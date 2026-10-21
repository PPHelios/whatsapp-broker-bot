// server.js
"use strict";
require("dotenv").config();
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const express = require("express");
const sharp = require("sharp");
const { GoogleGenAI } = require("@google/genai");

const { pool } = require("./lib/db");
const {
  uploadListingImage,
  uploadFlyerImage,
  deleteStorageFiles
} = require("./lib/supabase");
const { generateFlyerBuffer, loadFont } = require("./lib/flyer");
const WA = require("./lib/whatsapp");
const T = require("./lib/text");
const S = require("./lib/search");
const L = require("./lib/listing");
const U = require("./lib/util");
const Drafts = require("./lib/drafts");

/* ====================================================================== */
/* Config                                                                 */
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
  console.error("Missing required env vars:", missing.join(", "));
  process.exit(1);
}

sharp.concurrency(1);
sharp.cache({ items: 20, memory: 64 });

/* ====================================================================== */
/* Request Context & Logging                                              */
/* ====================================================================== */
const als = new AsyncLocalStorage();
const ctx = () => als.getStore() || {};

async function withDistributedListingLock(agencyId, code, workFn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [String(agencyId), String(code).toUpperCase()]
    );
    const result = await workFn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function log(level, msg, meta = {}) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    req: ctx().reqId,
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
    const apiCode = err?.response?.data?.error?.code || err?.code;
    const apiSubcode = err?.response?.data?.error?.error_subcode;

    if (apiCode === 131047 || apiSubcode === 131047) {
      log(
        "warn",
        "WhatsApp 24-hour session expired; cannot send freeform text",
        { brokerId: broker?.id, phone: broker?.phone }
      );
      return null;
    }

    if (apiCode === 80007 || apiCode === 130429) {
      log("warn", "WhatsApp API rate limit reached, retrying in 1s", {
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
/* Unified Canonical Observability (`operation_logs`)                     */
/* ====================================================================== */
async function logOperation(p) {
  const c = ctx();
  const sql = `
    INSERT INTO operation_logs (
      agency_id, broker_id, listing_code, operation_type, status, error_code,
      total_duration_ms, gemini_ms, media_download_ms, image_process_ms, flyer_render_ms, storage_upload_ms, db_ms,
      tokens_input, tokens_output, model_used, estimated_cost_usd
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  `;
  const cost = S.estimateCostUsd({
    input: p.tokens_input,
    output: p.tokens_output
  });
  try {
    await pool.query(sql, [
      c.agencyId || p.agency_id || null,
      c.brokerId || p.broker_id || null,
      p.listing_code || null,
      p.operation_type,
      p.status || "success",
      p.error_code || null,
      p.total_duration_ms || 0,
      p.gemini_ms || 0,
      p.media_download_ms || 0,
      p.image_process_ms || 0,
      p.flyer_render_ms || 0,
      p.storage_upload_ms || 0,
      p.db_ms || 0,
      p.tokens_input || 0,
      p.tokens_output || 0,
      p.model_used || null,
      cost
    ]);
  } catch (err) {
    log("warn", "failed to record operation log", errMeta(err));
  }
}

/* ====================================================================== */
/* Concurrency & State Maps                                               */
/* ====================================================================== */
const recentBrokerListings = new Map();
const brokerEditSessions = new Map(); // phone -> { code: string, at: number }
const brokerCache = new Map();
const agencyCache = new Map();
const unknownNotified = new Map();
const lastTouch = new Map();
const cooldowns = new Map();
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
    code: String(code).toUpperCase(),
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
/* Explicit Unit Code Parsing & Normalization                             */
/* ====================================================================== */
function normalizeArabicDigits(str) {
  return String(str || "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"["۰۱۲۳٤٥٦٧٨٩".indexOf(d)]);
}

function parseExplicitUnitCode(rawText) {
  if (!rawText) return { hasCode: false, code: null, cleanText: rawText };
  const normalized = normalizeArabicDigits(rawText.trim());
  const codeRegex = /(?:^|\s)(?:#|(?:code|كود|الكود)\s*:?\s*)([^\s]+)/i;
  const match = normalized.match(codeRegex);
  if (!match) {
    return { hasCode: false, code: null, cleanText: rawText };
  }

  const rawCandidate = match[1].replace(/^[#\-_]+|[#\-_]+$/g, "");
  if (/[\u0600-\u06FF]/.test(rawCandidate)) {
    return {
      hasCode: true,
      invalidArabic: true,
      code: null,
      cleanText: rawText.replace(match[0], "").trim()
    };
  }

  const validPattern = /^[A-Za-z0-9_-]{3,30}$/;
  if (!validPattern.test(rawCandidate)) {
    return {
      hasCode: true,
      invalidFormat: true,
      code: null,
      cleanText: rawText.replace(match[0], "").trim()
    };
  }

  const cleanCode = rawCandidate.toUpperCase();
  const cleanText = rawText.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return {
    hasCode: true,
    code: cleanCode,
    cleanText
  };
}

async function checkCodeConflict(agencyId, code) {
  if (!code) return null;
  const res = await pool.query(
    "SELECT code, title, status FROM listings WHERE agency_id = $1 AND code = $2 LIMIT 1",
    [agencyId, String(code).toUpperCase()]
  );
  return res.rows[0] || null;
}

/* ====================================================================== */
/* Gemini Gateway & Two-Tier AI Quota                                     */
/* ====================================================================== */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function withinAiQuota(agencyId, brokerId = null) {
  if (!CFG.aiDailyLimit && !CFG.brokerDailyLimit) return { ok: true };
  try {
    if (CFG.aiDailyLimit) {
      const r = await pool.query(
        "SELECT COUNT(*)::int AS n FROM operation_logs WHERE agency_id = $1 AND created_at >= date_trunc('day', now()) AND tokens_input > 0",
        [agencyId]
      );
      if (r.rows[0].n >= CFG.aiDailyLimit) {
        return { ok: false, reason: "agency" };
      }
    }
    if (brokerId && CFG.brokerDailyLimit) {
      const br = await pool.query(
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
  const models = [
    primary,
    "gemini-3.6-flash",
    CFG.geminiFallback || "gemini-3.5-flash-lite"
  ].filter((m, i, a) => m && a.indexOf(m) === i);

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
        log("warn", "gemini call failed", {
          model: currentModel,
          attempt,
          err: errMsg
        });

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
            `Model ${currentModel} failed (${
              isTimeout ? "timeout" : isSpike ? "503 spike" : "quota"
            }). Failing over...`
          );
          break;
        }

        if (!isTransientError(err)) break;

        if (attempt < maxRetries - 1) {
          const delay = 1500 * (attempt + 1) + Math.random() * 500;
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

/* ====================================================================== */
/* AI Gateway: Speech Transcription & Text/Audio Property Extraction      */
/* ====================================================================== */
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
/* Database Loaders                                                       */
/* ====================================================================== */
async function getBroker(from) {
  const key = U.normalizePhone(from);
  const hit = brokerCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.broker;
  const r = await pool.query(
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
  const r = await pool.query(
    "SELECT id, name, logo_url, primary_color, secondary_color, flyer_theme FROM agencies WHERE id = $1 LIMIT 1",
    [agencyId]
  );
  const row = r.rows[0] || {};
  agencyCache.set(agencyId, { row, exp: Date.now() + 300000 });
  return row;
}

async function loadListingImages(listingId) {
  const r = await pool.query(
    "SELECT id, url, role, position FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 15",
    [listingId]
  );
  return r.rows;
}

async function loadExisting(agencyId, code) {
  const r = await pool.query(
    "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 LIMIT 1",
    [agencyId, code]
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return {
    ...row,
    updatedAtMs: new Date(row.updated_at).getTime(),
    images: await loadListingImages(row.id)
  };
}

const canEdit = (broker, listing) =>
  CFG.allowColleagueEdits ||
  !listing.broker_id ||
  listing.broker_id === broker.id ||
  CFG.adminRoles.includes(String(broker.role || "").toLowerCase());

async function markMsgs(ids, status) {
  if (!ids || !ids.length) return;
  try {
    await pool.query(
      "UPDATE inbound_messages SET status = $2, updated_at = NOW() WHERE msg_id = ANY($1::text[])",
      [ids, status]
    );
  } catch (e) {
    log("warn", "mark msgs failed", errMeta(e));
  }
}

/* ====================================================================== */
/* Media Normalization & Storage                                          */
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

const toThumbnail = (buf) =>
  sharp(buf, { failOn: "none" })
    .resize({
      width: 768,
      height: 768,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 70 })
    .toBuffer()
    .catch(() => buf);

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
          log("error", "image upload failed", errMeta(e));
          return null;
        }
      })
    )
  );

  return { ok: out.filter(Boolean), failed: out.filter((x) => !x).length };
}

/* ====================================================================== */
/* Lazy Flyer Vision Engine (Diversity & Hero Hierarchy)                  */
/* ====================================================================== */
async function classifyListingImages(listing, images) {
  if (!images || !images.length) return images;
  const hasUnclassified = images.some((img) => !img.role);
  if (!hasUnclassified && listing.details?.image_order?.length) return images;

  try {
    const thumbs = await Promise.all(
      images.slice(0, 15).map(async (im) => {
        const buf =
          im.buffer ||
          (await U.withTimeout(
            fetch(im.url).then((r) => r.arrayBuffer()),
            7000,
            "img-fetch"
          )
            .then(Buffer.from)
            .catch(() => null));
        return buf ? await toThumbnail(buf) : null;
      })
    );

    const promptText =
      "You are an expert real estate creative director. Analyze these property photos to create a stunning marketing brochure.\n" +
      "TASK:\n" +
      "1. Classify each image role: 'reception', 'facade', 'master_bedroom', 'bedroom', 'kitchen', 'bathroom', 'terrace', 'view', 'garden', 'document', or 'other'.\n" +
      "2. HERO IMAGE RULES: Select the single best image as the cover hero (hero_index). It MUST be an impressive wide-angle reception/living area, exterior villa/building facade, or terrace/garden view. NEVER pick a bathroom, kitchen, hallway, close-up, or document.\n" +
      "3. DIVERSITY QUOTAS: Select up to 9 diverse photos (image_order). Enforce variety: maximum 2 reception, max 2 bedrooms, max 1 kitchen, max 1 terrace. Do NOT pick multiple repetitive angles of the same room.\n" +
      "4. REJECTION: Identify any payment schedules, text documents, floor plans, screenshots, or blurry shots and mark them as 'document' or 'other'. Exclude them from image_order.\n" +
      'Output JSON strictly conforming to: {"hero_index": number, "image_roles": string[], "image_order": number[]}';

    const parts = [{ text: promptText }];
    thumbs.forEach((buf) => {
      if (buf) {
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") }
        });
      }
    });

    const visionResult = await callGemini({
      contents: parts,
      config: { temperature: 0.1, responseMimeType: "application/json" }
    });

    const parsed = JSON.parse(cleanJson(visionResult.res.text));
    const imageRoles = Array.isArray(parsed.image_roles)
      ? parsed.image_roles
      : [];
    const imageOrder = Array.isArray(parsed.image_order)
      ? parsed.image_order
      : images.map((_, i) => i);

    if (
      typeof parsed.hero_index === "number" &&
      imageOrder.includes(parsed.hero_index)
    ) {
      const heroIdx = imageOrder.indexOf(parsed.hero_index);
      imageOrder.splice(heroIdx, 1);
      imageOrder.unshift(parsed.hero_index);
    }

    await Promise.all(
      images.map(async (im, idx) => {
        const role = imageRoles[idx] || "other";
        im.role = role;
        if (im.id) {
          await pool
            .query("UPDATE listing_images SET role = $1 WHERE id = $2", [
              role,
              im.id
            ])
            .catch(() => {});
        }
      })
    );

    await pool
      .query(
        "UPDATE listings SET details = jsonb_set(COALESCE(details, '{}'::jsonb), '{image_order}', $1::jsonb) WHERE id = $2",
        [JSON.stringify(imageOrder), listing.id]
      )
      .catch(() => {});

    return images;
  } catch (err) {
    log(
      "warn",
      "lazy image classification failed, proceeding with raw order",
      errMeta(err)
    );
    return images;
  }
}

async function renderFlyerOnDemand(
  broker,
  listing,
  { lang = "en", theme = "dark", unbranded = false } = {}
) {
  const t0 = Date.now();
  const perf = {
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: listing.code,
    operation_type: "flyer_ondemand",
    gemini_ms: 0,
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
  if (!images.length) return { ok: false, reason: "no_images" };

  const v0 = Date.now();
  images = await classifyListingImages(listing, images);
  perf.gemini_ms = Date.now() - v0;

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
      location: listing.location,
      agent_name: broker.name,
      contact_phone: broker.contact_phone || broker.phone,
      details: listing.details || {}
    },
    agency,
    images: images.map((i) => i.url),
    lang: "en",
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

  await pool
    .query(
      "UPDATE listings SET flyer_cache = jsonb_set(COALESCE(flyer_cache, '{}'::jsonb), $1::text[], $2::jsonb) WHERE id = $3",
      [[cacheKey], JSON.stringify(entry), listing.id]
    )
    .catch((e) => log("warn", "cache write failed", errMeta(e)));

  perf.total_duration_ms = Date.now() - t0;
  logOperation(perf).catch(() => {});

  return { ok: true, wa_media_id: waMediaId, url: flyerUrl, buf: flyerBuf };
}

/* ====================================================================== */
/* Atomic Listing Persistence                                             */
/* ====================================================================== */
async function insertImages(client, listingId, agencyId, start, images) {
  if (!images.length) return;
  const vals = [];
  const params = [];
  images.forEach((im, i) => {
    const b = params.length;
    params.push(listingId, agencyId, im.url, start + i, im.role || null);
    vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
  });
  await client.query(
    `INSERT INTO listing_images (listing_id, agency_id, url, position, role) VALUES ${vals.join(
      ","
    )}`,
    params
  );
}

async function persistListing({
  broker,
  code,
  existing,
  fields,
  newImages,
  replace,
  batchKey
}) {
  const agencyId = broker.agency_id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${agencyId}:${code}`
    ]);

    const cur = await client.query(
      "SELECT id, updated_at FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [agencyId, code]
    );
    const exists = cur.rowCount > 0;
    if (
      Boolean(existing) !== exists ||
      (exists &&
        new Date(cur.rows[0].updated_at).getTime() !== existing.updatedAtMs)
    ) {
      await client.query("ROLLBACK");
      return { conflict: true };
    }

    let row;
    if (!exists) {
      const ins = await client.query(
        `INSERT INTO listings (
           agency_id, broker_id, code, title, property_type, listing_type, price_value, price_display,
           area_value, bedrooms, location, compound, district, city, location_keywords, details, flyer_cache, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'{}'::jsonb,'active') RETURNING *`,
        [
          agencyId,
          broker.id,
          code,
          fields.title,
          fields.property_type,
          fields.listing_type,
          fields.price_value,
          fields.price_display,
          fields.area_value,
          fields.bedrooms,
          fields.location,
          fields.compound,
          fields.district,
          fields.city,
          fields.location_keywords,
          fields.details
        ]
      );
      row = ins.rows[0];
      await insertImages(client, row.id, agencyId, 0, newImages);
    } else {
      const id = existing.id;
      let start = 0;
      if (replace) {
        await client.query("DELETE FROM listing_images WHERE listing_id = $1", [
          id
        ]);
      } else {
        const pRes = await client.query(
          "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM listing_images WHERE listing_id = $1",
          [id]
        );
        start = Number(pRes.rows[0].p);
      }
      await insertImages(client, id, agencyId, start, newImages);

      const upd = await client.query(
        `UPDATE listings SET
           title=$1, property_type=$2, listing_type=$3, price_value=$4, price_display=$5, area_value=$6,
           bedrooms=$7, location=$8, compound=$9, district=$10, city=$11, location_keywords=$12, details=$13,
           flyer_cache = CASE WHEN $14::boolean THEN '{}'::jsonb ELSE flyer_cache END,
           updated_at = NOW()
         WHERE id = $15 RETURNING *`,
        [
          fields.title,
          fields.property_type,
          fields.listing_type,
          fields.price_value,
          fields.price_display,
          fields.area_value,
          fields.bedrooms,
          fields.location,
          fields.compound,
          fields.district,
          fields.city,
          fields.location_keywords,
          fields.details,
          Boolean(newImages.length || replace),
          id
        ]
      );
      row = upd.rows[0];
    }

    await client.query(
      "INSERT INTO processed_batches (batch_key, agency_id, listing_code) VALUES ($1,$2,$3)",
      [batchKey, agencyId, code]
    );
    await client.query("COMMIT");
    return { listing: row, created: !exists };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") {
      if (String(err.constraint || "").includes("processed_batches"))
        return { duplicate: true };
      return { conflict: true, codeConflict: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

/* ====================================================================== */
/* Confirmation Bubbles & Card Displays                                   */
/* ====================================================================== */
async function sendListingConfirmation(broker, listing, created = true) {
  const lang = broker.preferred_lang || "ar";
  const rawCode = String(listing?.code || "UNT")
    .trim()
    .toUpperCase();
  const safeCode = rawCode.replace(/[^A-Z0-9_-]/g, "");

  const titleAr = created ? "تم حفظ الوحدة بنجاح" : "تم تحديث الوحدة بنجاح";
  const titleEn = created
    ? "Unit saved successfully"
    : "Unit updated successfully";

  let body =
    lang === "en"
      ? `✅ *${titleEn} #${safeCode}*\n📍 ${listing?.location || "-"}\n💰 ${
          listing?.price_display || "-"
        }`
      : `✅ *${titleAr} #${safeCode}*\n📍 ${listing?.location || "-"}\n💰 ${
          listing?.price_display || "-"
        }`;

  if (listing?.details?.ambiguous_location) {
    body +=
      lang === "en"
        ? "\n\n⚠️ *Location Note:* The compound name might exist in multiple areas. Please review and clarify if needed."
        : "\n\n⚠️ *تنبيه موقع:* اسم الكمبوند قد يحتمل أكثر من منطقة. يرجى مراجعة وتحديد الموقع في الوصف إن لزم.";
  }

  // 3 Actions: Brochure, Client Text, Edit (No "Sold" button on creation)
  const buttons = [
    {
      id: "flyer:en:dark:" + safeCode,
      title: lang === "en" ? "📄 Brochure" : "📄 بروشور"
    },
    {
      id: "client:" + safeCode,
      title: lang === "en" ? "📋 Client Text" : "📋 نص العميل"
    },
    {
      id: "edit_btn:" + safeCode,
      title: lang === "en" ? "✏️ Edit" : "✏️ تعديل"
    }
  ];

  const phone = to(broker);
  await WA.sendWhatsAppButtons(phone, body, buttons);
  await WA.sendWhatsAppText(phone, "`" + safeCode + "`");

  if (created) {
    await reply(broker, T.formatClientListingText(listing, broker, lang));
  }
}

async function showListingCard(broker, listing) {
  const lang = broker.preferred_lang || "ar";
  const code = String(listing.code || "").toUpperCase();
  const det = listing.details || {};

  const statusLabel =
    listing.status === "active"
      ? M(lang, "نشطة", "Active")
      : listing.status === "sold"
      ? M(lang, "تم البيع", "Sold")
      : listing.status;

  let bedStr = listing.bedrooms ? `${listing.bedrooms}` : "-";
  const extras = [];
  if (det.has_master_bedroom) extras.push(M(lang, "ماستر", "Master"));
  if (det.has_dressing_room) extras.push(M(lang, "دريسنج", "Dressing"));
  if (extras.length) bedStr += ` (${extras.join(" + ")})`;

  const finishingDisplay =
    lang === "en"
      ? det.finishing_en || det.finishing || "-"
      : det.finishing || det.finishing_en || "-";

  let body = M(
    lang,
    `🏠 *تفاصيل الوحدة #${code}*\n📍 الموقع: ${
      listing.location || "-"
    }\n💰 السعر: ${
      listing.price_display || "-"
    }\n🛏️ الغرف: ${bedStr}\n🛁 الحمامات: ${det.bathrooms || "-"}\n🏢 الدور: ${
      det.floor || "-"
    }\n🎨 التشطيب: ${finishingDisplay}\n📐 المساحة: ${
      listing.area_value ? `${listing.area_value}م²` : "-"
    }\nالحالة: *${statusLabel}*`,
    `🏠 *Unit Details #${code}*\n📍 Location: ${
      listing.location || "-"
    }\n💰 Price: ${
      listing.price_display || "-"
    }\n🛏️ Beds: ${bedStr}\n🛁 Baths: ${det.bathrooms || "-"}\n🏢 Floor: ${
      det.floor || "-"
    }\n🎨 Finishing: ${finishingDisplay}\n📐 Area: ${
      listing.area_value ? `${listing.area_value} sqm` : "-"
    }\nStatus: *${statusLabel}*`
  );

  const buttons = [
    { id: "flyer:en:dark:" + code, title: M(lang, "📄 بروشور", "📄 Brochure") },
    { id: "client:" + code, title: M(lang, "📋 نص العميل", "📋 Client Text") },
    { id: "edit_btn:" + code, title: M(lang, "✏️ تعديل", "✏️ Edit") }
  ];

  setActiveListing(broker, code);
  const phone = to(broker);
  await WA.sendWhatsAppButtons(phone, body, buttons);
  await WA.sendWhatsAppText(phone, "`" + code + "`");
}

/* ====================================================================== */
/* Delete & Edit Handlers                                                 */
/* ====================================================================== */
async function promptDeleteListing(broker, codeRaw, lang) {
  const code = codeRaw.toUpperCase();
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  if (!canEdit(broker, listing)) {
    return reply(
      broker,
      M(
        lang,
        "⛔ لا تملك صلاحية حذف هذه الوحدة.",
        "⛔ Unauthorized to delete this unit."
      )
    );
  }

  await WA.sendWhatsAppButtons(
    to(broker),
    M(
      lang,
      `⚠️ *تحذير:* هل أنت متأكد من حذف الوحدة *#${code}* نهائياً؟\nسيتم مسح كافة البيانات والصور والبروشورات المعتمدة من الخادم ولا يمكن التراجع.`,
      `⚠️ *Warning:* Are you sure you want to permanently delete unit *#${code}*?\nAll data, images, and brochures will be permanently erased.`
    ),
    [
      {
        id: `confirm:delete:${code}`,
        title: M(lang, "⚠️ تأكيد الحذف", "⚠️ Confirm Delete")
      },
      { id: "CANCEL_ACTION", title: M(lang, "❌ إلغاء", "❌ Cancel") }
    ]
  );
}

