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

module.exports = { findByCode, applyListingPatch, PATCH_COLUMNS };
