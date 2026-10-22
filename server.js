// server.js — Core Ingestion Router, State Machine & Deliverables Engine
"use strict";

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const sharp = require("sharp");
const ExcelJS = require("exceljs");
const { GoogleGenAI } = require("@google/genai");

const {
  pool,
  query,
  withTransaction,
  withAdvisoryLock,
  logOperation,
  als,
  getRequestContext
} = require("./lib/db");
const {
  uploadListingImage,
  uploadFlyerImage,
  deleteStorageFiles
} = require("./lib/supabase");
const { generateFlyerBuffer, loadFont } = require("./lib/flyer");
const WA = require("./lib/whatsapp");
const T = require("./lib/text");
const F = require("./lib/financials");
const E = require("./lib/excel");
const S = require("./lib/search");
const L = require("./lib/listing");
const U = require("./lib/util");
const Drafts = require("./lib/drafts");

/* ====================================================================== */
/* 1. Configuration & Startup Validation                                  */
/* ====================================================================== */
const CFG = {
  port: Number(process.env.PORT || 3000),
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  geminiFallback: process.env.GEMINI_FALLBACK_MODEL || "gemini-3.6-flash",
  geminiRpm: Number(process.env.GEMINI_RPM || 12),
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 45000),
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT_PER_AGENCY || 300),
  brokerDailyLimit: Number(process.env.AI_DAILY_LIMIT_PER_BROKER || 60),
  maxImages: 15,
  searchPageSize: 5,
  maxSearchAudioSec: 45,
  maxListingAudioSec: 120,
  adminRoles: (process.env.ADMIN_ROLES || "admin,owner,manager")
    .split(",")
    .map((s) => s.trim().toLowerCase()),
  allowColleagueEdits: process.env.ALLOW_COLLEAGUE_EDITS === "true",
  isProd: process.env.NODE_ENV === "production"
};

const missing = [
  "GEMINI_API_KEY",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN"
]
  .concat(CFG.isProd ? ["WHATSAPP_APP_SECRET"] : [])
  .filter((k) => !process.env[k]);

if (missing.length) {
  console.error(
    "FATAL: Missing mandatory environment variables:",
    missing.join(", ")
  );
  process.exit(1);
}

sharp.concurrency(1);
sharp.cache({ items: 20, memory: 64 });

/* ====================================================================== */
/* 2. Structured Tracing & Telemetry                                      */
/* ====================================================================== */

function log(level, msg, meta = {}) {
  const c = getRequestContext();
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    reqId: c.reqId || null,
    agencyId: c.agencyId || null,
    brokerId: c.brokerId || null,
    ...meta
  });
  (level === "error" ? console.error : console.log)(line);
}

const errMeta = (e) => ({ err: e && e.message, code: e && e.code });
const M = (lang, ar, en) => (lang === "en" ? en : ar);
const to = (broker) => U.normalizePhone(broker.phone);

async function reply(broker, text, opts = {}) {
  if (!text) return null;
  const recipient = to(broker);

  try {
    return await WA.sendWhatsAppText(recipient, text, opts);
  } catch (err) {
    const apiCode = err?.code || err?.response?.data?.error?.code;
    const apiSubcode =
      err?.subcode || err?.response?.data?.error?.error_subcode;

    if (apiCode === 131047 || apiSubcode === 131047) {
      log("warn", "WhatsApp 24-hr session expired; cannot dispatch text", {
        brokerId: broker?.id,
        phone: broker?.phone
      });
      return null;
    }

    if (apiCode === 80007 || apiCode === 130429) {
      log("warn", "WhatsApp rate limit reached, retrying in 1000ms...", {
        phone: broker?.phone
      });
      await U.sleep(1000);
      try {
        return await WA.sendWhatsAppText(recipient, text, opts);
      } catch (retryErr) {
        log(
          "error",
          "WhatsApp retry failed after rate limit",
          errMeta(retryErr)
        );
        return null;
      }
    }

    log("error", "WhatsApp reply failed", {
      phone: broker?.phone,
      ...errMeta(err)
    });
    return null;
  }
}

/* ====================================================================== */
/* 3. Concurrency, Ephemeral States & Serialization                       */
/* ====================================================================== */
const recentBrokerListings = new Map();
const brokerCache = new Map();
const agencyCache = new Map();
const unknownNotified = new Map();
const lastTouch = new Map();
const cooldowns = new Map();
const recentButtonClicks = new Map();
const pendingDraftReviews = new Map(); // In-memory pending draft cache for pre-save reviews
const perBroker = U.createSerializer();
const listingLimiter = U.createLimiter(2, { maxQueue: 40 });
const uploadLimiter = U.createLimiter(4);
const rateGate = U.createRateGate(CFG.geminiRpm);
const msgRate = U.createCounter(60000, 80);
let inFlight = 0;

function resolveLang(rawText, broker) {
  if (!rawText) return broker.preferred_lang || "ar";
  const isEnglish = /^[a-zA-Z0-9\s#_.,:/\-+!?()]+$/.test(rawText.trim());
  return isEnglish ? "en" : broker.preferred_lang || "ar";
}

function setActiveListing(broker, code) {
  const key = U.normalizePhone(broker.phone);
  recentBrokerListings.set(key, {
    code: T.extractCleanCode(code),
    at: Date.now()
  });
}

function getActiveListingCode(broker) {
  const key = U.normalizePhone(broker.phone);
  const rec = recentBrokerListings.get(key);
  if (rec && Date.now() - rec.at < 7200000) {
    return rec.code;
  }
  return null;
}

/* ====================================================================== */
/* 4. Gemini AI Gateway with Multi-Model Resilient Cascade               */
/* ====================================================================== */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const isTransientError = (e) => {
  const msg = String((e && e.message) || e);
  return /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(
    msg
  );
};

async function callGemini({ contents, config, model, maxRetries = 2 }) {
  const primary = model || CFG.geminiModel || "gemini-3.8-flash";
  const fallbackTier2 = "gemini-3.6-flash";
  const fallbackTier3 =
    CFG.geminiFallback && CFG.geminiFallback !== fallbackTier2
      ? CFG.geminiFallback
      : "gemini-3.5-flash-lite";

  const models = [primary, fallbackTier2, fallbackTier3].filter(
    (m, i, a) => m && a.indexOf(m) === i
  );

  let lastErr;

  for (const currentModel of models) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await rateGate();
      try {
        const t0 = Date.now();
        const res = await U.withTimeout(
          ai.models.generateContent({ model: currentModel, contents, config }),
          CFG.geminiTimeoutMs || 30000,
          currentModel
        );
        const dur = Date.now() - t0;

        return {
          res,
          model: currentModel,
          duration_ms: dur,
          usage: {
            input: res.usageMetadata?.promptTokenCount || 0,
            output: res.usageMetadata?.candidatesTokenCount || 0
          }
        };
      } catch (err) {
        lastErr = err;
        const errMsg = String((err && err.message) || err);
        const isSpike = /503|UNAVAILABLE|high demand/i.test(errMsg);
        const isQuota =
          /RESOURCE_EXHAUSTED|free_tier_requests|limit:\s*20/i.test(errMsg);
        const isTimeout = /timeout|ETIMEDOUT/i.test(errMsg);

        if (
          (isSpike || isQuota || isTimeout) &&
          models.length > 1 &&
          currentModel !== models[models.length - 1]
        ) {
          log(
            "warn",
            `Model ${currentModel} degraded. Cascading to next fallback tier...`
          );
          await U.sleep(400);
          break;
        }

        if (!isTransientError(err)) break;

        if (attempt < maxRetries - 1) {
          const delay = 1000 * (attempt + 1) + Math.random() * 400;
          await U.sleep(delay);
        }
      }
    }
  }

  throw lastErr;
}

const aiShim = {
  models: {
    generateContent: async (a) => {
      const out = await callGemini({
        contents: a.contents,
        config: a.config,
        model: a.model
      });
      return out.res;
    }
  }
};

