// domain/searchQuery.js — Search request → language-neutral filters (pure)
// Arabic, English or mixed wording, typed or spoken, must produce the same filters, so the same
// units come back in the same order. Places and features become keys; free text is normalized.
"use strict";

const Features = require("./features");
const Places = require("./places");
const { TYPE_TERMS } = require("./vocabulary");
const { normalizeSearch } = require("./searchText");
const { PROPERTY_TYPES } = require("./fieldRules");

const FINISHING_KEYS = ["core_and_shell", "semi_finished", "fully_finished", "super_lux", "ultra_super_lux"];
const SMALL_TALK = [
  "شكرا", "شكرا جزيلا", "تمام", "اوكي", "ok", "okay", "thanks", "thank you", "السلام عليكم", "سلام", "صباح الخير",
  "مساء الخير", "اهلا", "hi", "hello", "hey", "مرحبا", "تسلم", "ماشي", "حاضر", "👍"
].map(normalizeSearch);

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const nonNegInt = (v) => {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n) : null;
};
const uniq = (a) => [...new Set(a)];
const sortPlaces = (list) =>
  uniq(list.map((p) => `${p.kind}:${p.key}`))
    .sort()
    .map((s) => ({ kind: s.split(":")[0], key: s.split(":")[1] }));

function emptyFilters() {
  return {
    code: null,
    listing_type: null,
    property_types: [],
    market: null,
    places: [],
    place_terms: [],
    currency: null,
    price_min: null,
    price_max: null,
    area_min: null,
    area_max: null,
    bedrooms_min: null,
    bedrooms_max: null,
    bathrooms_min: null,
    floor_min: null,
    floor_max: null,
    finishing: [],
    furnishing: null,
    delivery_ready: null,
    delivery_by_year: null,
    payment_cash: null,
    payment_installments: null,
    max_down_payment: null,
    max_installment: null,
    features: [],
    feature_terms: []
  };
}

/** Normalized code: same folding as the listings.code_norm column. */
function normalizeCode(code) {
  const s = String(code ?? "")
    .replace(/[​-‍﻿‎‏‪-‮]/g, "")
    .replace(/^[`'"\[\(#\s_]+|[`'"\]\)#\s_]+$/g, "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .trim()
    .toUpperCase();
  return s || null;
}

/** Places and leftover place words from a list of names as the broker said them. */
function resolvePlaceNames(names = []) {
  const places = [];
  const terms = [];
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name) continue;
    for (const part of name.split(/[,/|،]|\s+(?:or|او|أو)\s+/i)) {
      const one = Places.resolvePlace(part);
      if (one) {
        places.push(one);
        continue;
      }
      const { places: found, rest } = Places.findPlaces(part);
      places.push(...found);
      const leftover = normalizeSearch(rest)
        .split(" ")
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .join(" ");
      if (!found.length && leftover) terms.push(leftover);
    }
  }
  return { places, terms };
}

/** Sorted, de-duplicated, canonical filters (order-independent equality across languages). */
function canonical(f) {
  const out = { ...emptyFilters(), ...f };
  out.property_types = uniq(out.property_types.filter((t) => PROPERTY_TYPES.includes(t))).sort();
  out.places = sortPlaces(out.places);
  out.place_terms = uniq(out.place_terms.map(normalizeSearch).filter(Boolean)).sort();
  out.features = Features.sortKeys(out.features);
  out.feature_terms = uniq(out.feature_terms.map(normalizeSearch).filter(Boolean)).sort();
  out.finishing = uniq(out.finishing.filter((k) => FINISHING_KEYS.includes(k))).sort();
  if (out.property_types.includes("studio") && out.bedrooms_min === null && out.bedrooms_max === null) {
    out.bedrooms_min = 0;
    out.bedrooms_max = 0;
  } else if (out.bedrooms_min === 0 && out.bedrooms_max === 0 && !out.property_types.length) {
    out.property_types = ["studio"];
  }
  for (const [lo, hi] of [["price_min", "price_max"], ["area_min", "area_max"], ["bedrooms_min", "bedrooms_max"], ["floor_min", "floor_max"]]) {
    if (out[lo] !== null && out[hi] !== null && out[lo] > out[hi]) [out[lo], out[hi]] = [out[hi], out[lo]];
  }
  return out;
}

