// tests/unit/search-english-compound.test.js — until Arabic compound names exist, a compound or area is matched by its
// English name (the unit text is English). A budget word next to a place must never become a place word.
"use strict";

const Q = require("../../domain/searchQuery");
const { buildSearchQuery, SEARCH_PROMPT } = require("../../services/search");

describe("English compound fallback", () => {
  test("a budget phrase next to a place name does not turn into a place word", () => {
    const f = Q.fallbackParse("عايز شقه ايجار ازاد 2+ غرف حتى 70 الف مفروشه").filters;
    expect(f.place_terms).not.toContain("حتي");
    expect(f.place_terms.join(" ")).not.toMatch(/حتي/);
    expect(f.price_max).toBe(70000);
    expect(f.furnishing).toBe("furnished");
  });

  test("the AI reading of an English compound name searches the English unit text", () => {
    const parsed = Q.normalizeAiSearch({
      filters: { listing_type: "rent", compound: "Azad", bedrooms_min: 2, price_max: 70000, furnishing: "furnished" }
    });
    expect(parsed.filters.place_terms).toEqual(["azad"]);
    const { sql, params } = buildSearchQuery("agency-1", parsed);
    expect(sql).toContain("l.search_text_normalized LIKE '%' || ");
    expect(params).toContain("azad");
  });

  test("the AI prompt asks for English compound and area names", () => {
    const prompt = SEARCH_PROMPT("x");
    expect(prompt).toMatch(/compound[^\n]*English/);
    expect(prompt).toMatch(/locations[^\n]*English/);
  });

  test("every known compound and area resolves from its English name", () => {
    const Places = require("../../domain/places");
    const entries = [...Object.entries(Places.COMPOUNDS || {}).map(([k, v]) => ["compound", k, v]), ...Object.entries(Places.AREAS || {}).map(([k, v]) => ["area", k, v])];
    expect(entries.length).toBeGreaterThan(0);
    for (const [kind, key, value] of entries) {
      const en = value && value.en;
      if (!en) continue;
      const hit = Places.resolvePlace(en);
      expect(hit && hit.key).toBe(key);
    }
  });
});