const cleanJson = (t) =>
  String(t || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

const AI = {
  async transcribeAudio(buffer, mimeType) {
    if (!buffer) return "";
    const cleanMime = U.cleanAudioMime(mimeType);
    const prompt =
      "Transcribe this Egyptian Arabic real estate voice note accurately into Arabic text. " +
      "Return ONLY the spoken words with no explanations, markdown, or commentary.";

    try {
      const res = await callGemini({
        contents: [
          { text: prompt },
          {
            inlineData: { mimeType: cleanMime, data: buffer.toString("base64") }
          }
        ],
        config: { temperature: 0.1, maxOutputTokens: 500 }
      });
      return cleanJson(res.res.text).trim();
    } catch (err) {
      log("warn", "Audio transcription failed", errMeta(err));
      return "";
    }
  },

  async extractPropertyDetails({
    texts = [],
    voiceBuffers = [],
    lang = "ar"
  } = {}) {
    const rawText = texts.filter(Boolean).join("\n").trim();
    const fenceToken = crypto.randomBytes(4).toString("hex").toUpperCase();
    const parts = [{ text: L.buildListingPrompt(lang, fenceToken) }];

    if (rawText) {
      parts.push({
        text: `===${fenceToken}===\n${rawText}\n===${fenceToken}===`
      });
    }

    for (const vb of voiceBuffers) {
      if (vb && vb.buffer && Buffer.isBuffer(vb.buffer)) {
        parts.push({
          inlineData: {
            mimeType: U.cleanAudioMime(vb.mimeType || "audio/ogg"),
            data: vb.buffer.toString("base64")
          }
        });
      }
    }

    const aiRes = await callGemini({
      contents: parts,
      config: {
        temperature: 0.1,
        maxOutputTokens: 3072,
        responseMimeType: "application/json"
      }
    });

    let draft = L.validateDraft(JSON.parse(cleanJson(aiRes.res.text)), lang);
    if (draft.details && Array.isArray(draft.details.features)) {
      draft.details.features = T.cleanFeaturesList(draft.details.features);
    }

    return {
      draft,
      usage: aiRes.usage,
      model: aiRes.model,
      duration_ms: aiRes.duration_ms
    };
  }
};

/* ====================================================================== */
/* 5. Database Loaders & Cache Accessors                                  */
/* ====================================================================== */
async function getBroker(from) {
  const key = U.normalizePhone(from);
  const hit = brokerCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.broker;

  const r = await query(
    "SELECT id, agency_id, name, phone, contact_phone, role, is_active, preferred_lang FROM brokers WHERE phone_normalized = $1 LIMIT 1",
    [key]
  );
  const broker = r.rows[0] || null;
  brokerCache.set(key, { broker, exp: Date.now() + 60000 });
  return broker;
}

async function getAgency(agencyId) {
  const hit = agencyCache.get(agencyId);
  if (hit && hit.exp > Date.now()) return hit.row;

  const r = await query(
    "SELECT id, name, logo_url, primary_color, secondary_color, flyer_theme FROM agencies WHERE id = $1 LIMIT 1",
    [agencyId]
  );
  const row = r.rows[0] || {};
  agencyCache.set(agencyId, { row, exp: Date.now() + 300000 });
  return row;
}

async function fetchListing(broker, code) {
  const cleanCode = T.extractCleanCode(code);
  const r = await query(
    `SELECT l.*, p.name AS project_name, p.developer_name, p.collateral AS project_collateral, p.media AS project_media
     FROM listings l
     LEFT JOIN projects p ON l.project_id = p.id
     WHERE l.agency_id = $1 AND (l.code = $2 OR l.developer_unit_code = $2)
     LIMIT 1`,
    [broker.agency_id, cleanCode]
  );
  return r.rows[0] || null;
}

async function loadListingImages(listingId) {
  const r = await query(
    "SELECT id, url, role, position FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 15",
    [listingId]
  );
  return r.rows;
}

const canEdit = (broker, listing) =>
  CFG.allowColleagueEdits ||
  !listing.broker_id ||
  listing.broker_id === broker.id ||
  CFG.adminRoles.includes(String(broker.role || "").toLowerCase());

async function markMsgs(ids, status) {
  if (!ids || !ids.length) return;
  try {
    await query(
      "UPDATE inbound_messages SET status = $2, updated_at = NOW() WHERE msg_id = ANY($1::text[])",
      [ids, status]
    );
  } catch (e) {
    log("warn", "Failed to update inbound message status", errMeta(e));
  }
}

/* ====================================================================== */
/* 6. Media Normalization & Storage                                       */
/* ====================================================================== */
const normalizeImage = (buf) =>
  sharp(buf, { failOn: "none" })
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 82 })
    .toBuffer();

async function uploadImages(agencyId, code, items) {
  if (!items || !items.length) return { ok: [], failed: 0 };
  const tag = crypto.randomBytes(3).toString("hex");

  const out = await Promise.all(
    items.map((it, i) =>
      uploadLimiter(async () => {
        try {
          if (!it || !it.buffer) return null;
          let finalBuf = it.buffer;
          if (finalBuf.length > 250 * 1024) {
            finalBuf = await normalizeImage(finalBuf);
          }

          const path = `agency_${agencyId}/listing_${code}/${code}-${tag}-${
            i + 1
          }.jpg`;
          const url = await uploadListingImage(agencyId, path, finalBuf);
          return url
            ? { url, role: it.role || null, buffer: finalBuf, path }
            : null;
        } catch (e) {
          log("error", "Image upload failed", errMeta(e));
          return null;
        }
      })
    )
  );

  return { ok: out.filter(Boolean), failed: out.filter((x) => !x).length };
}

/* ====================================================================== */
/* 7. On-Demand Brochure Rendering (Locked to 100% English LTR)           */
/* ====================================================================== */
async function renderFlyerOnDemand(
  broker,
  listing,
  { theme = "dark", unbranded = false } = {}
) {
  const t0 = Date.now();
  const perf = {
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: listing.code,
    operation_type: "flyer_ondemand",
    flyer_render_ms: 0,
    storage_upload_ms: 0
  };

  const agency = await getAgency(broker.agency_id);
  const cacheKey = unbranded
    ? `unbranded_en_${theme}`
    : `${broker.id}_en_${theme}`;
  const flyerCache = listing.flyer_cache || {};

  if (flyerCache[cacheKey]) {
    const cached = flyerCache[cacheKey];
    const isFresh =
      cached.wa_media_at &&
      Date.now() - new Date(cached.wa_media_at).getTime() < 25 * 86400000;
    if (isFresh && cached.wa_media_id) {
      return { ok: true, wa_media_id: cached.wa_media_id, url: cached.url };
    }
  }

  let images = await loadListingImages(listing.id);
  if (!images.length && listing.images) {
    const pImages = listing.images;
    images = [
      pImages.hero && { url: pImages.hero, role: "facade" },
      pImages.layout && { url: pImages.layout, role: "layout" },
      ...(Array.isArray(pImages.gallery)
        ? pImages.gallery.map((url) => ({ url, role: "other" }))
        : [])
    ].filter(Boolean);
  }

  if (!images.length) return { ok: false, reason: "no_images" };

  const r0 = Date.now();
  const flyerBuf = await generateFlyerBuffer({
    listing,
    agency,
    images: images.map((i) => i.url),
    theme,
    unbranded
  });
  perf.flyer_render_ms = Date.now() - r0;
  if (!flyerBuf) return { ok: false, reason: "render_failed" };

  const u0 = Date.now();
  const storagePath = `agency_${broker.agency_id}/listing_${listing.code}/flyer_${cacheKey}.jpg`;
  const flyerUrl = await uploadFlyerImage(
    broker.agency_id,
    storagePath,
    flyerBuf
  );
  perf.storage_upload_ms = Date.now() - u0;

  const waMediaId = await WA.uploadWhatsAppMedia(flyerBuf, {
    mimeType: "image/jpeg",
    filename: `${listing.code}.jpg`
  });

  const entry = {
    url: flyerUrl,
    wa_media_id: waMediaId,
    wa_media_at: new Date().toISOString(),
    agent_name: broker.name,
    agent_phone: broker.contact_phone || broker.phone
  };

  await query(
    "UPDATE listings SET flyer_cache = jsonb_set(COALESCE(flyer_cache, '{}'::jsonb), $1::text[], $2::jsonb) WHERE id = $3",
    [[cacheKey], JSON.stringify(entry), listing.id]
  ).catch((e) => log("warn", "Cache write failed", errMeta(e)));

  perf.total_duration_ms = Date.now() - t0;
  logOperation(perf).catch(() => {});

  return { ok: true, wa_media_id: waMediaId, url: flyerUrl, buf: flyerBuf };
}

