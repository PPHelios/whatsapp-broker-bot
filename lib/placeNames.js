// lib/placeNames.js — The place_names table: new English compound names wait here for the CRM owner (services/placeReview.js).
// Approved names are cached briefly for search.
"use strict";

const PlaceNames = require("../domain/placeNames");
const Places = require("../domain/places");

const CACHE_MS = 60 * 1000;
let approvedCache = { at: 0, rows: [] };

/**
 * Saves a name seen on a unit. A name the app already knows, or an Arabic-only name, is ignored. The owner is told in the
 * hourly digest (services/systemAlerts), not per name. A broker who already queued the hourly limit queues no more names
 * (the unit is still saved); a name the owner rejected stays rejected.
 */
async function noteUnknown(pool, name, { example = "", brokerId = null, batch = null } = {}) {
  if (!PlaceNames.isNewEnglishName(name)) return { status: "ignored" };
  // A name that contains a known place or compound ("Hyde Park Compound") is not new.
  if (Places.findPlaces(name).places.length) return { status: "known" };
  const key = PlaceNames.nameKey(name);
  if (!key) return { status: "ignored" };
  if (brokerId) {
    const seen = await pool.query("SELECT 1 FROM place_names WHERE name_key = $1", [key]);
    if (!seen.rows.length && (await require("../services/placeReview").overLimit(pool, brokerId))) return { status: "limited" };
  }
  const { rows } = await pool.query(
    `INSERT INTO place_names (name_key, name_en, example) VALUES ($1, $2, $3)
     ON CONFLICT (name_key) DO UPDATE SET times_seen = place_names.times_seen + 1
     RETURNING id, status, times_seen, (xmax = 0) AS inserted`,
    [key, String(name).trim(), String(example).slice(0, 200)]
  );
  const row = rows[0];
  if (brokerId && row.status === "pending") await require("../services/placeReview").recordProposal(pool, "compound", row.id, brokerId, batch).catch(() => {});
  if (row.status !== "pending") return { status: row.status };
  return row.inserted ? { status: "new" } : { status: "pending", timesSeen: row.times_seen };
}

/** The Arabic name and map link a broker typed for a new compound: kept on its pending name (never over what is already there). */
async function addDetails(pool, name, { nameAr = "", pin = "" } = {}) {
  const key = PlaceNames.nameKey(name);
  const ar = String(nameAr || "").trim().slice(0, 120);
  const link = String(pin || "").trim().slice(0, 500);
  if (!key || (!ar && !link)) return;
  await pool.query(
    "UPDATE place_names SET name_ar = COALESCE(name_ar, $2), pin_link = COALESCE(pin_link, $3) WHERE name_key = $1 AND status = 'pending'",
    [key, /[\u0600-\u06FF]/.test(ar) ? ar : null, link || null]
  );
}

/** Approved names, cached for a minute so a search does not query the table each time. */
async function approved(pool) {
  if (Date.now() - approvedCache.at < CACHE_MS) return approvedCache.rows;
  const { rows } = await pool.query("SELECT name_en, name_ar FROM place_names WHERE status = 'approved'").catch(() => ({ rows: [] }));
  approvedCache = { at: Date.now(), rows };
  return rows;
}

/** Search terms with approved names widened to both languages (see domain/placeNames widenTerms). */
async function widenSearchTerms(pool, terms) {
  if (!terms.length) return terms;
  return PlaceNames.widenTerms(terms, await approved(pool));
}

/** Forgets the cached approved names (after the owner approves or merges one). */
function resetCache() {
  approvedCache = { at: 0, rows: [] };
}

module.exports = { noteUnknown, addDetails, widenSearchTerms, resetCache, approved };
