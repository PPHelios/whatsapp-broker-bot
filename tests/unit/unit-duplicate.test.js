// tests/unit/unit-duplicate.test.js — P13: the one "looks like the same unit" rule.
"use strict";

const Dup = require("../../domain/unitDuplicate");

const base = { compound: "Hyde Park", listing_type: "sale", property_type: "apartment", bedrooms: 3, area_value: 150, price_value: 8500000 };

test("same compound (spelling folded), bedrooms and type; area and price within 5%", () => {
  expect(Dup.sameUnit({ ...base, compound: "hyde  park", area_value: 152, price_value: 8.4e6 }, base)).toBe(true);
  expect(Dup.sameUnit({ ...base, area_value: 160 }, base)).toBe(false);
  expect(Dup.sameUnit({ ...base, price_value: 9.5e6 }, base)).toBe(false);
  expect(Dup.sameUnit({ ...base, bedrooms: 2 }, base)).toBe(false);
  expect(Dup.sameUnit({ ...base, listing_type: "rent" }, base)).toBe(false);
  expect(Dup.sameUnit({ ...base, property_type: "duplex" }, base)).toBe(false);
  expect(Dup.sameUnit({ ...base, property_type: null }, base)).toBe(true);
  expect(Dup.sameUnit({ ...base, compound: "Mivida" }, base)).toBe(false);
});

test("no compound → the district, city or location", () => {
  const a = { ...base, compound: null, district: "التجمع الخامس" };
  expect(Dup.sameUnit(a, { ...base, compound: null, city: "التجمع الخامس" })).toBe(true);
  expect(Dup.sameUnit(a, { ...base, compound: "Hyde Park", district: "التجمع الخامس" })).toBe(true);
  expect(Dup.sameUnit(a, { ...base, compound: null, district: "الشيخ زايد" })).toBe(false);
  expect(Dup.placeKey({ district: "التجمع" })).toEqual({ district: "التجمع" });
});

test("without a place, an area or a price nothing is compared", () => {
  expect(Dup.sameUnit({ ...base, compound: null }, { ...base, compound: null })).toBe(false);
  expect(Dup.sameUnit({ ...base, price_value: null }, base)).toBe(false);
  expect(Dup.comparable(base)).toBe(true);
});