function enterEditMode(broker, code) {
  const lang = broker.preferred_lang || "ar";
  brokerEditSessions.set(to(broker), {
    code: code.toUpperCase(),
    at: Date.now()
  });

  return reply(
    broker,
    M(
      lang,
      `✏️ *وضع التعديل نشط للوحدة #${code}*\nأرسل التعديلات المطلوبة مباشرة عبر رسالة نصية أو فويس نوت (مثال: *"السعر 11 مليون والدور الثالث مع دريسنج وماستر"*).\n\n• تم قفل الكود تلقائياً ولا داعي لذكره في الصوت أو النص.\n• اكتب *إلغاء* للخروج من وضع التعديل.`,
      `✏️ *Edit Mode active for #${code}*\nSend the changes via text or voice note (e.g. *"Price 11M, 3rd floor with dressing and master"*).\n\n• Code is locked automatically.\n• Type *cancel* to exit.`
    )
  );
}

async function applyListingEdit(broker, code, instructions, lang) {
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  if (!canEdit(broker, listing)) {
    return reply(
      broker,
      M(
        lang,
        "⛔ لا تملك صلاحية تعديل هذه الوحدة.",
        "⛔ Unauthorized to edit this unit."
      )
    );
  }

  reply(
    broker,
    M(
      lang,
      "⏳ جاري تطبيق التعديلات وتحديث الوحدة...",
      "⏳ Applying updates..."
    )
  ).catch(() => {});

  const currentSnapshot = {
    title: listing.title,
    price_value: listing.price_value,
    price_display: listing.price_display,
    area_value: listing.area_value,
    bedrooms: listing.bedrooms,
    location: listing.location,
    compound: listing.compound,
    details: listing.details || {}
  };

  const prompt = `You are a real estate database updater for Egypt.
CURRENT LISTING:
${JSON.stringify(currentSnapshot)}

REQUESTED CHANGES:
"${instructions}"

RULES:
1. Extract ONLY modified fields.
2. If price changes, calculate numeric price_value and detect currency ("EGP", "USD", "EUR").
3. If floor/finishing changes, set both Arabic and English fields (e.g. floor, floor_en, finishing, finishing_en).
4. If master bedroom or dressing room is mentioned, update has_master_bedroom / has_dressing_room.
5. Strictly use "ناني" / "Nanny Room". Never "خادمة".
6. Return JSON only conforming to:
{
  "price_value": number or null,
  "currency": "EGP" | "USD" | "EUR" | null,
  "area_value": number or null,
  "bedrooms": number or null,
  "compound": string or null,
  "location": string or null,
  "details": object or null
}`;

  try {
    const aiRes = await callGemini({
      contents: [{ text: prompt }],
      config: { temperature: 0.1, responseMimeType: "application/json" }
    });

    const patch = JSON.parse(cleanJson(aiRes.res.text));

    await withDistributedListingLock(broker.agency_id, code, async (client) => {
      const mergedDetails = {
        ...(listing.details || {}),
        ...(patch.details || {})
      };
      if (patch.currency) mergedDetails.currency = patch.currency;

      const newPrice = patch.price_value ?? listing.price_value;
      const newDisplay = newPrice
        ? T.formatAbbreviatedPrice(
            newPrice,
            mergedDetails.currency || "EGP",
            lang
          )
        : listing.price_display;

      await client.query(
        `UPDATE listings SET
           price_value = $1, price_display = $2,
           area_value = COALESCE($3, area_value),
           bedrooms = COALESCE($4, bedrooms),
           compound = COALESCE($5, compound),
           location = COALESCE($6, location),
           details = $7,
           flyer_cache = '{}'::jsonb,
           updated_at = NOW()
         WHERE id = $8`,
        [
          newPrice,
          newDisplay,
          patch.area_value,
          patch.bedrooms,
          patch.compound,
          patch.location,
          mergedDetails,
          listing.id
        ]
      );
    });

    brokerEditSessions.delete(to(broker));
    const updated = await fetchListing(broker, code);
    setActiveListing(broker, code);

    await reply(
      broker,
      M(
        lang,
        `✅ تم تعديل بيانات الوحدة #${code} بنجاح.`,
        `✅ Unit #${code} updated.`
      )
    );
    await showListingCard(broker, updated);
  } catch (err) {
    log("error", "applyListingEdit failure", errMeta(err));
    await reply(
      broker,
      M(
        lang,
        "❌ فشل تعديل البيانات. يرجى المحاولة لاحقاً.",
        "❌ Edit failed. Try again."
      )
    );
  }
}

