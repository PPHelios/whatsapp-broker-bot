// lib/listingStore.js — Listing reads by code and the single write path for edits (optimistic locking)
"use strict";

const L = require("./listing");
const T = require("./text");
const Authz = require("./authz");
const { normalizeCode } = require("../domain/searchQuery");
const Dup = require("../domain/unitDuplicate");
const UnitCode = require("../domain/unitCode");

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
    const unitCode = explicit ? L.generateListingCode(code, f.property_type).code : await nextUnitCode(db, broker.agency_id, f.property_type);
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

/**
 * The agency's next auto code (NH-V12): bumps the running number under the agency row's lock, so two units saved at
 * once get different numbers. The prefix comes from the agency's name the first time. A number a broker already
 * typed by hand is skipped.
 */
async function nextUnitCode(db, agencyId, propertyType) {
  const { rows: a } = await db.query("SELECT name, code_prefix FROM agencies WHERE id = $1", [agencyId]);
  const initial = a[0]?.code_prefix || UnitCode.prefixFrom(a[0]?.name);
  for (let i = 0; i < 50; i++) {
    const { rows } = await db.query(
      "UPDATE agencies SET unit_code_seq = unit_code_seq + 1, code_prefix = COALESCE(code_prefix, $2) WHERE id = $1 RETURNING code_prefix, unit_code_seq",
      [agencyId, initial]
    );
    const code = UnitCode.format(rows[0].code_prefix, propertyType, rows[0].unit_code_seq);
    const { rows: taken } = await db.query("SELECT 1 FROM listings WHERE agency_id = $1 AND code = $2", [agencyId, code]);
    if (!taken.length) return code;
  }
  throw new Error("Could not allocate a unit code");
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
// Photos a client may see: everything but documents (contracts, IDs).
const SHOWABLE = "(role IS NULL OR role <> 'document')";

/** A unit's photos in their curated order (hero first), up to `limit`. */
async function photosOf(db, listing, { limit = 10 } = {}) {
  const { rows } = await db.query(
    `SELECT url FROM listing_images WHERE listing_id = $1 AND agency_id = $2 AND ${SHOWABLE} AND url LIKE 'https://%'
      ORDER BY (position = $3) DESC, position, id LIMIT $4`,
    [listing.id, listing.agency_id, Number(listing.hero_position) || 0, limit]
  );
  return rows.map((r) => r.url);
}

/** The cover photo of each unit (hero, else the first): Map listing id → url. */
async function coverPhotos(db, agencyId, listings = []) {
  const ids = listings.map((l) => l.id).filter(Boolean);
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT DISTINCT ON (i.listing_id) i.listing_id, i.url
       FROM listing_images i JOIN listings l ON l.id = i.listing_id AND l.agency_id = i.agency_id
      WHERE i.agency_id = $1 AND i.listing_id = ANY($2::uuid[]) AND (i.role IS NULL OR i.role NOT IN ('document', 'unrelated', 'layout')) AND i.url LIKE 'https://%'
      ORDER BY i.listing_id, (i.position = coalesce(l.hero_position, 0)) DESC, i.position, i.id`,
    [agencyId, ids]
  );
  return new Map(rows.map((r) => [r.listing_id, r.url]));
}

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
 * @param {Object} opts - { listing (row), patch: column → value, expectedVersion, priceSource (listing_prices.source) }
 * @returns {Promise<{ listing } | { conflict: true } | { forbidden: true }>}
 */
async function applyListingPatch(db, broker, { listing, patch, expectedVersion = null, priceSource = "edit" }) {
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
  if (rows[0] && "price_value" in values) await notePriceChange(db, broker, listing, rows[0], priceSource);
  return rows[0] ? { listing: rows[0] } : { conflict: true };
}

/** A changed price joins the unit's price history (C2, listing_prices); the first change also keeps the old price. */
async function notePriceChange(db, broker, before, after, source = "edit") {
  const from = Number(before.price_value) || null;
  const to = Number(after.price_value) || null;
  if (!to || from === to) return;
  const { rows } = await db.query("SELECT 1 FROM listing_prices WHERE listing_id = $1 LIMIT 1", [after.id]);
  if (!rows.length && from) {
    await db.query("INSERT INTO listing_prices (agency_id, listing_id, price, source, changed_at) VALUES ($1, $2, $3, 'edit', $4)", [after.agency_id, after.id, from, before.confirmed_at || before.created_at || new Date()]);
  }
  await db.query("INSERT INTO listing_prices (agency_id, listing_id, price, source, changed_by) VALUES ($1, $2, $3, $4, $5)", [after.agency_id, after.id, to, source, broker.id || null]);
}

/**
 * An active unit of the agency that looks like this one (P13, domain/unitDuplicate.js): its code, or null.
 * SQL narrows by bedrooms, area and price; the shared rule decides.
 */
async function findDuplicate(db, agencyId, l, { excludeId = null } = {}) {
  if (!Dup.comparable(l)) return null;
  const { rows } = await db.query(
    `SELECT id, code, compound, district, city, location, listing_type, bedrooms, property_type, area_value, price_value
       FROM listings
      WHERE agency_id = $1 AND status = 'active' AND id IS DISTINCT FROM $5::uuid
        AND coalesce(details->>'catalogue', '') <> 'true'
        AND coalesce(bedrooms, -1) = coalesce($2::int, -1)
        AND area_value BETWEEN $3::numeric * 0.9 AND $3::numeric * 1.1
        AND price_value BETWEEN $4::numeric * 0.9 AND $4::numeric * 1.1
      ORDER BY confirmed_at DESC NULLS LAST, created_at DESC LIMIT 50`,
    [agencyId, l.bedrooms ?? null, l.area_value, l.price_value, excludeId]
  );
  return rows.find((r) => Dup.sameUnit(l, r))?.code || null;
}

/**
 * C3: the agency's catalogue unit or model that a broker's own listing looks like (a soft note on the review; never a
 * block): { code, dev_code, model, project } or null. Catalogue units are not checked against themselves.
 */
async function findCatalogueMatch(db, agencyId, l, { excludeId = null } = {}) {
  if (!Dup.comparable(l) || l.details?.catalogue) return null;
  const { rows } = await db.query(
    `SELECT l.id, l.code, l.developer_unit_code, l.inventory_type, l.compound, l.compound_en, l.compound_key, l.property_type,
            l.bedrooms, l.area_value, l.price_value, l.details, p.name AS project_name
       FROM listings l LEFT JOIN projects p ON p.id = l.project_id
      WHERE l.agency_id = $1 AND l.status = 'active' AND l.id IS DISTINCT FROM $3::uuid
        AND l.details->>'catalogue' = 'true'
        AND l.price_value BETWEEN $2::numeric / 1.35 AND $2::numeric * 1.1
      ORDER BY l.inventory_type = 'developer_model', l.updated_at DESC LIMIT 100`,
    [agencyId, l.price_value, excludeId]
  );
  const keyed = { ...l, compound_key: l.compound_key || null };
  const hit = rows.find((r) => Dup.catalogueMatch(keyed, r));
  return hit ? { code: hit.code, dev_code: hit.developer_unit_code || null, model: hit.inventory_type === "developer_model", project: hit.project_name || hit.compound } : null;
}

module.exports = {
  findCatalogueMatch,
  photosOf,
  coverPhotos, findByCode, findDuplicate, createListing, nextUnitCode, addPhotos, removePhotos, applyListingPatch, INSERT_COLUMNS, PATCH_COLUMNS };
