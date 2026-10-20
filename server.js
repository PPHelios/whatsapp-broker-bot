// server.js
"use strict";
require("dotenv").config();
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const express = require("express");
const sharp = require("sharp");
const { GoogleGenAI } = require("@google/genai");

const { pool } = require("./lib/db");
const { uploadListingImage, uploadFlyerImage } = require("./lib/supabase");
const { generateFlyerBuffer } = require("./lib/flyer");
const WA = require("./lib/whatsapp");
const T = require("./lib/text");
const S = require("./lib/search");
const L = require("./lib/listing");
const U = require("./lib/util");

/* ====================================================================== */
/* Config                                                                  */
/* ====================================================================== */
const CFG = {
  port: Number(process.env.PORT || 3000),
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  geminiFallback: process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite",
  geminiRpm: Number(process.env.GEMINI_RPM || 12),
  geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 45000),
  aiDailyLimit: Number(process.env.AI_DAILY_LIMIT_PER_AGENCY || 300), // 0 = unlimited
  debounceMs: Number(process.env.BATCH_DEBOUNCE_MS || 5000),
  batchMaxWaitMs: 90000,
  textBufferMs: 2500,
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
/* Logging + request context                                               */
/* ====================================================================== */
const als = new AsyncLocalStorage();
const ctx = () => als.getStore() || {};
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
const reply = (broker, text) => WA.sendWhatsAppText(to(broker), text);

/* ====================================================================== */
/* In-process state (everything here is rebuilt or irrelevant after a restart:  */
/* durable state lives in Postgres — inbound_messages, processed_batches, ...)  */
/* ====================================================================== */
const incomingBatches = new Map();
const pendingTextBuffers = new Map();
const recentBrokerListings = new Map(); // key -> { code, at }
const brokerCache = new Map();
const agencyCache = new Map();
const unknownNotified = new Map();
const lastTouch = new Map();
const cooldowns = new Map();

const perBroker = U.createSerializer(); // message handling order, per broker
const brokerWork = U.createSerializer(); // batch processing, per broker
const listingLocks = U.createSerializer(); // in-process mutex per listing
const listingLimiter = U.createLimiter(2, { maxQueue: 40 });
const uploadLimiter = U.createLimiter(4);
const rateGate = U.createRateGate(CFG.geminiRpm);
const msgRate = U.createCounter(60000, 80);
let inFlight = 0;

/* ====================================================================== */
/* Gemini: rate gate, retries, model fallback, usage + daily quota          */
/* ====================================================================== */
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const isTransient = (e) =>
  /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|timeout|ECONNRESET|ETIMEDOUT|fetch failed|\b500\b|INTERNAL|DEADLINE/i.test(
    String((e && e.message) || e)
  );

function recordUsage(kind, model, u = {}) {
  const c = ctx();
  pool
    .query(
      "INSERT INTO ai_usage (agency_id, broker_id, kind, model, input_tokens, output_tokens) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        c.agencyId || null,
        c.brokerId || null,
        kind,
        model,
        u.promptTokenCount || 0,
        u.candidatesTokenCount || 0
      ]
    )
    .catch((e) => log("warn", "usage log failed", errMeta(e)));
}

async function withinAiQuota(agencyId) {
  if (!CFG.aiDailyLimit) return true;
  try {
    const r = await pool.query(
      "SELECT COUNT(*)::int AS n FROM ai_usage WHERE agency_id = $1 AND created_at >= date_trunc('day', now())",
      [agencyId]
    );
    return r.rows[0].n < CFG.aiDailyLimit;
  } catch {
    return true; // never block brokers because of a bookkeeping failure
  }
}

async function callGemini({
  contents,
  config,
  model,
  kind = "generic",
  maxRetries = 3
}) {
  const models = [model || CFG.geminiModel, CFG.geminiFallback].filter(
    (m, i, a) => m && a.indexOf(m) === i
  );
  let lastErr;
  for (const m of models) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await rateGate();
      try {
        const res = await U.withTimeout(
          ai.models.generateContent({ model: m, contents, config }),
          CFG.geminiTimeoutMs,
          "gemini"
        );
        recordUsage(kind, m, res.usageMetadata);
        return res;
      } catch (err) {
        lastErr = err;
        log("warn", "gemini call failed", {
          model: m,
          attempt,
          ...errMeta(err)
        });
        if (!isTransient(err)) break; // non-transient: go straight to the fallback model
        if (attempt < maxRetries - 1)
          await U.sleep(
            Math.min(8000, 1000 * 2 ** attempt) + Math.random() * 400
          );
      }
    }
  }
  throw lastErr;
}
// lib/search.js talks to `ai.models.generateContent`; route it through the same gate/retry/usage.
const aiShim = {
  models: {
    generateContent: (a) =>
      callGemini({
        contents: a.contents,
        config: a.config,
        model: a.model,
        kind: "search"
      })
  }
};

