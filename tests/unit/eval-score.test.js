// tests/unit/eval-score.test.js — The AI quality scorer must be right before its numbers drive decisions.
"use strict";

const { scoreExtraction } = require("../eval/score");

test("a fully correct extraction scores every field", () => {
  const out = {
    property_type: "apartment",
    listing_type: "sale",
    compound_en: "Madinaty",
    area_value: 150,
    bedrooms: 3,
    bathrooms: 2,
    price_value: 8500000,
    details: { floor: "الدور الرابع", floor_en: "4th Floor", finishing: "تشطيب كامل", finishing_en: "Fully Finished" }
  };
  const r = scoreExtraction(
    { property_type: "apartment", listing_type: "sale", compound: "Madinaty", area_value: 150, bedrooms: 3, bathrooms: 2, floor: 4, finishing: "fully_finished", price_value: 8500000 },
    out
  );
  expect(r).toEqual({ correct: 9, total: 9, misses: [] });
});

test("a wrong price, an ignored correction and an invented price are misses", () => {
  expect(scoreExtraction({ price_value: 11500000 }, { price_value: 12000000 }).misses[0]).toEqual({
    field: "price_value",
    expected: 11500000,
    got: 12000000
  });
  expect(scoreExtraction({ price_value: null }, { price_value: 5000000 }).correct).toBe(0);
  expect(scoreExtraction({ price_value: null }, { price_value: null }).correct).toBe(1);
});

test("tolerant matching: Arabic floor ordinals, orientation, compound prefix, resale fields", () => {
  const out = {
    compound: "بالم هيلز",
    compound_en: "Palm Hills",
    price_value: 10000000,
    details: { floor: "العاشر", orientation: "بحري", total_upfront_cash: 4000000, remaining_balance: 6000000 }
  };
  const r = scoreExtraction(
    { compound: "Palm Hills October", floor: 10, orientation: "north", total_upfront_cash: 4000000, remaining_debt: 6000000 },
    out
  );
  expect(r.misses).toEqual([]);
});

test("short English compound names count as a prefix match (ZED, NOLL)", () => {
  expect(scoreExtraction({ compound: "ZED Sheikh Zayed" }, { compound: "زد", compound_en: "Zed" }).correct).toBe(1);
  expect(scoreExtraction({ compound: "ZED Sheikh Zayed" }, { compound: "", compound_en: "Ze" }).correct).toBe(0);
});

test("down payment % can be derived from the amount; commercial accepts retail/shop", () => {
  expect(scoreExtraction({ down_payment_pct: 10 }, { price_value: 11000000, details: { down_payment_value: 1100000 } }).correct).toBe(1);
  expect(scoreExtraction({ property_type: "commercial", bedrooms: null }, { property_type: "retail", bedrooms: 0 }).correct).toBe(2);
});

test("unparseable output scores zero", () => {
  expect(scoreExtraction({ area_value: 150, bedrooms: 3 }, null)).toMatchObject({ correct: 0, total: 2 });
});
