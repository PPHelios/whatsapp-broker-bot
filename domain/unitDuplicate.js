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

/** Same compound: the canonical compound key when both have one (synonyms, Arabic/English), else the normalized name. */
function sameCompound(a, b) {
  if (a.compound_key && b.compound_key) return a.compound_key === b.compound_key;
  const ca = normalizeSearch(a.compound || "");
  return Boolean(ca) && [b.compound, b.compound_en].some((v) => v && normalizeSearch(v) === ca);
}

/**
 * C3: a broker's own listing (a) that looks like a catalogue unit or model (b) of the agency: same compound, a
 * compatible type and the same bedrooms; for an exact unit, area and price within 5%; for a model, an area inside its
 * range (±5%) and a price from 5% under its "from" price up to 30% over. A soft note only, never a block.
 */
function catalogueMatch(a, b) {
  if (!comparable(a) || !sameCompound(a, b)) return false;
  if (a.property_type && b.property_type && a.property_type !== b.property_type) return false;
  if (b.bedrooms !== null && b.bedrooms !== undefined && (a.bedrooms ?? -1) !== b.bedrooms) return false;
  const area = Number(a.area_value);
  const price = Number(a.price_value);
  const from = Number(b.area_value);
  const to = Number(b.details?.area_to) || from;
  if (!(from > 0) || !(Number(b.price_value) > 0)) return false;
  if (b.inventory_type === "developer_model") {
    return area >= from * (1 - TOLERANCE) && area <= to * (1 + TOLERANCE) && price >= Number(b.price_value) * (1 - TOLERANCE) && price <= Number(b.price_value) * 1.3;
  }
  return near(area, from) && near(price, b.price_value);
}

module.exports = { TOLERANCE, placeKey, comparable, sameUnit, sameCompound, catalogueMatch };
