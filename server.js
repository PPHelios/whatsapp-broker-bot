// server.js
require("dotenv").config();
const express = require("express");
const sharp = require("sharp");
const { GoogleGenAI } = require("@google/genai");

const { pool } = require("./lib/db");
const { uploadListingImage, uploadFlyerImage } = require("./lib/supabase");
const { generateFlyerBuffer } = require("./lib/flyer");
const {
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  downloadWhatsAppMedia
} = require("./lib/whatsapp");
const {
  getHelpMessage,
  formatClientListingText,
  formatInternalListingDetails,
  parseEgyptianPrice
} = require("./lib/text");

const app = express();
app.use(express.json({ limit: "20mb" }));

// ---------------------------------------------------------------------------
// ARCHITECTURAL SAFEGUARDS & NATIVE CONCURRENCY LIMITER
// ---------------------------------------------------------------------------
sharp.concurrency(1);

function createLimiter(concurrency) {
  let activeCount = 0;
  const queue = [];

  const next = function () {
    activeCount--;
    if (queue.length > 0) {
      const run = queue.shift();
      run();
    }
  };

  return function (fn) {
    return new Promise(function (resolve, reject) {
      const run = async function () {
        activeCount++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          next();
        }
      };

      if (activeCount < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

// Limit heavy listing ingestion pipelines to 2 concurrent jobs
const listingLimiter = createLimiter(2);

// Operational Constants
const GEMINI_MODEL_ID = "gemini-3.8-flash";
const MAX_VISION_EVAL_IMAGES = 15;
const MAX_FLYER_IMAGES = 9;
const MAX_SEARCH_AUDIO_SEC = 45;
const MAX_LISTING_AUDIO_SEC = 120;
const SEARCH_PAGE_SIZE = 10;
const BATCH_DEBOUNCE_MS = 8000;

// In-memory state maps for multi-photo debounce batching and search pagination
const incomingBatches = new Map();
const lastSearchState = new Map();

// ---------------------------------------------------------------------------
// UNIFIED @google/genai CLIENT & CONFIGURATIONS
// ---------------------------------------------------------------------------
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || ""
});

// Tier 1: Multimodal Ingestion & Photo Curation (Thinking Budget: 768)
const LISTING_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 2048,
  responseMimeType: "application/json",
  thinkingConfig: {
    thinkingBudget: 768
  }
};

// Tier 2: Voice Search Parser (Thinking Budget: 256)
const VOICE_SEARCH_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 500,
  responseMimeType: "application/json",
  thinkingConfig: {
    thinkingBudget: 256
  }
};

// Tier 3: Lean Text Search Parser (Thinking Budget: 0)
const TEXT_SEARCH_CONFIG = {
  temperature: 0.0,
  maxOutputTokens: 350,
  responseMimeType: "application/json",
  thinkingConfig: {
    thinkingBudget: 0
  }
};

// ---------------------------------------------------------------------------
// CANONICAL RULES & PROMPTS
// ---------------------------------------------------------------------------
const CANONICAL_REAL_ESTATE_RULES = [
  "CANONICAL EGYPTIAN REAL ESTATE RULES:",
  "1. TYPO & PHONETIC CORRECTION:",
  "   - بالم هيلتز / بالم هيلس -> بالم هيلز (Palm Hills)",
  "   - مفيدا -> ميفيدا (Mivida)",
  "   - اب تاون / ابتاون -> أبتاون كايرو (Uptown Cairo)",
  "   - هيد بارك -> هايد بارك (Hyde Park)",
  "   - مانتن فيو / ماونتنفيو -> ماونتن فيو (Mountain View)",
  "   - تاج ستي -> تاج سيتي (Taj City)",
  "   - باديه -> بادية (Badya)",
  "   - فيلت / فيليت -> فيليت (Villette)",
  "   - مدينتى -> مدينتي (Madinaty)",
  "   - الرحابه -> الرحاب (Al Rehab)",
  "2. GEOGRAPHIC INFERENCE FOR KNOWN COMPOUNDS:",
  "   - ميفيدا -> compound: ميفيدا, district: التجمع الخامس, city: القاهرة الجديدة",
  "   - أبتاون كايرو -> compound: أبتاون كايرو, district: المقطم, city: القاهرة",
  "   - بادية -> compound: بادية, district: 6 أكتوبر, city: الجيزة",
  "   - مدينتي -> compound: مدينتي, district: شرق القاهرة, city: القاهرة",
  "   - زد إيست -> compound: زد إيست, district: التجمع الخامس, city: القاهرة الجديدة",
  "   - زد الشيخ زايد -> compound: زد, district: الشيخ زايد, city: الجيزة",
  "3. MASTER DEVELOPERS VS COMPOUNDS:",
  "   - سوديك, إعمار, بالم هيلز, ماونتن فيو, طلعت مصطفى, مصر إيطاليا, الأهلي صبور are MASTER DEVELOPERS.",
  "   - If a developer is given alone (e.g. سوديك), set developer: Name, is_multi_project_developer: true, and leave compound, district, and city null.",
  "   - If developer + area is given (e.g. سوديك زايد), set developer: سوديك, district: الشيخ زايد, is_multi_project_developer: false.",
  "4. FRANCO-ARABIC NUMERAL HANDLING:",
  "   - Digits 3 (ع), 7 (ح), 2 (أ), 5 (خ) inside words are LETTERS, NOT NUMBERS (e.g. 3ayez = wanting, sha2a = apartment).",
  "   - Only extract bedrooms when quantifying rooms (e.g. 3 bedrooms, 3 owaad, 3 ghoraf).",
  "5. FOREGROUND VOICE & SELF-CORRECTION:",
  "   - Ignore background noise, radio ads, and side chatter.",
  "   - If speaker corrects themselves (لأ معلش, قصدي, سوري), the new value overwrites the old value.",
  "6. DOWN PAYMENT & PAYMENT PLANS:",
  "   - mo2adam, مقدم, دفعة أولى, كاش متاح -> is_down_payment: true, map value to down_payment_value."
].join("\n");

