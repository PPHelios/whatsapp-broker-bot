// server.js
"use strict";

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const sharp = require("sharp");
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
/**
 * Step 1: Initiates deletion by sending a confirmation prompt with action buttons.
 */
async function cmdRequestDelete(broker, codeRaw, lang) {
  const code = T.extractCleanCode(codeRaw);
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  if (!canEdit(broker, listing)) {
    return reply(
      broker,
      M(
        lang,
        "⛔ ليس لديك صلاحية لحذف هذه الوحدة.",
        "⛔ You do not have permission to delete this listing."
      )
    );
  }

  const isEn = lang === "en";
  const title = listing.title || listing.compound || code;
  const priceStr =
    listing.price_display ||
    (listing.price_value ? T.formatPrice(listing.price_value, lang) : "-");

  const promptText = isEn
    ? `⚠️ *Are you sure you want to delete unit \`${code}\`?*\n\n• *Property:* ${title}\n• *Price:* ${priceStr}\n\nThis will permanently delete the unit and all associated images.`
    : `⚠️ *هل أنت متأكد من حذف الوحدة \`${code}\` نهائياً؟*\n\n• *العقار:* ${title}\n• *السعر:* ${priceStr}\n\nسيتم حذف بيانات الوحدة وجميع الصور والوسائط الخاصة بها تماماً.`;

  // Enforce <= 20 chars for Meta API button title ceiling
  const buttons = [
    {
      id: `del_confirm:${listing.id}:${code}`,
      title: isEn ? "Confirm Delete 🗑️" : "تأكيد الحذف 🗑️"
    },
    {
      id: "del_cancel",
      title: isEn ? "Cancel ❌" : "تراجع ❌"
    }
  ];

  await WA.sendWhatsAppButtons(to(broker), promptText, buttons);
}

/**
 * Updates listing status (Soft Delete / Sold / Archive / Active).
 */
async function cmdUpdateStatus(broker, codeRaw, newStatus, lang) {
  const t0 = Date.now();
  const code = T.extractCleanCode(codeRaw);
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  if (!canEdit(broker, listing)) {
    return reply(
      broker,
      M(
        lang,
        "⛔ ليس لديك صلاحية لتعديل حالة هذه الوحدة.",
        "⛔ You do not have permission to update this listing."
      )
    );
  }

  const validStatuses = ["active", "sold", "archived"];
  if (!validStatuses.includes(newStatus)) return false;

  try {
    await query(
      "UPDATE listings SET status = $1, updated_at = NOW() WHERE id = $2 AND agency_id = $3",
      [newStatus, listing.id, broker.agency_id]
    );

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "update_status",
      status: "success",
      total_duration_ms: Date.now() - t0,
      metadata: { old_status: listing.status, new_status: newStatus }
    });

    const statusLabels = {
      active: { ar: "نشطة (متاحة للبحث)", en: "Active (Available in search)" },
      sold: {
        ar: "تم البيع (محجوبة من البحث)",
        en: "Sold (Hidden from search)"
      },
      archived: {
        ar: "مؤرشفة (محجوبة من البحث)",
        en: "Archived (Hidden from search)"
      }
    };

    const label = statusLabels[newStatus] || { ar: newStatus, en: newStatus };
    await reply(
      broker,
      M(
        lang,
        `✅ تم تحديث حالة الوحدة \`${code}\` إلى: *${label.ar}*`,
        `✅ Unit \`${code}\` status updated to: *${label.en}*`
      )
    );
    return true;
  } catch (err) {
    log("error", "cmdUpdateStatus failed", errMeta(err));
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "update_status",
      status: "failed",
      error_code: err.code || "DB_ERROR",
      total_duration_ms: Date.now() - t0
    });
    await reply(
      broker,
      M(lang, "❌ تعذر تعديل حالة الوحدة.", "❌ Failed to update status.")
    );
    return true;
  }
}

/**
 * Executes direct inline attribute patches with GIN trigram index resync.
 */
