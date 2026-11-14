// domain/searchQuery.js — Search request → language-neutral filters (pure)
// Arabic, English or mixed wording, typed or spoken, must produce the same filters, so the same
// units come back in the same order. Places and features become keys; free text is normalized.
"use strict";

const Fx = require("./fx");

const Features = require("./features");
const Places = require("./places");
const { TYPE_TERMS } = require("./vocabulary");
const { normalizeSearch, foldLetters } = require("./searchText");
const { mapFurnishing, mapFinishing } = require("./furnishingStatus");
const { PROPERTY_TYPES } = require("./fieldRules");

const FINISHING_KEYS = ["core_and_shell", "semi_finished", "fully_finished", "super_lux", "ultra_super_lux"];
// Furnishing status values. "kitchen_and_ac" / "ac_only" / "kitchen_only" are states of the same field (Haytham 2026-11-04).
const FURNISHING_VALUES = ["furnished", "semi_furnished", "unfurnished", "kitchen_and_ac", "ac_only", "kitchen_only"];
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
/** Down payment as a percent of the price (a plan's down_payment_pct): 0 to 100, else null. */
const downPct = (v) => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};
/**
 * One number is a minimum (3 bedrooms = 3 or more), and one budget is a ceiling. The AI sometimes returns the same
 * number as both ends; a real range has two different ends, so an equal pair is collapsed here.
 */
const singleCountMax = (lo, hi) => (lo !== null && hi !== null && lo === hi ? null : hi);
const singleBudgetFloor = (lo, hi) => (lo !== null && hi !== null && lo === hi ? null : lo);
/** Years of a payment plan: a whole number from 1 to 30, else null. */
const planYears = (v) => {
  const n = num(v);
  return n !== null && Number.isInteger(Math.round(n)) && Math.round(n) >= 1 && Math.round(n) <= 30 ? Math.round(n) : null;
};
const sortPlaces = (list) =>
  uniq(list.map((p) => `${p.kind}:${p.key}`))
    .sort()
    .map((s) => ({ kind: s.split(":")[0], key: s.split(":")[1] }));

function emptyFilters() {
  return {
    code: null,
    listing_type: null,
    property_types: [],
    property_type_order: [],
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
    payment_years: null,
    payment_down_pct: null,
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
      if (!found.length && leftover) {
        // A name the AI wrote with a slightly different spelling ("Mivda"): snapped to the known place when one fits.
        const close = Places.closePlaces(leftover.split(" "));
        if (close.matched.length && !close.ambiguous.length && close.used.size === leftover.split(" ").length) places.push(...close.matched.map((m) => ({ kind: m.kind, key: m.key })));
        else terms.push(leftover);
      }
    }
  }
  return { places, terms };
}

// Words that name a kind of place, not a place: "compound mivida" must search for Mivida only, since the word would match
// every unit whose text says compound.
const GENERIC_PLACE_WORDS = new Set(["compound", "compounds", "كمبوند", "كمبوندات", "كومبوند", "project", "projects", "مشروع", "مشاريع", "any", "اي", "أي", "اى", "ايه"].map(normalizeSearch));
function dropGenericPlaceWords(term) {
  return normalizeSearch(term).split(" ").filter((w) => w && !GENERIC_PLACE_WORDS.has(w)).join(" ");
}