function generateListingCode() {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let rand = "";
  for (let i = 0; i < 5; i++) {
    rand += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return "RK-D-" + rand;
}

function cleanJsonResponse(rawText) {
  let cleaned = String(rawText || "").trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

async function prepareImagesForGemini(rawImages, maxCount) {
  const limit = maxCount || MAX_VISION_EVAL_IMAGES;
  const candidates = rawImages.slice(0, limit);

  return Promise.all(
    candidates.map(async function (img) {
      try {
        const compressedBuffer = await sharp(img.buffer)
          .rotate()
          .resize({
            width: 1024,
            height: 1024,
            fit: "inside",
            withoutEnlargement: true
          })
          .jpeg({ quality: 78, mozjpeg: true })
          .toBuffer();

        return {
          buffer: compressedBuffer,
          mimeType: "image/jpeg"
        };
      } catch (err) {
        console.warn(
          "[SHARP PRE-COMPRESS] Fallback to raw buffer:",
          err.message
        );
        return img;
      }
    })
  );
}

// ---------------------------------------------------------------------------
// MULTI-MESSAGE DEBOUNCE BATCHER (Collects multi-photo bursts over 8s)
// ---------------------------------------------------------------------------
function isBatchingActive(phone) {
  return incomingBatches.has(phone);
}

function enqueueToBatch(broker, item) {
  const phone = broker.phone;
  let batch = incomingBatches.get(phone);

  if (!batch) {
    batch = {
      broker: broker,
      from: phone,
      texts: [],
      audios: [],
      images: [],
      timer: null
    };
    incomingBatches.set(phone, batch);
  }

  if (item.text) batch.texts.push(item.text);
  if (item.audio) batch.audios.push(item.audio);
  if (item.image) batch.images.push(item.image);

  if (batch.timer) clearTimeout(batch.timer);

  batch.timer = setTimeout(async function () {
    const finalizedBatch = incomingBatches.get(phone);
    incomingBatches.delete(phone);
    if (!finalizedBatch) return;

    try {
      await listingLimiter(function () {
        return processBatchedListing(finalizedBatch.broker, finalizedBatch);
      });
    } catch (err) {
      console.error("[BATCH EXECUTION ERROR]:", err);
    }
  }, BATCH_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// 1. INGESTION PIPELINE: processBatchedListing
// ---------------------------------------------------------------------------
async function processBatchedListing(broker, batch) {
  const from = batch.from;
  const startMs = Date.now();
  const images = batch.images || [];
  const audios = batch.audios || [];
  const textBody = (batch.texts || []).join("\n").trim();

  for (let i = 0; i < audios.length; i++) {
    const audio = audios[i];
    if (audio.duration && audio.duration > MAX_LISTING_AUDIO_SEC) {
      return sendWhatsAppText(
        from,
        "⚠️ *التسجيل الصوتي طويل جداً (" +
          audio.duration +
          " ثانية).*\n\nالحد الأقصى للتسجيل الصوتي لإضافة عقار هو *دقيقتان (120 ثانية)*.\nيرجى إرسال تسجيل صوتي مختصر بمواصفات الوحدة."
      );
    }
  }

  // Scenario A: Late photos attached to an explicit #CODE or within 5 minutes
  const explicitCodeMatch = textBody.match(/^#?([A-Z]{2}-[A-Z]-[A-Z0-9]{5})$/i);
  if (
    audios.length === 0 &&
    images.length > 0 &&
    (!textBody || explicitCodeMatch)
  ) {
    let recentRes;
    if (explicitCodeMatch) {
      recentRes = await pool.query(
        "SELECT id, code, flyer_url, title, price_display, area_value, bedrooms, location, details FROM listings WHERE agency_id = $1 AND code = $2 LIMIT 1",
        [broker.agency_id, explicitCodeMatch[1].toUpperCase()]
      );
    } else {
      recentRes = await pool.query(
        "SELECT id, code, flyer_url, title, price_display, area_value, bedrooms, location, details FROM listings WHERE broker_id = $1 AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1",
        [broker.id]
      );
    }

    if (recentRes.rowCount > 0) {
      const recent = recentRes.rows[0];
      await sendWhatsAppText(
        from,
        "📸 جاري معالجة وإلحاق الصور الجديدة بالعقار رقم *#" +
          recent.code +
          "*..."
      );

      const compressedLate = await prepareImagesForGemini(
        images,
        MAX_FLYER_IMAGES
      );
      for (let i = 0; i < compressedLate.length; i++) {
        const url = await uploadListingImage(
          broker.agency_id,
          recent.id,
          compressedLate[i].buffer
        );
        if (url) {
          await pool.query(
            "INSERT INTO listing_images (listing_id, url, position) VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM listing_images WHERE listing_id = $1))",
            [recent.id, url]
          );
        }
      }

      const allImgsRes = await pool.query(
        "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 9",
        [recent.id]
      );
      const allImageUrls = allImgsRes.rows.map(function (r) {
        return r.url;
      });

      const agencyRes = await pool.query(
        "SELECT name, logo_url, primary_color, secondary_color FROM agencies WHERE id = $1",
        [broker.agency_id]
      );
      const agency = agencyRes.rows[0] || {};

      const flyerBuffer = await generateFlyerBuffer({
        listing: recent,
        agency: agency,
        images: allImageUrls
      });
      const updatedFlyerUrl = await uploadFlyerImage(
        broker.agency_id,
        recent.code,
        flyerBuffer
      );

      if (updatedFlyerUrl) {
        await pool.query(
          "UPDATE listings SET flyer_url = $1, updated_at = NOW() WHERE id = $2",
          [updatedFlyerUrl, recent.id]
        );

        return sendWhatsAppImage(
          from,
          updatedFlyerUrl + "?t=" + Date.now(),
          "✅ تم تحديث كتالوج العقار *#" +
            recent.code +
            "* بنجاح.\n📸 إجمالي الصور المعتمدة: (" +
            allImageUrls.length +
            ")."
        );
      }
    }

    return sendWhatsAppText(
      from,
      "⚠️ *تم استلام صور بدون أي تفاصيل أو كود عقار.*\n\nيرجى إرسال مواصفات الوحدة في رسالة نصية أو تسجيل صوتي ليتم تسجيلها وتصميم الكتالوج."
    );
  }

  // Scenario B: Text / Audio Only (Zero Photos)
  if (images.length === 0 && (textBody || audios.length > 0)) {
    await sendWhatsAppText(from, "⏳ جاري استخراج وحفظ بيانات العقار...");

    const promptText = [
      "You are an expert Egyptian real estate data extractor. Extract specs into strict JSON:",
      "{",
      '  "code": "optional unit code or null",',
      '  "title": "Concise Arabic title",',
      '  "property_type": "apartment | villa | townhouse | twinhouse | duplex | penthouse | studio | chalet | office | commercial",',
      '  "listing_type": "sale | rent",',
      '  "price_value": null,',
      '  "price_display": "formatted Arabic price or null",',
      '  "area_value": null,',
      '  "bedrooms": null,',
      '  "location": "Compound and/or district in Arabic",',
      '  "compound": "Compound in Arabic or null",',
      '  "district": "District in Arabic or null",',
      '  "city": "City in Arabic or null",',
      '  "location_keywords": ["canonical terms in Arabic, English, Franco"],',
      '  "clean_summary": "Professional Arabic summary without broker contact info",',
      '  "short_summary": "1-line concise Arabic highlight",',
      '  "features": ["up to 5 key features"],',
      '  "down_payment_value": null,',
      '  "installments_years": null',
      "}",
      CANONICAL_REAL_ESTATE_RULES
    ].join("\n");

    const parts = [{ text: promptText }];
    if (textBody) parts.push({ text: "\n--- DETAILS ---\n" + textBody });

    for (let i = 0; i < audios.length; i++) {
      const audio = audios[i];
      if (audio.buffer && audio.buffer.length > 0) {
        parts.push({
          inlineData: {
            mimeType: audio.mimeType || "audio/ogg",
            data: audio.buffer.toString("base64")
          }
        });
      }
    }

    let draftData = {};
    let usage = {};
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL_ID,
        contents: parts,
        config: LISTING_CONFIG
      });
      const resText = cleanJsonResponse(response.text);
      usage = response.usageMetadata || {};
      draftData = JSON.parse(resText);
    } catch (err) {
      console.error("[EXTRACTION ERROR TEXT/AUDIO]:", err.message);
      return sendWhatsAppText(
        from,
        "❌ تعذر استخراج مواصفات العقار. يرجى توضيح السعر والموقع والمساحة وإعادة المحاولة."
      );
    }

    const listingCode =
      draftData.code && String(draftData.code).trim().length > 2
        ? String(draftData.code).trim().toUpperCase()
        : generateListingCode();

    const insertQuery =
      "INSERT INTO listings (" +
      "agency_id, broker_id, code, title, property_type, listing_type, " +
      "price_value, price_display, area_value, bedrooms, location, " +
      "compound, district, city, location_keywords, flyer_url, status, details" +
      ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *;";

    const values = [
      broker.agency_id,
      broker.id,
      listingCode,
      draftData.title || "وحدة سكنية متميزة",
      draftData.property_type || "apartment",
      draftData.listing_type || "sale",
      draftData.price_value || null,
      draftData.price_display ||
        (draftData.price_value
          ? Number(draftData.price_value).toLocaleString("en-US") + " ج"
          : "عند الطلب"),
      draftData.area_value || null,
      draftData.bedrooms || null,
      draftData.location || null,
      draftData.compound || null,
      draftData.district || null,
      draftData.city || null,
      draftData.location_keywords || [],
      null,
      "active",
      draftData
    ];

    const { rows } = await pool.query(insertQuery, values);
    const listing = rows[0];

    await pool.query(
      "INSERT INTO usage_events (agency_id, broker_id, phone, event_type, listing_id, duration_ms, meta) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        broker.agency_id,
        broker.id,
        from,
        "create_listing",
        listing.id,
        Date.now() - startMs,
        {
          stored_photos: 0,
          stored_bytes: 0,
          has_flyer: false,
          prompt_tokens: usage.promptTokenCount || 0,
          candidates_tokens: usage.candidatesTokenCount || 0,
          total_tokens: usage.totalTokenCount || 0,
          model_used: "gemini-3.8-flash-reasoning"
        }
      ]
    );

    const summaryText = draftData.clean_summary
      ? "\n\n📝 *التفاصيل:*\n" + draftData.clean_summary
      : "";
    return sendWhatsAppText(
      from,
      [
        "✅ *تم حفظ بيانات العقار بنجاح برمز: #" + listing.code + "*",
        "• الوحدة: " + listing.title,
        "• السعر: *" + listing.price_display + "*",
        "• المساحة: " +
          (listing.area_value ? listing.area_value + " م²" : "-") +
          " | الغرف: " +
          (listing.bedrooms || "-"),
        "• الموقع: " + (listing.location || "-") + summaryText,
        "",
        "💡 *ملحوظة:* تم حفظ الوحدة بدون صور. لإصدار كتالوج مخصص، أرسل صور الوحدة واكتب في التعليق: *#" +
          listing.code +
          "*."
      ].join("\n")
    );
  }

  // Scenario C: Complete Pipeline (Text/Audio + Candidate Images)
  let preWaitNotice =
    "⏳ *جاري فحص البيانات وتصميم الكتالوج...*\n⏱️ يستغرق التجهيز دقيقة واحدة تقريباً.\n\n⚠️ *تنبيه:* يرجى الانتظار حتى استلام الكتالوج قبل إرسال عقار جديد لتجنب تداخل البيانات.";
  if (images.length > MAX_VISION_EVAL_IMAGES) {
    preWaitNotice =
      "📸 *تم استلام " +
      images.length +
      " صورة.* (الحد الأقصى للفحص الذكي 15 صورة).\n🔍 *سيتم فحص أول 15 صورة واختيار أفضل 9 صور للكتالوج تلقائياً.*\n\n" +
      preWaitNotice;
  }
  await sendWhatsAppText(from, preWaitNotice);

  const candidateCompressed = await prepareImagesForGemini(
    images,
    MAX_VISION_EVAL_IMAGES
  );

  const prompt = [
    "You are an expert Egyptian real estate data extractor and architectural photo art director.",
    "Extract all specs and evaluate candidate images into strict JSON:",
    "{",
    '  "code": "optional unit code or null",',
    '  "title": "Concise Arabic title",',
    '  "property_type": "apartment | villa | townhouse | twinhouse | duplex | penthouse | studio | chalet | office | commercial",',
    '  "listing_type": "sale | rent",',
    '  "price_value": null,',
    '  "price_display": "formatted Arabic price or null",',
    '  "area_value": null,',
    '  "bedrooms": null,',
    '  "location": "Compound and/or district in Arabic",',
    '  "compound": "Compound in Arabic or null",',
    '  "district": "District in Arabic or null",',
    '  "city": "City in Arabic or null",',
    '  "location_keywords": ["canonical terms in Arabic, English, Franco"],',
    '  "clean_summary": "Professional Arabic summary without broker contact info",',
    '  "short_summary": "1-line concise Arabic highlight",',
    '  "features": ["up to 5 key features"],',
    '  "down_payment_value": null,',
    '  "installments_years": null,',
    '  "hero_index": 0,',
    '  "selected_image_indices": [0, 1, 2],',
    '  "floorplan_indices": []',
    "}",
    "PHOTO CURATION DIRECTIVES (UP TO 9 BROCHURE IMAGES):",
    "1. hero_index: 0-based index of the best standout shot (wide panoramic view, golf view, or grand reception).",
    "2. selected_image_indices: Array of up to 9 distinct image indices ordered with hero_index first. EXCLUDE selfies, blurry shots, utility meters, corridors, or duplicate angles.",
    "3. floorplan_indices: 0-based indices of 2D architectural blueprints (exclude from selected_image_indices).",
    CANONICAL_REAL_ESTATE_RULES
  ].join("\n");

  const parts = [{ text: prompt }];
  if (textBody) parts.push({ text: "\n--- TEXT CAPTIONS ---\n" + textBody });

  for (let i = 0; i < audios.length; i++) {
    const audio = audios[i];
    if (audio.buffer && audio.buffer.length > 0) {
      parts.push({
        inlineData: {
          mimeType: audio.mimeType || "audio/ogg",
          data: audio.buffer.toString("base64")
        }
      });
    }
  }

  for (let i = 0; i < candidateCompressed.length; i++) {
    const img = candidateCompressed[i];
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.buffer.toString("base64")
      }
    });
  }

  let draftData = {};
  let usage = {};
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_ID,
      contents: parts,
      config: LISTING_CONFIG
    });
    const resText = cleanJsonResponse(response.text);
    usage = response.usageMetadata || {};
    draftData = JSON.parse(resText);
  } catch (err) {
    console.error("[MULTIMODAL EXTRACTION ERROR]:", err.message);
    return sendWhatsAppText(
      from,
      "❌ حدث خطأ أثناء فحص الصور والمواصفات عبر الذكاء الاصطناعي. يرجى إعادة المحاولة."
    );
  }

  let selectedBuffers = [];
  if (
    Array.isArray(draftData.selected_image_indices) &&
    draftData.selected_image_indices.length > 0
  ) {
    const seenIndices = new Set();
    for (let i = 0; i < draftData.selected_image_indices.length; i++) {
      const idx = draftData.selected_image_indices[i];
      if (
        typeof idx === "number" &&
        candidateCompressed[idx] &&
        !seenIndices.has(idx)
      ) {
        selectedBuffers.push(candidateCompressed[idx]);
        seenIndices.add(idx);
      }
      if (selectedBuffers.length === MAX_FLYER_IMAGES) break;
    }
  }

  if (selectedBuffers.length === 0) {
    selectedBuffers = candidateCompressed.slice(0, MAX_FLYER_IMAGES);
  }

  const uploadedUrls = [];
  let totalBytesStored = 0;
  for (let i = 0; i < selectedBuffers.length; i++) {
    const buffer = selectedBuffers[i].buffer;
    totalBytesStored += buffer.length;
    const url = await uploadListingImage(broker.agency_id, null, buffer);
    if (url) uploadedUrls.push(url);
  }

  const listingCode =
    draftData.code && String(draftData.code).trim().length > 2
      ? String(draftData.code).trim().toUpperCase()
      : generateListingCode();

  const insertQuery =
    "INSERT INTO listings (" +
    "agency_id, broker_id, code, title, property_type, listing_type, " +
    "price_value, price_display, area_value, bedrooms, location, " +
    "compound, district, city, location_keywords, flyer_url, status, details" +
    ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *;";

  const values = [
    broker.agency_id,
    broker.id,
    listingCode,
    draftData.title || "وحدة سكنية راقية",
    draftData.property_type || "apartment",
    draftData.listing_type || "sale",
    draftData.price_value || null,
    draftData.price_display ||
      (draftData.price_value
        ? Number(draftData.price_value).toLocaleString("en-US") + " ج"
        : "عند الطلب"),
    draftData.area_value || null,
    draftData.bedrooms || null,
    draftData.location || null,
    draftData.compound || null,
    draftData.district || null,
    draftData.city || null,
    draftData.location_keywords || [],
    null,
    "active",
    draftData
  ];

  const { rows } = await pool.query(insertQuery, values);
  const listing = rows[0];

  for (let pos = 0; pos < uploadedUrls.length; pos++) {
    await pool.query(
      "INSERT INTO listing_images (listing_id, url, position) VALUES ($1, $2, $3)",
      [listing.id, uploadedUrls[pos], pos]
    );
  }

  const agencyRes = await pool.query(
    "SELECT name, logo_url, primary_color, secondary_color FROM agencies WHERE id = $1",
    [broker.agency_id]
  );
  const agency = agencyRes.rows[0] || {};

  let finalFlyerUrl = null;
  try {
    const flyerBuffer = await generateFlyerBuffer({
      listing: listing,
      agency: agency,
      images: uploadedUrls
    });
    finalFlyerUrl = await uploadFlyerImage(
      broker.agency_id,
      listing.code,
      flyerBuffer
    );
    if (finalFlyerUrl) {
      await pool.query("UPDATE listings SET flyer_url = $1 WHERE id = $2", [
        finalFlyerUrl,
        listing.id
      ]);
    }
  } catch (renderErr) {
    console.error("[FLYER RENDER ERROR]:", renderErr.message);
  }

  await pool.query(
    "INSERT INTO usage_events (agency_id, broker_id, phone, event_type, listing_id, duration_ms, meta) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      broker.agency_id,
      broker.id,
      from,
      "create_listing",
      listing.id,
      Date.now() - startMs,
      {
        received_photos: images.length,
        evaluated_photos: candidateCompressed.length,
        stored_photos: uploadedUrls.length,
        stored_bytes: totalBytesStored,
        has_flyer: Boolean(finalFlyerUrl),
        prompt_tokens: usage.promptTokenCount || 0,
        candidates_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0,
        model_used: "gemini-3.8-flash-reasoning"
      }
    ]
  );

  let photoCountSummary =
    "📸 تم تصميم الكتالوج بـ (" + uploadedUrls.length + ") صور.";
  if (images.length > MAX_VISION_EVAL_IMAGES) {
    photoCountSummary =
      "📸 تم استلام " +
      images.length +
      " صورة (تم فحص أول 15 واختيار أفضل " +
      uploadedUrls.length +
      " صور للكتالوج).";
  } else if (images.length > MAX_FLYER_IMAGES) {
    photoCountSummary =
      "📸 تم استلام " +
      images.length +
      " صور (تم اختيار أفضل " +
      uploadedUrls.length +
      " صور واستبعاد المكرر).";
  }

  const summaryText = draftData.clean_summary
    ? "\n\n📝 *التفاصيل:*\n" + draftData.clean_summary
    : "";
  const flyerCaption = [
    "✅ *تم اعتماد العقار برمز: #" + listing.code + "*",
    "• الوحدة: " + listing.title,
    "• السعر: *" + listing.price_display + "*",
    "• المساحة: " +
      (listing.area_value ? listing.area_value + " م²" : "-") +
      " | الغرف: " +
      (listing.bedrooms || "-"),
    "• الموقع: " + (listing.location || "-"),
    photoCountSummary + summaryText,
    "",
    "💡 *لإرسال العرض لعميلك:* أرسل: عميل " + listing.code
  ].join("\n");

  if (finalFlyerUrl) {
    return sendWhatsAppImage(
      from,
      finalFlyerUrl + "?t=" + Date.now(),
      flyerCaption
    );
  }

  return sendWhatsAppText(from, flyerCaption);
}

