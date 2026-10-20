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

sharp.concurrency(1);

function createLimiter(concurrency) {
  let activeCount = 0;
  const queue = [];
  const next = () => {
    activeCount--;
    if (queue.length > 0) queue.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = async () => {
        activeCount++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          next();
        }
      };
      if (activeCount < concurrency) run();
      else queue.push(run);
    });
}

const listingLimiter = createLimiter(2);

const GEMINI_MODEL_ID = "gemini-3.8-flash";
const MAX_VISION_EVAL_IMAGES = 15;
const MAX_SEARCH_AUDIO_SEC = 45;
const MAX_LISTING_AUDIO_SEC = 120;
const SEARCH_PAGE_SIZE = 10;
const BATCH_DEBOUNCE_MS = 8000;

function normalizePhone(rawPhone) {
  if (!rawPhone) return "";
  return String(rawPhone).replace(/@.*$/, "").replace(/[^\d]/g, "");
}

const incomingBatches = new Map();
const pendingTextBuffers = new Map();
const activeProcessingBrokers = new Set();
const recentBrokerListings = new Map();
const processedMessageIds = new Map();
const lastSearchState = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > 300000) processedMessageIds.delete(id);
  }
}, 300000);

function isBatchingActive(phone) {
  const cleanKey = normalizePhone(phone);
  return incomingBatches.has(cleanKey) || pendingTextBuffers.has(cleanKey);
}

function extractExplicitUnitCode(text) {
  if (!text) return null;
  const match = String(text).match(
    /(?:^|[\s,،])(?:إضافة|اضافة|استبدال|add|replace|كود|code|ref)\s*#?([A-Za-z0-9-_]{2,})(?=$|[\s,،])/i
  );
  return match && match[1] ? match[1].toUpperCase() : null;
}

function isLikelyListingMetadata(text) {
  if (!text) return false;
  const isSearchQuery =
    /(?:^|\s)(عايز|محتاج|ابحث|دورلي|عندك|search|find|looking for)(?:\$|\s)/i.test(
      text
    );
  if (isSearchQuery) return false;
  const hasListingClues =
    /(?:^|\s)(كود|code|للبيع|مطلوب|مساحة|دور|تشطيب|كمبوند|شقة|فيلا|غرف|مقدم|تقسيط|ref)(?:\$|\s)/i.test(
      text
    );
  return hasListingClues;
}

function reserveBatch(broker, initialCustomCode = null) {
  const cleanKey = normalizePhone(broker.phone);
  let batch = incomingBatches.get(cleanKey);

  if (!batch) {
    batch = {
      broker,
      from: broker.phone,
      texts: [],
      captions: [],
      audios: [],
      voices: [],
      images: [],
      customCode: initialCustomCode || null,
      pendingDownloads: 0,
      timer: null
    };
    incomingBatches.set(cleanKey, batch);

    sendWhatsAppText(
      batch.from,
      "📥 تم استلام الملفات، بانتظار اكتمال التحميل لبدء المعالجة..."
    ).catch((err) =>
      console.error("[WHATSAPP RECEPTION ACK ERROR]:", err.message)
    );
  } else if (initialCustomCode && !batch.customCode) {
    batch.customCode = initialCustomCode;
  }

  if (pendingTextBuffers.has(cleanKey)) {
    const buffered = pendingTextBuffers.get(cleanKey);
    clearTimeout(buffered.timer);
    pendingTextBuffers.delete(cleanKey);
    if (buffered.text) batch.texts.push(buffered.text);
    if (buffered.customCode && !batch.customCode)
      batch.customCode = buffered.customCode;
  }

  if (!batch.customCode && recentBrokerListings.has(cleanKey)) {
    const recent = recentBrokerListings.get(cleanKey);
    if (Date.now() - recent.timestamp < 60000) {
      batch.customCode = recent.code;
    }
  }

  resetBatchDebounceTimer(cleanKey);
  return batch;
}