async function cmdPatchListing(broker, codeRaw, fieldRaw, valueRaw, lang) {
  const t0 = Date.now();
  const code = T.extractCleanCode(codeRaw);
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  if (!canEdit(broker, listing)) {
    return reply(
      broker,
      M(
        lang,
        "⛔ ليس لديك صلاحية لتعديل هذه الوحدة.",
        "⛔ You do not have permission to edit this listing."
      )
    );
  }

  // Guard against corrupting primary developer models
  if (
    (listing.inventory_type === "developer_model" ||
      listing.is_primary_developer) &&
    /^(?:سعر|السعر|price)$/i.test(fieldRaw)
  ) {
    return reply(
      broker,
      M(
        lang,
        "⚠️ لا يمكن تعديل سعر وحدات المشاريع المطورة مباشرة لاحتوائها على مصفوفة أقساط وخصومات معتمدة.",
        "⚠️ Cannot directly patch base price on developer models with staged installment matrices."
      )
    );
  }

  const field = String(fieldRaw || "")
    .toLowerCase()
    .trim();
  const val = String(valueRaw || "").trim();
  if (!val) {
    return reply(
      broker,
      M(
        lang,
        "⚠️ يرجى تحديد القيمة الجديدة المطلوب تعديلها.",
        "⚠️ Please specify the new value."
      )
    );
  }

  let updateQuery = "";
  let params = [];
  let changeMsg = "";

  if (/^(?:سعر|السعر|price)$/i.test(field)) {
    const parsed = T.parseEgyptianPrice(val, {
      listingType: listing.listing_type
    });
    const newPrice = parsed.priceValue || Number(val.replace(/[^0-9.]/g, ""));
    if (!newPrice || isNaN(newPrice) || newPrice <= 0) {
      return reply(
        broker,
        M(
          lang,
          "⚠️ لم نتمكن من قراءة السعر الجديد. مثال: `تعديل N4-105 السعر 7.5 مليون`",
          "⚠️ Invalid price format."
        )
      );
    }
    const newDisplay = parsed.priceDisplay || T.formatPrice(newPrice, lang);
    updateQuery = `
      UPDATE listings
      SET price_value = $1, price_display = $2, flyer_cache = '{}'::jsonb, updated_at = NOW()
      WHERE id = $3 RETURNING *`;
    params = [newPrice, newDisplay, listing.id];
    changeMsg = M(
      lang,
      `تم تعديل السعر إلى: *${newDisplay}*`,
      `Price updated to: *${newDisplay}*`
    );
  } else if (/^(?:تشطيب|التشطيب|finishing)$/i.test(field)) {
    updateQuery = `
      UPDATE listings
      SET details = jsonb_set(COALESCE(details, '{}'::jsonb), '{finishing}', to_jsonb($1::text)),
          search_text_normalized = public.clean_arabic_text(title || ' ' || compound || ' ' || district || ' ' || $1 || ' ' || COALESCE(bedrooms::text, '') || ' غرف'),
          flyer_cache = '{}'::jsonb,
          updated_at = NOW()
      WHERE id = $2 RETURNING *`;
    params = [val, listing.id];
    changeMsg = M(
      lang,
      `تم تعديل التشطيب إلى: *${val}*`,
      `Finishing updated to: *${val}*`
    );
  } else if (/^(?:مساحة|المساحة|مساحه|المساحه|area)$/i.test(field)) {
    const newArea = Number(val.replace(/[^0-9.]/g, ""));
    if (!newArea || isNaN(newArea) || newArea < 10) {
      return reply(
        broker,
        M(
          lang,
          "⚠️ يرجى إدخال مساحة رقمية صحيحة بالمتر المربع.",
          "⚠️ Invalid area number."
        )
      );
    }
    updateQuery = `
      UPDATE listings
      SET area_value = $1, flyer_cache = '{}'::jsonb, updated_at = NOW()
      WHERE id = $2 RETURNING *`;
    params = [newArea, listing.id];
    changeMsg = M(
      lang,
      `تم تعديل المساحة إلى: *${newArea} م²*`,
      `Area updated to: *${newArea} sqm*`
    );
  } else if (/^(?:غرف|الغرف|نوم|bedrooms|beds)$/i.test(field)) {
    const newBeds = parseInt(val.replace(/[^0-9]/g, ""), 10);
    if (!newBeds || isNaN(newBeds) || newBeds < 1 || newBeds > 30) {
      return reply(
        broker,
        M(lang, "⚠️ يرجى إدخال عدد غرف صحيح.", "⚠️ Invalid bedroom count.")
      );
    }
    updateQuery = `
      UPDATE listings
      SET bedrooms = $1,
          search_text_normalized = public.clean_arabic_text(title || ' ' || compound || ' ' || district || ' ' || COALESCE(details->>'finishing', '') || ' ' || $1 || ' غرف'),
          flyer_cache = '{}'::jsonb,
          updated_at = NOW()
      WHERE id = $2 RETURNING *`;
    params = [newBeds, listing.id];
    changeMsg = M(
      lang,
      `تم تعديل عدد الغرف إلى: *${newBeds}*`,
      `Bedrooms updated to: *${newBeds}*`
    );
  } else {
    return reply(
      broker,
      M(
        lang,
        "⚠️ الحقل غير مدعوم للتعديل السريع. الحقول المتاحة: (السعر، التشطيب، المساحة، الغرف).\nمثال: `تعديل N4-105 السعر 7 مليون`",
        "⚠️ Unsupported field. Available: (price, finishing, area, bedrooms).\nExample: `edit N4-105 price 7M`"
      )
    );
  }

  try {
    const updatedRes = await query(updateQuery, params);
    const updatedListing = updatedRes.rows[0];

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "patch_listing",
      status: "success",
      total_duration_ms: Date.now() - t0,
      metadata: { field, new_val: val }
    });

    await reply(broker, `✅ ${changeMsg}`);
    if (updatedListing) {
      await showListingCard(broker, updatedListing);
    }
    return true;
  } catch (err) {
    log("error", "cmdPatchListing query failed", errMeta(err));
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "patch_listing",
      status: "failed",
      error_code: err.code || "DB_ERROR",
      total_duration_ms: Date.now() - t0
    });
    await reply(
      broker,
      M(lang, "❌ تعذر إتمام التعديل.", "❌ Failed to apply edits.")
    );
    return true;
  }
}

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

    // WhatsApp 24-Hour Session Expired
    if (apiCode === 131047 || apiSubcode === 131047) {
      log(
        "warn",
        "WhatsApp 24-hour session expired; cannot dispatch freeform text",
        {
          brokerId: broker?.id,
          phone: broker?.phone
        }
      );
      return null;
    }

    // Rate Limit Hit: Back off and retry once
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

