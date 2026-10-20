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
const { generateFlyerBuffer } = require("./lib/flyer");
const WA = require("./lib/whatsapp");
const T = require("./lib/text");
const S = require("./lib/search");
const L = require("./lib/listing");
const U = require("./lib/util");
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
  debounceMs: Number(process.env.BATCH_DEBOUNCE_MS || 5000),
  batchMaxWaitMs: 90000,
  textBufferMs: 3500,
  maxImages: 15,
  searchPageSize: 10,
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
    // 64-bit advisory transaction lock keyed to agency UUID hash and listing code hash
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
// server.js - Replace line 100 with this robust implementation
async function reply(broker, text, opts = {}) {
  if (!text) return null;
  const recipient = to(broker);

  try {
    return await WA.sendWhatsAppText(recipient, text, opts);
  } catch (err) {
    const apiCode = err?.response?.data?.error?.code || err?.code;
    const apiSubcode = err?.response?.data?.error?.error_subcode;

    // Error 131047: Meta 24-hour service window closed
    if (apiCode === 131047 || apiSubcode === 131047) {
      log(
        "warn",
        "WhatsApp 24-hour session expired; cannot send freeform text",
        {
          brokerId: broker?.id,
          phone: broker?.phone
        }
      );
      return null;
    }

    // Rate limiting from Meta (code 80007 / 130429): back off 1s and retry once
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
const incomingBatches = new Map();
const pendingTextBuffers = new Map();
const recentBrokerListings = new Map();
const brokerCache = new Map();
const agencyCache = new Map();
const unknownNotified = new Map();
const lastTouch = new Map();
const cooldowns = new Map();
const activeProcessingKeys = new Set();
const perBroker = U.createSerializer();
const brokerWork = U.createSerializer();
const listingLimiter = U.createLimiter(2, { maxQueue: 40 });
const uploadLimiter = U.createLimiter(4);
const rateGate = U.createRateGate(CFG.geminiRpm);
const msgRate = U.createCounter(60000, 80);
let inFlight = 0;
function resolveLang(rawText, broker) {
  if (!rawText) return broker.preferred_lang || "ar";
  // If the text is predominantly Latin/English characters and standard symbols
  const isEnglish = /^[a-zA-Z0-9\s#_.,:/\-+!?()]+$/.test(rawText.trim());
  return isEnglish ? "en" : broker.preferred_lang || "ar";
}
function setActiveListing(broker, code) {
  const key = U.normalizePhone(broker.phone);
  recentBrokerListings.set(key, { code: code.toUpperCase(), at: Date.now() });
}

function getActiveListingCode(broker) {
  const key = U.normalizePhone(broker.phone);
  const rec = recentBrokerListings.get(key);
  // Valid for 2 hours (7,200,000 ms)
  if (rec && Date.now() - rec.at < 7200000) {
    return rec.code;
  }
  return null;
}
/* ====================================================================== */
/* Gemini Gateway                                                         */
/* ====================================================================== */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function withinAiQuota(agencyId) {
  if (!CFG.aiDailyLimit) return true;
  try {
    const r = await pool.query(
      "SELECT COUNT(*)::int AS n FROM operation_logs WHERE agency_id = $1 AND created_at >= date_trunc('day', now()) AND tokens_input > 0",
      [agencyId]
    );
    return r.rows[0].n < CFG.aiDailyLimit;
  } catch {
    return true;
  }
}

// In server.js: Differentiate transient 429 from daily quota exhaustion
const isDailyQuotaExhausted = (e) =>
  /GenerateRequestsPerDayPerProjectPerModel|free_tier_requests|limit:\s*20/i.test(
    String(e && e.message)
  );

// In server.js - Full Replacement for callGemini

const isTransientError = (e) => {
  const msg = String((e && e.message) || e);
  return /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(
    msg
  );
};

async function callGemini({ contents, config, model, maxRetries = 2 }) {
  // 3-tier cascade: 3.8 -> 3.6 -> fallback (3.5-flash-lite)
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
          currentModel // cleaner label: "gemini-3.8-flash timeout"
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

        // If current model timed out, spiked (503), or hit quota:
        // Bail out immediately on the very first attempt and switch to the next model in the chain!
        if (
          (isSpike || isQuota || isTimeout) &&
          models.length > 1 &&
          currentModel !== models[models.length - 1]
        ) {
          log(
            "warn",
            `Model ${currentModel} failed (${
              isTimeout ? "timeout" : isSpike ? "503 spike" : "quota"
            }). Failing over to next model...`
          );
          break; // break retry loop to jump to next model in outer loop
        }

        if (!isTransientError(err)) break;

        // Exponential backoff only for recoverable per-minute rate limits
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
// BEFORE
// AFTER
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

          // Guarantee compression: if buffer > 250KB, compress to 1600px MozJPEG
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
/* On-Demand Lazy Vision & Multi-Variant Brochure Engine                  */
/* ====================================================================== */
async function classifyListingImages(listing, images) {
  if (!images.length) return images;
  const hasUnclassified = images.some((img) => !img.role);
  if (!hasUnclassified) return images;

  try {
    const thumbs = await Promise.all(
      images.map(async (im) => {
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

    const parts = [{ text: L.buildVisionPrompt() }];
    thumbs.forEach((buf, i) => {
      if (buf)
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") }
        });
    });

    const visionResult = await callGemini({
      contents: parts,
      config: { temperature: 0.1, responseMimeType: "application/json" }
    });

    const parsed = L.validateVisionDraft(
      JSON.parse(cleanJson(visionResult.res.text)),
      images.length
    );

    await Promise.all(
      images.map(async (im, idx) => {
        const role = parsed.image_roles[idx] || "other";
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
        "UPDATE listings SET details = jsonb_set(details, '{image_order}', $1::jsonb) WHERE id = $2",
        [JSON.stringify(parsed.image_order), listing.id]
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

  // Check valid cache entry (under 25 days old)
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

  // Run lazy vision classification if roles are missing
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

  // Update Cache in PostgreSQL
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

      // Invalidate flyer cache if photos or specs changed
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
      return { conflict: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

/* ====================================================================== */
/* Batch Processing (Text & Audio Ingestion)                              */
/* ====================================================================== */
async function processBatch(batch) {
  const t0 = Date.now();
  const { broker } = batch;
  const ids = batch.msgIds;
  const key = U.normalizePhone(broker.phone);
  const agencyId = broker.agency_id;
  const batchKey = U.sha1([...ids].sort().join(","));

  const perf = {
    agency_id: agencyId,
    broker_id: broker.id,
    operation_type: "listing_ingest",
    gemini_ms: 0,
    media_download_ms: 0,
    image_process_ms: 0,
    storage_upload_ms: 0,
    db_ms: 0
  };

  const text = [...batch.texts, ...batch.captions].join(" ");
  const lang = L.detectLang(text, broker.preferred_lang || "ar");
  const replaceMode = L.isReplaceMode(text);
  const images = batch.images.filter(Boolean);
  const imageOnly = !text.trim() && batch.voices.length === 0;

  try {
    const done = await pool.query(
      "SELECT 1 FROM processed_batches WHERE batch_key = $1",
      [batchKey]
    );
    if (done.rowCount) {
      await markMsgs(ids, "done");
      return;
    }

    let explicit = batch.customCode || L.extractExplicitUnitCode(text);
    let carried = null;
    const recent = recentBrokerListings.get(key);
    if (
      !explicit &&
      imageOnly &&
      images.length &&
      recent &&
      Date.now() - recent.at < 90000
    ) {
      explicit = recent.code;
      carried = recent.code;
    }

    await reply(
      broker,
      M(
        lang,
        "⏳ جاري استخراج مواصفات الوحدة وحفظ العقار...",
        "⏳ Extracting specifications and saving listing..."
      )
    );

    if (!(await withinAiQuota(agencyId))) {
      await markMsgs(ids, "failed");
      return void (await reply(
        broker,
        M(
          lang,
          "⛔ تم استهلاك الحد اليومي للذكاء الاصطناعي.",
          "⛔ Daily AI quota reached."
        )
      ));
    }

    // Generate listing code up front so upload paths can start immediately
    let { code, explicit: codeExplicit } = L.generateListingCode(
      explicit,
      "UNT"
    );
    perf.listing_code = code;

    // Generate dynamic nonce token to sandbox user text input against prompt injection
    const fenceToken = crypto.randomBytes(4).toString("hex").toUpperCase();

    // Build Gemini extraction payload
    const parts = [{ text: L.buildListingPrompt(lang, fenceToken) }];

    if (text.trim()) {
      parts.push({
        text: `===${fenceToken}===\n${text.trim()}\n===${fenceToken}===`
      });
    }

    for (const v of batch.voices) {
      if (v.buffer && Buffer.isBuffer(v.buffer)) {
        parts.push({
          inlineData: {
            mimeType: U.cleanAudioMime(v.mimeType),
            data: v.buffer.toString("base64")
          }
        });
      }
    }

    // RUN GEMINI & SUPABASE STORAGE UPLOADS SIMULTANEOUSLY
    const gem0 = Date.now();
    const u0 = Date.now();

    const [aiRes, up] = await Promise.all([
      callGemini({
        contents: parts,
        config: {
          temperature: 0.1,
          maxOutputTokens: 3072,
          responseMimeType: "application/json"
        }
      }),
      images.length
        ? uploadImages(agencyId, code, images).catch((uploadErr) => {
            log(
              "error",
              "Parallel image upload failed; proceeding with unit specs",
              errMeta(uploadErr)
            );
            return { ok: [], failed: images.length, error: uploadErr.message };
          })
        : Promise.resolve({ ok: [], failed: 0 })
    ]);

    perf.gemini_ms = Date.now() - gem0;
    perf.storage_upload_ms = Date.now() - u0;
    perf.tokens_input = aiRes.usage.input;
    perf.tokens_output = aiRes.usage.output;
    perf.model_used = aiRes.model;

    let draft = L.validateDraft(JSON.parse(cleanJson(aiRes.res.text)), lang);

    // Enforce clean feature vocabulary to prevent phonetic errors like "بول"
    if (draft.details && Array.isArray(draft.details.features)) {
      draft.details.features = T.cleanFeaturesList(draft.details.features);
    }

    const price = T.parseEgyptianPrice(draft.price_raw, {
      lang,
      listingType: draft.listing_type || "sale"
    });

    if (
      !images.length &&
      !price.priceValue &&
      !draft.area_value &&
      !draft.title
    ) {
      await markMsgs(ids, "done");
      return void (await reply(
        broker,
        M(
          lang,
          "⚠️ لم يتم استخراج مواصفات كافية ولم تُرفق صور.",
          "⚠️ Insufficient details and no photos attached."
        )
      ));
    }

    // Geographic Enrichment
    let enriched = null;
    if (
      !imageOnly &&
      draft.location &&
      draft.location_keywords.length < 4 &&
      (await withinAiQuota(agencyId))
    ) {
      try {
        enriched = await S.enrichLocation(aiShim, {
          location: draft.location,
          title: draft.title,
          rawText: text,
          model: CFG.geminiFallback
        });
        draft.compound = draft.compound || enriched.compound || "";
        draft.district = draft.district || enriched.district || "";
        draft.city = draft.city || enriched.city || "";
        draft.location_keywords = S.normalizeKeywords([
          ...draft.location_keywords,
          ...enriched.keywords
        ]);
      } catch (e) {
        log("warn", "location enrichment skipped", errMeta(e));
      }
    }

    // Atomic DB Commit with Advisory Locking and Retry Protection
    let result = null;
    const db0 = Date.now();
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const existing = await loadExisting(agencyId, code);
      if (existing && !codeExplicit) {
        code = L.generateListingCode(null, draft.property_type).code;
        perf.listing_code = code;
        continue;
      }
      if (existing && !canEdit(broker, existing)) {
        await markMsgs(ids, "done");
        return void (await reply(
          broker,
          M(
            lang,
            `⛔ الكود #${code} مسجل باسم زميل آخر.`,
            `⛔ Code #${code} belongs to another broker.`
          )
        ));
      }

      const fields = L.composeFields({
        existing,
        draft,
        price,
        imageOnly,
        lang,
        enriched
      });
      const replace = Boolean(existing && replaceMode && up.ok.length);

      const r = await persistListing({
        broker,
        code,
        existing,
        fields,
        newImages: up.ok,
        replace,
        batchKey
      });
      if (r.duplicate) {
        await markMsgs(ids, "done");
        return;
      }
      if (!r.conflict) result = r;
    }
    perf.db_ms = Date.now() - db0;
    if (!result) throw new Error("concurrency retry limit exceeded");

    const listing = result.listing;

    // Lock as active listing context for shortcut commands (price/sold/flyer)
    setActiveListing(broker, listing.code);
    await markMsgs(ids, "done");

    // Success Notification & Action Buttons
    let body = M(
      lang,
      `✅ ${result.created ? "تم حفظ" : "تم تحديث"} الوحدة بنجاح *#${
        listing.code
      }*\n📍 ${listing.location || "-"}\n💰 ${listing.price_display || "-"}`,
      `✅ Unit *#${listing.code}* ${
        result.created ? "saved" : "updated"
      } successfully.\n📍 ${listing.location || "-"}\n💰 ${
        listing.price_display || "-"
      }`
    );

    if (listing.details && listing.details.ambiguous_location) {
      body += M(
        lang,
        `\n\n⚠️ *تنبيه موقع:* اسم الكمبوند قد يحتمل أكثر من منطقة (مثل جاردينيا سيتي / جاردينيا سبرنجز). يرجى مراجعة وتحديد الموقع في الوصف إن لزم.`,
        `\n\n⚠️ *Location Note:* The compound name might exist in multiple areas. Please review and clarify if needed.`
      );
    }

    const buttons = [
      { id: `flyer:en:dark:${listing.code}`, title: "📄 Flyer (EN)" },
      {
        id: `client:${listing.code}`,
        title: M(lang, "📲 نص العميل", "📲 Client Text")
      },
      {
        id: `status:sold:${listing.code}`,
        title: M(lang, "🏷️ تم البيع", "🏷️ Mark Sold")
      }
    ];
    // Alert the broker if photos failed to upload, without losing the listing
    if (images.length > 0 && up.failed > 0 && up.ok.length === 0) {
      body += M(
        lang,
        `\n\n⚠️ *تنبيه الصور:* تعذر رفع الصور لضعف شبكة السيرفر. يمكنك إعادة إرسالها لاحقاً: *إضافة #${listing.code}*`,
        `\n\n⚠️ *Photo Notice:* Photos failed to upload due to network timeout. You can re-send them: *add #${listing.code}*`
      );
    }
    // 1. Send the rich interactive message with buttons
    await WA.sendWhatsAppButtons(to(broker), body, buttons);

    // 2. Send the monospace unit code bubble for one-tap mobile clipboard copy
    await WA.sendWhatsAppText(to(broker), `\`${listing.code}\``);

    // 3. Send formatted customer-facing text if unit is newly created
    if (result.created) {
      await reply(broker, T.formatClientListingText(listing, broker, lang));
    }

    perf.total_duration_ms = Date.now() - t0;
    logOperation(perf).catch(() => {});
  } catch (err) {
    log("error", "process batch failed", errMeta(err));
    perf.status = "failed";
    perf.error_code = err.message;
    perf.total_duration_ms = Date.now() - t0;
    logOperation(perf).catch(() => {});
    await markMsgs(ids, "failed");
    await reply(
      broker,
      M(
        lang,
        "❌ حدث خطأ أثناء الحفظ. اكتب «أعد المحاولة».",
        "❌ Error during saving. Send «retry»."
      )
    );
  }
}

/* ====================================================================== */
/* Inbound Ingestion Buffering & Flow Control                             */
/* ====================================================================== */
function reserveBatch(broker, msgId, initialCode = null) {
  const key = U.normalizePhone(broker.phone);
  let batch = incomingBatches.get(key);
  if (!batch) {
    batch = {
      broker,
      texts: [],
      captions: [],
      audios: [],
      voices: [],
      images: [],
      msgIds: [],
      customCode: initialCode,
      pendingDownloads: 0,
      nextSlot: 0,
      dropped: 0,
      failedDownloads: 0,
      createdAt: Date.now(),
      timer: null,
      closed: false
    };
    incomingBatches.set(key, batch);
    reply(
      broker,
      M(
        broker.preferred_lang || "ar",
        "📥 تم الاستلام. ابعت باقي الصور/التفاصيل، وهبدأ المعالجة تلقائياً بعد ثواني (أو اكتب «تم» للبدء فوراً).",
        "📥 Received. Send the remaining photos/details — I'll start in a few seconds (or send «done» to start now)."
      )
    ).catch(() => {});
  } else if (initialCode && !batch.customCode) {
    batch.customCode = initialCode;
  }

  if (msgId && !batch.msgIds.includes(msgId)) batch.msgIds.push(msgId);
  const buffered = pendingTextBuffers.get(key);
  if (buffered) {
    clearTimeout(buffered.timer);
    pendingTextBuffers.delete(key);
    batch.texts.push(buffered.text);
    if (buffered.msgId && !batch.msgIds.includes(buffered.msgId))
      batch.msgIds.push(buffered.msgId);
    if (buffered.customCode && !batch.customCode)
      batch.customCode = buffered.customCode;
  }
  armBatchTimer(key);
  return batch;
}

function armBatchTimer(key, delay = CFG.debounceMs) {
  const b = incomingBatches.get(key);
  if (!b) return;
  clearTimeout(b.timer);
  b.timer = setTimeout(
    () =>
      finalizeBatch(key).catch((e) =>
        log("error", "finalize failed", errMeta(e))
      ),
    delay
  );
}

async function finalizeBatch(key, { force = false } = {}) {
  const batch = incomingBatches.get(key);
  if (!batch) return;
  clearTimeout(batch.timer);
  if (
    batch.pendingDownloads > 0 &&
    Date.now() - batch.createdAt < CFG.batchMaxWaitMs
  ) {
    if (!force) return void armBatchTimer(key, 1500);
    const until = Date.now() + 20000;
    while (batch.pendingDownloads > 0 && Date.now() < until) await U.sleep(250);
  }
  if (incomingBatches.get(key) !== batch) return;
  incomingBatches.delete(key);
  batch.closed = true;

  // Mark key as currently in flight
  activeProcessingKeys.add(key);

  inFlight++;
  try {
    await brokerWork(key, () =>
      listingLimiter(() =>
        als.run(
          {
            reqId: `batch:${batch.msgIds[0] || key}`,
            agencyId: batch.broker.agency_id,
            brokerId: batch.broker.id
          },
          () => processBatch(batch)
        )
      )
    );
  } finally {
    inFlight--;
    // Retain for 8 seconds to swallow duplicate "تم" taps
    setTimeout(() => activeProcessingKeys.delete(key), 8000);
  }
}

function addImageToBatch(broker, message, media, caption) {
  const key = U.normalizePhone(broker.phone);
  const batch = reserveBatch(
    broker,
    message.id,
    L.extractExplicitUnitCode(caption)
  );
  if (caption) batch.captions.push(caption);
  const slot = batch.nextSlot++;
  if (slot >= CFG.maxImages) {
    batch.dropped++;
    return "batched";
  }
  batch.pendingDownloads++;
  (async () => {
    try {
      const dl = await WA.downloadWhatsAppMedia(media.id);
      if (!dl || !dl.buffer) return void batch.failedDownloads++;
      if (batch.closed) return;
      batch.images[slot] = {
        buffer: await normalizeImage(dl.buffer),
        mimeType: "image/jpeg"
      };
    } catch (e) {
      batch.failedDownloads++;
      log("warn", "image ingest failed", errMeta(e));
    } finally {
      batch.pendingDownloads = Math.max(0, batch.pendingDownloads - 1);
      if (!batch.closed) armBatchTimer(key);
    }
  })();
  return "batched";
}

const isBatchingActive = (key) =>
  incomingBatches.has(key) || pendingTextBuffers.has(key);

/* ====================================================================== */
/* Search Execution                                                       */
/* ====================================================================== */
async function handleSearchMessage(
  broker,
  { text = "", audio = null, more = false, msgId = null } = {}
) {
  const key = U.normalizePhone(broker.phone);
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
    if (!st)
      return void (await reply(
        broker,
        M(lang, "⚠️ لا يوجد بحث سابق نشط.", "⚠️ No active search found.")
      ));
    parsed = st.parsed;
    offset = st.next_offset;
  } else {
    // Search audio limit validated before calling Gemini
    if (isVoice && audio.duration > CFG.maxSearchAudioSec) {
      return void (await reply(
        broker,
        M(
          lang,
          `⚠️ تسجيل البحث طويل (${audio.duration} ث). الحد ${CFG.maxSearchAudioSec} ثانية.`,
          `⚠️ Search audio too long (${audio.duration}s). Max ${CFG.maxSearchAudioSec}s.`
        )
      ));
    }

    if (!(await withinAiQuota(broker.agency_id))) {
      return void (await reply(
        broker,
        M(
          lang,
          "⛔ تم استهلاك حد الذكاء الاصطناعي اليومي.",
          "⛔ Daily AI limit reached."
        )
      ));
    }

    reply(
      broker,
      isVoice
        ? M(lang, "🎙️ جاري الاستماع للبحث...", "🎙️ Listening...")
        : M(lang, "🔍 جاري البحث في المخزون...", "🔍 Searching...")
    ).catch(() => {});
    try {
      ({ parsed } = await S.parseSearchRequest(aiShim, {
        text,
        audio: isVoice ? [audio] : [],
        model: CFG.geminiModel
      }));
    } catch (e) {
      log("warn", "search parse failed, using fallback", errMeta(e));
      if (isVoice)
        return void (await reply(
          broker,
          M(
            lang,
            "❌ تعذر فهم التسجيل. أعد المحاولة كتابةً.",
            "❌ Could not parse audio. Try typing."
          )
        ));
      parsed = S.fallbackParse(text);
    }

    if (parsed.intent === "listing") {
      const b = reserveBatch(broker, msgId);
      if (text) b.texts.push(text);
      if (isVoice) {
        b.audios.push(audio);
        b.voices.push(audio);
      }
      return "batched";
    }
    if (parsed.intent === "other") {
      return void (await reply(
        broker,
        M(
          lang,
          "👋 أهلاً بك! اكتب «مساعدة» لعرض الأوامر، أو اكتب مواصفات بحثك.",
          "👋 Welcome! Send «help» for commands or type your search."
        )
      ));
    }
  }

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
    if (!rows.length && !more && S.hasAnyFilter(parsed)) {
      rows = await run(true);
      relaxed = rows.length > 0;
    }
  } catch (e) {
    log("error", "search query failed", errMeta(e));
    return void (await reply(
      broker,
      M(lang, "❌ خطأ أثناء البحث.", "❌ Search error.")
    ));
  }

  const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
  if (!total)
    return void (await reply(
      broker,
      M(
        lang,
        "🔍 لم نجد وحدات مطابقة. جرب توسيع الميزانية أو المنطقة.",
        "🔍 No units matched. Try widening your criteria."
      )
    ));

  pool
    .query(
      `INSERT INTO broker_search_state (phone_key, parsed, next_offset, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (phone_key) DO UPDATE SET parsed = EXCLUDED.parsed, next_offset = EXCLUDED.next_offset, updated_at = NOW()`,
      [key, { ...parsed, __relaxed: relaxed }, offset + rows.length]
    )
    .catch(() => {});

  // Send WhatsApp Interactive List if 10 or fewer results
  if (rows.length <= 10) {
    const listRows = rows.map((u) => {
      const price =
        u.price_display ||
        (u.price_value ? `${+(u.price_value / 1e6).toFixed(1)}M EGP` : "-");
      const beds = u.bedrooms ? `${u.bedrooms} Beds` : "";
      const area = u.area_value ? `${u.area_value} sqm` : "";
      const desc = [u.compound || u.location, beds, area]
        .filter(Boolean)
        .join(" • ")
        .slice(0, 72);

      return {
        id: `inspect:${u.code}`,
        title: `#${u.code} | ${price}`.slice(0, 24),
        description: desc
      };
    });

    const header = M(
      lang,
      `نتائج البحث (${total} وحدة)`,
      `Search Results (${total} units)`
    );
    const summary =
      (more ? "" : S.formatInterpretation(parsed)) ||
      M(
        lang,
        "اختر وحدة لعرض كافة التفاصيل:",
        "Select a unit to view details:"
      );
    const btnLabel = M(lang, "عرض الوحدات", "View Units");

    return void (await WA.sendWhatsAppList(
      to(broker),
      header,
      summary,
      btnLabel,
      [
        {
          title: M(lang, "الوحدات المطابقة", "Matching Listings"),
          rows: listRows
        }
      ]
    ));
  }

  // Fallback to text for larger result sets
  await reply(
    broker,
    T.formatSearchResults(rows, {
      offset,
      total,
      lang,
      interpretation: more ? "" : S.formatInterpretation(parsed),
      relaxed
    })
  );
}

/* ====================================================================== */
/* Command Handlers                                                       */
/* ====================================================================== */
const CODE = "([A-Za-z0-9_-]+)";
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
  return withDistributedListingLock(broker.agency_id, code, async (client) => {
    const r = await client.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [broker.agency_id, code]
    );
    const l = r.rows[0];
    if (!l) return notFound(broker, code);
    if (!canEdit(broker, l)) {
      return reply(
        broker,
        M(
          lang,
          "⛔ لا تملك صلاحية تعديل هذه الوحدة.",
          "⛔ Unauthorized to edit this unit."
        )
      );
    }

    const p = T.parseEgyptianPrice(priceRaw, {
      lang,
      listingType: l.listing_type
    });
    if (!p.priceValue) {
      return reply(
        broker,
        M(
          lang,
          `❌ تعذر تحديد السعر. مثال: سعر ${code} إلى 18.5 مليون`,
          `❌ Invalid price. Example: price ${code} to 18.5M`
        )
      );
    }

    await client.query(
      "UPDATE listings SET price_value = $1, price_display = $2, flyer_cache = '{}'::jsonb, updated_at = NOW() WHERE id = $3",
      [p.priceValue, p.priceDisplay, l.id]
    );

    await reply(
      broker,
      M(
        lang,
        `✅ تم تعديل سعر الوحدة #${code} إلى ${p.priceDisplay} وتم تحديث الكاش.`,
        `✅ Price for #${code} updated to ${p.priceDisplay}. Flyer cache invalidated.`
      )
    );
  });
}

async function cmdStatus(broker, codeRaw, newStatus, lang) {
  const code = codeRaw.toUpperCase();
  return withDistributedListingLock(broker.agency_id, code, async (client) => {
    const r = await client.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [broker.agency_id, code]
    );
    const l = r.rows[0];
    if (!l) return notFound(broker, code);
    if (!canEdit(broker, l)) {
      return reply(
        broker,
        M(
          lang,
          "⛔ لا تملك صلاحية تعديل حالة الوحدة.",
          "⛔ Unauthorized to change status."
        )
      );
    }

    await client.query(
      "UPDATE listings SET status = $1, updated_at = NOW() WHERE id = $2",
      [newStatus, l.id]
    );

    const labels = {
      sold: M(lang, "تم البيع", "SOLD"),
      archived: M(lang, "مؤرشفة", "ARCHIVED"),
      active: M(lang, "نشطة", "ACTIVE")
    };
    await reply(
      broker,
      M(
        lang,
        `✅ أصبحت حالة الوحدة #${code}: *${labels[newStatus]}*.`,
        `✅ Unit #${code} status updated to: *${labels[newStatus]}*.`
      )
    );
  });
}

async function cmdDelete(broker, codeRaw, lang) {
  const code = codeRaw.toUpperCase();
  return withDistributedListingLock(broker.agency_id, code, async (client) => {
    const r = await client.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2 FOR UPDATE",
      [broker.agency_id, code]
    );
    const l = r.rows[0];
    if (!l) return notFound(broker, code);
    if (!canEdit(broker, l)) {
      return reply(
        broker,
        M(
          lang,
          "⛔ لا تملك صلاحية حذف هذه الوحدة.",
          "⛔ Unauthorized to delete this unit."
        )
      );
    }

    // Collect storage paths safely
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
    await reply(
      broker,
      M(
        lang,
        `🗑️ تم حذف الوحدة #${code} نهائياً ومسح كافة وسائطها وملفاتها من السيرفر.`,
        `🗑️ Unit #${code} and all associated media permanently deleted.`
      )
    );
  });
}

async function cmdStats(broker, lang) {
  const [counts, types, locs] = await Promise.all([
    pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status='active') AS active,
        COUNT(*) FILTER (WHERE status='sold') AS sold,
        COUNT(*) FILTER (WHERE status='archived') AS archived,
        COUNT(*) FILTER (WHERE broker_id = $2) AS mine
      FROM listings WHERE agency_id = $1`,
      [broker.agency_id, broker.id]
    ),
    pool.query(
      `
      SELECT property_type, COUNT(*) AS count
      FROM listings WHERE agency_id = $1 AND status='active'
      GROUP BY property_type ORDER BY count DESC LIMIT 4`,
      [broker.agency_id]
    ),
    pool.query(
      `
      SELECT COALESCE(NULLIF(compound,''), district) AS zone, COUNT(*) AS count
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
  if (cooldowns.get(key) > Date.now())
    return reply(
      broker,
      M(
        lang,
        "⏳ انتظر دقيقة قبل تصدير ملف جديد.",
        "⏳ Please wait a minute before another export."
      )
    );
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

  if (!r.rowCount)
    return reply(
      broker,
      M(lang, "لا توجد وحدات للتصدير.", "No units available to export.")
    );
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
  if (!sent)
    await reply(
      broker,
      M(lang, "⚠️ تعذر إرسال الملف.", "⚠️ Failed to send file.")
    );
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

  // Try WhatsApp media ID first, fall back to public URL if Meta CDN rejects it
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
  const lang = resolveLang(raw, broker); // Dynamic English/Arabic response
  const n = raw.trim();
  const key = U.normalizePhone(broker.phone);
  let m;
  if (/^(?:مساعدة|اوامر|أوامر|تعليمات|help|commands|\?)$/i.test(n)) {
    await reply(broker, T.getHelpMessage(lang));
    return true;
  }

  // ==========================================
  // 2. BATCH COMPLETION TRIGGER
  // ==========================================
  if (/^(تم|تمام|ابدا|خلاص|go|done)$/i.test(n)) {
    if (incomingBatches.has(key)) {
      finalizeBatch(key, { force: true }).catch((e) =>
        log("error", "finalize failed", errMeta(e))
      );
    } else if (activeProcessingKeys.has(key)) {
      log(
        "info",
        "User sent 'تم' while batch was already processing. Silencing false-alarm reply.",
        { key }
      );
    } else {
      await reply(
        broker,
        M(lang, "لا توجد وحدة قيد التجهيز.", "No active batch in progress.")
      );
    }
    return true;
  }
  // Helper to extract explicit code OR fallback to active listing
  const resolveTargetCode = (explicitCode) => {
    if (explicitCode) return explicitCode.toUpperCase();
    return getActiveListingCode(broker);
  };

  // 1. FLYER (e.g., "flyer", "flyer #HAS101", "كتالوج", "كتالوج #HAS101")
  if (
    (m = n.match(
      /^(?:كتالوج|بروشور|flyer|catalog)(?:\s+#?([a-zA-Z0-9_-]+))?$/i
    ))
  ) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      return (
        void (await reply(
          broker,
          M(
            lang,
            "⚠️ يرجى تحديد كود الوحدة أو فحص وحدة أولاً.",
            "⚠️ Please specify a unit code or select a unit first."
          )
        )) || true
      );
    }
    return (
      void (await cmdFlyer(broker, targetCode, "en", { theme: "dark" })) || true
    );
  }

  // 2. CLIENT TEXT (e.g., "client", "client #HAS101", "عميل", "عميل #HAS101")
  if ((m = n.match(/^(?:عميل|زبون|client)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      return (
        void (await reply(
          broker,
          M(
            lang,
            "⚠️ يرجى تحديد كود الوحدة أو فحص وحدة أولاً.",
            "⚠️ Please specify a unit code or select a unit first."
          )
        )) || true
      );
    }
    const l = await fetchListing(broker, targetCode);
    return (
      void (l
        ? reply(broker, T.formatClientListingText(l, broker, lang))
        : notFound(broker, targetCode)) || true
    );
  }

  // 3. STATUS CHANGE: SOLD (e.g., "sold", "sold #HAS101", "مباع", "تم البيع #HAS101")
  if ((m = n.match(/^(?:مباع|تم\s+البيع|sold)(?:\s+#?([a-zA-Z0-9_-]+))?$/i))) {
    const targetCode = resolveTargetCode(m[1]);
    if (!targetCode) {
      return (
        void (await reply(
          broker,
          M(
            lang,
            "⚠️ يرجى تحديد كود الوحدة لتغيير حالتها.",
            "⚠️ Please specify a unit code to update."
          )
        )) || true
      );
    }
    return void (await cmdStatus(broker, targetCode, "sold", lang)) || true;
  }

  // 4. PRICE UPDATE WITH OR WITHOUT CODE
  // Format A: "price #HAS101 to 18.5M" or "سعر #HAS101 إلى 18.5 مليون"
  // Format B (Contextual): "price to 18.5M", "price 18.5M", "سعر إلى 18.5 مليون"
  if (
    (m = n.match(
      /^(?:سعر|price)(?:\s+#?([a-zA-Z0-9_-]+))?\s+(?:إلى|to|=)?\s*(.+)$/i
    ))
  ) {
    let explicitCode = m[1];
    let priceRaw = m[2];

    // If m[1] was actually the start of the price (e.g., "price 18.5M")
    if (explicitCode && /^\d/.test(explicitCode) && !priceRaw) {
      priceRaw = explicitCode;
      explicitCode = null;
    }

    const targetCode = resolveTargetCode(explicitCode);
    if (!targetCode) {
      return (
        void (await reply(
          broker,
          M(
            lang,
            "⚠️ حدد كود الوحدة المراد تعديل سعرها.",
            "⚠️ Please specify a unit code to update price."
          )
        )) || true
      );
    }
    return void (await cmdPrice(broker, targetCode, priceRaw, lang)) || true;
  }

  // 5. LANGUAGE TOGGLE (e.g., "lang en", "lang ar", "عربي", "english")
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

async function handleInteractive(broker, message) {
  const id =
    message.interactive?.button_reply?.id ||
    message.interactive?.list_reply?.id ||
    "";
  const [kind, ...rest] = id.split(":");
  const lang = broker.preferred_lang || "ar";

  // When a broker taps a search result row
  if (kind === "inspect" && rest[0]) {
    const code = rest[0].toUpperCase();
    const l = await fetchListing(broker, code);
    if (!l) return notFound(broker, code);

    // 1. SET ACTIVE CONTEXT
    setActiveListing(broker, code);

    // 2. SEND FULL SPECS
    await reply(broker, T.formatInternalListingDetails(l, lang));

    // 3. SEND INTERACTIVE ACTION BUTTONS
    await WA.sendWhatsAppButtons(
      to(broker),
      M(lang, `إجراءات سريعة للوحدة #${code}:`, `Quick actions for #${code}:`),
      [
        { id: `flyer:en:dark:${code}`, title: "📄 Flyer (EN)" },
        {
          id: `client:${code}`,
          title: M(lang, "📲 نص العميل", "📲 Client Text")
        },
        {
          id: `status:sold:${code}`,
          title: M(lang, "🏷️ تم البيع", "🏷️ Mark Sold")
        }
      ]
    );

    // 4. SEND MONOSPACE CODE BUBBLE (One-tap clipboard copy)
    await WA.sendWhatsAppText(to(broker), `\`${code}\``);
    return "done";
  }

  // Handle Action Buttons
  if (kind === "status" && rest[0] && rest[1]) {
    const [newStatus, code] = rest;
    setActiveListing(broker, code);
    return cmdStatus(broker, code, newStatus, lang);
  }

  if (kind === "client" && rest[0]) {
    const code = rest[0].toUpperCase();
    setActiveListing(broker, code);
    const l = await fetchListing(broker, code);
    return l
      ? reply(broker, T.formatClientListingText(l, broker, lang))
      : notFound(broker, code);
  }

  if (kind === "flyer" && rest.length >= 3) {
    const [fl, theme, code] = rest;
    setActiveListing(broker, code);
    return cmdFlyer(broker, code, fl, { theme });
  }

  return "done";
}

/* ====================================================================== */
/* Message Ingestion Routing                                              */
/* ====================================================================== */
async function handleAudio(broker, message) {
  const key = U.normalizePhone(broker.phone);
  const lang = broker.preferred_lang || "ar";
  const media = message.audio || message.voice || {};
  const duration = Number(media.duration) || 0;

  if (duration > CFG.maxListingAudioSec) {
    await reply(
      broker,
      M(
        lang,
        `⚠️ التسجيل طويل جداً (${duration} ثانية). الحد الأقصى دقيقتان.`,
        `⚠️ Audio too long (${duration}s). Max 120s.`
      )
    );
    return "done";
  }

  let batch = null;
  if (isBatchingActive(key)) {
    batch = reserveBatch(broker, message.id);
    batch.pendingDownloads++;
  }

  const dl = await WA.downloadWhatsAppMedia(media.id, {
    maxBytes: 12 * 1024 * 1024
  });
  if (!dl) {
    if (batch) {
      batch.pendingDownloads = Math.max(0, batch.pendingDownloads - 1);
      armBatchTimer(key);
    }
    await reply(
      broker,
      M(
        lang,
        "⚠️ تعذر تحميل الرسالة الصوتية.",
        "⚠️ Failed to download voice note."
      )
    );
    return batch ? "batched" : "done";
  }

  const audioObj = { buffer: dl.buffer, mimeType: dl.mimeType, duration };
  if (batch) {
    batch.audios.push(audioObj);
    batch.voices.push(audioObj);
    batch.pendingDownloads = Math.max(0, batch.pendingDownloads - 1);
    armBatchTimer(key);
    return "batched";
  }

  return (
    (await handleSearchMessage(broker, {
      audio: audioObj,
      msgId: message.id
    })) || "done"
  );
}

// server.js - Replace handleText with this corrected precedence order:

async function handleText(broker, message) {
  const key = U.normalizePhone(broker.phone);
  const lang = broker.preferred_lang || "ar";
  const raw = ((message.text && message.text.body) || "").trim();
  if (!raw) return "done";

  // 1. Commands ALWAYS execute immediately (e.g., "تم", "sold", "price", "help")
  if (await handleCommand(broker, raw, message)) return "done";

  // 2. Batch lock for accumulating ongoing listing descriptions/edits
  if (isBatchingActive(key)) {
    reserveBatch(broker, message.id).texts.push(raw);
    return "batched";
  }

  // 3. Explicit listing actions open an ingestion batch immediately
  const explicitCode = L.extractExplicitUnitCode(raw);
  const isExplicitAction =
    /(?:إضافة|اضافة|استبدال|add|replace)\s*#?[A-Za-z0-9_-]{2,}/i.test(raw);
  if (explicitCode && isExplicitAction) {
    const batch = reserveBatch(broker, message.id, explicitCode);
    batch.texts.push(raw);
    return "batched";
  }

  // 4. Metadata buffer window for new listings
  if (L.isLikelyListingMetadata(raw)) {
    const timer = setTimeout(() => {
      const e = pendingTextBuffers.get(key);
      if (!e || e.timer !== timer) return;
      pendingTextBuffers.delete(key);
      perBroker(key, () =>
        als.run(
          {
            reqId: message.id,
            agencyId: broker.agency_id,
            brokerId: broker.id
          },
          async () => {
            try {
              const outcome = await handleSearchMessage(broker, {
                text: raw,
                msgId: message.id
              });
              await markMsgs(
                [message.id],
                outcome === "batched" ? "batched" : "done"
              );
            } catch (err) {
              log("error", "buffered text failed", errMeta(err));
              await markMsgs([message.id], "failed");
            }
          }
        )
      );
    }, CFG.textBufferMs);

    pendingTextBuffers.set(key, {
      text: raw,
      customCode: explicitCode,
      msgId: message.id,
      timer
    });
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
      return addImageToBatch(
        broker,
        message,
        message.image,
        ((message.image && message.image.caption) || "").trim()
      );
    case "document":
      const mime = (message.document && message.document.mime_type) || "";
      const filename = (message.document && message.document.filename) || "";
      const isImageDoc =
        /^image\//i.test(mime) ||
        /\.(jpe?g|png|webp|heic|heif)$/i.test(filename);

      if (isImageDoc) {
        return addImageToBatch(
          broker,
          message,
          message.document,
          (message.document.caption || "").trim()
        );
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

      if (!replay && (message.type !== "image" || !isBatchingActive(key))) {
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

  // Buffer length check and constant-time comparison
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
  for (const m of fresh)
    scheduleMessage(m).catch((e) =>
      log("error", "schedule failed", errMeta(e))
    );
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
      openBatches: incomingBatches.size,
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
  while (
    (inFlight > 0 || perBroker.size() > 0 || brokerWork.size() > 0) &&
    Date.now() < until
  ) {
    await U.sleep(300);
  }

  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const { loadFont } = require("./lib/flyer");

async function boot() {
  // 1. Pre-warm fonts in memory to avoid cold-start delays
  log("info", "Pre-warming fonts into RAM...");
  await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]).catch((err) => log("warn", "Font pre-warming failed", errMeta(err)));

  // 2. Prune old inbound messages (>14 days) to keep indexes fast
  pool
    .query(
      "DELETE FROM inbound_messages WHERE received_at < NOW() - INTERVAL '14 days'"
    )
    .catch((e) =>
      log("warn", "Inbound message table cleanup failed", errMeta(e))
    );

  // 3. Start server and run crash recovery
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

module.exports = { app };
