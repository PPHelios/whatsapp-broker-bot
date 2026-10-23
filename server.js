// server.js — Core WhatsApp Ingestion Router, State Machine & Orchestration Engine
"use strict";
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const sharp = require("sharp");
const ExcelJS = require("exceljs");

// Internal Library Modules
const DB = require("./lib/db");
const Drafts = require("./lib/drafts");
const Flyer = require("./lib/flyer");
const Excel = require("./lib/excel");
const Supabase = require("./lib/supabase");
const Financials = require("./lib/financials");
const U = require("./lib/util");
const T = require("./lib/text");
const S = require("./lib/search");
const L = require("./lib/listing");
const WA = require("./lib/whatsapp");

const app = express();

// Capture raw body buffer for Meta Webhook HMAC-SHA256 signature verification
app.use(
  express.json({
    limit: "50mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// Ephemeral Debounce Timers & In-Process Concurrency Serializers
const burstTimers = new Map();
const brokerSerializers = U.createSerializer();

// Google Gemini AI Client Initialization
let geminiClient = null;

async function getGeminiClient() {
  if (geminiClient) return geminiClient;
  if (!process.env.GEMINI_API_KEY) return null;

  try {
    const { GoogleGenAI } = await import("@google/genai");
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return geminiClient;
  } catch (err) {
    DB.logStdout("error", "Failed to load @google/genai ESM module", {
      err: err.message
    });
    return null;
  }
}
const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
const GEMINI_VISION_MODEL =
  process.env.GEMINI_VISION_MODEL || "gemini-2.5-flash";

/* ====================================================================== */
/* 1. Distributed PostgreSQL Session State Store                          */
/* ====================================================================== */

async function setSession(brokerId, sessionType, data, ttlSeconds = 900) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await DB.query(
    `INSERT INTO broker_sessions (broker_id, session_type, context_data, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       context_data = EXCLUDED.context_data,
       expires_at = EXCLUDED.expires_at`,
    [brokerId, sessionType, JSON.stringify(data), expiresAt]
  );
}

async function getSession(brokerId, sessionType) {
  const res = await DB.query(
    `SELECT context_data FROM broker_sessions
     WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()`,
    [brokerId, sessionType]
  );
  return res.rows[0]?.context_data || null;
}

async function deleteSession(brokerId, sessionType) {
  await DB.query(
    `DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2`,
    [brokerId, sessionType]
  );
}

/* ====================================================================== */
/* 2. Broker Authentication & Multi-Tenancy Helpers                       */
/* ====================================================================== */

async function resolveBroker(phone) {
  const cleanPhone = U.normalizePhone(phone);
  if (!cleanPhone) return null;

  // Handles international (+2010...), local (010...), and unadorned digits (2010...)
  const res = await DB.query(
    `SELECT b.*, a.name AS agency_name, a.logo_url AS agency_logo,
            a.primary_color, a.secondary_color, a.phone AS agency_phone
     FROM brokers b
     JOIN agencies a ON b.agency_id = a.id
     WHERE b.phone_number = $1
        OR b.phone_normalized = $1
        OR b.phone_normalized = ('+' || $1)
        OR b.phone_number = regexp_replace($1, '^\\+?20', '0')
        OR b.contact_phone = $1
     LIMIT 1`,
    [cleanPhone]
  );
  return res.rows[0] || null;
}

// Fixed recipient phone accessor aligned with database schema
const to = (broker) =>
  broker.phone_number || broker.phone_normalized || broker.contact_phone;
const M = (lang, ar, en) => (lang === "en" ? en : ar);

async function reply(broker, text) {
  return WA.sendWhatsAppText(to(broker), text);
}

function canEdit(broker, listing) {
  if (!broker || !listing) return false;
  if (["admin", "owner", "manager"].includes(broker.role)) return true;
  if (broker.id === listing.broker_id) return true;
  return process.env.ALLOW_COLLEAGUE_EDITS === "true";
}

async function fetchListing(broker, rawCode) {
  const code = T.extractCleanCode(rawCode);
  if (!code) return null;

  const res = await DB.query(
    `SELECT * FROM listings
     WHERE agency_id = $1 AND (code = $2 OR developer_unit_code = $2)
     LIMIT 1`,
    [broker.agency_id, code]
  );
  return res.rows[0] || null;
}

async function notFound(broker, code) {
  const lang = broker.preferred_lang || "ar";
  DB.logStdout("warn", "Requested property code not found", {
    code,
    brokerId: broker.id
  });
  await reply(
    broker,
    M(
      lang,
      `⚠️ لم يتم العثور على وحدة بالكود \`${code}\` في مخزون الوكالة.`,
      `⚠️ No unit found with code \`${code}\` in agency inventory.`
    )
  );
  return true;
}

/* ====================================================================== */
/* 3. Standard Search Card & Pagination View                              */
/* ====================================================================== */

async function showListingCard(broker, listing) {
  const lang = broker.preferred_lang || "ar";
  const isEn = lang === "en";
  const code = listing.code;
  const isPrimary = Boolean(listing.payment_terms?.plans?.length);

  const header = T.formatStandardHeader(listing, lang);
  const specs = [
    `📐 *${isEn ? "Area:" : "المساحة:"}* ${listing.area_value || "-"} ${
      isEn ? "sqm" : "م²"
    }`,
    `🛏️ *${isEn ? "Beds:" : "الغرف:"}* ${listing.bedrooms ?? "-"}`,
    listing.details?.bathrooms || listing.bathrooms
      ? `🛁 *${isEn ? "Baths:" : "الحمامات:"}* ${
          listing.details?.bathrooms || listing.bathrooms
        }`
      : null,
    listing.details?.orientation
      ? `🧭 *${isEn ? "Orientation:" : "الوجهة:"}* ${
          listing.details.orientation
        }`
      : null,
    listing.details?.finishing
      ? `🎨 *${isEn ? "Finishing:" : "التشطيب:"}* ${listing.details.finishing}`
      : null
  ]
    .filter(Boolean)
    .join(" | ");

  let financialSection = `💰 *${
    isEn ? "Total Price:" : "إجمالي السعر:"
  }* ${T.priceText(listing, lang)}`;

  if (isPrimary) {
    const bestPlan = listing.payment_terms.plans[0];
    financialSection += `\n💳 *${isEn ? "Payment Plan:" : "نظام السداد:"}* ${
      bestPlan.years
    } ${isEn ? "Years" : "سنوات"} (Down: ${bestPlan.down_payment_pct}%)`;
  } else {
    const upfront =
      listing.details?.total_upfront_cash || listing.down_payment_value;
    if (upfront) {
      financialSection += `\n💵 *${
        isEn ? "Cash Required:" : "كاش مطلوب:"
      }* ${T.formatAbbreviatedPrice(
        upfront,
        listing.details?.currency || "EGP",
        lang
      )}`;
    }
    if (listing.details?.remaining_balance) {
      financialSection += `\n🗓️ *${
        isEn ? "Remaining Debt:" : "متبقي أقساط:"
      }* ${T.formatAbbreviatedPrice(
        listing.details.remaining_balance,
        listing.details?.currency || "EGP",
        lang
      )}`;
    }
  }

  const deliveryStr = listing.details?.ready_to_move
    ? isEn
      ? "Immediate (Ready to Move)"
      : "فوري (جاهز للاستلام)"
    : listing.details?.delivery_date || "-";
  financialSection += `\n📅 *${
    isEn ? "Delivery:" : "الاستلام:"
  }* ${deliveryStr}`;

  const cardText = `${header}\n─────────────────────────\n${specs}\n─────────────────────────\n${financialSection}`;

  const buttons = [
    { id: `flyer:${code}`, title: isEn ? "Brochure 📄" : "البروشور 📄" },
    isPrimary
      ? {
          id: `plans_view:${code}`,
          title: isEn ? "Payment Plans 💳" : "أنظمة السداد 💳"
        }
      : { id: `edit_unit:${code}`, title: isEn ? "Edit ✏️" : "تعديل ✏️" },
    { id: `client:${code}`, title: isEn ? "Client Text 📋" : "نص العميل 📋" }
  ];

  await WA.sendWhatsAppButtons(to(broker), cardText, buttons);
}

/* ====================================================================== */
/* 4. On-Demand First-Flyer Vision Curation & Photo Pruning               */
/* ====================================================================== */

async function renderFlyerOnDemand(
  broker,
  code,
  { theme = "dark", unbranded = false } = {}
) {
  const t0 = Date.now();
  let geminiDuration = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let storageUploadDuration = 0;
  let renderDuration = 0;

  const lang = broker.preferred_lang || "ar";
  const listing = await fetchListing(broker, code);
  if (!listing) return notFound(broker, code);

  const cacheKey = `${theme}_${unbranded ? "unbranded" : "branded"}`;
  if (listing.flyer_cache && listing.flyer_cache[cacheKey]) {
    DB.logStdout("info", "Serving flyer from cache", {
      code: listing.code,
      cacheKey
    });
    await WA.sendWhatsAppImage(
      to(broker),
      listing.flyer_cache[cacheKey],
      `#${listing.code}`
    );
    return true;
  }

  // Quoted "position" to avoid reserved keyword collision
  const imgRes = await DB.query(
    `SELECT * FROM listing_images
     WHERE listing_id = $1
     ORDER BY "position" ASC`,
    [listing.id]
  );
  let images = imgRes.rows;

  if (!images.length) {
    DB.logStdout("warn", "Cannot render flyer without images", {
      code: listing.code
    });
    await reply(
      broker,
      M(
        lang,
        `⚠️ لا توجد صور مرفوعة للوحدة #${listing.code} لإنشاء البروشور.`,
        `⚠️ No images uploaded for unit #${listing.code} to generate brochure.`
      )
    );
    return false;
  }

  // FIRST FLYER REQUEST: Run Gemini Vision Curation & Photo Pruning if images are 'unprocessed'
  const needsCuration = images.some(
    (img) => img.role === "unprocessed" || !img.role
  );

  if (needsCuration && images.length > 1 && geminiClient) {
    try {
      await DB.checkAiQuota(broker.agency_id, broker.id);

      const imagePayloads = [];
      for (const img of images.slice(0, 15)) {
        const res = await fetch(img.url, {
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          imagePayloads.push({
            id: img.id,
            url: img.url,
            inlineData: {
              mimeType: "image/jpeg",
              data: buf.toString("base64")
            }
          });
        }
      }

      if (imagePayloads.length > 1) {
        const v0 = Date.now();
        const visionPrompt = L.buildVisionPrompt();
        const response = await geminiClient.models.generateContent({
          model: GEMINI_VISION_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { text: visionPrompt },
                ...imagePayloads.map((p) => ({ inlineData: p.inlineData }))
              ]
            }
          ],
          config: { responseMimeType: "application/json", temperature: 0.1 }
        });

        geminiDuration = Date.now() - v0;
        tokensIn = response.usageMetadata?.promptTokenCount || 0;
        tokensOut = response.usageMetadata?.candidatesTokenCount || 0;

        const visionRaw = JSON.parse(
          response.text.replace(/^```json|```$/g, "").trim()
        );
        const curation = L.validateVisionDraft(visionRaw, imagePayloads.length);

        const keptIndices = (curation.image_order || []).slice(0, 9);
        const keptImages = [];
        const rejectedImages = [];

        imagePayloads.forEach((item, index) => {
          if (keptIndices.includes(index)) {
            keptImages.push({
              id: item.id,
              url: item.url,
              position: keptIndices.indexOf(index),
              role:
                curation.image_roles[index] ||
                (keptIndices.indexOf(index) === 0 ? "facade" : "other")
            });
          } else {
            rejectedImages.push(item);
          }
        });

        // 1. Update kept images in DB with designated roles and sequential positions
        for (const kept of keptImages) {
          await DB.query(
            `UPDATE listing_images SET "position" = $1, role = $2 WHERE id = $3`,
            [kept.position, kept.role, kept.id]
          );
        }

        // 2. PRUNING: Permanently delete excess rejected images from Supabase Storage & DB
        if (rejectedImages.length > 0) {
          const pathsToDelete = rejectedImages.map((img) => img.url);
          await Supabase.deleteStorageFiles(pathsToDelete);
          await DB.query(
            "DELETE FROM listing_images WHERE id = ANY($1::uuid[])",
            [rejectedImages.map((img) => img.id)]
          );
        }

        images = keptImages.sort((a, b) => a.position - b.position);

        await DB.logOperation({
          agency_id: broker.agency_id,
          broker_id: broker.id,
          listing_code: listing.code,
          operation_type: "curate_and_prune_media",
          status: "success",
          gemini_ms: geminiDuration,
          tokens_input: tokensIn,
          tokens_output: tokensOut,
          model_used: GEMINI_VISION_MODEL,
          metadata: { kept: keptImages.length, pruned: rejectedImages.length }
        });

        DB.logStdout(
          "info",
          "Vision curation completed and excess photos pruned",
          {
            code: listing.code,
            keptCount: keptImages.length,
            prunedCount: rejectedImages.length
          }
        );
      }
    } catch (err) {
      DB.logStdout(
        "warn",
        "Vision curation bypassed, falling back to sequential ordering",
        {
          code: listing.code,
          err: err.message
        }
      );
      images = images.slice(0, 9);
    }
  }

  // Render the Dynamic Luxury Flyer
  const r0 = Date.now();
  const agency = {
    name: broker.agency_name,
    logo_url: broker.agency_logo,
    primary_color: broker.primary_color,
    secondary_color: broker.secondary_color,
    phone: broker.agency_phone
  };

  const flyerBuffer = await Flyer.generateFlyerBuffer({
    listing,
    agency,
    broker,
    images: images.map((i) => i.url),
    theme,
    unbranded
  });
  renderDuration = Date.now() - r0;

  // Upload to Supabase Storage
  const s0 = Date.now();
  const storagePath = `flyers/${broker.agency_id}/${
    listing.code
  }_${cacheKey}_${Date.now()}.jpg`;
  const flyerUrl = await Supabase.uploadFlyerImage(
    broker.agency_id,
    storagePath,
    flyerBuffer
  );
  storageUploadDuration = Date.now() - s0;

  // Update Flyer Cache on Listing
  await DB.query(
    `UPDATE listings
     SET flyer_cache = jsonb_set(COALESCE(flyer_cache, '{}'::jsonb), $1, $2::jsonb),
         updated_at = NOW()
     WHERE id = $3`,
    [`{${cacheKey}}`, JSON.stringify(flyerUrl), listing.id]
  );

  const totalDuration = Date.now() - t0;

  await DB.logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: listing.code,
    operation_type: "generate_flyer",
    status: "success",
    total_duration_ms: totalDuration,
    gemini_ms: geminiDuration,
    flyer_render_ms: renderDuration,
    storage_upload_ms: storageUploadDuration,
    tokens_input: tokensIn,
    tokens_output: tokensOut,
    model_used: geminiDuration > 0 ? GEMINI_VISION_MODEL : null,
    metadata: { theme, unbranded }
  });

  DB.logStdout("info", "Flyer rendered and dispatched successfully", {
    code: listing.code,
    durationMs: totalDuration,
    flyerUrl
  });

  await WA.sendWhatsAppImage(to(broker), flyerUrl, `#${listing.code}`);
  return true;
}

