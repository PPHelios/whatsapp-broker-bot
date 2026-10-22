// lib/drafts.js — Resilient Draft State Machine, Ephemeral Buffer Cache & Atomic Commits
"use strict";

const { pool, withTransaction, logStdout } = require("./db");
const L = require("./listing");
const T = require("./text");

const MAX_IMAGES = 15;
const DRAFT_TTL_MS = 15 * 60 * 1000; // Hardened 15-minute TTL to eliminate session deadlocks

/* ====================================================================== */
/* 1. Ephemeral Buffer Cache with Auto-Pruning                            */
/* ====================================================================== */
// Holds in-memory voice notes and photo buffers during an active multi-step draft
const ephemeralBuffers = new Map();

// Periodic garbage collection to ensure no memory leaks from abandoned draft buffers
setInterval(() => {
  const now = Date.now();
  for (const [brokerId, session] of ephemeralBuffers.entries()) {
    if (now - session.updated_at > DRAFT_TTL_MS) {
      ephemeralBuffers.delete(brokerId);
    }
  }
}, 60000).unref();

function getOrCreateBufferSession(brokerId) {
  let session = ephemeralBuffers.get(brokerId);
  if (!session) {
    session = {
      media_items: [],
      voice_buffers: [],
      updated_at: Date.now()
    };
    ephemeralBuffers.set(brokerId, session);
  }
  session.updated_at = Date.now();
  return session;
}

/* ====================================================================== */
/* 2. Draft Session Retrieval & Lifecycle Management                      */
/* ====================================================================== */

/**
 * Retrieves the broker's current active draft from PostgreSQL and merges
 * any in-flight media/voice buffers. Enforces the strict 15-minute TTL[cite: 4].
 */
async function getDraft(brokerId) {
  if (!brokerId) return null;

  const res = await pool.query(
    "SELECT * FROM listing_drafts WHERE broker_id = $1",
    [brokerId]
  );
  const draft = res.rows[0];
  if (!draft) {
    ephemeralBuffers.delete(brokerId);
    return null;
  }

  // Lazy TTL Eviction: automatically purge drafts abandoned for > 15 minutes[cite: 4]
  if (draft.updated_at) {
    const ageMs = Date.now() - new Date(draft.updated_at).getTime();
    if (ageMs > DRAFT_TTL_MS) {
      await clearDraft(brokerId);
      return null;
    }
  }

  // Hydrate PostgreSQL draft record with in-memory binary buffers
  const session = ephemeralBuffers.get(brokerId);
  draft.media_items = session ? session.media_items : [];
  draft.voice_buffers = session ? session.voice_buffers : [];

  return draft;
}

/**
 * Creates or resets an active draft session for a broker[cite: 2].
 */
async function createDraft(brokerId, agencyId, brokerPhone = "") {
  ephemeralBuffers.delete(brokerId);
  getOrCreateBufferSession(brokerId);

  const res = await pool.query(
    `INSERT INTO listing_drafts
      (broker_id, agency_id, broker_phone, media_ids, voice_ids, texts, custom_code, staged_data, updated_at)
     VALUES ($1, $2, $3, '{}', '{}', '{}', NULL, NULL, NOW())
     ON CONFLICT (broker_id) DO UPDATE SET
       agency_id = EXCLUDED.agency_id,
       broker_phone = EXCLUDED.broker_phone,
       media_ids = '{}',
       voice_ids = '{}',
       texts = '{}',
       custom_code = NULL,
       staged_data = NULL,
       updated_at = NOW()
     RETURNING *`,
    [brokerId, agencyId, brokerPhone || ""]
  );

  const draft = res.rows[0];
  draft.media_items = [];
  draft.voice_buffers = [];
  return draft;
}

/**
 * Permanently clears an active draft from both PostgreSQL and memory[cite: 2, 4].
 */
async function clearDraft(brokerId) {
  if (!brokerId) return;
  ephemeralBuffers.delete(brokerId);
  await pool.query("DELETE FROM listing_drafts WHERE broker_id = $1", [
    brokerId
  ]);
}

/* ====================================================================== */
/* 3. Ingestion Appenders (Text, Voice, Photography)                      */
/* ====================================================================== */

/**
 * Appends a written specification note to the active draft[cite: 2].
 */
