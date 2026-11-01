// domain/features.js — Fixed bilingual dictionary of unit extras and features (pure)
// One list feeds descriptions, search filters and the search text. Unknown extras stay free text
// in features_other; nothing is invented.
"use strict";

const { normalizeSearch } = require("./searchText");

/**
 * key: stable id stored in listings.feature_keys
 * ar / en: display labels
 * syn: lower-case match terms (Arabic and English, normalized by normalizeForMatch)
 * group: orientation | layout | outdoor | view | equipment | building
 */
const FEATURES = [
  { key: "north_facing", ar: "بحري", en: "North facing", group: "orientation", syn: ["بحري", "بحرى", "north facing", "north", "واجهة بحري"] },
  { key: "south_facing", ar: "قبلي", en: "South facing", group: "orientation", syn: ["قبلي", "قبلى", "south facing", "south"] },
  { key: "east_facing", ar: "شرقي", en: "East facing", group: "orientation", syn: ["شرقي", "شرقى", "east facing"] },
  { key: "west_facing", ar: "غربي", en: "West facing", group: "orientation", syn: ["غربي", "غربى", "west facing"] },
  { key: "corner", ar: "ناصية", en: "Corner unit", group: "orientation", syn: ["ناصيه", "ناصية", "على ناصية", "كورنر", "corner"] },

  { key: "master_bedroom", ar: "غرفة ماستر", en: "Master bedroom", group: "layout", syn: ["ماستر", "master", "master bedroom", "غرفه ماستر", "غرفة ماستر"] },
  { key: "dressing_room", ar: "دريسنج", en: "Dressing room", group: "layout", syn: ["دريسنج", "دريسينج", "dressing", "dressing room", "غرفة ملابس"] },
  { key: "nanny_room", ar: "غرفة مربية", en: "Nanny room", group: "layout", syn: ["غرفه مربيه", "غرفة مربية", "مربيه", "مربية", "ناني", "غرفة ناني", "nanny", "nanny room", "maid room", "maid's room", "غرفة خادمة"] },
  { key: "driver_room", ar: "غرفة سائق", en: "Driver room", group: "layout", syn: ["غرفة سائق", "غرفه سواق", "غرفة سواق", "سواق", "driver room"] },
  { key: "laundry_room", ar: "غرفة غسيل", en: "Laundry room", group: "layout", syn: ["غرفة غسيل", "غرفه غسيل", "laundry", "laundry room"] },
  { key: "storage_room", ar: "مخزن", en: "Storage room", group: "layout", syn: ["مخزن", "غرفة تخزين", "storage", "storage room"] },
  { key: "basement", ar: "بدروم", en: "Basement", group: "layout", syn: ["بدروم", "بيزمنت", "basement"] },
  { key: "duplex_layout", ar: "دورين", en: "Two levels", group: "layout", syn: ["دورين", "two levels", "two floors"] },

  { key: "roof", ar: "روف", en: "Roof", group: "outdoor", syn: ["روف", "سطح", "roof", "rooftop", "roof terrace"] },
  { key: "private_garden", ar: "جنينة خاصة", en: "Private garden", group: "outdoor", syn: ["جنينه", "جنينة", "حديقه خاصه", "حديقة خاصة", "حديقه", "حديقة", "جاردن", "private garden", "garden"] },
  { key: "terrace", ar: "تراس", en: "Terrace", group: "outdoor", syn: ["تراس", "terrace", "بلكونه كبيره"] },
  { key: "balcony", ar: "بلكونة", en: "Balcony", group: "outdoor", syn: ["بلكونه", "بلكونة", "balcony"] },
  { key: "private_pool", ar: "حمام سباحة خاص", en: "Private pool", group: "outdoor", syn: ["حمام سباحه خاص", "حمام سباحة خاص", "private pool", "بيسين خاص"] },

  { key: "view_garden", ar: "فيو جاردن", en: "Garden view", group: "view", syn: ["فيو جاردن", "فيو حديقه", "فيو حديقة", "على الجاردن", "garden view"] },
  { key: "view_pool", ar: "فيو بول", en: "Pool view", group: "view", syn: ["فيو بول", "فيو حمام السباحه", "pool view"] },
  { key: "view_lagoon", ar: "فيو لاجون", en: "Lagoon view", group: "view", syn: ["فيو لاجون", "لاجون", "lagoon", "lagoon view", "فيو بحيره", "فيو بحيرة", "lake view"] },
  { key: "view_landscape", ar: "فيو لاندسكيب", en: "Landscape view", group: "view", syn: ["فيو لاند سكيب", "فيو لاندسكيب", "لاندسكيب", "لاند سكيب", "علي لاند سكيب", "landscape", "landscape view"] },
  { key: "view_club", ar: "فيو النادي", en: "Club view", group: "view", syn: ["فيو النادي", "فيو الكلوب", "club view"] },
  { key: "view_sea", ar: "فيو بحر", en: "Sea view", group: "view", syn: ["فيو بحر", "فيو البحر", "sea view"] },
  { key: "view_open", ar: "فيو مفتوح", en: "Open view", group: "view", syn: ["فيو مفتوح", "فيو مفتوحه", "اوبن فيو", "open view", "panoramic view"] },
  { key: "view_street", ar: "على الشارع", en: "Street view", group: "view", syn: ["على الشارع", "فيو شارع", "street view"] },

  { key: "furnished", ar: "مفروشة", en: "Furnished", group: "equipment", syn: ["مفروشه", "مفروشة", "مفروش", "furnished", "fully furnished"] },
  { key: "kitchen_installed", ar: "مطبخ مركب", en: "Fitted kitchen", group: "equipment", syn: ["مطبخ مركب", "بالمطبخ", "fitted kitchen", "kitchen installed"] },
  { key: "appliances", ar: "بالأجهزة", en: "With appliances", group: "equipment", syn: ["بالاجهزه", "بالأجهزة", "بالاجهزة", "اجهزه كهربائيه", "appliances", "with appliances"] },
  { key: "ac_installed", ar: "تكييفات", en: "ACs installed", group: "equipment", syn: ["تكييفات", "مكيفات", "بالتكييفات", "تكييف", "ac", "acs", "air conditioning"] },
  { key: "smart_home", ar: "سمارت هوم", en: "Smart home", group: "equipment", syn: ["سمارت هوم", "smart home"] },
  { key: "natural_gas", ar: "عداد غاز", en: "Natural gas", group: "equipment", syn: ["غاز طبيعي", "عداد غاز", "natural gas"] },

  { key: "elevator", ar: "أسانسير", en: "Elevator", group: "building", syn: ["اسانسير", "أسانسير", "مصعد", "elevator", "lift"] },
  { key: "parking", ar: "جراج", en: "Parking", group: "building", syn: ["جراج", "باركينج", "موقف سيارات", "parking", "garage"] },
  { key: "club_membership", ar: "عضوية النادي", en: "Club membership", group: "building", syn: ["عضويه النادي", "عضوية النادي", "كارنيه النادي", "club membership", "club"] },
  { key: "security", ar: "أمن 24 ساعة", en: "24/7 security", group: "building", syn: ["امن", "أمن", "حراسه", "حراسة", "security", "24/7 security"] }
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Matching uses the one search normalizer (domain/searchText.js). */
const normalizeForMatch = normalizeSearch;

// Longest synonyms first so "حمام سباحة خاص" wins over shorter overlaps.
const MATCHERS = FEATURES.flatMap((f) => f.syn.map((s) => ({ key: f.key, term: normalizeForMatch(s) })))
  .filter((m) => m.term)
  .sort((a, b) => b.term.length - a.term.length);

const isKey = (k) => BY_KEY.has(k);

/** Display label for a key, or null for an unknown key. */
function featureLabel(key, lang = "ar") {
  const f = BY_KEY.get(key);
  if (!f) return null;
  return lang === "en" ? f.en : f.ar;
}

/**
 * Finds dictionary features inside free text. Whole-word matches only.
 * Returns keys in dictionary order.
 */
function matchFeatureKeys(text) {
  let hay = ` ${normalizeForMatch(text)} `;
  const found = new Set();
  for (const m of MATCHERS) {
    // Arabic attaches "و" (and) to the next word: "وفيو جاردن".
    for (const needle of [` ${m.term} `, ` و${m.term} `]) {
      if (hay.includes(needle)) {
        found.add(m.key);
        hay = hay.split(needle).join(" ");
      }
    }
  }
  return sortKeys([...found]);
}

/** Dictionary order (the order descriptions and tags show features in). */
function sortKeys(keys) {
  const order = new Map(FEATURES.map((f, i) => [f.key, i]));
  return [...new Set(keys.filter(isKey))].sort((a, b) => order.get(a) - order.get(b));
}

/**
 * Splits a mixed list (keys, Arabic or English labels, free text) into dictionary keys and
 * leftover free-text extras. An entry is a known feature only if it matches as a whole.
 */
function classifyFeatures(list = []) {
  const keys = [];
  const other = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const item = String(raw ?? "").trim();
    if (!item) continue;
    if (isKey(item)) {
      keys.push(item);
      continue;
    }
    const norm = normalizeForMatch(item);
    const exact = MATCHERS.find((m) => m.term === norm);
    if (exact) keys.push(exact.key);
    else if (!other.some((o) => normalizeForMatch(o) === norm)) other.push(item.slice(0, 60));
  }
  return { keys: sortKeys(keys), other };
}