async function withinAiQuota(agencyId, brokerId = null) {
  if (!CFG.aiDailyLimit && !CFG.brokerDailyLimit) return { ok: true };
  try {
    if (CFG.aiDailyLimit) {
      const r = await query(
        "SELECT COUNT(*)::int AS n FROM operation_logs WHERE agency_id = $1 AND created_at >= date_trunc('day', now()) AND tokens_input > 0",
        [agencyId]
      );
      if (r.rows[0].n >= CFG.aiDailyLimit) {
        return { ok: false, reason: "agency" };
      }
    }
    if (brokerId && CFG.brokerDailyLimit) {
      const br = await query(
        "SELECT COUNT(*)::int AS n FROM operation_logs WHERE broker_id = $1 AND created_at >= date_trunc('day', now()) AND tokens_input > 0",
        [brokerId]
      );
      if (br.rows[0].n >= CFG.brokerDailyLimit) {
        return { ok: false, reason: "broker" };
      }
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

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
    .rotate() // EXIF auto-orientation
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
/* 7. On-Demand Brochure Rendering                                        */
/* ====================================================================== */
async function renderFlyerOnDemand(
  broker,
  listing,
  { lang = "ar", theme = "dark", unbranded = false } = {}
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
    ? `unbranded_${lang}_${theme}`
    : `${broker.id}_${lang}_${theme}`;
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
    listing: {
      code: listing.code,
      title: listing.title,
      property_type: listing.property_type,
      listing_type: listing.listing_type,
      price_value: listing.price_value,
      price_display: listing.price_display,
      area_value: listing.area_value,
      bedrooms: listing.bedrooms,
      compound: listing.compound,
      district: listing.district,
      location: listing.location,
      payment_terms: listing.payment_terms,
      installment_years: listing.installment_years,
      down_payment_value: listing.down_payment_value,
      agent_name: broker.name,
      contact_phone: broker.contact_phone || broker.phone,
      details: listing.details || {}
    },
    agency,
    images: images.map((i) => i.url),
    lang,
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
/* 8. Property Presentation Cards & Confirmation Views                    */
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
  const specs = [
    `📐 *${isEn ? "Area:" : "المساحة:"}* ${
      listing.area_value ? `${listing.area_value}${isEn ? "sqm" : "م²"}` : "-"
    }`,
    `🛏️ *${isEn ? "Bedrooms:" : "الغرف:"}* ${listing.bedrooms || "-"}`,
    `🎨 *${isEn ? "Finishing:" : "التشطيب:"}* ${
      det.finishing ||
      listing.finishing_type ||
      (isEn ? "Fully Finished" : "تشطيب كامل")
    }`
  ].join(" | ");

  let priceSection = "";
  if (isPrimary && listing.payment_terms?.plans?.length) {
    const plans = listing.payment_terms.plans;
    const maxYears = Math.max(...plans.map((p) => p.years || 0));
    const minDownPct = Math.min(...plans.map((p) => p.down_payment_pct ?? 100));
    const bestCash = plans.find((p) => p.years === 0 || p.discount_pct >= 25);

    priceSection = isEn
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
  }

  const body = `${header}\n─────────────────────────\n${specs}\n${priceSection}\n📅 *${
    isEn ? "Delivery:" : "الاستلام:"
  }* ${listing.delivery_date || "2029"}`;

  const buttons = [
    {
      id: `flyer:ar:dark:${code}`,
      title: isEn ? "📄 Brochure" : "📄 البروشور"
    },
    {
      id: `plans_view:${code}`,
      title: isEn ? "💳 Payment Plans" : "💳 أنظمة السداد"
    },
    { id: `client:${code}`, title: isEn ? "📋 Client Text" : "📋 نص العميل" }
  ];

  setActiveListing(broker, code);
  await WA.sendWhatsAppButtons(to(broker), body, buttons);
}

/* ====================================================================== */
/* 9. Specialized Deliverable Dispatchers (Excel, Collateral, Plans)      */
/* ====================================================================== */

/**
 * Generates and sends the consolidated multi-tab Excel payment schedule.
 */
async function sendConsolidatedExcel(broker, code) {
  const t0 = Date.now();
  const lang = broker.preferred_lang || "ar";
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  const agency = await getAgency(broker.agency_id);
  const plans = listing.payment_terms?.plans || [];

  if (!plans.length) {
    return reply(
      broker,
      M(
        lang,
        `⚠️ الوحدة #${code} لا تحتوي على أنظمة تقسيط مصفوفية (بيانات إعادة بيع فردية).`,
        `⚠️ Listing #${code} does not contain multi-tier installment plans.`
      )
    );
  }

  await reply(
    broker,
    M(
      lang,
      "⏳ جاري توليد جدول السداد المعتمد (Excel)...",
      "⏳ Generating Excel schedule..."
    )
  );

  const excelBuffer = await E.buildMultiPlanWorkbook({
    listing,
    plans,
    agency,
    broker,
    lang
  });

  const filename = `جدول_سداد_${code}_${listing.compound || "NOLL"}.xlsx`;
  const caption = M(
    lang,
    `📊 جدول سداد الوحدة #${code} الشامل (مقارنة كافة الأنظمة + الأقساط الربع سنوية ووديعة الصيانة).`,
    `📊 Consolidated Payment Plan for #${code} (Comparison matrix + quarterly cash flows).`
  );

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

/**
 * Sends direct HTTPS preview links for marketing collateral (PDF brochures, layouts, Drive).
 */
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

  if (layoutPdf) {
    lines.push(
      `📐 *${
        isEn ? "Floor Plan PDF:" : "مخطط الشقة الهندسي (2D Layout):"
      }*\n${layoutPdf}\n`
    );
  }
  if (masterPlan) {
    lines.push(
      `🗺️ *${
        isEn ? "Master Plan:" : "المخطط العام للكمبوند (Master Plan):"
      }*\n${masterPlan}\n`
    );
  }
  if (masterBrochure) {
    lines.push(
      `📖 *${
        isEn ? "Project Brochure:" : "بروشور المشروع الكامل:"
      }*\n${masterBrochure}\n`
    );
  }
  if (driveUrl) {
    lines.push(
      `📁 *${
        isEn
          ? "Sales Kit Drive Folder:"
          : "مجلد الريندرات والصور الترويجية (Drive):"
      }*\n${driveUrl}\n`
    );
  }

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
      "⏳ Preparing full inventory Excel workbook..."
    )
  );

  const agency = await getAgency(broker.agency_id);
  const excelBuffer = await E.buildAgencyInventoryWorkbook({
    listings: r.rows,
    agency,
    broker,
    lang
  });

  const filename = `مخزون_الوكالة_${new Date()
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
  { flyerLang = "ar", theme = "dark", unbranded = false } = {}
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
        ? "⏳ جاري تصميم الكتالوج الأبيض (بدون بيانات الوكالة)..."
        : "⏳ جاري تصميم وإنشاء الكتالوج المعتمد للوحدة...",
      "⏳ Preparing brochure..."
    )
  );

  try {
    const res = await renderFlyerOnDemand(broker, listing, {
      lang: flyerLang || lang || "ar",
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

async function handleCommand(broker, raw) {
  if (!raw) return false;
  const n = String(raw)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u0640]/g, "")
    .trim();
  const lang = resolveLang(n, broker);
  let m;

  // 1. HELP MENU
  if (/^(?:مساعدة|مساعده|المساعدة|help|menu|منيو|اوامر|أوامر|\?|؟)$/i.test(n)) {
    await reply(broker, T.getHelpMessage(lang));
    return true;
  }
  // 1. ADD NEW LISTING COMMAND: "اضافة", "جديد", "add", "new"
  if (/^(?:اضافة|إضافة|جديد|add|new)$/i.test(n)) {
    await Drafts.clearDraft(broker.id);
    await Drafts.createDraft(broker.id, broker.agency_id);
    await reply(
      broker,
      M(
        lang,
        "📝 *بدء إضافة وحدة جديدة*\n\n1️⃣ أرسل صور الوحدة.\n2️⃣ أرسل التفاصيل (كتابة أو رسالة صوتية).\n3️⃣ أرسل *تم* أو *done* لحفظ الوحدة بالمخزون.",
        "📝 *Add New Listing*\n\n1️⃣ Send unit photos.\n2️⃣ Send details (text or voice).\n3️⃣ Send *done* to save to inventory."
      )
    );
    return true;
  }

  // 2. FINALIZE LISTING COMMAND: "تم", "حفظ", "done", "save"
  if (/^(?:تم|حفظ|done|save)$/i.test(n)) {
    await cmdCommitDraft(broker, lang);
    return true;
  }

  // FINALIZE AND SAVE LISTING: "تم", "done", "حفظ", "save"
  if (/^(?:تم|حفظ|done|save)$/i.test(n)) {
    const draft = await Drafts.getDraft(broker.id);
    if (
      !draft ||
      (!draft.texts?.length &&
        !draft.voice_buffers?.length &&
        !draft.media_items?.length)
    ) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ لا توجد مسودة نشطة تحتوي على بيانات لحفظها.",
          "⚠️ No active draft with data to save."
        )
      );
      return true;
    }

    await reply(
      broker,
      M(
        lang,
        "⏳ جاري استخراج البيانات ورفع الصور وتأكيد الوحدة...",
        "⏳ Processing and saving listing..."
      )
    );

    try {
      // 1. AI Extraction using Gemini
      const extraction = await AI.extractPropertyDetails({
        texts: draft.texts || [],
        voiceBuffers: draft.voice_buffers || [],
        lang
      });
      const listingData = extraction.draft;

      // 2. Upload images to Supabase Storage
      const uploadRes = await uploadImages(
        broker.agency_id,
        listingData.code,
        draft.media_items || []
      );

      // 3. Insert into Database
      const inserted = await Drafts.commitDraftToListing({
        broker,
        agencyId: broker.agency_id,
        listingData,
        images: uploadRes.ok
      });

      // 4. Clear the draft
      await Drafts.clearDraft(broker.id);

      await reply(
        broker,
        M(
          lang,
          `✅ تم اعتماد الوحدة بنجاح كود: \`${inserted.code}\``,
          `✅ Listing saved: \`${inserted.code}\``
        )
      );
      await showListingCard(broker, inserted);
    } catch (err) {
      log("error", "Failed to commit draft to listing", errMeta(err));
      await reply(
        broker,
        M(
          lang,
          "❌ حدث خطأ أثناء حفظ الوحدة، يرجى المحاولة لاحقاً.",
          "❌ Failed to save listing."
        )
      );
    }
    return true;
  }
  // 1. HELP MENU
  if (/^(?:مساعدة|مساعده|المساعدة|help|menu|منيو|اوامر|أوامر|\?|؟)$/i.test(n)) {
    await reply(broker, T.getHelpMessage(lang));
    return true;
  }

  // 2. EXCEL & STATS
  if (/^(?:تصدير|اكسيل|اكسل|excel|export)$/i.test(n)) {
    await cmdExport(broker, lang);
    return true;
  }

  // ◄── PLACE DRAFT CANCELLATION HERE ──────────────────────────────
  if (/^(?:إلغاء|الغاء|تراجع|cancel)$/i.test(n)) {
    const t0 = Date.now();
    const draft = await Drafts.getDraft(broker.id);

    if (draft) {
      await Drafts.clearDraft(broker.id);

      await logOperation({
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "draft_cancel",
        status: "success",
        total_duration_ms: Date.now() - t0,
        metadata: {
          had_images: (draft.media_items || []).length,
          had_text: (draft.texts || []).length
        }
      }).catch(() => {});

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
  // ────────────────────────────────────────────────────────────────

  const resolveTargetCode = (explicitCode) => {
    if (explicitCode) return T.extractCleanCode(explicitCode);
    return getActiveListingCode(broker);
  };

  // 3. PAYMENT PLANS COMMAND: "جدول NOLL" or "احسب KKJ654"
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

  // 4. COLLATERAL COMMAND: "مخطط NOLL" or "بروشور NOLL"
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

  // 5. FLYER COMMAND
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
      flyerLang: lang,
      theme: "dark"
    });
    return true;
  }

  // 6. CLIENT TEXT COMMAND
  if (
    (m = n.match(/^(?:عميل|زبون|client)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i))
  ) {
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
      await reply(broker, T.formatClientListingText(l, broker, lang));
    } else {
      await notFound(broker, targetCode);
    }
    return true;
  }
  // DRAFT IMAGE REPLACE (استبدال / replace) with telemetry
  if (/^(?:استبدال|replace)$/i.test(n)) {
    const t0 = Date.now();
    const draft = await Drafts.getDraft(broker.id);
    if (!draft) {
      await reply(
        broker,
        M(
          lang,
          "ℹ️ لا توجد مسودة نشطة حالياً لاستبدال صورها.",
          "ℹ️ No active draft found to replace images."
        )
      );
      return true;
    }

    await query(
      "UPDATE listing_drafts SET media_ids = '{}', updated_at = NOW() WHERE broker_id = $1",
      [broker.id]
    );

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "draft_replace_images",
      status: "success",
      total_duration_ms: Date.now() - t0,
      metadata: { cleared_images_count: (draft.media_ids || []).length }
    });

    await reply(
      broker,
      M(
        lang,
        "🔄 تم مسح الصور السابقة من المسودة بنجاح.\n📷 يمكنك الآن إرسال الصور الجديدة البديلة.",
        "🔄 Previous photos cleared from draft.\n📷 You can now send replacement photos."
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

  // 1. RAPID BUTTON CLICK DROP (3-Second Debounce per broker & button)
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

  // Lazy memory cleanup for debounce cache
  if (recentButtonClicks.size > 1000) {
    for (const [k, exp] of recentButtonClicks.entries()) {
      if (exp < now) recentButtonClicks.delete(k);
    }
  }
  // --- Deletion Execution & Cancellation Handlers ---
  if (replyId.startsWith("del_confirm:")) {
    const t0 = Date.now();
    const [, listingId, code] = replyId.split(":");
    let storagePaths = [];

    try {
      // 1. Database Transaction Boundary (Locks, re-verifies auth, cascades DB rows)
      await withTransaction(async (client) => {
        // Re-verify existence and ownership under lock
        const lRes = await client.query(
          "SELECT id, broker_id FROM listings WHERE id = $1 AND agency_id = $2 FOR UPDATE",
          [listingId, broker.agency_id]
        );
        const listing = lRes.rows[0];
        if (!listing) {
          throw new Error("NOT_FOUND_OR_UNAUTHORIZED");
        }

        // Re-verify authorization
        if (!canEdit(broker, listing)) {
          throw new Error("PERMISSION_DENIED");
        }

        // Collect storage paths before cascade deletion
        const imgRes = await client.query(
          "SELECT url FROM listing_images WHERE listing_id = $1",
          [listingId]
        );

        storagePaths = imgRes.rows
          .map((r) => {
            const match = String(r.url || "").match(/\/listing-images\/(.+)$/);
            return match ? match[1] : null;
          })
          .filter(Boolean);

        // Delete row (listing_images cascades automatically via foreign key)
        await client.query("DELETE FROM listings WHERE id = $1", [listingId]);
      });

      // 2. Storage Purge (Outside the database transaction to prevent locking DB pool)
      if (storagePaths.length > 0) {
        deleteStorageFiles(storagePaths).catch((err) => {
          log("warn", "Non-blocking storage file purge failed", {
            paths: storagePaths,
            ...errMeta(err)
          });
        });
      }

      // 3. Write Success Audit Log
      await logOperation({
        agency_id: broker.agency_id,
        broker_id: broker.id,
        listing_code: code,
        operation_type: "delete_listing",
        status: "success",
        total_duration_ms: Date.now() - t0,
        metadata: {
          listing_id: listingId,
          purged_images_count: storagePaths.length
        }
      });

      await reply(
        broker,
        M(
          lang,
          `🗑️ تم حذف الوحدة \`${code}\` ومسح جميع وسائطها المرفقة بنجاح.`,
          `🗑️ Unit \`${code}\` and its media files have been permanently deleted.`
        )
      );
    } catch (err) {
      log("error", "Listing deletion failed", errMeta(err));

      await logOperation({
        agency_id: broker.agency_id,
        broker_id: broker.id,
        listing_code: code,
        operation_type: "delete_listing",
        status: "failed",
        error_code:
          err.message === "PERMISSION_DENIED"
            ? "FORBIDDEN"
            : err.code || "DB_ERROR",
        total_duration_ms: Date.now() - t0
      });

      const errText =
        err.message === "PERMISSION_DENIED"
          ? M(
              lang,
              "⛔ ليس لديك صلاحية لحذف هذه الوحدة.",
              "⛔ Permission denied."
            )
          : M(
              lang,
              "❌ تعذر إتمام عملية الحذف.",
              "❌ Failed to delete listing."
            );
      await reply(broker, errText);
    }
    return "done";
  }

  if (replyId === "del_cancel") {
    await reply(
      broker,
      M(
        lang,
        "↩️ تم إلغاء عملية الحذف. لم يتم تعديل أي بيانات.",
        "↩️ Deletion canceled. No changes were made."
      )
    );
    return "done";
  }
  const lang = broker.preferred_lang || "ar";

  // Pagination Handler ("عرض المزيد")
  if (replyId === "MORE_SEARCH") {
    await handleSearchMessage(broker, { more: true });
    return "done";
  }

  // Dynamic Excel Export Action
  if (
    replyId.startsWith("compare_excel:") ||
    replyId.startsWith("export_excel:")
  ) {
    const code = replyId.split(":")[1];
    await sendConsolidatedExcel(broker, code);
    return "done";
  }

  // Collateral Preview Links Action
  if (replyId.startsWith("collateral:")) {
    const code = replyId.split(":")[1];
    await sendCollateralLinks(broker, code);
    return "done";
  }

  // Payment Plans Breakdown View (List Modal or Action Buttons)
  if (replyId.startsWith("plans_view:") || replyId.startsWith("plans_all:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);

    const plans = listing.payment_terms?.plans || [];
    if (plans.length) {
      const matchResult = F.filterMatchingPlans(listing.price_value, plans);
      await WA.sendPaymentPlansResponse(to(broker), code, matchResult, lang);
    } else {
      await sendConsolidatedExcel(broker, code);
    }
    return "done";
  }

  // Detailed Plan View from Modal List / Dual Buttons
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
      await WA.sendPaymentPlansResponse(to(broker), code, matchResult, lang);
    }
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "view_plan_detail",
      status: "success",
      total_duration_ms: Date.now() - t0,
      metadata: { plan_id: planId, years: targetPlan.years }
    }).catch(() => {});
    return "done";
  }

  // Standard Brochure Request
  if (replyId.startsWith("flyer:")) {
    const parts = replyId.split(":");
    const fLang = parts[1] || "ar";
    const theme = parts[2] || "dark";
    const code = parts[3];
    await cmdFlyer(broker, code, lang, { flyerLang: fLang, theme });
    return "done";
  }

  // Client Text Request
  if (replyId.startsWith("client:") || replyId.startsWith("share_client:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    await reply(broker, T.formatClientListingText(listing, broker, lang));
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "client_text_generated",
      status: "success",
      total_duration_ms: Date.now() - t0
    }).catch(() => {});
    return "done";
  }

  return "done";
}

