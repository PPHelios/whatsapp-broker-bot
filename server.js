// server.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");
const sharp = require("sharp");
const mediaCache = new Map();
const pendingQueues = new Map();
const PAGE_SIZE = 10;
const SEARCH_SESSION_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const PAGINATION_DEBOUNCE_MS = 2000; // 2 seconds
function cleanAudioMime(mime = "") {
  return (
    String(mime || "audio/ogg")
      .split(";")[0]
      .trim()
      .toLowerCase() || "audio/ogg"
  );
}

const T = require("./lib/text");
const R = require("./lib/render");
const S = require("./lib/search");

// ---------------------------------------------------------------------------
// 1. Boot Environment Guard: Require APP_SECRET unless local bypass is explicit
// ---------------------------------------------------------------------------
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === "true";
const APP_SECRET = process.env.APP_SECRET;

if (!APP_SECRET && !ALLOW_UNSIGNED) {
  console.error("🚨 [FATAL] Server cannot start: APP_SECRET is missing.");
  console.error(
    "👉 Set APP_SECRET in your .env or set ALLOW_UNSIGNED_WEBHOOKS=true for local testing only."
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || "media";
const MAX_VISION_IMAGES = 15;
const CODE_WAITING_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ [DATABASE] Pool connection error:", err.message);
  } else {
    release();
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "placeholder"
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// ---------------------------------------------------------------------------
// Utility & Schema Helpers
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Dynamic Processing Duration Cache (Zero DB load on webhooks)
// ---------------------------------------------------------------------------
let cachedAvgSecs = 55; // Safe realistic default

async function refreshAvgDuration() {
  try {
    const res = await pool.query(`
      SELECT ROUND(AVG(duration_ms) / 1000) AS avg_secs
      FROM usage_events
      WHERE event_type = 'create'
        AND duration_ms BETWEEN 5000 AND 180000
        AND created_at > NOW() - INTERVAL '7 days'
    `);
    const val = Number(res.rows[0]?.avg_secs);
    if (val && val >= 20 && val <= 150) {
      cachedAvgSecs = Math.round(val / 5) * 5; // Round to nearest 5s
    }
  } catch (err) {
    console.error(
      "⚠️ [METRICS CACHE] Could not refresh avg duration:",
      err.message
    );
  }
}

// Warm cache at startup, then refresh hourly
refreshAvgDuration();
setInterval(refreshAvgDuration, 60 * 60 * 1000);

function getFormattedWaitTime() {
  if (cachedAvgSecs >= 50 && cachedAvgSecs <= 70) {
    return "دقيقة واحدة تقريباً";
  }
  return `حوالي ${cachedAvgSecs} ثانية`;
}
function cleanAudioMime(mime = "") {
  return (
    String(mime || "audio/ogg")
      .split(";")[0]
      .trim()
      .toLowerCase() || "audio/ogg"
  );
}

function normalizeDigits(value = "") {
  return T.toEnDigits(value);
}

function normalizeCode(raw = "") {
  const s = normalizeDigits(String(raw || ""))
    .trim()
    .replace(/^#/, "")
    .replace(/\s+/g, "")
    .toUpperCase();
  return s || "";
}

async function computeDHash64(buffer) {
  try {
    const rawPixels = await sharp(buffer)
      .grayscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer();

    let hash = "";
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = rawPixels[row * 9 + col];
        const right = rawPixels[row * 9 + col + 1];
        hash += left < right ? "1" : "0";
      }
    }
    return hash;
  } catch (_) {
    return "0".repeat(64);
  }
}

async function logUsageEvent({
  agencyId = null,
  brokerId = null,
  phone = null,
  eventType,
  listingId = null,
  durationMs = null,
  costUsd = 0,
  tokensInput = 0,
  tokensOutput = 0,
  meta = {}
}) {
  const safeDuration = Number.isFinite(Number(durationMs))
    ? Math.round(Number(durationMs))
    : null;
  const safeCost = Number.isFinite(Number(costUsd)) ? Number(costUsd) : 0;
  const safeIn = Number.isFinite(Number(tokensInput))
    ? Math.round(Number(tokensInput))
    : 0;
  const safeOut = Number.isFinite(Number(tokensOutput))
    ? Math.round(Number(tokensOutput))
    : 0;

  try {
    await pool.query(
      `INSERT INTO usage_events (
        agency_id, broker_id, phone, event_type, listing_id,
        duration_ms, cost_usd, tokens_input, tokens_output, meta
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        agencyId || null,
        brokerId || null,
        phone ? String(phone) : null,
        String(eventType || "unknown"),
        listingId || null,
        safeDuration,
        safeCost,
        safeIn,
        safeOut,
        JSON.stringify(meta || {})
      ]
    );
  } catch (err) {
    console.error(
      `❌ [USAGE_EVENTS] Failed to log "${eventType}":`,
      err.message
    );
  }
}

async function upsertSession(phone, state, listingId = null, data = {}) {
  try {
    await pool.query(
      `INSERT INTO sessions (phone, state, listing_id, data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE
       SET state = EXCLUDED.state,
           listing_id = COALESCE(EXCLUDED.listing_id, sessions.listing_id),
           data = EXCLUDED.data,
           updated_at = NOW()`,
      [phone, state, listingId, JSON.stringify(data || {})]
    );
  } catch (err) {
    console.error("⚠️ [SESSIONS] Failed to update session:", err.message);
  }
}

function buildSearchText(data = {}, rawText = "", code = "") {
  const parts = [
    code,
    data.title,
    data.property_type,
    T.translatePropertyType(data.property_type),
    data.listing_type === "rent" ? "ايجار إيجار rent" : "بيع تمليك sale",
    data.location,
    data.location_name,
    data.compound,
    data.district,
    data.city,
    Array.isArray(data.location_keywords)
      ? data.location_keywords.join(" ")
      : "",
    data.price_display,
    data.area_value ? `${data.area_value} متر م2` : "",
    data.bedrooms ? `${data.bedrooms} غرف نوم` : "",
    Array.isArray(data.features) ? data.features.join(" ") : "",
    rawText
  ];
  return T.normalizeAr(parts.filter(Boolean).join(" "));
}

// ---------------------------------------------------------------------------
// WhatsApp Graph API Helpers
// ---------------------------------------------------------------------------
async function downloadWhatsAppMedia(mediaId) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });

    if (!metaRes.ok) {
      const errBody = await metaRes.json().catch(() => ({}));
      console.error("❌ [MEDIA] Meta lookup failed:", errBody);
      return null;
    }

    const { url, mime_type } = await metaRes.json();
    const mediaRes = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });

    if (!mediaRes.ok) {
      console.error("❌ [MEDIA] Payload download failed for media:", mediaId);
      return null;
    }

    const rawBuffer = Buffer.from(await mediaRes.arrayBuffer());

    if ((mime_type || "").startsWith("image/")) {
      const optimizedBuffer = await sharp(rawBuffer)
        .rotate()
        .resize({
          width: 1200,
          height: 1200,
          fit: "inside",
          withoutEnlargement: true
        })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();

      return {
        mediaId,
        buffer: optimizedBuffer,
        mimeType: "image/jpeg"
      };
    }

    return {
      mediaId,
      buffer: rawBuffer,
      mimeType: cleanAudioMime(mime_type)
    };
  } catch (err) {
    console.error("❌ [MEDIA] Download error:", err.message);
    return null;
  }
}

async function sendWhatsAppText(to, text) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text }
        })
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("❌ [WHATSAPP OUTBOUND] Failed:", JSON.stringify(errBody));
      return false;
    }

    return true;
  } catch (err) {
    console.error("❌ [WHATSAPP OUTBOUND] Network error:", err.message);
    return false;
  }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "image",
          image: {
            link: imageUrl,
            caption: caption || ""
          }
        })
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error("❌ [WHATSAPP IMAGE] Failed:", JSON.stringify(errBody));
      return false;
    }

    return true;
  } catch (err) {
    console.error("❌ [WHATSAPP IMAGE] Network error:", err.message);
    return false;
  }
}

async function generateAndUploadFlyer({ broker, listing, imageSources = [] }) {
  const startMs = Date.now();

  // 1. Initialize all display variables first
  const typeAr = T.translatePropertyType(listing.property_type);
  const displayTitle =
    listing.title ||
    (listing.location ? `${typeAr} في ${listing.location}` : typeAr);

  const priceDisplay =
    listing.price_display ||
    (listing.price_value ? T.formatPrice(listing.price_value) : "عند الطلب");

  const downPaymentDisplay = listing.down_payment_value
    ? T.formatPrice(listing.down_payment_value)
    : null;

  // 2. Call the renderer after variables are initialized
  const renderFn = R.renderFlyerJpeg || R.renderFlyerPng || R.renderFlyerSatori;
  const jpegBuffer = await renderFn({
    agencyName: broker.agency_name,
    brandColor: broker.brand_color,
    accentColor: broker.accent_color,
    logoUrl: broker.logo_url,
    code: listing.code,
    title: displayTitle,
    priceDisplay,
    area: listing.area_value ? `${listing.area_value} م²` : null,
    bedrooms: listing.bedrooms ? `${listing.bedrooms} غرف` : null,
    location: listing.location || listing.location_name || "القاهرة",
    brokerPhone: broker.contact_phone || broker.phone,
    features: Array.isArray(listing.features) ? listing.features : [],
    images: imageSources,
    downPayment: downPaymentDisplay,
    installmentYears: listing.installment_years || null
  });

  // 3. Upload to Supabase Storage
  const storagePath = `${broker.agency_id}/${listing.id}/flyer.jpg`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, jpegBuffer, {
      contentType: "image/jpeg",
      upsert: true
    });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const flyerPublicUrl = urlData.publicUrl;

  await pool.query(
    "UPDATE listings SET flyer_url = $1, updated_at = NOW() WHERE id = $2",
    [flyerPublicUrl, listing.id]
  );

  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: broker.phone,
    eventType: "brochure",
    listingId: listing.id,
    durationMs: Date.now() - startMs
  });

  return flyerPublicUrl;
}

// ---------------------------------------------------------------------------
// Webhook Signature Middleware
// ---------------------------------------------------------------------------
function verifyMetaSignature(req, res, next) {
  if (ALLOW_UNSIGNED && !APP_SECRET) {
    return next();
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn(
      "⚠️ [SECURITY] Rejected webhook: Missing x-hub-signature-256 header."
    );
    return res.status(401).send("Missing signature");
  }

  const signatureHash = signature.split("=")[1];
  const expectedHash = crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody || "")
    .digest("hex");

  if (signatureHash !== expectedHash) {
    console.warn("⚠️ [SECURITY] Rejected webhook: Invalid HMAC signature.");
    return res.status(403).send("Invalid signature");
  }

  next();
}

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);

  const body = req.body || {};
  if (body.object !== "whatsapp_business_account") return;

  const value = body.entry?.[0]?.changes?.[0]?.value;
  if (value?.statuses && value.statuses.length > 0) return;

  const messages = value?.messages;
  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    await handleIncomingWhatsAppMessage(msg);
  }
});

async function handleIncomingWhatsAppMessage(msg) {
  const from = String(msg.from || "").replace(/\D/g, "");
  const messageId = msg.id;

  try {
    const dedup = await pool.query(
      "INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id",
      [messageId]
    );

    if (dedup.rowCount === 0) return;
  } catch (err) {
    console.error("❌ [DEDUP] Query failed:", err.message);
  }

  let broker;
  try {
    const bRes = await pool.query(
      `SELECT b.*, a.name as agency_name, a.brand_color, a.accent_color, a.logo_url
       FROM brokers b
       JOIN agencies a ON a.id = b.agency_id
       WHERE regexp_replace(b.phone, '\\D', '', 'g') = $1 AND b.is_active = true`,
      [from]
    );

    if (bRes.rowCount === 0) {
      await logUsageEvent({ phone: from, eventType: "unregistered" });
      await sendWhatsAppText(
        from,
        "⚠️ هذا الرقم غير مسجل في النظام. تواصل مع مدير الوكالة للتفعيل."
      );
      return;
    }

    broker = bRes.rows[0];
  } catch (err) {
    console.error("❌ [AUTH] Broker lookup error:", err.message);
    return;
  }

  // -------------------------------------------------------------------------
  // Check for Pending 10-Minute Waiting Code Session
  // -------------------------------------------------------------------------
  const sRes = await pool.query("SELECT * FROM sessions WHERE phone = $1", [
    from
  ]);
  if (sRes.rowCount > 0 && sRes.rows[0].state === "waiting_code") {
    const session = sRes.rows[0];
    const elapsed = Date.now() - new Date(session.updated_at).getTime();

    if (elapsed > CODE_WAITING_WINDOW_MS) {
      await pool.query("DELETE FROM sessions WHERE phone = $1", [from]);
      await sendWhatsAppText(
        from,
        "⏳ انتهت مهلة الـ 10 دقائق لتعديل الكود وتم إلغاء حفظ الإعلان."
      );
    } else if (msg.type === "text") {
      const candidateCode = normalizeCode(msg.text?.body || "");
      const isPureCode =
        /^[A-Z0-9_-]{2,20}$/i.test(candidateCode) && /\d/.test(candidateCode);

      if (isPureCode) {
        const dupCheck = await pool.query(
          "SELECT id FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)",
          [broker.agency_id, candidateCode]
        );

        if (dupCheck.rowCount > 0) {
          return sendWhatsAppText(
            from,
            `⚠️ الكود *#${candidateCode}* مستخدم أيضاً! أرسل كود آخر متاح:`
          );
        }

        await pool.query("DELETE FROM sessions WHERE phone = $1", [from]);
        await sendWhatsAppText(
          from,
          `⏳ جاري حفظ العقار بالكود الجديد *#${candidateCode}*...`
        );
        return finalizeListingCreation({
          broker,
          from,
          draftData: session.data.draftData,
          listingCode: candidateCode,
          rankedImages: session.data.rankedImages
        });
      } else {
        await pool.query("DELETE FROM sessions WHERE phone = $1", [from]);
        await sendWhatsAppText(from, "❌ تم إلغاء حفظ الإعلان السابق.");
      }
    } else {
      await pool.query("DELETE FROM sessions WHERE phone = $1", [from]);
      await sendWhatsAppText(
        from,
        "❌ تم إلغاء حفظ الإعلان السابق لبدء رسالة جديدة."
      );
    }
  }

  if (msg.type === "text" && !pendingQueues.has(from)) {
    const textBody = (msg.text?.body || "").trim();
    const command = T.parseCommand(textBody);
    if (command) {
      return handleCommand(command, broker, from);
    }
  }

  enqueueIncomingMessage(from, msg, broker);
}

