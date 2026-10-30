// services/priceInsights.js — Price per m² from the agency's own units (phase 2 step 8). For each compound (or district
// when a unit has no compound), sale and rent apart: how many active units, the median, lowest and highest price per
// m². A group is shown only with at least MIN_UNITS units, so one odd listing never reads as "the market". Agency only.
"use strict";
const Vis = require("../lib/visibility");

const MIN_UNITS = 5;

const PLACE = "COALESCE(NULLIF(trim(compound), ''), NULLIF(trim(district), ''))";
const BASE = `agency_id = $1 AND status = 'active' AND listing_type IN ('sale', 'rent') AND price_value > 0 AND area_value >= 20`;

/** All groups with enough units: [{ place, listing_type, units, median, low, high }], busiest first. */
async function byPlace(db, agencyId, { minUnits = MIN_UNITS } = {}) {
  const { rows } = await db.query(
    `SELECT ${PLACE} AS place, listing_type, count(*)::int AS units,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price_value / area_value))::bigint AS median,
            round(min(price_value / area_value))::bigint AS low, round(max(price_value / area_value))::bigint AS high
       FROM listings WHERE ${Vis.units("listings")} AND ${BASE} AND ${PLACE} IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) >= $2
      ORDER BY count(*) DESC, 1, 2`,
    [agencyId, minUnits]
  );
  return rows.map((r) => ({ ...r, median: Number(r.median), low: Number(r.low), high: Number(r.high) }));
}

// P1: rent extras, so a furnished flat isn't compared with an empty one.
const EXTRAS = `CASE WHEN furnishing = 'furnished' OR 'furnished' = ANY(feature_keys) THEN 'furnished'
  WHEN furnishing = 'semi_furnished' THEN 'semi_furnished'
  WHEN feature_keys && ARRAY['kitchen_installed', 'ac_installed']::text[] THEN 'kitchen_ac' ELSE 'none' END`;

/** The rent extras group of a unit: furnished, semi_furnished, kitchen_ac (fitted kitchen or ACs) or none. */
function extrasOf(l) {
  const keys = Array.isArray(l.feature_keys) ? l.feature_keys : [];
  if (l.furnishing === "furnished" || keys.includes("furnished")) return "furnished";
  if (l.furnishing === "semi_furnished") return "semi_furnished";
  return keys.includes("kitchen_installed") || keys.includes("ac_installed") ? "kitchen_ac" : "none";
}

/**
 * How one unit's price per m² compares with its compound (same purpose): { place, perM2, median, units, diffPct, like }
 * or null when the unit or its group can't be compared (no price or area, or fewer than MIN_UNITS other units).
 * P1: first against units with the same finishing (and, for rent, the same extras: furnished, kitchen/ACs, none),
 * then the same finishing only, then the whole compound; `like` says which ({ finishing, extras }, null = any).
 */
async function forUnit(db, listing, { minUnits = MIN_UNITS } = {}) {
  const place = String(listing?.compound || listing?.district || "").trim();
  if (!place || !(Number(listing.price_value) > 0) || !(Number(listing.area_value) >= 20) || !["sale", "rent"].includes(listing.listing_type)) return null;
  const finishing = String(listing.finishing || "").trim() || null;
  const extras = listing.listing_type === "rent" ? extrasOf(listing) : null;
  const tiers = [];
  if (finishing && extras) tiers.push({ finishing, extras });
  if (finishing) tiers.push({ finishing, extras: null });
  if (extras && !finishing) tiers.push({ finishing: null, extras });
  tiers.push({ finishing: null, extras: null });
  for (const like of tiers) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS units, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price_value / area_value))::bigint AS median
         FROM listings WHERE ${Vis.units("listings")} AND ${BASE} AND ${PLACE} = $2 AND listing_type = $3 AND id IS DISTINCT FROM $4
          AND ($5::text IS NULL OR finishing = $5) AND ($6::text IS NULL OR ${EXTRAS} = $6)`,
      [listing.agency_id, place, listing.listing_type, listing.id || null, like.finishing, like.extras]
    );
    const g = rows[0];
    if (!g || g.units < minUnits) continue;
    const perM2 = Math.round(Number(listing.price_value) / Number(listing.area_value));
    const median = Number(g.median);
    return { place, perM2, median, units: g.units, diffPct: median > 0 ? Math.round(((perM2 - median) * 100) / median) : null, like };
  }
  return null;
}

const EXTRAS_LABELS = { furnished: ["مفروشة", "furnished"], semi_furnished: ["نص فرش", "semi-furnished"], kitchen_ac: ["بمطبخ أو تكييفات", "with kitchen or ACs"], none: ["فاضية", "unfurnished"] };

/** What the units were compared with, e.g. "fully finished, furnished" (empty for the whole compound). */
function likeLabel(m, lang = "ar") {
  const i = lang === "en" ? 1 : 0;
  const parts = [];
  if (m?.like?.finishing) parts.push(require("../domain/describe").finishingLabel({ finishing: m.like.finishing }, lang) || m.like.finishing);
  if (m?.like?.extras) parts.push(EXTRAS_LABELS[m.like.extras][i]);
  return parts.join(lang === "en" ? ", " : "، ");
}

/** One plain-text line for the bot when a unit is added: "📊 12% above the median of 6 … units in X". */
function noteLine(m, listing, lang = "ar") {
  if (!m) return "";
  const n = (x) => Number(x).toLocaleString("en-US");
  const en = lang === "en";
  const diff = m.diffPct === null || Math.abs(m.diffPct) < 3 ? (en ? "close to" : "قريب من") : m.diffPct > 0 ? (en ? `${m.diffPct}% above` : `أعلى ${m.diffPct}% من`) : en ? `${-m.diffPct}% below` : `أقل ${-m.diffPct}% من`;
  const like = likeLabel(m, lang);
  const month = listing.listing_type === "rent" ? (en ? " a month" : " في الشهر") : "";
  return en
    ? `📊 ${n(m.perM2)} EGP per m²${month} · ${diff} the median of ${m.units} ${like ? `${like} ` : ""}units in ${m.place} (${n(m.median)})`
    : `📊 ${n(m.perM2)} ج.م للمتر${month} · ${diff} وسيط ${m.units} وحدة${like ? ` (${like})` : ""} في ${m.place} (${n(m.median)})`;
}

module.exports = { MIN_UNITS, byPlace, forUnit, extrasOf, likeLabel, noteLine };
