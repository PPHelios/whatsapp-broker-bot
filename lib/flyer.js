// lib/flyer.js — Property flyer generator (100% English, LTR, auto height, dark + light themes)
//
// Inputs   : listing (+details), agency (name, logo_url, primary_color, secondary_color, phone),
//            broker (name, contact_phone / phone_normalized), 1-9 photos, theme "dark" | "light".
// Deal kinds (domain/fieldRules.js paymentCase): primary | resale (with installments) | cash | rent.
// Rules    : never invent data (hide what is missing) and never print Arabic text.
//
// The pieces live in lib/flyerStyle.js (constants, colours, text), lib/flyerAssets.js (fonts, safe fetch, logo),
// lib/flyerModel.js (data model) and lib/flyerLayout.js (element tree); this file renders and sends.
"use strict";

const sharp = require("sharp");
const crypto = require("crypto");
const path = require("path");
const { Worker } = require("worker_threads");
const U = require("./util");
const { getConfig } = require("../config");
const Store = require("./listingStore");
const { ensureListingImagesCurated } = require("./vision");
const WA = require("./whatsapp");
const Supabase = require("./supabase");
const { reply, replyImage } = require("./dispatcher");
const { t } = require("./copy");
const { FLYER_VERSION, MIN_H, MAX_H, MAX_PHOTOS, contrast, ensureContrast, makeTheme, hasArabic, en, truncate, titleCase, abbr, formatFloor, formatPhone } = require("./flyerStyle");
const { loadFont, fetchBuf, prepareLogo, logoSlot, fitInto } = require("./flyerAssets");
const { buildFlyerModel } = require("./flyerModel");
const { ROWS_FOR, photoLayout, buildTree, svgHeight, PASS_LEVELS, renderPass } = require("./flyerLayout");

/* ====================================================================== */
/* 7. Public renderer: assets on the main thread, rendering in a worker      */
/* ====================================================================== */

let fontsPromise = null;
function flyerFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([loadFont("Cairo-Bold.ttf"), loadFont("Cairo-Regular.ttf")]).then(([bold, regular]) => [
      { name: "Cairo", data: regular, weight: 400, style: "normal" },
      { name: "Cairo", data: bold, weight: 700, style: "normal" }
    ]);
  }
  return fontsPromise;
}

/** Downloads photos and the logo (network I/O; stays on the main thread). */
async function fetchFlyerAssets({ images = [], logoUrl = null }) {
  const urls = (images || []).filter(Boolean).slice(0, MAX_PHOTOS);
  const [fetched, logoBuf] = await Promise.all([Promise.all(urls.map((u) => fetchBuf(u))), logoUrl ? fetchBuf(logoUrl) : null]);
  return { bufs: fetched.filter(Boolean), logoBuf: logoBuf || null };
}

/**
 * CPU-only render of a prepared model + image buffers to a JPEG (runs inside the worker).
 * @param {Object} p - { model, theme, primary, secondary, bufs: Buffer[], logoBuf: Buffer|null, format }
 */
async function renderFlyerImage({ model, theme = "dark", primary, secondary, bufs = [], logoBuf = null, format = "jpeg" }) {
  const fonts = await flyerFonts();
  const T = makeTheme(theme, primary, secondary);
  const photoBufs = bufs.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)));
  const logo = logoBuf && !model.unbranded ? await prepareLogo(Buffer.isBuffer(logoBuf) ? logoBuf : Buffer.from(logoBuf)) : null;

  let opts = PASS_LEVELS[0];
  let res = await renderPass(model, T, photoBufs, logo, opts, fonts);
  if (res.height > 0 && res.height < MIN_H) {
    const deficit = MIN_H - res.height;
    const grow = photoBufs.length ? Math.min(deficit, 520) : 0;
    opts = { ...opts, heroExtra: grow, extraPad: deficit - grow };
    res = await renderPass(model, T, photoBufs, logo, opts, fonts);
  } else {
    for (let i = 1; i < PASS_LEVELS.length && res.height > MAX_H; i++) {
      opts = PASS_LEVELS[i];
      res = await renderPass(model, T, photoBufs, logo, opts, fonts);
    }
  }
  const img = sharp(Buffer.from(res.svg));
  return format === "png" ? img.png().toBuffer() : img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

/* ---- worker pool (one worker, bounded queue) ---- */
let worker = null;
let jobSeq = 0;
const jobs = new Map();
const renderLimiter = U.createLimiter(1, { maxQueue: getConfig().flyer.maxQueue });

