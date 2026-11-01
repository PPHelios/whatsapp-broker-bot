// tests/unit/search-missing-and-typical.test.js — one number is a minimum (or a ceiling for price), "متكرر" is any floor
// above ground, a unit with no floor/area/bedrooms/bathrooms still matches, and "furnished" is filtered once.
"use strict";

const Q = require("../../domain/searchQuery");
const { buildSearchQuery } = require("../../services/search");

describe("single values, typical floors and missing fields", () => {
  test("an AI pair with equal ends is a minimum (bedrooms, area) or a ceiling (price)", () => {
    const f = Q.normalizeAiSearch({
      filters: { bedrooms_min: 2, bedrooms_max: 2, area_min: 150, area_max: 150, price_min: 70000, price_max: 70000 }
    }).filters;
    expect(f.bedrooms_min).toBe(2);
    expect(f.bedrooms_max).toBeNull();
    expect(f.area_min).toBe(150);
    expect(f.area_max).toBeNull();
    expect(f.price_min).toBeNull();
    expect(f.price_max).toBe(70000);
  });

  test("a real range keeps both ends", () => {
    const f = Q.normalizeAiSearch({ filters: { bedrooms_min: 2, bedrooms_max: 3, area_min: 120, area_max: 150 } }).filters;
    expect(f.bedrooms_min).toBe(2);
    expect(f.bedrooms_max).toBe(3);
    expect(f.area_min).toBe(120);
    expect(f.area_max).toBe(150);
  });

  test("exact floors are kept (the fifth floor is floor 5 on both ends)", () => {
    const f = Q.normalizeAiSearch({ filters: { floor_min: 5, floor_max: 5 } }).filters;
    expect(f.floor_min).toBe(5);
    expect(f.floor_max).toBe(5);
  });

  test("متكرر and typical mean any floor above ground, in both parsers", () => {
    expect(Q.fallbackParse("شقه متكرر").filters.floor_min).toBe(1);
    expect(Q.fallbackParse("apartment typical floor").filters.floor_min).toBe(1);
    expect(Q.fallbackParse("شقه متكرر").filters.place_terms).toEqual([]);
    expect(Q.normalizeAiSearch({ filters: { floor_min: 1 } }).filters.floor_min).toBe(1);
  });

  test("a unit with no floor, area, bedrooms or bathrooms still matches", () => {
    const { sql } = buildSearchQuery("agency-1", Q.normalizeAiSearch({
      filters: { bedrooms_min: 2, area_min: 100, bathrooms_min: 2, floor_min: 1 }
    }));
    expect(sql).toContain("(l.bedrooms IS NULL OR l.bedrooms >=");
    expect(sql).toContain("(l.area_value IS NULL OR l.area_value >=");
    expect(sql).toContain("(l.bathrooms IS NULL OR l.bathrooms >=");
    expect(sql).toContain("(l.floor_level IS NULL OR l.floor_level >=");
  });

  test("price and listing type stay strict for missing values", () => {
    const { sql } = buildSearchQuery("agency-1", Q.normalizeAiSearch({ filters: { price_max: 70000, listing_type: "rent" } }));
    expect(sql).toContain("l.price_value <=");
    expect(sql).not.toContain("l.price_value IS NULL");
    expect(sql).toContain("l.listing_type = ");
  });

  test("furnished is filtered once, not as both the furnishing and a feature key", () => {
    const { sql } = buildSearchQuery("agency-1", Q.normalizeAiSearch({ filters: { furnishing: "furnished", features: ["furnished"] } }));
    expect(sql).toContain("l.furnishing = ");
    expect(sql).not.toContain("feature_keys @>");
  });
});

describe("blank furnishing and finishing match either side", () => {
  test("a furnished or unfurnished search still includes units with furnishing blank", () => {
    for (const furnishing of ["furnished", "unfurnished"]) {
      const { sql } = buildSearchQuery("agency-1", Q.normalizeAiSearch({ filters: { furnishing } }));
      expect(sql).toContain("(l.furnishing IS NULL OR l.furnishing = ");
    }
  });

  test("a finishing filter includes units with finishing blank", () => {
    const { sql } = buildSearchQuery("agency-1", Q.normalizeAiSearch({ filters: { finishing: ["fully_finished"] } }));
    expect(sql).toContain("(l.finishing IS NULL OR l.finishing = ANY(");
  });
});