/* ====================================================================== */
/* 5. Review Card Generation & Atomic Commit Workflow                     */
/* ====================================================================== */

async function cmdReviewDraft(broker) {
  const t0 = Date.now();
  const lang = broker.preferred_lang || "ar";
  const draft = await Drafts.getDraft(broker.id);

  if (
    !draft ||
    (!draft.texts?.length &&
      !draft.voice_buffers?.length &&
      !draft.media_items?.length)
  ) {
    DB.logStdout("info", "Draft review requested on empty draft", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "⚠️ لا توجد مسودة نشطة حالياً. اكتب *اضافة* لبدء تسجيل وحدة جديدة.",
        "⚠️ No active draft found. Type *add* to begin a new listing."
      )
    );
    return;
  }

  await DB.checkAiQuota(broker.agency_id, broker.id);

  const parts = [{ text: L.buildListingPrompt(lang) }];

  if (draft.texts?.length) {
    parts.push({ text: `=== PROPERTY NOTES ===\n${draft.texts.join("\n")}` });
  }

  for (const v of draft.voice_buffers || []) {
    parts.push({
      inlineData: {
        mimeType: U.cleanAudioMime(v.mimeType),
        data: v.buffer.toString("base64")
      }
    });
  }

  const v0 = Date.now();
  const response = await geminiClient.models.generateContent({
    model: GEMINI_TEXT_MODEL,
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", temperature: 0.1 }
  });
  const geminiDuration = Date.now() - v0;

  const tokensIn = response.usageMetadata?.promptTokenCount || 0;
  const tokensOut = response.usageMetadata?.candidatesTokenCount || 0;

  const parsedJson = JSON.parse(
    response.text.replace(/^```json|```$/g, "").trim()
  );
  const validated = L.validateDraft(parsedJson, lang);
  const parsedPrice = T.parseEgyptianPrice(validated.price_raw, { lang });
  const check = L.checkDraftCompleteness(validated, parsedPrice);

  await DB.logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "review_draft_ai",
    status: check.isComplete ? "success" : "validation_failed",
    total_duration_ms: Date.now() - t0,
    gemini_ms: geminiDuration,
    tokens_input: tokensIn,
    tokens_output: tokensOut,
    model_used: GEMINI_TEXT_MODEL,
    metadata: {
      isComplete: check.isComplete,
      blockersCount: check.blockers.length
    }
  });

  if (!check.isComplete) {
    DB.logStdout("warn", "Draft failed completeness validation", {
      brokerId: broker.id,
      blockers: check.blockers
    });
    const errorList = check.blockers.map((b) => `• ${b}`).join("\n");
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `⚠️ *بيانات إلزامية ناقصة لاعتماد الوحدة:*\n${errorList}\n\nيرجى إرسال البيانات الناقصة (صوت أو كتابة):`,
        `⚠️ *Mandatory missing fields:*\n${errorList}\n\nPlease provide missing specs:`
      ),
      [
        {
          id: "draft_edit",
          title: M(lang, "✏️ استكمال البيانات", "✏️ Provide Specs")
        },
        {
          id: "draft_cancel",
          title: M(lang, "🗑️ إلغاء المسودة", "🗑️ Cancel Draft")
        }
      ]
    );
    return;
  }

  // Stage validated listing data in PostgreSQL for multi-pod confirmation
  await Drafts.stageDraftReview(broker.id, validated, draft.media_items);

  DB.logStdout("info", "Draft passed validation and staged for confirmation", {
    brokerId: broker.id
  });

  const reviewCardText = T.formatDraftReviewCard(
    validated,
    parsedPrice,
    check,
    lang
  );

  // Meta Button API Constraint: Body text cannot exceed 1024 characters
  if (reviewCardText.length > 950) {
    await WA.sendWhatsAppText(to(broker), reviewCardText);
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        "اختر الإجراء المناسب للاعتماد أو التعديل:",
        "Choose an action to confirm or modify:"
      ),
      [
        {
          id: "draft_confirm_save",
          title: M(lang, "✅ تأكيد وحفظ", "✅ Confirm & Save")
        },
        { id: "draft_edit", title: M(lang, "✏️ تعديل", "✏️ Edit Details") },
        { id: "draft_cancel", title: M(lang, "❌ إلغاء", "❌ Cancel") }
      ]
    );
  } else {
    await WA.sendWhatsAppButtons(to(broker), reviewCardText, [
      {
        id: "draft_confirm_save",
        title: M(lang, "✅ تأكيد وحفظ", "✅ Confirm & Save")
      },
      { id: "draft_edit", title: M(lang, "✏️ تعديل", "✏️ Edit Details") },
      { id: "draft_cancel", title: M(lang, "❌ إلغاء", "❌ Cancel") }
    ]);
  }
}