/* ====================================================================== */
/* Draft Finalizer (Parallel I/O, Zero Vision at Save)                    */
/* ====================================================================== */
async function finalizeDraft(broker, draft) {
  const t0 = Date.now();
  const lang = broker.preferred_lang || "ar";
  const agencyId = broker.agency_id;
  const mediaCount = (draft.media_ids || []).length;
  const textCount = (draft.texts || []).length;
  const voiceCount = (draft.voice_ids || []).length;

  if (textCount === 0 && voiceCount === 0) {
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `⚠️ لا يمكن تسجيل الوحدة بالصور فقط (${mediaCount} صور مرفقة).\nيرجى إرسال فويس نوت أو رسالة تحتوي على السعر والموقع، ثم اضغط حفظ.`,
        `⚠️ Cannot create listing with photos only (${mediaCount} photos attached).\nPlease send a voice note or text with the price and location, then tap Save.`
      ),
      [
        { id: "DRAFT_SAVE", title: M(lang, "✅ حفظ (تم)", "✅ Save") },
        { id: "DRAFT_CANCEL", title: M(lang, "❌ إلغاء", "❌ Cancel") }
      ]
    );
    return "done";
  }

  const quotaCheck = await withinAiQuota(agencyId, broker.id);
  if (!quotaCheck.ok) {
    const quotaMsg =
      quotaCheck.reason === "broker"
        ? M(
            lang,
            "⛔ تم استهلاك حد الذكاء الاصطناعي اليومي لحسابك (60 عملية).",
            "⛔ Daily personal AI limit reached (60 operations)."
          )
        : M(
            lang,
            "⛔ تم استهلاك حد الذكاء الاصطناعي اليومي للوكالة.",
            "⛔ Daily agency AI quota reached."
          );
    await reply(broker, quotaMsg);
    return "done";
  }

  await WA.sendWhatsAppText(
    to(broker),
    M(
      lang,
      "⏳ جاري استخراج المواصفات وحفظ العقار...",
      "⏳ Processing and saving listing..."
    )
  );

  const perf = {
    agency_id: agencyId,
    broker_id: broker.id,
    operation_type: "listing_draft_finalize",
    gemini_ms: 0,
    media_download_ms: 0,
    image_process_ms: 0,
    storage_upload_ms: 0,
    db_ms: 0,
    tokens_input: 0,
    tokens_output: 0,
    model_used: null
  };

  try {
    const dl0 = Date.now();
    const downloadedRaw = await Promise.all(
      (draft.media_ids || []).map((mid) =>
        WA.downloadWhatsAppMedia(mid).catch((err) => {
          log("warn", `Failed to download media ${mid}`, errMeta(err));
          return null;
        })
      )
    );
    perf.media_download_ms = Date.now() - dl0;

    const img0 = Date.now();
    const validImages = [];
    await Promise.all(
      downloadedRaw.filter(Boolean).map(async (f) => {
        try {
          const buffer = await normalizeImage(f.buffer);
          validImages.push({ buffer, mimeType: "image/jpeg" });
        } catch (e) {
          log("warn", "Sharp image compression failed", errMeta(e));
        }
      })
    );
    perf.image_process_ms = Date.now() - img0;

    const voiceBuffers = [];
    for (const vid of draft.voice_ids || []) {
      const vFile = await WA.downloadWhatsAppMedia(vid);
      if (vFile && vFile.buffer) {
        voiceBuffers.push({ buffer: vFile.buffer, mimeType: vFile.mimeType });
      }
    }

    let { code } = L.generateListingCode(draft.custom_code, "UNT");
    perf.listing_code = code;

    const gem0 = Date.now();
    const u0 = Date.now();

    const [aiResult, upResult] = await Promise.all([
      AI.extractPropertyDetails({
        texts: draft.texts || [],
        voiceBuffers,
        lang
      }),
      validImages.length
        ? uploadImages(agencyId, code, validImages).catch((err) => {
            log("error", "Parallel image upload failed", errMeta(err));
            return { ok: [], failed: validImages.length };
          })
        : Promise.resolve({ ok: [], failed: 0 })
    ]);

    perf.gemini_ms = Date.now() - gem0;
    perf.storage_upload_ms = Date.now() - u0;
    perf.tokens_input = aiResult.usage.input;
    perf.tokens_output = aiResult.usage.output;
    perf.model_used = aiResult.model;

    const extracted = aiResult.draft;

    if (!extracted || (!extracted.location && !extracted.compound)) {
      await WA.sendWhatsAppText(
        to(broker),
        M(
          lang,
          "❌ لم نتمكن من تحديد موقع العقار أو اسم الكمبوند. يرجى إرسال رسالة أو فويس نوت بالموقع ثم اكتب «تم».",
          "❌ Could not determine property location or compound. Please send the location and type «done»."
        )
      );
      return "done";
    }

    const price = T.parseEgyptianPrice(extracted.price_raw, {
      lang,
      listingType: extracted.listing_type || "sale"
    });

    let enriched = null;
    if (
      extracted.location &&
      extracted.location_keywords.length < 4 &&
      (await withinAiQuota(agencyId, broker.id)).ok
    ) {
      try {
        enriched = await S.enrichLocation(aiShim, {
          location: extracted.location,
          title: extracted.title,
          rawText: (draft.texts || []).join(" "),
          model: CFG.geminiFallback
        });
        extracted.compound = extracted.compound || enriched.compound || "";
        extracted.district = extracted.district || enriched.district || "";
        extracted.city = extracted.city || enriched.city || "";
        extracted.location_keywords = S.normalizeKeywords([
          ...extracted.location_keywords,
          ...enriched.keywords
        ]);
      } catch (e) {
        log("warn", "location enrichment skipped", errMeta(e));
      }
    }

    const fields = L.composeFields({
      existing: null,
      draft: extracted,
      price,
      imageOnly: false,
      lang,
      enriched
    });

    const batchKey = U.sha1(
      `${broker.id}:${code}:${draft.updated_at || Date.now()}`
    );

    const db0 = Date.now();
    let result = null;

    try {
      result = await persistListing({
        broker,
        code,
        existing: null,
        fields,
        newImages: upResult.ok,
        replace: false,
        batchKey
      });
    } catch (dbErr) {
      if (
        dbErr.code === "23505" ||
        dbErr.message?.includes("listings_agency_id_code_key")
      ) {
        await WA.sendWhatsAppText(
          to(broker),
          M(
            lang,
            `⚠️ الكود #${code} تم تسجيله للتو من قبل زميل آخر. أرسل كود مختلف مثل: #NEW-${code}`,
            `⚠️ Code #${code} was just taken by another agent. Please send a new code like: #NEW-${code}`
          )
        );
        return "done";
      }
      throw dbErr;
    }
    perf.db_ms = Date.now() - db0;

    const savedListing = result.listing;
    setActiveListing(broker, savedListing.code);

    await Drafts.clearDraft(broker.id);
    await sendListingConfirmation(broker, savedListing, result.created);

    perf.total_duration_ms = Date.now() - t0;
    logOperation(perf).catch(() => {});
    return "done";
  } catch (err) {
    log("error", "finalizeDraft top-level failure", errMeta(err));
    perf.status = "failed";
    perf.error_code = err.message;
    perf.total_duration_ms = Date.now() - t0;
    logOperation(perf).catch(() => {});

    await WA.sendWhatsAppText(
      to(broker),
      M(
        lang,
        "❌ حدث خطأ غير متوقع أثناء معالجة الوحدة. تم الاحتفاظ بالمسودة، يرجى المحاولة مرة أخرى لاحقاً.",
        "❌ An unexpected error occurred. Your draft has been preserved, please try again."
      )
    );
    return "done";
  }
}