const cleanJson = (t) =>
  String(t || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

/* ====================================================================== */
/* Loaders                                                                 */
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
    "SELECT url, role FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 15",
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
/* Images                                                                  */
/* ====================================================================== */
// Downscale immediately on arrival: keeps batch memory small (15 x ~300KB instead of 15 x ~5MB).
const normalizeImage = (buf) =>
  sharp(buf)
    .rotate()
    .resize({
      width: 1600,
      height: 1600,
      fit: "inside",
      withoutEnlargement: true
    })
    .jpeg({ quality: 82 })
    .toBuffer();
const toGeminiImage = (buf) =>
  sharp(buf)
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
  const tag = crypto.randomBytes(3).toString("hex");
  const out = await Promise.all(
    items.map((it, i) =>
      uploadLimiter(async () => {
        try {
          const url = await uploadListingImage(
            agencyId,
            `${code}-${tag}-${i + 1}`,
            it.buffer
          );
          return url ? { url, role: it.role || null, buffer: it.buffer } : null;
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
/* Flyer                                                                   */
/* ====================================================================== */
async function renderFlyer({ listing, images, agency, broker, lang, theme }) {
  try {
    const l = T.localizeListing(listing, lang);
    const d = l.details || {};
    return await generateFlyerBuffer({
      listing: {
        code: l.code,
        title: l.title,
        property_type: l.property_type || "apartment",
        listing_type: l.listing_type || "sale",
        price_value: l.price_value,
        price_display: l.price_display,
        area_value: l.area_value,
        bedrooms: l.bedrooms,
        bathrooms: d.bathrooms || null,
        location: l.location || "",
        contact_phone: broker.contact_phone || broker.phone || "",
        details: {
          ...d,
          image_roles: images.map((i) => i.role || ""),
          image_order: undefined
        }
      },
      agency,
      images: images.map((i) => i.buffer || i.url), // Buffers when we have them: no re-download
      lang,
      theme: theme || (agency && agency.flyer_theme) || "dark"
    });
  } catch (e) {
    log("error", "flyer render failed", errMeta(e));
    return null;
  }
}

async function uploadFlyer(agencyId, code, buf, suffix = "") {
  try {
    return (
      (await uploadFlyerImage(
        agencyId,
        `${code}-flyer${suffix}-${Date.now()}`,
        buf
      )) || null
    );
  } catch (e) {
    log("error", "flyer upload failed", errMeta(e));
    return null;
  }
}

// Sends the stored flyer. Prefers a cached WhatsApp media id; falls back to the public URL.
async function sendListingFlyer(broker, listing, caption, freshBuffer = null) {
  const fresh =
    listing.flyer_wa_media_id &&
    listing.flyer_wa_media_at &&
    Date.now() - new Date(listing.flyer_wa_media_at).getTime() < 25 * 86400000;
  let mediaId = fresh ? listing.flyer_wa_media_id : null;
  if (!mediaId && freshBuffer)
    mediaId = await WA.uploadWhatsAppMedia(freshBuffer, {
      mimeType: "image/jpeg",
      filename: `${listing.code}.jpg`
    });

  let sent = mediaId
    ? await WA.sendWhatsAppImage(to(broker), { id: mediaId }, caption)
    : null;
  if (!sent && listing.flyer_url) {
    sent = await WA.sendWhatsAppImage(to(broker), listing.flyer_url, caption);
    if (!sent && fresh)
      await pool
        .query("UPDATE listings SET flyer_wa_media_id = NULL WHERE id = $1", [
          listing.id
        ])
        .catch(() => {});
    mediaId = null;
  }
  if (sent && mediaId && !fresh && listing.id) {
    pool
      .query(
        "UPDATE listings SET flyer_wa_media_id = $1, flyer_wa_media_at = NOW() WHERE id = $2 AND flyer_url IS NOT DISTINCT FROM $3",
        [mediaId, listing.id, listing.flyer_url || null]
      )
      .catch(() => {});
  }
  return Boolean(sent);
}

async function renderStoredFlyer(broker, listing, { lang, theme, persist }) {
  const agency = await getAgency(broker.agency_id);
  const images = await loadListingImages(listing.id);
  if (!images.length) return { ok: false, reason: "no_images" };
  const buf = await renderFlyer({
    listing,
    images,
    agency,
    broker,
    lang,
    theme
  });
  if (!buf) return { ok: false, reason: "render" };
  if (persist) {
    const url = await uploadFlyer(broker.agency_id, listing.code, buf);
    if (url) {
      await pool.query(
        "UPDATE listings SET flyer_url = $1, flyer_wa_media_id = NULL, flyer_wa_media_at = NULL WHERE id = $2",
        [url, listing.id]
      );
      listing = {
        ...listing,
        flyer_url: url,
        flyer_wa_media_id: null,
        flyer_wa_media_at: null
      };
    }
  }
  return { ok: true, buf, listing };
}

/* ====================================================================== */
/* Listing persistence (optimistic concurrency; the transaction only holds   */
/* DB writes — rendering/uploading happen before it)                         */
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
  flyerUrl,
  flyerChanged,
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
        `INSERT INTO listings (agency_id, broker_id, code, title, property_type, listing_type, price_value, price_display,
           area_value, bedrooms, location, compound, district, city, location_keywords, details, flyer_url, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active') RETURNING *`,
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
          fields.details,
          flyerUrl
        ]
      );
      row = ins.rows[0];
      await insertImages(client, row.id, agencyId, 0, newImages);
    } else {
      const id = existing.id;
      let start = 0;
      if (replace)
        await client.query("DELETE FROM listing_images WHERE listing_id = $1", [
          id
        ]);
      else
        start = Number(
          (
            await client.query(
              "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM listing_images WHERE listing_id = $1",
              [id]
            )
          ).rows[0].p
        );
      await insertImages(client, id, agencyId, start, newImages);
      const upd = await client.query(
        `UPDATE listings SET title=$1, property_type=$2, listing_type=$3, price_value=$4, price_display=$5, area_value=$6,
           bedrooms=$7, location=$8, compound=$9, district=$10, city=$11, location_keywords=$12, details=$13, flyer_url=$14,
           flyer_wa_media_id = CASE WHEN $15::boolean THEN NULL ELSE flyer_wa_media_id END,
           flyer_wa_media_at = CASE WHEN $15::boolean THEN NULL ELSE flyer_wa_media_at END,
           updated_at = NOW()
         WHERE id = $16 RETURNING *`,
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
          flyerUrl,
          Boolean(flyerChanged),
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
      return { conflict: true }; // someone created/changed the same code meanwhile
    }
    throw err;
  } finally {
    client.release();
  }
}

/* ====================================================================== */
/* Price sanity (soft warning, never blocks)                                */
/* ====================================================================== */
async function priceSanityNote(agencyId, f, lang) {
  if (f.listing_type !== "sale" || !f.price_value) return "";
  if (f.price_value < 100000)
    return M(
      lang,
      "⚠️ السعر يبدو منخفضاً جداً، راجعه.",
      "⚠️ The price looks very low, please double-check."
    );
  if (!f.area_value) return "";
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY price_value / area_value) AS med
       FROM listings
       WHERE agency_id = $1 AND listing_type = 'sale' AND area_value > 0 AND price_value > 0 AND code <> $4
         AND (($2::text <> '' AND compound = $2::text) OR ($3::text <> '' AND district = $3::text))`,
      [agencyId, f.compound || "", f.district || "", f.code]
    );
    const { n, med } = r.rows[0];
    if (n < 5 || !med) return "";
    const ppm = f.price_value / f.area_value;
    const ratio = ppm / Number(med);
    if (ratio >= 0.5 && ratio <= 1.8) return "";
    const fmt = (v) => Math.round(v).toLocaleString("en-US");
    return M(
      lang,
      `⚠️ سعر المتر (${fmt(ppm)}) يختلف كثيراً عن متوسط وحدات مشابهة (${fmt(
        med
      )}). لو في خطأ: سعر ${f.code} إلى ...`,
      `⚠️ Price/sqm (${fmt(ppm)}) differs a lot from similar units (${fmt(
        med
      )}). To fix: price ${f.code} to ...`
    );
  } catch {
    return "";
  }
}

/* ====================================================================== */
/* Batch processing                                                         */
/* ====================================================================== */
async function extractDraft({ batch, lang, geminiImgs }) {
  const parts = [{ text: L.buildListingPrompt(lang) }];
  const notes = [...batch.texts, ...batch.captions];
  if (notes.length)
    parts.push({
      text: `--- [EXPLICIT BROKER TEXT] ---\n${notes.join("\n\n")}`
    });
  if (batch.voices.length) {
    parts.push({ text: "--- [BROKER AUDIO RECORDINGS] ---" });
    for (const v of batch.voices) {
      if (v.buffer)
        parts.push({
          inlineData: {
            mimeType: String(v.mimeType || "audio/ogg").split(";")[0],
            data: v.buffer.toString("base64")
          }
        });
    }
  }
  if (geminiImgs.length) {
    parts.push({
      text: `--- [ATTACHED IMAGES: ${geminiImgs.length}, index starts at 0] ---`
    });
    for (const b of geminiImgs)
      parts.push({
        inlineData: { mimeType: "image/jpeg", data: b.toString("base64") }
      });
  }
  const res = await callGemini({
    contents: parts,
    config: {
      temperature: 0.1,
      maxOutputTokens: 3072,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 768 }
    },
    kind: "listing_extract"
  });
  let raw;
  try {
    raw = JSON.parse(cleanJson(res.text));
  } catch {
    throw new Error("model returned invalid JSON");
  }
  return L.validateDraft(raw, geminiImgs.length, lang);
}

async function processBatch(batch) {
  const { broker } = batch;
  const ids = batch.msgIds;
  const key = U.normalizePhone(broker.phone);
  const agencyId = broker.agency_id;
  const batchKey = U.sha1([...ids].sort().join(","));

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
      log("info", "batch already processed, skipping", { batchKey });
      await markMsgs(ids, "done");
      return;
    }

    // photos-only follow-up shortly after a listing => attach to that listing (told to the broker)
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
      images.length
        ? M(
            lang,
            "⏳ جاري فحص البيانات والمواصفات وتصميم الكتالوج...",
            "⏳ Verifying property details and designing the brochure..."
          )
        : M(
            lang,
            "⏳ جاري استخراج مواصفات الوحدة وحفظ البيانات...",
            "⏳ Extracting property specifications and saving the unit..."
          )
    );

    if (!(await withinAiQuota(agencyId))) {
      await markMsgs(ids, "failed");
      return void (await reply(
        broker,
        M(
          lang,
          "⛔ تم الوصول للحد اليومي لاستخدام الذكاء الاصطناعي لوكالتك. حاول غداً.",
          "⛔ Your agency reached today's AI usage limit. Try again tomorrow."
        )
      ));
    }

    // ---- AI extraction ----
    const geminiImgs = await Promise.all(
      images.map((i) => toGeminiImage(i.buffer))
    );
    let draft;
    try {
      draft = await extractDraft({ batch, lang, geminiImgs });
    } catch (e) {
      log("error", "extraction failed", errMeta(e));
      await markMsgs(ids, "failed");
      return void (await reply(
        broker,
        M(
          lang,
          "⚠️ تعذر تحليل الوحدة الآن (ضغط مؤقت). اكتب «أعد المحاولة» ولن تحتاج لإعادة إرسال الصور.",
          "⚠️ Could not analyse the unit right now. Send «retry» — no need to resend the photos."
        )
      ));
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
          "⚠️ لم يتم استخراج مواصفات كافية ولم تُرفق صور. لم يتم حفظ العقار.",
          "⚠️ Not enough specifications and no photos. Listing not saved."
        )
      ));
    }

    // ---- location enrichment (helps search recall) ----
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

    // ---- images in marketing order, with roles ----
    const ordered = draft.details.image_order.map((idx) => ({
      buffer: images[idx].buffer,
      role: draft.details.image_roles[idx]
    }));
    let { code, explicit: codeExplicit } = L.generateListingCode(
      explicit || draft.custom_code,
      draft.property_type
    );
    const up = ordered.length
      ? await uploadImages(agencyId, code, ordered)
      : { ok: [], failed: 0 };
    if (ordered.length && !up.ok.length && imageOnly) {
      await markMsgs(ids, "failed");
      return void (await reply(
        broker,
        M(
          lang,
          "⚠️ تعذر رفع الصور. اكتب «أعد المحاولة».",
          "⚠️ Photo upload failed. Send «retry»."
        )
      ));
    }

    const agency = await getAgency(agencyId);
    const theme = agency.flyer_theme || "dark";

    // ---- build -> render -> commit (retry on concurrent change) ----
    let result = null;
    let flyerBuf = null;
    let fields = null;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const existing = await loadExisting(agencyId, code);
      if (existing && !codeExplicit) {
        code = L.generateListingCode(null, draft.property_type).code; // random code collided
        continue;
      }
      if (existing && !canEdit(broker, existing)) {
        await markMsgs(ids, "done");
        return void (await reply(
          broker,
          M(
            lang,
            `⛔ الكود #${code} يخص وحدة مسجلة بواسطة زميل. اطلب من المدير تعديلها.`,
            `⛔ Code #${code} belongs to a colleague's unit. Ask an admin to edit it.`
          )
        ));
      }
      fields = L.composeFields({
        existing,
        draft,
        price,
        imageOnly,
        lang,
        enriched
      });
      const replace = Boolean(existing && replaceMode && up.ok.length);
      const kept = existing && !replace ? existing.images : [];
      const allImages = [...kept, ...up.ok];

      flyerBuf = null;
      let flyerUrl = existing ? existing.flyer_url : null;
      let flyerChanged = false;
      if (allImages.length) {
        flyerBuf = await renderFlyer({
          listing: { code, ...fields },
          images: allImages,
          agency,
          broker,
          lang,
          theme
        });
        if (flyerBuf) {
          const u = await uploadFlyer(agencyId, code, flyerBuf);
          if (u) {
            flyerUrl = u;
            flyerChanged = true;
          }
        }
      }
      const r = await persistListing({
        broker,
        code,
        existing,
        fields,
        newImages: up.ok,
        replace,
        flyerUrl,
        flyerChanged: flyerChanged || replace,
        batchKey
      });
      if (r.duplicate) {
        await markMsgs(ids, "done");
        return;
      }
      if (!r.conflict) result = r;
    }
    if (!result)
      throw new Error("listing changed concurrently, retries exhausted");

    const listing = result.listing;
    recentBrokerListings.set(key, { code: listing.code, at: Date.now() });
    await markMsgs(ids, "done");
    log("info", "listing saved", {
      code: listing.code,
      created: result.created,
      images: up.ok.length
    });

    // ---- notify (failures here never undo the save) ----
    const warnings = [];
    if (carried)
      warnings.push(
        M(
          lang,
          `🔗 أُضيفت الصور إلى آخر وحدة #${carried}. لو دي وحدة جديدة ابعت مواصفاتها مع الصور.`,
          `🔗 Photos were added to your last unit #${carried}. For a new unit, send its details with the photos.`
        )
      );
    if (up.failed)
      warnings.push(
        M(
          lang,
          `⚠️ تعذر رفع ${up.failed} صورة.`,
          `⚠️ ${up.failed} photo(s) failed to upload.`
        )
      );
    if (batch.dropped)
      warnings.push(
        M(
          lang,
          `ℹ️ تم تجاهل ${batch.dropped} صورة (الحد ${CFG.maxImages}).`,
          `ℹ️ ${batch.dropped} photo(s) ignored (max ${CFG.maxImages}).`
        )
      );
    if (batch.failedDownloads)
      warnings.push(
        M(
          lang,
          `⚠️ تعذر تحميل ${batch.failedDownloads} صورة من واتساب.`,
          `⚠️ ${batch.failedDownloads} photo(s) could not be downloaded.`
        )
      );
    const imgCount =
      (result.created ? 0 : 0) +
      (
        await pool.query(
          "SELECT COUNT(*)::int AS n FROM listing_images WHERE listing_id = $1",
          [listing.id]
        )
      ).rows[0].n;
    if (imgCount > 0 && !flyerBuf && !listing.flyer_url)
      warnings.push(
        M(
          lang,
          `⚠️ تم الحفظ لكن تعذر تصميم الكتالوج. اكتب: كتالوج ${listing.code}`,
          `⚠️ Saved, but the flyer failed. Send: catalog ${listing.code}`
        )
      );
    if (imgCount === 0)
      warnings.push(
        M(
          lang,
          `💡 تم التسجيل بدون صور. أرسل الصور مع: إضافة #${listing.code}`,
          `💡 Saved without photos. Send photos with: add #${listing.code}`
        )
      );
    const sanity = await priceSanityNote(agencyId, { ...listing }, lang);
    if (sanity) warnings.push(sanity);

    if (flyerBuf || listing.flyer_url) {
      await sendListingFlyer(
        broker,
        listing,
        result.created
          ? M(
              lang,
              `📋 كتالوج تسويقي معتمد - كود الوحدة: #${listing.code}`,
              `📋 Verified Brochure - Unit #${listing.code}`
            )
          : M(
              lang,
              `📋 كتالوج تسويقي محدث - كود الوحدة: #${listing.code}`,
              `📋 Updated Brochure - Unit #${listing.code}`
            ),
        flyerBuf
      );
    }
    if (result.created)
      await reply(broker, T.formatClientListingText(listing, broker, lang));

    const otherLang = lang === "en" ? "ar" : "en";
    const otherTheme = theme === "dark" ? "light" : "dark";
    const body = [
      M(
        lang,
        `✅ ${result.created ? "تم حفظ" : "تم تحديث"} الوحدة *#${
          listing.code
        }*`,
        `✅ Unit *#${listing.code}* ${result.created ? "saved" : "updated"}`
      ),
      ...warnings
    ].join("\n");
    const buttons = [
      {
        id: `client:${listing.code}`,
        title: M(lang, "نص للعميل", "Client text")
      }
    ];
    if (imgCount > 0) {
      buttons.unshift({
        id: `flyer:${otherLang}:${theme}:${listing.code}`,
        title: otherLang === "en" ? "Flyer EN" : "كتالوج عربي"
      });
      buttons.push({
        id: `flyer:${lang}:${otherTheme}:${listing.code}`,
        title: M(
          lang,
          otherTheme === "light" ? "ثيم فاتح" : "ثيم داكن",
          otherTheme === "light" ? "Light theme" : "Dark theme"
        )
      });
    }
    if (!(await WA.sendWhatsAppButtons(to(broker), body, buttons)))
      await reply(broker, body);
  } catch (err) {
    log("error", "batch processing failed", errMeta(err));
    await markMsgs(ids, "failed");
    await reply(
      broker,
      M(
        lang,
        "❌ حدث خطأ أثناء حفظ العقار. اكتب «أعد المحاولة» وسنكمل من حيث توقفنا.",
        "❌ An error occurred while saving. Send «retry» and we'll pick up where we left off."
      )
    );
  }
}