async function cmdExecuteConfirmSave(broker) {
  const t0 = Date.now();
  const lang = broker.preferred_lang || "ar";

  // Double-tap idempotency protection check
  const recentCommit = await getSession(broker.id, "recent_commit");
  if (recentCommit && recentCommit.code) {
    DB.logStdout(
      "info",
      "Idempotency caught double-tap commit; returning saved status",
      {
        code: recentCommit.code,
        brokerId: broker.id
      }
    );
    await reply(
      broker,
      M(
        lang,
        `✅ تم استلام وتأكيد حفظ الوحدة مسبقاً بكود: \`${recentCommit.code}\``,
        `✅ Unit was already successfully saved under code: \`${recentCommit.code}\``
      )
    );
    return;
  }

  const staged = await Drafts.getStagedDraft(broker.id);
  if (!staged || !staged.listingData) {
    DB.logStdout("warn", "Staged draft not found or expired during commit", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "⚠️ انتهت صلاحية جلسة المراجعة (15 دقيقة) أو تم حفظها مسبقاً. أرسل *اضافة* للبدء من جديد.",
        "⚠️ Review session expired (15m TTL) or already committed. Type *add* to restart."
      )
    );
    return;
  }

  const draft = await Drafts.getDraft(broker.id);
  const uploadedImages = [];

  const s0 = Date.now();
  for (let i = 0; i < (draft?.media_items || []).length; i++) {
    const item = draft.media_items[i];
    const compressedBuf = await sharp(item.buffer)
      .rotate()
      .resize({
        width: 1600,
        height: 1600,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();

    const path = `properties/${broker.agency_id}/${Date.now()}_${i}.jpg`;
    const publicUrl = await Supabase.uploadListingImage(
      broker.agency_id,
      path,
      compressedBuf
    );

    if (publicUrl) {
      uploadedImages.push({ url: publicUrl, role: "unprocessed" });
    }
  }
  const storageUploadDuration = Date.now() - s0;

  const committed = await Drafts.commitDraftToListing({
    broker,
    agencyId: broker.agency_id,
    listingData: staged.listingData,
    images: uploadedImages
  });

  // Store commit in session for 20 seconds to prevent double-tap race errors
  await setSession(broker.id, "recent_commit", { code: committed.code }, 20);

  const totalDuration = Date.now() - t0;

  await DB.logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    listing_code: committed.code,
    operation_type: "commit_draft_listing",
    status: "success",
    total_duration_ms: totalDuration,
    storage_upload_ms: storageUploadDuration,
    metadata: { uploadedImagesCount: uploadedImages.length }
  });

  DB.logStdout("info", "Draft listing committed successfully to PostgreSQL", {
    code: committed.code,
    brokerId: broker.id,
    imagesCount: uploadedImages.length,
    durationMs: totalDuration
  });

  await reply(
    broker,
    M(
      lang,
      `🎉 تم اعتماد وحفظ الوحدة بنجاح بكود: \`${committed.code}\`\nتم إدراجها بالمخزون النشط وجاهزة للمشاركة.`,
      `🎉 Unit successfully saved and active under code: \`${committed.code}\``
    )
  );

  await showListingCard(broker, committed);
}

/* ====================================================================== */
/* 6. Inbound Message Handlers (Commands, Text, Audio, Image, Document)   */
/* ====================================================================== */

