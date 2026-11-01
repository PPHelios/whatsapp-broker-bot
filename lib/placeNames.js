// lib/placeNames.js — The place_names table: new English compound names wait here for the CRM owner's Arabic name.
// A new name is alerted once (Telegram, through alertOwner); approved names are cached briefly for search.
"use strict";

const PlaceNames = require("../domain/placeNames");
const Places = require("../domain/places");
const { alertOwner } = require("./errorReports");
const Links = require("./links");

const CACHE_MS = 60 * 1000;
let approvedCache = { at: 0, rows: [] };

/** Saves a name seen on a unit. A name the app already knows, or an Arabic-only name, is ignored. */
async function noteUnknown(pool, name, { example = "", alert = alertOwner } = {}) {
  if (!PlaceNames.isNewEnglishName(name)) return { status: "ignored" };
  // A name that contains a known place or compound ("Hyde Park Compound") is not new.
  if (Places.findPlaces(name).places.length) return { status: "known" };
  const key = PlaceNames.nameKey(name);
  if (!key) return { status: "ignored" };
  const { rows } = await pool.query(
    `INSERT INTO place_names (name_key, name_en, example) VALUES ($1, $2, $3)
     ON CONFLICT (name_key) DO UPDATE SET times_seen = place_names.times_seen + 1
     RETURNING status, times_seen, (xmax = 0) AS inserted`,
    [key, String(name).trim(), String(example).slice(0, 200)]
  );
  const row = rows[0];
  if (row.status === "approved") return { status: "approved" };
  if (row.inserted) {
    await alert(`🆕 اسم كمبوند جديد: ${String(name).trim()}\nاكتب اسمه بالعربي هنا: ${Links.appUrl("owner#place-names")}`).catch(() => {});
    return { status: "new" };
  }
  return { status: "pending", timesSeen: row.times_seen };
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

/** Pending names for the owner, most seen first. */
async function pending(pool) {
  const { rows } = await pool.query(
    "SELECT id, name_en, times_seen, example, created_at FROM place_names WHERE status = 'pending' ORDER BY times_seen DESC, created_at LIMIT 200"
  );
  return rows;
}

/** The owner gives the Arabic name: the row is approved and search uses it from the next minute (or at once after a reset). */
async function approve(pool, id, nameAr) {
  const ar = String(nameAr || "").trim();
  if (!ar || !/[؀-ۿ]/.test(ar) || ar.length > 80) return { error: "bad_arabic" };
  const { rows } = await pool.query(
    "UPDATE place_names SET name_ar = $2, status = 'approved', decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING name_en",
    [id, ar]
  );
  if (!rows.length) return { error: "not_pending" };
  approvedCache = { at: 0, rows: [] };
  return { ok: true, name_en: rows[0].name_en };
}

module.exports = { noteUnknown, widenSearchTerms, pending, approve, approved };