/* ====================================================================== */
/* Batching (debounce window that groups photos + text + voice of one unit)   */
/* ====================================================================== */
function reserveBatch(broker, msgId, initialCode = null) {
  const key = U.normalizePhone(broker.phone);
  let batch = incomingBatches.get(key);
  if (!batch) {
    batch = {
      broker,
      from: broker.phone,
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
  } else if (initialCode && !batch.customCode) batch.customCode = initialCode;

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

  const lang = batch.broker.preferred_lang || "ar";
  const st = listingLimiter.stats();
  if (st.queued > 0) {
    reply(
      batch.broker,
      M(
        lang,
        `🕐 طلبك في الانتظار (رقم ${st.queued} في الدور).`,
        `🕐 Queued (position ${st.queued}).`
      )
    ).catch(() => {});
  }
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
  } catch (err) {
    log("error", "batch scheduling failed", errMeta(err));
    await markMsgs(batch.msgIds, "failed");
    await reply(
      batch.broker,
      err.code === "QUEUE_FULL"
        ? M(
            lang,
            "⚠️ النظام مشغول جداً الآن. اكتب «أعد المحاولة» بعد دقيقة.",
            "⚠️ System is busy. Send «retry» in a minute."
          )
        : M(
            lang,
            "❌ حدث خطأ غير متوقع. اكتب «أعد المحاولة».",
            "❌ Unexpected error. Send «retry»."
          )
    );
  } finally {
    inFlight--;
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
      if (batch.closed)
        return void log("warn", "image arrived after batch closed", {
          mediaId: media.id
        });
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
/* Search                                                                   */
/* ====================================================================== */
async function loadSearchState(key) {
  const r = await pool.query(
    "SELECT parsed, next_offset FROM broker_search_state WHERE phone_key = $1",
    [key]
  );
  return r.rows[0] || null;
}

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
    const st = await loadSearchState(key);
    if (!st)
      return void (await reply(
        broker,
        M(lang, "⚠️ لا يوجد بحث سابق نشط.", "⚠️ No active search found.")
      ));
    parsed = st.parsed;
    offset = st.next_offset;
  } else {
    if (!(await withinAiQuota(broker.agency_id))) {
      return void (await reply(
        broker,
        M(
          lang,
          "⛔ تم الوصول للحد اليومي للذكاء الاصطناعي.",
          "⛔ Daily AI limit reached."
        )
      ));
    }
    reply(
      broker,
      isVoice
        ? M(
            lang,
            "🎙️ جاري الاستماع لطلبك...",
            "🎙️ Listening to your request..."
          )
        : M(lang, "🔍 جاري البحث...", "🔍 Searching...")
    ).catch(() => {});
    try {
      ({ parsed } = await S.parseSearchRequest(aiShim, {
        text,
        audio: isVoice ? [audio] : [],
        model: CFG.geminiModel
      }));
    } catch (e) {
      log("warn", "search parse failed", errMeta(e));
      if (isVoice)
        return void (await reply(
          broker,
          M(
            lang,
            "❌ تعذر فهم التسجيل. جرب مرة أخرى أو اكتب طلبك.",
            "❌ Could not understand the recording. Try again or type it."
          )
        ));
      parsed = S.fallbackParse(text); // Gemini unavailable: keyword search still works
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
          "👋 اكتب `مساعدة` لعرض الأوامر، أو اكتب طلب بحثك (مثال: شقة 3 غرف في التجمع تحت 10 مليون).",
          "👋 Send `help` for commands, or type a search (e.g. 3-bed apartment in New Cairo under 10M)."
        )
      ));
    }
    if (isVoice && audio.duration > CFG.maxSearchAudioSec) {
      return void (await reply(
        broker,
        M(
          lang,
          `⚠️ تسجيل البحث طويل (${audio.duration} ثانية). الحد ${CFG.maxSearchAudioSec} ثانية.`,
          `⚠️ Search recording too long (${audio.duration}s). Max ${CFG.maxSearchAudioSec}s.`
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
      M(
        lang,
        "❌ خطأ أثناء البحث. حاول مرة أخرى.",
        "❌ Search error. Please try again."
      )
    ));
  }

  const total = rows.length ? parseInt(rows[0].total_count, 10) : 0;
  if (!total)
    return void (await reply(
      broker,
      M(
        lang,
        "🔍 لم يتم العثور على وحدات مطابقة. جرب توسيع الميزانية أو المنطقة.",
        "🔍 No matching units. Try widening the budget or area."
      )
    ));

  pool
    .query(
      `INSERT INTO broker_search_state (phone_key, parsed, next_offset, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (phone_key) DO UPDATE SET parsed = EXCLUDED.parsed, next_offset = EXCLUDED.next_offset, updated_at = NOW()`,
      [key, { ...parsed, __relaxed: relaxed }, offset + rows.length]
    )
    .catch((e) => log("warn", "search state save failed", errMeta(e)));

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
/* Commands                                                                 */
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
  return listingLocks(`${broker.agency_id}:${code}`, async () => {
    const l = await fetchListing(broker, code);
    if (!l) return notFound(broker, code);
    if (!canEdit(broker, l))
      return reply(
        broker,
        M(
          lang,
          "⛔ لا تملك صلاحية تعديل هذه الوحدة.",
          "⛔ You can't edit this unit."
        )
      );
    const p = T.parseEgyptianPrice(priceRaw, {
      lang,
      listingType: l.listing_type
    });
    if (!p.priceValue)
      return reply(
        broker,
        M(
          lang,
          "❌ مش قادر أفهم السعر. مثال: سعر " + code + " إلى 19.5 مليون",
          "❌ Couldn't parse the price. Example: price " + code + " to 19.5M"
        )
      );
    const u = await pool.query(
      "UPDATE listings SET price_value = $1, price_display = $2, updated_at = NOW() WHERE id = $3 RETURNING *",
      [p.priceValue, p.priceDisplay, l.id]
    );
    let listing = u.rows[0];
    const out = await renderStoredFlyer(broker, listing, {
      lang,
      persist: true
    });
    if (out.ok) {
      listing = out.listing;
      await sendListingFlyer(
        broker,
        listing,
        M(lang, `📋 كتالوج محدث #${code}`, `📋 Updated flyer #${code}`),
        out.buf
      );
    }
    const note = await priceSanityNote(broker.agency_id, listing, lang);
    await reply(
      broker,
      [
        M(
          lang,
          `✅ تم تحديث سعر #${code} إلى ${p.priceDisplay}.`,
          `✅ Price of #${code} updated to ${p.priceDisplay}.`
        ),
        note
      ]
        .filter(Boolean)
        .join("\n")
    );
  });
}