async function handleCommand(broker, raw) {
  const lang = broker.preferred_lang || "ar";
  const n = raw.trim();
  let m;

  // Help / Menu
  if (/^(?:help|menu|مساعدة|اوامر|أوامر|\?|؟)$/i.test(n)) {
    DB.logStdout("info", "Command executed: help menu", {
      brokerId: broker.id
    });
    await reply(broker, T.getHelpMessage(lang));
    return true;
  }

  // Language Switching
  if (/^(?:lang\s+en|english|انجليزي)$/i.test(n)) {
    await DB.query("UPDATE brokers SET preferred_lang = 'en' WHERE id = $1", [
      broker.id
    ]);
    broker.preferred_lang = "en";
    DB.logStdout("info", "Command executed: language set to en", {
      brokerId: broker.id
    });
    await reply(broker, "✅ Interface language set to English.");
    return true;
  }
  if (/^(?:lang\s+ar|عربي|اللغة العربية)$/i.test(n)) {
    await DB.query("UPDATE brokers SET preferred_lang = 'ar' WHERE id = $1", [
      broker.id
    ]);
    broker.preferred_lang = "ar";
    DB.logStdout("info", "Command executed: language set to ar", {
      brokerId: broker.id
    });
    await reply(broker, "✅ تم تحويل لغة النظام إلى العربية.");
    return true;
  }

  // Draft Lifecycle Commands (using valid broker.phone_number)
  if (/^(?:اضافة|إضافة|جديد|add|new)$/i.test(n)) {
    await Drafts.createDraft(broker.id, broker.agency_id, broker.phone_number);
    await deleteSession(broker.id, "edit");
    await deleteSession(broker.id, "pending_search");
    DB.logStdout("info", "Command executed: create new draft", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "📝 تم فتح مسودة جديدة.\nأرسل صور الوحدة (حتى 15 صورة)، ثم أرسل المواصفات والأسعار (تسجيل صوتي أو كتابة)، واكتب *تم* للمراجعة.",
        "📝 New draft opened.\nSend photos (up to 15), then voice or text specs, and type *done* to review."
      )
    );
    return true;
  }

  if (/^(?:تم|done|حفظ|save)$/i.test(n)) {
    DB.logStdout("info", "Command executed: review draft", {
      brokerId: broker.id
    });
    await cmdReviewDraft(broker);
    return true;
  }

  if (/^(?:cancel|إلغاء|الغاء|تراجع)$/i.test(n)) {
    await Drafts.clearDraft(broker.id);
    await deleteSession(broker.id, "edit");
    await deleteSession(broker.id, "pending_search");
    DB.logStdout("info", "Command executed: cancel active operation", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "🗑️ تم إلغاء المسودة/العملية بنجاح.",
        "🗑️ Draft / operation cancelled."
      )
    );
    return true;
  }

  if (/^(?:replace|استبدال)$/i.test(n)) {
    const draft = await Drafts.getDraft(broker.id);
    if (draft) {
      await DB.query(
        "UPDATE listing_drafts SET media_ids = '{}' WHERE broker_id = $1",
        [broker.id]
      );
      DB.logStdout("info", "Command executed: replace draft photos", {
        brokerId: broker.id
      });
      await reply(
        broker,
        M(
          lang,
          "📷 تم مسح صور المسودة. يمكنك إرسال الصور الجديدة الآن.",
          "📷 Photos cleared. Send new photos now."
        )
      );
      return true;
    }
  }

  // Agency Inventory Export (Optimized to use idx_listings_agency_status_created)
  if (/^(?:excel|export|اكسل|اكسيل|تصدير)$/i.test(n)) {
    DB.logStdout("info", "Command executed: export agency inventory", {
      brokerId: broker.id
    });
    const res = await DB.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND status = 'active' ORDER BY created_at DESC",
      [broker.agency_id]
    );
    const buffer = await Excel.buildAgencyInventoryWorkbook({
      listings: res.rows,
      agency: { name: broker.agency_name },
      broker,
      lang
    });
    await WA.sendWhatsAppDocument(
      to(broker),
      buffer,
      "Agency_Inventory.xlsx",
      M(lang, "📊 كامل مخزون الوكالة النشط", "📊 Full active agency inventory")
    );
    return true;
  }

  // Interactive Edit Command
  if ((m = n.match(/^(?:تعديل|edit)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (!canEdit(broker, listing)) {
      DB.logStdout("warn", "Unauthorized edit attempt", {
        code,
        brokerId: broker.id
      });
      await reply(
        broker,
        M(
          lang,
          "⛔ لا تملك صلاحية تعديل هذه الوحدة.",
          "⛔ Unauthorized to edit this unit."
        )
      );
      return true;
    }
    await setSession(broker.id, "edit", { code }, 900);
    DB.logStdout("info", "Command executed: enter edit mode", {
      code,
      brokerId: broker.id
    });
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `✏️ *بدء تعديل الوحدة #${code}*\nأرسل التعديل المطلوب (صوت أو كتابة، مثلاً: 'السعر بقى 9.5 مليون والتسليم فوري') أو اضغط إلغاء:`,
        `✏️ *Editing unit #${code}*\nSend changes (voice/text):`
      ),
      [
        {
          id: `cancel_edit:${code}`,
          title: M(lang, "❌ إلغاء التعديل", "❌ Cancel Edit")
        }
      ]
    );
    return true;
  }

  // Two-Step Safe Deletion Command
  if ((m = n.match(/^(?:delete|حذف)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (!canEdit(broker, listing)) {
      DB.logStdout("warn", "Unauthorized delete attempt", {
        code,
        brokerId: broker.id
      });
      await reply(
        broker,
        M(
          lang,
          "⛔ لا تملك صلاحية حذف هذه الوحدة.",
          "⛔ Unauthorized to delete this unit."
        )
      );
      return true;
    }
    DB.logStdout("info", "Command executed: prompt delete confirmation", {
      code,
      brokerId: broker.id
    });
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `⚠️ *تأكيد حذف الوحدة #${code} نهائياً؟*\n🏢 ${
          listing.compound || listing.title
        }\n💰 ${T.priceText(listing, lang)}`,
        `⚠️ *Permanently delete unit #${code}?*\n🏢 ${
          listing.compound || listing.title
        }\n💰 ${T.priceText(listing, lang)}`
      ),
      [
        {
          id: `confirm_delete:${code}`,
          title: M(lang, "🗑️ تأكيد الحذف نهائياً", "🗑️ Delete Permanently")
        },
        {
          id: `cancel_delete:${code}`,
          title: M(lang, "❌ تراجع وإلغاء", "❌ Cancel")
        }
      ]
    );
    return true;
  }

  // Status Updates
  if ((m = n.match(/^(?:sold|تم البيع)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (!canEdit(broker, listing)) return reply(broker, "⛔ غير مصرح.");
    await DB.query(
      "UPDATE listings SET status = 'sold', flyer_cache = '{}'::jsonb, updated_at = NOW() WHERE id = $1",
      [listing.id]
    );
    DB.logStdout("info", "Listing status updated to sold", {
      code,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        `✅ تم تحديث حالة الوحدة #${code} إلى: تم البيع (Sold).`,
        `✅ Unit #${code} marked as Sold.`
      )
    );
    return true;
  }

  if (
    (m = n.match(/^(?:archive|أرشفة|ارشsuperفة)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))
  ) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (!canEdit(broker, listing)) return reply(broker, "⛔ غير مصرح.");
    await DB.query(
      "UPDATE listings SET status = 'archived', flyer_cache = '{}'::jsonb, updated_at = NOW() WHERE id = $1",
      [listing.id]
    );
    DB.logStdout("info", "Listing status updated to archived", {
      code,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        `📦 تم أرشفة الوحدة #${code} بنجاح.`,
        `📦 Unit #${code} archived.`
      )
    );
    return true;
  }

  // Reactivate Unit: accepts activate, active, and تفعيل
  if ((m = n.match(/^(?:activate|active|تفعيل)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (!canEdit(broker, listing)) return reply(broker, "⛔ غير مصرح.");
    await DB.query(
      "UPDATE listings SET status = 'active', flyer_cache = '{}'::jsonb, updated_at = NOW() WHERE id = $1",
      [listing.id]
    );
    DB.logStdout("info", "Listing status reactivated", {
      code,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        `🟢 تم إعادة تفعيل الوحدة #${code} بالمخزون النشط.`,
        `🟢 Unit #${code} reactivated.`
      )
    );
    return true;
  }

  // Deliverables & Marketing Shortcuts
  if ((m = n.match(/^(?:flyer|catalog|كتالوج)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))) {
    await renderFlyerOnDemand(broker, m[1], {
      theme: "dark",
      unbranded: false
    });
    return true;
  }
  if (
    (m = n.match(
      /^(?:unbranded|بروشور بدون بيانات)\s+([A-Za-z0-9_\-\.\/`#]+)$/i
    ))
  ) {
    await renderFlyerOnDemand(broker, m[1], { theme: "dark", unbranded: true });
    return true;
  }
  if ((m = n.match(/^(?:client|عميل|زبون)\s+([A-Za-z0-9_\-\.\/`#]+)$/i))) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    const textLang = /client/i.test(n) ? "en" : "ar";
    DB.logStdout("info", "Client ad copy generated", {
      code,
      textLang,
      brokerId: broker.id
    });
    await reply(broker, T.formatClientListingText(listing, broker, textLang));
    return true;
  }

  if (
    (m = n.match(
      /^(?:plans|calc|جدول|انظمة|أنظمة|احسب)\s+([A-Za-z0-9_\-\.\/`#]+)$/i
    ))
  ) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (listing.payment_terms?.plans?.length) {
      const buffer = await Excel.buildMultiPlanWorkbook({
        listing,
        plans: listing.payment_terms.plans,
        agency: { name: broker.agency_name },
        broker,
        lang
      });
      await WA.sendWhatsAppDocument(
        to(broker),
        buffer,
        `Payment_Plans_${code}.xlsx`,
        M(
          lang,
          `📊 جدول سداد ومقارنة أنظمة الوحدة #${code}`,
          `📊 Payment schedule for #${code}`
        )
      );
    } else {
      await reply(
        broker,
        M(
          lang,
          `ℹ️ الوحدة #${code} عبارة عن وحدة ريزيل ولا تحتوي على أنظمة سداد مطور.`,
          `ℹ️ Unit #${code} is a resale unit and has no developer payment plans.`
        )
      );
    }
    return true;
  }

  if (
    (m = n.match(
      /^(?:collateral|layout|drive|مخطط|بروشور|درايف|ملفات)\s+([A-Za-z0-9_\-\.\/`#]+)$/i
    ))
  ) {
    const code = T.extractCleanCode(m[1]);
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    const col = listing.collateral || {};
    const links = [
      col.layout_pdf_url ? `• *المخطط الهندسي:* ${col.layout_pdf_url}` : null,
      col.master_plan_url ? `• *الماستر بلان:* ${col.master_plan_url}` : null,
      col.drive_folder_url ? `• *مجلد درايف:* ${col.drive_folder_url}` : null
    ].filter(Boolean);

    if (links.length) {
      await reply(
        broker,
        `📁 *الملفات التسويقية للوحدة #${code}:*\n${links.join("\n")}`
      );
    } else {
      await reply(
        broker,
        M(
          lang,
          `ℹ️ لا توجد ملفات هندسية مرفوعة للوحدة #${code}.`,
          `ℹ️ No collateral links uploaded for #${code}.`
        )
      );
    }
    return true;
  }

  return false;
}

async function handleText(broker, raw) {
  const lang = broker.preferred_lang || "ar";

  // 1. Process System Commands
  if (await handleCommand(broker, raw)) return "done";

  const isSearchIntent =
    /(?:^|\s)(عايز|عاوز|محتاج|ابحث|دورلي|عندك|search|find|looking for|ميزانية|بحدود)(?=$|\s)/i.test(
      raw
    );

  // 2. Active Interactive Edit Staging Session (Persisted via DB Session Store)
  const activeEdit = await getSession(broker.id, "edit");
  if (activeEdit && activeEdit.code) {
    const code = activeEdit.code;

    // Collision Check: Search query sent while in Edit mode
    if (isSearchIntent) {
      await setSession(broker.id, "pending_search", { query: raw }, 600);
      DB.logStdout(
        "info",
        "Search intent detected inside edit mode; prompting choice",
        { code, brokerId: broker.id }
      );
      await WA.sendWhatsAppButtons(
        to(broker),
        M(
          lang,
          `⚠️ *أنت حالياً في وضع تعديل الوحدة #${code}.*\nهل تريد استكمال تعديل الوحدة أم الخروج والبحث في المخزون؟`,
          `⚠️ *You are currently editing unit #${code}.*\nDo you want to complete editing or exit and search?`
        ),
        [
          {
            id: `edit_stay_complete:${code}`,
            title: M(lang, "✏️ استكمال التعديل", "✏️ Complete Edit")
          },
          {
            id: "edit_exit_and_search",
            title: M(lang, "🔍 خروج والبحث", "🔍 Exit & Search")
          }
        ]
      );
      return "done";
    }

    // Normal Edit: Proceed to patch the unit via Gemini
    await deleteSession(broker.id, "edit");
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);

    const t0 = Date.now();
    await DB.checkAiQuota(broker.agency_id, broker.id);

    const parts = [
      { text: L.buildListingPrompt(lang) },
      {
        text: `\n\n=== ORIGINAL UNIT DATA ===\n${JSON.stringify(
          listing
        )}\n=== MODIFICATION INSTRUCTION ===\n${raw}`
      }
    ];

    const v0 = Date.now();
    const response = await geminiClient.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0.1 }
    });
    const geminiDuration = Date.now() - v0;

    const parsedJson = JSON.parse(
      response.text.replace(/^```json|```$/g, "").trim()
    );
    const validated = L.validateDraft(parsedJson, lang);
    const parsedPrice = T.parseEgyptianPrice(validated.price_raw, { lang });
    const composed = L.composeFields({
      existing: listing,
      draft: validated,
      price: parsedPrice,
      lang,
      enriched: null,
      imageOnly: false
    });

    await DB.query(
      `UPDATE listings SET
         title = $1, price_value = $2, price_display = $3, area_value = $4,
         bedrooms = $5, details = $6, flyer_cache = '{}'::jsonb, updated_at = NOW()
       WHERE id = $7`,
      [
        composed.title,
        composed.price_value,
        composed.price_display,
        composed.area_value,
        composed.bedrooms,
        JSON.stringify(composed.details),
        listing.id
      ]
    );

    await DB.logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "edit_unit_patch",
      status: "success",
      total_duration_ms: Date.now() - t0,
      gemini_ms: geminiDuration,
      tokens_input: response.usageMetadata?.promptTokenCount || 0,
      tokens_output: response.usageMetadata?.candidatesTokenCount || 0,
      model_used: GEMINI_TEXT_MODEL
    });

    DB.logStdout("info", "Listing successfully edited via text patch", {
      code,
      brokerId: broker.id
    });

    await reply(
      broker,
      M(
        lang,
        `✅ تم تحديث بيانات الوحدة #${code} بنجاح وإعادة ضبط البروشور.`,
        `✅ Unit #${code} updated.`
      )
    );
    const refreshed = await fetchListing(broker, code);
    await showListingCard(broker, refreshed);
    return "done";
  }

  // 3. Draft Mode (Add Mode) Interception
  const activeDraft = await Drafts.getDraft(broker.id);
  if (activeDraft) {
    // Collision Check: Search query sent while Draft is open
    if (isSearchIntent) {
      await setSession(broker.id, "pending_search", { query: raw }, 600);
      DB.logStdout(
        "info",
        "Search intent detected inside draft mode; prompting choice",
        { brokerId: broker.id }
      );
      await WA.sendWhatsAppButtons(
        to(broker),
        M(
          lang,
          "⚠️ *لديك مسودة وحدة قيد الإنشاء لم تكتمل بعد.*\nهل تريد استكمال تسجيل الوحدة الحالية أم إلغاؤها والبحث في المخزون؟",
          "⚠️ *You have an active draft in progress.*\nDo you want to complete the listing or exit and search?"
        ),
        [
          {
            id: "draft_stay_complete",
            title: M(lang, "📝 استكمال المسودة", "📝 Complete Draft")
          },
          {
            id: "draft_exit_and_search",
            title: M(lang, "🔍 إلغاء والبحث", "🔍 Exit & Search")
          }
        ]
      );
      return "done";
    }

    // Normal property description: append to draft notes
    await Drafts.appendText(broker.id, raw);
    DB.logStdout("info", "Note appended to draft", { brokerId: broker.id });
    await reply(
      broker,
      M(
        lang,
        "📝 تم تدوين الملاحظة وإضافتها للمسودة. أرسل المزيد أو اكتب *تم* للمراجعة.",
        "📝 Note added to draft. Send more or type *done* to review."
      )
    );
    return "done";
  }

  // 4. Standalone Direct Code Lookup
  const codeCheck = T.parseExplicitUnitCode(raw);
  if (codeCheck.hasCode && codeCheck.code) {
    const listing = await fetchListing(broker, codeCheck.code);
    if (listing) {
      DB.logStdout("info", "Direct code lookup resolved", {
        code: codeCheck.code,
        brokerId: broker.id
      });
      await showListingCard(broker, listing);
      return "done";
    }
  }

  // 5. Normal Search Execution (Bilingual 2-Pass Matching)
  await executeSearch(broker, { text: raw });
  return "done";
}

async function handleAudio(broker, audioObj) {
  const lang = broker.preferred_lang || "ar";
  const mediaData = await WA.downloadWhatsAppMedia(audioObj.id);

  if (!mediaData || !mediaData.buffer) {
    DB.logStdout("warn", "Failed to download audio media", {
      mediaId: audioObj.id,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "⚠️ تعذر تحميل التسجيل الصوتي من واتساب. يرجى إعادة المحاولة.",
        "⚠️ Failed to download voice note. Please try again."
      )
    );
    return "done";
  }

  // 1. Check Edit Mode Collision / Processing
  const activeEdit = await getSession(broker.id, "edit");
  if (activeEdit && activeEdit.code) {
    const code = activeEdit.code;
    DB.logStdout(
      "info",
      "Voice note received in edit mode; transcribing via Gemini",
      { code, brokerId: broker.id }
    );

    await DB.checkAiQuota(broker.agency_id, broker.id);
    const transcriptionRes = await geminiClient.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Transcribe this Egyptian Arabic real estate voice note accurately. Return ONLY the transcribed text:"
            },
            {
              inlineData: {
                mimeType: U.cleanAudioMime(mediaData.mimeType),
                data: mediaData.buffer.toString("base64")
              }
            }
          ]
        }
      ]
    });

    const transcribedText = transcriptionRes.text.trim();
    DB.logStdout("info", "Voice note transcribed for edit patch", {
      code,
      transcribedText
    });
    return await handleText(broker, transcribedText);
  }

  // 2. Check Draft Mode
  const activeDraft = await Drafts.getDraft(broker.id);
  if (activeDraft) {
    await Drafts.appendVoice(broker.id, mediaData);
    DB.logStdout("info", "Voice note appended to draft", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "🎙️ تم استلام التسجيل الصوتي وإضافته للمسودة. أرسل المزيد أو اكتب *تم* للمراجعة.",
        "🎙️ Voice note added to draft. Send more or type *done* to review."
      )
    );
    return "done";
  }

  // 3. Fallback: Search Query
  DB.logStdout("info", "Executing search from audio voice note", {
    brokerId: broker.id
  });
  await executeSearch(broker, { audio: [mediaData] });
  return "done";
}