/* ====================================================================== */
/* 8. Property Presentation Cards & Dynamic Buttons (Primary vs Resale)   */
/* ====================================================================== */
async function showListingCard(broker, listing) {
  const lang = broker.preferred_lang || "ar";
  const isEn = lang === "en";
  const code = T.extractCleanCode(listing.code);
  const det = listing.details || {};
  const isPrimary =
    listing.inventory_type === "developer_model" ||
    listing.is_primary_developer;

  const header = T.formatStandardHeader(listing, lang);

  const specsList = [
    `📐 *${isEn ? "Area:" : "المساحة:"}* ${
      listing.area_value ? `${listing.area_value}${isEn ? "sqm" : "م²"}` : "-"
    }`,
    `🛏️ *${isEn ? "Bedrooms:" : "الغرف:"}* ${
      listing.property_type === "studio"
        ? isEn
          ? "Studio"
          : "استوديو"
        : listing.bedrooms || "-"
    }`,
    det.bathrooms
      ? `🛁 *${isEn ? "Bathrooms:" : "الحمامات:"}* ${det.bathrooms}`
      : null,
    det.orientation
      ? `🧭 *${isEn ? "Orientation:" : "الوجهة:"}* ${
          isEn ? det.orientation_en || det.orientation : det.orientation
        }`
      : null,
    det.finishing
      ? `🎨 *${isEn ? "Finishing:" : "التشطيب:"}* ${
          isEn ? det.finishing_en || det.finishing : det.finishing
        }`
      : null
  ].filter(Boolean);

  let financialBlock = "";
  if (isPrimary && listing.payment_terms?.plans?.length) {
    const plans = listing.payment_terms.plans;
    const maxYears = Math.max(...plans.map((p) => p.years || 0));
    const minDownPct = Math.min(...plans.map((p) => p.down_payment_pct ?? 100));
    const bestCash = plans.find((p) => p.years === 0 || p.discount_pct >= 25);

    financialBlock = isEn
      ? `💰 *Pricing Options:*\n` +
        (bestCash
          ? ` • Cash: ${T.formatPrice(
              listing.price_value * (1 - bestCash.discount_pct / 100),
              "en"
            )}\n`
          : "") +
        (maxYears > 0
          ? ` • Installments: Up to ${maxYears} Years (Down from ${minDownPct}%)`
          : "")
      : `💰 *خيارات السعر والتقسيط:*\n` +
        (bestCash
          ? ` • الكاش بعد الخصم: ${T.formatPrice(
              listing.price_value * (1 - bestCash.discount_pct / 100),
              "ar"
            )}\n`
          : "") +
        (maxYears > 0
          ? ` • التقسيط: حتى ${maxYears} سنوات (مقدم يبدأ من ${minDownPct}%)`
          : "");
  } else {
    // Resale Cash & Remaining Installments Block
    const cur = det.currency || "EGP";
    const upfront =
      det.total_upfront_cash ||
      det.down_payment_value ||
      listing.down_payment_value;
    const rem = det.remaining_balance;
    const priceFormatted = listing.price_value
      ? T.formatAbbreviatedPrice(
          listing.price_value,
          cur,
          lang,
          listing.listing_type
        )
      : listing.price_display || "-";

    const lines = [
      `💰 *${isEn ? "Total Price:" : "إجمالي السعر:"}* ${priceFormatted}`
    ];
    if (upfront) {
      lines.push(
        `💵 *${
          isEn ? "Cash Required:" : "كاش مطلوب:"
        }* ${T.formatAbbreviatedPrice(
          upfront,
          cur,
          lang,
          listing.listing_type
        )}`
      );
    }
    if (rem) {
      lines.push(
        `🗓️ *${
          isEn ? "Remaining Debt:" : "متبقي أقساط:"
        }* ${T.formatAbbreviatedPrice(rem, cur, lang, listing.listing_type)}`
      );
    }
    financialBlock = lines.join("\n");
  }

  const deliveryStr = det.ready_to_move
    ? isEn
      ? "Immediate (Ready to Move)"
      : "فوري (جاهز للاستلام)"
    : det.delivery_date || listing.delivery_date || "-";

  const body = `${header}\n─────────────────────────\n${specsList.join(
    " | "
  )}\n─────────────────────────\n${financialBlock}\n📅 *${
    isEn ? "Delivery:" : "الاستلام:"
  }* ${deliveryStr}`;

  // Dynamic 3-Button Allocation: Primary gets Payment Plans; Resale gets Edit Unit
  const middleButton = isPrimary
    ? {
        id: `plans_view:${code}`,
        title: isEn ? "💳 Payment Plans" : "💳 أنظمة السداد"
      }
    : {
        id: `edit_unit:${code}`,
        title: isEn ? "✏️ Edit Unit" : "✏️ تعديل"
      };

  const buttons = [
    {
      id: `flyer:en:dark:${code}`, // Locked strictly to English brochure
      title: isEn ? "📄 Brochure" : "📄 البروشور"
    },
    middleButton,
    {
      id: isEn ? `client:${code}` : `عميل:${code}`,
      title: isEn ? "📋 Client Text" : "📋 نص العميل"
    }
  ];

  setActiveListing(broker, code);
  await WA.sendWhatsAppButtons(to(broker), body, buttons);
}

/* ====================================================================== */
/* 9. Specialized Deliverables Dispatchers (Excel, Collateral)            */
/* ====================================================================== */

async function sendConsolidatedExcel(broker, code) {
  const t0 = Date.now();
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  const agency = await getAgency(broker.agency_id);
  const plans = listing.payment_terms?.plans || [];

  if (!plans.length) {
    return reply(
      broker,
      M(
        broker.preferred_lang || "ar",
        `⚠️ الوحدة #${code} لا تحتوي على مصفوفة أقساط للمطور (وحدة ريزيل فردية).`,
        `⚠️ Listing #${code} does not contain multi-tier developer installment plans.`
      )
    );
  }

  await reply(
    broker,
    M(
      broker.preferred_lang || "ar",
      "⏳ جاري توليد جدول السداد المعتمد (English Excel)...",
      "⏳ Generating Excel schedule (English)..."
    )
  );

  const excelBuffer = await E.buildMultiPlanWorkbook({
    listing,
    plans,
    agency,
    broker,
    lang: "en" // Locked to English LTR
  });

  const filename = `Payment_Schedule_${code}_${
    listing.compound || "Unit"
  }.xlsx`;
  const caption = `📊 Payment Plan Breakdown for #${code} (Comparison matrix + quarterly cash flows).`;

  const sent = await WA.sendWhatsAppDocument(
    to(broker),
    excelBuffer,
    filename,
    caption
  );

  logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: code,
    operation_type: "export_payment_excel",
    status: sent ? "success" : "failed",
    total_duration_ms: Date.now() - t0
  }).catch(() => {});
}

async function sendCollateralLinks(broker, code) {
  const lang = broker.preferred_lang || "ar";
  const isEn = lang === "en";
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  const collateral = listing.collateral || {};
  const projectCollateral = listing.project_collateral || {};
  const projectMedia = listing.project_media || {};

  const layoutPdf = collateral.layout_pdf_url;
  const masterBrochure =
    projectCollateral.master_brochure_url || collateral.master_brochure_url;
  const masterPlan =
    projectCollateral.master_plan_url || collateral.master_plan_url;
  const driveUrl =
    projectCollateral.drive_folder_url || projectMedia.drive_folder_url;

  const lines = [
    isEn
      ? `📂 *Marketing & Engineering Collateral #${code}*`
      : `📂 *المستندات والوسائط الترويجية للوحدة #${code}*`,
    `─────────────────────────`
  ];

  if (layoutPdf)
    lines.push(
      `📐 *${
        isEn ? "Floor Plan PDF:" : "مخطط الشقة الهندسي (2D Layout):"
      }*\n${layoutPdf}\n`
    );
  if (masterPlan)
    lines.push(
      `🗺️ *${
        isEn ? "Master Plan:" : "المخطط العام للكمبوند (Master Plan):"
      }*\n${masterPlan}\n`
    );
  if (masterBrochure)
    lines.push(
      `📖 *${
        isEn ? "Project Brochure:" : "بروشور المشروع الكامل:"
      }*\n${masterBrochure}\n`
    );
  if (driveUrl)
    lines.push(
      `📁 *${
        isEn ? "Sales Kit Drive Folder:" : "مجلد الصور والملفات (Drive):"
      }*\n${driveUrl}\n`
    );

  if (lines.length === 2) {
    lines.push(
      isEn
        ? "ℹ️ No cloud PDF links currently attached to this unit."
        : "ℹ️ لم يتم إرفاق روابط ملفات PDF سحابية لهذه الوحدة حتى الآن."
    );
  }

  await reply(broker, lines.join("\n"));
  await logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: code,
    operation_type: "collateral_view",
    status: "success",
    total_duration_ms: Date.now() - t0,
    metadata: { has_layout: !!layoutPdf, has_drive: !!driveUrl }
  }).catch(() => {});
}