/** Sorted, de-duplicated, canonical filters (order-independent equality across languages). */
function canonical(f) {
  const out = { ...emptyFilters(), ...f };
  out.property_types = uniq(out.property_types.filter((t) => PROPERTY_TYPES.includes(t))).sort();
  out.places = sortPlaces(out.places);
  out.place_terms = uniq(out.place_terms.map(dropGenericPlaceWords).filter(Boolean)).sort();
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
/**
 * Type families: a search for one kind returns the whole family, the searched kind first, then the rest in this order.
 * A villa search returns villa, twin villa, i villa, townhouse, maisonette. Triplex with roof is searched first for a
 * triplex roof search, and plain triplex follows. Plain triplex is not widened (not decided yet).
 */
const TYPE_FAMILIES = [
  { members: ["villa", "twin_villa", "i_villa", "townhouse", "maisonette"], from: ["villa", "twin_villa", "i_villa", "townhouse", "maisonette"] },
  { members: ["triplex", "triplex_roof"], from: ["triplex", "triplex_roof"] },
];

/** The unit types a search asks for, and the order to show them in. A standalone search (exact) is not widened. */
function typeScope(list, exact) {
  const names = list.map((t) => String(t).toLowerCase().replace(/[\s-]/g, "")).map((t) => (t === "standalone" ? "villa" : t));
  if (exact || !names.length) return { types: [...new Set(names)], order: [...new Set(names)] };
  const types = new Set(names);
  let order = [...new Set(names)];
  for (const fam of TYPE_FAMILIES) {
    const head = names.find((t) => fam.from.includes(t));
    if (!head) continue;
    fam.members.forEach((t) => types.add(t));
    order = [head, ...fam.members.filter((t) => t !== head), ...order.filter((t) => !fam.members.includes(t))];
    break;
  }
  return { types: [...types], order };
}

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

  // A villa search returns every villa kind: standalone, i villa and twin villa (townhouse is separate).
  const { types, order } = typeScope(Array.isArray(f.property_types) ? f.property_types : [], f.type_exact === true);

  const filters = canonical({
    code: f.code ? normalizeCode(f.code) : null,
    listing_type: ["sale", "rent"].includes(f.listing_type) ? f.listing_type : null,
    property_types: types,
    property_type_order: order,
    market: ["primary", "resale"].includes(f.market) ? f.market : null,
    places,
    place_terms: terms,
    currency: ["EGP", "USD", "EUR"].includes(f.currency) ? f.currency : null,
    price_min: singleBudgetFloor(pos(f.price_min), pos(f.price_max)),
    price_max: pos(f.price_max),
    area_min: pos(f.area_min),
    area_max: singleCountMax(pos(f.area_min), pos(f.area_max)),
    bedrooms_min: nonNegInt(f.bedrooms_min),
    bedrooms_max: singleCountMax(nonNegInt(f.bedrooms_min), nonNegInt(f.bedrooms_max)),
    bathrooms_min: nonNegInt(f.bathrooms_min),
    floor_min: num(f.floor_min) !== null ? Math.round(num(f.floor_min)) : null,
    floor_max: num(f.floor_max) !== null ? Math.round(num(f.floor_max)) : null,
    finishing: (Array.isArray(f.finishing) ? f.finishing : f.finishing ? [f.finishing] : []).map((x) => mapFinishing(x)).filter(Boolean),
    furnishing: mapFurnishing(f.furnishing),
    delivery_ready: delivery.ready === true ? true : delivery.off_plan === true ? false : null,
    delivery_by_year: num(delivery.by_year) && num(delivery.by_year) >= 2000 ? Math.round(num(delivery.by_year)) : null,
    payment_cash: payment.cash === true ? true : null,
    payment_installments: payment.installments === true ? true : null,
    payment_years: planYears(payment.years ?? f.payment_years),
    payment_down_pct: downPct(payment.down_pct),
    max_down_payment: pos(payment.max_down_payment ?? f.down_payment_max),
    max_installment: pos(payment.max_installment ?? f.installment_max),
    features: [...keys, ...legacyFlags],
    feature_terms: other
  });

  // AC and kitchen are a furnishing status (the same reading the quick reader makes): both, AC alone or kitchen alone ("with AC").
  if (!filters.furnishing) {
    const k = filters.features.includes("kitchen_installed");
    const a = filters.features.includes("ac_installed");
    if (k || a) {
      filters.features = filters.features.filter((x) => x !== "kitchen_installed" && x !== "ac_installed");
      filters.furnishing = k && a ? "kitchen_and_ac" : a ? "ac_only" : "kitchen_only";
    }
  }
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
    "سنين", "سنه", "سنة", "سنوات", "سنتين", "years", "year", "yrs", "مقدم", "دفعه", "اولي", "down", "payment", "تكملة", "تكمله",
    "حتي", "لحد", "اقل", "تحت", "حدود", "بحدود", "فوق", "اكتر", "اكثر", "up", "under", "budget", "متكرر", "متكرره", "typical",
    "the", "a", "an", "in", "for", "at", "with", "show", "me", "find", "search", "i", "want", "need", "looking", "unit", "units",
    "compound", "please", "any",
    // Spoken fillers and polite words (Egyptian Arabic): they carry no filter.
    "ممكن", "تكرمت", "تكرم", "تدورلي", "تدور", "ادورلي", "بلاش", "اللي", "يا", "باشا", "بيه", "ريس", "هندسه", "استاذ", "اخي", "تمام", "طيب",
    "بسعر", "سعر", "ميزانيه", "ميزانيتي", "بميزانيه", "بادجت", "جنيه", "جنية", "جنيها", "الشهر", "شهريا", "شهري", "وصاله", "صاله",
    "مساحتها", "مساحه", "الاقل", "كومباوند", "كومبوند", "كمبوند", "كمبوندات", "كومباوندات", "قريبه", "ابغي", "ابي", "عندكم", "عندكو", "some", "and", "or", "of", "to", "is", "near", "around", "قريب", "جنب",
    "more", "less", "than", "دولار", "يورو", "دولارات", "dollar", "dollars", "euro", "euros", "usd", "eur", "شقتين", "فيلتين", "وحدتين", "بدور", "دور", "البادجت", "بدجت", "بودجت", "الميزانيه", "بدوّر", "عاوزه", "عايزين", "محتاجه"
  ].map(normalizeSearch)
);

const STANDALONE_TERMS = new Set(["standalone", "stand alone", normalizeSearch("فيلا مستقلة")]);
const TYPE_MATCHERS = Object.entries(TYPE_TERMS)
  .flatMap(([type, words]) => words.map((w) => ({ type, term: normalizeSearch(w) })))
  .sort((a, b) => b.term.length - a.term.length);

/**
 * Egyptian spoken amounts as digits, so the money rules can read them: "مليونين" → "2 مليون", "نص مليون" → "0.5 مليون",
 * "مليون ونص" → "1.5 مليون", "الفين" → "2 الف", and a bare "مليون" after a filler ("بسعر مليون") → "1 مليون".
 */
