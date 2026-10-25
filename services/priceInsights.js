// services/priceInsights.js — Price per m² from the agency's own units (phase 2 step 8). For each compound (or district
// when a unit has no compound), sale and rent apart: how many active units, the median, lowest and highest price per
// m². A group is shown only with at least MIN_UNITS units, so one odd listing never reads as "the market". Agency only.
"use strict";

const MIN_UNITS = 5;

const PLACE = "COALESCE(NULLIF(trim(compound), ''), NULLIF(trim(district), ''))";
const BASE = `agency_id = $1 AND status = 'active' AND listing_type IN ('sale', 'rent') AND price_value > 0 AND area_value >= 20`;

/** All groups with enough units: [{ place, listing_type, units, median, low, high }], busiest first. */
async function byPlace(db, agencyId, { minUnits = MIN_UNITS } = {}) {
  const { rows } = await db.query(
    `SELECT ${PLACE} AS place, listing_type, count(*)::int AS units,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price_value / area_value))::bigint AS median,
            round(min(price_value / area_value))::bigint AS low, round(max(price_value / area_value))::bigint AS high
       FROM listings WHERE ${BASE} AND ${PLACE} IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) >= $2
      ORDER BY count(*) DESC, 1, 2`,
    [agencyId, minUnits]
  );
  return rows.map((r) => ({ ...r, median: Number(r.median), low: Number(r.low), high: Number(r.high) }));
}

/**
 * How one unit's price per m² compares with its compound (same purpose): { perM2, median, units, diffPct } or null when
 * the unit or its group can't be compared (no price or area, or fewer than MIN_UNITS other units).
 */
async function forUnit(db, listing, { minUnits = MIN_UNITS } = {}) {
  const place = String(listing?.compound || listing?.district || "").trim();
  if (!place || !(Number(listing.price_value) > 0) || !(Number(listing.area_value) >= 20) || !["sale", "rent"].includes(listing.listing_type)) return null;
  const { rows } = await db.query(
    `SELECT count(*)::int AS units, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price_value / area_value))::bigint AS median
       FROM listings WHERE ${BASE} AND ${PLACE} = $2 AND listing_type = $3 AND id <> $4`,
    [listing.agency_id, place, listing.listing_type, listing.id]
  );
  const g = rows[0];
  if (!g || g.units < minUnits) return null;
  const perM2 = Math.round(Number(listing.price_value) / Number(listing.area_value));
  const median = Number(g.median);
  return { place, perM2, median, units: g.units, diffPct: median > 0 ? Math.round(((perM2 - median) * 100) / median) : null };
}

module.exports = { MIN_UNITS, byPlace, forUnit };