async function cmdFlyer(
  broker,
  code,
  lang,
  { theme, persist = false, caption } = {}
) {
  const l = await fetchListing(broker, code);
  if (!l) return notFound(broker, code);
  if (!theme && !persist && l.flyer_url) {
    if (await sendListingFlyer(broker, l, caption || `📋 #${l.code}`)) return;
  }
  const out = await renderStoredFlyer(broker, l, {
    lang,
    theme,
    persist: persist || (!theme && !l.flyer_url)
  });
  if (!out.ok) {
    return reply(
      broker,
      out.reason === "no_images"
        ? M(
            lang,
            `⚠️ لا توجد صور لهذه الوحدة. أرسل الصور مع: إضافة #${l.code}`,
            `⚠️ No photos for this unit. Send photos with: add #${l.code}`
          )
        : M(
            lang,
            "⚠️ تعذر تصميم الكتالوج الآن. حاول بعد قليل.",
            "⚠️ Could not render the flyer now. Try again shortly."
          )
    );
  }
  if (persist || (!theme && !l.flyer_url))
    return void (await sendListingFlyer(
      broker,
      out.listing,
      caption || `📋 #${l.code}`,
      out.buf
    ));
  // one-off variant (language / theme): sent, not stored
  const id = await WA.uploadWhatsAppMedia(out.buf, {
    mimeType: "image/jpeg",
    filename: `${l.code}-${lang}-${theme}.jpg`
  });
  if (
    !(
      id &&
      (await WA.sendWhatsAppImage(
        to(broker),
        { id },
        caption || `📋 #${l.code}`
      ))
    )
  ) {
    await reply(
      broker,
      M(lang, "⚠️ تعذر إرسال الصورة.", "⚠️ Could not send the image.")
    );
  }
}