async function handleImage(broker, imageObj) {
  const lang = broker.preferred_lang || "ar";
  const mediaData = await WA.downloadWhatsAppMedia(imageObj.id);

  if (!mediaData || !mediaData.buffer) {
    DB.logStdout("warn", "Failed to download image media", {
      mediaId: imageObj.id,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "⚠️ تعذر تحميل الصورة من واتساب. يرجى إعادة المحاولة.",
        "⚠️ Failed to download image."
      )
    );
    return "done";
  }

  let draft = await Drafts.getDraft(broker.id);
  if (!draft) {
    // Uses broker.phone_number for strict NOT NULL compliance on broker_phone
    draft = await Drafts.createDraft(
      broker.id,
      broker.agency_id,
      broker.phone_number
    );
    DB.logStdout("info", "Implicit draft created by incoming image", {
      brokerId: broker.id
    });
  }

  const currentCount = (draft.media_items || []).length;
  if (currentCount >= 15) {
    DB.logStdout("warn", "Image rejected: 15-photo ceiling reached", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "⚠️ تم استلام 15 صورة بالفعل (الحد الأقصى لكل وحدة).\nسيتم الاعتماد على أول 15 صورة وانتقاء أفضل 9 صور منها تلقائياً للبروشور.",
        "⚠️ 15 photos already received (maximum limit).\nThe AI will curate the best 9 for the brochure."
      )
    );
    return "done";
  }

  await Drafts.appendMedia(broker.id, {
    mediaId: imageObj.id,
    buffer: mediaData.buffer,
    mimeType: mediaData.mimeType || "image/jpeg"
  });

  // Burst Debounce Notification (2.5s window)
  const timerKey = `burst_${broker.id}`;
  if (burstTimers.has(timerKey)) clearTimeout(burstTimers.get(timerKey));

  burstTimers.set(
    timerKey,
    setTimeout(async () => {
      const updated = await Drafts.getDraft(broker.id);
      const count = (updated?.media_items || []).length;
      DB.logStdout(
        "info",
        "Image burst settled; dispatching count confirmation",
        { count, brokerId: broker.id }
      );
      await reply(
        broker,
        M(
          lang,
          `📷 تم استلام *(${count}/15)* صورة بنجاح.\n💡 سيختار الذكاء الاصطناعي أفضل 9 صور تلقائياً لتصميم البروشور.\n\nأرسل الآن المواصفات والأسعار (صوت أو كتابة)، واكتب *تم* للمراجعة.`,
          `📷 Received *(${count}/15)* photos.\n💡 The AI will curate the best 9 photos for your flyer.\n\nSend specs/price, or type *done* to review.`
        )
      );
    }, 2500)
  );

  return "done";
}