/* ====================================================================== */
/* 10. Command Handlers (Decoupled & Instrumented)                        */
/* ====================================================================== */
const notFound = (broker, code) =>
  reply(
    broker,
    M(
      broker.preferred_lang || "ar",
      `❌ الوحدة غير موجودة بالمخزون: #${code}`,
      `❌ Listing not found: #${code}`
    )
  );

async function cmdExport(broker, lang) {
  const t0 = Date.now();
  const key = `export:${U.normalizePhone(broker.phone)}`;
  if (cooldowns.get(key) > Date.now()) {
    return reply(
      broker,
      M(
        lang,
        "⏳ يرجى الانتظار دقيقة قبل طلب تصدير جديد.",
        "⏳ Please wait a minute before requesting another export."
      )
    );
  }
  cooldowns.set(key, Date.now() + 60000);

  const isAdmin = CFG.adminRoles.includes(
    String(broker.role || "").toLowerCase()
  );
  const r = await query(
    `SELECT code, title, property_type, listing_type, price_value, price_display, area_value, bedrooms, location, compound, district, details, status, created_at
     FROM listings WHERE agency_id = $1 ${
       isAdmin ? "" : "AND broker_id = $2"
     } ORDER BY created_at DESC LIMIT 5000`,
    isAdmin ? [broker.agency_id] : [broker.agency_id, broker.id]
  );

  if (!r.rowCount) {
    return reply(
      broker,
      M(
        lang,
        "لا توجد وحدات متاحة للتصدير.",
        "No listings available to export."
      )
    );
  }

  await reply(
    broker,
    M(
      lang,
      "⏳ جاري إعداد ملف إكسيل الشامل للمخزون...",
      "⏳ Preparing master inventory Excel workbook..."
    )
  );

  const agency = await getAgency(broker.agency_id);
  const excelBuffer = await E.buildAgencyInventoryWorkbook({
    listings: r.rows,
    agency,
    broker,
    lang: "en" // Master ledger locked to English LTR
  });

  const filename = `Master_Inventory_${new Date()
    .toISOString()
    .slice(0, 10)}.xlsx`;
  const sent = await WA.sendWhatsAppDocument(
    to(broker),
    excelBuffer,
    filename,
    M(
      lang,
      `📄 تم استخراج شيت إكسيل شامل (${r.rowCount} وحدة)`,
      `📄 Full Agency Inventory (${r.rowCount} units)`
    )
  );

  logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "cmd_export_excel",
    status: sent ? "success" : "failed",
    total_duration_ms: Date.now() - t0
  }).catch(() => {});
}

async function cmdFlyer(
  broker,
  codeRaw,
  lang,
  { theme = "dark", unbranded = false } = {}
) {
  const t0 = Date.now();
  const code = T.extractCleanCode(codeRaw);
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  await reply(
    broker,
    M(
      lang,
      unbranded
        ? "⏳ جاري تصميم الكتالوج الأبيض (English Unbranded)..."
        : "⏳ جاري تصميم وإنشاء الكتالوج المعتمد (English Brochure)...",
      "⏳ Preparing luxury brochure (English)..."
    )
  );

  try {
    const res = await renderFlyerOnDemand(broker, listing, {
      theme: theme || "dark",
      unbranded
    });

    if (!res.ok) {
      log("warn", "Flyer render failed", { code, reason: res.reason });
      return await reply(
        broker,
        M(lang, "❌ تعذر إنشاء البروشور.", "❌ Brochure generation failed.")
      );
    }

    const mediaSource = res.wa_media_id || res.url;
    if (!mediaSource) {
      return await reply(
        broker,
        M(lang, "❌ تعذر رفع البروشور.", "❌ Brochure upload failed.")
      );
    }

    const caption = unbranded ? `#${code}` : `#${code} - ${broker.name || ""}`;
    await WA.sendWhatsAppImage(to(broker), mediaSource, caption);
  } catch (err) {
    log("error", "cmdFlyer failed to render or deliver brochure", errMeta(err));
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "flyer_ondemand",
      status: "failed",
      error_code: err.code || err.message?.slice(0, 50) || "FLYER_ERROR",
      total_duration_ms: Date.now() - t0
    }).catch(() => {});

    await reply(
      broker,
      M(lang, "❌ تعذر إنشاء البروشور.", "❌ Brochure generation failed.")
    );
  }
}

/**
 * Initiates the Pre-Save Interactive Review Card before committing to the DB.
 */
async function cmdReviewDraft(broker, lang) {
  const t0 = Date.now();
  const draft = await Drafts.getDraft(broker.id);

  if (
    !draft ||
    (!draft.texts?.length &&
      !draft.voice_buffers?.length &&
      !draft.media_items?.length)
  ) {
    return reply(
      broker,
      M(
        lang,
        "⚠️ لا توجد مسودة نشطة تحتوي على بيانات لحفظها.\nلبدء مسودة جديدة، أرسل صور الوحدة مباشرة أو اكتب *اضافة*.",
        "⚠️ No active draft with data to save.\nTo start a draft, send photos or type *add*."
      )
    );
  }

  await reply(
    broker,
    M(
      lang,
      "⏳ جاري تحليل مواصفات الوحدة بالذكاء الاصطناعي وإعداد كارت المراجعة...",
      "⏳ Analyzing listing specifications and preparing review card..."
    )
  );

  try {
    const g0 = Date.now();
    const extraction = await AI.extractPropertyDetails({
      texts: draft.texts || [],
      voiceBuffers: draft.voice_buffers || [],
      lang
    });
    const geminiMs = Date.now() - g0;
    const listingData = extraction.draft;

    // Evaluate parsed price
    const parsedPrice = listingData.price_raw
      ? T.parseEgyptianPrice(listingData.price_raw, {
          listingType: listingData.listing_type
        })
      : null;

    if (parsedPrice?.priceValue) {
      listingData.price_value = parsedPrice.priceValue;
      listingData.price_display = parsedPrice.priceDisplay;
    }

    // Evaluate Completeness & Rules
    const validationResult = L.checkDraftCompleteness(listingData, parsedPrice);

    // If hard blockers exist: reject commit and list missing mandatory fields
    if (!validationResult.isComplete) {
      const blockerList = validationResult.blockers
        .map((b) => ` • ${b}`)
        .join("\n");
      const blockMsg = M(
        lang,
        `❌ *بيانات ناقصة تمنع الحفظ:*\n${blockerList}\n\nيرجى إرسال البيانات الناقصة (كتابة أو رسالة صوتية) ثم كتابة *تم*.`,
        `❌ *Missing mandatory fields:*\n${blockerList}\n\nPlease provide the missing details and send *done*.`
      );

      await logOperation({
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "draft_validation_blocked",
        status: "rejected",
        total_duration_ms: Date.now() - t0,
        metadata: { blockers: validationResult.blockers }
      });

      return reply(broker, blockMsg);
    }

    // Format Review Card (Separates verified specs from optional flagged fields)
    const reviewCardText = T.formatDraftReviewCard(
      listingData,
      parsedPrice,
      validationResult,
      lang
    );

    // Cache the validated draft in pending review state
    pendingDraftReviews.set(broker.id, {
      listingData,
      mediaItems: draft.media_items || [],
      created_at: Date.now()
    });

    const isEn = lang === "en";
    const buttons = [
      {
        id: "draft_confirm",
        title: isEn ? "Confirm & Save ✅" : "تأكيد وحفظ ✅"
      },
      {
        id: "draft_edit",
        title: isEn ? "Edit Details ✏️" : "تعديل ✏️"
      },
      {
        id: "draft_cancel",
        title: isEn ? "Cancel ❌" : "إلغاء ❌"
      }
    ];

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: listingData.code,
      operation_type: "draft_review_shown",
      status: "success",
      gemini_ms: geminiMs,
      total_duration_ms: Date.now() - t0,
      metadata: { warnings_count: validationResult.warnings.length }
    });

    await WA.sendWhatsAppButtons(to(broker), reviewCardText, buttons);
  } catch (err) {
    log("error", "cmdReviewDraft AI analysis failed", errMeta(err));
    await reply(
      broker,
      M(
        lang,
        "❌ حدث خطأ أثناء قراءة بيانات الوحدة. حاول مجدداً بكتابة *تم*.",
        "❌ Failed to parse draft. Please retry with *done*."
      )
    );
  }
}