async function cmdStats(broker, lang) {
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='active') AS active, COUNT(*) FILTER (WHERE status='sold') AS sold,
            COUNT(*) FILTER (WHERE broker_id = $2) AS mine FROM listings WHERE agency_id = $1`,
    [broker.agency_id, broker.id]
  );
  const s = r.rows[0] || {};
  await reply(
    broker,
    M(
      lang,
      `📊 إحصائيات المخزون:\n• الوحدات النشطة: ${s.active || 0}\n• المباعة: ${
        s.sold || 0
      }\n• وحداتك: ${s.mine || 0}`,
      `📊 Inventory:\n• Active: ${s.active || 0}\n• Sold: ${
        s.sold || 0
      }\n• Yours: ${s.mine || 0}`
    )
  );
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
    `SELECT code, title, property_type, listing_type, price_value, area_value, bedrooms, location, compound, status, flyer_url, created_at
     FROM listings WHERE agency_id = $1 ${
       isAdmin ? "" : "AND broker_id = $2"
     } ORDER BY created_at DESC LIMIT 5000`,
    isAdmin ? [broker.agency_id] : [broker.agency_id, broker.id]
  );
  if (!r.rowCount)
    return reply(
      broker,
      M(lang, "لا توجد وحدات للتصدير.", "No units to export.")
    );
  const sent = await WA.sendWhatsAppDocument(
    to(broker),
    Buffer.from(T.listingsToCsv(r.rows), "utf8"),
    `listings-${new Date().toISOString().slice(0, 10)}.csv`,
    M(lang, `📄 ${r.rowCount} وحدة`, `📄 ${r.rowCount} units`)
  );
  if (!sent)
    await reply(
      broker,
      M(lang, "⚠️ تعذر إرسال الملف.", "⚠️ Could not send the file.")
    );
}

async function cmdRetry(broker, lang) {
  const key = U.normalizePhone(broker.phone);
  const r = await pool.query(
    `UPDATE inbound_messages SET status = 'new', attempts = 0, updated_at = NOW()
     WHERE phone_key = $1 AND status = 'failed' AND received_at > NOW() - INTERVAL '15 minutes'
     RETURNING msg_id, phone_key, payload, received_at`,
    [key]
  );
  if (!r.rowCount)
    return reply(
      broker,
      M(lang, "لا توجد عملية فاشلة حديثة لإعادتها.", "Nothing recent to retry.")
    );
  await reply(broker, M(lang, "🔁 جاري إعادة المحاولة...", "🔁 Retrying..."));
  replayRows(r.rows).catch((e) =>
    log("error", "retry replay failed", errMeta(e))
  ); // not awaited: we are inside the broker's queue
}

// returns true when the text was a command
async function handleCommand(broker, raw, lang) {
  const key = U.normalizePhone(broker.phone);
  const n = T.normalizeAr(raw);
  let m;

  if (/^(help|مساعده|اوامر|قواعد|تعليمات)$/.test(n))
    return void (await reply(broker, T.getHelpMessage())) || true;
  if (/^(تم|تمام|ابدا|خلاص|go|done)$/.test(n)) {
    if (incomingBatches.has(key))
      finalizeBatch(key, { force: true }).catch((e) =>
        log("error", "finalize failed", errMeta(e))
      );
    else
      await reply(
        broker,
        M(
          lang,
          "لا توجد وحدة قيد التجهيز الآن.",
          "Nothing is being prepared right now."
        )
      );
    return true;
  }
  if (/^(المزيد|more|التالي)$/.test(n))
    return void (await handleSearchMessage(broker, { more: true })) || true;
  if (/^(احصائيات|stats)$/.test(n))
    return void (await cmdStats(broker, lang)) || true;
  if (/^(اعد المحاوله|اعاده المحاوله|retry)$/.test(n))
    return void (await cmdRetry(broker, lang)) || true;
  if (/^(اكسيل|excel|csv|تصدير)$/.test(n))
    return void (await cmdExport(broker, lang)) || true;

  if (
    (m = raw.match(
      new RegExp(
        `^(?:سعر|price)\\s+#?${CODE}\\s+(?:إلى|الى|ل|to)\\s+(.+)$`,
        "i"
      )
    ))
  )
    return void (await cmdPrice(broker, m[1], m[2], lang)) || true;

  if (
    (m = raw.match(
      new RegExp(
        `^(?:كتالوج|بروشور|catalog|brochure)\\s+(?:عميل|client)\\s+#?${CODE}$`,
        "i"
      )
    ))
  ) {
    const l = await fetchListing(broker, m[1]);
    if (!l) return void (await notFound(broker, m[1].toUpperCase())) || true;
    if (l.flyer_url) await sendListingFlyer(broker, l, `📋 #${l.code}`);
    await reply(broker, T.formatClientListingText(l, broker, lang));
    return true;
  }
  if ((m = raw.match(new RegExp(`^(?:عميل|client)\\s+#?${CODE}$`, "i")))) {
    const l = await fetchListing(broker, m[1]);
    return (
      void (await (l
        ? reply(broker, T.formatClientListingText(l, broker, lang))
        : notFound(broker, m[1].toUpperCase()))) || true
    );
  }
  if (
    (m = raw.match(
      new RegExp(`^(?:كتالوج|بروشور|catalog|brochure)\\s+#?${CODE}$`, "i")
    ))
  )
    return void (await cmdFlyer(broker, m[1], lang)) || true;
  if ((m = raw.match(new RegExp(`^#${CODE}$`)))) {
    const l = await fetchListing(broker, m[1]);
    return (
      void (await (l
        ? reply(broker, T.formatInternalListingDetails(l, lang))
        : notFound(broker, m[1].toUpperCase()))) || true
    );
  }
  return false;
}