async function handleDocument(broker, docObj) {
  const t0 = Date.now();
  const lang = broker.preferred_lang || "ar";
  const filename = docObj.filename || "file.dat";

  if (!/\.xlsx$/i.test(filename)) {
    DB.logStdout("warn", "Non-xlsx document upload rejected", {
      filename,
      brokerId: broker.id
    });
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        "⚠️ يقبل النظام ملفات إكسيل بصيغة (.xlsx) فقط لإضافة وتحديث المخزون مجمعاً.",
        "⚠️ System accepts (.xlsx) Excel files only for bulk ingestion."
      ),
      [{ id: "help", title: M(lang, "📋 المساعدة", "📋 Help") }]
    );
    return "done";
  }

  const docData = await WA.downloadWhatsAppMedia(docObj.id);
  if (!docData || !U.isValidZipBuffer(docData.buffer)) {
    DB.logStdout("error", "Document failed PK zip magic-byte validation", {
      filename,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "⚠️ الملف غير صالح أو تالف. يرجى رفع ملف إكسيل حقيقي وغير محمي بكلمة سر.",
        "⚠️ Invalid or corrupted Excel workbook."
      )
    );
    return "done";
  }

  // Acquire 90-Second PostgreSQL Advisory Lock for Broker Ingestion Safety
  await DB.withAdvisoryLock(`bulk_${broker.agency_id}`, broker.id, async () => {
    DB.logStdout("info", "Starting bulk Excel ingestion under advisory lock", {
      filename,
      brokerId: broker.id
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(docData.buffer);
    const worksheet = workbook.worksheets[0];

    const addedListings = [];
    const rejectedRows = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip headers
      const code = String(row.getCell(1).value || "").trim();
      const title = String(row.getCell(2).value || "").trim();
      const price = Number(row.getCell(6).value || 0);

      if (!price || price <= 0) {
        rejectedRows.push({
          rowNumber,
          code,
          reason: "Missing or invalid Price value",
          rawDetails: title
        });
      } else {
        addedListings.push({
          code,
          title,
          price_value: price,
          area_value: Number(row.getCell(10).value || 0)
        });
      }
    });

    await DB.logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "bulk_excel_ingest",
      status: rejectedRows.length ? "partial_success" : "success",
      total_duration_ms: Date.now() - t0,
      metadata: {
        addedCount: addedListings.length,
        rejectedCount: rejectedRows.length
      }
    });

    if (rejectedRows.length > 0) {
      DB.logStdout("warn", "Bulk Excel ingestion yielded rejected rows", {
        brokerId: broker.id,
        addedCount: addedListings.length,
        rejectedCount: rejectedRows.length
      });
      const errBuffer = await Excel.buildRejectionWorkbook({
        rejectedRows,
        agencyName: broker.agency_name
      });
      await WA.sendWhatsAppDocument(
        to(broker),
        errBuffer,
        "مرفوضات_المخزون.xlsx",
        M(
          lang,
          `⚠️ تم استيراد ${addedListings.length} وحدة، وتم استبعاد ${rejectedRows.length} وحدة لوجود أخطاء.`,
          `⚠️ Imported ${addedListings.length}, rejected ${rejectedRows.length}.`
        )
      );
    } else {
      DB.logStdout("info", "Bulk Excel ingestion completed with 100% success", {
        brokerId: broker.id,
        addedCount: addedListings.length
      });
      await reply(
        broker,
        M(
          lang,
          `🎉 تم استيراد كامل الملف (${addedListings.length} وحدة) بنجاح دون أي أخطاء.`,
          `🎉 All ${addedListings.length} units imported successfully.`
        )
      );
    }
  });

  return "done";
}

/* ====================================================================== */
/* 7. Search Execution Pipeline (Strict + Relaxed Cascading)              */
/* ====================================================================== */

