// domain/places.js — Bilingual places: areas, developers and compounds as language-neutral keys (pure)
// Seeds the compound_synonyms table (db/migrations/004) and resolves query text on the search side,
// so "Mountain View" and "ماونتن فيو" become the same key.
"use strict";

const { normalizeSearch } = require("./searchText");

const AREAS = {
  new_cairo: ["التجمع الخامس", "التجمع", "القاهرة الجديدة", "new cairo", "5th settlement", "fifth settlement", "tagamoa"],
  sheikh_zayed: ["الشيخ زايد", "زايد", "sheikh zayed", "zayed"],
  october: ["6 أكتوبر", "أكتوبر", "6th of october", "6 october", "october"],
  north_coast: ["الساحل الشمالي", "الساحل", "north coast", "sahel"],
  new_capital: ["العاصمة الإدارية", "العاصمة", "new capital", "new administrative capital"],
  shorouk: ["الشروق", "el shorouk", "shorouk"],
  mostakbal: ["مدينة المستقبل", "المستقبل", "mostakbal city", "future city"],
  ain_sokhna: ["العين السخنة", "السخنة", "ain sokhna", "sokhna"]
};

const DEVELOPERS = {
  sodic: ["سوديك", "sodic"],
  emaar: ["إعمار", "اعمار", "emaar"],
  palm_hills: ["بالم هيلز", "palm hills"],
  mountain_view: ["ماونتن فيو", "mountain view"],
  ora: ["أورا", "ora developers"],
  tmg: ["طلعت مصطفى", "talaat moustafa", "tmg"],
  hassan_allam: ["حسن علام", "hassan allam"]
};

// key: [area, developer, synonyms...] — the first Latin synonym is the canonical English name.
const COMPOUNDS = {
  hyde_park: ["new_cairo", null, "هايد بارك", "هايدبارك", "hyde park", "hydepark"],
  mivida: ["new_cairo", "emaar", "ميفيدا", "mivida"],
  madinaty: [null, "tmg", "مدينتي", "madinaty"],
  rehab: ["new_cairo", "tmg", "الرحاب", "رحاب", "al rehab", "rehab"],
  mv_icity: ["new_cairo", "mountain_view", "ماونتن فيو آي سيتي", "آي سيتي", "اي سيتي", "mountain view icity", "icity", "i city"],
  villette: ["new_cairo", "sodic", "فيليت", "villette"],
  eastown: ["new_cairo", "sodic", "ايست تاون", "eastown", "east town"],
  sodic_east: ["shorouk", "sodic", "سوديك ايست", "sodic east"],
  westown: ["sheikh_zayed", "sodic", "ويست تاون", "westown", "west town"],
  noll: ["new_cairo", null, "نول", "noll", "كليك", "kleek"],
  palm_hills_october: ["october", "palm_hills", "بالم هيلز أكتوبر", "palm hills october"],
  badya: ["october", "palm_hills", "بادية", "badya"],
  zed_west: ["sheikh_zayed", "ora", "زد الشيخ زايد", "زد", "zed sheikh zayed", "zed west", "zed"],
  zed_east: ["new_cairo", "ora", "زد ايست", "zed east"],
  marassi: ["north_coast", "emaar", "مراسي", "marassi"],
  swan_lake: ["new_cairo", "hassan_allam", "سوان ليك", "سوانليك", "swan lake", "swanlake"],
  beverly_hills: ["sheikh_zayed", null, "بيفرلي هيلز", "beverly hills"]
};

/** Every synonym row: { kind, key, synonym, norm, area_key, developer_key }. */
function synonymRows() {
  const rows = [];
  const push = (kind, key, syn, area = null, dev = null) =>
    rows.push({ kind, key, synonym: syn, norm: normalizeSearch(syn), area_key: area, developer_key: dev });
  for (const [key, syns] of Object.entries(AREAS)) syns.forEach((s) => push("area", key, s));
  for (const [key, syns] of Object.entries(DEVELOPERS)) syns.forEach((s) => push("developer", key, s));
  for (const [key, [area, dev, ...syns]] of Object.entries(COMPOUNDS)) syns.forEach((s) => push("compound", key, s, area, dev));
  return rows;
}

// Longest normalized synonym first, compounds before developers before areas on equal length.
const KIND_RANK = { compound: 0, developer: 1, area: 2 };
const MATCHERS = synonymRows()
  .filter((r) => r.norm)
  .sort((a, b) => b.norm.length - a.norm.length || KIND_RANK[a.kind] - KIND_RANK[b.kind]);

/**
 * Finds every place named in the text (whole-word matches). Matched words are consumed so
 * "palm hills october" is one compound, not the developer plus an area.
 * @returns {{ places: Array<{kind, key}>, rest: string }}
 */
function findPlaces(text) {
  let hay = ` ${normalizeSearch(text)} `;
  const places = [];
  for (const m of MATCHERS) {
    for (const needle of [` ${m.norm} `, ` و${m.norm} `, ` ب${m.norm} `]) {
      if (hay.includes(needle)) {
        if (!places.some((p) => p.kind === m.kind && p.key === m.key)) places.push({ kind: m.kind, key: m.key });
        hay = hay.split(needle).join(" ");
      }
    }
  }
  return { places, rest: hay.replace(/\s+/g, " ").trim() };
}

/** The single place a short phrase names (e.g. an AI "compound" field), or null. */
function resolvePlace(text) {
  const norm = normalizeSearch(text);
  if (!norm) return null;
  const exact = MATCHERS.find((m) => m.norm === norm);
  if (exact) return { kind: exact.kind, key: exact.key };
  const { places, rest } = findPlaces(text);
  return places.length === 1 && rest.length <= 2 ? places[0] : null;
}

/** Display name of a place key ({ ar, en }). */
function placeName(kind, key) {
  const syns = kind === "area" ? AREAS[key] : kind === "developer" ? DEVELOPERS[key] : COMPOUNDS[key]?.slice(2);
  if (!syns) return null;
  return { ar: syns.find((s) => /[؀-ۿ]/.test(s)) || syns[0], en: syns.find((s) => !/[؀-ۿ]/.test(s)) || syns[0] };
}

module.exports = { AREAS, DEVELOPERS, COMPOUNDS, synonymRows, findPlaces, resolvePlace, placeName };