/**
 * AI search JSON → { intent, transcript, language, filters }.
 * Accepts the Release 1 prompt shape and the earlier one (compound, features as words, ...).
 */
function normalizeAiSearch(raw) {
  const r = (Array.isArray(raw) ? raw[0] : raw) || {};
  const f = r.filters || {};
  const names = [f.compound, ...(Array.isArray(f.locations) ? f.locations : []), ...(Array.isArray(r.locations) ? r.locations : [])];
  let { places, terms } = resolvePlaceNames(names);
  // Earlier prompt shape: location_terms. They narrow only when no compound was named
  // (a named compound is the boundary; broad area words must not widen it).
  const legacyTerms = Array.isArray(r.location_terms) ? r.location_terms : [];
  if (legacyTerms.length && !places.some((p) => p.kind === "compound")) {
    const legacy = resolvePlaceNames(legacyTerms);
    places = [...places, ...legacy.places];
    if (!places.length) terms = [...terms, ...legacy.terms];
  }
  const featureWords = [...(Array.isArray(f.features) ? f.features : []), ...(Array.isArray(f.other_features) ? f.other_features : [])];
  const { keys, other } = Features.classifyFeatures(featureWords);
  const legacyFlags = Features.keysFromDetails({ has_nanny_room: f.nanny_room, has_master_bedroom: f.has_master_bedroom, has_dressing_room: f.has_dressing_room });
  const delivery = f.delivery || {};
  const payment = f.payment || {};

  const types = (Array.isArray(f.property_types) ? f.property_types : [])
    .map((t) => String(t).toLowerCase().replace(/[\s_-]/g, ""))
    .map((t) => (t === "standalone" ? "villa" : t));

  const filters = canonical({
    code: f.code ? normalizeCode(f.code) : null,
    listing_type: ["sale", "rent"].includes(f.listing_type) ? f.listing_type : null,
    property_types: types,
    market: ["primary", "resale"].includes(f.market) ? f.market : null,
    places,
    place_terms: terms,
    currency: ["EGP", "USD", "EUR"].includes(f.currency) ? f.currency : null,
    price_min: pos(f.price_min),
    price_max: pos(f.price_max),
    area_min: pos(f.area_min),
    area_max: pos(f.area_max),
    bedrooms_min: nonNegInt(f.bedrooms_min),
    bedrooms_max: nonNegInt(f.bedrooms_max),
    bathrooms_min: nonNegInt(f.bathrooms_min),
    floor_min: num(f.floor_min) !== null ? Math.round(num(f.floor_min)) : null,
    floor_max: num(f.floor_max) !== null ? Math.round(num(f.floor_max)) : null,
    finishing: (Array.isArray(f.finishing) ? f.finishing : f.finishing ? [f.finishing] : []).map((x) => String(x).toLowerCase()),
    furnishing: ["furnished", "semi_furnished", "unfurnished"].includes(f.furnishing) ? f.furnishing : null,
    delivery_ready: delivery.ready === true ? true : null,
    delivery_by_year: num(delivery.by_year) && num(delivery.by_year) >= 2000 ? Math.round(num(delivery.by_year)) : null,
    payment_cash: payment.cash === true ? true : null,
    payment_installments: payment.installments === true ? true : null,
    max_down_payment: pos(payment.max_down_payment ?? f.down_payment_max),
    max_installment: pos(payment.max_installment ?? f.installment_max),
    features: [...keys, ...legacyFlags],
    feature_terms: other
  });

  return {
    intent: ["search", "listing", "other"].includes(r.intent) ? r.intent : "search",
    transcript: String(r.transcript ?? "").slice(0, 500),
    language: r.language === "en" ? "en" : "ar",
    filters
  };
}

/* ---------------------------------------------------------------------- */
/* Regex fallback (AI down): same output shape                              */
/* ---------------------------------------------------------------------- */

const STOP = new Set(
  [
    "في", "فى", "من", "الى", "إلى", "علي", "على", "عن", "و", "مع", "عايز", "عاوز", "عايزه", "محتاج", "دورلي", "ورني", "وريني",
    "فيه", "فيها", "عندنا", "عندك", "عندي", "بحث", "ابحث", "لي", "لو", "سمحت", "بس", "حاجة", "حاجه", "وحدة", "وحده", "كمبوند",
    "the", "a", "an", "in", "for", "at", "with", "show", "me", "find", "search", "i", "want", "need", "looking", "unit", "units",
    "compound", "please", "any", "some", "and", "or", "of", "to", "is", "near", "around", "قريب", "جنب"
  ].map(normalizeSearch)
);