// ---------------------------------------------------------------------------
// 2. SEARCH ENGINE: handleSearchMessage
// ---------------------------------------------------------------------------
async function handleSearchMessage(broker, options) {
  const text = options && options.text ? options.text : "";
  const audio = options && options.audio ? options.audio : null;
  const offset =
    options && typeof options.offset === "number" ? options.offset : 0;
  const from = broker.phone;
  const startMs = Date.now();
  const isVoice = Boolean(audio && audio.buffer && audio.buffer.length > 0);

  if (isVoice && audio.duration && audio.duration > MAX_SEARCH_AUDIO_SEC) {
    return sendWhatsAppText(
      from,
      "⚠️ *التسجيل الصوتي للبحث طويل جداً (" +
        audio.duration +
        " ثانية).*\n\nالحد الأقصى للبحث الصوتي هو *45 ثانية*. يرجى تسجيل طلبك باختصار."
    );
  }

  const activeConfig = isVoice ? VOICE_SEARCH_CONFIG : TEXT_SEARCH_CONFIG;
  const modelLabel = isVoice
    ? "gemini-3.8-flash-voice-reasoning"
    : "gemini-3.8-flash-lean";

  const searchPrompt = [
    "You are an Egyptian real estate intent and search query parser.",
    'Determine if the broker is searching for inventory (intent: "search") or submitting a new property listing to save (intent: "create_listing").',
    "Return strict JSON:",
    "{",
    '  "intent": "search | create_listing",',
    '  "filters": {',
    '    "property_type": "apartment | villa | townhouse | twinhouse | duplex | penthouse | studio | chalet | office | commercial | null",',
    '    "listing_type": "sale | rent | null",',
    '    "bedrooms": null,',
    '    "min_bedrooms": null,',
    '    "price_max": null,',
    '    "price_min": null,',
    '    "is_down_payment": false',
    "  },",
    '  "developer": null,',
    '  "is_multi_project_developer": false,',
    '  "location_terms": []',
    "}",
    CANONICAL_REAL_ESTATE_RULES
  ].join("\n");

  const parts = [{ text: searchPrompt }];
  if (text.trim()) {
    parts.push({ text: "\n--- INPUT ---\n" + text.trim() });
  }

  if (isVoice) {
    parts.push({
      inlineData: {
        mimeType: audio.mimeType || "audio/ogg",
        data: audio.buffer.toString("base64")
      }
    });
  }

  let parsed = { intent: "search", filters: {}, location_terms: [] };
  let usage = {};
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_ID,
      contents: parts,
      config: activeConfig
    });
    const resText = cleanJsonResponse(response.text);
    usage = response.usageMetadata || {};
    parsed = JSON.parse(resText);
  } catch (parseErr) {
    console.error("[SEARCH PARSE ERROR]:", parseErr.message);
    return sendWhatsAppText(
      from,
      "❌ تعذر فهم طلب البحث. يرجى توضيح المطلوب كنص أو تسجيل صوتي واضح."
    );
  }

  if (parsed.intent === "create_listing" && offset === 0) {
    return listingLimiter(function () {
      return processBatchedListing(broker, {
        from: from,
        texts: text ? [text] : [],
        audios: isVoice ? [audio] : [],
        images: []
      });
    });
  }

  lastSearchState.set(from, { text: text, audio: audio, offset: offset });

  const where = ["l.agency_id = $1", "l.status = 'active'"];
  const params = [broker.agency_id];
  let pIdx = 2;

  const filters = parsed.filters || {};

  if (filters.listing_type) {
    where.push("l.listing_type = $" + pIdx++);
    params.push(filters.listing_type);
  }

  if (filters.property_type) {
    where.push("l.property_type = $" + pIdx++);
    params.push(filters.property_type);
  }

  if (typeof filters.bedrooms === "number") {
    where.push("l.bedrooms = $" + pIdx++);
    params.push(filters.bedrooms);
  } else if (filters.min_bedrooms) {
    where.push("l.bedrooms >= $" + pIdx++);
    params.push(filters.min_bedrooms);
  }

  if (filters.is_down_payment) {
    if (filters.price_max) {
      where.push(
        "COALESCE((l.details->>'down_payment_value')::numeric, l.price_value) <= $" +
          pIdx++
      );
      params.push(filters.price_max);
    }
  } else {
    if (filters.price_max) {
      where.push("l.price_value <= $" + pIdx++);
      params.push(filters.price_max);
    }
    if (filters.price_min) {
      where.push("l.price_value >= $" + pIdx++);
      params.push(filters.price_min);
    }
  }

  const locationTerms = (parsed.location_terms || []).filter(Boolean);
  let firstLocParamIdx = null;
  if (locationTerms.length > 0) {
    const locationClauses = [];
    for (let i = 0; i < locationTerms.length; i++) {
      const term = locationTerms[i];
      if (firstLocParamIdx === null) firstLocParamIdx = pIdx;
      locationClauses.push(
        "(l.search_text_normalized LIKE ('%' || normalize_arabic($" +
          pIdx +
          ") || '%') OR similarity(l.search_text_normalized, normalize_arabic($" +
          pIdx +
          ")) > 0.35)"
      );
      params.push(term);
      pIdx++;
    }
    where.push("(" + locationClauses.join(" OR ") + ")");
  }

  params.push(SEARCH_PAGE_SIZE);
  const limitIdx = pIdx++;
  params.push(offset);
  const offsetIdx = pIdx++;

  const orderClause =
    firstLocParamIdx !== null
      ? "similarity(l.search_text_normalized, normalize_arabic($" +
        firstLocParamIdx +
        ")) DESC, l.created_at DESC"
      : "l.created_at DESC";

  const sql =
    "SELECT l.id, l.code, l.title, l.property_type, l.listing_type, " +
    "l.price_value, l.price_display, l.area_value, l.bedrooms, " +
    "l.location, l.compound, l.details, COUNT(*) OVER() AS total_count " +
    "FROM listings l " +
    "WHERE " +
    where.join(" AND ") +
    " " +
    "ORDER BY " +
    orderClause +
    " " +
    "LIMIT $" +
    limitIdx +
    " OFFSET $" +
    offsetIdx +
    ";";

  let rows = [];
  try {
    const dbRes = await pool.query(sql, params);
    rows = dbRes.rows;
  } catch (dbErr) {
    console.error("[SEARCH DB ERROR]:", dbErr.message);
    return sendWhatsAppText(from, "❌ حدث خطأ في قاعدة البيانات أثناء البحث.");
  }

  const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

  await pool.query(
    "INSERT INTO usage_events (agency_id, broker_id, phone, event_type, duration_ms, meta) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      broker.agency_id,
      broker.id,
      from,
      "search_inventory",
      Date.now() - startMs,
      {
        query_text: text || "[Voice Note]",
        results_count: totalCount,
        offset: offset,
        prompt_tokens: usage.promptTokenCount || 0,
        candidates_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0,
        model_used: modelLabel
      }
    ]
  );

  if (totalCount === 0) {
    return sendWhatsAppText(
      from,
      '🔍 *لم يتم العثور على وحدات مطابقة للبحث.*\n\n💡 *نصائح للبحث:*\n• جرب البحث باسم المنطقة أو الكمبوند فقط (مثل: _"شقة في ميفيدا"_).\n• قلل الشروط المحددة للسعر أو عدد الغرف.\n• تأكد من صحة أرقام الميزانية.'
    );
  }

  const responseLines = [];
  if (parsed.is_multi_project_developer && parsed.developer) {
    responseLines.push(
      "💡 *ملاحظة:* تم البحث في كافة مشروعات مطور *(" +
        parsed.developer +
        ')*. لتضييق النتائج، يمكنك تحديد المنطقة (مثال: _"' +
        parsed.developer +
        ' التجمع"_ أو _"' +
        parsed.developer +
        ' زايد"_).\n'
    );
  }

  const currentEnd = Math.min(offset + rows.length, totalCount);
  responseLines.push(
    "🔍 *نتائج البحث (" +
      (offset + 1) +
      " إلى " +
      currentEnd +
      " من أصل " +
      totalCount +
      " وحدة):*\n"
  );

  for (let i = 0; i < rows.length; i++) {
    const unit = rows[i];
    const details = unit.details || {};
    const shortSum = details.short_summary
      ? "\n   _" + details.short_summary + "_"
      : "";
    const downPayment = details.down_payment_value
      ? " | مقدم: *" +
        Number(details.down_payment_value).toLocaleString("en-US") +
        " ج*"
      : "";

    responseLines.push(
      "*" + (offset + i + 1) + ". #" + unit.code + "* - " + unit.title,
      "   💰 السعر: *" + unit.price_display + "*" + downPayment,
      "   📐 المساحة: " +
        (unit.area_value ? unit.area_value + " م²" : "-") +
        " | 🛏️ الغرف: " +
        (unit.bedrooms || "-"),
      "   📍 الموقع: " + (unit.location || "-") + shortSum,
      "   📄 للكتالوج: كتالوج " + unit.code + " | 📲 للعميل: عميل " + unit.code,
      ""
    );
  }

  if (currentEnd < totalCount) {
    responseLines.push(
      "━━━━━━━━━━━━━━━━━━━━",
      "➡️ لعرض الـ 10 وحدات التالية، أرسل: *المزيد*"
    );
  }

  return sendWhatsAppText(from, responseLines.join("\n"));
}