/**
 * Commits verified draft to the database after explicit confirmation.
 */
async function cmdExecuteConfirmSave(broker, lang) {
  const t0 = Date.now();
  const pending = pendingDraftReviews.get(broker.id);

  if (!pending || !pending.listingData) {
    return reply(
      broker,
      M(
        lang,
        "⚠️ انتهت صلاحية كارت المراجعة المؤقت. يرجى كتابة *تم* لإنشاء كارت مراجعة جديد.",
        "⚠️ Pending review expired. Please send *done* to re-generate the review card."
      )
    );
  }

  const { listingData, mediaItems } = pending;

  await reply(
    broker,
    M(
      lang,
      "⏳ جاري رفع الصور واعتماد الوحدة نهائياً بالمخزون...",
      "⏳ Uploading photos and committing unit to inventory..."
    )
  );

  try {
    const u0 = Date.now();
    const uploadRes = await uploadImages(
      broker.agency_id,
      listingData.code,
      mediaItems
    );
    const storageMs = Date.now() - u0;

    const c0 = Date.now();
    const inserted = await Drafts.commitDraftToListing({
      broker,
      agencyId: broker.agency_id,
      listingData,
      images: uploadRes.ok
    });
    const dbMs = Date.now() - c0;

    // Clear both pending review and draft session
    pendingDraftReviews.delete(broker.id);
    await Drafts.clearDraft(broker.id);

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: inserted.code,
      operation_type: "draft_confirm_commit",
      status: "success",
      storage_upload_ms: storageMs,
      db_ms: dbMs,
      total_duration_ms: Date.now() - t0,
      metadata: { images_count: uploadRes.ok.length }
    });

    await reply(
      broker,
      M(
        lang,
        `✅ تم حفظ واعتماد الوحدة بنجاح كود: \`${inserted.code}\``,
        `✅ Unit saved successfully: \`${inserted.code}\``
      )
    );

    await showListingCard(broker, inserted);
  } catch (err) {
    log("error", "Failed to commit confirmed draft", errMeta(err));
    await reply(
      broker,
      M(
        lang,
        "❌ تعذر حفظ الوحدة بقاعدة البيانات.",
        "❌ Failed to save listing."
      )
    );
  }
}

async function handleCommand(broker, raw) {
  if (!raw) return false;
  const n = String(raw)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u0640]/g, "")
    .trim();
  const lang = broker.preferred_lang || "ar";
  let m;

  // 1. LANGUAGE SWITCHER: "عربي", "english", "lang ar", "lang en"
  if (/^(?:lang\s+ar|عربي|اللغة العربية)$/i.test(n)) {
    await query("UPDATE brokers SET preferred_lang = 'ar' WHERE id = $1", [
      broker.id
    ]);
    brokerCache.delete(U.normalizePhone(broker.phone));
    broker.preferred_lang = "ar";
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "set_language",
      status: "success",
      metadata: { new_lang: "ar" }
    });
    await reply(
      broker,
      "✅ تم ضبط اللغة إلى العربية. ستصلك جميع القوائم والبطاقات باللغة العربية."
    );
    return true;
  }

  if (/^(?:lang\s+en|english|انجليزي|إنجليزي)$/i.test(n)) {
    await query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [
      broker.id
    ]);
    brokerCache.delete(U.normalizePhone(broker.phone));
    broker.preferred_lang = "en";
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "set_language",
      status: "success",
      metadata: { new_lang: "en" }
    });
    await reply(
      broker,
      "✅ Language set to English. All menus, cards, and responses will now be in English."
    );
    return true;
  }

  // 2. HELP MENU
  if (/^(?:مساعدة|مساعده|المساعدة|help|menu|منيو|اوامر|أوامر|\?|؟)$/i.test(n)) {
    await reply(broker, T.getHelpMessage(lang));
    return true;
  }

  // 3. ADD NEW LISTING COMMAND
  if (/^(?:اضافة|إضافة|جديد|add|new)$/i.test(n)) {
    pendingDraftReviews.delete(broker.id);
    await Drafts.clearDraft(broker.id);
    await Drafts.createDraft(broker.id, broker.agency_id);
    await reply(
      broker,
      M(
        lang,
        "📝 *بدء إضافة مسودة وحدة جديدة*\n\n1️⃣ أرسل صور الوحدة.\n2️⃣ أرسل المواصفات والأسعار (صوت أو كتابة).\n3️⃣ أرسل *تم* أو *done* لفتح كارت المراجعة والاعتماد.",
        "📝 *Add New Listing Draft*\n\n1️⃣ Send unit photos.\n2️⃣ Send specifications & price (voice or text).\n3️⃣ Send *done* to review and confirm."
      )
    );
    return true;
  }

  // 4. REVIEW DRAFT COMMAND
  if (/^(?:تم|حفظ|done|save)$/i.test(n)) {
    await cmdReviewDraft(broker, lang);
    return true;
  }

  // 5. EXCEL EXPORT
  if (/^(?:تصدير|اكسيل|اكسل|excel|export)$/i.test(n)) {
    await cmdExport(broker, lang);
    return true;
  }

  // 6. CANCEL DRAFT
  if (/^(?:إلغاء|الغاء|تراجع|cancel)$/i.test(n)) {
    pendingDraftReviews.delete(broker.id);
    const draft = await Drafts.getDraft(broker.id);
    if (draft) {
      await Drafts.clearDraft(broker.id);
      await reply(
        broker,
        M(
          lang,
          "🗑️ تم إلغاء المسودة الحالية وتفريغها.",
          "🗑️ Active draft has been canceled."
        )
      );
      return true;
    }
  }

  const resolveTargetCode = (explicitCode) => {
    if (explicitCode) return T.extractCleanCode(explicitCode);
    return getActiveListingCode(broker);
  };

  // 7. PAYMENT PLANS COMMAND (Locked to English Excel)
  if (
    (m = n.match(
      /^(?:جدول|انظمة|أنظمة|احسب|plans|calc)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i
    ))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ حدد كود الوحدة لعرض أنظمة سدادها.", "⚠️ Specify unit code.")
      );
      return true;
    }
    await sendConsolidatedExcel(broker, targetCode);
    return true;
  }

  // 8. COLLATERAL COMMAND
  if (
    (m = n.match(
      /^(?:مخطط|بروشور|درايف|ملفات|collateral|layout|drive)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i
    ))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ حدد كود الوحدة لعرض ملفاتها.", "⚠️ Specify unit code.")
      );
      return true;
    }
    await sendCollateralLinks(broker, targetCode);
    return true;
  }

  // 9. FLYER COMMAND (Always 100% English)
  if (
    (m = n.match(/^(?:كتالوج|flyer|catalog)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ يرجى تحديد كود الوحدة.", "⚠️ Specify unit code.")
      );
      return true;
    }
    await cmdFlyer(broker, targetCode, lang, {
      theme: "dark",
      unbranded: false
    });
    return true;
  }

  // 10. UNBRANDED FLYER COMMAND
  if (
    (m = n.match(
      /^(?:بروشور بدون بيانات|unbranded)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i
    ))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ يرجى تحديد كود الوحدة.", "⚠️ Specify unit code.")
      );
      return true;
    }
    await cmdFlyer(broker, targetCode, lang, {
      theme: "dark",
      unbranded: true
    });
    return true;
  }

  // 11. DUAL CLIENT COPY: "عميل CODE" (Arabic) vs "client CODE" (English)
  if ((m = n.match(/^(?:عميل|زبون)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ يرجى تحديد كود الوحدة.", "⚠️ Specify unit code.")
      );
      return true;
    }
    const l = await fetchListing(broker, targetCode);
    if (l) {
      await reply(broker, T.formatClientListingText(l, broker, "ar"));
    } else {
      await notFound(broker, targetCode);
    }
    return true;
  }

  if ((m = n.match(/^(?:client)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ Please specify unit code.", "⚠️ Please specify unit code.")
      );
      return true;
    }
    const l = await fetchListing(broker, targetCode);
    if (l) {
      await reply(broker, T.formatClientListingText(l, broker, "en"));
    } else {
      await notFound(broker, targetCode);
    }
    return true;
  }

  // 12. DRAFT IMAGE REPLACE
  if (/^(?:استبدال|replace)$/i.test(n)) {
    const draft = await Drafts.getDraft(broker.id);
    if (!draft) {
      await reply(
        broker,
        M(
          lang,
          "ℹ️ لا توجد مسودة نشطة حالياً لاستبدال صورها.",
          "ℹ️ No active draft found."
        )
      );
      return true;
    }

    await query(
      "UPDATE listing_drafts SET media_ids = '{}', updated_at = NOW() WHERE broker_id = $1",
      [broker.id]
    );

    await reply(
      broker,
      M(
        lang,
        "🔄 تم مسح الصور السابقة من المسودة بنجاح.\n📷 يمكنك الآن إرسال الصور الجديدة البديلة.",
        "🔄 Previous photos cleared from draft.\n📷 Send replacement photos."
      )
    );
    return true;
  }

  return false;
}

