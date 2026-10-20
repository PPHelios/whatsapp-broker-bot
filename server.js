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

function getPropertyTypeCode(propertyType = "") {
  const norm = propertyType.trim();
  if (/شقة|شقه/i.test(norm)) return "APT";
  if (/فيلا/i.test(norm)) return "VIL";
  if (/دوبلكس/i.test(norm)) return "DUP";
  if (/تاون|توين/i.test(norm)) return "TWN";
  if (/بنتهاوس/i.test(norm)) return "PNT";
  if (/مكتب|إداري/i.test(norm)) return "OFF";
  if (/محل|تجاري/i.test(norm)) return "COM";
  if (/عيادة|عياده/i.test(norm)) return "CLN";
  if (/شاليه/i.test(norm)) return "CHL";
  if (/أرض|ارض/i.test(norm)) return "LND";
  if (/عمارة|عماره/i.test(norm)) return "BLD";
  if (/استوديو/i.test(norm)) return "STD";
  return "UNT";
}

/**
 * Generates an ASCII-only listing code or sanitizes a broker-supplied code.
 */
function generateSafeListingCode(brokerCode, propertyType) {
  // If broker sent a custom alphanumeric code (e.g., "gj765")
  if (brokerCode && typeof brokerCode === "string") {
    const clean = brokerCode
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .toUpperCase();
    if (clean.length >= 3) {
      return `RK-${clean}`;
    }
  }

  // Fallback auto-generated ASCII code: e.g. RK-APT-49102
  const prefix = getPropertyTypeCode(propertyType);
  const randomNum = Math.floor(10000 + Math.random() * 90000);
  return `RK-${prefix}-${randomNum}`;
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

/**
 * Compresses, auto-orients, and resizes raw listing images in parallel.
 * Produces a unified 1280px web-optimized JPEG buffer reused across both
 * Gemini multimodal ingestion and Supabase public storage uploads.
 *
 * @param {Array<Object>} rawImages - Array of objects with image buffers (e.g. { buffer, mimeType })
 * @param {number} [maxCount] - Maximum image count cap (defaults to MAX_VISION_EVAL_IMAGES)
 * @returns {Promise<Array<{ buffer: Buffer, mimeType: string }>>}
 */
async function prepareImagesForGemini(rawImages, maxCount) {
  const limit =
    typeof maxCount === "number" ? maxCount : MAX_VISION_EVAL_IMAGES;
  const candidates = rawImages.slice(0, limit);

  return Promise.all(
    candidates.map(async function (img) {
      if (!img || !img.buffer) return null;

      try {
        const compressedBuffer = await sharp(img.buffer)
          .rotate() // Automatically corrects EXIF orientation from mobile phone cameras
          .resize({
            width: 1280,
            height: 1280,
            fit: "inside",
            withoutEnlargement: true
          })
          .jpeg({ quality: 80, mozjpeg: true })
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
        return {
          buffer: img.buffer,
          mimeType: img.mimeType || "image/jpeg"
        };
      }
    })
  ).then(function (results) {
    return results.filter(Boolean);
  });
}

// ---------------------------------------------------------------------------
// MULTI-MESSAGE DEBOUNCE BATCHER (Collects multi-photo bursts over 8s)
// ---------------------------------------------------------------------------
function isBatchingActive(phone) {
  return incomingBatches.has(phone);
}

/**
 * Queues incoming media, audio, or text items into a debounce batch per broker.
 * Enforces audio duration constraints, handles early batch buffering acknowledgment,
 * prunes excess image uploads beyond MAX_VISION_EVAL_IMAGES, and handles batch failures.
 *
 * @param {Object} broker - The broker database record
 * @param {Object} item - Payload containing text, audio, and/or image
 */
function enqueueToBatch(broker, item) {
  const phone = broker.phone;
  let batch = incomingBatches.get(phone);

  if (!batch) {
    batch = {
      broker: broker,
      from: phone,
      texts: [],
      audios: [],
      voices: [], // Aliased to audios for full compatibility
      images: [],
      timer: null
    };
    incomingBatches.set(phone, batch);

    // Immediate non-blocking acknowledgment sent only on first buffered item
    sendWhatsAppText(
      phone,
      "📥 تم استلام الملفات، بانتظار اكتمال التحميل لبدء المعالجة..."
    ).catch((err) =>
      console.error("[WHATSAPP RECEPTION ACK ERROR]:", err.message)
    );
  }

  // 1. Ingest text descriptions or captions
  if (item.text) {
    batch.texts.push(item.text);
  }

  // 2. Validate and ingest audio recordings against MAX_LISTING_AUDIO_SEC
  if (item.audio) {
    const duration =
      item.audio.duration || item.audio.seconds || item.duration || 0;

    if (
      typeof MAX_LISTING_AUDIO_SEC === "number" &&
      MAX_LISTING_AUDIO_SEC > 0 &&
      duration > MAX_LISTING_AUDIO_SEC
    ) {
      console.warn(
        `[AUDIO EXCEEDED LIMIT]: ${duration}s exceeds max limit of ${MAX_LISTING_AUDIO_SEC}s for broker ${phone}`
      );
      sendWhatsAppText(
        phone,
        `⚠️ تم تجاوز الحد الأقصى المسموح للتسجيل الصوتي (${MAX_LISTING_AUDIO_SEC} ثانية). يرجى إرسال تسجيل مختصر لضمان استخراج المواصفات بدقة.`
      ).catch((err) => console.error("[WHATSAPP NOTIFICATION ERROR]:", err));
    } else {
      batch.audios.push(item.audio);
      batch.voices.push(item.audio);
    }
  }

  // 3. Ingest listing images with buffer overflow protection
  if (item.image) {
    const maxImages =
      typeof MAX_VISION_EVAL_IMAGES === "number" ? MAX_VISION_EVAL_IMAGES : 15;

    if (batch.images.length < maxImages) {
      batch.images.push(item.image);
    } else if (batch.images.length === maxImages) {
      // Push placeholder/flag to avoid repeated alerts on subsequent images in the same batch
      batch.images.push({ overflowAlerted: true });
      console.warn(
        `[IMAGE OVERFLOW]: Batch for broker ${phone} reached cap of ${maxImages} images. Excess ignored.`
      );
      sendWhatsAppText(
        phone,
        `⚠️ تم استلام الحد الأقصى من الصور (${maxImages} صور). سيتم تجاهل أي صور إضافية للحفاظ على سرعة المعالجة وجودة الكتالوج.`
      ).catch((err) =>
        console.error("[WHATSAPP IMAGE OVERFLOW ALERT ERROR]:", err.message)
      );
    }
  }

  // 4. Reset debounce timer
  if (batch.timer) clearTimeout(batch.timer);

  batch.timer = setTimeout(async function () {
    const finalizedBatch = incomingBatches.get(phone);
    incomingBatches.delete(phone);
    if (!finalizedBatch) return;

    // Remove any overflow marker items before processing
    finalizedBatch.images = finalizedBatch.images.filter(
      (img) => img && img.buffer
    );

    try {
      await listingLimiter(function () {
        return processBatchedListing(finalizedBatch.broker, finalizedBatch);
      });
    } catch (err) {
      console.error("[BATCH EXECUTION ERROR]:", err);
      // Inform the broker directly on WhatsApp so they are never left waiting
      try {
        await sendWhatsAppText(
          finalizedBatch.from,
          "❌ حدث خطأ غير متوقع أثناء معالجة وحفظ العقار وإنشاء الكتالوج. يرجى إعادة المحاولة أو التواصل مع الدعم الفني."
        );
      } catch (notifyErr) {
        console.error("[FAILED TO SEND ERROR NOTICE TO BROKER]:", notifyErr);
      }
    }
  }, BATCH_DEBOUNCE_MS);
}
/**
 * Executes a Gemini generateContent request with automatic retry on 503/429
 * and optional fallback model routing.
 */
async function generateContentWithRetry({
  contents,
  config,
  primaryModel = "gemini-3.8-flash",
  fallbackModel = "gemini-3.5-flash-lite",
  maxRetries = 3
}) {
  let attempt = 0;
  let currentModel = primaryModel;

  while (attempt < maxRetries) {
    try {
      return await ai.models.generateContent({
        model: currentModel,
        contents: contents,
        config: config
      });
    } catch (err) {
      attempt++;
      const errStr = String(err?.message || JSON.stringify(err));
      const isTransient =
        errStr.includes("503") ||
        errStr.includes("UNAVAILABLE") ||
        errStr.includes("429") ||
        errStr.includes("RESOURCE_EXHAUSTED");

      if (!isTransient || attempt >= maxRetries) {
        // If primary model failed repeatedly on 503, attempt 1 final shot with fallback model
        if (currentModel !== fallbackModel && fallbackModel) {
          console.warn(
            `[GEMINI 503 SPIKE] Switching from ${currentModel} to fallback ${fallbackModel}...`
          );
          currentModel = fallbackModel;
          attempt = 0; // reset attempts for fallback
          continue;
        }
        throw err;
      }

      // Exponential backoff with jitter: 1.5s, 3s, 6s...
      const delayMs =
        Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
      console.warn(
        `[GEMINI RETRY] Attempt ${attempt}/${maxRetries} failed with 503/429. Retrying in ${delayMs}ms...`
      );
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
}
// ---------------------------------------------------------------------------
// 1. INGESTION PIPELINE: processBatchedListing
// ---------------------------------------------------------------------------
/**
 * Processes a batched property listing submission (photos + text/voice).
 * Handles AI multimodal extraction, image storage, brochure rendering,
 * atomic database persistence (via PostgreSQL transaction), and WhatsApp responses.
 *
 * Implements:
 * - Option B: Single-pass optimized buffer pipeline via prepareImagesForGemini.
 * - Broker language resolution (ar / en / bilingual).
 * - Existing listing detection with image addition ('إضافة') vs. replacement ('استبدال').
 * - Dynamic feedback for voice/text-only listings with clear instructions to attach photos.
 *
 * @param {Object} broker - The broker record from DB (id, agency_id, phone, contact_phone, role, preferred_lang, etc.)
 * @param {Object} batch - The aggregated incoming batch (from, texts, voices/audios, images, customCode)
 */
async function processBatchedListing(broker, batch) {
  const from = batch.from;
  const startTime = Date.now();

  // Combine text items to detect language overrides and operation commands
  const combinedInputText = [
    ...(batch.texts || []),
    batch.customCode || ""
  ].join(" ");

  // 1. Resolve target language (Explicit input keyword > broker.preferred_lang > 'ar')
  let targetLang = broker.preferred_lang || "ar";
  if (/\b(en|english|انجليزي|إنجليزي)\b/i.test(combinedInputText)) {
    targetLang = "en";
  } else if (
    /\b(bilingual|global|مزدوج|عربي وانجليزي|عربي وإنجليزي)\b/i.test(
      combinedInputText
    )
  ) {
    targetLang = "bilingual";
  } else if (/\b(ar|arabic|عربي)\b/i.test(combinedInputText)) {
    targetLang = "ar";
  }

  // Detect update intent: 'استبدال' (replace) vs. default 'إضافة' (append)
  const isReplaceMode = /\b(استبدال|replace)\b/i.test(combinedInputText);

  const hasImages = Boolean(batch.images && batch.images.length > 0);

  // 2. Dynamic initial acknowledgement based on media presence and language
  if (hasImages) {
    await sendWhatsAppText(
      from,
      targetLang === "en"
        ? "⏳ Verifying property details and designing brochure flyer..."
        : "⏳ جاري فحص البيانات والمواصفات وتصميم الكتالوج الاحترافي..."
    );
  } else {
    await sendWhatsAppText(
      from,
      targetLang === "en"
        ? "⏳ Extracting property specifications and saving unit record..."
        : "⏳ جاري استخراج مواصفات الوحدة وحفظ البيانات..."
    );
  }

  try {
    // -------------------------------------------------------------------------
    // STEP 1: PREPARE MULTIMODAL PAYLOAD (Images + Text + Transcribed Voice)
    // -------------------------------------------------------------------------
    const parts = [];

    // System instruction and structural schema enforcement prompt with language support
    parts.push({
      text: `أنت نظام تدقيق واستخراج بيانات عقارية عالي الدقة لمنصة وساطة معتمدة.
مهمتك استخراج مواصفات الوحدة العقارية بدقة متناهية وإخراجها حصراً في صيغة JSON صالحة.

اللغة المطلوبة للمخرجات (TARGET OUTPUT LANGUAGE): "${targetLang}"
- إذا كانت اللغة "en": يجب صياغة (title) و (details.clean_summary) و (details.features) باللغة الإنجليزية العقارية الاحترافية حصراً.
- إذا كانت اللغة "ar": يجب الصياغة باللغة العربية الفصحى المعتمدة.
- إذا كانت اللغة "bilingual": يجب توفير النص العربي متبوعاً بالترجمة الإنجليزية داخل نفس الحقول النصية.

==================================================
قواعد الأسبقية ومصدر الحقيقة (CRITICAL HIERARCHY RULES):
==================================================
1. الملاحظات الصوتية والنصوص المكتوبة هي "المصدر الوحيد والمطلق للحقيقة" (Single Source of Truth):
   - جميع البيانات الأساسية (نوع العقار، السعر، المساحة، عدد الغرف، الموقع، الكمبوند، نوع التشطيب، كود الوحدة) يجب استخراجها حصراً من النص أو التسجيل الصوتي.
   - إذا ذكر النص أو الصوت أن الوحدة "3 غرف" أو "نصف تشطيب"، اعتمد ذلك تماماً حتى لو بدت الصور توحي بخلاف ذلك.

2. الصور المرفقة مخصصة للعرض فقط (Visual Presentation Only):
   - الصور قد تكون صوراً عامة (Generic / Stock)، أو تصاميم 3D تخيلية، أو صوراً للكمبوند وليست للوحدة ذاتها.
   - يُمنع منعاً باتاً استنتاج أو تخمين أو افتراض أي مواصفات (مثل عدد الغرف، المساحة، أو مستوى التشطيب، أو الموقع) استناداً إلى الصور إذا لم تُذكر في النص أو الصوت.
   - دور الصور ينحصر فقط في تقييم جودة الإضاءة والزوايا لترتيب أفضل الصور للبروشور في مصفوفة (image_order).

3. منع التخمين والهلوسة (Zero Hallucination):
   - أي حقل غير مذكور صراحة في النص أو التسجيل الصوتي، اتركه null أو فارغاً ""، ولا تقم بملئه من وحي الصور أو التخمين.

==================================================
حقول الإخراج المطلوبة (JSON Schema):
==================================================
{
  "custom_code": "أي كود خاص ذكره الوسيط للوحدة نصياً أو صوتياً (مثال: gj765 أو ref-20)، وإن لم يذكر اتركه null",
  "title": "عنوان تسويقي رسمي جذاب مستوحى من النص/الصوت فقط",
  "property_type": "نوع الوحدة من النص/الصوت (شقة, فيلا, دوبلكس, مكتب, محل, إلخ)",
  "listing_type": "'sale' أو 'rent' بناء على النص/الصوت فقط (افتراضي 'sale')",
  "price_value": "القيمة الرقمية المجردة للسعر كما وردت نصاً أو صوتاً (رقم فقط بدون نصوص، أو null)",
  "price_display": "السعر المنسق مع العملة (مثال: '19,200,000 ج.م' أو null)",
  "area_value": "المساحة كرقم مجرد بالمتر المربع المذكورة نصاً/صوتاً فقط، أو null",
  "bedrooms": "عدد الغرف المذكورة نصاً/صوتاً فقط كرقم، أو null",
  "location": "المدينة أو الحي المذكور في النص/الصوت",
  "compound": "اسم الكمبوند أو المشروع المذكور في النص/الصوت، أو ''",
  "district": "المنطقة أو الحي بالتفصيل",
  "city": "المدينة الرئيسية المذكورة",
  "location_keywords": ["مصفوفة كلمات مفتاحية جغرافية مستخلصة من النص والصوت فقط"],
  "details": {
    "clean_summary": "صياغة تنفيذية منسقة لما ورد في الوصف والنص الصوتي فقط دون أي إضافات خارجية",
    "features": ["مصفوفة لأبرز 3-5 مميزات ذُكرت في النص أو الصوت فقط"],
    "installment_years": "عدد سنوات التقسيط كرقم إن ذكرت، أو null",
    "down_payment_value": "قيمة المقدم كرقم إن ذكرت، أو null",
    "image_order": [مصفوفة أرقام تبدأ من 0 تمثل أفضل ترتيب لصور المعرض في البروشور حسب وضوح الكادر وجودة الصورة]
  }
}`
    });

    // A. Primary Source of Truth: Explicit text notes from the broker
    if (batch.texts && batch.texts.length > 0) {
      parts.push({
        text: `--- [EXPLICIT BROKER TEXT - SINGLE SOURCE OF TRUTH] ---\n${batch.texts.join(
          "\n\n"
        )}`
      });
    }

    // B. Secondary Source of Truth: Audio recordings (treated as ground truth)
    const rawAudioItems = batch.voices || batch.audios || [];
    if (rawAudioItems.length > 0) {
      parts.push({
        text: `--- [BROKER AUDIO RECORDINGS - SINGLE SOURCE OF TRUTH] ---`
      });
      for (const voiceItem of rawAudioItems) {
        if (!voiceItem.buffer) continue;
        parts.push({
          inlineData: {
            mimeType: voiceItem.mimeType || "audio/ogg",
            data: voiceItem.buffer.toString("base64")
          }
        });
      }
    }

    // C. Attached Images: Parallel single-pass compression via prepareImagesForGemini
    let optimizedImages = [];
    if (hasImages) {
      parts.push({
        text: `--- [ATTACHED IMAGES - FOR DISPLAY AND BROCHURE CURATION ONLY. DO NOT INFER PROPERTY SPECS UNLESS EXPLICITLY STATED ABOVE] ---`
      });

      const rawValidImages = batch.images.filter(function (img) {
        return img && img.buffer;
      });

      optimizedImages = await prepareImagesForGemini(
        rawValidImages,
        typeof MAX_VISION_EVAL_IMAGES === "number" ? MAX_VISION_EVAL_IMAGES : 15
      );

      for (const imgObj of optimizedImages) {
        parts.push({
          inlineData: {
            mimeType: imgObj.mimeType || "image/jpeg",
            data: imgObj.buffer.toString("base64")
          }
        });
      }
    }

    // -------------------------------------------------------------------------
    // STEP 2: CALL GEMINI WITH RESILIENT RETRY & FALLBACK
    // -------------------------------------------------------------------------
    let draftData = {};
    let usage = {};

    try {
      const response = await generateContentWithRetry({
        contents: parts,
        config: LISTING_CONFIG,
        primaryModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        fallbackModel: "gemini-3.5-flash-lite",
        maxRetries: 3
      });

      const resText = cleanJsonResponse(response.text);
      usage = response.usageMetadata || {};
      draftData = JSON.parse(resText);
    } catch (aiErr) {
      console.error("[MULTIMODAL EXTRACTION ERROR]:", aiErr.message);
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "⚠️ AI extraction is experiencing temporary high demand. Please resend the unit in a moment."
          : "⚠️ خوادم الذكاء الاصطناعي تشهد ضغطاً مؤقتاً في الوقت الحالي. يرجى إعادة إرسال الوحدة بعد لحظات."
      );
    }

    // -------------------------------------------------------------------------
    // STEP 3: CHECK IF UNIT EXISTS (UPDATE PATH VS. INSERT PATH)
    // -------------------------------------------------------------------------
    const unitPrefix = generateSafeListingCode(
      draftData.custom_code || batch.customCode,
      draftData.property_type
    );

    const existingListingRes = await pool.query(
      "SELECT id, code, flyer_url, title, property_type, listing_type, price_value, price_display, area_value, bedrooms, location, details FROM listings WHERE agency_id = $1 AND code = $2 LIMIT 1",
      [broker.agency_id, unitPrefix]
    );
    const existingListing = existingListingRes.rows[0];

    // Fetch agency branding assets for flyer generation
    const agencyRes = await pool.query(
      "SELECT id, name, logo_url, primary_color, secondary_color FROM agencies WHERE id = $1 LIMIT 1",
      [broker.agency_id]
    );
    const agency = agencyRes.rows[0] || {};

    // =========================================================================
    // BRANCH A: EXISTING UNIT - UPDATE PHOTOS & RE-RENDER FLYER
    // =========================================================================
    if (existingListing && hasImages) {
      const uploadPromises = optimizedImages.map(function (imgObj, i) {
        return uploadListingImage(
          broker.agency_id,
          `${unitPrefix}-${Date.now()}-${i + 1}`,
          imgObj.buffer
        );
      });

      const uploadResults = await Promise.all(uploadPromises);
      const newUploadedUrls = uploadResults.filter(Boolean);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        let currentPosition = 0;
        if (isReplaceMode) {
          // Replace strategy: remove existing image rows
          await client.query(
            "DELETE FROM listing_images WHERE listing_id = $1",
            [existingListing.id]
          );
        } else {
          // Append strategy: determine next position offset
          const maxPosRes = await client.query(
            "SELECT COALESCE(MAX(position), -1) AS max_pos FROM listing_images WHERE listing_id = $1",
            [existingListing.id]
          );
          currentPosition = Number(maxPosRes.rows[0].max_pos) + 1;
        }

        // Insert new image records
        for (let i = 0; i < newUploadedUrls.length; i++) {
          await client.query(
            `INSERT INTO listing_images (listing_id, agency_id, url, position)
             VALUES ($1, $2, $3, $4)`,
            [
              existingListing.id,
              broker.agency_id,
              newUploadedUrls[i],
              currentPosition + i
            ]
          );
        }

        // Query all active image URLs ordered by position
        const allImagesRes = await client.query(
          "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 15",
          [existingListing.id]
        );
        const allImageUrls = allImagesRes.rows.map((r) => r.url);

        // Re-generate flyer with full image array and target language
        let updatedFlyerUrl = existingListing.flyer_url;
        if (allImageUrls.length > 0) {
          try {
            const flyerBuffer = await generateFlyerBuffer({
              listing: {
                code: existingListing.code,
                title: existingListing.title,
                listing_type: existingListing.listing_type,
                price_value: existingListing.price_value,
                price_display: existingListing.price_display,
                area_value: existingListing.area_value,
                bedrooms: existingListing.bedrooms,
                location: existingListing.location,
                details: existingListing.details || {}
              },
              agency: agency,
              images: allImageUrls,
              lang: targetLang
            });

            if (flyerBuffer) {
              updatedFlyerUrl = await uploadFlyerImage(
                broker.agency_id,
                `${unitPrefix}-flyer-${Date.now()}`,
                flyerBuffer
              );
            }
          } catch (flyerErr) {
            console.error("[FLYER UPDATE RE-RENDER ERROR]:", flyerErr);
          }
        }

        // Update listing record
        await client.query(
          `UPDATE listings
           SET flyer_url = $1, updated_at = NOW()
           WHERE id = $2`,
          [updatedFlyerUrl, existingListing.id]
        );

        // Record update telemetry
        await client.query(
          `INSERT INTO usage_events (agency_id, broker_id, phone, event_type, listing_id, duration_ms, meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            broker.agency_id,
            broker.id,
            from,
            "listing_image_update",
            existingListing.id,
            Date.now() - startTime,
            JSON.stringify({
              mode: isReplaceMode ? "replace" : "append",
              added_count: newUploadedUrls.length,
              total_count: allImageUrls.length,
              has_flyer: Boolean(updatedFlyerUrl)
            })
          ]
        );

        await client.query("COMMIT");

        // Send updated flyer image to broker
        if (updatedFlyerUrl) {
          await sendWhatsAppImage(
            from,
            updatedFlyerUrl,
            targetLang === "en"
              ? `📋 Updated Brochure - Unit #${existingListing.code}`
              : `📋 كتالوج تسويقي محدث - كود الوحدة: #${existingListing.code}`
          );
        }

        const updateConfirmText =
          targetLang === "en"
            ? `✅ Successfully ${
                isReplaceMode ? "replaced" : "added"
              } photos for unit *#${
                existingListing.code
              }*.\nTotal active photos: *${allImageUrls.length}*.`
            : `✅ تم ${isReplaceMode ? "استبدال" : "إضافة"} صور الوحدة *#${
                existingListing.code
              }* بنجاح.\nإجمالي الصور المعتمدة: *${allImageUrls.length}* صورة.`;

        await sendWhatsAppText(from, updateConfirmText);
        return;
      } catch (updateDbErr) {
        await client.query("ROLLBACK");
        console.error("[UPDATE TRANSACTION FAILED]:", updateDbErr);
        throw updateDbErr;
      } finally {
        client.release();
      }
    }

    // =========================================================================
    // BRANCH B: NEW LISTING - ATOMIC CREATION & STORAGE
    // =========================================================================
    let uploadedUrls = [];
    if (hasImages && optimizedImages.length > 0) {
      const uploadPromises = optimizedImages.map(function (imgObj, i) {
        return uploadListingImage(
          broker.agency_id,
          `${unitPrefix}-${i + 1}`,
          imgObj.buffer
        );
      });

      const uploadResults = await Promise.all(uploadPromises);
      uploadedUrls = uploadResults.filter(Boolean);
    }

    // Generate brochure flyer only if images were successfully uploaded
    let flyerStorageUrl = null;
    let flyerBuffer = null;

    if (uploadedUrls.length > 0) {
      try {
        flyerBuffer = await generateFlyerBuffer({
          listing: {
            code: unitPrefix,
            title: draftData.title,
            listing_type: draftData.listing_type,
            price_value: draftData.price_value,
            price_display: draftData.price_display,
            area_value: draftData.area_value,
            bedrooms: draftData.bedrooms,
            location: draftData.location,
            details: draftData.details || {}
          },
          agency: agency,
          images: uploadedUrls,
          lang: targetLang
        });

        if (flyerBuffer) {
          flyerStorageUrl = await uploadFlyerImage(
            broker.agency_id,
            `${unitPrefix}-flyer`,
            flyerBuffer
          );
        }
      } catch (flyerErr) {
        console.error("[FLYER RENDER/UPLOAD ERROR]:", flyerErr);
      }
    }

    // Atomic Database Insertion for New Listing
    const client = await pool.connect();
    let savedListing = null;

    try {
      await client.query("BEGIN");

      // Embed language preference into the details JSON payload
      const listingDetails = Object.assign({}, draftData.details || {}, {
        lang: targetLang
      });

      const insertListingSql = `
        INSERT INTO listings (
          agency_id,
          broker_id,
          code,
          title,
          property_type,
          listing_type,
          price_value,
          price_display,
          area_value,
          bedrooms,
          location,
          compound,
          district,
          city,
          location_keywords,
          details,
          flyer_url,
          status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'active'
        )
        RETURNING *;
      `;

      const listingRes = await client.query(insertListingSql, [
        broker.agency_id,
        broker.id,
        unitPrefix,
        draftData.title ||
          (targetLang === "en" ? "Residential Property" : "وحدة سكنية معروضة"),
        draftData.property_type || (targetLang === "en" ? "Apartment" : "شقة"),
        draftData.listing_type || "sale",
        draftData.price_value || null,
        draftData.price_display || "",
        draftData.area_value || null,
        draftData.bedrooms || null,
        draftData.location || "",
        draftData.compound || "",
        draftData.district || "",
        draftData.city || "",
        draftData.location_keywords || [],
        listingDetails,
        flyerStorageUrl
      ]);

      savedListing = listingRes.rows[0];

      // Insert associated image rows
      if (uploadedUrls.length > 0) {
        for (let pos = 0; pos < uploadedUrls.length; pos++) {
          await client.query(
            `INSERT INTO listing_images (listing_id, agency_id, url, position)
             VALUES ($1, $2, $3, $4)`,
            [savedListing.id, broker.agency_id, uploadedUrls[pos], pos]
          );
        }
      }

      // Record system usage telemetry
      await client.query(
        `INSERT INTO usage_events (agency_id, broker_id, phone, event_type, listing_id, duration_ms, meta)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          broker.agency_id,
          broker.id,
          from,
          "listing_creation",
          savedListing.id,
          Date.now() - startTime,
          JSON.stringify({
            images_count: uploadedUrls.length,
            tokens: usage.totalTokenCount || 0,
            has_flyer: Boolean(flyerStorageUrl),
            lang: targetLang
          })
        ]
      );

      await client.query("COMMIT");
      console.log(`✅ [LISTING SAVED ATOMICALLY]: ${savedListing.code}`);
    } catch (dbErr) {
      await client.query("ROLLBACK");
      console.error("❌ [TRANSACTION FAILED - ROLLEDBACK]:", dbErr);
      throw dbErr;
    } finally {
      client.release();
    }

    // -------------------------------------------------------------------------
    // STEP 4: DISPATCH FINAL CONFIRMATION & CLIENT-FACING TEXT TO BROKER
    // -------------------------------------------------------------------------
    if (flyerStorageUrl) {
      await sendWhatsAppImage(
        from,
        flyerStorageUrl,
        targetLang === "en"
          ? `📋 Verified Brochure - Unit #${savedListing.code}`
          : `📋 كتالوج تسويقي معتمد - كود الوحدة: #${savedListing.code}`
      );
    }

    // Format client marketing summary in the requested language
    let clientSummaryText = formatClientListingText(
      savedListing,
      broker,
      targetLang
    );

    // If unit was registered without images, append a note explaining how to add photos
    if (!hasImages || uploadedUrls.length === 0) {
      const noImageGuidance =
        targetLang === "en"
          ? `\n\n💡 *Note:* This unit is saved active without a visual brochure because no photos were attached.\nTo generate a brochure later, send photos with caption: *add #${savedListing.code}*`
          : `\n\n💡 *ملاحظة:* تم تسجيل الوحدة بنجاح بدون كتالوج مصور لعدم إرفاق صور.\nلتصميم الكتالوج لاحقاً، أرسل الصور واكتب في الرسالة: *إضافة #${savedListing.code}*`;

      clientSummaryText += noImageGuidance;
    }

    await sendWhatsAppText(from, clientSummaryText);
  } catch (fatalErr) {
    console.error("[BATCH EXECUTION FATAL ERROR]:", fatalErr);
    await sendWhatsAppText(
      from,
      targetLang === "en"
        ? "❌ An unexpected error occurred while saving the property. Partial registration was rolled back safely. Please resend."
        : "❌ عذراً، واجه النظام خطأ غير متوقع أثناء معالجة وحفظ العقار. تم إلغاء التسجيل الجزئي تلقائياً لضمان سلامة بياناتك، يرجى إعادة الإرسال."
    );
  }
}
// ---------------------------------------------------------------------------
// 2. SEARCH ENGINE: handleSearchMessage
// ---------------------------------------------------------------------------
/**
 * Handles text and voice-based inventory search queries and intent classification.
 * If intent is classified as "create_listing", delegates execution to processBatchedListing.
 *
 * @param {Object} broker - The broker record from DB (id, agency_id, phone, preferred_lang, etc.)
 * @param {Object} options - Search options { text, audio, offset }
 */