// ---------------------------------------------------------------------------
// Batching & Listing Processing Pipeline
// ---------------------------------------------------------------------------
function enqueueIncomingMessage(from, msg, broker) {
  const debounceDelay = parseInt(process.env.DEBOUNCE_MS, 10) || 8000;

  if (!pendingQueues.has(from)) {
    pendingQueues.set(from, { items: [], timer: null, broker });
    upsertSession(from, "collecting", null, {
      startedAt: new Date().toISOString()
    });
  }

  const queue = pendingQueues.get(from);
  queue.items.push(msg);

  if (queue.timer) clearTimeout(queue.timer);

  queue.timer = setTimeout(async () => {
    const target = pendingQueues.get(from);
    pendingQueues.delete(from);

    if (target && target.items.length > 0) {
      try {
        await processBatchedListing(from, target.items, target.broker);
      } catch (err) {
        console.error("💥 [DEBOUNCE RUNTIME ERROR]:", err);
        await logUsageEvent({
          agencyId: target.broker?.agency_id,
          brokerId: target.broker?.id,
          phone: from,
          eventType: "error",
          meta: { message: err.message }
        });
        // Generic error message for broker, details logged internally only
        await sendWhatsAppText(
          from,
          "⚠️ حدث خطأ فني أثناء المعالجة. يرجى إعادة المحاولة لاحقاً."
        ).catch(() => {});
      }
    }
  }, debounceDelay);
}