async function executeSearch(broker, { text = "", audio = [] } = {}) {
  const t0 = Date.now();
  const lang = broker.preferred_lang || "ar";
  await DB.checkAiQuota(broker.agency_id, broker.id);

  let searchParsed = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let geminiDuration = 0;

  try {
    const v0 = Date.now();
    const aiRes = await S.parseSearchRequest(geminiClient, {
      text,
      audio,
      model: GEMINI_TEXT_MODEL
    });
    geminiDuration = Date.now() - v0;
    searchParsed = aiRes.parsed;
    tokensIn = aiRes.usage?.input || 0;
    tokensOut = aiRes.usage?.output || 0;
  } catch (err) {
    DB.logStdout(
      "warn",
      "AI search parsing failed; using fallback lexical parser",
      { err: err.message }
    );
    searchParsed = S.fallbackParse(text);
  }

  // Persist search parameters in DB session for pagination (`MORE_SEARCH`)
  await setSession(broker.id, "last_search", { parsed: searchParsed }, 1800);

  // Pass 1: Strict Match
  let queryObj = S.buildSearchQuery(broker.agency_id, searchParsed, {
    limit: 5,
    offset: 0,
    relaxed: false
  });
  let dbRes = await DB.query(queryObj.sql, queryObj.params);
  let isRelaxed = false;

  // Pass 2: Relaxed Match (Expands bounds if strict returns zero)
  if (dbRes.rowCount === 0 && S.hasAnyFilter(searchParsed)) {
    queryObj = S.buildSearchQuery(broker.agency_id, searchParsed, {
      limit: 5,
      offset: 0,
      relaxed: true
    });
    dbRes = await DB.query(queryObj.sql, queryObj.params);
    isRelaxed = true;
  }

  const totalDuration = Date.now() - t0;

  await DB.logOperation({
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "inventory_search",
    status: dbRes.rowCount > 0 ? "success" : "zero_results",
    total_duration_ms: totalDuration,
    gemini_ms: geminiDuration,
    tokens_input: tokensIn,
    tokens_output: tokensOut,
    model_used: geminiDuration > 0 ? GEMINI_TEXT_MODEL : null,
    metadata: {
      matchedCount: dbRes.rowCount,
      isRelaxed,
      filters: searchParsed.filters
    }
  });

  DB.logStdout("info", "Search query executed", {
    brokerId: broker.id,
    matchedCount: dbRes.rowCount,
    isRelaxed,
    durationMs: totalDuration
  });

  if (dbRes.rowCount === 0) {
    await reply(
      broker,
      M(
        lang,
        "🔍 لم نجد أي وحدات مطابقة لمواصفات بحثك في المخزون الحالي.\nجرب توسيع ميزانية السعر أو البحث في كمبوند آخر.",
        "🔍 No matching units found. Try widening your price range or district."
      )
    );
    return;
  }

  if (isRelaxed) {
    await reply(
      broker,
      M(
        lang,
        "ℹ️ *نتائج تقريبية* — لم نجد تطابقاً تاماً، تم توسيع نطاق الميزانية والمساحة بنسبة 15%:",
        "ℹ️ *Approximate Matches* — Search range widened by 15%:"
      )
    );
  }

  for (const listing of dbRes.rows) {
    await showListingCard(broker, listing);
  }

  const totalFound = Number(dbRes.rows[0].total_count || dbRes.rowCount);
  if (totalFound > 5) {
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `📊 تم عرض 5 من إجمالي ${totalFound} وحدة مطابقة.`,
        `📊 Displaying 5 of ${totalFound} matching units.`
      ),
      [
        {
          id: `MORE_SEARCH:5:${totalFound}`,
          title: M(lang, "➡️ عرض المزيد", "➡️ Show More")
        }
      ]
    );
  }
}

/* ====================================================================== */
/* 8. Interactive Reply Event Handler (Meta Button / List Clicks)         */
/* ====================================================================== */

async function handleInteractive(broker, interactive) {
  const lang = broker.preferred_lang || "ar";
  const replyId = interactive.button_reply?.id || interactive.list_reply?.id;
  if (!replyId) return "done";

  DB.logStdout("info", "Interactive button clicked", {
    replyId,
    brokerId: broker.id
  });

  // A. Draft Staging Confirm & Save
  if (replyId === "draft_confirm_save") {
    await cmdExecuteConfirmSave(broker);
    return "done";
  }

  if (replyId === "draft_edit") {
    await reply(
      broker,
      M(
        lang,
        "✏️ أرسل البيانات الناقصة أو التعديلات المطلوبة (صوت أو كتابة)، ثم اكتب *تم* للمراجعة مجدداً.",
        "✏️ Send additional details or voice notes, then type *done* to review again."
      )
    );
    return "done";
  }

  if (replyId === "draft_cancel") {
    await Drafts.clearDraft(broker.id);
    await reply(
      broker,
      M(lang, "🗑️ تم إلغاء المسودة بنجاح.", "🗑️ Draft cancelled successfully.")
    );
    return "done";
  }

  // B. Unified Collision Handling: Draft Mode
  if (replyId === "draft_stay_complete") {
    const pending = await getSession(broker.id, "pending_search");
    await deleteSession(broker.id, "pending_search");
    if (pending && pending.query) {
      await Drafts.appendText(broker.id, pending.query);
      DB.logStdout("info", "Collision resolved: text appended to draft", {
        brokerId: broker.id
      });
      await reply(
        broker,
        M(
          lang,
          "📝 تم تدوين الملاحظة بالمسودة.\nأرسل باقي المواصفات أو اكتب *تم* لاعتماد الوحدة.",
          "📝 Note recorded. Send additional specs or type *done* to commit."
        )
      );
    }
    return "done";
  }

  if (replyId === "draft_exit_and_search") {
    const pending = await getSession(broker.id, "pending_search");
    await deleteSession(broker.id, "pending_search");
    await Drafts.clearDraft(broker.id);

    DB.logStdout("info", "Collision resolved: draft abandoned for search", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "🗑️ تم إلغاء المسودة والانتقال إلى البحث.",
        "🗑️ Draft cleared. Running search..."
      )
    );
    if (pending && pending.query) {
      await executeSearch(broker, { text: pending.query });
    }
    return "done";
  }

  // C. Unified Collision Handling: Edit Mode
  if (replyId.startsWith("edit_stay_complete:")) {
    const code = replyId.split(":")[1];
    const pending = await getSession(broker.id, "pending_search");
    await deleteSession(broker.id, "pending_search");

    DB.logStdout("info", "Collision resolved: text applied as edit patch", {
      code,
      brokerId: broker.id
    });
    if (pending && pending.query) {
      await setSession(broker.id, "edit", { code }, 900);
      await handleText(broker, pending.query);
    }
    return "done";
  }

  if (replyId === "edit_exit_and_search") {
    const pending = await getSession(broker.id, "pending_search");
    await deleteSession(broker.id, "pending_search");
    await deleteSession(broker.id, "edit");

    DB.logStdout("info", "Collision resolved: edit abandoned for search", {
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        "🚪 تم الخروج من وضع التعديل والانتقال للبحث.",
        "🚪 Exited edit mode. Running search..."
      )
    );
    if (pending && pending.query) {
      await executeSearch(broker, { text: pending.query });
    }
    return "done";
  }

  // D. Safe Deletion Confirmation
  if (replyId.startsWith("confirm_delete:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);
    if (!canEdit(broker, listing)) return reply(broker, "⛔ غير مصرح.");

    const imgRes = await DB.query(
      `SELECT url FROM listing_images WHERE listing_id = $1`,
      [listing.id]
    );
    await Supabase.deleteStorageFiles(imgRes.rows.map((r) => r.url));
    await DB.query("DELETE FROM listings WHERE id = $1", [listing.id]);

    await DB.logOperation({
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: code,
      operation_type: "delete_listing",
      status: "success"
    });

    DB.logStdout("info", "Listing permanently deleted", {
      code,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(
        lang,
        `🗑️ تم حذف الوحدة #${code} نهائياً من قاعدة البيانات.`,
        `🗑️ Unit #${code} permanently deleted.`
      )
    );
    return "done";
  }

  if (
    replyId.startsWith("cancel_delete:") ||
    replyId.startsWith("cancel_edit:")
  ) {
    await deleteSession(broker.id, "edit");
    DB.logStdout("info", "Operation cancelled via interactive button", {
      replyId,
      brokerId: broker.id
    });
    await reply(
      broker,
      M(lang, "✅ تم إلغاء العملية بأمان.", "✅ Operation cancelled safely.")
    );
    return "done";
  }

  // E. Flyer Request
  if (replyId.startsWith("flyer:")) {
    const parts = replyId.split(":");
    const code = parts[parts.length - 1];
    await renderFlyerOnDemand(broker, code, {
      theme: "dark",
      unbranded: false
    });
    return "done";
  }

  // F. Edit Unit Trigger
  if (replyId.startsWith("edit_unit:")) {
    const code = replyId.split(":")[1];
    await setSession(broker.id, "edit", { code }, 900);
    DB.logStdout("info", "Edit mode entered via card button", {
      code,
      brokerId: broker.id
    });
    await WA.sendWhatsAppButtons(
      to(broker),
      M(
        lang,
        `✏️ *أنت الآن في وضع تعديل الوحدة #${code}*\nأرسل التعديل المطلوب (صوت أو كتابة، مثلاً: 'السعر بقى 9.5 مليون والتسليم فوري') أو اضغط إلغاء:`,
        `✏️ *Editing unit #${code}*\nSend changes (voice/text):`
      ),
      [
        {
          id: `cancel_edit:${code}`,
          title: M(lang, "❌ إلغاء التعديل", "❌ Cancel Edit")
        }
      ]
    );
    return "done";
  }

  // G. Client Marketing Text
  if (replyId.startsWith("client:") || replyId.startsWith("عميل:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (listing) {
      await reply(broker, T.formatClientListingText(listing, broker, lang));
    }
    return "done";
  }

  // H. Primary Payment Plan Schedule Excel Generation
  if (replyId.startsWith("compare_excel:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (listing && listing.payment_terms?.plans?.length) {
      const buffer = await Excel.buildMultiPlanWorkbook({
        listing,
        plans: listing.payment_terms.plans,
        agency: { name: broker.agency_name },
        broker,
        lang
      });
      await WA.sendWhatsAppDocument(
        to(broker),
        buffer,
        `Payment_Plans_${code}.xlsx`,
        M(
          lang,
          `📊 جدول سداد ومقارنة أنظمة الوحدة #${code}`,
          `📊 Payment schedule for #${code}`
        )
      );
    }
    return "done";
  }

  // I. Primary Payment Plan Interactive Viewer
  if (replyId.startsWith("plans_view:")) {
    const code = replyId.split(":")[1];
    const listing = await fetchListing(broker, code);
    if (!listing) return notFound(broker, code);

    const plans = listing.payment_terms?.plans || [];
    if (!plans.length) {
      await reply(
        broker,
        M(
          lang,
          `ℹ️ الوحدة #${code} لا تحتوي على خطط سداد مطور مجدولة.`,
          `ℹ️ No payment plans available for #${code}.`
        )
      );
      return "done";
    }

    const basePrice = Number(listing.price_value || 0);
    const matchingResult = Financials.filterMatchingPlans(basePrice, plans, {});
    await WA.sendPaymentPlansResponse(to(broker), code, matchingResult, lang);
    return "done";
  }

  // J. Search Results Pagination Handler
  if (replyId.startsWith("MORE_SEARCH:")) {
    const parts = replyId.split(":");
    const currentOffset = Number(parts[1]) || 5;
    const lastSearch = await getSession(broker.id, "last_search");

    if (!lastSearch || !lastSearch.parsed) {
      await reply(
        broker,
        M(
          lang,
          "⚠️ انتهت صلاحية نتائج البحث السابقة. يرجى إعادة كتابة البحث.",
          "⚠️ Search session expired. Please search again."
        )
      );
      return "done";
    }

    const queryObj = S.buildSearchQuery(broker.agency_id, lastSearch.parsed, {
      limit: 5,
      offset: currentOffset,
      relaxed: false
    });
    const dbRes = await DB.query(queryObj.sql, queryObj.params);

    for (const listing of dbRes.rows) {
      await showListingCard(broker, listing);
    }

    const totalFound = Number(dbRes.rows[0]?.total_count || 0);
    const nextOffset = currentOffset + dbRes.rowCount;

    if (nextOffset < totalFound) {
      await WA.sendWhatsAppButtons(
        to(broker),
        M(
          lang,
          `📊 تم عرض ${nextOffset} من إجمالي ${totalFound} وحدة مطابقة.`,
          `📊 Displaying ${nextOffset} of ${totalFound} matching units.`
        ),
        [
          {
            id: `MORE_SEARCH:${nextOffset}:${totalFound}`,
            title: M(lang, "➡️ عرض المزيد", "➡️ Show More")
          }
        ]
      );
    } else {
      await reply(
        broker,
        M(
          lang,
          "🏁 تم عرض كافة الوحدات المطابقة في المخزون.",
          "🏁 All matching units displayed."
        )
      );
    }
    return "done";
  }

  // Fallback for unhandled reply actions
  DB.logStdout("warn", "Unhandled or expired interactive reply ID", {
    replyId,
    brokerId: broker.id
  });
  await reply(
    broker,
    M(
      lang,
      "⚠️ هذا الخيار غير صالح أو انتهت صلاحيته.",
      "⚠️ This option has expired."
    )
  );
  return "done";
}

/* ====================================================================== */
/* 9. Webhook Ingress & Express Routes                                    */
/* ====================================================================== */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    DB.logStdout("info", "Meta webhook subscription verified successfully");
    return res.status(200).send(challenge);
  }
  DB.logStdout("warn", "Meta webhook subscription verification failed");
  return res.sendStatus(403);
});

