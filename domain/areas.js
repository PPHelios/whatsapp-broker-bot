// domain/areas.js — Pure rules for areas and sub-zones (no database): matching a typed name or alias, the location rule
// for compounds and units, and one suggestion list over compounds, areas and sub-zones. Every channel (website, Telegram,
// mini app, app, imports) calls these same rules, so none keeps its own copy.
"use strict";

const { placeKey, keysOf, dice } = require("./mapPlaces");

/** Every key an area answers to: English name, Arabic name, aliases. */
function areaKeys(area) {
  return keysOf(area);
}

/** key -> area ids (a name can exist under two parents, so a key can lead to more than one area). */
function buildIndex(areas) {
  const index = new Map();
  for (const a of areas) for (const k of areaKeys(a)) index.set(k, [...(index.get(k) || []), a.id]);
  return index;
}

/**
 * The area for a typed name. One match wins; two or more is "ambiguous" and the caller asks which one.
 * @returns {{id: string}|{ambiguous: string[]}|null}
 */
function resolveArea(index, text) {
  const ids = index.get(placeKey(text)) || [];
  if (ids.length === 1) return { id: ids[0] };
  return ids.length ? { ambiguous: ids } : null;
}

/** The chain from the top area down to this one: [area, sub-zone, ...]. A broken or looping chain stops where it breaks. */
function chain(areas, id) {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const out = [];
  const seen = new Set();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = byId.get(cur.parent_id)) {
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

/** What to store for a chosen node: its top area and, below that, the node itself as the sub-zone. */
function placement(areas, id) {
  const path = chain(areas, id);
  if (!path.length) return { area_id: null, subzone_id: null };
  return { area_id: path[0].id, subzone_id: path.length > 1 ? path[path.length - 1].id : null };
}

/**
 * Checks the location of a compound or a unit. A compound needs an area. A unit needs a compound or an area; a compound
 * brings its own area, so the unit's area is taken from it and cannot disagree. A sub-zone needs an area and must sit under it.
 * @param {{place_id?: string, area_id?: string, subzone_id?: string}} loc
 * @param {{kind: "compound"|"unit", areas: object[], placeArea?: string|null}} ctx placeArea = the chosen compound's area
 * @returns {{ok: true, area_id: string|null, subzone_id: string|null}|{ok: false, error: "needs_area"|"needs_location"|"bad_subzone"}}
 */
function checkLocation(loc, { kind, areas, placeArea = null }) {
  const area_id = loc.place_id && placeArea ? placeArea : loc.area_id || null;
  const subzone_id = loc.subzone_id || null;
  if (!area_id) return { ok: false, error: kind === "compound" ? "needs_area" : "needs_location" };
  if (subzone_id) {
    const path = chain(areas, subzone_id);
    if (path.length < 2 || path[0].id !== area_id) return { ok: false, error: "bad_subzone" };
  }
  return { ok: true, area_id, subzone_id };
}

/** Checks and cleans an area typed by the owner or proposed by a broker. */
function cleanArea(input) {
  const clip = (v, n) => String(v || "").trim().slice(0, n) || null;
  const name_en = clip(input.name_en, 120);
  const name_ar = clip(input.name_ar, 120);
  if (!name_en && !name_ar) return { ok: false, error: "name" };
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const lat = num(input.lat);
  const lng = num(input.lng);
  if ((lat != null && !Number.isFinite(lat)) || (lng != null && !Number.isFinite(lng))) return { ok: false, error: "coords" };
  if ((lat == null) !== (lng == null)) return { ok: false, error: "coords" };
  const aliases = Array.isArray(input.aliases) ? input.aliases : String(input.aliases || "").split(/[,،;؛\n]/);
  return {
    ok: true,
    value: {
      parent_id: input.parent_id || null,
      name_key: placeKey(name_en || name_ar),
      name_en,
      name_ar,
      aliases: [...new Set(aliases.map((s) => String(s).trim()).filter((s) => s.length >= 2 && s.length <= 80))].slice(0, 20),
      lat: lat == null ? null : Math.round(lat * 1e6) / 1e6,
      lng: lng == null ? null : Math.round(lng * 1e6) / 1e6
    }
  };
}

const KIND_RANK = { compound: 0, subzone: 1, area: 2 };

/**
 * One suggestion list for what a person types: compounds, their aliases, areas and sub-zones together. Exact names and
 * aliases first, then names that start with the text, then names that contain it, then spelling-alike names.
 * @param {string} text
 * @param {{places: object[], areas: object[]}} lists approved rows only
 * @returns {Array<{kind: "compound"|"area"|"subzone", id: string, name_en: string|null, name_ar: string|null, path: string, via: "name"|"alias"|"alike", area_id: string|null, subzone_id: string|null}>}
 */
function suggest(text, { places = [], areas = [] }, limit = 8, lang = "en") {
  // Typing matches Arabic or English; what is shown (label, path) is in the reader's language.
  const nm = (a) => (lang === "ar" ? a.name_ar || a.name_en : a.name_en || a.name_ar);
  const q = placeKey(text);
  if (q.length < 2) return [];
  const byId = new Map(areas.map((a) => [a.id, a]));
  const pathOf = (row) => {
    const own = row.parent_id !== undefined ? chain(areas, row.id).slice(0, -1) : [row.area_id, row.subzone_id].filter(Boolean).map((i) => byId.get(i)).filter(Boolean);
    return own.map(nm).join(" › ");
  };
  const rows = [
    ...places.map((p) => ({ kind: "compound", row: p })),
    ...areas.map((a) => ({ kind: a.parent_id ? "subzone" : "area", row: a }))
  ];
  const out = [];
  for (const { kind, row } of rows) {
    let best = null;
    const names = [placeKey(row.name_en), placeKey(row.name_ar)].filter(Boolean);
    for (const k of areaKeys(row)) {
      const isName = names.includes(k);
      let score = 0;
      if (k === q) score = 4;
      else if (k.startsWith(q) || k.split(" ").some((w) => w.startsWith(q))) score = 3;
      else if (k.includes(q)) score = 2;
      else if (q.length >= 4 && dice(q, k) >= 0.55) score = 1 + dice(q, k) / 10;
      if (score && (!best || score > best.score)) best = { score, via: score < 2 ? "alike" : isName ? "name" : "alias" };
    }
    if (best) {
      // What to store when this suggestion is picked: a compound brings its own area; an area or sub-zone is the area itself.
      const at = kind === "compound" ? { area_id: row.area_id || null, subzone_id: row.subzone_id || null } : placement(areas, row.id);
      out.push({ kind, id: row.id, label: nm(row), name_en: row.name_en || null, name_ar: row.name_ar || null, path: pathOf(row), via: best.via, ...at, score: best.score });
    }
  }
  return out
    .sort((a, b) => b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind] || String(a.name_en || a.name_ar).localeCompare(String(b.name_en || b.name_ar)))
    .slice(0, limit)
    .map(({ score, ...rest }) => rest);
}

module.exports = { areaKeys, buildIndex, resolveArea, chain, placement, checkLocation, cleanArea, suggest };