async function processBatchedListing(broker, batch) {
  const from = batch.from;
  const startMs = Date.now();
  const images = batch.images || [];
  const audios = batch.audios || [];
  const textBody = (batch.texts || []).join("\n").trim();

  // -------------------------------------------------------------------------
  // Edge Case 1: Images Only (Zero Text, Zero Audio)
  // -------------------------------------------------------------------------
  if (!textBody && audios.length === 0 && images.length > 0) {
    // Check if the broker created a listing in the last 5 minutes (Late Images)
    const recentRes = await pool.query(
      `SELECT id, code, flyer_url FROM listings
       WHERE broker_id = $1 AND created_at > NOW() - INTERVAL '5 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [broker.id]
    );

    if (recentRes.rowCount > 0) {
      const recent = recentRes.rows[0];
      await sendWhatsAppText(
        from,
        `📸 جاري إلحاق الصور الجديدة بالعقار رقم *#${recent.code}*...`
      );

      // Upload and append images
      for (let i = 0; i < images.length; i++) {
        const imgUrl = await uploadListingImage(
          broker.agency_id,
          recent.id,
          images[i].buffer
        );
        if (imgUrl) {
          await pool.query(
            `INSERT INTO listing_images (listing_id, url, position)
             VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM listing_images WHERE listing_id = $1))`,
            [recent.id, imgUrl]
          );
        }
      }

      // Re-render flyer with updated photos
      const allImgsRes = await pool.query(
        "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 9",
        [recent.id]
      );
      const flyerUrl = await generateAndUploadFlyer({
        broker,
        listing: recent,
        imageSources: allImgsRes.rows.map((r) => r.url)
      });

      return sendWhatsAppImage(
        from,
        `${flyerUrl}?t=${Date.now()}`,
        `✅ تم تحديث كتالوج العقار *#${recent.code}* بالصور الجديدة.`
      );
    }

    // No recent listing found -> Reject orphan image batch
    return sendWhatsAppText(
      from,
      "⚠️ *تم استلام الصور بدون أي تفاصيل أو تسجيل صوتي.*\n\nيرجى إرسال مواصفات الوحدة (السعر، المساحة، الموقع) في رسالة نصية أو تسجيل صوتي ليتم تسجيلها."
    );
  }

  // -------------------------------------------------------------------------
  // Edge Case 2: Text / Audio Only (No Images)
  // -------------------------------------------------------------------------
  if (images.length === 0 && (textBody || audios.length > 0)) {
    await sendWhatsAppText(from, "⏳ جاري مراجعة وحفظ بيانات الوحدة...");

    const { draftData, usage } = await extractListingDetailsWithAi({
      text: textBody,
      audios,
      images: []
    });

    const listing = await insertListingToDatabase({
      broker,
      draftData,
      flyerUrl: null // No flyer generated
    });

    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: "create",
      listingId: listing.id,
      durationMs: Date.now() - startMs,
      meta: { imageCount: 0, hasFlyer: false }
    });

    const summaryText = draftData.clean_summary
      ? `\n\n📝 *التفاصيل:*\n${draftData.clean_summary}`
      : "";
    const confirmationText = [
      `✅ *تم تسجيل بيانات العقار بنجاح برمز: #${listing.code}*`,
      `• الوحدة: ${listing.title || "-"}`,
      `• السعر: *${listing.price_display || "عند الطلب"}*`,
      `• المساحة: ${
        listing.area_value ? `${listing.area_value} م²` : "-"
      } | الغرف: ${listing.bedrooms || "-"}`,
      `• الموقع: ${listing.location || "-"}${summaryText}`,
      "",
      "💡 *ملحوظة:* تم حفظ الوحدة بدون صور. لإصدار كتالوج بتصميم احترافي، أرسل صور العقار مرفقة بالكود في أي وقت (مثال: أرسل الصور واكتب في التعليق: *#" +
        listing.code +
        "*)."
    ].join("\n");

    return sendWhatsAppText(from, confirmationText);
  }

  // -------------------------------------------------------------------------
  // Standard Case: Text/Audio + Images (Full Flyer Pipeline)
  // -------------------------------------------------------------------------
  const waitDuration = getFormattedWaitTime();
  await sendWhatsAppText(
    from,
    `⏳ *جاري استخراج البيانات وتصميم الكتالوج...*\n⏱️ يستغرق التجهيز ${waitDuration}.\n\n⚠️ *تنبيه:* يرجى الانتظار حتى استلام الكتالوج قبل إرسال عقار جديد أو إجراء بحث لتجنب تداخل البيانات.`
  );

  // 1. Process Gemini Multimodal Extraction
  const { draftData, usage } = await extractListingDetailsWithAi({
    text: textBody,
    audios,
    images
  });

  // 2. Upload Compressed Images
  const uploadedUrls = [];
  for (let i = 0; i < images.length; i++) {
    const url = await uploadListingImage(
      broker.agency_id,
      null,
      images[i].buffer
    );
    if (url) uploadedUrls.push(url);
  }

  // 3. Insert Listing Record
  const listing = await insertListingToDatabase({
    broker,
    draftData,
    flyerUrl: null
  });

  // Save image references
  for (let pos = 0; pos < uploadedUrls.length; pos++) {
    await pool.query(
      "INSERT INTO listing_images (listing_id, url, position) VALUES ($1, $2, $3)",
      [listing.id, uploadedUrls[pos], pos]
    );
  }

  // 4. Render Flyer via Satori
  let flyerUrl = null;
  try {
    flyerUrl = await generateAndUploadFlyer({
      broker,
      listing,
      imageSources: uploadedUrls
    });

    await pool.query("UPDATE listings SET flyer_url = $1 WHERE id = $2", [
      flyerUrl,
      listing.id
    ]);
  } catch (err) {
    console.error("❌ [FLYER RENDER ERROR]:", err.message);
  }

  // 5. Log Metrics
  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: from,
    eventType: "create",
    listingId: listing.id,
    durationMs: Date.now() - startMs,
    meta: { imageCount: uploadedUrls.length, hasFlyer: Boolean(flyerUrl) }
  });

  // 6. Send Response
  const summaryText = draftData.clean_summary
    ? `\n\n📝 *التفاصيل:*\n${draftData.clean_summary}`
    : "";
  const flyerCaption = [
    `✅ *تم اعتماد العقار برمز: #${listing.code}*`,
    `• الوحدة: ${listing.title || "-"}`,
    `• السعر: *${listing.price_display || "عند الطلب"}*`,
    `• المساحة: ${
      listing.area_value ? `${listing.area_value} م²` : "-"
    } | الغرف: ${listing.bedrooms || "-"}`,
    `• الموقع: ${listing.location || "-"}`,
    `📸 تم اعتماد الكتالوج بـ (${uploadedUrls.length}) صور.${summaryText}`
  ].join("\n");

  if (flyerUrl) {
    return sendWhatsAppImage(from, `${flyerUrl}?t=${Date.now()}`, flyerCaption);
  }

  return sendWhatsAppText(from, flyerCaption);
}