function failAll(err) {
  for (const { reject, timer } of jobs.values()) {
    clearTimeout(timer);
    reject(err);
  }
  jobs.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, "flyerWorker.js"));
  worker.on("message", ({ id, ok, data, error, rss }) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    clearTimeout(job.timer);
    if (ok) job.resolve({ buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength), rss });
    else job.reject(new Error(error || "flyer worker failed"));
  });
  worker.on("error", (err) => {
    failAll(err);
    worker = null;
  });
  worker.on("exit", () => {
    failAll(new Error("flyer worker exited"));
    worker = null;
  });
  worker.unref();
  return worker;
}

/** Renders in the worker thread, one job at a time; QUEUE_FULL when too many wait. */
function renderOffThread(payload) {
  const { timeoutMs } = getConfig().flyer;
  return renderLimiter(
    () =>
      new Promise((resolve, reject) => {
        const id = ++jobSeq;
        const timer = setTimeout(() => {
          jobs.delete(id);
          reject(new Error("flyer render timeout"));
          if (worker) worker.terminate().catch(() => {});
        }, timeoutMs);
        jobs.set(id, { resolve, reject, timer });
        getWorker().postMessage({ id, payload });
      })
  );
}

/** Stops the render worker (graceful shutdown, tests). */
async function stopFlyerWorker() {
  if (worker) await worker.terminate().catch(() => {});
  worker = null;
}

/**
 * Listing → JPEG buffer. Photos are fetched here; rendering runs in the worker unless disabled
 * (config.flyer.worker, off under tests) or { inline: true }.
 */
async function generateFlyerBuffer({ listing, agency = {}, broker = {}, images = [], theme = "dark", unbranded = false, inline = null, format = "jpeg" }) {
  const model = buildFlyerModel({ listing, agency, broker, theme, unbranded });
  const { bufs, logoBuf } = await fetchFlyerAssets({ images, logoUrl: model.brand.logoUrl && !model.unbranded ? model.brand.logoUrl : null });
  const payload = { model, theme, primary: agency.primary_color, secondary: agency.secondary_color, bufs, logoBuf, format };
  const useWorker = inline === null ? getConfig().flyer.worker : !inline;
  if (!useWorker) return renderFlyerImage(payload);
  return (await renderOffThread(payload)).buffer;
}

/* ====================================================================== */
/* 8. End-to-end orchestrator (cache -> lazy vision -> render -> send)      */
/* ====================================================================== */
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

/** The cache key changes whenever the flyer would look different (theme, brand, contact, listing data). */
function flyerCacheKey({ theme, listing, agency, broker, unbranded }) {
  const sig = JSON.stringify([
    FLYER_VERSION,
    theme,
    Boolean(unbranded),
    broker.id,
    broker.name,
    broker.contact_phone,
    broker.phone_normalized,
    broker.phone_number,
    agency.name,
    agency.logo_url,
    agency.primary_color,
    agency.secondary_color,
    agency.phone,
    listing.code,
    listing.price_value,
    listing.total_price,
    listing.property_type,
    listing.listing_type,
    listing.bedrooms,
    listing.area_value,
    listing.compound,
    listing.compound_en,
    listing.district,
    listing.location,
    listing.payment_terms,
    listing.delivery_date,
    listing.details
  ]);
  return `${theme}_${FLYER_VERSION}_${sha1(sig).slice(0, 12)}`;
}

/**
 * DEL-01: the one flyer pipeline (text command and button). One message: the image with its caption.
 * Cache → lazy vision curation → render (worker) → upload → send. Failures reply with an error.
 */
async function renderFlyerOnDemand(broker, code, _flyerLang = "en", theme = "dark", ctx = {}) {
  require("./dispatcher").setTurnAction("flyer");
  const { pool, lang } = ctx;
  const t0 = Date.now();
  const listing = await Store.findByCode(pool, broker.agency_id, code);
  if (!listing) {
    await reply(broker, lang === "en" ? `🔍 Unit #${code} was not found.` : `🔍 الوحدة #${code} غير موجودة.`);
    return "done";
  }
  const { rows: agencyRows } = await pool.query("SELECT * FROM agencies WHERE id = $1", [broker.agency_id]);
  const agency = agencyRows[0] || {};
  const unbranded = Boolean(ctx.unbranded || listing.is_unbranded);
  theme = theme === "light" ? "light" : "dark";

  const model = buildFlyerModel({ listing, agency, broker, theme, unbranded });
  const caption = [model.title, `Ref ${listing.code}`, model.brand.name].filter(Boolean).join("\n");

  const cacheKey = flyerCacheKey({ theme, listing, agency, broker, unbranded });
  const cachedFlyerUrl = listing.flyer_cache?.[cacheKey];
  if (cachedFlyerUrl && (await replyImage(broker, cachedFlyerUrl, caption))) return "done";

  // Curation and rendering take a while: a "designing" line first on Telegram (lib/dispatcher.js withProgress).
  return require("./dispatcher").withProgress(broker, t("flyer_working", lang), () =>
    renderAndSend(broker, ctx, { listing, agency, theme, unbranded, model, caption, cacheKey, t0 }),
    { whatsapp: false } // a flyer on WhatsApp stays one message (the image)
  );
}