/* ====================================================================== */
/* 11. Interactive Button & List Menu Router                              */
/* ====================================================================== */
async function handleInteractive(broker, message) {
  const replyId =
    message.interactive?.button_reply?.id ||
    message.interactive?.list_reply?.id;
  if (!replyId) return "done";

  // Debounce Rapid Clicks (3s ceiling)
  const clickKey = `${U.normalizePhone(broker.phone)}:${replyId}`;
  const now = Date.now();
  if (recentButtonClicks.get(clickKey) > now) {
    log("info", "Duplicate button click dropped (debounced)", {
      phone: broker.phone,
      replyId
    });
    return "done";
  }
  recentButtonClicks.set(clickKey, now + 3000);

  const lang = broker.preferred_lang || "ar";

  // --- Pre-Save Review Card Actions ---
  if (replyId === "draft_confirm") {
    await cmdExecuteConfirmSave(broker, lang);
    return "done";
  }

  if (replyId === "draft_edit") {
    await reply(
      broker,
      M(
        lang,
        "✏️ أرسل التعديل المطلوب بصوت أو رسالة (مثال: `التشطيب سوبر لوكس والدور 3`)، ثم أرسل *تم* لتحديث المراجعة.",
        "✏️ Send your correction (text or voice), then send *done* to review again."
      )
    );
    return "done";
  }

  if (replyId === "draft_cancel") {
    pendingDraftReviews.delete(broker.id);
    await Drafts.clearDraft(broker.id);
    await reply(broker, M(lang, "🗑️ تم إلغاء المسودة.", "🗑️ Draft canceled."));
    return "done";
  }

  // --- Resale Edit Prompt Action ---
  if (replyId.startsWith("edit_unit:")) {
    const code = replyId.split(":")[1];
    await reply(
      broker,
      M(
        lang,
        `✏️ لتعديل بيانات الوحدة #${code}، أرسل أمر التعديل المباشر:\n• \`تعديل ${code} السعر [القيمة]\`\n• \`تعديل ${code} التشطيب [القيمة]\`\n• \`تعديل ${code} المساحة [القيمة]\`\n• \`تعديل ${code} الغرف [العدد]\``,
        `✏️ To edit unit #${code}, send an inline patch command:\n• \`edit ${code} price [value]\`\n• \`edit ${code} finishing [value]\`\n• \`edit ${code} area [value]\`\n• \`edit ${code} bedrooms [count]\``
      )
    );
    return "done";
  }

  // --- Brochure Request (Locked to English LTR) ---
  if (replyId.startsWith("flyer:")) {
    const parts = replyId.split(":");
    const theme = parts[2] || "dark";
    const code = parts[3] || parts[1];
    await cmdFlyer(broker, code, lang, { theme, unbranded: false });
    return "done";
  }

  // --- Client Ad Copy Request ---
  if (replyId.startsWith("client:") || replyId.startsWith("share_client:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    await reply(broker, T.formatClientListingText(listing, broker, "en"));
    return "done";
  }

  if (replyId.startsWith("عميل:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    await reply(broker, T.formatClientListingText(listing, broker, "ar"));
    return "done";
  }

  // --- Primary Payment Plans Actions ---
  if (replyId.startsWith("plans_view:") || replyId.startsWith("plans_all:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);

    const plans = listing.payment_terms?.plans || [];
    if (plans.length) {
      const matchResult = F.filterMatchingPlans(listing.price_value, plans);
      await WA.sendPaymentPlansResponse(to(broker), code, matchResult, "en");
    } else {
      await sendConsolidatedExcel(broker, code);
    }
    return "done";
  }

  if (replyId.startsWith("plan_view:")) {
    const parts = replyId.split(":");
    const code = parts[1];
    const planId = parts[2];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);

    const plans = listing.payment_terms?.plans || [];
    const targetPlan = plans.find((p) => p.plan_id === planId) || plans[0];
    if (targetPlan) {
      const matchResult = {
        status: "matched",
        matches: [F.calculatePlanSummary(listing.price_value, targetPlan)]
      };
      await WA.sendPaymentPlansResponse(to(broker), code, matchResult, "en");
    }
    return "done";
  }

  if (replyId.startsWith("compare_excel:")) {
    const code = replyId.split(":")[1];
    await sendConsolidatedExcel(broker, code);
    return "done";
  }

  // --- Search Pagination ---
  if (replyId === "MORE_SEARCH") {
    await handleSearchMessage(broker, { more: true });
    return "done";
  }

  return "done";
}

/* ====================================================================== */
/* 12. Search Execution Engine (Bilingual Trigram Matching)              */
/* ====================================================================== */
async function handleSearchMessage(
  broker,
  { text = "", audio = null, more = false } = {}
) {
  const t0 = Date.now();
  const key = to(broker);
  const lang = broker.preferred_lang || "ar";
  const isVoice = Boolean(audio && audio.buffer && audio.buffer.length);

  let parsed;
  let offset = 0;
  let geminiMs = 0;

  if (more) {
    const st = (
      await query(
        "SELECT parsed, next_offset FROM broker_search_state WHERE phone_key = $1",
        [key]
      )
    ).rows[0];
    if (!st) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ لا يوجد بحث سابق لعرض المزيد.",
          "⚠️ No active search found."
        )
      );
      return;
    }
    parsed = st.parsed;
    offset = st.next_offset;
  } else {
    reply(
      broker,
      isVoice
        ? M(lang, "🎙️ جاري الاستماع للطلب...", "🎙️ Listening...")
        : M(lang, "🔍 جاري البحث...", "🔍 Searching...")
    ).catch(() => {});

    try {
      const g0 = Date.now();
      const parseResult = await S.parseSearchRequest(aiShim, {
        text,
        audio: isVoice ? [audio] : [],
        model: CFG.geminiModel
      });
      geminiMs = Date.now() - g0;
      parsed = parseResult.parsed;
    } catch {
      parsed = S.fallbackParse(text);
    }
  }

  let relaxed = Boolean(parsed.__relaxed);
  let rows = [];

  const runQuery = async (isRelaxed) => {
    const { sql, params } = S.buildSearchQuery(broker.agency_id, parsed, {
      relaxed: isRelaxed,
      limit: CFG.searchPageSize,
      offset
    });
    return (await query(sql, params)).rows;
  };

  rows = await runQuery(relaxed);

  if (!rows.length && !relaxed && !parsed.filters?.code) {
    relaxed = true;
    rows = await runQuery(true);
    if (rows.length) {
      await reply(
        broker,
        M(
          lang,
          "ℹ️ نتائج تقريبية — تم توسيع نطاق البحث قليلاً لعرض أقرب الخيارات.",
          "ℹ️ Close matches — search range widened slightly."
        )
      );
    }
  }

  const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
  if (!total) {
    await reply(
      broker,
      M(
        lang,
        "🔍 لم نجد وحدات مطابقة لمواصفات بحثك.",
        "🔍 No units matched your search criteria."
      )
    );
    return;
  }

  query(
    `INSERT INTO broker_search_state (phone_key, parsed, next_offset, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (phone_key) DO UPDATE SET parsed = EXCLUDED.parsed, next_offset = EXCLUDED.next_offset, updated_at = NOW()`,
    [key, { ...parsed, __relaxed: relaxed }, offset + rows.length]
  ).catch(() => {});

  for (const unit of rows) {
    await showListingCard(broker, unit);
    await U.sleep(300);
  }

  const remaining = total - (offset + rows.length);
  if (remaining > 0) {
    const nextBatch = Math.min(5, remaining);
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `📊 تم عرض ${offset + rows.length} من إجمالي ${total} وحدة مطابقة.`,
        `📊 Showing ${offset + rows.length} of ${total} matching units.`
      ),
      [
        {
          id: "MORE_SEARCH",
          title: M(
            lang,
            `➡️ عرض المزيد (${nextBatch})`,
            `➡️ View More (${nextBatch})`
          )
        }
      ]
    );
  }

  logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: more ? "search_more" : "search_query",
    status: "success",
    total_duration_ms: Date.now() - t0,
    gemini_ms: geminiMs
  }).catch(() => {});
}