// ---------------------------------------------------------------------------
// Finalize Listing Creation Helper
// ---------------------------------------------------------------------------
async function finalizeListingCreation({
  broker,
  from,
  draftData,
  listingCode,
  rankedImages = []
}) {
  const typeAr = T.translatePropertyType(draftData.property_type);
  const locationText = draftData.location || draftData.location_name || null;
  const propertyTitle =
    draftData.title || (locationText ? `${typeAr} في ${locationText}` : typeAr);

  const combinedRawText = [draftData.rawTextJoined, draftData.transcribed_text]
    .filter(Boolean)
    .join("\n")
    .trim();

  const searchText = buildSearchText(draftData, combinedRawText, listingCode);
  const locKeywords = S.normalizeKeywords([
    draftData.compound,
    draftData.district,
    draftData.city,
    draftData.location,
    draftData.location_name,
    ...String(draftData.location || "").split(/[-–—،,/]/),
    ...(Array.isArray(draftData.location_keywords)
      ? draftData.location_keywords
      : [])
  ]);

  const validFrequency = [
    "monthly",
    "quarterly",
    "semi_annual",
    "annual"
  ].includes(draftData.payment_frequency)
    ? draftData.payment_frequency
    : "quarterly";

  let listingRow;
  try {
    const ins = await pool.query(
      `INSERT INTO listings (
        agency_id, broker_id, code, status, title, property_type, listing_type,
        price_value, price_display, area_value, bedrooms, location, location_name,
        features, language, raw_text, details, search_text, hero_position,
        is_primary_developer, down_payment_value, installment_years, installment_value,
        payment_frequency, delivery_date, maintenance_pct,
        compound, district, city, location_keywords
      ) VALUES (
        $1, $2, $3, 'active', $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, 0,
        $18, $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27, $28
      )
      ON CONFLICT (agency_id, code) DO UPDATE SET
        broker_id = EXCLUDED.broker_id,
        status = 'active',
        title = COALESCE(EXCLUDED.title, listings.title),
        property_type = COALESCE(EXCLUDED.property_type, listings.property_type),
        listing_type = COALESCE(EXCLUDED.listing_type, listings.listing_type),
        price_value = COALESCE(EXCLUDED.price_value, listings.price_value),
        price_display = COALESCE(EXCLUDED.price_display, listings.price_display),
        area_value = COALESCE(EXCLUDED.area_value, listings.area_value),
        bedrooms = COALESCE(EXCLUDED.bedrooms, listings.bedrooms),
        location = COALESCE(EXCLUDED.location, listings.location),
        location_name = COALESCE(EXCLUDED.location_name, listings.location_name),
        features = CASE WHEN array_length(EXCLUDED.features, 1) > 0 THEN EXCLUDED.features ELSE listings.features END,
        raw_text = COALESCE(NULLIF(EXCLUDED.raw_text, ''), listings.raw_text),
        details = EXCLUDED.details,
        search_text = EXCLUDED.search_text,
        compound = COALESCE(EXCLUDED.compound, listings.compound),
        district = COALESCE(EXCLUDED.district, listings.district),
        city = COALESCE(EXCLUDED.city, listings.city),
        location_keywords = CASE WHEN cardinality(EXCLUDED.location_keywords) > 0 THEN EXCLUDED.location_keywords ELSE listings.location_keywords END,
        hero_position = 0,
        is_primary_developer = EXCLUDED.is_primary_developer,
        down_payment_value = COALESCE(EXCLUDED.down_payment_value, listings.down_payment_value),
        installment_years = COALESCE(EXCLUDED.installment_years, listings.installment_years),
        installment_value = COALESCE(EXCLUDED.installment_value, listings.installment_value),
        payment_frequency = COALESCE(EXCLUDED.payment_frequency, listings.payment_frequency),
        delivery_date = COALESCE(EXCLUDED.delivery_date, listings.delivery_date),
        updated_at = NOW()
      RETURNING *`,
      [
        broker.agency_id,
        broker.id,
        listingCode,
        propertyTitle,
        draftData.property_type || "apartment",
        draftData.listing_type || "sale",
        draftData.price_value || null,
        draftData.price_display || null,
        draftData.area_value || null,
        draftData.bedrooms ? parseInt(draftData.bedrooms, 10) : null,
        locationText,
        draftData.location_name || locationText,
        Array.isArray(draftData.features) ? draftData.features : [],
        draftData.language === "en" ? "en" : "ar",
        combinedRawText || null,
        JSON.stringify(draftData),
        searchText,
        Boolean(draftData.is_primary_developer),
        draftData.down_payment_value || null,
        draftData.installment_years
          ? parseInt(draftData.installment_years, 10)
          : null,
        draftData.installment_value || null,
        validFrequency,
        draftData.delivery_date || null,
        draftData.maintenance_pct ?? 8,
        draftData.compound || null,
        draftData.district || null,
        draftData.city || null,
        locKeywords
      ]
    );

    listingRow = ins.rows[0];
  } catch (err) {
    console.error("❌ [DATABASE] Insertion failed:", err.message);
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: "error",
      meta: { stage: "db_insert", error: err.message }
    });
    // Generic error message for broker, details logged internally only
    await sendWhatsAppText(
      from,
      "⚠️ تعذر حفظ بيانات العقار في النظام حالياً. يرجى المحاولة مرة أخرى."
    );
    return;
  }

  await pool.query("DELETE FROM listing_images WHERE listing_id = $1", [
    listingRow.id
  ]);

  const flyerImageSources = [];
  for (let i = 0; i < rankedImages.length; i++) {
    const item = rankedImages[i];
    const buffer = item.buffer || Buffer.from(item.bufferB64, "base64");
    const photoPath = `${broker.agency_id}/${listingRow.id}/photo_${i}.jpg`;

    try {
      const { error: photoErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(photoPath, buffer, {
          contentType: "image/jpeg",
          upsert: true
        });

      if (!photoErr) {
        const { data: pubData } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(photoPath);

        const publicUrl = pubData.publicUrl;

        await pool.query(
          `INSERT INTO listing_images (listing_id, agency_id, position, url, phash)
           VALUES ($1, $2, $3, $4, $5::bit(64))`,
          [
            listingRow.id,
            broker.agency_id,
            i,
            publicUrl,
            item.phash || "0".repeat(64)
          ]
        );

        if (!item.isFloorplan && flyerImageSources.length < 9) {
          flyerImageSources.push(
            item.dataUri ||
              `data:image/jpeg;base64,${buffer.toString("base64")}`
          );
        }
      }
    } catch (imgErr) {
      console.error(`❌ [IMAGE UPLOAD #${i}] Error:`, imgErr.message);
    }
  }

  let flyerPublicUrl = null;
  try {
    flyerPublicUrl = await generateAndUploadFlyer({
      broker,
      listing: listingRow,
      imageSources: flyerImageSources
    });
  } catch (err) {
    console.error("❌ [RENDER] Brochure rendering error:", err.message);
  }

  await upsertSession(from, "review", listingRow.id, {
    code: listingCode,
    flyerUrl: flyerPublicUrl
  });

  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: from,
    eventType: "submission",
    listingId: listingRow.id,
    meta: {
      code: listingCode,
      imagesCount: rankedImages.length
    }
  });

  const displayPrice =
    listingRow.price_display ||
    (listingRow.price_value
      ? T.formatPrice(listingRow.price_value)
      : "عند الطلب");
  const displayArea = listingRow.area_value
    ? `${listingRow.area_value} م²`
    : "-";
  const displayRooms = listingRow.bedrooms ? `${listingRow.bedrooms} غرف` : "-";

  const displaySummary = draftData.clean_summary || "";
  const displayBathrooms = draftData.bathrooms
    ? ` | الحمامات: *${draftData.bathrooms}*`
    : "";

  if (flyerPublicUrl) {
    const caption = [
      `🏡 *تم تجهيز الكتالوج بنجاح!*`,
      `• الكود: *#${listingCode}*`,
      `• الوحدة: *${propertyTitle}*`,
      `• السعر: *${displayPrice}*`,
      `• المساحة: *${displayArea}* | الغرف: *${displayRooms}*${displayBathrooms}`,
      `• الموقع: *${locationText || "القاهرة"}*`,
      displaySummary ? `\n📝 *ملخص الوحدة:*\n${displaySummary}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    await sendWhatsAppImage(from, `${flyerPublicUrl}?t=${Date.now()}`, caption);
  } else {
    await sendWhatsAppText(
      from,
      `✅ تم حفظ العقار برقم *#${listingCode}*، ولكن تعذر إنشاء الصورة الترويجية.`
    );
  }
}

