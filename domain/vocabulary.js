// domain/vocabulary.js — Search vocabulary shared by the SQL search document and the query parser (pure)
"use strict";

const Features = require("./features");
const Places = require("./places");
const { normalizeSearch } = require("./searchText");

// Words that name a property type, both languages (normalized when used).
const TYPE_TERMS = {
  apartment: ["شقة", "شقق", "apartment", "apartments", "flat", "apt", "apts"],
  duplex: ["دوبلكس", "duplex"],
  penthouse: ["بنتهاوس", "penthouse"],
  chalet: ["شاليه", "شاليهات", "chalet"],
  studio: ["استوديو", "استديو", "studio"],
  villa: ["فيلا", "فيلات", "فيلا مستقلة", "villa", "villas", "standalone", "stand alone"],
  townhouse: ["تاون هاوس", "تاون", "townhouse", "town house"],
  twinhouse: ["توين هاوس", "توين", "twin house", "twinhouse"],
  office: ["مكتب", "مكاتب", "مكتب اداري", "office", "offices"],
  shop: ["محل تجاري", "محل", "محلات", "shop", "retail"],
  clinic: ["عيادة", "عيادات", "clinic"],
  commercial: ["تجاري", "commercial"],
  land: ["أرض", "ارض", "land", "plot"]
};

/** Rows for the search_vocabulary table: { kind, key, terms } with normalized, space-joined terms. */
function vocabularyRows() {
  const rows = [];
  for (const [key, words] of Object.entries(TYPE_TERMS)) {
    rows.push({ kind: "type", key, terms: [...new Set(words.map(normalizeSearch))].join(" ") });
  }
  for (const f of Features.FEATURES) {
    rows.push({ kind: "feature", key: f.key, terms: [...new Set([f.ar, f.en, ...f.syn].map(normalizeSearch))].join(" ") });
  }
  return rows;
}

/** Replaces the stored vocabulary and place synonyms with the current dictionaries. */
async function seedVocabulary(client) {
  await client.query("DELETE FROM search_vocabulary");
  for (const r of vocabularyRows()) {
    await client.query("INSERT INTO search_vocabulary (kind, key, terms) VALUES ($1, $2, $3)", [r.kind, r.key, r.terms]);
  }
  await client.query("DELETE FROM compound_synonyms");
  for (const r of Places.synonymRows()) {
    await client.query(
      `INSERT INTO compound_synonyms (kind, key, synonym, synonym_norm, area_key, developer_key)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [r.kind, r.key, r.synonym, r.norm, r.area_key, r.developer_key]
    );
  }
}

module.exports = { TYPE_TERMS, vocabularyRows, seedVocabulary };