/** Curates the photos, renders the flyer and sends it (cached by cacheKey). */
async function renderAndSend(broker, ctx, { listing, agency, theme, unbranded, model, caption, cacheKey, t0 }) {
  const { pool, lang } = ctx;
  // Lazy vision curation (roles + best-first order); screenshots/documents never go on a flyer.
  let list = [];
  try {
    const curated = await ensureListingImagesCurated(listing.id, { ...ctx, broker });
    list = Array.isArray(curated) ? curated : [];
  } catch (err) {
    console.warn("[FLYER] Vision curation skipped:", err.message);
    const { rows } = await pool.query("SELECT id, url, role FROM listing_images WHERE listing_id = $1 ORDER BY position", [listing.id]);
    list = rows;
  }
  const photosOnly = list.filter((i) => i && i.role !== "document");
  const imageUrls = (photosOnly.length ? photosOnly : list).map((i) => i && i.url).filter(Boolean);

  let jpegBuffer = null;
  const r0 = Date.now();
  try {
    jpegBuffer = await generateFlyerBuffer({ listing, agency, broker, images: imageUrls, theme, unbranded });
  } catch (err) {
    console.error("[FLYER] Rendering failed:", err.message);
    await reply(
      broker,
      err.code === "QUEUE_FULL"
        ? lang === "en"
          ? "⏳ Many flyers are being prepared right now. Please try again in a minute."
          : "⏳ في كتالوجات كتير بتتجهز دلوقتي. حاول تاني بعد دقيقة."
        : lang === "en"
        ? "❌ Could not render the flyer right now. Please try again later."
        : "❌ تعذر تصميم الكتالوج حالياً. يرجى المحاولة لاحقاً."
    );
    return "done";
  }
  const renderMs = Date.now() - r0;

  let publicUrl = "";
  try {
    publicUrl = await Supabase.uploadFlyerImage(broker.agency_id, `flyers/${broker.agency_id}/${listing.code}_${theme}_${Date.now()}.jpg`, jpegBuffer);
  } catch (uploadErr) {
    console.error("[FLYER] Flyer upload failure:", uploadErr.message);
  }
  if (publicUrl) {
    // Keep the newest few flyers only.
    const prev = Object.entries(listing.flyer_cache || {}).filter(([k, v]) => typeof v === "string" && k !== "updated_at");
    const updatedCache = { ...Object.fromEntries(prev.slice(-5)), [cacheKey]: publicUrl, updated_at: new Date().toISOString() };
    await pool.query("UPDATE listings SET flyer_cache = $1 WHERE id = $2", [updatedCache, listing.id]);
  }

  // Prefer the stored URL; fall back to a direct WhatsApp upload when storage failed.
  const media = publicUrl || (await WA.uploadWhatsAppMedia(jpegBuffer, { mimeType: "image/jpeg" }));
  const sent = media ? await replyImage(broker, media, caption) : null;
  if (!sent) {
    await reply(broker, lang === "en" ? "❌ Failed to deliver the flyer to WhatsApp." : "❌ تعذر إرسال الكتالوج عبر واتساب.");
  }
  pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, total_duration_ms, flyer_render_ms, metadata, created_at)
       VALUES ($1, $2, $3, 'flyer_render', $4, $5, $6, $7::jsonb, NOW())`,
      [broker.agency_id, broker.id, listing.code, sent ? "success" : "failed", Date.now() - t0, renderMs,
        JSON.stringify({ theme, unbranded, photos: imageUrls.length, rss_mb: Math.round(process.memoryUsage().rss / 1048576) })]
    )
    .catch(() => {});
  return "done";
}

module.exports = {
  generateFlyerBuffer,
  renderFlyerImage,
  fetchFlyerAssets,
  renderOffThread,
  stopFlyerWorker,
  renderFlyerOnDemand,
  loadFont,
  buildFlyerModel,
  makeTheme,
  photoLayout,
  flyerCacheKey,
  __test: {
    en,
    hasArabic,
    formatPhone,
    formatFloor,
    abbr,
    titleCase,
    truncate,
    ensureContrast,
    contrast,
    logoSlot,
    fitInto,
    buildTree,
    svgHeight,
    ROWS_FOR
  }
};