// ---------------------------------------------------------------------------
// AI Search (Text or Voice) & Command Handlers
// ---------------------------------------------------------------------------
const MAX_SEARCHES_PER_HOUR =
  parseInt(process.env.MAX_SEARCHES_PER_HOUR, 10) || 60;
const searchModel = () =>
  process.env.GEMINI_SEARCH_MODEL ||
  process.env.GEMINI_MODEL ||
  "gemini-2.5-flash";
const geminiPrices = () => ({
  inPerM: Number(process.env.GEMINI_PRICE_IN_PER_M) || 0,
  outPerM: Number(process.env.GEMINI_PRICE_OUT_PER_M) || 0
});

function cacheMedia(id, media) {
  const now = Date.now();
  for (const [k, v] of mediaCache)
    if (now - v.at > 3 * 60 * 1000) mediaCache.delete(k);
  mediaCache.set(id, { media, at: now });
}

async function routeTextOrVoice({ from, broker, collectedText, audioItems }) {
  const text = collectedText.join("\n").trim();
  const audio = [];
  for (const aud of audioItems) {
    if (!aud?.id) continue;
    const media = await downloadWhatsAppMedia(aud.id);
    if (media?.buffer) {
      cacheMedia(aud.id, media);
      audio.push({
        buffer: media.buffer,
        mimeType: cleanAudioMime(media.mimeType)
      });
    }
  }

  const startMs = Date.now();
  let parsed;
  let usage;
  try {
    ({ parsed, usage } = await S.parseSearchRequest(ai, {
      text,
      audio,
      model: searchModel()
    }));
  } catch (err) {
    console.error("❌ [SEARCH PARSE] Gemini failed:", err.message);
    return false;
  }

  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: from,
    eventType: "gemini",
    durationMs: Date.now() - startMs,
    costUsd: S.estimateCostUsd(usage, geminiPrices()),
    tokensInput: usage.input,
    tokensOutput: usage.output,
    meta: {
      stage: "intent_search",
      intent: parsed.intent,
      audioCount: audio.length
    }
  });

  if (parsed.intent === "search") {
    await runAiSearch({
      broker,
      from,
      parsed,
      isVoice: audio.length > 0,
      startMs
    });
    return true;
  }
  if (parsed.intent === "other") {
    await sendWhatsAppText(
      from,
      'أهلاً 👋 ابعت صور العقار مع التفاصيل لتجهيز كتالوج، أو اسألني عن وحداتكم مثلاً: "شقة 3 غرف في التجمع الخامس تحت 7 مليون". للمساعدة اكتب: مساعدة'
    );
    return true;
  }
  return false;
}