function speakNumbers(hay) {
  const mil = (a, b) => ` ${Number((Number(a) + Number(b) / 1000).toFixed(3))} مليون `;
  let h = hay
    .replace(/ (?:المليون|الملايين) /g, " مليون ")
    .replace(/ (\d+(?:\.\d+)?) مليون و ?(\d+) الف /g, (_, a, b) => mil(a, b))
    .replace(/ مليون و ?(\d+) الف /g, (_, b) => mil(1, b))
    .replace(/ ب?(عشرين|تلاتين|ثلاثين|اربعين|خمسين|ستين|سبعين|تمانين|ثمانين|تسعين) (?:الف|ألف) /g, (_, w) => ` ${{ عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, تمانين: 80, ثمانين: 80, تسعين: 90 }[w]} الف `)
    .replace(/ ([ء-ي]+) مليون (ونص|وربع) /g, (all, w, k) => (Object.prototype.hasOwnProperty.call(AR_NUMBER_WORDS, w) ? ` ${AR_NUMBER_WORDS[w] + (k === "ونص" ? 0.5 : 0.25)} مليون ` : all))
    .replace(/ (?:نص|نصف) مليون /g, " 0.5 مليون ")
    .replace(/ ربع مليون /g, " 0.25 مليون ")
    .replace(/ (?:تلت|ثلث) مليون /g, " 0.33 مليون ")
    .replace(/ ب?(مليونين|مليونان) /g, " 2 مليون ")
    .replace(/ (الفين|الفان) /g, " 2 الف ")
    .replace(/ (?:الاف|تلاف) /g, " الف ")
    .replace(/ (\d+) مليون ونص /g, (_, d) => ` ${Number(d) + 0.5} مليون `)
    .replace(/ (\d+) مليون وربع /g, (_, d) => ` ${Number(d) + 0.25} مليون `)
    .replace(/ مليون ونص /g, " 1.5 مليون ")
    .replace(/ مليون وربع /g, " 1.25 مليون ");
  // A bare "مليون" / "الف" with no number before it means one.
  const t = h.trim().split(/\s+/);
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "مليون" && t[i] !== "million") continue;
    const prev = t[i - 1];
    if (prev === undefined || !(/^\d+(\.\d+)?$/.test(prev) || Object.prototype.hasOwnProperty.call(AR_NUMBER_WORDS, prev))) t[i] = `1 ${t[i]}`;
  }
  return ` ${t.join(" ")} `;
}

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

const NEG_FIRST = new Set(["بدون", "without", "except", "بلا"]);
const NEG_KEEP = new Set(["تشطيب", "فرش"]); // "بدون تشطيب" is core-and-shell, "بدون فرش" is unfurnished: real filters
const FLOOR_WORDS = new Set(["الدور", "دور", "floor"]);

/**
 * Pulls negations and unsupported phrases out of the normalized text.
 * "بدون مصعد", "من غير جراج وحديقة", "مش في الدور الاول", "الدور الاخير", "last floor", "قانون جديد" → unapplied list.
 */
function takeUnapplied(hay, unapplied) {
  const t = hay.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < t.length; i++) {
    let start = -1;
    if (NEG_FIRST.has(t[i])) start = i + 1;
    else if (t[i] === "من" && t[i + 1] === "غير") start = i + 2;
    else if (t[i] === "مش" && (t[i + 1] === "في" || t[i + 1] === "فى")) start = i + 2;
    const w = start >= 0 ? t[start] : undefined;
    if (w !== undefined && !/^\d/.test(w) && !NEG_KEEP.has(w)) {
      const taken = [w];
      let j = start + 1;
      if (FLOOR_WORDS.has(w) && t[j] !== undefined) taken.push(t[j++]);
      // "بدون مصعد وجراج" / "بدون مصعد و جراج": the whole list is negated.
      while (t[j] !== undefined && (t[j] === "و" || (t[j].length > 2 && t[j].startsWith("و")))) {
        taken.push(t[j]);
        if (t[j] === "و" && t[j + 1] !== undefined) taken.push(t[++j]);
        j++;
      }
      unapplied.push(t.slice(i, start).concat(taken).join(" "));
      i = j - 1;
      continue;
    }
    out.push(t[i]);
  }
  let h = ` ${out.join(" ")} `;
  for (const re of [
    / (?:ب|بال)?(?:الدور الاخير|اخر دور|الدور الاخر|top floor|last floor) /,
    / (?:قانون جديد|قانون قديم|ايجار قديم|ايجار جديد|new rent law|old rent law) /,
    // "down payment less than 10%": a ceiling on the down payment percent, which the filters cannot say.
    / (?:down ?payment|مقدم) (?:less than|under|below|max|maximum|اقل من|تحت|حد اقصي) \d+(?:\.\d+)? ?(?:%|percent|بالمية|فالمية) /
  ]) {
    const m = h.match(re);
    if (m) {
      unapplied.push(m[0].trim());
      h = h.replace(re, " ");
    }
  }
  return h;
}

/** The sentence is long or odd enough that a person should not trust the local reading alone (words as typed). */
const MAYBE_LISTING = / (?:عندي|معايا|عندنا|سعرها|سعره|مطلوب فيها|صاحبها|المالك|i have|my unit|for my client) /;