async function handleSearchMessage(broker, options) {
  const text = options && options.text ? options.text : "";
  const audio = options && options.audio ? options.audio : null;
  const offset =
    options && typeof options.offset === "number" ? options.offset : 0;
  const from = broker.phone;
  const startMs = Date.now();
  const isVoice = Boolean(audio && audio.buffer && audio.buffer.length > 0);

  // Resolve broker preferred language (defaults to 'ar')
  const targetLang = broker.preferred_lang || "ar";

  // 1. Guard against oversized voice searches
  if (isVoice && audio.duration && audio.duration > MAX_SEARCH_AUDIO_SEC) {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? `⚠️ *Voice search recording is too long (${audio.duration}s).*\n\nMaximum allowed voice search is *${MAX_SEARCH_AUDIO_SEC}s*. Please summarize your request.`
        : `⚠️ *التسجيل الصوتي للبحث طويل جداً (${audio.duration} ثانية).*\n\nالحد الأقصى للبحث الصوتي هو *${MAX_SEARCH_AUDIO_SEC} ثانية*. يرجى تسجيل طلبك باختصار.`
    );
  }

  // 2. Immediate feedback: Neutralized initial acknowledgment
  // Does not assume "searching" on audio so listing dictations do not receive premature search notices
  if (offset === 0) {
    sendWhatsAppText(
      from,
      isVoice
        ? targetLang === "en"
          ? "🎙️ Processing your voice note and analyzing request..."
          : "🎙️ جاري الاستماع للملاحظة الصوتية ومعالجة طلبك..."
        : targetLang === "en"
        ? "🔍 Searching database and matching your request..."
        : "🔍 جاري البحث في قاعدة البيانات ومطابقة طلبك..."
    ).catch((err) => console.error("[SEARCH ACK ERROR]:", err.message));
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
    const response = await generateContentWithRetry({
      contents: parts,
      config: activeConfig,
      primaryModel: GEMINI_MODEL_ID,
      fallbackModel: "gemini-3.5-flash-lite",
      maxRetries: 3
    });
    const resText = cleanJsonResponse(response.text);
    usage = response.usageMetadata || {};
    parsed = JSON.parse(resText);
  } catch (parseErr) {
    console.error("[SEARCH PARSE ERROR]:", parseErr.message);
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "❌ Could not understand the search request. Please specify your query in clear text or audio."
        : "❌ تعذر فهم طلب البحث. يرجى توضيح المطلوب كنص أو تسجيل صوتي واضح."
    );
  }

  // 3. Fallthrough if AI detects broker is submitting a unit rather than querying
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

  // 4. Construct SQL Query Clauses
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
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "❌ A database error occurred during search."
        : "❌ حدث خطأ في قاعدة البيانات أثناء البحث."
    );
  }

  const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

  // 5. Track Usage Analytics
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

  // 6. Handle Zero Results with Clean Formatted Guidance
  if (totalCount === 0) {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "🔍 *No matching listings found.*\n\n" +
            "💡 *Search Tips:*\n" +
            '• Try searching by area or compound name only (e.g., _"Apartment in Mivida"_).\n' +
            "• Broaden your criteria for price or bedroom count.\n" +
            "• Verify your budget figures."
        : "🔍 *لم يتم العثور على وحدات مطابقة للبحث.*\n\n" +
            "💡 *نصائح للبحث:*\n" +
            '• جرب البحث باسم المنطقة أو الكمبوند فقط (مثل: _"شقة في ميفيدا"_).\n' +
            "• قلل الشروط المحددة للسعر أو عدد الغرف.\n" +
            "• تأكد من صحة أرقام الميزانية."
    );
  }

  // 7. Format Result Cards
  const responseLines = [];
  if (parsed.is_multi_project_developer && parsed.developer) {
    responseLines.push(
      targetLang === "en"
        ? `💡 *Note:* Searched across all projects by developer *(${parsed.developer})*. To narrow down, specify the area (e.g., _"${parsed.developer} New Cairo"_ or _"${parsed.developer} Zayed"_).\n`
        : `💡 *ملاحظة:* تم البحث في كافة مشروعات مطور *(${parsed.developer})*. لتضييق النتائج، يمكنك تحديد المنطقة (مثال: _"${parsed.developer} التجمع"_ أو _"${parsed.developer} زايد"_).\n`
    );
  }

  const currentEnd = Math.min(offset + rows.length, totalCount);
  responseLines.push(
    targetLang === "en"
      ? `🔍 *Search Results (${
          offset + 1
        } to ${currentEnd} of ${totalCount} units):*\n`
      : `🔍 *نتائج البحث (${
          offset + 1
        } إلى ${currentEnd} من أصل ${totalCount} وحدة):*\n`
  );

  for (let i = 0; i < rows.length; i++) {
    const unit = rows[i];
    const details = unit.details || {};
    const shortSum = details.short_summary
      ? "\n   _" + details.short_summary + "_"
      : "";
    const downPayment = details.down_payment_value
      ? " | " +
        (targetLang === "en" ? "Down Payment: *" : "مقدم: *") +
        Number(details.down_payment_value).toLocaleString("en-US") +
        (targetLang === "en" ? " EGP*" : " ج*")
      : "";

    if (targetLang === "en") {
      responseLines.push(
        `*${offset + i + 1}. #${unit.code}* - ${unit.title}`,
        `   💰 Price: *${unit.price_display}*${downPayment}`,
        `   📐 Area: ${
          unit.area_value ? unit.area_value + " m²" : "-"
        } | 🛏️ Beds: ${unit.bedrooms || "-"}`,
        `   📍 Location: ${unit.location || "-"}${shortSum}`,
        `   📄 Brochure: catalog ${unit.code} | 📲 Client View: client ${unit.code}`,
        ""
      );
    } else {
      responseLines.push(
        `*${offset + i + 1}. #${unit.code}* - ${unit.title}`,
        `   💰 السعر: *${unit.price_display}*${downPayment}`,
        `   📐 المساحة: ${
          unit.area_value ? unit.area_value + " م²" : "-"
        } | 🛏️ الغرف: ${unit.bedrooms || "-"}`,
        `   📍 الموقع: ${unit.location || "-"}${shortSum}`,
        `   📄 للكتالوج: كتالوج ${unit.code} | 📲 للعميل: عميل ${unit.code}`,
        ""
      );
    }
  }

  if (currentEnd < totalCount) {
    responseLines.push(
      "━━━━━━━━━━━━━━━━━━━━",
      targetLang === "en"
        ? "➡️ To view the next 10 units, send: *more*"
        : "➡️ لعرض الـ 10 وحدات التالية، أرسل: *المزيد*"
    );
  }

  return sendWhatsAppText(from, responseLines.join("\n"));
}