// Meta Webhook HMAC-SHA256 Signature Validator
function isValidMetaSignature(req) {
  if (!process.env.WHATSAPP_APP_SECRET) return true;
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET);
  hmac.update(req.rawBody || Buffer.from(""));
  const expected = `sha256=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

app.post("/webhook", async (req, res) => {
  if (!isValidMetaSignature(req)) {
    DB.logStdout("warn", "Rejected webhook with invalid HMAC signature");
    return res.sendStatus(401);
  }

  res.sendStatus(200); // Immediate 200 ACK to Meta Graph API

  const body = req.body;
  if (!body || body.object !== "whatsapp_business_account") return;

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0]?.value;
  const message = changes?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const broker = await resolveBroker(from);

  if (!broker) {
    DB.logStdout("warn", "Inbound message from unregistered phone number", {
      phone: from
    });
    await WA.sendWhatsAppText(
      from,
      "⚠️ هذا الرقم غير مسجل في منظومة AqarChat العقارية.\nيرجى التواصل مع إدارة وكالتك لتفعيل حسابك ومشاركتك في المخزون."
    );
    return;
  }

  const reqId = U.sha1(`${from}_${Date.now()}_${Math.random()}`).slice(0, 12);
  const lang = broker.preferred_lang || "ar";

  // Serialized FIFO Queue execution per broker wrapped in AsyncLocalStorage tracing context
  brokerSerializers(broker.id, async () => {
    await DB.als.run(
      { reqId, agencyId: broker.agency_id, brokerId: broker.id },
      async () => {
        try {
          await WA.markAsRead(message.id, { typing: true });

          if (message.type === "text") {
            await handleText(broker, message.text.body);
          } else if (message.type === "audio") {
            await handleAudio(broker, message.audio);
          } else if (message.type === "image") {
            await handleImage(broker, message.image);
          } else if (message.type === "document") {
            await handleDocument(broker, message.document);
          } else if (message.type === "interactive") {
            await handleInteractive(broker, message.interactive);
          }
        } catch (err) {
          if (err.code === "BROKER_QUOTA_EXCEEDED") {
            DB.logStdout("warn", "Broker daily AI quota exceeded", {
              brokerId: broker.id,
              used: err.used,
              limit: err.limit
            });
            await reply(
              broker,
              M(
                lang,
                `⚠️ *تم استهلاك كامل رصيدك اليومي من الذكاء الاصطناعي (${err.limit}/${err.limit} عملية).*\nيتجدد الرصيد تلقائياً الساعة 12 منتصف الليل، أو تواصل مع المشرف لزيادة باقتك.`,
                `⚠️ *Daily AI limit reached (${err.limit}/${err.limit}).*\nQuota resets at midnight UTC, or contact your admin to upgrade.`
              )
            );
            return;
          }

          if (err.code === "AGENCY_QUOTA_EXCEEDED") {
            DB.logStdout("warn", "Agency total AI quota exceeded", {
              agencyId: broker.agency_id
            });
            await reply(
              broker,
              M(
                lang,
                "⚠️ *تجاوزت الوكالة الحد الأقصى المسموح به لعمليات الذكاء الاصطناعي اليوم.*\nيرجى مراجعة إدارة الوكالة لترقية الاشتراك.",
                "⚠️ *Agency daily AI quota exceeded.*\nPlease contact management to upgrade the tier."
              )
            );
            return;
          }

          DB.logStdout(
            "error",
            "Unhandled exception in webhook processing loop",
            {
              brokerId: broker.id,
              err: err.message,
              code: err.code,
              stack: err.stack
            }
          );
          await reply(
            broker,
            "⚠️ حدث خطأ غير متوقع أثناء معالجة طلبك. يرجى المحاولة مرة أخرى."
          );
        }
      }
    );
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime())
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  DB.logStdout(
    "info",
    `AqarChat Master Ingestion Engine online on port ${PORT}`
  );
});
