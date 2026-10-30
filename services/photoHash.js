// services/photoHash.js — Duplicate-photo flag (phase 2 step 5). Each listing photo gets a 64-bit difference hash
// (dHash: a 9×8 greyscale thumbnail, one bit per "is this pixel brighter than its right neighbour"), stored in
// listing_images.phash. The same picture resized, recompressed or re-sent on WhatsApp keeps almost the same bits, so
// a new photo within MAX_DISTANCE bits of a photo on another active unit of the agency is flagged as "same photo as".
"use strict";

const Vis = require("../lib/visibility");
const sharp = require("sharp");
const Supabase = require("../lib/supabase");
const Billing = require("./billing");

const MAX_DISTANCE = 6;
const BACKFILL_BATCH = 40;

/** The photo's dHash as a 64-character bit string (what a bit(64) column takes), or null when it can't be read. */
async function hashImage(buffer) {
  try {
    const px = await sharp(buffer).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
    let bits = "";
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? "1" : "0";
    return bits;
  } catch {
    return null;
  }
}

/** Bits that differ between two hashes. */
function distance(a, b) {
  let n = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) n++;
  return n;
}

/**
 * For each hash, the code of an active unit of the agency that already has the same photo (Map hash → code).
 * @param {string[]} hashes
 * @param {Object} [opts] - { excludeListingId }
 */
async function sameAs(db, agencyId, hashes = [], { excludeListingId = null } = {}) {
  const out = new Map();
  const list = [...new Set(hashes.filter((h) => /^[01]{64}$/.test(String(h))))];
  if (!list.length) return out;
  const { rows } = await db.query(
    `SELECT DISTINCT ON (h.hash) h.hash, l.code
       FROM unnest($2::text[]) AS h(hash)
       JOIN listing_images i ON i.agency_id = $1 AND i.phash IS NOT NULL AND bit_count(i.phash # h.hash::bit(64)) <= $3
       JOIN listings l ON l.id = i.listing_id AND l.status = 'active' AND ${Vis.units("l")} AND ($4::uuid IS NULL OR l.id <> $4::uuid)
      ORDER BY h.hash, bit_count(i.phash # h.hash::bit(64)), l.created_at`,
    [agencyId, list, MAX_DISTANCE, excludeListingId]
  );
  for (const r of rows) out.set(r.hash, r.code);
  return out;
}

/** Stores the hash of photos just added (url → hash), agency-scoped. */
async function saveHashes(db, agencyId, byUrl = new Map()) {
  for (const [url, hash] of byUrl) {
    if (hash) await db.query("UPDATE listing_images SET phash = $3::bit(64) WHERE agency_id = $1 AND url = $2 AND phash IS NULL", [agencyId, url, hash]);
  }
}

/**
 * Hashes photos stored before hashing existed, a batch at a time in id order (a photo that can't be downloaded is
 * passed over: the cursor moves on, so a broken URL is tried again only when the cursor wraps round).
 */
async function backfill(pool, { limit = BACKFILL_BATCH } = {}) {
  const cursor = (await Billing.getSetting(pool, "phash_cursor", { id: null })).id;
  const { rows } = await pool.query(
    `SELECT id, url FROM listing_images WHERE phash IS NULL AND url LIKE 'https://%' AND ($1::uuid IS NULL OR id > $1::uuid)
      ORDER BY id LIMIT $2`,
    [cursor, limit]
  );
  let hashed = 0;
  for (const r of rows) {
    const img = await Supabase.downloadListingImage(r.url);
    const hash = img ? await hashImage(img.buffer) : null;
    if (hash) {
      await pool.query("UPDATE listing_images SET phash = $2::bit(64) WHERE id = $1", [r.id, hash]);
      hashed++;
    }
  }
  // A full batch means more may follow; a short one wraps the cursor so photos added since are reached too.
  await Billing.setSetting(pool, "phash_cursor", { id: rows.length === limit ? rows[rows.length - 1].id : null });
  return { seen: rows.length, hashed };
}

const backfillJob = () => ({
  name: "photo_hashes",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool }) => ({ counts: await backfill(pool) })
});

module.exports = { MAX_DISTANCE, hashImage, distance, sameAs, saveHashes, backfill, backfillJob };