/* ====================================================================== */
/* Search Execution: 5-Unit Card Stream & Pagination                      */
/* ====================================================================== */
async function handleSearchMessage(
  broker,
  { text = "", audio = null, more = false, msgId = null } = {}
) {
  const key = to(broker);
  const lang = broker.preferred_lang || "ar";
  const isVoice = Boolean(audio && audio.buffer && audio.buffer.length);
  let parsed;
  let offset = 0;

  if (more) {
    const st = (
      await pool.query(
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
    if (isVoice && audio.duration > CFG.maxSearchAudioSec) {
      await reply(
        broker,
        M(
          lang,
          `⚠️ تسجيل البحث طويل (${audio.duration} ث). الحد ${CFG.maxSearchAudioSec} ثانية.`,
          `⚠️ Search audio too long (${audio.duration}s). Max ${CFG.maxSearchAudioSec}s.`
        )
      );
      return;
    }

    const quotaCheck = await withinAiQuota(broker.agency_id, broker.id);
    if (!quotaCheck.ok) {
      await reply(
        broker,
        quotaCheck.reason === "broker"
          ? M(
              lang,
              "⛔ تم استهلاك حد الذكاء الاصطناعي اليومي لحسابك (60 عملية).",
              "⛔ Daily personal AI limit reached (60 operations)."
            )
          : M(
              lang,
              "⛔ تم استهلاك حد الذكاء الاصطناعي اليومي للوكالة.",
              "⛔ Daily agency AI limit reached."
            )
      );
      return;
    }

    // Removed "المخزون"
    reply(
      broker,
      isVoice
        ? M(lang, "🎙️ جاري الاستماع للبحث...", "🎙️ Listening...")
        : M(lang, "🔍 جاري البحث...", "🔍 Searching...")
    ).catch(() => {});

    try {
      ({ parsed } = await S.parseSearchRequest(aiShim, {
        text,
        audio: isVoice ? [audio] : [],
        model: CFG.geminiModel
      }));
    } catch (e) {
      log("warn", "search parse failed, using fallback", errMeta(e));
      if (isVoice) {
        await reply(
          broker,
          M(
            lang,
            "❌ تعذر فهم التسجيل. أعد المحاولة كتابةً.",
            "❌ Could not parse audio. Try typing."
          )
        );
        return;
      }
      parsed = S.fallbackParse(text);
    }

    if (parsed.intent === "listing") {
      await Drafts.appendToDraft(broker, { text });
      await WA.sendWhatsAppButtons(
        to(broker),
        M(
          lang,
          "📝 *تم فتح مسودة وحدة جديدة من المواصفات.*\nأرسل الصور أو فويس نوت، ثم اضغط *حفظ*.",
          "📝 *Started listing draft from specs.*\nSend photos or voice notes, then tap *Save*."
        ),
        [
          { id: "DRAFT_SAVE", title: M(lang, "✅ حفظ (تم)", "✅ Save") },
          { id: "DRAFT_CANCEL", title: M(lang, "❌ إلغاء", "❌ Cancel") }
        ]
      );
      return "batched";
    }

    if (parsed.intent === "other") {
      await reply(
        broker,
        M(
          lang,
          "👋 أهلاً بك! اكتب «مساعدة» لعرض الأوامر، أو اكتب مواصفات بحثك.",
          "👋 Welcome! Send «help» for commands or type your search."
        )
      );
      return;
    }
  }

  // 5 Units Per Page
  const run = async (relaxed) => {
    const { sql, params } = S.buildSearchQuery(broker.agency_id, parsed, {
      relaxed,
      limit: CFG.searchPageSize,
      offset
    });
    return (await pool.query(sql, params)).rows;
  };

  let rows;
  let relaxed = Boolean(parsed.__relaxed);
  try {
    rows = await run(relaxed);
  } catch (e) {
    log("error", "search query failed", errMeta(e));
    await reply(broker, M(lang, "❌ خطأ أثناء البحث.", "❌ Search error."));
    return;
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

  pool
    .query(
      `INSERT INTO broker_search_state (phone_key, parsed, next_offset, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (phone_key) DO UPDATE SET parsed = EXCLUDED.parsed, next_offset = EXCLUDED.next_offset, updated_at = NOW()`,
      [key, { ...parsed, __relaxed: relaxed }, offset + rows.length]
    )
    .catch(() => {});

  // Stream each unit card directly
  for (const unit of rows) {
    await showListingCard(broker, unit);
    await U.sleep(400); // Prevents notification bombardment
  }

  // Pagination navigation message if more units exist
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
}

/* ====================================================================== */
/* Command Handlers (Decoupled from DB Locks)                             */
/* ====================================================================== */
const notFound = (broker, code) =>
  reply(
    broker,
    M(
      broker.preferred_lang || "ar",
      `❌ الوحدة غير موجودة: #${code}`,
      `❌ Listing not found: #${code}`
    )
  );

async function fetchListing(broker, code) {
  const r = await pool.query(
    "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
    [broker.agency_id, String(code).toUpperCase()]
  );
  return r.rows[0] || null;
}

async function cmdPrice(broker, codeRaw, priceRaw, lang) {
  const code = codeRaw.toUpperCase();
  let outcome = null;

  await withDistributedListingLock(broker.agency_id, code, async (client) => {
    const r = await client.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [broker.agency_id, code]
    );
    const l = r.rows[0];
    if (!l) {
      outcome = { status: "not_found" };
      return;
    }
    if (!canEdit(broker, l)) {
      outcome = { status: "unauthorized" };
      return;
    }

    const p = T.parseEgyptianPrice(priceRaw, {
      lang,
      listingType: l.listing_type
    });
    if (!p.priceValue) {
      outcome = { status: "invalid_price" };
      return;
    }

    await client.query(
      "UPDATE listings SET price_value = $1, price_display = $2, flyer_cache = '{}'::jsonb, updated_at = NOW() WHERE id = $3",
      [p.priceValue, p.priceDisplay, l.id]
    );
    outcome = { status: "ok", priceDisplay: p.priceDisplay };
  });

  if (!outcome || outcome.status === "not_found") return notFound(broker, code);
  if (outcome.status === "unauthorized") {
    return reply(
      broker,
      M(
        lang,
        "⛔ لا تملك صلاحية تعديل هذه الوحدة.",
        "⛔ Unauthorized to edit this unit."
      )
    );
  }
  if (outcome.status === "invalid_price") {
    return reply(
      broker,
      M(
        lang,
        `❌ تعذر تحديد السعر. مثال: سعر ${code} إلى 18.5 مليون`,
        `❌ Invalid price. Example: price ${code} to 18.5M`
      )
    );
  }
  return reply(
    broker,
    M(
      lang,
      `✅ تم تعديل سعر الوحدة #${code} إلى ${outcome.priceDisplay} وتم تحديث الكاش.`,
      `✅ Price for #${code} updated to ${outcome.priceDisplay}. Flyer cache invalidated.`
    )
  );
}

async function cmdStatus(broker, codeRaw, newStatus, lang) {
  const code = codeRaw.toUpperCase();
  let outcome = null;

  await withDistributedListingLock(broker.agency_id, code, async (client) => {
    const r = await client.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [broker.agency_id, code]
    );
    const l = r.rows[0];
    if (!l) {
      outcome = { status: "not_found" };
      return;
    }
    if (!canEdit(broker, l)) {
      outcome = { status: "unauthorized" };
      return;
    }

    await client.query(
      "UPDATE listings SET status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, l.id]
    );
    outcome = { status: "ok" };
  });

  if (!outcome || outcome.status === "not_found") return notFound(broker, code);
  if (outcome.status === "unauthorized") {
    return reply(
      broker,
      M(
        lang,
        "⛔ لا تملك صلاحية تعديل حالة الوحدة.",
        "⛔ Unauthorized to change status."
      )
    );
  }

  const labels = {
    sold: M(lang, "تم البيع", "SOLD"),
    archived: M(lang, "مؤرشفة", "ARCHIVED"),
    active: M(lang, "نشطة", "ACTIVE")
  };
  return reply(
    broker,
    M(
      lang,
      `✅ أصبحت حالة الوحدة #${code}: *${labels[newStatus]}*.`,
      `✅ Unit #${code} status updated to: *${labels[newStatus]}*.`
    )
  );
}

async function cmdDelete(broker, codeRaw, lang) {
  const code = codeRaw.toUpperCase();
  let outcome = null;

  await withDistributedListingLock(broker.agency_id, code, async (client) => {
    const r = await client.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [broker.agency_id, code]
    );
    const l = r.rows[0];
    if (!l) {
      outcome = { status: "not_found" };
      return;
    }
    if (!canEdit(broker, l)) {
      outcome = { status: "unauthorized" };
      return;
    }

    const imgRows = await client.query(
      "SELECT url FROM listing_images WHERE listing_id = $1",
      [l.id]
    );
    const flyerCache = l.flyer_cache || {};
    const urls = imgRows.rows.map((row) => row.url);
    Object.values(flyerCache).forEach((v) => {
      if (v.url) urls.push(v.url);
    });

    const paths = urls
      .map((u) => {
        const m = u.match(
          /\/listing-images\/(agency_[^/]+\/listing_[^/]+\/[a-zA-Z0-9._-]+)$/
        );
        return m ? m[1] : null;
      })
      .filter(Boolean);

    if (paths.length) {
      await deleteStorageFiles(paths);
    }

    await client.query("DELETE FROM listings WHERE id = $1", [l.id]);
    outcome = { status: "ok" };
  });

  if (!outcome || outcome.status === "not_found") return notFound(broker, code);
  if (outcome.status === "unauthorized") {
    return reply(
      broker,
      M(
        lang,
        "⛔ لا تملك صلاحية حذف هذه الوحدة.",
        "⛔ Unauthorized to delete this unit."
      )
    );
  }
  return reply(
    broker,
    M(
      lang,
      `🗑️ تم حذف الوحدة #${code} نهائياً ومسح كافة وسائطها وملفاتها من السيرفر.`,
      `🗑️ Unit #${code} and all associated media permanently deleted.`
    )
  );
}