async function runAiSearch({
  broker,
  from,
  parsed,
  isVoice = false,
  startMs = Date.now(),
  usedFallback = false,
  offset = 0
}) {
  // 1. Rate Limiting Check
  const lim = await pool.query(
    `SELECT COUNT(*) AS n FROM usage_events
      WHERE broker_id = $1 AND event_type = 'search' AND created_at > NOW() - INTERVAL '1 hour'`,
    [broker.id]
  );
  if (Number(lim.rows[0].n) >= MAX_SEARCHES_PER_HOUR) {
    return sendWhatsAppText(
      from,
      "⛔ وصلت للحد الأقصى لعمليات البحث بالساعة. جرّب بعد شوية."
    );
  }

  // 2. Validate Filter Presence
  if (!S.hasAnyFilter(parsed)) {
    return sendWhatsAppText(
      from,
      'حدد منطقة أو نوع أو ميزانية عشان أدورلك، مثلاً: "شقة 3 غرف في التجمع تحت 7 مليون".'
    );
  }

  // 3. Query Execution with LIMIT 10 and OFFSET
  let relaxed = false;
  let q = S.buildSearchQuery(broker.agency_id, parsed, {
    limit: PAGE_SIZE,
    offset
  });
  let res = await pool.query(q.sql, q.params);

  if (res.rowCount === 0 && offset === 0 && !parsed.filters.code) {
    relaxed = true;
    q = S.buildSearchQuery(broker.agency_id, parsed, {
      relaxed: true,
      limit: PAGE_SIZE,
      offset
    });
    res = await pool.query(q.sql, q.params);
  }

  const totalCount = res.rowCount > 0 ? Number(res.rows[0].total_count) : 0;
  const now = Date.now();

  // 4. Save/Refresh Pagination State in Postgres
  await upsertSession(from, "search_paging", null, {
    parsed,
    offset,
    totalCount,
    relaxed,
    timestamp: offset === 0 ? now : undefined, // Reset 10-min window on new search
    lastPagingAt: now
  });

  // 5. Usage & Analytics Logging
  if (offset === 0) {
    try {
      await pool.query(
        `INSERT INTO search_analytics (agency_id, broker_id, query_raw, tokens, results_count, is_voice)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          broker.agency_id,
          broker.id,
          parsed.transcript || "",
          parsed.location_terms,
          totalCount,
          isVoice
        ]
      );
    } catch (_) {}

    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: "search",
      durationMs: Date.now() - startMs,
      meta: {
        totalCount,
        relaxed,
        isVoice,
        usedFallback,
        terms: parsed.location_terms
      }
    });
  }

  // 6. Build Compact 10-Unit Response
  const understood = S.formatInterpretation(parsed);
  const header = `🔍 *طلبك:* ${understood || parsed.transcript}${
    usedFallback ? " _(بحث بالكلمات)_" : ""
  }`;

  if (totalCount === 0) {
    return sendWhatsAppText(
      from,
      `${header}\n\n❌ مفيش وحدات نشطة مطابقة حالياً.\n💡 جرّب توسيع نطاق السعر أو تغيير المنطقة.`
    );
  }

  const startIdx = offset + 1;
  const endIdx = Math.min(offset + res.rowCount, totalCount);

  // Render compact lines with indented short_summary
  const lines = res.rows.map((r, i) => {
    const num = startIdx + i;
    const title = r.title || "وحدة سكنية";
    const loc = r.location || "-";
    const price =
      r.price_display ||
      (r.price_value ? T.formatPrice(r.price_value) : "عند الطلب");
    const area = r.area_value ? `${r.area_value}م²` : "-";
    const beds = r.bedrooms ? `${r.bedrooms} غرف` : "-";

    // Prioritize pre-stored short_summary
    const summary = r.details?.short_summary || r.details?.clean_summary || "";
    const summaryLine = summary ? `\n   📝 _${summary}_` : "";

    return `*${num}. #${r.code}* — ${title}\n   📍 ${loc} | 💰 *${price}* | 📐 ${area} | 🛏️ ${beds}${summaryLine}`;
  });

  const note = relaxed ? "⚠️ _(أقرب نتائج تقريبية لعدم وجود تطابق تام)_\n" : "";
  const remaining = totalCount - endIdx;

  const footerParts = [
    `\n━━━━━━━━━━━━━━━━━━━━`,
    `⚠️ *ملحوظة:* البحث الجماعي يعرض ملخصات نصية فقط لتوفير الوقت وسرعة التصفح. للحصول على الكتالوج والصور اطلب بالرمز: *كتالوج #الكود*`,
    `\n💡 *لتضييق النتائج:* أرسل رسالة محددة أكثر بالسعر أو عدد الغرف (مثال: "تحت 18 مليون" أو "3 غرف").`,
    `• لعرض بيانات أي وحدة: *#الكود*`,
    `• لتحميل كتالوج أي وحدة: *كتالوج الكود*`
  ];

  if (remaining > 0) {
    footerParts.push(
      `\n📄 متبقي *${remaining}* وحدة أخرى. لرؤية الـ 10 التالية أرسل: *المزيد*`
    );
  }

  if (totalCount > PAGE_SIZE) {
    footerParts.push(
      `📊 لتنزيل كل النتائج (*${totalCount}* وحدة) في ملف إكسيل أرسل: *اكسيل*`
    );
  }

  const replyText = [
    header,
    note,
    `📊 *إجمالي النتائج:* تم العثور على *${totalCount}* وحدة (معروض أفضل ${startIdx} إلى ${endIdx}):`,
    "",
    lines.join("\n\n"),
    footerParts.join("\n")
  ]
    .filter(Boolean)
    .join("\n");

  return sendWhatsAppText(from, replyText);
}

async function handleCommand(cmd, broker, from) {
  const startMs = Date.now();

  if (cmd.type === "help") {
    return sendWhatsAppText(
      from,
      [
        "📖 *دليل أوامر النظام:*",
        "",
        "• *إضافة عقار:* أرسل الصور مع الوصف أو رسالة صوتية.",
        "• *عرض عقار:* عقار 1001 أو #ANH245",
        "• *بحث في العقارات:* بحث شقة التجمع أو بحث فيلا زايد",
        "• *تحديث سعر:* سعر ANH245 إلى 8.5 مليون",
        "• *تحديث حالة:* تم البيع ANH245 | أرشيف ANH245 | تفعيل ANH245",
        "• *إحصائيات:* احصائيات"
      ].join("\n")
    );
  }

  if (cmd.type === "confirm" || cmd.type === "skip") {
    const sRes = await pool.query("SELECT * FROM sessions WHERE phone = $1", [
      from
    ]);
    const listingId = sRes.rows[0]?.listing_id;
    if (listingId) {
      await pool.query(
        "UPDATE listings SET status = 'active', updated_at = NOW() WHERE id = $1",
        [listingId]
      );
    }
    await pool.query("DELETE FROM sessions WHERE phone = $1", [from]);
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: "confirm",
      listingId
    });
    return sendWhatsAppText(from, "✅ تم اعتماد وتفعيل الإعلان بنجاح.");
  }

  if (cmd.type === "status") {
    const cleanCode = normalizeCode(cmd.code);
    const res = await pool.query(
      "UPDATE listings SET status = $1, updated_at = NOW() WHERE agency_id = $2 AND lower(code) = lower($3) RETURNING id, code",
      [cmd.status, broker.agency_id, cleanCode]
    );

    if (res.rowCount > 0) {
      const row = res.rows[0];
      await logUsageEvent({
        agencyId: broker.agency_id,
        brokerId: broker.id,
        phone: from,
        eventType: "status",
        listingId: row.id,
        durationMs: Date.now() - startMs,
        meta: { status: cmd.status, code: row.code }
      });
      const statusAr =
        cmd.status === "sold"
          ? "مباع (Sold)"
          : cmd.status === "archived"
          ? "مؤرشف (Archived)"
          : "نشط (Active)";
      return sendWhatsAppText(
        from,
        `✅ تم تحديث حالة العقار *#${row.code}* إلى: *${statusAr}*`
      );
    }

    return sendWhatsAppText(
      from,
      `❌ لم يتم العثور على عقار بالكود *#${cleanCode}*`
    );
  }

  if (cmd.type === "price") {
    const cleanCode = normalizeCode(cmd.code);
    const parsed = T.parsePrice(normalizeDigits(cmd.priceText));
    if (!parsed) {
      return sendWhatsAppText(
        from,
        `⚠️ لم نتمكن من قراءة السعر الجديد: "${cmd.priceText}"`
      );
    }

    const display = T.formatPrice(parsed);
    const res = await pool.query(
      `UPDATE listings
       SET price_value = $1, price_display = $2, updated_at = NOW()
       WHERE agency_id = $3 AND lower(code) = lower($4)
       RETURNING *`,
      [parsed, display, broker.agency_id, cleanCode]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        `❌ لم يتم العثور على عقار بالكود *#${cleanCode}*`
      );
    }

    const updatedListing = res.rows[0];
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: "price",
      listingId: updatedListing.id,
      durationMs: Date.now() - startMs,
      meta: { code: updatedListing.code, newPrice: parsed }
    });

    try {
      const imgsRes = await pool.query(
        "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 9",
        [updatedListing.id]
      );
      const imageUrls = imgsRes.rows.map((r) => r.url);
      const newFlyerUrl = await generateAndUploadFlyer({
        broker,
        listing: updatedListing,
        imageSources: imageUrls
      });
      return sendWhatsAppImage(
        from,
        `${newFlyerUrl}?t=${Date.now()}`,
        `✅ تم تحديث سعر العقار *#${updatedListing.code}* إلى: *${display}* وتحديث الكتالوج.`
      );
    } catch (err) {
      console.error("⚠️ [PRICE RE-RENDER] Failed:", err.message);
      return sendWhatsAppText(
        from,
        `✅ تم تحديث سعر العقار *#${updatedListing.code}* إلى: *${display}*`
      );
    }
  }
  if (cmd.type === "more") {
    const sRes = await pool.query("SELECT * FROM sessions WHERE phone = $1", [
      from
    ]);
    const session = sRes.rows[0];

    // 1. Check if an active search session exists
    if (
      !session ||
      session.state !== "search_paging" ||
      !session.data?.parsed
    ) {
      return sendWhatsAppText(
        from,
        '⚠️ مفيش نتائج سابقة لعرض المزيد. ابدأ بحث جديد أولاً (مثال: "بحث شقة في التجمع").'
      );
    }

    const sessionData = session.data || {};
    const now = Date.now();
    const sessionAge = now - (sessionData.timestamp || 0);
    const lastPagingElapsed = now - (sessionData.lastPagingAt || 0);

    // 2. Anti-spam 2-Second Guard: Ignore duplicate taps within 2 seconds
    if (lastPagingElapsed < PAGINATION_DEBOUNCE_MS) {
      // Silently ignore rapid double-taps to prevent skipping pages
      return;
    }

    // 3. 10-Minute Expiry Check
    if (sessionAge > SEARCH_SESSION_EXPIRY_MS) {
      await pool.query("DELETE FROM sessions WHERE phone = $1", [from]);
      return sendWhatsAppText(
        from,
        "⏳ انتهت جلسة البحث السابقة (صلاحية البحث 10 دقائق). يرجى كتابة طلب البحث مجدداً."
      );
    }

    const { parsed, offset = 0, totalCount = 0 } = sessionData;
    const nextOffset = offset + PAGE_SIZE;

    // 4. Check if all listings have already been rendered
    if (nextOffset >= totalCount) {
      return sendWhatsAppText(
        from,
        `🏁 تم عرض جميع النتائج بالكامل (*${totalCount}* وحدة).\n💡 للبحث بمواصفات أخرى أرسل طلبك مباشرة.`
      );
    }

    // 5. Update lastPagingAt timestamp atomically before fetching
    await upsertSession(from, "search_paging", null, {
      ...sessionData,
      offset: nextOffset,
      lastPagingAt: now
    });

    return runAiSearch({
      broker,
      from,
      parsed,
      offset: nextOffset,
      startMs
    });
  }
  if (cmd.type === "show" || cmd.type === "catalog") {
    const cleanCode = normalizeCode(cmd.code);
    const res = await pool.query(
      `SELECT *, details->>'clean_summary' AS clean_summary
       FROM listings
       WHERE agency_id = $1 AND lower(code) = lower($2)`,
      [broker.agency_id, cleanCode]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(from, `❌ العقار *#${cleanCode}* غير مسجل.`);
    }

    const l = res.rows[0];
    let flyerUrl = l.flyer_url;

    // If flyer_url is missing (or forced via catalog/regenerate), generate it on the fly
    if (!flyerUrl || cmd.type === "catalog") {
      try {
        const imgsRes = await pool.query(
          "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 9",
          [l.id]
        );
        const imageUrls = imgsRes.rows.map((r) => r.url);

        flyerUrl = await generateAndUploadFlyer({
          broker,
          listing: l,
          imageSources: imageUrls
        });
      } catch (err) {
        console.error(
          "⚠️ [SHOW AUTO-RENDER] Flyer generation failed:",
          err.message
        );
      }
    }

    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: "show",
      listingId: l.id,
      durationMs: Date.now() - startMs
    });

    const summaryText = l.clean_summary
      ? `\n\n📝 *التفاصيل:*\n${l.clean_summary}`
      : "";
    const caption = [
      `📋 *بيانات العقار #${l.code}*`,
      `• العنوان: ${l.title || "-"}`,
      `• السعر: *${l.price_display || "عند الطلب"}*`,
      `• المساحة: ${l.area_value ? `${l.area_value} م²` : "-"} | الغرف: ${
        l.bedrooms || "-"
      }`,
      `• الموقع: ${l.location || "-"}`,
      `• الحالة: ${l.status}${summaryText}`
    ].join("\n");

    if (flyerUrl) {
      return sendWhatsAppImage(from, `${flyerUrl}?t=${Date.now()}`, caption);
    }

    return sendWhatsAppText(from, caption);
  }

  if (cmd.type === "search") {
    let parsed;
    let usage = null;
    let usedFallback = false;
    try {
      ({ parsed, usage } = await S.parseSearchRequest(ai, {
        text: cmd.query,
        model: searchModel()
      }));
      parsed.intent = "search";
    } catch (err) {
      console.error(
        "❌ [SEARCH PARSE] Gemini failed, using keyword fallback:",
        err.message
      );
      parsed = S.fallbackParse(cmd.query);
      usedFallback = true;
    }
    if (usage) {
      await logUsageEvent({
        agencyId: broker.agency_id,
        brokerId: broker.id,
        phone: from,
        eventType: "gemini",
        durationMs: Date.now() - startMs,
        costUsd: S.estimateCostUsd(usage, geminiPrices()),
        tokensInput: usage.input,
        tokensOutput: usage.output,
        meta: { stage: "search_command" }
      });
    }
    return runAiSearch({ broker, from, parsed, startMs, usedFallback });
  }

  if (cmd.type === "stats") {
    const countsRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active_count,
         COUNT(*) FILTER (WHERE status = 'sold') AS sold_count,
         COUNT(*) FILTER (WHERE status = 'archived') AS archived_count,
         COUNT(*) AS total_count
       FROM listings
       WHERE agency_id = $1`,
      [broker.agency_id]
    );

    const c = countsRes.rows[0] || {};
    return sendWhatsAppText(
      from,
      [
        `📊 *إحصائيات ${broker.agency_name}:*`,
        `• إجمالي الوحدات: *${c.total_count || 0}*`,
        `• وحدات نشطة: *${c.active_count || 0}*`,
        `• وحدات مباعة: *${c.sold_count || 0}*`,
        `• وحدات مؤرشفة: *${c.archived_count || 0}*`
      ].join("\n")
    );
  }

  if (cmd.type === "help") {
    return sendWhatsAppText(from, T.getHelpMessage());
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ [GLOBAL] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🚨 [GLOBAL] Uncaught Exception:", err);
});

app.listen(PORT, () => {
  console.log(`🚀 Real Estate WhatsApp Engine Online | Port: ${PORT}`);
});