const TYPE_MATCHERS = Object.entries(TYPE_TERMS)
  .flatMap(([type, words]) => words.map((w) => ({ type, term: normalizeSearch(w) })))
  .sort((a, b) => b.term.length - a.term.length);

const AR_NUMBER_WORDS = {
  واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, تلات: 3, تلت: 3, تلاته: 3, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5,
  ست: 6, سته: 6, ستة: 6, سبع: 7, سبعه: 7, سبعة: 7, تمن: 8, تمنيه: 8, تمنية: 8, خمسة: 5, اربعة: 4, تلتة: 3, تمانيه: 8, تمانية: 8, تسع: 9, تسعه: 9, تسعة: 9, عشر: 10, عشره: 10, عشرة: 10
};

function consume(hay, re) {
  const m = hay.match(re);
  return m ? { m, hay: hay.replace(re, " ") } : { m: null, hay };
}

/** A number written as digits or as an Egyptian word ("خمسة", "تمنية"): the number, or null when it is neither. */
function spokenAmount(word) {
  if (/^\d+(\.\d+)?$/.test(word)) return Number(word);
  return Object.prototype.hasOwnProperty.call(AR_NUMBER_WORDS, word) ? AR_NUMBER_WORDS[word] : null;
}

function parseMoneyWords(n, unit) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (/مليون|million|^(m|م)$/i.test(unit)) return Math.round(v * 1e6);
  if (/الف|ألف|k|thousand/i.test(unit)) return Math.round(v * 1e3);
  return v >= 1000 ? Math.round(v) : null;
}

/** Optimal string alignment distance: insert, delete, replace, or swap two neighbouring letters (one edit each). */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const SINGLE_TYPE_TERMS = TYPE_MATCHERS.filter((m) => !m.term.includes(" "));

/**
 * Typos in a property word ("vilal", "appartment", "شقه" with a stray letter): one edit for a short word, two for a word
 * of five letters or more, and only when a single type fits. Words with digits, stop words and words under 4 letters are
 * left alone so ordinary words do not turn into a type.
 */
function fuzzyTypes(hay, found) {
  let out = hay;
  for (const w of hay.trim().split(/\s+/)) {
    if (!w || /\d/.test(w) || w.length < 4 || STOP.has(w)) continue;
    const limit = w.length >= 5 ? 2 : 1;
    let best = null;
    let tie = false;
    for (const m of SINGLE_TYPE_TERMS) {
      if (Math.abs(m.term.length - w.length) > limit) continue;
      const dist = editDistance(w, m.term);
      if (dist > limit) continue;
      if (!best || dist < best.dist) {
        best = { dist, type: m.type };
        tie = false;
      } else if (dist === best.dist && m.type !== best.type) tie = true;
    }
    if (best && !tie) {
      found.push(best.type);
      out = out.split(` ${w} `).join(" ");
    }
  }
  return out;
}