function resetBatchDebounceTimer(cleanKey) {
  const batch = incomingBatches.get(cleanKey);
  if (!batch) return;
  if (batch.timer) clearTimeout(batch.timer);

  batch.timer = setTimeout(async () => {
    const finalizedBatch = incomingBatches.get(cleanKey);
    if (!finalizedBatch) return;

    if (finalizedBatch.pendingDownloads > 0) {
      resetBatchDebounceTimer(cleanKey);
      return;
    }

    incomingBatches.delete(cleanKey);
    activeProcessingBrokers.add(cleanKey);

    finalizedBatch.images = finalizedBatch.images.filter(
      (img) => img && img.buffer
    );

    const allTextTokens = [
      ...finalizedBatch.texts,
      ...finalizedBatch.captions
    ].join(" ");
    if (!finalizedBatch.customCode) {
      finalizedBatch.customCode = extractExplicitUnitCode(allTextTokens);
    }

    try {
      await listingLimiter(() =>
        processBatchedListing(finalizedBatch.broker, finalizedBatch)
      );
    } catch (err) {
      console.error("[BATCH EXECUTION ERROR]:", err);
      try {
        await sendWhatsAppText(
          finalizedBatch.from,
          "❌ حدث خطأ غير متوقع أثناء معالجة وحفظ العقار وإنشاء الكتالوج. يرجى إعادة المحاولة."
        );
      } catch (notifyErr) {
        console.error("[FAILED TO SEND ERROR NOTICE TO BROKER]:", notifyErr);
      }
    } finally {
      activeProcessingBrokers.delete(cleanKey);
    }
  }, BATCH_DEBOUNCE_MS);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const LISTING_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 2048,
  responseMimeType: "application/json",
  thinkingConfig: { thinkingBudget: 768 }
};
const VOICE_SEARCH_CONFIG = {
  temperature: 0.1,
  maxOutputTokens: 500,
  responseMimeType: "application/json",
  thinkingConfig: { thinkingBudget: 256 }
};
const TEXT_SEARCH_CONFIG = {
  temperature: 0.0,
  maxOutputTokens: 350,
  responseMimeType: "application/json",
  thinkingConfig: { thinkingBudget: 0 }
};

const CANONICAL_REAL_ESTATE_RULES = [
  "CANONICAL EGYPTIAN REAL ESTATE RULES:",
  "1. TYPO & PHONETIC CORRECTION: بالم هيلز, ميفيدا, أبتاون كايرو, هايد بارك, ماونتن فيو, مدينتي, الرحاب",
  "2. PROPERTY TYPE ENUM MUST BE STRICTLY ONE OF: apartment, villa, townhouse, twinhouse, duplex, penthouse, studio, chalet, office, commercial, land",
  "3. FRANCO-ARABIC NUMERALS & ZERO HALLUCINATION"
].join("\n");

function generateSafeListingCode(customCode, propertyType) {
  if (customCode && typeof customCode === "string") {
    const cleaned = customCode
      .trim()
      .replace(/^(?:كود|code|ref|#)\s*/i, "")
      .replace(/[^A-Za-z0-9-_]/g, "")
      .toUpperCase();
    if (cleaned.length >= 2) return cleaned;
  }
  const prefixMap = {
    apartment: "APT",
    villa: "VIL",
    townhouse: "TWN",
    twinhouse: "TWN",
    duplex: "DUP",
    penthouse: "PNT",
    chalet: "CHL",
    studio: "STU",
    office: "OFF",
    commercial: "COM",
    land: "LND"
  };
  const normType = String(propertyType || "").toLowerCase();
  const typeCode = prefixMap[normType] || "UNT";
  const randomEntropy = Math.floor(1000 + Math.random() * 9000);
  return `RK-${typeCode}-${randomEntropy}`;
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
  const limit =
    typeof maxCount === "number" ? maxCount : MAX_VISION_EVAL_IMAGES;
  const candidates = rawImages.slice(0, limit);
  return Promise.all(
    candidates.map(async (img) => {
      if (!img || !img.buffer) return null;
      try {
        const compressedBuffer = await sharp(img.buffer)
          .rotate()
          .resize({
            width: 1280,
            height: 1280,
            fit: "inside",
            withoutEnlargement: true
          })
          .jpeg({ quality: 80, mozjpeg: true })
          .toBuffer();
        return { buffer: compressedBuffer, mimeType: "image/jpeg" };
      } catch (err) {
        return { buffer: img.buffer, mimeType: img.mimeType || "image/jpeg" };
      }
    })
  ).then((results) => results.filter(Boolean));
}

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
        contents,
        config
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
        if (currentModel !== fallbackModel && fallbackModel) {
          currentModel = fallbackModel;
          attempt = 0;
          continue;
        }
        throw err;
      }
      await new Promise((res) =>
        setTimeout(
          res,
          Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500)
        )
      );
    }
  }
}