async function handleInteractive(broker, message) {
  const id =
    (message.interactive &&
      ((message.interactive.button_reply &&
        message.interactive.button_reply.id) ||
        (message.interactive.list_reply &&
          message.interactive.list_reply.id))) ||
    "";
  const [kind, ...rest] = id.split(":");
  const lang = broker.preferred_lang || "ar";
  if (kind === "client" && rest[0]) {
    const l = await fetchListing(broker, rest[0]);
    await (l
      ? reply(broker, T.formatClientListingText(l, broker, lang))
      : notFound(broker, rest[0].toUpperCase()));
  } else if (kind === "flyer" && rest.length === 3) {
    const [fl, theme, code] = rest;
    if (["ar", "en"].includes(fl) && ["dark", "light"].includes(theme))
      await cmdFlyer(broker, code, fl, {
        theme,
        caption: `📋 #${code.toUpperCase()}`
      });
  }
  return "done";
}

/* ====================================================================== */
/* Message dispatch                                                         */
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
        `⚠️ التسجيل طويل (${duration} ثانية). الحد ${CFG.maxListingAudioSec} ثانية.`,
        `⚠️ Recording too long (${duration}s). Max ${CFG.maxListingAudioSec}s.`
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
    maxBytes: 8 * 1024 * 1024
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
        "⚠️ تعذر تحميل التسجيل الصوتي. أعد إرساله.",
        "⚠️ Could not download the voice note. Please resend it."
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

