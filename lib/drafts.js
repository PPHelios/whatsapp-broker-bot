// lib/drafts.js — Distributed Draft State Machine, Ingress Staging & Atomic Commits
"use strict";

const L = require("./listing");
const T = require("./text");
const Supabase = require("./supabase");

const MAX_IMAGES = 15;
const DRAFT_TTL_MS = 15 * 60 * 1000; // 15-minute sliding TTL

/**
 * Retrieves the broker's current active draft from PostgreSQL broker_sessions.
 * Complies strictly with SCHEMA_REFERENCE.sql (table: broker_sessions).
 */
async function getDraft(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return null;

  const res = await pool.query(
    `SELECT session_data, expires_at
     FROM broker_sessions
     WHERE broker_id = $1 AND session_type = $2`,
    [brokerId, sessionType]
  );

  const session = res.rows[0];
  if (!session) return null;

  // Lazy TTL Eviction: automatically purge sessions older than 15 minutes
  if (new Date(session.expires_at) <= new Date()) {
    await clearDraft(pool, brokerId, sessionType);
    return null;
  }

  return session.session_data;
}

/**
 * Creates or resets an active session in broker_sessions.
 */
async function createDraft(
  pool,
  brokerId,
  agencyId,
  brokerPhoneNormalized = "",
  sessionType = "draft"
) {
  if (!pool || !brokerId) return null;

  const initialData = {
    broker_id: brokerId,
    agency_id: agencyId,
    broker_phone: brokerPhoneNormalized,
    media_items: [],
    voice_buffers: [],
    text_notes: [],
    custom_code: null,
    staged_review: null,
    created_at: Date.now()
  };

  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = EXCLUDED.session_data,
       expires_at = NOW() + INTERVAL '15 minutes'`,
    [brokerId, sessionType, initialData]
  );

  return initialData;
}

/**
 * Permanently removes a draft session from broker_sessions.
 */
async function clearDraft(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return;
  await pool.query(
    `DELETE FROM broker_sessions
     WHERE broker_id = $1 AND session_type = $2`,
    [brokerId, sessionType]
  );
}

/**
 * Appends a written specification note to the active session.
 */
async function appendText(pool, brokerId, text, sessionType = "draft") {
  const clean = String(text || "").trim();
  if (!pool || !brokerId || !clean) return null;

  const draft = (await getDraft(pool, brokerId, sessionType)) || {
    text_notes: []
  };
  if (!Array.isArray(draft.text_notes)) draft.text_notes = [];
  draft.text_notes.push(clean);

  await pool.query(
    `UPDATE broker_sessions
     SET session_data = $1, expires_at = NOW() + INTERVAL '15 minutes'
     WHERE broker_id = $2 AND session_type = $3`,
    [draft, brokerId, sessionType]
  );

  return draft;
}

/**
 * Appends a voice note buffer to the active session.
 */
async function appendVoice(
  pool,
  brokerId,
  { buffer, mimeType = "audio/ogg" },
  sessionType = "draft"
) {
  if (!pool || !brokerId || !buffer) return null;

  const draft = (await getDraft(pool, brokerId, sessionType)) || {
    voice_buffers: []
  };
  if (!Array.isArray(draft.voice_buffers)) draft.voice_buffers = [];

  draft.voice_buffers.push({
    mimeType,
    base64: buffer.toString("base64")
  });

  await pool.query(
    `UPDATE broker_sessions
     SET session_data = $1, expires_at = NOW() + INTERVAL '15 minutes'
     WHERE broker_id = $2 AND session_type = $3`,
    [draft, brokerId, sessionType]
  );

  return draft;
}

/**
 * Appends an image to the draft, enforcing the 15-photo ceiling (ING-01).
 */
async function appendMedia(
  pool,
  brokerId,
  { mediaId, buffer, mimeType = "image/jpeg" },
  sessionType = "draft"
) {
  if (!pool || !brokerId || !buffer) {
    return { ok: false, limitReached: false, count: 0 };
  }

  const draft = (await getDraft(pool, brokerId, sessionType)) || {
    media_items: []
  };
  if (!Array.isArray(draft.media_items)) draft.media_items = [];

  if (draft.media_items.length >= MAX_IMAGES) {
    return { ok: false, limitReached: true, count: draft.media_items.length };
  }

  const exists = draft.media_items.some((item) => item.mediaId === mediaId);
  if (!exists) {
    draft.media_items.push({
      mediaId,
      mimeType,
      base64: buffer.toString("base64")
    });
  }

  await pool.query(
    `UPDATE broker_sessions
     SET session_data = $1, expires_at = NOW() + INTERVAL '15 minutes'
     WHERE broker_id = $2 AND session_type = $3`,
    [draft, brokerId, sessionType]
  );

  const updatedCount = draft.media_items.length;
  return {
    ok: true,
    limitReached: updatedCount >= MAX_IMAGES,
    count: updatedCount,
    draft
  };
}

/**
 * Persists an AI-extracted review draft into staged_review in broker_sessions.
 */
async function stageDraftReview(pool, brokerId, reviewPayload) {
  const draft = (await getDraft(pool, brokerId, "draft")) || {};
  draft.staged_review = reviewPayload;

  await pool.query(
    `UPDATE broker_sessions
     SET session_data = $1, expires_at = NOW() + INTERVAL '15 minutes'
     WHERE broker_id = $2 AND session_type = 'draft'`,
    [draft, brokerId, "draft"]
  );

  return draft;
}

/**
 * Retrieves staged review object, verifying sliding TTL.
 */
async function getStagedReview(pool, brokerId) {
  const draft = await getDraft(pool, brokerId, "draft");
  return draft?.staged_review || null;
}

/**
 * Atomic Listing Commitment (DRF-03).
 * Commits a verified property draft into master listings and listing_images tables
 * inside a database transaction protected by a 64-bit advisory lock.
 */
async function commitDraftToDatabase(broker, draft, ctx) {
  const { pool, lang } = ctx;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Resolve unit code
    const assignedCode =
      draft.code ||
      draft.custom_code ||
      L.generateListingCode(null, draft.property_type).code;

    // 2. Acquire 64-bit distributed advisory lock on (agency_id, code)
    await client.query(
      "SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)",
      [String(broker.agency_id), assignedCode.toUpperCase()]
    );

    const details = draft.details || {};
    const compound = draft.compound || "";
    const compoundEn =
      draft.compound_en ||
      details.compound_en ||
      T.toEnglishSpec(compound, "compound") ||
      null;

    const priceDisplay = draft.price_value
      ? T.formatAbbreviatedPrice(
          draft.price_value,
          details.currency || "EGP",
          lang,
          draft.listing_type || "sale"
        )
      : draft.price_display || null;

    const titleAr =
      draft.title ||
      `${draft.property_type || "وحدة"} ${draft.area_value || ""}م² في ${
        compound || "مصر"
      } - ${priceDisplay || ""}`.trim();

    const titleEn =
      details.title_en ||
      `${T.toEnglishSpec(draft.property_type, "type") || "Unit"} ${
        draft.area_value || ""
      }sqm in ${compoundEn || compound || "Egypt"} - ${
        priceDisplay || ""
      }`.trim();

    details.title_en = titleEn;
    details.compound_en = compoundEn;

    // Build functional trigram search vector
    const fullSearchCorpus = `${assignedCode} ${titleAr} ${titleEn} ${compound} ${
      compoundEn || ""
    } ${draft.district || ""} ${draft.city || ""}`;

    // 3. Upsert Master Listing Record
    const insertSql = `
      INSERT INTO listings (
        agency_id, broker_id, code, title, property_type, listing_type,
        price_value, price_display, area_value, bedrooms, bathrooms,
        location, compound, compound_en, district, city, location_keywords,
        features, details, search_text, search_text_normalized,
        status, flyer_cache, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17,
        $18, $19, $20, clean_arabic_text($21),
        'active', '{}'::jsonb, NOW(), NOW()
      )
      ON CONFLICT (agency_id, code) DO UPDATE SET
        title = EXCLUDED.title,
        property_type = EXCLUDED.property_type,
        listing_type = EXCLUDED.listing_type,
        price_value = EXCLUDED.price_value,
        price_display = EXCLUDED.price_display,
        area_value = EXCLUDED.area_value,
        bedrooms = EXCLUDED.bedrooms,
        bathrooms = EXCLUDED.bathrooms,
        location = EXCLUDED.location,
        compound = EXCLUDED.compound,
        compound_en = EXCLUDED.compound_en,
        district = EXCLUDED.district,
        city = EXCLUDED.city,
        location_keywords = EXCLUDED.location_keywords,
        features = EXCLUDED.features,
        details = EXCLUDED.details,
        search_text = EXCLUDED.search_text,
        search_text_normalized = EXCLUDED.search_text_normalized,
        status = 'active',
        flyer_cache = '{}'::jsonb,
        updated_at = NOW()
      RETURNING *
    `;

    const { rows: listingRows } = await client.query(insertSql, [
      broker.agency_id,
      broker.id,
      assignedCode.toUpperCase(),
      titleAr,
      draft.property_type || "apartment",
      draft.listing_type || "sale",
      draft.price_value || null,
      priceDisplay,
      draft.area_value || null,
      draft.bedrooms !== null && draft.bedrooms !== undefined
        ? Number(draft.bedrooms)
        : null,
      details.bathrooms ? Number(details.bathrooms) : null,
      draft.location || "",
      compound,
      compoundEn,
      draft.district || "",
      draft.city || "",
      draft.location_keywords || [],
      details.features || [],
      JSON.stringify(details),
      fullSearchCorpus,
      fullSearchCorpus
    ]);

    const committedListing = listingRows[0];

    // 4. Upload Photos to Supabase and Persist in listing_images (Zero-Vision Ingestion)
    const mediaItems = Array.isArray(draft.media_items)
      ? draft.media_items
      : [];
    if (mediaItems.length > 0) {
      await client.query("DELETE FROM listing_images WHERE listing_id = $1", [
        committedListing.id
      ]);

      for (let i = 0; i < mediaItems.length; i++) {
        const item = mediaItems[i];
        let publicUrl = null;

        if (item.base64) {
          const imgBuffer = Buffer.from(item.base64, "base64");
          const storagePath = `listings/${broker.agency_id}/${
            committedListing.id
          }/${Date.now()}_${i}.jpg`;
          publicUrl = await Supabase.uploadListingImage(
            broker.agency_id,
            storagePath,
            imgBuffer
          );
        } else if (item.url) {
          publicUrl = item.url;
        }

        if (publicUrl) {
          await client.query(
            `INSERT INTO listing_images (
              listing_id, agency_id, position, url, role
            ) VALUES ($1, $2, $3, $4, NULL)`,
            [committedListing.id, broker.agency_id, i, publicUrl]
          );
        }
      }
    }

    // 5. Purge the draft session from broker_sessions
    await client.query(
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = 'draft'",
      [broker.id]
    );

    await client.query("COMMIT");

    // Symmetrical confirmation response
    const clientCopy = T.formatClientListingText(
      committedListing,
      broker,
      lang
    );
    const successMsg =
      lang === "en"
        ? `✅ *Listing Successfully Committed!*\n• Code: \`#${committedListing.code}\`\n• Status: Active & Searchable\n\n${clientCopy}`
        : `✅ *تم حفظ واعتماد الوحدة بنجاح!*\n• كود الوحدة: \`#${committedListing.code}\`\n• الحالة: نشطة ومتاحة في البحث الفوري\n\n${clientCopy}`;

    const { reply } = require("./dispatcher");
    await reply(broker, successMsg);
    return "done";
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Critical commitDraftToDatabase failure:", err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Legacy Adapter preserving backward compatibility with tests and older controllers.
 */
async function appendToDraft(pool, broker, { mediaId, buffer, text } = {}) {
  const phone = broker.phone_normalized || broker.phone_number;
  let draft = await getDraft(pool, broker.id, "draft");
  if (!draft) {
    draft = await createDraft(
      pool,
      broker.id,
      broker.agency_id,
      phone,
      "draft"
    );
  }

  if (text) await appendText(pool, broker.id, text, "draft");
  if (buffer) {
    await appendMedia(
      pool,
      broker.id,
      {
        mediaId: mediaId || `img_${Date.now()}`,
        buffer,
        mimeType: "image/jpeg"
      },
      "draft"
    );
  }

  const refreshed = await getDraft(pool, broker.id, "draft");
  return {
    draft: refreshed,
    isNew: false,
    mediaLimitReached: (refreshed?.media_items || []).length >= MAX_IMAGES
  };
}

module.exports = {
  getDraft,
  createDraft,
  clearDraft,
  appendText,
  appendVoice,
  appendMedia,
  stageDraftReview,
  getStagedReview,
  commitDraftToDatabase,
  commitDraftToListing: commitDraftToDatabase,
  appendToDraft,
  MAX_IMAGES,
  DRAFT_TTL_MS
};