async function processBatchedListing(broker, batch) {
  const from = batch.from;
  const startTime = Date.now();
  const combinedInputText = [
    ...(batch.texts || []),
    ...(batch.captions || []),
    batch.customCode || ""
  ].join(" ");

  let targetLang = broker.preferred_lang || "ar";
  if (/(?:^|\s)(en|english|انجليزي|إنجليزي)(?:\$|\s)/i.test(combinedInputText))
    targetLang = "en";
  else if (/(?:^|\s)(ar|arabic|عربي)(?:\$|\s)/i.test(combinedInputText))
    targetLang = "ar";

  const isReplaceMode = /(?:^|\s)(استبدال|replace)(?:\$|\s)/i.test(
    combinedInputText
  );
  const hasImages = Boolean(batch.images && batch.images.length > 0);

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
    const parts = [];
    parts.push({
      text: `أنت نظام تدقيق واستخراج بيانات عقارية عالي الدقة لمنصة وساطة معتمدة.
مهمتك استخراج مواصفات الوحدة العقارية بدقة متناهية وإخراجها حصراً في صيغة JSON صالحة.
اللغة المطلوبة للمخرجات: "${targetLang}" (ar أو en فقط).

حقول الإخراج المطلوبة (JSON Schema):
{
  "custom_code": "أي كود خاص ذكره الوسيط (مثال: gj765 أو ref-20)، وإن لم يذكر اتركه null",
  "title": "عنوان تسويقي رسمي جذاب مستوحى من النص/الصوت فقط",
  "property_type": "يجب أن يكون حصراً أحد القيم التالية: apartment, villa, townhouse, twinhouse, duplex, penthouse, studio, chalet, office, commercial, land",
  "listing_type": "sale أو rent (افتراضي sale)",
  "price_value": "القيمة الرقمية المجردة للسعر كرقم أو null",
  "price_display": "السعر المنسق مع العملة أو null",
  "area_value": "المساحة كرقم بالمتر المربع أو null",
  "bedrooms": "عدد الغرف كرقم أو null",
  "location": "المدينة أو الحي",
  "compound": "اسم الكمبوند أو ''",
  "district": "المنطقة بالتفصيل",
  "city": "المدينة الرئيسية",
  "location_keywords": [],
  "details": {
    "clean_summary": "صياغة تنفيذية منسقة لما ورد في الوصف والصوت",
    "features": [],
    "installment_years": null,
    "down_payment_value": null,
    "image_order": []
  }
}`
    });

    const allTextNotes = [...(batch.texts || []), ...(batch.captions || [])];
    if (allTextNotes.length > 0) {
      parts.push({
        text: `--- [EXPLICIT BROKER TEXT] ---\n${allTextNotes.join("\n\n")}`
      });
    }

    const rawAudioItems = batch.voices || batch.audios || [];
    if (rawAudioItems.length > 0) {
      parts.push({ text: `--- [BROKER AUDIO RECORDINGS] ---` });
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

    let optimizedImages = [];
    if (hasImages) {
      parts.push({ text: `--- [ATTACHED IMAGES] ---` });
      const rawValidImages = batch.images.filter((img) => img && img.buffer);
      optimizedImages = await prepareImagesForGemini(
        rawValidImages,
        MAX_VISION_EVAL_IMAGES
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
      draftData = JSON.parse(cleanJsonResponse(response.text));
      usage = response.usageMetadata || {};
    } catch (aiErr) {
      console.error("[MULTIMODAL EXTRACTION ERROR]:", aiErr.message);
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "⚠️ AI extraction is experiencing temporary high demand. Please resend."
          : "⚠️ خوادم الذكاء الاصطناعي تشهد ضغطاً مؤقتاً. يرجى إعادة الإرسال."
      );
    }

    const sanitizedPrice = parseEgyptianPrice(
      draftData.price_value || draftData.price_display,
      { lang: targetLang, listingType: draftData.listing_type }
    );
    const parsedArea =
      Number(String(draftData.area_value || "").replace(/[^0-9.]/g, "")) ||
      null;
    const parsedBeds =
      Number(String(draftData.bedrooms || "").replace(/[^0-9]/g, "")) || null;

    const hasMeaningfulTitle = Boolean(
      draftData.title &&
        draftData.title !== "وحدة سكنية معروضة" &&
        draftData.title !== "Residential Property"
    );
    const hasPrice = Boolean(
      sanitizedPrice.priceValue || sanitizedPrice.priceDisplay
    );
    const hasArea = Boolean(parsedArea);
    const hasSummary = Boolean(
      draftData.details && draftData.details.clean_summary
    );
    const hasUploadedImages = Boolean(hasImages && optimizedImages.length > 0);

    if (!hasUploadedImages && !hasPrice && !hasArea && !hasMeaningfulTitle) {
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "⚠️ Could not extract sufficient specifications. Listing not saved."
          : "⚠️ لم يتم استخراج مواصفات كافية ولم تُرفق صور. لم يتم حفظ العقار."
      );
    }

    const unitPrefix = generateSafeListingCode(
      extractExplicitUnitCode(combinedInputText) ||
        draftData.custom_code ||
        batch.customCode,
      draftData.property_type
    );

    const existingListingRes = await pool.query(
      "SELECT id, code, flyer_url, title, property_type, listing_type, price_value, price_display, area_value, bedrooms, location, details FROM listings WHERE agency_id = $1 AND code = $2 LIMIT 1",
      [broker.agency_id, unitPrefix]
    );
    const existingListing = existingListingRes.rows[0];
    const agencyRes = await pool.query(
      "SELECT id, name, logo_url, primary_color, secondary_color FROM agencies WHERE id = $1 LIMIT 1",
      [broker.agency_id]
    );
    const agency = agencyRes.rows[0] || {};

    if (existingListing) {
      const uploadPromises = optimizedImages.map((imgObj, i) =>
        uploadListingImage(
          broker.agency_id,
          `${unitPrefix}-${Date.now()}-${i + 1}`,
          imgObj.buffer
        )
      );
      const newUploadedUrls = (await Promise.all(uploadPromises)).filter(
        Boolean
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let currentPosition = 0;
        if (hasImages) {
          if (isReplaceMode) {
            await client.query(
              "DELETE FROM listing_images WHERE listing_id = $1",
              [existingListing.id]
            );
          } else {
            const maxPosRes = await client.query(
              "SELECT COALESCE(MAX(position), -1) AS max_pos FROM listing_images WHERE listing_id = $1",
              [existingListing.id]
            );
            currentPosition = Number(maxPosRes.rows[0].max_pos) + 1;
          }
          for (let i = 0; i < newUploadedUrls.length; i++) {
            await client.query(
              "INSERT INTO listing_images (listing_id, agency_id, url, position) VALUES ($1, $2, $3, $4)",
              [
                existingListing.id,
                broker.agency_id,
                newUploadedUrls[i],
                currentPosition + i
              ]
            );
          }
        }

        const allImagesRes = await client.query(
          "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 15",
          [existingListing.id]
        );
        const allImageUrls = allImagesRes.rows.map((r) => r.url);

        const updatedPriceVal =
          sanitizedPrice.priceValue || existingListing.price_value;
        const updatedPriceDisp =
          sanitizedPrice.priceDisplay || existingListing.price_display;
        const updatedTitle = draftData.title || existingListing.title;
        const updatedArea = parsedArea || existingListing.area_value;
        const updatedBeds = parsedBeds || existingListing.bedrooms;

        let updatedFlyerUrl = existingListing.flyer_url;
        if (allImageUrls.length > 0) {
          try {
            const flyerBuffer = await generateFlyerBuffer({
              listing: {
                code: existingListing.code,
                title: updatedTitle,
                listing_type:
                  draftData.listing_type || existingListing.listing_type,
                price_value: updatedPriceVal,
                price_display: updatedPriceDisp,
                area_value: updatedArea,
                bedrooms: updatedBeds,
                location: draftData.location || existingListing.location,
                details: Object.assign(
                  {},
                  existingListing.details || {},
                  draftData.details || {}
                )
              },
              agency,
              images: allImageUrls,
              lang: targetLang
            });
            if (flyerBuffer)
              updatedFlyerUrl = await uploadFlyerImage(
                broker.agency_id,
                `${unitPrefix}-flyer-${Date.now()}`,
                flyerBuffer
              );
          } catch (flyerErr) {
            console.error("[FLYER RE-RENDER ERROR]:", flyerErr);
          }
        }

        await client.query(
          `UPDATE listings SET title = $1, price_value = $2, price_display = $3, area_value = $4, bedrooms = $5, location = $6, flyer_url = $7, updated_at = NOW() WHERE id = $8`,
          [
            updatedTitle,
            updatedPriceVal,
            updatedPriceDisp,
            updatedArea,
            updatedBeds,
            draftData.location || existingListing.location,
            updatedFlyerUrl,
            existingListing.id
          ]
        );

        await client.query("COMMIT");
        recentBrokerListings.set(normalizePhone(broker.phone), {
          code: unitPrefix,
          timestamp: Date.now()
        });

        if (updatedFlyerUrl) {
          await sendWhatsAppImage(
            from,
            updatedFlyerUrl,
            targetLang === "en"
              ? `📋 Updated Brochure - Unit #${unitPrefix}`
              : `📋 كتالوج تسويقي محدث - كود الوحدة: #${unitPrefix}`
          );
        }
        await sendWhatsAppText(
          from,
          targetLang === "en"
            ? `✅ Successfully updated unit *#${unitPrefix}*.`
            : `✅ تم تحديث الوحدة *#${unitPrefix}* بنجاح.`
        );
        return;
      } catch (dbErr) {
        await client.query("ROLLBACK");
        throw dbErr;
      } finally {
        client.release();
      }
    }

    let uploadedUrls = [];
    if (hasImages && optimizedImages.length > 0) {
      const uploadPromises = optimizedImages.map((imgObj, i) =>
        uploadListingImage(
          broker.agency_id,
          `${unitPrefix}-${i + 1}`,
          imgObj.buffer
        )
      );
      uploadedUrls = (await Promise.all(uploadPromises)).filter(Boolean);
    }

    let flyerStorageUrl = null;
    if (uploadedUrls.length > 0) {
      try {
        const flyerBuffer = await generateFlyerBuffer({
          listing: {
            code: unitPrefix,
            title: draftData.title,
            listing_type: draftData.listing_type || "sale",
            price_value: sanitizedPrice.priceValue,
            price_display: sanitizedPrice.priceDisplay,
            area_value: parsedArea,
            bedrooms: parsedBeds,
            location: draftData.location || "",
            details: draftData.details || {}
          },
          agency,
          images: uploadedUrls,
          lang: targetLang
        });
        if (flyerBuffer)
          flyerStorageUrl = await uploadFlyerImage(
            broker.agency_id,
            `${unitPrefix}-flyer`,
            flyerBuffer
          );
      } catch (flyerErr) {
        console.error("[FLYER RENDER ERROR]:", flyerErr);
      }
    }

    const client = await pool.connect();
    let savedListing = null;
    try {
      await client.query("BEGIN");
      const listingDetails = Object.assign({}, draftData.details || {}, {
        lang: targetLang
      });

      const insertListingSql = `
        INSERT INTO listings (
          agency_id, broker_id, code, title, property_type, listing_type,
          price_value, price_display, area_value, bedrooms, location,
          compound, district, city, location_keywords, details, flyer_url, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'active')
        RETURNING *;
      `;

      const listingRes = await client.query(insertListingSql, [
        broker.agency_id,
        broker.id,
        unitPrefix,
        draftData.title ||
          (targetLang === "en" ? "Residential Property" : "وحدة سكنية معروضة"),
        draftData.property_type || "apartment",
        draftData.listing_type || "sale",
        sanitizedPrice.priceValue,
        sanitizedPrice.priceDisplay,
        parsedArea,
        parsedBeds,
        draftData.location || "",
        draftData.compound || "",
        draftData.district || "",
        draftData.city || "",
        draftData.location_keywords || [],
        listingDetails,
        flyerStorageUrl
      ]);
      savedListing = listingRes.rows[0];

      if (uploadedUrls.length > 0) {
        for (let pos = 0; pos < uploadedUrls.length; pos++) {
          await client.query(
            "INSERT INTO listing_images (listing_id, agency_id, url, position) VALUES ($1, $2, $3, $4)",
            [savedListing.id, broker.agency_id, uploadedUrls[pos], pos]
          );
        }
      }

      await client.query("COMMIT");
      recentBrokerListings.set(normalizePhone(broker.phone), {
        code: savedListing.code,
        timestamp: Date.now()
      });
      console.log(`✅ [LISTING SAVED ATOMICALLY]: ${savedListing.code}`);
    } catch (dbErr) {
      await client.query("ROLLBACK");
      throw dbErr;
    } finally {
      client.release();
    }

    if (flyerStorageUrl) {
      await sendWhatsAppImage(
        from,
        flyerStorageUrl,
        targetLang === "en"
          ? `📋 Verified Brochure - Unit #${savedListing.code}`
          : `📋 كتالوج تسويقي معتمد - كود الوحدة: #${savedListing.code}`
      );
    }

    let clientSummaryText = formatClientListingText(
      savedListing,
      broker,
      targetLang
    );
    if (!hasImages || uploadedUrls.length === 0) {
      clientSummaryText +=
        targetLang === "en"
          ? `\n\n💡 *Note:* Saved without brochure photos. Send photos with caption: *add #${savedListing.code}*`
          : `\n\n💡 *ملاحظة:* تم تسجيل الوحدة بدون كتالوج مصور لعدم إرفاق صور. أرسل الصور مع: *إضافة #${savedListing.code}*`;
    }
    await sendWhatsAppText(from, clientSummaryText);
  } catch (fatalErr) {
    console.error("[BATCH EXECUTION FATAL ERROR]:", fatalErr);
    await sendWhatsAppText(
      from,
      targetLang === "en"
        ? "❌ An error occurred while saving the property."
        : "❌ حدث خطأ أثناء حفظ العقار، يرجى إعادة الإرسال."
    );
  }
}