// ---------------------------------------------------------------------------
// 3. COMMAND ROUTING: handleSingleMessage
// ---------------------------------------------------------------------------
/**
 * Generates a clean, section-based bilingual guide for broker commands and workflows.
 *
 * @param {string} [lang='ar'] - Target language ('ar' | 'en')
 * @returns {string} Formatted WhatsApp message
 */
function getBilingualHelpMessage(lang) {
  if (lang === "en") {
    return [
      "📋 *REAL ESTATE ASSISTANT - COMMAND DIRECTORY*",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "1️⃣ *CREATING NEW LISTINGS*",
      "• Send photos (up to 15) with property specs in the caption.",
      "• Or send a voice note / text describing the unit.",
      "• *Language Flags:* Add _'en'_ for English, or _'bilingual'_ / _'global'_ for dual Arabic & English copy.",
      "",
      "2️⃣ *ADDING & UPDATING PHOTOS*",
      "• *Append to gallery:* Send photos with caption: `add #CODE` (or `إضافة #CODE`).",
      "• *Replace all photos:* Send photos with caption: `replace #CODE` (or `استبدال #CODE`).",
      "• The brochure flyer and image gallery will automatically re-render.",
      "",
      "3️⃣ *INVENTORY SEARCH*",
      '• Type or dictate your request (e.g., _"Apartment in Mivida 3 bedrooms under 15M"_).',
      "• Send *more* to view the next 10 results.",
      "",
      "4️⃣ *DIRECT LOOKUPS & ASSETS*",
      "• `catalog #CODE` : Download brochure flyer image.",
      "• `client #CODE`  : Get clean, copy-pasteable marketing text.",
      "• `catalog client #CODE` : Flyer image with marketing text caption.",
      "• `#CODE`        : View internal listing record and private metadata.",
      "",
      "5️⃣ *STATUS & INVENTORY MANAGEMENT*",
      "• `price #CODE to [PRICE]` : Update price (e.g. `price #RK-101 to 12.5M`).",
      "• `sold #CODE`     : Mark unit as sold.",
      "• `archive #CODE`  : Archive listing from search results.",
      "• `activate #CODE` : Reactivate an archived or sold unit.",
      "• `stats`          : View active, sold, and archived inventory counts.",
      "• `excel` or `csv` : Export latest 500 listings as a spreadsheet.",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    ].join("\n");
  }

  return [
    "📋 *دليل أوامر وتشغيل المساعد العقاري الذكي*",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "1️⃣ *تسجيل وحدة جديدة*",
    "• أرسل صور العقار (حتى 15 صورة) مع كتابة المواصفات في وصف الصورة.",
    "• أو أرسل تسجيلاً صوتياً أو نصياً يحتوي على تفاصيل الوحدة.",
    "• *تحديد اللغة:* اكتب _'انجليزي'_ أو _'en'_ للإنجليزية، أو _'عربي وانجليزي'_ أو _'مزدوج'_ للكتالوج ثنائي اللغة.",
    "",
    "2️⃣ *إضافة وتحديث صور العقارات*",
    "• *إضافة صور جديدة:* أرسل الصور واكتب في الوصف: `إضافة #الكود`.",
    "• *استبدال كافة الصور:* أرسل الصور واكتب في الوصف: `استبدال #الكود`.",
    "• سيتم تحديث معرض الصور وتصميم كتالوج جديد تلقائياً.",
    "",
    "3️⃣ *البحث والاستعلام عن العقارات*",
    '• اكتب أو سجل صوتياً مواصفات طلبك (مثال: _"شقة في ميفيدا 3 غرف بأقل من 15 مليون"_).',
    "• أرسل كلمة *المزيد* لعرض الـ 10 وحدات التالية.",
    "",
    "4️⃣ *طلب الكتالوج والبيانات المباشرة*",
    "• `كتالوج #الكود` : استلام صورة الكتالوج التسويقي المعتمد.",
    "• `عميل #الكود`  : استلام النص التسويقي الجاهز للإرسال للعميل.",
    "• `كتالوج عميل #الكود` : استلام صورة الكتالوج مدمج معها النص التسويقي.",
    "• `#الكود`       : عرض كافة البيانات والمواصفات الداخلية للوحدة.",
    "",
    "5️⃣ *إدارة الحالة والمخزون*",
    "• `سعر #الكود إلى [السعر]` : تحديث السعر (مثال: `سعر #RK-101 إلى 12.5 مليون`).",
    "• `تم البيع #الكود` : تحويل حالة الوحدة إلى مباعة.",
    "• `ارشيف #الكود`   : أرشفة الوحدة واستبعادها من نتائج البحث.",
    "• `تفعيل #الكود`   : إعادة تفعيل وحدة مؤرشفة أو مباعة.",
    "• `احصائيات`       : عرض عدد الوحدات النشطة، المباعة، والمؤرشفة.",
    "• `اكسيل` أو `csv` : تصدير ملف إكسيل بآخر 500 وحدة مسجلة.",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");
}

/**
 * Routes and handles incoming WhatsApp single messages (media, text, voice, commands, unsupported types).
 *
 * @param {Object} broker - The broker database record (id, agency_id, phone, preferred_lang, etc.)
 * @param {Object} message - Raw parsed incoming message object
 */
async function handleSingleMessage(broker, message) {
  const from = broker.phone;
  const msgType = message.type;
  const targetLang = broker.preferred_lang || "ar";

  // 1. Image Uploads (New listing media or existing listing update)
  if (msgType === "image") {
    const mediaId = message.image && message.image.id;
    const caption =
      message.image && message.image.caption
        ? message.image.caption.trim()
        : "";
    const downloaded = await downloadWhatsAppMedia(mediaId);
    if (!downloaded) return;

    // Detect unit code in caption to bind directly to batch (e.g. "إضافة #RK-101", "استبدال APT-20", or "#GJ765")
    let extractedCode = null;
    const codeMatch = caption.match(
      /(?:إضافة|اضافة|استبدال|add|replace)?\s*#?([A-Z0-9-]+)/i
    );
    if (codeMatch && codeMatch[1] && codeMatch[1].length >= 3) {
      extractedCode = codeMatch[1].toUpperCase();
    }

    enqueueToBatch(broker, {
      text: caption || null,
      customCode: extractedCode,
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

  // 3. Graceful Handling of Unsupported WhatsApp Media Payloads
  if (msgType === "location") {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "📍 Location pins cannot be read directly. Please type or speak the district, city, or compound name."
        : "📍 لا يمكن قراءة الموقع الجغرافي المباشر. يرجى كتابة أو تسجيل اسم المنطقة أو الكمبوند كنص أو تسجيل صوتي."
    );
  }

  if (msgType === "contacts") {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "👤 Contact cards (vCards) are not supported. Please type the client/contact details directly."
        : "👤 لا يمكن معالجة بطاقات جهات الاتصال (vCard). يرجى إرسال بيانات العميل نصياً داخل المحادثة."
    );
  }

  if (msgType === "sticker") {
    return; // Silently drop sticker reactions to avoid conversational spam
  }

  if (msgType === "document") {
    const mime = (message.document && message.document.mime_type) || "";
    // Only accept PDFs if PDF catalog parsing is handled elsewhere; otherwise guide user
    if (!mime.includes("pdf")) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "📄 Unrecognized document format. Please upload photos directly (JPEG/PNG) or send details via text/audio."
          : "📄 نوع الملف غير مدعوم. يرجى إرسال الصور مباشرة (JPEG/PNG) أو كتابة/تسجيل التفاصيل صوتياً."
      );
    }
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

  // 4. Structured Bilingual Help Command
  if (
    ["help", "مساعدة", "اوامر", "أوامر", "قواعد", "تعليمات"].includes(lower)
  ) {
    const requestedLang = lower === "help" ? "en" : targetLang;
    return sendWhatsAppText(from, getBilingualHelpMessage(requestedLang));
  }

  // 5. Pagination: المزيد / more
  if (rawText === "المزيد" || lower === "more") {
    const prev = lastSearchState.get(from);
    if (!prev) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "⚠️ No active search found or session expired. Please start a new search."
          : "⚠️ لا يوجد بحث سابق لعرض المزيد من نتائجه، أو انتهت صلاحية الجلسة. يرجى كتابة طلب بحث جديد."
      );
    }
    return handleSearchMessage(broker, {
      text: prev.text,
      audio: prev.audio,
      offset: prev.offset + SEARCH_PAGE_SIZE
    });
  }

  // 6. Broker Statistics: احصائيات / stats
  if (rawText === "احصائيات" || rawText === "إحصائيات" || lower === "stats") {
    const statsRes = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_count, COUNT(*) FILTER (WHERE status = 'sold') AS sold_count, COUNT(*) FILTER (WHERE status = 'archived') AS archived_count FROM listings WHERE agency_id = $1",
      [broker.agency_id]
    );
    const st = statsRes.rows[0] || {};
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? [
            "📊 *Agency Inventory Statistics:*",
            `• Active Units: *${st.active_count || 0}*`,
            `• Sold Units: *${st.sold_count || 0}*`,
            `• Archived Units: *${st.archived_count || 0}*`
          ].join("\n")
        : [
            "📊 *إحصائيات مخزون الوكالة:*",
            `• الوحدات النشطة: *${st.active_count || 0}*`,
            `• الوحدات المباعة: *${st.sold_count || 0}*`,
            `• الوحدات المؤرشفة: *${st.archived_count || 0}*`
          ].join("\n")
    );
  }

  // 7. CSV Export: اكسيل / csv
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
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "⚠️ No listings available to export."
          : "⚠️ لا توجد وحدات مسجلة لتصديرها."
      );
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
      `inventory_${Date.now()}.csv`,
      targetLang === "en"
        ? "📊 Excel file containing your recent registered listings."
        : "📊 ملف إكسيل يحتوي على أحدث الوحدات المسجلة."
    );
  }

  // 8. Price Update: سعر [كود] إلى [السعر] / price [code] to [price]
  const priceMatch = rawText.match(
    /^(?:سعر|price)\s+#?([A-Z0-9-]+)\s+(?:إلى|الى|ل|to)\s+(.+)$/i
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
        targetLang === "en"
          ? `❌ Listing not found: #${code}`
          : `❌ لم يتم العثور على عقار بالكود: #${code}`
      );
    }
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? `✅ Price updated for property *#${code}* to *${upd.rows[0].price_display}*.`
        : `✅ تم تحديث سعر العقار *#${code}* إلى *${upd.rows[0].price_display}*.`
    );
  }

  // 9. Client Brochure Forwarding: كتالوج عميل [كود] / catalog client [code]
  const clientBrochureMatch = rawText.match(
    /^(?:كتالوج\s+عميل|بروشور\s+عميل|catalog\s+client|brochure\s+client)\s+#?([A-Z0-9-]+)$/i
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
        targetLang === "en"
          ? `❌ Listing not found: #${code}`
          : `❌ لم يتم العثور على عقار بالكود: #${code}`
      );
    }

    const listing = res.rows[0];
    const clientText = formatClientListingText(listing, broker, targetLang);

    if (listing.flyer_url) {
      return sendWhatsAppImage(
        from,
        listing.flyer_url + "?t=" + Date.now(),
        clientText
      );
    }
    return sendWhatsAppText(from, clientText);
  }

  // 10. Client Text Forwarding: عميل [كود] / client [code]
  const clientTextMatch = rawText.match(/^(?:عميل|client)\s+#?([A-Z0-9-]+)$/i);
  if (clientTextMatch) {
    const code = clientTextMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? `❌ Listing not found: #${code}`
          : `❌ لم يتم العثور على عقار بالكود: #${code}`
      );
    }

    const listing = res.rows[0];
    const clientText = formatClientListingText(listing, broker, targetLang);
    return sendWhatsAppText(from, clientText);
  }

  // 11. Internal Flyer Command: كتالوج [كود] / catalog [code]
  const flyerMatch = rawText.match(
    /^(?:كتالوج|بروشور|catalog|flyer)\s+#?([A-Z0-9-]+)$/i
  );
  if (flyerMatch) {
    const code = flyerMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT code, title, price_display, flyer_url FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? `❌ Listing not found: #${code}`
          : `❌ لم يتم العثور على عقار بالكود: #${code}`
      );
    }

    const listing = res.rows[0];
    if (!listing.flyer_url) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? `⚠️ Listing *#${code}* was saved without photos and does not have a brochure flyer.\nSend photos with caption *add #${code}* to generate one.`
          : `⚠️ العقار رقم *#${code}* مسجل بدون صور ولا يوجد كتالوج مصور له.\nلإنشاء الكتالوج، أرسل الصور واكتب في الرسالة: *إضافة #${code}*`
      );
    }

    return sendWhatsAppImage(
      from,
      listing.flyer_url + "?t=" + Date.now(),
      targetLang === "en"
        ? `📄 Brochure for Listing *#${listing.code}*\n${listing.title}\n💰 Price: ${listing.price_display}`
        : `📄 كتالوج العقار رقم *#${listing.code}*\n${listing.title}\n💰 السعر: ${listing.price_display}`
    );
  }

  // 12. Internal Listing Details Command: #[كود]
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
        targetLang === "en"
          ? `❌ Listing not found: #${code}`
          : `❌ لم يتم العثور على عقار بالكود: #${code}`
      );
    }

    return sendWhatsAppText(
      from,
      formatInternalListingDetails(res.rows[0], targetLang)
    );
  }

  // 13. Status Updates: تم البيع [كود], ارشيف [كود], تفعيل [كود] / sold [code], archive [code], activate [code]
  const statusMatch = rawText.match(
    /^(تم البيع|ارشيف|أرشيف|تفعيل|sold|archive|activate)\s+#?([A-Z0-9-]+)$/i
  );
  if (statusMatch) {
    const rawAction = statusMatch[1].toLowerCase();
    const code = statusMatch[2].toUpperCase();
    let newStatus = "active";
    let label = "تفعيل";

    if (rawAction === "تم البيع" || rawAction === "sold") {
      newStatus = "sold";
      label = targetLang === "en" ? "Sold" : "تم البيع";
    } else if (
      rawAction === "ارشيف" ||
      rawAction === "أرشيف" ||
      rawAction === "archive"
    ) {
      newStatus = "archived";
      label = targetLang === "en" ? "Archived" : "أرشيف";
    } else {
      label = targetLang === "en" ? "Active" : "نشط";
    }

    const updateRes = await pool.query(
      "UPDATE listings SET status = $1, updated_at = NOW() WHERE agency_id = $2 AND code = $3 RETURNING code",
      [newStatus, broker.agency_id, code]
    );

    if (updateRes.rowCount === 0) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? `❌ Could not update listing. Please verify the code: #${code}`
          : `❌ تعذر تحديث العقار. تأكد من صحة الكود: #${code}`
      );
    }

    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? `✅ Listing status for *#${code}* changed to: *${label}*.`
        : `✅ تم تحديث حالة العقار *#${code}* إلى: *${label}*.`
    );
  }

  // 14. General Search / Listing Intent
  return handleSearchMessage(broker, { text: rawText, offset: 0 });
}

