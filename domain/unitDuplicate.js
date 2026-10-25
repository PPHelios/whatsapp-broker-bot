// domain/unitDuplicate.js — "Looks like the same unit" (P13), one rule for every way a unit comes in: the WhatsApp
// draft review, the web add form, the group import (against the inventory and inside one paste). Same place (the
// compound, or the district/city/location when there's no compound), same listing type and bedrooms, a compatible
// property type, and area and price within 5%. It only warns: the broker can always save anyway.
"use strict";

const { normalizeSearch } = require("./searchText");

const TOLERANCE = 0.05;

/** The place a unit is matched on: { compound } or { district } (normalized), or null when it has neither. */
function placeKey(l) {
  const compound = normalizeSearch(l?.compound || "");
  if (compound) return { compound };
  const district = normalizeSearch(l?.district || l?.city || l?.location || "");
  return district ? { district } : null;
}

/** Enough to compare: a place, an area and a price. */
const comparable = (l) => Boolean(placeKey(l) && Number(l.area_value) > 0 && Number(l.price_value) > 0);

const near = (a, b) => Math.abs(Number(a) - Number(b)) <= Number(b) * TOLERANCE;

function samePlace(a, b) {
  const pa = placeKey(a);
  const pb = placeKey(b);
  if (!pa || !pb) return false;
  if (pa.compound) return normalizeSearch(b.compound || "") === pa.compound;
  return [b.district, b.city, b.location].some((v) => v && normalizeSearch(v) === pa.district);
}

/** a looks like b (b is the stored or earlier unit). */
function sameUnit(a, b) {
  if (!comparable(a) || !comparable(b)) return false;
  if ((a.listing_type || "sale") !== (b.listing_type || "sale")) return false;
  if ((a.bedrooms ?? -1) !== (b.bedrooms ?? -1)) return false;
  if (a.property_type && b.property_type && a.property_type !== b.property_type) return false;
  return samePlace(a, b) && near(a.area_value, b.area_value) && near(a.price_value, b.price_value);
}

module.exports = { TOLERANCE, placeKey, comparable, sameUnit };