async function handleSearchMessage(broker, options) {
  const text = options && options.text ? options.text : "";
  const audio = options && options.audio ? options.audio : null;
  const offset =
    options && typeof options.offset === "number" ? options.offset : 0;
  const from = broker.phone;
  const cleanKey = normalizePhone(from);
  const startMs = Date.now();
  const isVoice = Boolean(audio && audio.buffer && audio.buffer.length > 0);
  const targetLang = broker.preferred_lang || "ar";

  if (isVoice && audio.duration && audio.duration > MAX_SEARCH_AUDIO_SEC) {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? `⚠️ Voice search recording is too long (${audio.duration}s).`
        : `⚠️ التسجيل الصوتي للبحث طويل جداً (${audio.duration} ثانية).`
    );
  }

  if (offset === 0) {
    sendWhatsAppText(
      from,
      isVoice
        ? "🎙️ جاري الاستماع للملاحظة الصوتية ومعالجة طلبك..."
        : "🔍 جاري البحث في قاعدة البيانات ومطابقة طلبك..."
    ).catch(() => {});
  }

  const searchPrompt = [
    "You are an Egyptian real estate intent and search query parser.",
    'Determine if the broker is searching for inventory (intent: "search") or submitting a new property listing to save (intent: "create_listing").',
    'Return strict JSON: { "intent": "search | create_listing", "filters": { "property_type": null, "listing_type": null, "bedrooms": null, "price_max": null, "price_min": null }, "location_terms": [] }',
    CANONICAL_REAL_ESTATE_RULES
  ].join("\n");

  const parts = [{ text: searchPrompt }];
  if (text.trim()) parts.push({ text: "\n--- INPUT ---\n" + text.trim() });
  if (isVoice)
    parts.push({
      inlineData: {
        mimeType: audio.mimeType || "audio/ogg",
        data: audio.buffer.toString("base64")
      }
    });

  let parsed = { intent: "search", filters: {}, location_terms: [] };
  try {
    const response = await generateContentWithRetry({
      contents: parts,
      config: isVoice ? VOICE_SEARCH_CONFIG : TEXT_SEARCH_CONFIG,
      primaryModel: GEMINI_MODEL_ID,
      maxRetries: 3
    });
    parsed = JSON.parse(cleanJsonResponse(response.text));
  } catch (parseErr) {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "❌ Could not understand search request."
        : "❌ تعذر فهم طلب البحث."
    );
  }

  if (parsed.intent === "create_listing" && offset === 0) {
    if (incomingBatches.has(cleanKey)) {
      const batch = reserveBatch(broker);
      if (text) batch.texts.push(text);
      if (isVoice) {
        batch.audios.push(audio);
        batch.voices.push(audio);
      }
      resetBatchDebounceTimer(cleanKey);
      return;
    }
    return listingLimiter(() =>
      processBatchedListing(broker, {
        from,
        texts: text ? [text] : [],
        audios: isVoice ? [audio] : [],
        images: []
      })
    );
  }

  lastSearchState.set(cleanKey, { text, audio, offset });
  const where = ["l.agency_id = $1", "l.status = 'active'"];
  const params = [broker.agency_id];
  let pIdx = 2;
  const filters = parsed.filters || {};

  if (filters.listing_type) {
    where.push(`l.listing_type = $${pIdx++}`);
    params.push(filters.listing_type);
  }
  if (filters.property_type) {
    where.push(`l.property_type = $${pIdx++}`);
    params.push(filters.property_type);
  }
  if (filters.price_max) {
    where.push(`l.price_value <= $${pIdx++}`);
    params.push(filters.price_max);
  }
  if (filters.price_min) {
    where.push(`l.price_value >= $${pIdx++}`);
    params.push(filters.price_min);
  }

  params.push(SEARCH_PAGE_SIZE, offset);
  const sql = `SELECT l.code, l.title, l.property_type, l.listing_type, l.price_display, l.area_value, l.bedrooms, l.location, l.details, COUNT(*) OVER() AS total_count FROM listings l WHERE ${where.join(
    " AND "
  )} ORDER BY l.created_at DESC LIMIT $${pIdx++} OFFSET $${pIdx++}`;

  let rows = [];
  try {
    const dbRes = await pool.query(sql, params);
    rows = dbRes.rows;
  } catch (dbErr) {
    return sendWhatsAppText(from, "❌ Database error during search.");
  }

  const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
  if (totalCount === 0) {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "🔍 No matching listings found."
        : "🔍 لم يتم العثور على وحدات مطابقة."
    );
  }

  const responseLines = [
    targetLang === "en"
      ? `🔍 Search Results (${totalCount} units):\n`
      : `🔍 نتائج البحث (${totalCount} وحدة):\n`
  ];
  for (let i = 0; i < rows.length; i++) {
    const unit = rows[i];
    responseLines.push(
      `*${offset + i + 1}. #${unit.code}* - ${unit.title}\n   💰 ${
        unit.price_display
      } | 📐 ${unit.area_value || "-"} m² | 🛏️ ${unit.bedrooms || "-"}\n   📍 ${
        unit.location || "-"
      }\n`
    );
  }
  return sendWhatsAppText(from, responseLines.join("\n"));
}

