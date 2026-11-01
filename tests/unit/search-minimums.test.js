// tests/unit/search-minimums.test.js — Haytham's rule (2026-11-01): a plain count of bedrooms, bathrooms or area is a
// minimum ("2 bedroom" = 2 or more); a budget is a ceiling only ("70k" = 70,000 or below, no lower bound).
"use strict";

const Q = require("../../domain/searchQuery");

const read = (text) => Q.fallbackParse(text).filters;

describe("counts and areas are minimums", () => {
  test.each([
    ["azad 2 bedroom budget 70 k", { bedrooms_min: 2, bedrooms_max: null, price_min: null, price_max: 70000 }],
    ["azad 2 bedroom budget 70k", { bedrooms_min: 2, bedrooms_max: null, price_min: null, price_max: 70000 }],
    ["شقة 3 غرف تحت 9 مليون", { bedrooms_min: 3, bedrooms_max: null, price_min: null, price_max: 9000000 }],
    ["apartment 3 bathrooms", { bathrooms_min: 3 }],
    ["apartment 150 sqm", { area_min: 150, area_max: null }],
    ["شقة 120 متر", { area_min: 120, area_max: null }]
  ])("%s", (text, want) => {
    const f = read(text);
    for (const [k, v] of Object.entries(want)) expect(f[k]).toBe(v);
  });

  test("a range still sets both ends", () => {
    const f = read("شقة من 120 لـ 150 متر");
    expect(f.area_min).toBe(120);
    expect(f.area_max).toBe(150);
  });

  test("a budget never sets a lower bound", () => {
    const f = read("azad fully furnished budget 70k");
    expect(f.price_min).toBeNull();
    expect(f.price_max).toBe(70000);
  });
});

describe("the search query uses the minimum and the ceiling", () => {
  const Search = require("../../services/search");
  const Q2 = require("../../domain/searchQuery");
  const build = (text, relaxed = false) => {
    const f = Q2.fallbackParse(text).filters;
    return Search.buildSearchQuery("00000000-0000-0000-0000-000000000000", f, { relaxed });
  };

  test("2 bedrooms, 70k budget: bedrooms >= 2 and price <= 70,000, never an exact bedroom match", () => {
    const { sql, params } = build("azad 2 bedroom budget 70k");
    expect(sql).toMatch(/l\.bedrooms >= \$\d+/);
    expect(sql).not.toMatch(/l\.bedrooms = \$\d+/);
    expect(sql).toMatch(/l\.price_value <= \$\d+/);
    expect(sql).not.toMatch(/l\.price_value >= \$\d+/);
    expect(params).toContain(70000);
  });
});
