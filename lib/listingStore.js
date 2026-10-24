// lib/listingStore.js — Listing reads by code and the single write path for edits (optimistic locking)
"use strict";

const L = require("./listing");
const T = require("./text");
const Authz = require("./authz");
const { normalizeCode } = require("../domain/searchQuery");

/** One listing of the agency by its code (or developer code), case- and digit-folded (code_norm index). */
async function findByCode(db, agencyId, code, { forUpdate = false } = {}) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  const { rows } = await db.query(
    `SELECT * FROM listings
     WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
     ORDER BY (code_norm = $2) DESC
     LIMIT 1 ${forUpdate ? "FOR UPDATE" : ""}`,
    [agencyId, norm]
  );
  return rows[0] || null;
}

// Columns an insert writes, in order (values come from a reviewed listing).
const INSERT_COLUMNS = [...L.LISTING_COLUMNS, "location_keywords", "feature_keys", "features_other", "payment_terms", "inventory_type", "is_primary_developer", "details"];

/**
 * createListing: the one insert path (WhatsApp drafts, the web form, imports). Insert-only:
 * a stated code that exists (23505 on the case/digit-folded code_norm) returns { conflict, code }
 * and nothing is written; a generated code that collides is regenerated (savepoint per attempt).
 * Must run inside a transaction. Sets confirmed_at; status active.
 * @param {Object} db - a client inside a transaction
 * @param {Object} broker - the owner of the new unit
 * @param {Object} opts - { fields (composed + evaluated listing), code (stated) | null, lang }
 * @returns {Promise<{ listing } | { conflict: true, code }>}
 */
async function createListing(db, broker, { fields, code = null, lang = "ar" }) {
  const f = fields || {};
  const explicit = Boolean(code);
  const priceDisplay = f.price_value
    ? T.formatAbbreviatedPrice(f.price_value, f.details?.currency || "EGP", lang, f.listing_type || "sale")
    : null;
  const values = {
    ...f,
    title: f.title || null,
    is_primary_developer: f.market === "primary",
    details: JSON.stringify(f.details || {}),
    payment_terms: JSON.stringify(f.payment_terms || {})
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const unitCode = L.generateListingCode(explicit ? code : null, f.property_type).code;
    await db.query("SAVEPOINT listing_insert");
    try {
      const cols = ["agency_id", "broker_id", "code", "price_display", "status", "confirmed_at", ...INSERT_COLUMNS];
      const params = [broker.agency_id, broker.id, unitCode, priceDisplay, "active", new Date().toISOString(), ...INSERT_COLUMNS.map((c) => values[c] ?? null)];
      const { rows } = await db.query(
        `INSERT INTO listings (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        params
      );
      await db.query("RELEASE SAVEPOINT listing_insert");
      return { listing: rows[0] };
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT listing_insert");
      if (err.code !== "23505") throw err;
      if (explicit) return { conflict: true, code: unitCode };
    }
  }
  throw new Error("Could not allocate a unique listing code");
}

/** Appends photos (storage URLs) to a listing after its last position; returns the new rows. */
async function addPhotos(db, listing, urls = []) {
  if (!urls.length) return [];
  const { rows } = await db.query("SELECT coalesce(max(position), -1) AS last FROM listing_images WHERE listing_id = $1", [listing.id]);
  const out = [];
  let pos = Number(rows[0].last) + 1;
  for (const url of urls) {
    const { rows: ins } = await db.query(
      `INSERT INTO listing_images (listing_id, agency_id, position, url, role) VALUES ($1, $2, $3, $4, NULL) RETURNING *`,
      [listing.id, listing.agency_id, pos++, url]
    );
    out.push(ins[0]);
  }
  return out;
}

/** Removes photos of a listing by id (agency-scoped); returns their URLs for storage cleanup after commit. */
async function removePhotos(db, listing, imageIds = []) {
  if (!imageIds.length) return [];
  const { rows } = await db.query(
    "DELETE FROM listing_images WHERE listing_id = $1 AND agency_id = $2 AND id = ANY($3::uuid[]) RETURNING url",
    [listing.id, listing.agency_id, imageIds]
  );
  return rows.map((r) => r.url);
}

// Columns a patch may write.
const PATCH_COLUMNS = [...L.LISTING_COLUMNS, "status", "location_keywords", "feature_keys", "features_other", "payment_terms", "details", "price_display", "inventory_type"];

/**
 * applyListingPatch: the one write path for edits and quick updates.
 * - authorization (lib/authz.js) under the row lock
 * - optimistic lock: expectedVersion must match listings.version, else { conflict: true }
 * - confirmed_at = now (the broker just vouched for the unit), flyer cache cleared, version + 1
 * @param {Object} db - a client inside a transaction, or the pool
 * @param {Object} broker
 * @param {Object} opts - { listing (row), patch: column → value, expectedVersion }
 * @returns {Promise<{ listing } | { conflict: true } | { forbidden: true }>}
 */
async function applyListingPatch(db, broker, { listing, patch, expectedVersion = null }) {
  if (!Authz.canEdit(broker, listing)) return { forbidden: true };
  const version = expectedVersion ?? listing.version;
  const values = { ...patch };
  if ("price_value" in values && values.price_value) {
    values.price_display = T.formatAbbreviatedPrice(
      values.price_value,
      (values.details || listing.details)?.currency || "EGP",
      broker.preferred_lang || "ar",
      values.listing_type || listing.listing_type || "sale"
    );
  }
  const cols = Object.keys(values).filter((c) => PATCH_COLUMNS.includes(c));
  const params = [listing.id, broker.agency_id, version];
  const sets = cols.map((c) => {
    const v = c === "details" || c === "payment_terms" ? JSON.stringify(values[c] ?? {}) : values[c];
    params.push(v);
    return `${c} = $${params.length}`;
  });
  const { rows } = await db.query(
    `UPDATE listings SET ${[...sets, "version = version + 1", "confirmed_at = NOW()", "flyer_cache = '{}'::jsonb", "updated_at = NOW()"].join(", ")}
     WHERE id = $1 AND agency_id = $2 AND version = $3
     RETURNING *`,
    params
  );
  return rows[0] ? { listing: rows[0] } : { conflict: true };
}

module.exports = { findByCode, createListing, addPhotos, removePhotos, applyListingPatch, INSERT_COLUMNS, PATCH_COLUMNS };
