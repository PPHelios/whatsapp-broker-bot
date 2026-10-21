// lib/drafts.js
"use strict";

const { pool } = require("./db");

const MAX_IMAGES = 15;
const DRAFT_TTL_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Retrieves the broker's current active draft, if one exists.
 * Lazily evicts expired drafts (> 60 minutes old).
 */
async function getDraft(brokerId) {
  const res = await pool.query(
    "SELECT * FROM listing_drafts WHERE broker_id = $1",
    [brokerId]
  );
  const draft = res.rows[0];
  if (!draft) return null;

  // Lazy TTL eviction
  if (draft.updated_at) {
    const ageMs = Date.now() - new Date(draft.updated_at).getTime();
    if (ageMs > DRAFT_TTL_MS) {
      await clearDraft(brokerId);
      return null;
    }
  }

  return draft;
}

/**
 * Appends photos, audio, or text to the broker's draft with strict deduplication.
 */
async function appendToDraft(
  broker,
  { mediaId, voiceId, text, customCode } = {}
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      "SELECT * FROM listing_drafts WHERE broker_id = $1 FOR UPDATE",
      [broker.id]
    );

    let draft = res.rows[0];

    // Lazy TTL check on existing draft under lock
    if (draft && draft.updated_at) {
      const ageMs = Date.now() - new Date(draft.updated_at).getTime();
      if (ageMs > DRAFT_TTL_MS) {
        await client.query("DELETE FROM listing_drafts WHERE broker_id = $1", [
          broker.id
        ]);
        draft = null;
      }
    }

    if (!draft) {
      // Initialize new draft
      const cleanText = text ? String(text).trim() : null;
      const insertRes = await client.query(
        `INSERT INTO listing_drafts
          (broker_id, agency_id, broker_phone, media_ids, voice_ids, texts, custom_code, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING *`,
        [
          broker.id,
          broker.agency_id,
          broker.phone,
          mediaId ? [mediaId] : [],
          voiceId ? [voiceId] : [],
          cleanText ? [cleanText] : [],
          customCode || null
        ]
      );
      draft = insertRes.rows[0];
      await client.query("COMMIT");
      return { draft, isNew: true, mediaLimitReached: false };
    }

    // Append to existing draft with deduplication
    const mediaIds = draft.media_ids || [];
    let mediaLimitReached = false;

    if (mediaId) {
      if (mediaIds.length >= MAX_IMAGES) {
        mediaLimitReached = true;
      } else if (!mediaIds.includes(mediaId)) {
        mediaIds.push(mediaId);
      }
    }

    const voiceIds = draft.voice_ids || [];
    if (voiceId && !voiceIds.includes(voiceId)) {
      voiceIds.push(voiceId);
    }

    const texts = draft.texts || [];
    if (text) {
      const clean = String(text).trim();
      if (clean && !texts.includes(clean)) {
        texts.push(clean);
      }
    }

    // Last Write Wins for unit code
    const finalCode = customCode || draft.custom_code;

    const updateRes = await client.query(
      `UPDATE listing_drafts
       SET media_ids = $1, voice_ids = $2, texts = $3, custom_code = $4, updated_at = NOW()
       WHERE broker_id = $5
       RETURNING *`,
      [mediaIds, voiceIds, texts, finalCode, broker.id]
    );

    await client.query("COMMIT");
    return { draft: updateRes.rows[0], isNew: false, mediaLimitReached };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Permanently clears the active draft upon "تم", "إلغاء", or timeout.
 */
async function clearDraft(brokerId) {
  await pool.query("DELETE FROM listing_drafts WHERE broker_id = $1", [
    brokerId
  ]);
}

module.exports = {
  getDraft,
  appendToDraft,
  clearDraft,
  MAX_IMAGES,
  DRAFT_TTL_MS
};
