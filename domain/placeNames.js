// domain/placeNames.js — Pure rules for English compound names that are not known yet (no database here).
"use strict";

const { normalizeSearch } = require("./searchText");

const LATIN = /[a-z]/i;
const ARABIC = /[؀-ۿ]/;

/** Key for a name: the normalized English text, so "El Rehab-Phase 1" and "el rehab phase 1" are one row. */
function nameKey(name) {
  return normalizeSearch(String(name || "")).replace(/[^a-z0-9ء-ي ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A compound worth asking about: it has English letters, and it is not already one of the known names. */
function isNewEnglishName(name) {
  const s = String(name || "").trim();
  return s.length >= 3 && s.length <= 80 && LATIN.test(s) && !ARABIC.test(s);
}

/**
 * Search terms that equal an approved name are widened to its English and Arabic forms, so a broker who types either
 * language finds the compound. Other terms are left as they are.
 * @param {string[]} terms place_terms from the parser
 * @param {Array<{name_en: string, name_ar: string|null}>} approved
 * @returns {string[]}
 */
function widenTerms(terms, approved) {
  const out = [];
  for (const t of terms) {
    const hit = approved.find((a) => nameKey(a.name_en) === nameKey(t) || (a.name_ar && normalizeSearch(a.name_ar) === normalizeSearch(t)));
    if (!hit) {
      out.push(t);
      continue;
    }
    out.push(normalizeSearch(hit.name_en));
    if (hit.name_ar) out.push(normalizeSearch(hit.name_ar));
  }
  return [...new Set(out.filter(Boolean))];
}

module.exports = { nameKey, isNewEnglishName, widenTerms };