async function appendText(brokerId, text) {
  const clean = String(text || "").trim();
  if (!clean) return null;

  const res = await pool.query(
    `UPDATE listing_drafts
     SET texts = array_append(COALESCE(texts, '{}'::text[]), $1),
         updated_at = NOW()
     WHERE broker_id = $2
     RETURNING *`,
    [clean, brokerId]
  );
  return res.rows[0] || null;
}

/**
 * Appends a voice recording buffer to the active draft session[cite: 2].
 */
async function appendVoice(brokerId, { buffer, mimeType = "audio/ogg" }) {
  if (!buffer) return null;

  const session = getOrCreateBufferSession(brokerId);
  session.voice_buffers.push({ buffer, mimeType });

  const voiceTag = `voice_${Date.now()}`;
  const res = await pool.query(
    `UPDATE listing_drafts
     SET voice_ids = array_append(COALESCE(voice_ids, '{}'::text[]), $1),
         updated_at = NOW()
     WHERE broker_id = $2
     RETURNING *`,
    [voiceTag, brokerId]
  );
  return res.rows[0] || null;
}

/**
 * Appends an image to the draft, enforcing the hard 15-photo ceiling[cite: 2, 4].
 */
async function appendMedia(
  brokerId,
  { mediaId, buffer, mimeType = "image/jpeg", role = "unprocessed" }
) {
  if (!mediaId || !buffer) return { ok: false, limitReached: false, count: 0 };

  const session = getOrCreateBufferSession(brokerId);

  // Evaluate current count against the 15-photo ceiling[cite: 4]
  if (session.media_items.length >= MAX_IMAGES) {
    return { ok: false, limitReached: true, count: session.media_items.length };
  }

  // Deduplicate by mediaId
  const exists = session.media_items.some((item) => item.mediaId === mediaId);
  if (!exists) {
    session.media_items.push({ mediaId, buffer, mimeType, role });
  }

  const res = await pool.query(
    `UPDATE listing_drafts
     SET media_ids = array_append(
       ARRAY(SELECT DISTINCT unnest(COALESCE(media_ids, '{}'::text[]))),
       $1
     ),
     updated_at = NOW()
     WHERE broker_id = $2
     RETURNING *`,
    [mediaId, brokerId]
  );

  const updatedCount = session.media_items.length;
  const isNowAtLimit = updatedCount >= MAX_IMAGES;

  return {
    ok: true,
    limitReached: isNowAtLimit,
    count: updatedCount,
    draft: res.rows[0]
  };
}

/* ====================================================================== */
/* 4. Pre-Commit Review Staging (Multi-Pod Scalability)                   */
/* ====================================================================== */

/**
 * Persists an AI-extracted review draft into `staged_data` JSONB in PostgreSQL.
 * Enables stateless review confirmations across load-balanced application instances[cite: 2].
 */
async function stageDraftReview(brokerId, listingData, mediaItems = []) {
  // Store media metadata; binary buffers remain available in the local session
  const mediaMeta = (mediaItems || []).map((m, idx) => ({
    mediaId: m.mediaId,
    role: m.role || "unprocessed",
    position: idx
  }));

  const payload = {
    listingData,
    mediaMeta,
    stagedAt: Date.now()
  };

  const res = await pool.query(
    `UPDATE listing_drafts
     SET staged_data = $1, updated_at = NOW()
     WHERE broker_id = $2
     RETURNING *`,
    [JSON.stringify(payload), brokerId]
  );
  return res.rows[0] || null;
}

/**
 * Retrieves the currently staged review object, verifying the 15-minute TTL[cite: 4].
 */
async function getStagedDraft(brokerId) {
  const res = await pool.query(
    "SELECT staged_data, updated_at FROM listing_drafts WHERE broker_id = $1",
    [brokerId]
  );
  const row = res.rows[0];
  if (!row || !row.staged_data) return null;

  if (
    row.updated_at &&
    Date.now() - new Date(row.updated_at).getTime() > DRAFT_TTL_MS
  ) {
    await clearDraft(brokerId);
    return null;
  }

  return row.staged_data;
}

/* ====================================================================== */
/* 5. Atomic Listing Commitment (`commitDraftToListing`)                  */
/* ====================================================================== */

