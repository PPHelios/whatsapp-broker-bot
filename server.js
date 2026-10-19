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
/**
 * Executes a Gemini generateContent request with automatic retry on 503/429
 * and optional fallback model routing.
 */
async function generateContentWithRetry({
  contents,
  config,
  primaryModel = "gemini-3.8-flash",
  fallbackModel = "gemini-2.6-flash",
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
async function processBatchedListing(broker, batch) {
  const from = batch.from;
  const startTime = Date.now();

  // 1. Send preliminary processing acknowledgement to the broker
  await sendWhatsAppText(
    from,
    "⏳ جاري فحص البيانات والمواصفات وتصميم الكتالوج الاحترافي..."
  );

  try {
    // -------------------------------------------------------------------------
    // STEP 1: PREPARE MULTIMODAL PAYLOAD (Images + Text + Transcribed Voice)
    // -------------------------------------------------------------------------
    const parts = [];

    // System instruction and structural schema enforcement prompt
    parts.push({
      text: `أنت خبير ومساعد عقاري ذكي لمنصة وساطة عقارية. مهمتك استخراج كافة تفاصيل العقار بدقة متناهية من النصوص والصور والملاحظات الصوتية المرفقة بصيغة JSON محددة حصراً.
استخرج الحقول التالية:
- title: عنوان مختصر جذاب للوحدة.
- property_type: نوع العقار (شقة, فيلا, دوبلكس, مكتب, محل, شاليه, إلخ).
- listing_type: نوع العرض ("sale" أو "rent").
- price_value: القيمة الرقمية للسعر الإجمالي فقط (بدون فواصل أو نصوص).
- price_display: السعر كنص واضح (مثال: "5,500,000 ج.م").
- area_value: المساحة كرقم فقط بالمتر المربع.
- bedrooms: عدد الغرف كرقم.
- location: الحي أو المدينة أو التجمع (مثال: "التجمع الخامس - القاهرة الجديدة").
- compound: اسم الكمبوند إن وجد، أو فارغ "".
- district: المنطقة أو الحي بالتفصيل.
- city: المدينة الرئيسية (مثال: "القاهرة", "الجيزة", "الساحل الشمالي").
- location_keywords: مصفوفة كلمات مفتاحية للموقع.
- details: كائن يحتوي على:
    - clean_summary: وصف تنفيذي منسق ومختصر للوحدة.
    - features: مصفوفة نصوص لأبرز 3-5 مميزات (تشطيب, بحري, فيو, أسانسير, إلخ).
    - installment_years: عدد سنوات التقسيط إن وجد (رقم).
    - down_payment_value: قيمة المقدم إن وجد (رقم).
    - image_order: مصفوفة أرقام ترتيب أفضل الصور من حيث الجودة لتظهر بالبروشور بدءاً من 0.`
    });

    // Append text descriptions from the broker
    if (batch.texts && batch.texts.length > 0) {
      parts.push({
        text: `تفاصيل العقار المرسلة نصياً:\n${batch.texts.join("\n\n")}`
      });
    }

    // Append and process raw images (compressed for Gemini ingestion)
    const validImageBuffers = [];
    if (batch.images && batch.images.length > 0) {
      for (const imgItem of batch.images) {
        if (!imgItem.buffer) continue;
        validImageBuffers.push(imgItem.buffer);

        // Resize buffer for Gemini input to conserve token bandwidth
        const lowRes = await sharp(imgItem.buffer)
          .resize({ width: 1024, height: 1024, fit: "inside" })
          .jpeg({ quality: 80 })
          .toBuffer();

        parts.push({
          inlineData: {
            mimeType: "image/jpeg",
            data: lowRes.toString("base64")
          }
        });
      }
    }

    // Process voice recordings if present
    if (batch.voices && batch.voices.length > 0) {
      for (const voiceItem of batch.voices) {
        if (!voiceItem.buffer) continue;
        parts.push({
          inlineData: {
            mimeType: voiceItem.mimeType || "audio/ogg",
            data: voiceItem.buffer.toString("base64")
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
        config: {
          temperature: 0.2,
          responseMimeType: "application/json"
        },
        primaryModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        fallbackModel: "gemini-2.5-flash",
        maxRetries: 3
      });

      const resText = cleanJsonResponse(response.text);
      usage = response.usageMetadata || {};
      draftData = JSON.parse(resText);
    } catch (aiErr) {
      console.error("[MULTIMODAL EXTRACTION ERROR]:", aiErr.message);
      return sendWhatsAppText(
        from,
        "⚠️ خوادم الذكاء الاصطناعي تشهد ضغطاً مؤقتاً في الوقت الحالي. يرجى إعادة إرسال الوحدة بعد لحظات."
      );
    }

    // -------------------------------------------------------------------------
    // STEP 3: UPLOAD LISTING IMAGES TO SUPABASE STORAGE
    // -------------------------------------------------------------------------
    // Generate a temporary unique code identifier for path naming
    const timestampCode = Math.floor(10000 + Math.random() * 90000);
    const unitPrefix = `RK-${
      draftData.property_type ? draftData.property_type.charAt(0) : "U"
    }-${timestampCode}`;

    const uploadedUrls = [];
    if (validImageBuffers.length > 0) {
      for (let i = 0; i < validImageBuffers.length; i++) {
        // Optimize image to high-efficiency web format
        const optimizedBuffer = await sharp(validImageBuffers[i])
          .resize({
            width: 1600,
            height: 1600,
            fit: "inside",
            withoutEnlargement: true
          })
          .jpeg({ quality: 84, mozjpeg: true })
          .toBuffer();

        const publicUrl = await uploadListingImage(
          broker.agency_id,
          `${unitPrefix}-${i + 1}`,
          optimizedBuffer
        );

        if (publicUrl) {
          uploadedUrls.push(publicUrl);
        }
      }
    }

    // -------------------------------------------------------------------------
    // STEP 4: FETCH AGENCY BRANDING & GENERATE BROCHURE FLYER
    // -------------------------------------------------------------------------
    const agencyRes = await pool.query(
      "SELECT id, name, logo_url, primary_color, secondary_color FROM agencies WHERE id = $1 LIMIT 1",
      [broker.agency_id]
    );
    const agency = agencyRes.rows[0] || {};

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
          images: uploadedUrls
        });

        if (flyerBuffer) {
          flyerStorageUrl = await uploadListingFlyer(
            broker.agency_id,
            `${unitPrefix}-flyer`,
            flyerBuffer
          );
        }
      } catch (flyerErr) {
        console.error("[FLYER RENDER ERROR]:", flyerErr);
      }
    }

    // -------------------------------------------------------------------------
    // STEP 5: ATOMIC TRANSACTIONAL DATABASE INSERTION
    // -------------------------------------------------------------------------
    const client = await pool.connect();
    let savedListing = null;

    try {
      await client.query("BEGIN");

      // A. Insert the property listing
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
        draftData.title || "وحدة سكنية معروضة",
        draftData.property_type || "شقة",
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
        draftData.details || {},
        flyerStorageUrl
      ]);

      savedListing = listingRes.rows[0];

      // B. Insert all associated image rows
      if (uploadedUrls.length > 0) {
        for (let pos = 0; pos < uploadedUrls.length; pos++) {
          await client.query(
            `INSERT INTO listing_images (listing_id, agency_id, url, position)
             VALUES ($1, $2, $3, $4)`,
            [savedListing.id, broker.agency_id, uploadedUrls[pos], pos]
          );
        }
      }

      // C. Record system usage telemetry
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
            has_flyer: Boolean(flyerStorageUrl)
          })
        ]
      );

      // Commit all changes atomically
      await client.query("COMMIT");
      console.log(`✅ [LISTING SAVED ATOMICALLY]: ${savedListing.code}`);
    } catch (dbErr) {
      await client.query("ROLLBACK");
      console.error(`❌ [TRANSACTION FAILED - ROLLEDBACK]:`, dbErr);
      throw dbErr; // Re-throw to trigger user error alert in outer catch
    } finally {
      client.release();
    }

    // -------------------------------------------------------------------------
    // STEP 6: DISPATCH FINAL CONFIRMATION & CLIENT-FACING TEXT TO BROKER
    // -------------------------------------------------------------------------
    // Send the rendered visual flyer image
    if (flyerStorageUrl) {
      await sendWhatsAppImage(
        from,
        flyerStorageUrl,
        `📋 كتالوج تسويقي معتمد - كود الوحدة: #${savedListing.code}`
      );
    }

    // Send formatted copy-pasteable client marketing summary
    const clientSummaryText = formatClientListingText(savedListing, broker);
    await sendWhatsAppText(from, clientSummaryText);
  } catch (fatalErr) {
    console.error("[BATCH EXECUTION FATAL ERROR]:", fatalErr);
    await sendWhatsAppText(
      from,
      "❌ عذراً، واجه النظام خطأ غير متوقع أثناء معالجة وحفظ العقار. تم إلغاء التسجيل الجزئي تلقائياً لضمان سلامة بياناتك، يرجى إعادة الإرسال."
    );
  }
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
    const response = await generateContentWithRetry({
      contents: parts,
      config: activeConfig,
      primaryModel: GEMINI_MODEL_ID,
      fallbackModel: "gemini-2.6-flash",
      maxRetries: 3
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

        // Dispatch message to command and search handler
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