// ---------------------------------------------------------------------------
// 3. COMMAND ROUTING: handleSingleMessage
// ---------------------------------------------------------------------------
async function handleSingleMessage(broker, message) {
  const from = broker.phone;
  const msgType = message.type;

  // 1. Image Uploads
  if (msgType === "image") {
    const mediaId = message.image && message.image.id;
    const caption =
      message.image && message.image.caption
        ? message.image.caption.trim()
        : "";
    const downloaded = await downloadWhatsAppMedia(mediaId);
    if (!downloaded) return;

    enqueueToBatch(broker, {
      text: caption || null,
      image: {
        buffer: downloaded.buffer,
        mimeType: downloaded.mimeType
      }
    });
    return;
  }

  // 2. Audio Voice Notes
  if (msgType === "audio") {
    const mediaId = message.audio && message.audio.id;
    const duration =
      message.audio && message.audio.duration
        ? Number(message.audio.duration)
        : 0;
    const downloaded = await downloadWhatsAppMedia(mediaId);
    if (!downloaded) return;

    const audioObj = {
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      duration: duration
    };

    if (isBatchingActive(from)) {
      enqueueToBatch(broker, { audio: audioObj });
      return;
    }

    return handleSearchMessage(broker, { audio: audioObj, offset: 0 });
  }

  if (msgType !== "text") return;

  const rawText = (
    message.text && message.text.body ? message.text.body : ""
  ).trim();
  if (!rawText) return;

  if (isBatchingActive(from)) {
    enqueueToBatch(broker, { text: rawText });
    return;
  }

  const lower = rawText.toLowerCase();

  // 3. Help Command
  if (["help", "مساعدة", "اوامر", "قواعد", "تعليمات"].includes(lower)) {
    return sendWhatsAppText(from, getHelpMessage());
  }

  // 4. Pagination: المزيد
  if (rawText === "المزيد" || lower === "more") {
    const prev = lastSearchState.get(from);
    if (!prev) {
      return sendWhatsAppText(
        from,
        "⚠️ لا يوجد بحث سابق لعرض المزيد من نتائجه."
      );
    }
    return handleSearchMessage(broker, {
      text: prev.text,
      audio: prev.audio,
      offset: prev.offset + SEARCH_PAGE_SIZE
    });
  }

  // 5. Broker Statistics: احصائيات
  if (rawText === "احصائيات" || rawText === "إحصائيات" || lower === "stats") {
    const statsRes = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_count, COUNT(*) FILTER (WHERE status = 'sold') AS sold_count, COUNT(*) FILTER (WHERE status = 'archived') AS archived_count FROM listings WHERE agency_id = $1",
      [broker.agency_id]
    );
    const st = statsRes.rows[0] || {};
    return sendWhatsAppText(
      from,
      [
        "📊 *إحصائيات مخزون الوكالة:*",
        "• الوحدات النشطة: *" + (st.active_count || 0) + "*",
        "• الوحدات المباعة: *" + (st.sold_count || 0) + "*",
        "• الوحدات المؤرشفة: *" + (st.archived_count || 0) + "*"
      ].join("\n")
    );
  }

  // 6. CSV Export: اكسيل
  if (
    rawText === "اكسيل" ||
    rawText === "إكسيل" ||
    lower === "excel" ||
    lower === "csv"
  ) {
    const csvRes = await pool.query(
      "SELECT code, title, property_type, listing_type, price_display, area_value, bedrooms, location, status FROM listings WHERE agency_id = $1 ORDER BY created_at DESC LIMIT 500",
      [broker.agency_id]
    );
    if (csvRes.rowCount === 0) {
      return sendWhatsAppText(from, "⚠️ لا توجد وحدات مسجلة لتصديرها.");
    }
    const header = "Code,Title,Type,Offer,Price,Area,Bedrooms,Location,Status";
    const lines = csvRes.rows.map(function (r) {
      return [
        r.code,
        '"' + String(r.title || "").replace(/"/g, '""') + '"',
        r.property_type,
        r.listing_type,
        '"' + String(r.price_display || "") + '"',
        r.area_value || "",
        r.bedrooms || "",
        '"' + String(r.location || "").replace(/"/g, '""') + '"',
        r.status
      ].join(",");
    });
    const csvContent = "\uFEFF" + [header].concat(lines).join("\n");
    return sendWhatsAppDocument(
      from,
      Buffer.from(csvContent, "utf8"),
      "inventory_" + Date.now() + ".csv",
      "📊 ملف إكسيل يحتوي على أحدث الوحدات المسجلة."
    );
  }

  // 7. Price Update: سعر [كود] إلى [السعر]
  const priceMatch = rawText.match(
    /^سعر\s+#?([A-Z0-9-]+)\s+(?:إلى|الى|ل)\s+(.+)$/i
  );
  if (priceMatch) {
    const code = priceMatch[1].toUpperCase();
    const parsedPrice = parseEgyptianPrice(priceMatch[2]);
    const upd = await pool.query(
      "UPDATE listings SET price_value = $1, price_display = $2, updated_at = NOW() WHERE agency_id = $3 AND code = $4 RETURNING code, price_display",
      [parsedPrice.priceValue, parsedPrice.priceDisplay, broker.agency_id, code]
    );
    if (upd.rowCount === 0) {
      return sendWhatsAppText(
        from,
        "❌ لم يتم العثور على عقار بالكود: #" + code
      );
    }
    return sendWhatsAppText(
      from,
      "✅ تم تحديث سعر العقار *#" +
        code +
        "* إلى *" +
        upd.rows[0].price_display +
        "*."
    );
  }

  // 8. Client Brochure Forwarding: كتالوج عميل [كود]
  const clientBrochureMatch = rawText.match(
    /^(?:كتالوج\s+عميل|بروشور\s+عميل)\s+#?([A-Z0-9-]+)$/i
  );
  if (clientBrochureMatch) {
    const code = clientBrochureMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        "❌ لم يتم العثور على عقار بالكود: #" + code
      );
    }

    const listing = res.rows[0];
    const clientText = formatClientListingText(listing, broker);

    if (listing.flyer_url) {
      return sendWhatsAppImage(
        from,
        listing.flyer_url + "?t=" + Date.now(),
        clientText
      );
    }
    return sendWhatsAppText(from, clientText);
  }

  // 9. Client Text Forwarding: عميل [كود]
  const clientTextMatch = rawText.match(/^عميل\s+#?([A-Z0-9-]+)$/i);
  if (clientTextMatch) {
    const code = clientTextMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        "❌ لم يتم العثور على عقار بالكود: #" + code
      );
    }

    const listing = res.rows[0];
    const clientText = formatClientListingText(listing, broker);
    return sendWhatsAppText(from, clientText);
  }

  // 10. Internal Flyer Command: كتالوج [كود]
  const flyerMatch = rawText.match(/^كتالوج\s+#?([A-Z0-9-]+)$/i);
  if (flyerMatch) {
    const code = flyerMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT code, title, price_display, flyer_url FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        "❌ لم يتم العثور على عقار بالكود: #" + code
      );
    }

    const listing = res.rows[0];
    if (!listing.flyer_url) {
      return sendWhatsAppText(
        from,
        "⚠️ العقار رقم *#" + code + "* مسجل بدون صور ولا يوجد كتالوج له."
      );
    }

    return sendWhatsAppImage(
      from,
      listing.flyer_url + "?t=" + Date.now(),
      "📄 كتالوج العقار رقم *#" +
        listing.code +
        "*\n" +
        listing.title +
        "\n💰 السعر: " +
        listing.price_display
    );
  }

  // 11. Internal Listing Details Command: #[كود]
  const internalDetailsMatch = rawText.match(/^#([A-Z0-9-]+)$/i);
  if (internalDetailsMatch) {
    const code = internalDetailsMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        "❌ لم يتم العثور على عقار بالكود: #" + code
      );
    }

    return sendWhatsAppText(from, formatInternalListingDetails(res.rows[0]));
  }

  // 12. Status Updates: تم البيع [كود], ارشيف [كود], تفعيل [كود]
  const statusMatch = rawText.match(
    /^(تم البيع|ارشيف|تفعيل)\s+#?([A-Z0-9-]+)$/i
  );
  if (statusMatch) {
    const action = statusMatch[1];
    const code = statusMatch[2].toUpperCase();
    let newStatus = "active";

    if (action === "تم البيع") newStatus = "sold";
    if (action === "ارشيف") newStatus = "archived";

    const updateRes = await pool.query(
      "UPDATE listings SET status = $1, updated_at = NOW() WHERE agency_id = $2 AND code = $3 RETURNING code",
      [newStatus, broker.agency_id, code]
    );

    if (updateRes.rowCount === 0) {
      return sendWhatsAppText(
        from,
        "❌ تعذر تحديث العقار. تأكد من صحة الكود: #" + code
      );
    }

    return sendWhatsAppText(
      from,
      "✅ تم تحديث حالة العقار *#" + code + "* إلى: *" + action + "*."
    );
  }

  // 13. General Search / Listing Intent
  return handleSearchMessage(broker, { text: rawText, offset: 0 });
}