/* ====================================================================== */
/* 13. Inbound Ingress Router & Document Handling                        */
/* ====================================================================== */

async function handleText(broker, message) {
  const raw = ((message.text && message.text.body) || "").trim();
  if (!raw) return "done";

  // Check commands first
  if (await handleCommand(broker, raw)) return "done";

  // Intercept open drafts: text appends to draft notes
  const activeDraft = await Drafts.getDraft(broker.id);
  if (activeDraft) {
    await Drafts.appendText(broker.id, raw);
    await reply(
      broker,
      M(
        broker.preferred_lang || "ar",
        "📝 تم تدوين الملاحظة وإضافتها للمسودة. أرسل المزيد أو اكتب *تم* للحفظ.",
        "📝 Note recorded and added to draft. Send more or type *done* to review."
      )
    );
    return "done";
  }

  // Check direct unit code lookups
  const parsedCode = T.parseExplicitUnitCode(raw);
  if (parsedCode.hasCode && !parsedCode.cleanText) {
    const listing = await fetchListing(broker, parsedCode.code);
    if (listing) {
      await showListingCard(broker, listing);
      return "done";
    }
  }

  return (await handleSearchMessage(broker, { text: raw })) || "done";
}

async function handleAudio(broker, message) {
  const t0 = Date.now();
  const voiceId =
    (message.voice && message.voice.id) || (message.audio && message.audio.id);
  if (!voiceId) return "done";

  const lang = broker.preferred_lang || "ar";
  const audioData = await WA.downloadWhatsAppMedia(voiceId);

  if (!audioData || !audioData.buffer) {
    log("error", "Failed to download WhatsApp voice media", { voiceId });
    return "done";
  }

  const activeDraft = await Drafts.getDraft(broker.id);
  if (activeDraft) {
    await Drafts.appendVoice(broker.id, {
      buffer: audioData.buffer,
      mimeType: audioData.mimeType || "audio/ogg"
    });

    await reply(
      broker,
      M(
        lang,
        "🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة.\nأرسل المزيد، أو اكتب *تم* للمراجعة والاعتماد.",
        "🎙️ Voice note added to draft.\nSend more or type *done* to review."
      )
    );
    return "done";
  }

  // Audio query transcription
  const transcription = await AI.transcribeAudio(
    audioData.buffer,
    audioData.mimeType
  );
  if (!transcription) {
    await reply(
      broker,
      M(
        lang,
        "⚠️ تعذر الاستماع للرسالة الصوتية بوضوح، يرجى إعادة إرسالها أو كتابة طلبك.",
        "⚠️ Could not transcribe voice note. Please retry or type your query."
      )
    );
    return "done";
  }

  return handleSearchMessage(broker, { text: transcription, audio: audioData });
}

async function handleImage(broker, message) {
  const imageId = message.image?.id;
  if (!imageId) return "done";

  const lang = broker.preferred_lang || "ar";
  const imgData = await WA.downloadWhatsAppMedia(imageId);

  if (!imgData || !imgData.buffer) {
    log("error", "Failed to download WhatsApp image", { imageId });
    return "done";
  }

  let draft = await Drafts.getDraft(broker.id);
  const isNewDraft = !draft;

  if (isNewDraft) {
    draft = await Drafts.createDraft(broker.id, broker.agency_id);
  }

  await Drafts.appendMedia(broker.id, {
    mediaId: imageId,
    buffer: imgData.buffer,
    mimeType: imgData.mimeType || "image/jpeg"
  });

  if (isNewDraft) {
    await reply(
      broker,
      M(
        lang,
        "📝 *تم فتح مسودة جديدة للوحدة*\n📷 استلمنا الصورة الأولى. أرسل باقي الصور ثم الملاحظات (صوت أو كتابة)، واكتب *تم* للمراجعة.",
        "📝 *New draft opened*\n📷 First photo received. Send remaining photos, voice/text notes, then type *done* to review."
      )
    );
  }

  return "done";
}

/**
 * Handles incoming .xlsx spreadsheet uploads for bulk inventory import.
 */