/** Local parser used when the AI is unavailable. Deterministic and bilingual. */
// Approved aliases from the database (services/searchVocab.js): a word brokers say → a word the dictionaries know.
let ALIASES = [];
function setAliases(list = []) {
  ALIASES = (list || [])
    .map((a) => ({ re: new RegExp(` ${String(normalizeSearch(a.term)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "g"), to: ` ${normalizeSearch(a.target)} ` }))
    .filter((a) => a.to.trim());
}
function applyAliases(hay) {
  for (const a of ALIASES) hay = hay.replace(a.re, a.to);
  return hay;
}

function fallbackParse(text) {
  const raw = foldLetters(String(text || "").trim());
  let hay = ` ${normalizeSearch(raw)} `.replace(Fx.CURRENCY_WORDS, " ");
  const egpWord = / (جنيه|جنيها|egp|pound|pounds|le) /.test(` ${normalizeSearch(raw)} `);
  const f = emptyFilters();
  // Budget numbers with no unit: the bot asks which unit was meant (see the budget rule below).
  const budgetAsk = [];
  // A dollar or euro budget keeps its currency; the amount is converted only at search time (domain/fx.js).
  f.currency = Fx.currencyOfText(raw);

  if (SMALL_TALK.includes(hay.trim())) {
    return { intent: "other", transcript: raw.slice(0, 500), language: /[a-z]/i.test(raw) && !/[؀-ۿ]/.test(raw) ? "en" : "ar", filters: canonical(f), meta: { unsure: false, reasons: [], leftover: [], leftover_numbers: [], unapplied: [] } };
  }

  // A unit code written like NH-V12 (initials, a hyphen, an optional letter, a number).
  let c = consume(hay, / ([a-z]{1,6}\d{0,3}-[a-z]{0,2}\d{1,5}) /);
  if (c.m) {
    f.code = normalizeCode(c.m[1]);
    hay = c.hay;
  } else {
    // A code typed with no hyphen ("HP218") is a code only when it is the whole message.
    const whole = hay.trim().match(/^([a-z]{1,6}\d{2,5})$/);
    if (whole) {
      f.code = normalizeCode(whole[1]);
      hay = " ";
    }
  }

  hay = hay.replace(/(\d)([a-zء-ي])/g, "$1 $2");
  // "ب٥ مليون" / "ب 5 مليون": the attached "ب" (at / for) before a number is dropped.
  hay = hay.replace(/ ب ?(?=\d)/g, " ");

  // Things the filters cannot say ("without a lift", "not on the first floor", "last floor", the new rent law) are not
  // guessed: they are taken out and reported, so the broker sees what was NOT applied.
  const unapplied = [];
  hay = takeUnapplied(hay, unapplied);
  hay = applyAliases(hay);

  // "Lake View" is a compound. It is the lake-view feature only in these phrasings, read before the places.
  const lake = consume(hay, / (?:overlooking (?:the )?lake|with (?:a |the )?lake view|ب?فيو (?:علي |ع )?(?:ال)?بحيره) /);
  const lakeFeature = Boolean(lake.m);
  hay = lake.hay;

  // Places first (they can contain type-like words, e.g. "town").
  const placeScan = Places.findPlaces(hay);
  f.places = placeScan.places;
  hay = speakNumbers(` ${placeScan.rest} `);
  // "و2 حمام": the "and" glued to a number is dropped (the money rules above already used it).
  hay = hay.replace(/ و(?=\d|حمام|[ء-ي]+ حمام)/g, " ");

  // "بجنينة" / "بغرفة مربية" / "بتراس": the attached "ب" (with) is dropped before a feature word.
  hay = hay.replace(/ ب(غرفه|جنينه|حديقه|جراج|اسانسير|تراس|روف|بلكونه|حمام سباحه|مطبخ|تكييف|ماستر|دريسنج|امن|سطح|دولار|يورو)/g, " $1");
  // Franco-Arabic (Arabic in Latin letters): the common words become their Arabic spelling so the rules below read them.
  hay = hay
    .replace(/ (?:shaqa|shaqqa|sha2a|shu2a|sha2'a) /g, " شقه ")
    .replace(/ (?:be?l? ?)?(?:tagheez|tashteeb|tasheeb) (?:kamel|kaamel|full) /g, " تشطيب كامل ")
    .replace(/ (?:ghorfa|ghorfet|ghurfa) (?:morabeya|morabbya|morabia|nanny) /g, " غرفه مربيه ")
    .replace(/ (?:ghorf|ghoraf|ghorfa|ghurf|oda|odaa|oda2) /g, " غرف ")
    .replace(/ (?:ejar|egar|igar|ijar|e7gar|eigar) /g, " ايجار ")
    .replace(/ (?:lel ?bay3|lel ?beya3|lel ?bei3|lelbay3|lelbei3) /g, " للبيع ")
    .replace(/ (?:fe|fi|fel|fil|fee) /g, " في ");
  // English words written in Arabic letters.
  hay = hay
    .replace(/ (ابارتمنت|ابارتمنتس|أبارتمنت|ابرتمنت) /g, " شقه ")
    .replace(/ (بيدروم|بيدرومز|بيدرومات|بدرومات) /g, " غرف ")
    .replace(/ (فولي|فلي|فوللي|فول) (فينشد|فنشد|فينيشد|فينيش) /g, " تشطيب كامل ")
    .replace(/ (فيرنشد|فرنشد|فيرنيشد|فرنيشد) /g, " مفروشه ")
    .replace(/ (هاي لوكس|هاى لوكس|high lux) /g, " سوبر لوكس ")
    .replace(/ (اوف بلان|off plan|offplan|under construction) /g, " تحت الانشاء ");

  // Multi-word type names are read before the features, so "triplex roof" is the triplex-with-roof type, not a triplex with a roof feature.
  for (const m of TYPE_MATCHERS) {
    if (m.term.includes(" ") && hay.includes(` ${m.term} `)) {
      f.property_types.push(m.type);
      if (STANDALONE_TERMS.has(m.term)) f.type_exact = true;
      hay = hay.split(` ${m.term} `).join(" ");
    }
  }

  // Features (dictionary only).
  f.features = Features.matchFeatureKeys(hay);
  if (lakeFeature && !f.features.includes("view_lagoon")) f.features.push("view_lagoon");
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
  // A plain count is a minimum: "2 bedroom" means 2 or more (same for bathrooms and area).
  if (c.m) f.bedrooms_min = 2;
  hay = c.hay;
  c = consume(hay, / (\d+|[ء-ي]+) (غرف|غرفه|اوض|اوضه|نوم|bed|beds|bedroom|bedrooms|room|rooms|br) /);
  if (c.m && n(c.m[1]) !== null) {
    f.bedrooms_min = n(c.m[1]);
    hay = c.hay;
  }
  c = consume(hay, / (حمامين) /);
  if (c.m) f.bathrooms_min = 2;
  hay = c.hay;
  c = consume(hay, / (\d+|[ء-ي]+) (حمام|حمامات|bath|baths|bathroom|bathrooms) /);
  if (c.m && n(c.m[1]) !== null) {
    f.bathrooms_min = n(c.m[1]);
    hay = c.hay;
  }

  // Money: ranges, "above", down payment and monthly installment come before the plain budget ceiling.
  const MONEY = "(\\d+(?:\\.\\d+)?|\\d+ \\d{1,2}) (مليون|million|m|الف|k|thousand)";
  const money = (num, unit) => parseMoneyWords(String(num).replace(" ", "."), unit);
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
  const CAP = "(?:حدود |تحت |اقل من |under |max |less than |at most |below |up to |مش (?:عايز )?(?:اكتر|اكثر) من |بحد اقصي |حد اقصي |اقصي |لحد )?";
  c = consume(hay, new RegExp(` و?(?:مقدم|دفعه اولي|دفعه مقدمه|down payment|downpayment) ${CAP}${MONEY} `));
  if (!c.m) c = consume(hay, / (\d+(?:\.\d+)?) (مليون|million|الف|k|thousand) (?:مقدم|دفعه اولي|down payment|downpayment) /); // "نص مليون مقدم": the amount comes first
  if (c.m) {
    f.max_down_payment = money(c.m[1], c.m[2]);
    hay = c.hay;
  }
  c = consume(hay, new RegExp(` و?(?:قسط شهري|قسط|monthly installment|installment) ${CAP}${MONEY} `));
  if (c.m) {
    f.max_installment = money(c.m[1], c.m[2]);
    f.payment_installments = true;
    hay = c.hay;
  }
  // "قسط 20000": the installment word with a plain number is the monthly installment ceiling.
  c = consume(hay, / و?(?:قسط شهري|قسط|monthly installment|installment) (\d{4,9}) /);
  if (c.m) {
    f.max_installment = Number(c.m[1]);
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
  c = consume(hay, new RegExp(`(?<!not|no|مش) (?:فوق|اكتر من|اكثر من|اكبر من|above|over|more than|min) (?!(?:[6-9]\\d|\\d{3,4}) m )${MONEY} `));
  if (c.m) {
    const v = money(c.m[1], c.m[2]);
    if (v) f.price_min = v;
    hay = c.hay;
  }

  // A budget with the short "م" ("تحت 9م"): read before the area rule, so it is not square metres.
  c = consume(hay, / (?:تحت|اقل من|حدود|بحدود|لحد|مش (?:عايز )?(?:اكتر|اكثر) من|under|below|max|up to|not more than|no more than|not over|not above|maximum) (\d+(?:\.\d+)?|[ء-ي]+) (م|m) /);
  if (c.m) {
    const v = spokenAmount(c.m[1]);
    if (v !== null) f.price_max = parseMoneyWords(String(v), "م");
    hay = c.hay;
  }
  // A dollar or euro budget with no unit word ("تحت 1000 دولار", "under 1000 dollars"): the number is the amount.
  if (f.currency && f.price_max === null) {
    c = consume(hay, / (?:تحت|اقل من|حدود|بحدود|لحد|under|below|max|up to|not more than|no more than|not over|not above|maximum) (\d+(?:\.\d+)?)(?! (?:مليون|million|m|الف|ألف|k|thousand|م) ) /);
    if (c.m) {
      f.price_max = Math.round(Number(c.m[1]));
      hay = c.hay;
    }
  }

  // Area: "150 متر" / "150 m2" is a minimum (150 or more); "من 120 ل 150 متر" is a range.
  c = consume(hay, / (?:من |from )?(\d{2,4}) (?:ل|الي|to|-) (\d{2,4}) (متر|م|m2|m|sqm|meter|meters) /);
  if (c.m) {
    f.area_min = Number(c.m[1]);
    f.area_max = Number(c.m[2]);
    hay = c.hay;
  } else {
    // "m" / "م" alone is metres only from 30 up; "20m" / "20 م" is twenty million (a unit is never 20 m2).
    // "bigger than 120 m" / "smaller than 150 m" (اكبر من / اصغر من) are the area's own words, not place words.
    c = consume(hay, /(?<!مش )(?:اصغر|اقل) من (\d{2,4}) (?:متر|m2|sqm|meter|meters) /);
    if (c.m) {
      f.area_max = Number(c.m[1]);
      hay = c.hay;
    } else {
      c = consume(hay, / (?:(?:اكبر|اكتر|اكثر|اوسع|فوق|above|over|more than|bigger than|larger than|at least) (?:من )?)?(\d{2,4}) (متر|m2|sqm|meter|meters) /);
      if (!c.m) c = consume(hay, / (?:(?:اكبر|اكتر|اكثر|اوسع|فوق|above|over|more than|bigger than|larger than|at least) (?:من )?)?(\d{3,4}|[3-9]\d) (م|m) /);
    }
    if (c.m && f.area_max == null) {
      f.area_min = Number(c.m[1]);
      hay = c.hay;
    }
  }

  // "20 م" alone (under 30) is twenty million, not metres.
  if (f.area_min === null && f.price_max === null && f.price_min === null) {
    c = consume(hay, / (\d{1,2}(?:\.\d+)?) م /);
    if (c.m) {
      f.price_max = Math.round(Number(c.m[1]) * 1e6);
      hay = c.hay;
    }
  }

  // A currency named with one plain number and no limit word ("شقة 5000 دولار", "8500 جنيه"): that number is the price ceiling.
  if (f.price_max === null && f.price_min === null && (f.currency || egpWord)) {
    const bare = hay.split(" ").filter((w) => /^\d{3,9}$/.test(w));
    if (bare.length === 1) {
      f.price_max = Number(bare[0]);
      hay = hay.replace(` ${bare[0]} `, " ");
    }
  }

  // Budget: "تحت 8 مليون" / "under 8 million" / "8 مليون" (a ceiling).
  c = consume(hay, / (?:تحت|اقل من|حدود|بحدود|لحد|بحد اقصي|حد اقصي|اقصي|مش (?:عايز )?(?:اكتر|اكثر) من|under|below|max|up to|not more than|no more than|not over|not above|maximum|budget|(?:ال)?(?:بادجت|بدجت|بودجت|ميزانيه|ميزانيتي))? ?(\d+(?:\.\d+)?|\d+ \d+|[ء-ي]+) (مليون|million|m|الف|k|thousand)( ونص)? /);
  if (c.m) {
    const n = spokenAmount(c.m[1].replace(" ", "."));
    const v = n === null ? null : parseMoneyWords(String(n), c.m[2]);
    const half = c.m[3] && v ? parseMoneyWords("0.5", c.m[2]) : 0;
    if (v && f.price_max === null) f.price_max = v + half;
    if (n !== null) hay = c.hay;
  }

  // "بحد اقصى 8000" / "تحت 15000": a bare number of four digits or more after a limit word is the price ceiling (rent).
  if (f.price_max === null) {
    c = consume(hay, / (?:بحد اقصي|حد اقصي|اقصي|ميزانيتي|ميزانيه|الميزانيه|بادجت|البادجت|بدجت|بودجت|تحت|اقل من|حدود|بحدود|لحد|under|below|max|up to|not more than|no more than|not over|not above|maximum|budget) (\d{4,9}) /);
    if (c.m) {
      f.price_max = Number(c.m[1]);
      hay = c.hay;
    }
  }

  // A budget word with a small plain number and no unit ("budget 50", "بادجيت ١٠٠", "budget 2.5"): it could be thousands or
  // millions, so nothing is guessed. The price stays empty and the bot asks which unit was meant (rent: thousands first, sale: millions first).
  if (f.price_max === null && f.price_min === null) {
    c = consume(hay, /(?:budget|بادجيت|بادجت|بدجت|بودجت|بودجيت|ميزانيه|ميزانيتي|الميزانيه|الميزانيتي) (\d{1,3}(?:\.\d+)?)(?![\d.])(?! ?(?:مليون|million|m|الف|ألف|k|thousand|م|دولار|dollars?|usd|\$|جنيه|egp|يورو|eur))/);
    if (c.m) {
      // The normalised text drops the dot, so read a decimal ('2.5') from the raw message.
      const decimal = /(?:budget|بادجيت|بادجت|بدجت|بودجت|بودجيت|ميزانيه|ميزانيتي|الميزانيه|الميزانيتي)\s*(\d{1,3}\.\d{1,2})(?!\d)/i.exec(raw);
      const typed = decimal ? decimal[1] : c.m[1];
      const thousands = `${typed} ألف`;
      const millions = `${typed} مليون`;
      budgetAsk.push({ typed, kind: "budget", options: f.listing_type === "sale" ? [millions, thousands] : [thousands, millions] });
      hay = c.hay;
    }
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
  c = consume(hay, / (?:غير مفروشه|غير مفروش|مش مفروشه|مش مفروش|بدون فرش|بدون مفروشه|بدون مفروش|من غير فرش|فاضيه|unfurnished|not furnished|non furnished|without furniture) /);
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
  // "مش مفروشة" / "بدون فرش" / "not furnished": the furnished word was already taken as a feature, so the negation is read from the whole text.
  const nfurn = normalizeSearch(raw);
  if (/(?:^| )(?:مش|غير|بدون|من غير|not|non|without) (?:مفروش[ء-ي]*|فرش|furnished|furniture)(?: |$)/.test(nfurn)) {
    f.furnishing = "unfurnished";
    f.features = f.features.filter((k) => k !== "furnished");
    hay = hay.replace(/ (?:مش|غير|بدون|من غير|not|non|without) /g, " ");
  } else if (/(?:^| )(?:نص|نصف|semi|half) (?:مفروش[ء-ي]*|فرش|furnished)(?: |$)/.test(nfurn)) {
    f.furnishing = "semi_furnished";
    f.features = f.features.filter((k) => k !== "furnished");
  }
  if (!f.furnishing && f.features.includes("furnished")) f.furnishing = "furnished";
  const ORD = {
    الاول: 1, الاولي: 1, اول: 1, التاني: 2, الثاني: 2, تاني: 2, ثاني: 2, التالت: 3, الثالث: 3, تالت: 3, ثالث: 3, الرابع: 4, رابع: 4,
    الخامس: 5, خامس: 5, السادس: 6, سادس: 6, السابع: 7, سابع: 7, الثامن: 8, تامن: 8, ثامن: 8, التاسع: 9, تاسع: 9, العاشر: 10, عاشر: 10
  };
  c = consume(hay, / (?:ب|بال)?(?:الدور|دور|floor) (\d{1,2}|[ء-ي]+) /);
  if (c.m) {
    const fl = /^\d+$/.test(c.m[1]) ? Number(c.m[1]) : ORD[c.m[1]] ?? null;
    if (fl !== null) {
      f.floor_min = f.floor_max = fl;
      hay = c.hay;
    }
  }
  // "متكرر" / "typical": any floor above ground.
  c = consume(hay, / (متكرر|متكرره|متكررة|typical|typical floor) /);
  if (c.m && f.floor_min === null) {
    f.floor_min = 1;
    hay = c.hay;
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
  c = consume(hay, / (?:تحت الانشاء|لسه بتتبني|قيد الانشاء) /);
  if (c.m) f.delivery_ready = false;
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
  c = consume(hay, / و?(?:ب|بال)?(تقسيط|اقساط|قسط|installments|installment) /);
  if (c.m) f.payment_installments = true;
  hay = c.hay;

  // Years of a plan: "على ٨ سنين", "8 years", "تمانية سنين", "سنتين". Read here, so the unit word never becomes a place term.
  c = consume(hay, / ([0-9]+|[ء-ي]+) (سنين|سنه|سنة|سنوات|years|year|yrs) /);
  if (c.m && planYears(spokenAmount(c.m[1])) !== null) {
    f.payment_years = planYears(spokenAmount(c.m[1]));
    hay = c.hay;
  }
  c = consume(hay, / (سنتين) /);
  if (c.m) {
    f.payment_years = 2;
    hay = c.hay;
  }

  // Down payment as a percent: "مقدم ١٠٪" / "10% down". The sign is dropped by the normalizer, so the number must stand
  // alone (no money unit, which the rules above already took) and be at most 100.
  c = consume(hay, / (مقدم|دفعه اولي|دفعه مقدمه|down payment|downpayment|down) (\d+(?:\.\d+)?) /);
  if (c.m && downPct(c.m[2]) !== null) {
    f.payment_down_pct = downPct(c.m[2]);
    hay = c.hay;
  }
  c = consume(hay, / (\d+(?:\.\d+)?) (?:down) /);
  if (c.m && downPct(c.m[1]) !== null) {
    f.payment_down_pct = downPct(c.m[1]);
    hay = c.hay;
  }

  // Property types.
  for (const m of TYPE_MATCHERS) {
    if (hay.includes(` ${m.term} `)) {
      f.property_types.push(m.type);
      if (STANDALONE_TERMS.has(m.term)) f.type_exact = true;
      hay = hay.split(` ${m.term} `).join(" ");
    }
  }
  hay = fuzzyTypes(hay, f.property_types);

  // "حمام سباحة" / "pool" (not "private pool", which is its own feature) is a feature word, not a place.
  c = consume(hay, / (?:ب|مع )?(?:حمام سباحه|حمامات سباحه|بيسين|swimming pool|pool) /);
  if (c.m) {
    f.feature_terms.push("حمام سباحه");
    hay = c.hay;
  }

  // Leftover words: unresolved places (≥3 letters, not stop words, not numbers).
  let leftovers = hay
    .split(" ")
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && !GENERIC_PLACE_WORDS.has(w));
  // Close spellings of known places ("مفيده", "mivda") are read as the place; ambiguous ones are left for the bot to ask about.
  const guesses = [];
  const ambiguous = [];
  if (leftovers.length) {
    const close = Places.closePlaces(leftovers);
    for (const m of close.matched) {
      if (!f.places.some((p) => p.kind === m.kind && p.key === m.key)) f.places.push({ kind: m.kind, key: m.key });
      guesses.push({ typed: m.typed, as: m.as });
    }
    for (const a of close.ambiguous) ambiguous.push(a);
    const askWords = new Set(ambiguous.flatMap((a) => a.typed.split(" ")));
    leftovers = leftovers.filter((w, i) => !close.used.has(i) || askWords.has(w));
  }
  // Words nobody knew are kept even when a place was found, so the bot can ask about them (the query ignores them then).
  if (leftovers.length) f.place_terms = [leftovers.join(" ")];
  // Numbers nobody used ("5000", "8"): the local reading cannot say what they are.
  const leftNumbers = hay.split(" ").filter((w) => /^\d+(?:\.\d+)?$/.test(w));

  // "kitchen and AC" is a furnishing status: when the request names no other furnishing, the two features become that status.
  // "AC only" / "kitchen only" (بس is optional in Arabic) are the other two statuses of the same field.
  if (!f.furnishing) {
    const nraw = ` ${normalizeSearch(raw)} `;
    // "K/A" is how brokers write kitchen and AC.
    if (/(?:^|\s)k\s?\/\s?a(?:\s|$)/i.test(String(raw))) {
      for (const k of ["kitchen_installed", "ac_installed"]) if (!f.features.includes(k)) f.features.push(k);
    }
    const hasK = f.features.includes("kitchen_installed");
    const hasA = f.features.includes("ac_installed");
    if (hasK && hasA) {
      f.features = f.features.filter((k) => k !== "kitchen_installed" && k !== "ac_installed");
      f.furnishing = "kitchen_and_ac";
    } else if (hasA && !hasK) {
      f.features = f.features.filter((k) => k !== "ac_installed");
      f.furnishing = "ac_only";
    } else if (hasK && !hasA) {
      f.features = f.features.filter((k) => k !== "kitchen_installed");
      f.furnishing = "kitchen_only";
    }
  }
  const filters = canonical(f);
  const intent = hasAnyFilter({ filters }) ? "search" : "other";
  const reasons = [];
  if (intent === "other" && !unapplied.length) reasons.push("no_filter");
  // Only words nobody knows ("ازيك"): a name, a greeting or a place the AI may know. Not a search to run on a guess.
  if (filters.place_terms.length && !hasAnyFilter({ filters: { ...filters, place_terms: [] } })) reasons.push("only_unknown_words");
  if (leftNumbers.length) reasons.push("numbers_left");
  if (leftovers.length >= 3) reasons.push("many_words_left");
  if (raw.split(/\s+/).length > 14) reasons.push("long");
  if (MAYBE_LISTING.test(` ${normalizeSearch(raw)} `)) reasons.push("maybe_listing");
  return {
    intent,
    transcript: raw.slice(0, 500),
    language: /[؀-ۿ]/.test(raw) ? "ar" : "en",
    filters,
    // What the local reader did and did not understand: shown to the broker and used to decide whether to ask the AI.
    meta: { unsure: reasons.length > 0, reasons, leftover: leftovers, leftover_numbers: leftNumbers, unapplied, guesses, ambiguous: [...ambiguous, ...budgetAsk] }
  };
}

/**
 * Where two readings of the same request differ (the quick reader and the AI): the names of the filters that are not equal.
 * Unknown words count as one field, "place_terms", so a place one reading could not find shows up as a difference.
 */
function disagreements(a, b) {
  const fa = canonical(a?.filters || a || {});
  const fb = canonical(b?.filters || b || {});
  // The display order of the types is not a disagreement about what is searched.
  const keys = Object.keys(emptyFilters()).filter((k) => !["feature_terms", "property_type_order"].includes(k));
  const out = [];
  for (const k of keys) {
    let x = fa[k];
    let y = fb[k];
    if (k === "places") {
      x = (x || []).map((p) => `${p.kind}:${p.key}`).join("|");
      y = (y || []).map((p) => `${p.kind}:${p.key}`).join("|");
    } else if (k === "place_terms") {
      x = (x || []).length > 0;
      y = (y || []).length > 0;
    }
    // An unset currency means EGP, and a family of types read in another order is the same search: not disagreements.
    if (k === "currency") (x = x || "EGP"), (y = y || "EGP");
    if (k === "property_types") (x = [...(x || [])].sort()), (y = [...(y || [])].sort());
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(k);
  }
  return out;
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
      f.area_scope ||
      (f.place_terms || []).length ||
      (f.features || []).length ||
      (f.feature_terms || []).length ||
      (f.finishing || []).length ||
      f.furnishing ||
      [f.price_min, f.price_max, f.area_min, f.area_max, f.bedrooms_min, f.bedrooms_max, f.bathrooms_min, f.floor_min, f.floor_max,
        f.max_down_payment, f.max_installment, f.delivery_by_year].some((v) => v !== null && v !== undefined) ||
      f.delivery_ready !== null && f.delivery_ready !== undefined ||
      f.payment_cash ||
      f.payment_installments ||
      (f.payment_years !== null && f.payment_years !== undefined) ||
      (f.payment_down_pct !== null && f.payment_down_pct !== undefined)
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
// A "20m" / "20 م" the AI read as 20 square metres: with no area word it is twenty million, a price ceiling.
function enforceMillionUnits(parsed, text) {
  const f = parsed?.filters;
  if (!f || f.area_min === null || f.area_min === undefined || Number(f.area_min) >= 30) return parsed;
  const t = ` ${normalizeSearch(String(text || ""))} `;
  if (/ (?:متر|m2|sqm|meter|meters) /.test(t) || /\d(?:m2|sqm)/.test(t)) return parsed;
  const m = t.match(/ (\d{1,2}(?:\.\d+)?) ?(?:m|م) /);
  if (!m || Number(m[1]) !== Number(f.area_min)) return parsed;
  if ((f.price_max === null || f.price_max === undefined) && (f.price_min === null || f.price_min === undefined)) f.price_max = Math.round(Number(m[1]) * 1e6);
  f.area_min = null;
  f.area_max = null;
  return parsed;
}

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

const RENT_WORD = /(^| )(ايجار|للايجار|ايجارات|rent|rental|for rent|tajeer)( |$)/;
/** A down payment, installment or payment years only exist on a sale: with no rent word the search is a sale. */
function enforceSaleForPayment(parsed, text) {
  const f = parsed?.filters;
  if (!f || f.listing_type === "sale") return parsed;
  const pays = f.max_down_payment || f.max_installment || f.payment_installments || f.payment_years || (f.payment_down_pct !== null && f.payment_down_pct !== undefined);
  if (pays && !RENT_WORD.test(normalizeSearch(String(text || "")))) f.listing_type = "sale";
  return parsed;
}

module.exports = {
  enforceSaleForPayment,
  enforceInstallmentWords,
  enforceMillionUnits,
  emptyFilters,
  normalizeCode,
  normalizeAiSearch,
  fallbackParse,
  setAliases,
  hasAnyFilter,
  classifyIntent,
  ensureFilters,
  canonical,
  disagreements
};
