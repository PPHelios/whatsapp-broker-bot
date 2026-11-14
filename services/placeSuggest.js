// services/placeSuggest.js — One suggestion list for what a person types in a place box: compounds, their aliases, areas
// and sub-zones together (rules in domain/areas.js). The approved lists are cached for a minute.
"use strict";

const crypto = require("crypto");
const A = require("../domain/areas");
const Areas = require("./areas");

const CACHE_MS = 60 * 1000;
let cache = { at: 0, places: [], areas: [], version: "" };

async function lists(pool) {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  const [places, areas] = await Promise.all([
    pool.query("SELECT id, name_en, name_ar, aliases, area_id, subzone_id, lat, lng FROM map_places WHERE approved"),
    Areas.approvedAreas(pool)
  ]);
  // The version changes only when an approved place or area changes, so the phone can keep its copy until then.
  const version = crypto.createHash("sha1").update(JSON.stringify([places.rows, areas])).digest("hex").slice(0, 16);
  cache = { at: Date.now(), places: places.rows, areas, version };
  return cache;
}

/** Up to `limit` suggestions for the text: [{kind, id, name_en, name_ar, path, via}]. */
async function suggest(pool, text, limit = 8, lang = "en") {
  const { places, areas } = await lists(pool);
  return A.suggest(String(text || "").slice(0, 80), { places, areas }, Math.min(Math.max(1, limit), 20), lang === "ar" ? "ar" : "en");
}

/** The whole approved list for the phone to keep: { version, places, areas }. With the version the phone already holds: { version, unchanged: true }. */
async function listing(pool, since = "") {
  const { places, areas, version } = await lists(pool);
  if (since && since === version) return { version, unchanged: true };
  return { version, places, areas };
}

/** Forget the cached lists (after the owner approves, merges or edits a place or an area). */
function resetCache() {
  cache = { at: 0, places: [], areas: [], version: "" };
  require("./areaSearch").resetCache();
}

module.exports = { suggest, listing, resetCache };