/** Local parser used when the AI is unavailable. Deterministic and bilingual. */
function fallbackParse(text) {
  const raw = String(text || "").trim();
  let hay = ` ${normalizeSearch(raw)} `;
  const f = emptyFilters();

  if (SMALL_TALK.includes(hay.trim())) {
    return { intent: "other", transcript: raw.slice(0, 500), language: /[a-z]/i.test(raw) && !/[؀-ۿ]/.test(raw) ? "en" : "ar", filters: canonical(f) };
  }

  // A unit code written like NH-V12 (initials, a hyphen, an optional letter, a number).
  let c = consume(hay, / ([a-z]{1,6}-[a-z]{0,2}\d{1,5}) /);
  if (c.m) {
    f.code = normalizeCode(c.m[1]);
    hay = c.hay;
  }

  hay = hay.replace(/(\d)([a-zء-ي])/g, "$1 $2");

  // Places first (they can contain type-like words, e.g. "town").
  const placeScan = Places.findPlaces(hay);
  f.places = placeScan.places;
  hay = ` ${placeScan.rest} `;

  // Features (dictionary only).
  f.features = Features.matchFeatureKeys(hay);
  for (const key of f.features) {
    const terms = Features.FEATURES.find((x) => x.key === key).syn.map(normalizeSearch).sort((a, b) => b.length - a.length);
    for (const t of terms) hay = hay.split(` ${t} `).join(" ").split(` و${t} `).join(" ");
  }

  // Listing type.
  c = consume(hay, / (للايجار|ايجار|rent|for rent|lease) /);
  if (c.m) f.listing_type = "rent";
  hay = c.hay;
  c = consume(hay, / (للبيع|بيع|for sale|sale) /);
  if (c.m && !f.listing_type) f.listing_type = "sale";
  hay = c.hay;
  if (/ (ريسيل|resale) /.test(hay)) f.market = "resale";
  if (/ (برايمري|primary|من المطور|developer) /.test(hay)) f.market = "primary";
  hay = hay.replace(/ (ريسيل|resale|برايمري|primary|من المطور) /g, " ");

  // Bedrooms / bathrooms (digits or Egyptian number words).
  const n = (s) => (/^\d+$/.test(s) ? Number(s) : AR_NUMBER_WORDS[s] ?? null);
  c = consume(hay, / و?(غرفتين|اوضتين) /);
  if (c.m) f.bedrooms_min = f.bedrooms_max = 2;
  hay = c.hay;
  c = consume(hay, / (\d+|[ء-ي]+) (غرف|غرفه|اوض|اوضه|نوم|bed|beds|bedroom|bedrooms|room|rooms|br) /);
  if (c.m && n(c.m[1]) !== null) {
    f.bedrooms_min = f.bedrooms_max = n(c.m[1]);
    hay = c.hay;
  }
  c = consume(hay, / (حمامين) /);
  if (c.m) f.bathrooms_min = 2;
  hay = c.hay;
  c = consume(hay, / (\d+) (حمام|حمامات|bath|baths|bathroom|bathrooms) /);
  if (c.m) {
    f.bathrooms_min = Number(c.m[1]);
    hay = c.hay;
  }

  // Money: ranges, "above", down payment and monthly installment come before the plain budget ceiling.
  const MONEY = "(\\d+(?:\\.\\d+)?) (مليون|million|m|الف|k|thousand)";
  const money = (num, unit) => parseMoneyWords(String(num), unit);
  c = consume(hay, new RegExp(` (?:من |from )?(\\d+(?:\\.\\d+)?)(?: (مليون|million|m|الف|k|thousand))? (?:ل|الي|to|-) ${MONEY} `));
  if (c.m) {
    const hi = money(c.m[3], c.m[4]);
    const lo = money(c.m[1], c.m[2] || c.m[4]);
    if (lo && hi && lo <= hi) {
      f.price_min = lo;
      f.price_max = hi;
      hay = c.hay;
    }
  }
  c = consume(hay, new RegExp(` (?:مقدم|دفعه اولي|دفعه مقدمه|down payment|downpayment) (?:حدود |تحت |اقل من |under |max )?${MONEY} `));
  if (c.m) {
    f.max_down_payment = money(c.m[1], c.m[2]);
    hay = c.hay;
  }
  c = consume(hay, new RegExp(` و?(?:قسط شهري|قسط|monthly installment|installment) (?:حدود |تحت |اقل من |under |max )?${MONEY} `));
  if (c.m) {
    f.max_installment = money(c.m[1], c.m[2]);
    f.payment_installments = true;
    hay = c.hay;
  }
  // "مش عايز أكتر من 9 مليون" is a ceiling, not a floor.
  c = consume(hay, new RegExp(` مش (?:عايز )?(?:اكتر|اكثر) من ${MONEY} `));
  if (c.m) {
    const v = money(c.m[1], c.m[2]);
    if (v) f.price_max = v;
    hay = c.hay;
  }
  c = consume(hay, new RegExp(` (?:فوق|اكتر من|اكثر من|above|over|more than|min) ${MONEY} `));
  if (c.m) {
    const v = money(c.m[1], c.m[2]);
    if (v) f.price_min = v;
    hay = c.hay;
  }

  // A budget with the short "م" ("تحت 9م"): read before the area rule, so it is not square metres.
  c = consume(hay, / (?:تحت|اقل من|حدود|بحدود|لحد|مش (?:عايز )?(?:اكتر|اكثر) من|under|below|max|up to) (\d+(?:\.\d+)?|[ء-ي]+) (م|m) /);
  if (c.m) {
    const v = spokenAmount(c.m[1]);
    if (v !== null) f.price_max = parseMoneyWords(String(v), "م");
    hay = c.hay;
  }

  // Area: "150 متر" / "150 m2" / "150 sqm" is a band of +-10%; "من 120 ل 150 متر" is the exact range.
  c = consume(hay, / (?:من |from )?(\d{2,4}) (?:ل|الي|to|-) (\d{2,4}) (متر|م|m2|m|sqm|meter|meters) /);
  if (c.m) {
    f.area_min = Number(c.m[1]);
    f.area_max = Number(c.m[2]);
    hay = c.hay;
  } else {
    c = consume(hay, / (\d{2,4}) (متر|م|m2|m|sqm|meter|meters) /);
    if (c.m) {
      const a = Number(c.m[1]);
      f.area_min = Math.round(a * 0.9);
      f.area_max = Math.round(a * 1.1);
      hay = c.hay;
    }
  }

  // Budget: "تحت 8 مليون" / "under 8 million" / "8 مليون" (a ceiling).
  c = consume(hay, / (?:تحت|اقل من|حدود|بحدود|لحد|مش (?:عايز )?(?:اكتر|اكثر) من|under|below|max|up to|budget)? ?(\d+(?:\.\d+)?|\d+ \d+|[ء-ي]+) (مليون|million|m|الف|k|thousand)( ونص)? /);
  if (c.m) {
    const n = spokenAmount(c.m[1].replace(" ", "."));
    const v = n === null ? null : parseMoneyWords(String(n), c.m[2]);
    const half = c.m[3] && v ? parseMoneyWords("0.5", c.m[2]) : 0;
    if (v && f.price_max === null) f.price_max = v + half;
    if (n !== null) hay = c.hay;
  }

  // Finishing, furnishing and floor.
  const FIN = [
    [/ (?:الترا سوبر لوكس|ultra super lux|الترا لوكس|ultra lux) /, "ultra_super_lux"],
    [/ (?:سوبر لوكس|super lux) /, "super_lux"],
    [/ (?:نص تشطيب|نصف تشطيب|semi finished|semi-finished) /, "semi_finished"],
    [/ (?:علي الطوب|على الطوب|محاره|بدون تشطيب|core and shell|core & shell|shell) /, "core_and_shell"],
    [/ (?:تشطيب كامل|متشطبه|فينيش|fully finished|finished) /, "fully_finished"]
  ];
  for (const [re, key] of FIN) {
    c = consume(hay, re);
    if (c.m) {
      f.finishing.push(key);
      hay = c.hay.replace(/ تشطيب /g, " ");
      break;
    }
  }
  c = consume(hay, / (?:غير مفروشه|فاضيه|unfurnished) /);
  if (c.m) f.furnishing = "unfurnished";
  else {
    c = consume(hay, / (?:نص فرش|نصف فرش|semi furnished|semi-furnished) /);
    if (c.m) f.furnishing = "semi_furnished";
    else {
      c = consume(hay, / (?:مفروشه|مفروش|فرش كامل|fully furnished|furnished) /);
      if (c.m) f.furnishing = "furnished";
    }
  }
  hay = c.hay;
  if (!f.furnishing && f.features.includes("furnished")) f.furnishing = "furnished";
  const ORD = { الاول: 1, الاولي: 1, التاني: 2, الثاني: 2, التالت: 3, الثالث: 3, الرابع: 4, الخامس: 5, السادس: 6, السابع: 7, الثامن: 8, التاسع: 9, العاشر: 10 };
  c = consume(hay, / (?:ب|بال)?(?:الدور|دور|floor) (\d{1,2}|[ء-ي]+) /);
  if (c.m) {
    const fl = /^\d+$/.test(c.m[1]) ? Number(c.m[1]) : ORD[c.m[1]] ?? null;
    if (fl !== null) {
      f.floor_min = f.floor_max = fl;
      hay = c.hay;
    }
  }
  c = consume(hay, / (?:ب|بال)?(?:الدور الارضي|دور ارضي|ground floor) /);
  if (c.m) {
    f.floor_min = f.floor_max = 0;
    hay = c.hay;
  }

  // Delivery.
  c = consume(hay, / (استلام فوري|فوري|جاهز|ready to move|ready|immediate) /);
  if (c.m) f.delivery_ready = true;
  hay = c.hay;
  c = consume(hay, / (?:تسليم|استلام|delivery|by) (20[2-4]\d) /);
  if (c.m) {
    f.delivery_by_year = Number(c.m[1]);
    hay = c.hay;
  }

  // Payment.
  c = consume(hay, / (كاش|cash) /);
  if (c.m) f.payment_cash = true;
  hay = c.hay;
  c = consume(hay, / (?:ب|بال)?(تقسيط|اقساط|قسط|installments|installment) /);
  if (c.m) f.payment_installments = true;
  hay = c.hay;

  // Property types.
  for (const m of TYPE_MATCHERS) {
    if (hay.includes(` ${m.term} `)) {
      f.property_types.push(m.type);
      hay = hay.split(` ${m.term} `).join(" ");
    }
  }
  hay = fuzzyTypes(hay, f.property_types);

  // Leftover words: unresolved places (≥3 letters, not stop words, not numbers).
  const leftovers = hay
    .split(" ")
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  if (!f.places.length && leftovers.length) f.place_terms = [leftovers.join(" ")];

  const filters = canonical(f);
  return {
    intent: hasAnyFilter({ filters }) ? "search" : "other",
    transcript: raw.slice(0, 500),
    language: /[؀-ۿ]/.test(raw) ? "ar" : "en",
    filters
  };
}