async function handleText(broker, message) {
  const key = U.normalizePhone(broker.phone);
  const lang = broker.preferred_lang || "ar";
  const raw = ((message.text && message.text.body) || "").trim();
  if (!raw) return "done";

  if (await handleCommand(broker, raw, lang)) return "done"; // commands work even while a batch is open

  if (isBatchingActive(key)) {
    reserveBatch(broker, message.id).texts.push(raw);
    return "batched";
  }
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
              await reply(
                broker,
                M(
                  lang,
                  "❌ حدث خطأ. أعد إرسال الرسالة.",
                  "❌ Something went wrong. Please resend."
                )
              );
            }
          }
        )
      );
    }, CFG.textBufferMs);
    pendingTextBuffers.set(key, {
      text: raw,
      customCode: L.extractExplicitUnitCode(raw),
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

// -> "batched" (kept in the durable inbox until its batch completes) | "done"
async function dispatchMessage(broker, message) {
  const lang = broker.preferred_lang || "ar";
  switch (message.type) {
    case "image":
      return addImageToBatch(
        broker,
        message,
        message.image,
        ((message.image && message.image.caption) || "").trim()
      );
    case "document":
      if (
        message.document &&
        /^image\//i.test(message.document.mime_type || "")
      ) {
        return addImageToBatch(
          broker,
          message,
          message.document,
          (message.document.caption || "").trim()
        );
      }
      await reply(
        broker,
        M(
          lang,
          "📎 الملفات غير مدعومة. أرسل الصور كصور عادية.",
          "📎 Files aren't supported. Send photos as regular images."
        )
      );
      return "done";
    case "audio":
    case "voice":
      return handleAudio(broker, message);
    case "video":
      await reply(
        broker,
        M(
          lang,
          "📹 الفيديو غير مدعوم للكتالوجات. أرسل صوراً أو مواصفات صوتية/نصية.",
          "📹 Videos aren't supported. Send photos or voice/text specs."
        )
      );
      return "done";
    case "interactive":
      return handleInteractive(broker, message);
    case "text":
      return handleText(broker, message);
    case "reaction":
    case "system":
    case "unsupported":
      return "done";
    default:
      await reply(
        broker,
        M(
          lang,
          "⚠️ نوع الرسالة غير مدعوم. أرسل نصاً أو صوتاً أو صوراً.",
          "⚠️ Unsupported message type. Send text, voice or photos."
        )
      );
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
            "⚠️ رقم الهاتف غير مسجل في أي وكالة عقارية معتمدة."
          );
        }
        return markMsgs([message.id], "done");
      }
      ctx().agencyId = broker.agency_id;
      ctx().brokerId = broker.id;
      if (broker.is_active === false) {
        await reply(broker, "⛔ تم تعطيل هذا الحساب مؤقتاً.");
        return markMsgs([message.id], "done");
      }
      if (!replay && !msgRate(key)) {
        log("warn", "rate limit hit", { key });
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
      if (!replay && (message.type !== "image" || !isBatchingActive(key)))
        WA.markAsRead(message.id, {
          typing: message.type !== "interactive"
        }).catch(() => {});

      const outcome = await dispatchMessage(broker, message);
      await markMsgs([message.id], outcome === "batched" ? "batched" : "done");
    } catch (err) {
      log("error", "message processing failed", errMeta(err));
      await markMsgs([message.id], "failed");
      await WA.sendWhatsAppText(
        key,
        "❌ حدث خطأ غير متوقع. اكتب «أعد المحاولة» أو أعد الإرسال."
      ).catch(() => {});
    } finally {
      inFlight--;
    }
  });
}