async function cmdStats(broker, lang) {
  const [counts, types, locs] = await Promise.all([
    pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status='active') AS active,
        COUNT(*) FILTER (WHERE status='sold') AS sold,
        COUNT(*) FILTER (WHERE status='archived') AS archived,
        COUNT(*) FILTER (WHERE broker_id = $2) AS mine
       FROM listings WHERE agency_id = $1`,
      [broker.agency_id, broker.id]
    ),
    pool.query(
      `SELECT property_type, COUNT(*) AS count
       FROM listings WHERE agency_id = $1 AND status='active'
       GROUP BY property_type ORDER BY count DESC LIMIT 4`,
      [broker.agency_id]
    ),
    pool.query(
      `SELECT COALESCE(NULLIF(compound,''), district) AS zone, COUNT(*) AS count
       FROM listings WHERE agency_id = $1 AND status='active' AND (compound <> '' OR district <> '')
       GROUP BY zone ORDER BY count DESC LIMIT 3`,
      [broker.agency_id]
    )
  ]);

  const s = counts.rows[0] || {};
  const typeLines = types.rows
    .map(
      (r) => `  • ${S.TYPE_AR[r.property_type] || r.property_type}: ${r.count}`
    )
    .join("\n");
  const locLines = locs.rows.map((r) => `  • ${r.zone}: ${r.count}`).join("\n");

  const msg = [
    M(
      lang,
      "📊 *تقرير مخزون الوكالة الفوري:*",
      "📊 *Agency Inventory Report:*"
    ),
    M(
      lang,
      `• الوحدات المعروضة (نشطة): ${s.active || 0}`,
      `• Active Listings: ${s.active || 0}`
    ),
    M(
      lang,
      `• الوحدات المباعة: ${s.sold || 0}`,
      `• Sold Listings: ${s.sold || 0}`
    ),
    M(
      lang,
      `• الوحدات المؤرشفة: ${s.archived || 0}`,
      `• Archived Listings: ${s.archived || 0}`
    ),
    M(
      lang,
      `• مساهمتك الشخصية: ${s.mine || 0} وحدة`,
      `• Your Listings: ${s.mine || 0}`
    ),
    "",
    M(lang, "*توزيع الوحدات النشطة:*", "*Active Types Breakdown:*"),
    typeLines || "  -",
    "",
    M(lang, "*أبرز المناطق بالمخزون:*", "*Top Active Locations:*"),
    locLines || "  -"
  ].join("\n");

  await reply(broker, msg);
}

async function cmdExport(broker, lang) {
  const key = `export:${U.normalizePhone(broker.phone)}`;
  if (cooldowns.get(key) > Date.now()) {
    return reply(
      broker,
      M(
        lang,
        "⏳ انتظر دقيقة قبل تصدير ملف جديد.",
        "⏳ Please wait a minute before another export."
      )
    );
  }
  cooldowns.set(key, Date.now() + 60000);

  const isAdmin = CFG.adminRoles.includes(
    String(broker.role || "").toLowerCase()
  );
  const r = await pool.query(
    `SELECT code, title, property_type, listing_type, price_value, price_display, area_value, bedrooms, location, compound, details, status, created_at
     FROM listings WHERE agency_id = $1 ${
       isAdmin ? "" : "AND broker_id = $2"
     } ORDER BY created_at DESC LIMIT 5000`,
    isAdmin ? [broker.agency_id] : [broker.agency_id, broker.id]
  );

  if (!r.rowCount) {
    return reply(
      broker,
      M(lang, "لا توجد وحدات للتصدير.", "No units available to export.")
    );
  }
  const csvData = T.listingsToCsv(r.rows);
  const sent = await WA.sendWhatsAppDocument(
    to(broker),
    Buffer.from(csvData, "utf8"),
    `inventory-${new Date().toISOString().slice(0, 10)}.csv`,
    M(
      lang,
      `📄 ملف إكسيل تنفيذي جاهز (${r.rowCount} وحدة)`,
      `📄 Inventory Export (${r.rowCount} units)`
    )
  );
  if (!sent) {
    await reply(
      broker,
      M(lang, "⚠️ تعذر إرسال الملف.", "⚠️ Failed to send file.")
    );
  }
}

async function cmdFlyer(
  broker,
  codeRaw,
  lang,
  { theme = "dark", unbranded = false } = {}
) {
  const code = codeRaw.toUpperCase();
  const l = await fetchListing(broker, code);
  if (!l) return notFound(broker, code);

  reply(
    broker,
    M(
      lang,
      "⏳ جاري إعداد وتصميم الكتالوج المعتمد...",
      "⏳ Preparing brochure..."
    )
  ).catch(() => {});

  const res = await renderFlyerOnDemand(broker, l, {
    lang: "en",
    theme,
    unbranded
  });

  if (!res.ok) {
    return reply(
      broker,
      res.reason === "no_images"
        ? M(
            lang,
            `⚠️ لا توجد صور لهذه الوحدة. أرسل الصور مع: إضافة #${code}`,
            `⚠️ No images for #${code}. Send photos with: add #${code}`
          )
        : M(
            lang,
            "⚠️ تعذر تصميم الكتالوج حالياً.",
            "⚠️ Failed to generate brochure."
          )
    );
  }

  const caption = M(
    lang,
    `📋 كتالوج معتمد #${code}`,
    `📋 Verified Brochure #${code}`
  );

  if (res.wa_media_id) {
    try {
      const sent = await WA.sendWhatsAppImage(
        to(broker),
        { id: res.wa_media_id },
        caption
      );
      if (sent) return;
    } catch (sendErr) {
      log(
        "warn",
        "Sending flyer via wa_media_id failed, falling back to public URL",
        errMeta(sendErr)
      );
    }
  }

  if (res.url) {
    await WA.sendWhatsAppImage(to(broker), res.url, caption);
  }
}