/** True when the request names at least one real filter. */
function hasAnyFilter(parsed) {
  const f = parsed?.filters || {};
  return Boolean(
    f.code ||
      f.listing_type ||
      f.market ||
      (f.property_types || []).length ||
      (f.places || []).length ||
      (f.place_terms || []).length ||
      (f.features || []).length ||
      (f.feature_terms || []).length ||
      (f.finishing || []).length ||
      f.furnishing ||
      [f.price_min, f.price_max, f.area_min, f.area_max, f.bedrooms_min, f.bedrooms_max, f.bathrooms_min, f.floor_min, f.floor_max,
        f.max_down_payment, f.max_installment, f.delivery_by_year].some((v) => v !== null && v !== undefined) ||
      f.delivery_ready ||
      f.payment_cash ||
      f.payment_installments
  );
}

/**
 * Intent guard (B2): only a search with at least one filter reaches the database.
 * @returns {"search" | "small_talk" | "listing"}
 */
function classifyIntent(parsed) {
  if (parsed?.intent === "listing") return "listing";
  if (parsed?.intent === "other" || !hasAnyFilter(parsed)) return "small_talk";
  return "search";
}

/** Earlier callers pass { filters: { compound: "..." } }; give them canonical filters. */
function ensureFilters(parsed) {
  const f = parsed?.filters || {};
  if (Array.isArray(f.places) && Array.isArray(f.feature_terms)) return f;
  return normalizeAiSearch({ filters: f, locations: parsed?.locations || [] }).filters;
}

// Haytham (2026-11-01): a budget is a price ceiling. A monthly installment cap is kept only when the
// message itself says installment (EN) or قسط / أقساط / تقسيط (AR). The AI reading can drop that word;
// without it the number moves to the price ceiling (when no price was given).
const INSTALLMENT_WORD = /installment|instalment|قسط|اقساط|تقسيط/;
function enforceInstallmentWords(parsed, text) {
  const said = INSTALLMENT_WORD.test(normalizeSearch(String(text || "")));
  const f = parsed?.filters;
  if (!f || said) return parsed;
  if (f.max_installment !== null && f.max_installment !== undefined) {
    if (f.price_max === null || f.price_max === undefined) f.price_max = f.max_installment;
    f.max_installment = null;
  }
  f.payment_installments = null;
  return parsed;
}

module.exports = {
  enforceInstallmentWords,
  emptyFilters,
  normalizeCode,
  normalizeAiSearch,
  fallbackParse,
  hasAnyFilter,
  classifyIntent,
  ensureFilters,
  canonical
};