/* ====================================================================== */
/* 12. Search Execution Engine (2-Pass Cascade & Financial Matching)     */
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

  // PASS 1: Strict Query Execution
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

  // PASS 2: Relaxed Fallback Cascade (If Pass 1 returns 0 rows)
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
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: more ? "search_more" : "search_query",
      status: "no_matches",
      total_duration_ms: Date.now() - t0,
      gemini_ms: geminiMs,
      metadata: { parsed_query: parsed }
    }).catch(() => {});

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
/* 13. Inbound Ingress Router (Lenient Codes & Audio Transcription)       */
/* ====================================================================== */
async function handleText(broker, message) {
  const raw = ((message.text && message.text.body) || "").trim();
  if (!raw) return "done";

  // Check commands first (Help, Excel, Add, Done, Replace, Cancel, Delete, etc.)
  if (await handleCommand(broker, raw)) return "done";

  // Intercept open drafts: text appends to draft notes rather than searching
  const activeDraft = await Drafts.getDraft(broker.id);
  if (activeDraft) {
    await Drafts.appendText(broker.id, raw);
    await reply(
      broker,
      M(
        broker.preferred_lang || "ar",
        "📝 تم تدوين الملاحظة وإضافتها للمسودة. أرسل المزيد أو اكتب *تم* للحفظ.",
        "📝 Note recorded and added to draft. Send more or type *done* to save."
      )
    );
    return "done";
  }

  // Check direct unit code lookups: `N4-105`, [N4-105], #N4-105
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

/**
 * 13. Context-Aware Audio Handler (Draft Recording vs. Property Search)
 */
/**
 * 13. Context-Aware Audio Handler (Draft Recording vs. Property Search)
 */
async function handleAudio(broker, message) {
  const t0 = Date.now();
  const voiceId =
    (message.voice && message.voice.id) || (message.audio && message.audio.id);
  if (!voiceId) return "done";

  const lang = broker.preferred_lang || "ar";

  // 1. Download voice audio buffer from Meta Graph API
  const dl0 = Date.now();
  const audioData = await WA.downloadWhatsAppMedia(voiceId);
  const mediaDownloadMs = Date.now() - dl0;

  if (!audioData || !audioData.buffer) {
    log("error", "Failed to download WhatsApp voice media", { voiceId });
    return "done";
  }

  // 2. CHECK ACTIVE DRAFT: If the broker has an open draft, append voice note to it!
  const activeDraft = await Drafts.getDraft(broker.id);
  if (activeDraft) {
    await Drafts.appendVoice(broker.id, {
      buffer: audioData.buffer,
      mimeType: audioData.mimeType || "audio/ogg"
    });

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "draft_append_audio",
      status: "success",
      media_download_ms: mediaDownloadMs,
      total_duration_ms: Date.now() - t0,
      metadata: {
        voice_id: voiceId,
        bytes: audioData.buffer.length,
        mime: audioData.mimeType
      }
    });

    await reply(
      broker,
      M(
        lang,
        "🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة.\nأرسل المزيد من التفاصيل، أو اكتب *تم* لاعتماد وحفظ الوحدة.",
        "🎙️ Voice note added to draft.\nSend more details or type *done* to finalize."
      )
    );
    return "done";
  }

  // 3. NO ACTIVE DRAFT: Transcribe via Gemini Audio Pipeline for property search
  const g0 = Date.now();
  const transcription = await AI.transcribeAudio(
    audioData.buffer,
    audioData.mimeType
  );
  const geminiMs = Date.now() - g0;

  if (!transcription) {
    await reply(
      broker,
      M(
        lang,
        "⚠️ تعذر الاستماع للرسالة الصوتية بوضوح، يرجى إعادة إرسالها أو كتابة طلبك.",
        "⚠️ Could not transcribe voice note. Please re-send or type your query."
      )
    );
    return "done";
  }

  await logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "voice_transcription",
    status: "success",
    media_download_ms: mediaDownloadMs,
    gemini_ms: geminiMs,
    total_duration_ms: Date.now() - t0,
    metadata: { transcription_preview: transcription.slice(0, 100) }
  });

  // Execute search using the transcribed text
  return handleSearchMessage(broker, {
    text: transcription,
    audio: audioData
  });
}

