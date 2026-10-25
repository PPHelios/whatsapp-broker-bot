// domain/unitCode.js — Auto-generated unit codes (owner's choice 2026-10-25): the agency's initials, one letter for
// the property type and one running number per agency, e.g. NH-V12, NH-A41. Codes a broker types are kept as typed.
"use strict";

const TYPE_LETTER = {
  apartment: "A",
  villa: "V",
  townhouse: "T",
  twinhouse: "T",
  duplex: "D",
  penthouse: "P",
  chalet: "C",
  studio: "S",
  office: "O",
  commercial: "R",
  land: "L"
};

// First letters of Arabic words in Latin (Egyptian sounds: ج → G, ق → Q).
const AR_LATIN = {
  "ا": "A", "أ": "A", "إ": "A", "آ": "A", "ب": "B", "ت": "T", "ث": "T", "ج": "G", "ح": "H", "خ": "K", "د": "D", "ذ": "Z",
  "ر": "R", "ز": "Z", "س": "S", "ش": "S", "ص": "S", "ض": "D", "ط": "T", "ظ": "Z", "ع": "A", "غ": "G", "ف": "F", "ق": "Q",
  "ك": "K", "ل": "L", "م": "M", "ن": "N", "ه": "H", "و": "W", "ي": "Y", "ى": "Y", "ة": "H"
};

// Words that say what the business is rather than who: left out of the initials.
const FILLER = new Set([
  "real", "estate", "realestate", "realty", "properties", "property", "company", "co", "group", "for", "and", "the",
  "agency", "brokerage", "developments", "شركة", "شركه", "عقارات", "للعقارات", "العقارية", "العقاريه", "للتسويق", "العقاري",
  "مكتب", "و", "ل"
]);

const typeLetter = (propertyType) => TYPE_LETTER[String(propertyType || "").toLowerCase()] || "U";

/** One Latin letter for a word's first letter (Arabic transliterated, the article ال skipped); "" if none. */
function firstLetter(word) {
  const w = String(word).replace(/^ال(?=\S{2,})/, "");
  const c = w.charAt(0);
  if (/[A-Za-z]/.test(c)) return c.toUpperCase();
  return AR_LATIN[c] || "";
}

/** Initials from an agency or freelancer name: "Nile Homes" → NH, "عقارات النيل" → N, "Remax" → RE; fallback U. */
function prefixFrom(name) {
  const words = String(name || "")
    .split(/[\s\-_.,&/()]+/)
    .filter(Boolean)
    .filter((w) => !FILLER.has(w.toLowerCase()));
  const letters = words.map(firstLetter).filter(Boolean);
  if (letters.length >= 2) return letters.slice(0, 3).join("");
  if (words.length === 1 && /^[A-Za-z]{2}/.test(words[0])) return words[0].slice(0, 2).toUpperCase();
  return letters[0] || "U";
}

/** A prefix a manager may set: 1–4 Latin letters (upper-cased); null otherwise. */
function cleanPrefix(raw) {
  const p = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z]{1,4}$/.test(p) ? p : null;
}

const format = (prefix, propertyType, n) => `${prefix}-${typeLetter(propertyType)}${n}`;

module.exports = { TYPE_LETTER, typeLetter, prefixFrom, cleanPrefix, format };