/** Feature keys implied by structured AI/legacy detail fields. */
function keysFromDetails(details = {}) {
  const d = details || {};
  const keys = [];
  const yes = (v) => v === true || v === "true";
  if (yes(d.has_nanny_room) || yes(d.nanny_room)) keys.push("nanny_room");
  if (yes(d.has_driver_room)) keys.push("driver_room");
  if (yes(d.has_master_bedroom) || Number(d.master_bedrooms) > 0) keys.push("master_bedroom");
  if (yes(d.has_dressing_room)) keys.push("dressing_room");
  if (yes(d.is_corner)) keys.push("corner");
  if (Number(d.roof_area) > 0) keys.push("roof");
  if (Number(d.garden_area) > 0) keys.push("private_garden");
  keys.push(...matchFeatureKeys(`${d.orientation || ""} ${d.orientation_en || ""} ${d.view || ""}`));
  return sortKeys(keys);
}

/** Bilingual words for the search text of a set of keys (both labels and all synonyms). */
function searchTermsFor(keys = []) {
  const out = [];
  for (const k of keys) {
    const f = BY_KEY.get(k);
    if (f) out.push(f.ar, f.en, ...f.syn);
  }
  return [...new Set(out.map((t) => t.toLowerCase()))];
}

module.exports = {
  FEATURES,
  normalizeForMatch,
  featureLabel,
  matchFeatureKeys,
  classifyFeatures,
  keysFromDetails,
  searchTermsFor,
  sortKeys,
  isFeatureKey: isKey
};