async function handleSingleMessage(broker, message) {
  const from = broker.phone;
  const cleanKey = normalizePhone(from);
  const msgType = message.type;
  const targetLang = broker.preferred_lang || "ar";

  if (msgType === "image") {
    const mediaId = message.image && message.image.id;
    const caption = (
      message.image && message.image.caption ? message.image.caption : ""
    ).trim();
    const extractedCode = extractExplicitUnitCode(caption);

    const batch = reserveBatch(broker, extractedCode);
    if (caption) batch.captions.push(caption);
    batch.pendingDownloads++;

    (async () => {
      try {
        const downloaded = await downloadWhatsAppMedia(mediaId);
        if (downloaded && downloaded.buffer) {
          if (batch.images.length < MAX_VISION_EVAL_IMAGES) {
            batch.images.push({
              buffer: downloaded.buffer,
              mimeType: downloaded.mimeType
            });
          }
        }
      } catch (dlErr) {
        console.error("[IMAGE DOWNLOAD FAILED]:", dlErr.message);
      } finally {
        batch.pendingDownloads = Math.max(0, batch.pendingDownloads - 1);
        resetBatchDebounceTimer(cleanKey);
      }
    })();
    return;
  }

  if (msgType === "audio" || msgType === "voice") {
    const mediaObj = message.audio || message.voice;
    const mediaId = mediaObj && mediaObj.id;
    const duration =
      mediaObj && mediaObj.duration ? Number(mediaObj.duration) : 0;

    const batchActive = isBatchingActive(from);
    let batch = null;
    if (batchActive) {
      batch = reserveBatch(broker);
      batch.pendingDownloads++;
    }

    const downloaded = await downloadWhatsAppMedia(mediaId);
    if (!downloaded) {
      if (batch) {
        batch.pendingDownloads = Math.max(0, batch.pendingDownloads - 1);
        resetBatchDebounceTimer(cleanKey);
      }
      return;
    }

    const audioObj = {
      buffer: downloaded.buffer,
      mimeType: downloaded.mimeType,
      duration
    };
    if (batchActive && batch) {
      batch.audios.push(audioObj);
      batch.voices.push(audioObj);
      batch.pendingDownloads = Math.max(0, batch.pendingDownloads - 1);
      resetBatchDebounceTimer(cleanKey);
      return;
    }
    return handleSearchMessage(broker, { audio: audioObj, offset: 0 });
  }

  if (msgType === "video") {
    return sendWhatsAppText(
      from,
      targetLang === "en"
        ? "📹 Video walkthroughs are not supported for catalog flyers. Please send photos (JPEG/PNG) or voice/text specs."
        : "📹 فيديوهات المعاينة غير مدعومة للكتالوجات. يرجى إرسال صور أو مواصفات صوتية/نصية."
    );
  }

  if (msgType !== "text") return;
  const rawText = (
    message.text && message.text.body ? message.text.body : ""
  ).trim();
  if (!rawText) return;

  if (isBatchingActive(from)) {
    const batch = reserveBatch(broker);
    batch.texts.push(rawText);
    resetBatchDebounceTimer(cleanKey);
    return;
  }

  const lower = rawText.toLowerCase();
  if (/(?:^|\s)(help|مساعدة|اوامر|أوامر|قواعد|تعليمات)(?:\$|\s)/i.test(lower)) {
    return sendWhatsAppText(from, getHelpMessage());
  }

  if (rawText === "المزيد" || lower === "more") {
    const prev = lastSearchState.get(cleanKey);
    if (!prev)
      return sendWhatsAppText(
        from,
        targetLang === "en"
          ? "⚠️ No active search found."
          : "⚠️ لا يوجد بحث سابق نشط."
      );
    return handleSearchMessage(broker, {
      text: prev.text,
      audio: prev.audio,
      offset: prev.offset + SEARCH_PAGE_SIZE
    });
  }

  if (/(?:^|\s)(احصائيات|إحصائيات|stats)(?:\$|\s)/i.test(rawText)) {
    const statsRes = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_count, COUNT(*) FILTER (WHERE status = 'sold') AS sold_count FROM listings WHERE agency_id = $1",
      [broker.agency_id]
    );
    const st = statsRes.rows[0] || {};
    return sendWhatsAppText(
      from,
      `📊 إحصائيات المخزون:\n• الوحدات النشطة: ${
        st.active_count || 0
      }\n• المباعة: ${st.sold_count || 0}`
    );
  }

  const priceMatch = rawText.match(
    /^(?:سعر|price)\s+#?([A-Z0-9-]+)\s+(?:إلى|الى|ل|to)\s+(.+)$/i
  );
  if (priceMatch) {
    const code = priceMatch[1].toUpperCase();
    const parsedPrice = parseEgyptianPrice(priceMatch[2], { lang: targetLang });
    const upd = await pool.query(
      "UPDATE listings SET price_value = $1, price_display = $2, updated_at = NOW() WHERE agency_id = $3 AND code = $4 RETURNING *",
      [parsedPrice.priceValue, parsedPrice.priceDisplay, broker.agency_id, code]
    );
    if (upd.rowCount === 0)
      return sendWhatsAppText(from, `❌ Listing not found: #${code}`);

    const imgRes = await pool.query(
      "SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 15",
      [upd.rows[0].id]
    );
    if (imgRes.rowCount > 0) {
      try {
        const agencyRes = await pool.query(
          "SELECT * FROM agencies WHERE id = $1 LIMIT 1",
          [broker.agency_id]
        );
        const flyerBuffer = await generateFlyerBuffer({
          listing: upd.rows[0],
          agency: agencyRes.rows[0] || {},
          images: imgRes.rows.map((r) => r.url),
          lang: targetLang
        });
        if (flyerBuffer) {
          const newFlyerUrl = await uploadFlyerImage(
            broker.agency_id,
            `${code}-flyer-${Date.now()}`,
            flyerBuffer
          );
          await pool.query("UPDATE listings SET flyer_url = $1 WHERE id = $2", [
            newFlyerUrl,
            upd.rows[0].id
          ]);
          await sendWhatsAppImage(
            from,
            newFlyerUrl,
            `📋 Updated Flyer for #${code}`
          );
        }
      } catch (e) {
        console.error("[FLYER PRICE UPDATE RE-RENDER ERROR]:", e);
      }
    }
    return sendWhatsAppText(
      from,
      `✅ Price updated for #${code} to ${upd.rows[0].price_display}.`
    );
  }

  const clientBrochureMatch = rawText.match(
    /^(?:كتالوج\s+عميل|بروشور\s+عميل|catalog\s+client|brochure\s+client)\s+#?([A-Z0-9-]+)$/i
  );
  if (clientBrochureMatch) {
    const code = clientBrochureMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );
    if (res.rowCount === 0)
      return sendWhatsAppText(from, `❌ Listing not found: #${code}`);
    const listing = res.rows[0];
    const clientText = formatClientListingText(listing, broker, targetLang);
    if (listing.flyer_url)
      return sendWhatsAppImage(
        from,
        listing.flyer_url + "?t=" + Date.now(),
        clientText
      );
    return sendWhatsAppText(from, clientText);
  }

  const internalDetailsMatch = rawText.match(/^#([A-Z0-9-]+)$/i);
  if (internalDetailsMatch) {
    const code = internalDetailsMatch[1].toUpperCase();
    const res = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND code = $2",
      [broker.agency_id, code]
    );
    if (res.rowCount === 0)
      return sendWhatsAppText(from, `❌ Listing not found: #${code}`);
    return sendWhatsAppText(
      from,
      formatInternalListingDetails(res.rows[0], targetLang)
    );
  }

  if (isLikelyListingMetadata(rawText)) {
    const customCode = extractExplicitUnitCode(rawText);
    const timer = setTimeout(() => {
      pendingTextBuffers.delete(cleanKey);
      handleSearchMessage(broker, { text: rawText, offset: 0 });
    }, 2500);
    pendingTextBuffers.set(cleanKey, { text: rawText, customCode, timer });
    return;
  }

  return handleSearchMessage(broker, { text: rawText, offset: 0 });
}