/**
 * 14. Image Ingress Handler: Collects photos into the broker's active draft
 */
async function handleImage(broker, message) {
  const t0 = Date.now();
  const imageId = message.image?.id;
  if (!imageId) return "done";

  const lang = broker.preferred_lang || "ar";

  // 1. Download image from Meta
  const dl0 = Date.now();
  const imgData = await WA.downloadWhatsAppMedia(imageId);
  const mediaDownloadMs = Date.now() - dl0;

  if (!imgData || !imgData.buffer) {
    log("error", "Failed to download WhatsApp image", { imageId });
    return "done";
  }

  // 2. Fetch or create draft
  let draft = await Drafts.getDraft(broker.id);
  const isNewDraft = !draft;

  if (isNewDraft) {
    draft = await Drafts.createDraft(broker.id, broker.agency_id);
  }

  // 3. Append image buffer to draft
  await Drafts.appendMedia(broker.id, {
    mediaId: imageId,
    buffer: imgData.buffer,
    mimeType: imgData.mimeType || "image/jpeg"
  });

  await logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "draft_append_image",
    status: "success",
    media_download_ms: mediaDownloadMs,
    total_duration_ms: Date.now() - t0,
    metadata: { image_id: imageId, bytes: imgData.buffer.length }
  });

  // Notify broker on first photo; stay quiet on subsequent photos in batch
  if (isNewDraft) {
    await reply(
      broker,
      M(
        lang,
        "📝 *تم فتح مسودة جديدة للوحدة*\n📷 استلمنا الصورة الأولى. أرسل باقي الصور ثم الملاحظات (صوت أو كتابة)، واكتب *تم* للحفظ.",
        "📝 *New draft opened*\n📷 First photo received. Send remaining photos, voice/text notes, then type *done* to save."
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

      if (message.type !== "image") {
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
/* 15. Webhook Ingestion & 2ms Early Drop for Delivery Statuses          */
/* ====================================================================== */
async function persistIncoming(body) {
  const msgs = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v) continue;

      // 2ms EARLY DROP: Ignore WhatsApp delivery receipts (sent, delivered, read)
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
/**
 * 15. Finalizes active draft: Runs Gemini extraction, uploads images, commits to database
 */
async function cmdCommitDraft(broker, lang) {
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
      "⏳ جاري تحليل بيانات الوحدة بواسطة الذكاء الاصطناعي ورفع الصور للمخزون...",
      "⏳ Analyzing listing with AI and uploading media..."
    )
  );

  try {
    // 1. Multimodal AI Extraction via Gemini
    const g0 = Date.now();
    const extraction = await AI.extractPropertyDetails({
      texts: draft.texts || [],
      voiceBuffers: draft.voice_buffers || [],
      lang
    });
    const geminiMs = Date.now() - g0;
    const listingData = extraction.draft;

    // 2. Upload images to Supabase Storage
    const u0 = Date.now();
    const uploadRes = await uploadImages(
      broker.agency_id,
      listingData.code,
      draft.media_items || []
    );
    const storageMs = Date.now() - u0;

    // 3. Atomic Database Commit
    const c0 = Date.now();
    const inserted = await Drafts.commitDraftToListing({
      broker,
      agencyId: broker.agency_id,
      listingData,
      images: uploadRes.ok
    });
    const dbMs = Date.now() - c0;

    // 4. Clear the active draft session
    await Drafts.clearDraft(broker.id);

    // 5. Write comprehensive audit log
    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: inserted.code,
      operation_type: "draft_commit",
      status: "success",
      gemini_ms: geminiMs,
      storage_upload_ms: storageMs,
      db_ms: dbMs,
      tokens_input: extraction.usage?.input || 0,
      tokens_output: extraction.usage?.output || 0,
      model_used: extraction.model,
      total_duration_ms: Date.now() - t0,
      metadata: {
        images_count: uploadRes.ok.length,
        images_failed: uploadRes.failed
      }
    });

    await reply(
      broker,
      M(
        lang,
        `✅ تم حفظ واعتماد الوحدة بنجاح كود: \`${inserted.code}\``,
        `✅ Listing saved successfully: \`${inserted.code}\``
      )
    );

    // Display the unit card immediately to verify
    await showListingCard(broker, inserted);
  } catch (err) {
    log("error", "Failed to commit draft to listing", errMeta(err));

    await logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "draft_commit",
      status: "failed",
      error_code: err.code || err.message?.slice(0, 50) || "COMMIT_FAILED",
      total_duration_ms: Date.now() - t0
    });

    await reply(
      broker,
      M(
        lang,
        "❌ حدث خطأ أثناء حفظ الوحدة، مسودتك محفوظة كما هي. حاول مرة أخرى بكتابة *تم*.",
        "❌ Failed to save listing. Your draft is preserved; please retry with *done*."
      )
    );
  }
}
/* ====================================================================== */
/* 16. Express Server & Webhook Verification Endpoints                    */
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