// ---------------------------------------------------------------------------
// 4. WEBHOOK ENDPOINTS
// ---------------------------------------------------------------------------
app.post("/webhook", function (req, res) {
  // 1. Immediately acknowledge Meta to prevent duplicate delivery retries
  res.status(200).send("EVENT_RECEIVED");

  // 2. Process message payloads asynchronously
  setImmediate(async function () {
    try {
      const entry = req.body && req.body.entry && req.body.entry[0];
      const change =
        entry && entry.changes && entry.changes[0] && entry.changes[0].value;

      // Ignore delivery receipts, read receipts, and empty webhook events
      const messages =
        change && Array.isArray(change.messages) ? change.messages : [];
      if (messages.length === 0) return;

      const MEDIA_TYPES = ["image", "audio", "voice", "video", "document"];

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const from = message.from;
        if (!from) continue;

        // Fetch broker profile including role, contact_phone, and is_active flag
        const brokerRes = await pool.query(
          "SELECT id, agency_id, name, phone, contact_phone, role, is_active FROM brokers WHERE phone = $1 LIMIT 1",
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

        // Guard: Prevent suspended or inactive brokers from triggering requests
        if (broker.is_active === false) {
          await sendWhatsAppText(
            from,
            "⛔ تم تعطيل هذا الحساب مؤقتاً. يرجى مراجعة إدارة الوكالة للتفعيل."
          );
          continue;
        }

        // Update active timestamp
        await pool.query(
          "UPDATE brokers SET last_active_at = NOW() WHERE id = $1",
          [broker.id]
        );

        // ---------------------------------------------------------------------
        // ROUTING GUARD: Prevent Search / Creation Race Conditions
        // ---------------------------------------------------------------------
        const isMedia = MEDIA_TYPES.includes(message.type);
        const hasActiveBatch =
          typeof incomingBatches !== "undefined" && incomingBatches.has(from);

        // Check if another message from this same sender in the current webhook payload contains media
        const hasMediaInCurrentPayload = messages.some(
          (m) => m.from === from && MEDIA_TYPES.includes(m.type)
        );

        if (isMedia || hasActiveBatch || hasMediaInCurrentPayload) {
          // Route exclusively to listing batch ingestion (captures photos, audio notes, and custom codes)
          await enqueueToBatch(broker, from, message);
        } else {
          // Standalone text messages: commands, inquiries, and property search
          await handleSingleMessage(broker, message);
        }
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
// ---------------------------------------------------------------------------
// 5. HEALTH CHECK & SYSTEM STATUS ENDPOINTS
// ---------------------------------------------------------------------------
app.get("/health", async function (req, res) {
  try {
    // Ping PostgreSQL to confirm database connectivity
    await pool.query("SELECT 1");
    res.status(200).json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: "connected"
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      database: "disconnected",
      error: err.message
    });
  }
});

app.get("/", function (req, res) {
  res.status(200).send("Real Estate WhatsApp Engine is active.");
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("🚀 Real Estate WhatsApp Engine online on port " + PORT);
});