app.post("/webhook", function (req, res) {
  res.status(200).send("EVENT_RECEIVED");

  setImmediate(async function () {
    try {
      const entry = req.body && req.body.entry && req.body.entry[0];
      const change =
        entry && entry.changes && entry.changes[0] && entry.changes[0].value;
      const messages =
        change && Array.isArray(change.messages) ? change.messages : [];
      if (messages.length === 0) return;

      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const from = message.from;
        const msgId = message.id;
        if (!from || !msgId) continue;

        if (processedMessageIds.has(msgId)) continue;
        processedMessageIds.set(msgId, Date.now());

        const brokerRes = await pool.query(
          "SELECT id, agency_id, name, phone, contact_phone, role, is_active, preferred_lang FROM brokers WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1 LIMIT 1",
          [normalizePhone(from)]
        );

        if (brokerRes.rowCount === 0) {
          await sendWhatsAppText(
            from,
            "⚠️ رقم الهاتف غير مسجل في أي وكالة عقارية معتمدة."
          );
          continue;
        }

        const broker = brokerRes.rows[0];
        if (broker.is_active === false) {
          await sendWhatsAppText(from, "⛔ تم تعطيل هذا الحساب مؤقتاً.");
          continue;
        }

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
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN)
    return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.get("/health", async function (req, res) {
  try {
    await pool.query("SELECT 1");
    res
      .status(200)
      .json({ status: "ok", uptime: process.uptime(), database: "connected" });
  } catch (err) {
    res
      .status(500)
      .json({ status: "error", database: "disconnected", error: err.message });
  }
});

app.get("/", function (req, res) {
  res.status(200).send("Real Estate WhatsApp Engine is active.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("🚀 Real Estate WhatsApp Engine online on port " + PORT);
});