// ---------------------------------------------------------------------------
// 4. WEBHOOK ENDPOINTS
// ---------------------------------------------------------------------------
app.post("/webhook", function (req, res) {
  res.status(200).send("EVENT_RECEIVED");

  setImmediate(async function () {
    try {
      const entry = req.body && req.body.entry && req.body.entry[0];
      const change =
        entry && entry.changes && entry.changes[0] && entry.changes[0].value;
      const messages = change && change.messages ? change.messages : [];

      if (messages.length === 0) return;

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const from = message.from;
        if (!from) continue;

        const brokerRes = await pool.query(
          "SELECT id, agency_id, name, phone, role FROM brokers WHERE phone = $1",
          [from]
        );

        if (brokerRes.rowCount === 0) {
          await sendWhatsAppText(
            from,
            "⚠️ رقم الهاتف غير مسجل في أي وكالة عقارية معتمدة. يرجى مراجعة إدارة شركتك لإضافتك."
          );
          continue;
        }

        const broker = brokerRes.rows[0];
        await pool.query(
          "UPDATE brokers SET last_active_at = NOW() WHERE id = $1",
          [broker.id]
        );
        await handleSingleMessage(broker, message);
      }
    } catch (err) {
      console.error("[WEBHOOK ASYNC PROCESSING ERROR]:", err);
    }
  });
});

app.get("/webhook", function (req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("🚀 Real Estate WhatsApp Engine online on port " + PORT);
});
