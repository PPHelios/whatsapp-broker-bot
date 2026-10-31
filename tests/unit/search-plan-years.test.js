// tests/unit/search-plan-years.test.js — "على ٨ سنين" (a payment plan of N years) is a filter, never a place word.
"use strict";

const Q = require("../../domain/searchQuery");
const L = require("../../domain/searchLink");
const { buildSearchQuery } = require("../../services/search");
const { emptyFilters } = Q;

describe("payment plan years", () => {
  test("the reported query finds installment units by plan length, not by the word سنين", () => {
    const parsed = Q.fallbackParse("شقه قسط علي ٨ سنين");
    expect(parsed.filters.place_terms).toEqual([]);
    expect(parsed.filters.payment_years).toBe(8);
    expect(Q.classifyIntent(parsed)).toBe("search");
    const { sql, params } = buildSearchQuery("agency-1", parsed);
    expect(sql).toContain("l.installment_years >= $");
    expect(sql).toContain("(p->>'years')::numeric >= $");
    expect(params).toContain(8);
    expect(params.some((v) => v === "سنين")).toBe(false);
  });

  test("the same plan length from the AI parser (payment.years) and from the regex parser", () => {
    const ai = Q.normalizeAiSearch({ filters: { payment: { installments: true, years: 8 } } });
    expect(ai.filters.payment_years).toBe(8);
    expect(Q.fallbackParse("شقه قسط علي 8 سنين").filters.payment_years).toBe(8);
  });

  test("years outside 1-30 are ignored; a bare year word adds no filter", () => {
    expect(Q.normalizeAiSearch({ filters: { payment: { years: 0 } } }).filters.payment_years).toBeNull();
    expect(Q.normalizeAiSearch({ filters: { payment: { years: 80 } } }).filters.payment_years).toBeNull();
    expect(Q.fallbackParse("سنين").intent).toBe("other");
  });

  test("the web refine link keeps the plan length", () => {
    const f = Q.fallbackParse("شقه قسط علي ٨ سنين").filters;
    expect(L.decodeFilters(L.encodeFilters(f)).payment_years).toBe(8);
  });

  test("a down payment percent is a filter, not a place word", () => {
    for (const q of ["عايز شقه مقدم ١٠٪", "شقة مقدم 10%", "apartment 10% down"]) {
      const parsed = Q.fallbackParse(q);
      expect(parsed.filters.payment_down_pct).toBe(10);
      expect(parsed.filters.place_terms).toEqual([]);
      const { sql, params } = buildSearchQuery("agency-1", parsed);
      expect(sql).toContain("(p->>'down_payment_pct')::numeric = $");
      expect(params).toContain(10);
    }
  });

  test("a down payment amount still reads as an amount", () => {
    const f = Q.fallbackParse("شقة مقدم 500 الف").filters;
    expect(f.max_down_payment).toBe(500000);
    expect(f.payment_down_pct).toBeNull();
  });

  test("an empty filter set has no plan years", () => {
    expect(emptyFilters().payment_years).toBeNull();
  });
});
