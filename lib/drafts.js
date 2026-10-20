// lib/drafts.js
"use strict";

const { pool } = require("./db");

const MAX_IMAGES = 15;

/**
 * Retrieves the broker's current active draft, if one exists.
 */
async function getDraft(brokerId) {
  const res = await pool.query(
    "SELECT * FROM listing_drafts WHERE broker_id = $1",
    [brokerId]
  );
  return res.rows[0] || null;
}

/**
 * Appends photos, audio, or text to the broker's draft.
 */
async function appendToDraft(
  broker,
  { mediaId, voiceId, text, customCode } = {}
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch existing or lock
    const res = await client.query(
      "SELECT * FROM listing_drafts WHERE broker_id = $1 FOR UPDATE",
      [broker.id]
    );

    let draft = res.rows[0];

    if (!draft) {
      // Initialize new draft
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
          text ? [text] : [],
          customCode || null
        ]
      );
      draft = insertRes.rows[0];
      await client.query("COMMIT");
      return { draft, isNew: true };
    }

    // Append to existing draft (enforce 15-image cap)
    const mediaIds = draft.media_ids || [];
    if (
      mediaId &&
      mediaIds.length < MAX_IMAGES &&
      !mediaIds.includes(mediaId)
    ) {
      mediaIds.push(mediaId);
    }

    const voiceIds = draft.voice_ids || [];
    if (voiceId && !voiceIds.includes(voiceId)) {
      voiceIds.push(voiceId);
    }

    const texts = draft.texts || [];
    if (text) {
      texts.push(text);
    }

    const finalCode = customCode || draft.custom_code;

    const updateRes = await client.query(
      `UPDATE listing_drafts
       SET media_ids = $1, voice_ids = $2, texts = $3, custom_code = $4, updated_at = NOW()
       WHERE broker_id = $5
       RETURNING *`,
      [mediaIds, voiceIds, texts, finalCode, broker.id]
    );

    await client.query("COMMIT");
    return { draft: updateRes.rows[0], isNew: false };
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
  MAX_IMAGES
};