/**
 * Commits a verified property draft into the master `listings` and
 * `listing_images` tables inside a managed transaction[cite: 2, 3].
 * Photos are initially saved with `role = 'unprocessed'` to defer AI Vision[cite: 2].
 */
async function commitDraftToListing({
  broker,
  agencyId,
  listingData,
  images = []
}) {
  return withTransaction(async (client) => {
    // Generate clean unique unit code if not provided[cite: 8]
    const assignedCode =
      listingData.code ||
      L.generateListingCode(listingData.custom_code, listingData.property_type)
        .code;

    const details = listingData.details || {};
    const compound = listingData.compound || "";
    const compoundEn =
      listingData.compound_en ||
      details.compound_en ||
      T.toEnglishSpec(compound, "compound") ||
      null;

    const title =
      listingData.title ||
      (compound ? `${compound} Unit` : "Residential Property");
    const titleEn =
      details.title_en || T.toEnglishSpec(title, "title") || title;

    details.title_en = titleEn;
    details.compound_en = compoundEn;

    // Build functional search text vector for PostgreSQL GIN Trigram matching[cite: 9]
    const searchText = [
      assignedCode,
      title,
      titleEn,
      compound,
      compoundEn,
      listingData.district,
      listingData.city,
      listingData.location,
      ...(listingData.location_keywords || []),
      ...(details.features || []),
      ...(details.features_en || [])
    ]
      .filter(Boolean)
      .join(" ");

    const normalizedSearchText = T.cleanArabicText(searchText);

    // 1. Insert Master Listing Record[cite: 2]
    const insertListingSql = `
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
        $18, $19, $20, $21,
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

    const listingRes = await client.query(insertListingSql, [
      agencyId,
      broker.id,
      assignedCode,
      title,
      listingData.property_type || "apartment",
      listingData.listing_type || "sale",
      listingData.price_value || null,
      listingData.price_display || null,
      listingData.area_value || null,
      listingData.bedrooms !== null && listingData.bedrooms !== undefined
        ? Number(listingData.bedrooms)
        : null,
      details.bathrooms ? Number(details.bathrooms) : null,
      listingData.location || "",
      compound,
      compoundEn,
      listingData.district || "",
      listingData.city || "",
      listingData.location_keywords || [],
      details.features || [],
      JSON.stringify(details),
      searchText,
      normalizedSearchText
    ]);

    const committedListing = listingRes.rows[0];

    // 2. Persist Uploaded Images with role = 'unprocessed'[cite: 2]
    if (Array.isArray(images) && images.length > 0) {
      // Clear out stale image references if re-committing the same code[cite: 2]
      await client.query("DELETE FROM listing_images WHERE listing_id = $1", [
        committedListing.id
      ]);

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img || !img.url) continue;

        await client.query(
          `INSERT INTO listing_images (
            listing_id, agency_id, position, url, role
          ) VALUES ($1, $2, $3, $4, $5)`,
          [
            committedListing.id,
            agencyId,
            i,
            img.url,
            img.role || "unprocessed" // Marked unprocessed to trigger Vision on first flyer request[cite: 2]
          ]
        );
      }
    }

    // 3. Clear the active draft session and memory buffers[cite: 2]
    ephemeralBuffers.delete(broker.id);
    await client.query("DELETE FROM listing_drafts WHERE broker_id = $1", [
      broker.id
    ]);

    return committedListing;
  });
}

/* ====================================================================== */
/* 6. Legacy Adapter (Preserves Backward Compatibility)                   */
/* ====================================================================== */
async function appendToDraft(
  broker,
  { mediaId, voiceId, text, customCode } = {}
) {
  let draft = await getDraft(broker.id);
  if (!draft) {
    draft = await createDraft(broker.id, broker.agency_id, broker.phone);
  }

  if (text) await appendText(broker.id, text);
  if (mediaId) {
    const session = getOrCreateBufferSession(broker.id);
    await appendMedia(broker.id, {
      mediaId,
      buffer: Buffer.from(""),
      mimeType: "image/jpeg"
    });
  }

  return {
    draft: await getDraft(broker.id),
    isNew: false,
    mediaLimitReached: (draft.media_ids || []).length >= MAX_IMAGES
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
  getStagedDraft,
  commitDraftToListing,
  appendToDraft,
  MAX_IMAGES,
  DRAFT_TTL_MS
};