async function handleCommand(broker, raw, message = null) {
  if (!raw) return false;
  const n = String(raw)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u0640]/g, "")
    .trim();
  const lang = resolveLang(n, broker);
  let m;

  // Help
  if (
    /^(?:مساعدة|مساعده|المساعدة|المساعده|تعليمات|اوامر|أوامر|help|menu|منيو|قائمة|القائمة|\?|؟)$/i.test(
      n
    )
  ) {
    await reply(broker, T.getHelpMessage(lang));
    return true;
  }

  // Finalize / Save
  if (/^(?:تم|تمام|حفظ|ابدا|ابدأ|خلاص|go|done|save)$/i.test(n)) {
    const draft = await Drafts.getDraft(broker.id);
    if (draft) {
      await finalizeDraft(broker, draft);
      return true;
    }
    await reply(
      broker,
      M(lang, "لا توجد وحدة قيد التجهيز.", "No active draft in progress.")
    );
    return true;
  }

  const resolveTargetCode = (explicitCode) => {
    if (explicitCode) return explicitCode.toUpperCase();
    return getActiveListingCode(broker);
  };

  // 1. DELETE COMMAND
  if ((m = n.match(/^(?:حذف|مسح|delete|remove)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ يرجى تحديد كود الوحدة لحذفها (مثال: حذف #HAS101).",
          "⚠️ Specify code to delete (e.g. delete #HAS101)."
        )
      );
      return true;
    }
    await promptDeleteListing(broker, targetCode, lang);
    return true;
  }

  // 2. EDIT COMMAND
  if (
    (m = n.match(/^(?:تعديل|edit)(?:\s+#?([a-zA-Z0-9_-]+))?(?:\s+(.+))?$/i))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    const instructions = m[2]?.trim();
    if (!targetCode) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ حدد كود الوحدة المراد تعديلها (مثال: تعديل #HAS101).",
          "⚠️ Specify unit code to edit (e.g. edit #HAS101)."
        )
      );
      return true;
    }
    if (instructions) {
      await applyListingEdit(broker, targetCode, instructions, lang);
    } else {
      await enterEditMode(broker, targetCode);
    }
    return true;
  }

  // 3. PAGINATION COMMAND
  if (/^(?:المزيد|زيد|more|next)$/i.test(n)) {
    await handleSearchMessage(broker, { more: true });
    return true;
  }

  // 4. FLYER
  if (
    (m = n.match(
      /^(?:كتالوج|بروشور|flyer|catalog)(?:\s+#?([a-zA-Z0-9_-]+))?$/i
    ))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ يرجى تحديد كود الوحدة أو فحص وحدة أولاً.",
          "⚠️ Please specify a unit code or select a unit first."
        )
      );
      return true;
    }
    await cmdFlyer(broker, targetCode, "en", { theme: "dark" });
    return true;
  }

  // 5. CLIENT TEXT
  if ((m = n.match(/^(?:عميل|زبون|client)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ يرجى تحديد كود الوحدة أو فحص وحدة أولاً.",
          "⚠️ Please specify a unit code or select a unit first."
        )
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

  // 6. STATUS CHANGE: SOLD / ACTIVE / ARCHIVED
  if ((m = n.match(/^(?:مباع|تم\s+البيع|sold)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      await reply(
        broker,
        M(lang, "⚠️ يرجى تحديد كود الوحدة.", "⚠️ Please specify a unit code.")
      );
      return true;
    }
    await cmdStatus(broker, targetCode, "sold", lang);
    return true;
  }
  if ((m = n.match(/^(?:متاح|نشط|active)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (targetCode) await cmdStatus(broker, targetCode, "active", lang);
    return true;
  }
  if ((m = n.match(/^(?:ارشيف|أرشيف|archive)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (targetCode) await cmdStatus(broker, targetCode, "archived", lang);
    return true;
  }

  // 7. PRICE UPDATE
  if (
    (m = n.match(
      /^(?:سعر|price)(?:\s+#?([a-zA-Z0-9_-]+))?\s+(?:إلى|to|=)?\s*(.+)$/i
    ))
  ) {
    let explicitCode = m[1];
    let priceRaw = m[2];

    if (explicitCode && /^\d/.test(explicitCode) && !priceRaw) {
      priceRaw = explicitCode;
      explicitCode = null;
    }

    const targetCode = resolveTargetCode(explicitCode);
    if (!targetCode) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ حدد كود الوحدة المراد تعديل سعرها.",
          "⚠️ Please specify a unit code to update price."
        )
      );
      return true;
    }
    await cmdPrice(broker, targetCode, priceRaw, lang);
    return true;
  }

  // 8. EXPORT & STATS
  if (/^(?:تصدير|اكسيل|excel|export)$/i.test(n)) {
    await cmdExport(broker, lang);
    return true;
  }
  if (/^(?:تقرير|احصائيات|stats|report)$/i.test(n)) {
    await cmdStats(broker, lang);
    return true;
  }

  // 9. LANGUAGE TOGGLE
  if (/^(?:lang\s+en|english|إنجليزي|انجليزي)$/i.test(n)) {
    await pool.query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [
      broker.id
    ]);
    broker.preferred_lang = "en";
    await reply(
      broker,
      "✅ Language set to English. All confirmations will now be sent in English."
    );
    return true;
  }
  if (/^(?:lang\s+ar|arabic|عربي)$/i.test(n)) {
    await pool.query("UPDATE brokers SET preferred_lang = 'ar' WHERE id = $1", [
      broker.id
    ]);
    broker.preferred_lang = "ar";
    await reply(
      broker,
      "✅ تم ضبط اللغة إلى العربية. سيتم إرسال كافة التأكيدات بالعربية."
    );
    return true;
  }

  return false;
}

/* ====================================================================== */
/* Interactive Replies (Buttons & Lists Router)                           */
/* ====================================================================== */
async function handleInteractive(broker, message) {
  const replyId =
    message.interactive?.button_reply?.id ||
    message.interactive?.list_reply?.id;

  if (!replyId) return "done";
  const lang = broker.preferred_lang || "ar";
  const draft = await Drafts.getDraft(broker.id);

  if (replyId === "DRAFT_SAVE") {
    if (!draft) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ لا توجد مسودة نشطة حالياً. لإضافة وحدة جديدة، أرسل الصور أو اكتب «إضافة».",
          "⚠️ No active draft found. Send photos or type 'add' to start."
        )
      );
      return "done";
    }
    return finalizeDraft(broker, draft);
  }

  if (replyId === "DRAFT_CANCEL") {
    if (draft) await Drafts.clearDraft(broker.id);
    await reply(
      broker,
      M(lang, "🗑️ تم إلغاء المسودة بنجاح.", "🗑️ Draft discarded.")
    );
    return "done";
  }

  if (replyId.startsWith("CANCEL_AND_SEARCH:")) {
    const rawQuery = Buffer.from(
      replyId.replace("CANCEL_AND_SEARCH:", ""),
      "base64"
    ).toString("utf-8");
    if (draft) await Drafts.clearDraft(broker.id);
    return handleSearchMessage(broker, { text: rawQuery, msgId: message.id });
  }

  if (replyId === "KEEP_DRAFT") {
    await reply(
      broker,
      M(
        lang,
        "👍 تم الإبقاء على المسودة. أرسل باقي التفاصيل واكتب «تم».",
        "👍 Draft kept open. Send remaining details and send «done»."
      )
    );
    return "done";
  }

  if (replyId.startsWith("START_WITH_CODE:")) {
    const code = replyId.split(":")[1];
    await Drafts.appendToDraft(broker, { customCode: code });
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `📝 تم فتح مسودة وحدة بكود *#${code}*.\nأرسل الصور أو التفاصيل، واضغط حفظ عند الانتهاء.`,
        `📝 Started draft for *#${code}*.\nSend photos or details, then tap Save.`
      ),
      [
        { id: "DRAFT_SAVE", title: M(lang, "✅ حفظ (تم)", "✅ Save") },
        { id: "DRAFT_CANCEL", title: M(lang, "❌ إلغاء", "❌ Cancel") }
      ]
    );
    return "done";
  }

  if (replyId.startsWith("flyer:")) {
    const parts = replyId.split(":");
    const flyerLang = parts[1] || "en";
    const flyerTheme = parts[2] || "dark";
    const code = parts[3];
    await cmdFlyer(broker, code, flyerLang, { theme: flyerTheme });
    return "done";
  }

  if (replyId.startsWith("client:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    await reply(broker, T.formatClientListingText(listing, broker, lang));
    return "done";
  }

  if (replyId.startsWith("edit_btn:")) {
    const code = replyId.split(":")[1];
    await enterEditMode(broker, code);
    return "done";
  }

  if (replyId === "MORE_SEARCH") {
    await handleSearchMessage(broker, { more: true });
    return "done";
  }

  if (replyId.startsWith("confirm:delete:")) {
    const code = replyId.split(":")[2];
    await cmdDelete(broker, code, lang);
    return "done";
  }

  if (replyId.startsWith("status:sold:")) {
    const code = replyId.split(":")[2];
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `⚠️ هل أنت متأكد من تغيير حالة الوحدة #${code} إلى "تم البيع"؟`,
        `⚠️ Are you sure you want to mark #${code} as SOLD?`
      ),
      [
        {
          id: `confirm:sold:${code}`,
          title: M(lang, "✅ تأكيد البيع", "✅ Confirm Sold")
        },
        { id: "CANCEL_ACTION", title: M(lang, "تراجع", "Cancel") }
      ]
    );
    return "done";
  }

  if (replyId.startsWith("confirm:sold:")) {
    const code = replyId.split(":")[2];
    await cmdStatus(broker, code, "sold", lang);
    return "done";
  }

  if (replyId.startsWith("inspect:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    await showListingCard(broker, listing);
    return "done";
  }

  if (replyId === "CANCEL_ACTION") {
    await reply(broker, M(lang, "تم إلغاء العملية.", "Action cancelled."));
    return "done";
  }

  return "done";
}