const scheduleMessage = (message) =>
  perBroker(U.normalizePhone(message.from), () => processMessage(message));

/* ====================================================================== */
/* Durable inbox: persist -> ACK -> process; replay unfinished work on boot   */
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
    if (r.rowCount) fresh.push(m); // duplicates (Meta retries / restarts) are dropped here, durably
  }
  return fresh;
}

// Rebuilds batches from stored messages; media is re-downloaded by id. Groups by time gaps so two
// unfinished units are never merged into one.
async function replayRows(rows) {
  const byPhone = new Map();
  for (const r of rows) {
    if (!byPhone.has(r.phone_key)) byPhone.set(r.phone_key, []);
    byPhone.get(r.phone_key).push(r);
  }
  await Promise.all(
    [...byPhone].map(async ([key, list]) => {
      list.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
      let prev = null;
      for (const r of list) {
        const t = new Date(r.received_at).getTime();
        if (prev !== null && t - prev > 20000)
          await finalizeBatch(key, { force: true });
        await perBroker(key, () => processMessage(r.payload, { replay: true }));
        prev = t;
      }
      await finalizeBatch(key, { force: true });
    })
  );
}

async function recoverInbound() {
  const r = await pool.query(
    `UPDATE inbound_messages SET attempts = attempts + 1, updated_at = NOW()
     WHERE msg_id IN (
       SELECT msg_id FROM inbound_messages
       WHERE status IN ('new','batched') AND received_at > NOW() - INTERVAL '20 minutes' AND attempts < 3
       ORDER BY received_at FOR UPDATE SKIP LOCKED
     ) RETURNING msg_id, phone_key, payload, received_at`
  );
  if (r.rowCount)
    log("info", "replaying unfinished messages", { count: r.rowCount });
  await replayRows(r.rows);
}

async function housekeeping() {
  try {
    await pool.query(
      "UPDATE inbound_messages SET status = 'expired' WHERE status IN ('new','batched') AND received_at < NOW() - INTERVAL '30 minutes'"
    );
    await pool.query(
      "DELETE FROM inbound_messages WHERE received_at < NOW() - INTERVAL '7 days'"
    );
    await pool.query(
      "DELETE FROM broker_search_state WHERE updated_at < NOW() - INTERVAL '2 days'"
    );
    await pool.query(
      "DELETE FROM processed_batches WHERE created_at < NOW() - INTERVAL '30 days'"
    );
  } catch (e) {
    log("warn", "housekeeping failed", errMeta(e));
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentBrokerListings)
    if (now - v.at > 300000) recentBrokerListings.delete(k);
  for (const [k, v] of brokerCache) if (v.exp < now) brokerCache.delete(k);
  for (const [k, v] of agencyCache) if (v.exp < now) agencyCache.delete(k);
  for (const [k, v] of unknownNotified) if (v < now) unknownNotified.delete(k);
  for (const [k, v] of lastTouch) if (v < now - 600000) lastTouch.delete(k);
  for (const [k, v] of cooldowns) if (v < now) cooldowns.delete(k);
}, 60000).unref();
setInterval(housekeeping, 3600000).unref();

/* ====================================================================== */
/* HTTP                                                                     */
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
  if (!secret) return !CFG.isProd; // dev convenience only; production refuses to boot without the secret
  const sig = req.get("x-hub-signature-256") || "";
  if (!sig.startsWith("sha256=") || !req.rawBody) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("hex");
  const got = sig.slice(7);
  return (
    got.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))
  );
}

app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);
  let fresh;
  try {
    fresh = await persistIncoming(req.body);
  } catch (err) {
    log("error", "persisting webhook failed", errMeta(err));
    return res.sendStatus(500); // Meta will retry; nothing was lost
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
  )
    return res.status(200).send(req.query["hub.challenge"]);
  return res.sendStatus(403);
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      database: "connected",
      queue: listingLimiter.stats(),
      openBatches: incomingBatches.size,
      inFlight
    });
  } catch (err) {
    res
      .status(500)
      .json({ status: "error", database: "disconnected", error: err.message });
  }
});

app.get("/", (req, res) =>
  res.status(200).send("Real Estate WhatsApp Engine is active.")
);

/* ====================================================================== */
/* Process lifecycle                                                        */
/* ====================================================================== */
process.on("unhandledRejection", (r) =>
  log("error", "unhandledRejection", { err: String((r && r.message) || r) })
);
process.on("uncaughtException", (e) => {
  log("error", "uncaughtException", errMeta(e));
  setTimeout(() => process.exit(1), 500).unref();
});

let server;
async function shutdown(sig) {
  log("info", "shutting down", { sig });
  if (server) server.close();
  const until = Date.now() + 25000;
  while (
    (inFlight > 0 || perBroker.size() > 0 || brokerWork.size() > 0) &&
    Date.now() < until
  )
    await U.sleep(300);
  // anything still in an open batch stays 'batched' in inbound_messages and is replayed on next boot
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (require.main === module) {
  server = app.listen(CFG.port, () => {
    log("info", `Real Estate WhatsApp Engine online on port ${CFG.port}`);
    recoverInbound().catch((e) => log("error", "recovery failed", errMeta(e)));
    housekeeping();
  });
}

module.exports = { app };
