// scripts/import-place-lists.js — Reads the location JSON files (label "English - عربي", value "English name") and
// writes data/place-lists/places.json with one row per place. Missing fields are stored as empty strings. Names
// that match a compound already in domain/places.js are marked matched; the rest are listed as unmatched.
"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeSearch } = require("../domain/searchText");
const Places = require("../domain/places");

const DIR = path.join(__dirname, "..", "data", "place-lists");
const FILES = ["newCairo", "cairo", "giza", "northCoast", "ainSokhna", "alex"];

const slug = (s) =>
  normalizeSearch(s).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "x";

/** "Porto Sokhna -بورتو السخنة" → { en: "Porto Sokhna", ar: "بورتو السخنة" }; a label with no Arabic gives ar "". */
function splitLabel(label) {
  const s = String(label || "").trim();
  const i = s.search(/[؀-ۿ]/);
  if (i < 0) return { en: s.replace(/\s*-\s*$/, "").trim(), ar: "" };
  return { en: s.slice(0, i).replace(/[\s-]+$/, "").trim(), ar: s.slice(i).trim() };
}

/** Value "Compound - Developer" → developer part; a value with no " - " has no developer. */
function developerOf(value) {
  const v = String(value || "");
  const i = v.lastIndexOf(" - ");
  return i < 0 ? "" : v.slice(i + 3).trim();
}

// Canonical Latin names already in code: compared on their normalized form.
const known = new Map();
for (const [key, [, , ...syns]] of Object.entries(Places.COMPOUNDS)) {
  for (const s of syns) if (/^[\x00-\x7F]+$/.test(s)) known.set(normalizeSearch(s), key);
}

const rows = [];
const report = {};
for (const file of FILES) {
  const list = JSON.parse(fs.readFileSync(path.join(DIR, `${file}.json`), "utf8"));
  const stats = { total: 0, matched: 0, unmatched: 0, missing_arabic: 0, missing_developer: 0 };
  for (const item of list) {
    const { en, ar } = splitLabel(item.label);
    const developer = developerOf(item.value);
    const key = slug(en);
    const matched = known.has(normalizeSearch(en)) ? known.get(normalizeSearch(en)) : null;
    const row = {
      key,
      source: file,
      name_en: en,
      name_ar: ar,
      developer,
      value: String(item.value || ""),
      area: "",
      matched_key: matched || "",
      status: matched ? "matched" : "unmatched"
    };
    rows.push(row);
    stats.total++;
    if (matched) stats.matched++;
    else stats.unmatched++;
    if (!ar) stats.missing_arabic++;
    if (!developer) stats.missing_developer++;
  }
  report[file] = stats;
}

fs.writeFileSync(path.join(DIR, "places.json"), JSON.stringify(rows, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
const unmatched = rows.filter((r) => r.status === "unmatched").length;
console.log(`total ${rows.length}, unmatched ${unmatched}`);