async function handleDocument(broker, message) {
  const t0 = Date.now();
  const doc = message.document;
  if (!doc || !doc.id) return "done";

  const lang = broker.preferred_lang || "ar";
  const filename = doc.filename || "inventory.xlsx";

  if (!/\.xlsx$/i.test(filename)) {
    return reply(
      broker,
      M(
        lang,
        "⚠️ يقبل النظام ملفات الإكسيل بصيغة .xlsx فقط لمعالجة المخزون المجمع.",
        "⚠️ System only supports .xlsx files for bulk inventory ingestion."
      )
    );
  }

  await reply(
    broker,
    M(
      lang,
      `⏳ استلمنا ملف الإكسيل: *${filename}*.\nجاري فحص البيانات وتدقيق الحقول الإلزامية...`,
      `⏳ Received Excel file: *${filename}*.\nValidating rows and mandatory fields...`
    )
  );

  const downloaded = await WA.downloadWhatsAppMedia(doc.id);
  if (!downloaded || !downloaded.buffer) {
    return reply(
      broker,
      M(lang, "❌ تعذر تحميل ملف الإكسيل.", "❌ Failed to download Excel file.")
    );
  }

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(downloaded.buffer);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      return reply(
        broker,
        M(
          lang,
          "❌ ملف الإكسيل لا يحتوي على أوراق عمل.",
          "❌ Excel file contains no worksheets."
        )
      );
    }

    const rows = [];
    let headerRowValues = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1 || rowNumber === 4) {
        // Detect header row
        const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (vals.some((v) => /code|كود|price|سعر/i.test(String(v)))) {
          headerRowValues = vals.map(String);
        }
      }
      if (rowNumber > 1) {
        rows.push({
          rowNumber,
          values: Array.isArray(row.values) ? row.values.slice(1) : []
        });
      }
    });

    const validToCommit = [];
    const rejectedRows = [];

    for (const r of rows) {
      const vals = r.values;
      if (
        !vals.length ||
        vals.every((v) => v === null || v === undefined || v === "")
      ) {
        continue;
      }

      const codeRaw = vals[0];
      const titleRaw = vals[1];
      const compoundRaw = vals[2];
      const typeRaw = vals[3];
      const priceRaw = vals[4];
      const areaRaw = vals[5];
      const bedsRaw = vals[6];

      const cleanCode = T.extractCleanCode(codeRaw);
      const priceParsed = T.parseEgyptianPrice(priceRaw);
      const areaNum = Number(String(areaRaw || "").replace(/[^0-9.]/g, ""));
      const isStudio = /studio|استوديو/i.test(String(typeRaw || ""));

      // Evaluate Mandatory Blockers
      const errors = [];
      if (!cleanCode) errors.push("Missing Unit Code");
      if (!priceParsed.priceValue)
        errors.push("Missing or invalid numeric price");
      if (!compoundRaw) errors.push("Missing compound or location");
      if (!areaNum || areaNum < 10) errors.push("Invalid Area (<10 sqm)");
      if (!isStudio && (!bedsRaw || isNaN(Number(bedsRaw))))
        errors.push("Missing bedroom count");

      if (errors.length) {
        rejectedRows.push({
          rowNumber: r.rowNumber,
          code: cleanCode || "-",
          reason: errors.join(", "),
          rawRowValues: vals
        });
      } else {
        validToCommit.push({
          code: cleanCode,
          title: String(titleRaw || `${compoundRaw} Unit`),
          compound: String(compoundRaw),
          property_type: isStudio ? "studio" : "apartment",
          price_value: priceParsed.priceValue,
          price_display: priceParsed.priceDisplay,
          area_value: areaNum,
          bedrooms: isStudio ? 0 : Number(bedsRaw),
          details: {
            title_en: String(titleRaw || `${compoundRaw} Unit`),
            compound_en:
              T.toEnglishSpec(compoundRaw, "compound") || String(compoundRaw)
          }
        });
      }
    }

    // Commit Valid Units Inside Database Transaction
    if (validToCommit.length > 0) {
      await withTransaction(async (client) => {
        for (const item of validToCommit) {
          await client.query(
            `INSERT INTO listings (agency_id, broker_id, code, title, compound, property_type, price_value, price_display, area_value, bedrooms, details, status, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', NOW())
             ON CONFLICT (agency_id, code) DO UPDATE SET
               title = EXCLUDED.title,
               compound = EXCLUDED.compound,
               price_value = EXCLUDED.price_value,
               price_display = EXCLUDED.price_display,
               area_value = EXCLUDED.area_value,
               bedrooms = EXCLUDED.bedrooms,
               details = listings.details || EXCLUDED.details,
               updated_at = NOW()`,
            [
              broker.agency_id,
              broker.id,
              item.code,
              item.title,
              item.compound,
              item.property_type,
              item.price_value,
              item.price_display,
              item.area_value,
              item.bedrooms,
              JSON.stringify(item.details)
            ]
          );
        }
      });
    }

    const summaryText = M(
      lang,
      `📊 *تقرير معالجة ملف المخزون:*\n• الإجمالي: ${rows.length} سطر\n• ✅ تم الحفظ والتحديث: ${validToCommit.length} وحدة\n• ❌ المرفوضات: ${rejectedRows.length} وحدة`,
      `📊 *Bulk Ingestion Report:*\n• Total Rows: ${rows.length}\n• ✅ Successfully Imported: ${validToCommit.length}\n• ❌ Rejected: ${rejectedRows.length}`
    );

    await reply(broker, summaryText);

    // If any units failed, automatically return rejection spreadsheet
    if (rejectedRows.length > 0) {
      const rejBuf = await E.buildRejectionWorkbook({
        rejectedRows,
        originalHeaders: headerRowValues
      });

      await WA.sendWhatsAppDocument(
        to(broker),
        rejBuf,
        `مرفوضات_${filename}`,
        M(
          lang,
          "📎 مرفق ملف الإكسيل بالصفوف المرفوضة وأسباب الاستبعاد. يرجى تصحيحها وإعادة رفعها.",
          "📎 Attached is the rejection spreadsheet with error reasons. Correct and re-upload."
        )
      );
    }

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "bulk_excel_import",
      status: "success",
      total_duration_ms: Date.now() - t0,
      metadata: {
        total_rows: rows.length,
        imported_count: validToCommit.length,
        rejected_count: rejectedRows.length
      }
    });
  } catch (err) {
    log("error", "handleDocument failed", errMeta(err));
    await reply(
      broker,
      M(
        lang,
        "❌ تعذر معالجة ملف الإكسيل لوجود تلف بالتنسيق.",
        "❌ Failed to parse Excel workbook."
      )
    );
  }

  return "done";
}

async function dispatchMessage(broker, message) {
  switch (message.type) {
    case "interactive":
      return handleInteractive(broker, message);
    case "text":
      return handleText(broker, message);
    case "audio":
    case "voice":
      return handleAudio(broker, message);
    case "image":
      return handleImage(broker, message);
    case "document":
      return handleDocument(broker, message);
    default:
      return "done";
  }
}

/* ====================================================================== */
/* 14. Message Processing Pipeline with Distributed Locks                 */
/* ====================================================================== */
async function processMessage(message) {
  const key = U.normalizePhone(message.from);

  return als.run({ reqId: message.id }, async () => {
    inFlight++;
    try {
      const broker = await getBroker(message.from);
      if (!broker) {
        if (!(unknownNotified.get(key) > Date.now())) {
          unknownNotified.set(key, Date.now() + 600000);
          await WA.sendWhatsAppText(
            key,
            "⚠️ هذا الرقم غير مسجل كوكيل عقاري معتمد لدينا."
          );
        }
        return markMsgs([message.id], "done");
      }

      const c = getRequestContext();
      c.agencyId = broker.agency_id;
      c.brokerId = broker.id;

      if (!broker.is_active) {
        await reply(broker, "⛔ الحساب معطل حالياً من قبل الإدارة.");
        return markMsgs([message.id], "done");
      }

      if (!msgRate(key)) return markMsgs([message.id], "done");

      if (!(lastTouch.get(key) > Date.now() - 300000)) {
        lastTouch.set(key, Date.now());
        query("UPDATE brokers SET last_active_at = NOW() WHERE id = $1", [
          broker.id
        ]).catch(() => {});
      }

      if (message.type !== "image" && message.type !== "document") {
        WA.markAsRead(message.id, {
          typing: message.type !== "interactive"
        }).catch(() => {});
      }

      const outcome = await dispatchMessage(broker, message);
      await markMsgs([message.id], outcome === "batched" ? "batched" : "done");
    } catch (err) {
      log("error", "processMessage top-level failure", errMeta(err));
      await markMsgs([message.id], "failed");
    } finally {
      inFlight--;
    }
  });
}

const scheduleMessage = (message) =>
  perBroker(U.normalizePhone(message.from), () => processMessage(message));

/* ====================================================================== */
/* 15. Webhook Ingestion & Early Drop for Delivery Statuses               */
/* ====================================================================== */
async function persistIncoming(body) {
  const msgs = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v) continue;

      if (v.statuses && (!v.messages || !v.messages.length)) {
        return [];
      }

      for (const m of v.messages || []) {
        if (m && m.id && m.from) msgs.push(m);
      }
    }
  }

  msgs.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const fresh = [];

  for (const m of msgs) {
    const r = await query(
      "INSERT INTO inbound_messages (msg_id, phone_key, payload) VALUES ($1,$2,$3) ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id",
      [m.id, U.normalizePhone(m.from), m]
    );
    if (r.rowCount) fresh.push(m);
  }
  return fresh;
}

/* ====================================================================== */
/* 16. Express Server & Webhook Endpoints                                 */
/* ====================================================================== */
const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

function verifySignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const sig = req.get("x-hub-signature-256") || "";
  if (!secret || !sig.startsWith("sha256=") || !req.rawBody) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");
  const got = sig.slice(7);

  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

app.post("/webhook", async (req, res) => {
  if (CFG.isProd && !verifySignature(req)) return res.sendStatus(401);

  let fresh = [];
  try {
    fresh = await persistIncoming(req.body);
  } catch (err) {
    log("error", "Failed to persist inbound webhook payload", errMeta(err));
    return res.sendStatus(500);
  }

  res.status(200).send("EVENT_RECEIVED");

  for (const m of fresh) {
    scheduleMessage(m).catch((e) =>
      log("error", "Schedule message failed", errMeta(e))
    );
  }
});

app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  return res.sendStatus(403);
});

app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res
      .status(200)
      .json({ status: "ok", inFlight, queue: listingLimiter.stats() });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

/* ====================================================================== */
/* 17. Graceful Boot & Shutdown Lifecycles                                */
/* ====================================================================== */
let server;
let isShuttingDown = false;

async function shutdown(sig) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("info", "Gracefully terminating server...", { sig });
  if (server) server.close();

  const until = Date.now() + 25000;
  while ((inFlight > 0 || perBroker.size() > 0) && Date.now() < until) {
    await U.sleep(300);
  }

  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function boot() {
  log("info", "Pre-warming fonts into RAM...");
  await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]).catch((err) => log("warn", "Font pre-warming failed", errMeta(err)));

  server = app.listen(CFG.port, () => {
    log("info", `AqarChat Real Estate Engine active on port ${CFG.port}`);
  });
}

if (require.main === module) {
  boot();
}

module.exports = { app, fetchListing, showListingCard };