/* ====================================================================== */
/* Inbound Ingestion Routing (State Machine Enforced)                     */
/* ====================================================================== */
async function handleImage(broker, message) {
  const mediaId = message.image && message.image.id;
  const caption = (message.image && message.image.caption) || "";
  const lang = broker.preferred_lang || "ar";

  if (!mediaId) return "done";

  const parsedCode = parseExplicitUnitCode(caption);
  let customCode = null;
  let text = caption.trim() || null;

  if (
    parsedCode.hasCode &&
    !parsedCode.invalidArabic &&
    !parsedCode.invalidFormat
  ) {
    const conflict = await checkCodeConflict(broker.agency_id, parsedCode.code);
    if (!conflict) {
      customCode = parsedCode.code;
      text = parsedCode.cleanText || null;
    }
  }

  const { isNew } = await Drafts.appendToDraft(broker, {
    mediaId,
    text,
    customCode
  });

  if (isNew) {
    const msg =
      lang === "en"
        ? "📝 *Started new listing draft.*\nSend remaining photos, voice notes, or text details.\n\nWhen done, tap *Save* or type *done*."
        : "📝 *بدأت تجهيز مسودة وحدة جديدة.*\nأرسل باقي الصور، فويس نوت بالتفاصيل، أو اكتب المواصفات.\n\nعند الانتهاء اضغط *حفظ* أو اكتب *تم*.";

    await WA.sendWhatsAppButtons(to(broker), msg, [
      {
        id: "DRAFT_SAVE",
        title: lang === "en" ? "✅ Save (Done)" : "✅ حفظ الوحدة (تم)"
      },
      {
        id: "DRAFT_CANCEL",
        title: lang === "en" ? "❌ Cancel" : "❌ إلغاء المسودة"
      }
    ]);
  }

  return "batched";
}

async function handleAudio(broker, message) {
  const voiceId =
    (message.voice && message.voice.id) || (message.audio && message.audio.id);
  const lang = broker.preferred_lang || "ar";
  if (!voiceId) return "done";

  // Check active edit session first
  const editSession = brokerEditSessions.get(to(broker));
  if (editSession) {
    const audioData = await WA.downloadWhatsAppMedia(voiceId);
    if (audioData) {
      const transcription = await AI.transcribeAudio(
        audioData.buffer,
        audioData.mimeType
      );
      if (transcription) {
        await applyListingEdit(broker, editSession.code, transcription, lang);
        return "done";
      }
    }
    return "done";
  }

  const draft = await Drafts.getDraft(broker.id);

  if (draft) {
    await Drafts.appendToDraft(broker, { voiceId });
    await reply(
      broker,
      M(
        lang,
        "🎙️ تم إضافة الفويس نوت للمسودة. اكتب *تم* عند الانتهاء.",
        "🎙️ Voice note added to draft. Send more or type *done*."
      )
    );
    return "batched";
  }

  const audioData = await WA.downloadWhatsAppMedia(voiceId);
  if (!audioData) return "done";

  const transcription = await AI.transcribeAudio(
    audioData.buffer,
    audioData.mimeType
  );
  if (!transcription) return "done";

  const isSearchIntent =
    /^(?:بحث|ابحث|دورلي|محتاج|عايز|مطلوب|عندك|search|looking for|find)(?:[\s:؛]|$|\b)/i.test(
      transcription
    );

  if (isSearchIntent) {
    return handleSearchMessage(broker, {
      text: transcription,
      msgId: message.id
    });
  }

  await Drafts.appendToDraft(broker, { voiceId, text: transcription });
  await WA.sendWhatsAppButtons(
    to(broker),
    M(
      lang,
      `📝 *تم فتح مسودة وحدة جديدة من التسجيل:*\n"${transcription.slice(
        0,
        100
      )}..."\n\nأرسل الصور الآن، ثم اضغط *حفظ*.`,
      `📝 *New listing draft opened from voice note:*\n"${transcription.slice(
        0,
        100
      )}..."\n\nSend photos now, then tap *Save*.`
    ),
    [
      { id: "DRAFT_SAVE", title: M(lang, "✅ حفظ (تم)", "✅ Save") },
      { id: "DRAFT_CANCEL", title: M(lang, "❌ إلغاء", "❌ Cancel") }
    ]
  );

  return "batched";
}

async function handleText(broker, message) {
  const raw = ((message.text && message.text.body) || "").trim();
  if (!raw) return "done";
  const lang = broker.preferred_lang || "ar";

  // Check active edit session first
  const editSession = brokerEditSessions.get(to(broker));
  if (editSession) {
    if (/^(?:الغاء|إلغاء|cancel|خروج|exit)$/i.test(raw)) {
      brokerEditSessions.delete(to(broker));
      await reply(
        broker,
        M(lang, "تم إلغاء وضع التعديل.", "Edit mode cancelled.")
      );
      return "done";
    }
    await applyListingEdit(broker, editSession.code, raw, lang);
    return "done";
  }

  if (await handleCommand(broker, raw, message)) return "done";

  const draft = await Drafts.getDraft(broker.id);

  // =========================================================================
  // DRAFTING STATE
  // =========================================================================
  if (draft) {
    if (/^(?:تم|تمام|حفظ|ابدا|ابدأ|done|save)$/i.test(raw)) {
      return finalizeDraft(broker, draft);
    }

    if (/^(?:الغاء|إلغاء|cancel|discard)$/i.test(raw)) {
      await Drafts.clearDraft(broker.id);
      await reply(
        broker,
        M(lang, "🗑️ تم إلغاء المسودة بنجاح.", "🗑️ Draft discarded.")
      );
      return "done";
    }

    const isSearchQuery =
      /^(?:بحث|ابحث|دورلي|محتاج|عايز|مطلوب|عندك|search|find|looking)(?:[\s:؛]|$|\b)/i.test(
        raw
      );
    if (isSearchQuery) {
      const encoded = Buffer.from(raw).toString("base64");
      await WA.sendWhatsAppButtons(
        to(broker),
        M(
          lang,
          `⚠️ لديك مسودة وحدة قيد الإضافة حالياً (${
            (draft.media_ids || []).length
          } صور).\n\nهل تريد إلغاء المسودة وتنفيذ البحث؟`,
          `⚠️ You have an active listing draft (${
            (draft.media_ids || []).length
          } photos).\n\nDo you want to cancel the draft and search instead?`
        ),
        [
          {
            id: `CANCEL_AND_SEARCH:${encoded}`,
            title: M(lang, "🔍 إلغاء والبحث", "🔍 Cancel & Search")
          },
          {
            id: "KEEP_DRAFT",
            title: M(lang, "📝 إكمال المسودة", "📝 Keep Draft")
          }
        ]
      );
      return "done";
    }

    const parsedCode = parseExplicitUnitCode(raw);
    if (parsedCode.hasCode) {
      if (parsedCode.invalidArabic) {
        await reply(
          broker,
          M(
            lang,
            "⚠️ كود الوحدة يجب أن يتكون من حروف إنجليزية وأرقام فقط (مثال: #HAS577). يرجى إرسال الكود مجدداً بالإنجليزية.",
            "⚠️ Unit code must contain English letters and numbers only (e.g. #HAS577). Please resend in English."
          )
        );
        return "done";
      }

      if (parsedCode.invalidFormat) {
        await reply(
          broker,
          M(
            lang,
            "⚠️ صيغة الكود غير صالحة. يجب أن يتكون من 3 إلى 30 حرف ورقم (مثال: #HAS577).",
            "⚠️ Invalid code format. Must be 3-30 alphanumeric characters (e.g. #HAS577)."
          )
        );
        return "done";
      }

      const conflict = await checkCodeConflict(
        broker.agency_id,
        parsedCode.code
      );
      if (conflict) {
        const statusMap = { active: "نشطة", sold: "مباعة", archived: "مؤرشفة" };
        await reply(
          broker,
          M(
            lang,
            `⚠️ الكود #${parsedCode.code} مستخدم بالفعل لوحدة (${
              statusMap[conflict.status] || conflict.status
            }: ${conflict.title || "عقار"}). يرجى اختيار كود آخر.`,
            `⚠️ Code #${parsedCode.code} is already used by a unit (${
              conflict.status
            }: ${conflict.title || "Listing"}). Please select another code.`
          )
        );
        return "done";
      }

      const prevCode = draft.custom_code;
      await Drafts.appendToDraft(broker, { customCode: parsedCode.code });

      const msg =
        prevCode && prevCode !== parsedCode.code
          ? M(
              lang,
              `🔄 تم تعديل كود الوحدة من #${prevCode} إلى *#${parsedCode.code}*.`,
              `🔄 Unit code updated from #${prevCode} to *#${parsedCode.code}*.`
            )
          : M(
              lang,
              `🏷️ تم تعيين كود الوحدة: *#${parsedCode.code}*.`,
              `🏷️ Unit code set to: *#${parsedCode.code}*.`
            );

      await reply(broker, msg);
      if (!parsedCode.cleanText) return "batched";
    }

    const textToAppend = parsedCode.hasCode ? parsedCode.cleanText : raw;
    if (textToAppend) {
      await Drafts.appendToDraft(broker, { text: textToAppend });
      await reply(
        broker,
        M(
          lang,
          "📝 تم إضافة التفاصيل للمسودة. اكتب «تم» عند الانتهاء.",
          "📝 Details added to draft. Send «done» when finished."
        )
      );
    }
    return "batched";
  }

  // =========================================================================
  // IDLE STATE
  // =========================================================================
  const RESERVED_WORDS =
    /^(add|new|help|save|edit|sold|delete|remove|stats|excel|more|next|المزيد|تم|حفظ)$/i;

  // Direct Unit Lookup (e.g., "#HAS101", "كود HAS101", "code HAS101")
  const explicitLookup = parseExplicitUnitCode(raw);
  if (
    explicitLookup.hasCode &&
    !explicitLookup.cleanText &&
    !RESERVED_WORDS.test(explicitLookup.code)
  ) {
    const listing = await fetchListing(broker, explicitLookup.code);
    if (listing) {
      await showListingCard(broker, listing);
      return "done";
    }
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `🔍 الوحدة #${explicitLookup.code} غير موجودة بالمخزون. هل تريد بدء إضافة وحدة جديدة بهذا الكود؟`,
        `🔍 Unit #${explicitLookup.code} not found. Start a new unit with this code?`
      ),
      [
        {
          id: `START_WITH_CODE:${explicitLookup.code}`,
          title: M(lang, "➕ إضافة الوحدة", "➕ Add Unit")
        },
        { id: "CANCEL_ACTION", title: M(lang, "إلغاء", "Cancel") }
      ]
    );
    return "done";
  }

  // Standalone Add Command (Allows bare "إضافة", "اضافة", "add", "new")
  if (/^(?:\+|إضافة:?|اضافة:?|add:?|new:?)(?:\s+.*)?$/i.test(raw)) {
    const cleanText = raw
      .replace(/^(?:\+|إضافة:?|اضافة:?|add:?|new:?)\s*/i, "")
      .trim();
    const parsedCode = parseExplicitUnitCode(cleanText);

    let initialCode = null;
    if (
      parsedCode.hasCode &&
      !parsedCode.invalidArabic &&
      !parsedCode.invalidFormat
    ) {
      const conflict = await checkCodeConflict(
        broker.agency_id,
        parsedCode.code
      );
      if (!conflict) initialCode = parsedCode.code;
    }

    await Drafts.appendToDraft(broker, {
      text: parsedCode.cleanText || cleanText || null,
      customCode: initialCode
    });

    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `📝 *تم فتح مسودة وحدة جديدة${
          initialCode ? ` (#${initialCode})` : ""
        }.*\nأرسل باقي الصور أو فويس نوت، ثم اضغط *حفظ*.`,
        `📝 *Started new listing draft${
          initialCode ? ` (#${initialCode})` : ""
        }.*\nSend photos or voice notes, then tap *Save*.`
      ),
      [
        { id: "DRAFT_SAVE", title: M(lang, "✅ حفظ (تم)", "✅ Save") },
        { id: "DRAFT_CANCEL", title: M(lang, "❌ إلغاء", "❌ Cancel") }
      ]
    );
    return "batched";
  }

  return (
    (await handleSearchMessage(broker, { text: raw, msgId: message.id })) ||
    "done"
  );
}

async function dispatchMessage(broker, message) {
  switch (message.type) {
    case "image":
      return handleImage(broker, message);
    case "document":
      const mime = (message.document && message.document.mime_type) || "";
      const filename = (message.document && message.document.filename) || "";
      const isImageDoc =
        /^image\//i.test(mime) ||
        /\.(jpe?g|png|webp|heic|heif)$/i.test(filename);

      if (isImageDoc) {
        return handleImage(broker, {
          ...message,
          image: {
            id: message.document.id,
            caption: message.document.caption
          }
        });
      }
      await reply(
        broker,
        "📎 المستندات غير مدعومة. أرسل الصور كملفات وسائط عادية."
      );
      return "done";
    case "audio":
    case "voice":
      return handleAudio(broker, message);
    case "interactive":
      return handleInteractive(broker, message);
    case "text":
      return handleText(broker, message);
    default:
      return "done";
  }
}

async function processMessage(message, { replay = false } = {}) {
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
      ctx().agencyId = broker.agency_id;
      ctx().brokerId = broker.id;

      if (broker.is_active === false) {
        await reply(broker, "⛔ الحساب معطل حالياً.");
        return markMsgs([message.id], "done");
      }
      if (!replay && !msgRate(key)) {
        return markMsgs([message.id], "done");
      }

      if (!(lastTouch.get(key) > Date.now() - 300000)) {
        lastTouch.set(key, Date.now());
        pool
          .query("UPDATE brokers SET last_active_at = NOW() WHERE id = $1", [
            broker.id
          ])
          .catch(() => {});
      }

      if (!replay && message.type !== "image") {
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
/* Durable Webhook Ingestion & Crash Recovery                             */
/* ====================================================================== */
async function persistIncoming(body) {
  const msgs = [];
  for (const entry of (body && body.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v) continue;
      for (const m of v.messages || []) if (m && m.id && m.from) msgs.push(m);
    }
  }
  msgs.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const fresh = [];
  for (const m of msgs) {
    const r = await pool.query(
      "INSERT INTO inbound_messages (msg_id, phone_key, payload) VALUES ($1,$2,$3) ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id",
      [m.id, U.normalizePhone(m.from), m]
    );
    if (r.rowCount) fresh.push(m);
  }
  return fresh;
}

async function recoverInbound() {
  const r = await pool.query(
    `UPDATE inbound_messages SET attempts = attempts + 1, updated_at = NOW()
     WHERE msg_id IN (
       SELECT msg_id FROM inbound_messages
       WHERE status IN ('new','batched') AND received_at > NOW() - INTERVAL '20 minutes' AND attempts < 3
       ORDER BY received_at FOR UPDATE SKIP LOCKED
     ) RETURNING payload`
  );
  for (const row of r.rows) {
    scheduleMessage(row.payload).catch(() => {});
  }
}

/* ====================================================================== */
/* HTTP API & Lifecycles                                                  */
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

if (!process.env.WHATSAPP_APP_SECRET) {
  console.error(
    "FATAL: WHATSAPP_APP_SECRET is mandatory for webhook integrity."
  );
  process.exit(1);
}

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
  if (!verifySignature(req)) return res.sendStatus(401);
  let fresh;
  try {
    fresh = await persistIncoming(req.body);
  } catch (err) {
    log("error", "persisting incoming webhook failed", errMeta(err));
    return res.sendStatus(500);
  }
  res.status(200).send("EVENT_RECEIVED");
  for (const m of fresh) {
    scheduleMessage(m).catch((e) =>
      log("error", "schedule failed", errMeta(e))
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
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "ok",
      queue: listingLimiter.stats(),
      inFlight
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

let server;
let isShuttingDown = false;

async function shutdown(sig) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log("info", "server shutting down", { sig });
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

  pool
    .query(
      "DELETE FROM inbound_messages WHERE received_at < NOW() - INTERVAL '14 days'"
    )
    .catch((e) =>
      log("warn", "Inbound message table cleanup failed", errMeta(e))
    );

  server = app.listen(CFG.port, () => {
    log("info", `Real Estate Engine listening on port ${CFG.port}`);
    recoverInbound().catch((e) =>
      log("error", "crash recovery failed", errMeta(e))
    );
  });
}

if (require.main === module) {
  boot();
}

module.exports = { app, brokerEditSessions, recentBrokerListings };
