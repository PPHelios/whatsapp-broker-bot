// tests/unit/features-delivery.test.js — domain/features.js dictionary and domain/delivery.js parsing
"use strict";

const F = require("../../domain/features");
const D = require("../../domain/delivery");

describe("Feature dictionary", () => {
  test("keys are unique and every feature has both labels", () => {
    const keys = F.FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of F.FEATURES) {
      expect(f.ar).toMatch(/[؀-ۿ]/);
      expect(f.en).not.toMatch(/[؀-ۿ]/);
    }
  });

  test("broker wording maps to keys in dictionary order", () => {
    expect(F.matchFeatureKeys("شقة بحري ناصية فيها غرفة مربية وفيو جاردن")).toEqual([
      "north_facing",
      "corner",
      "nanny_room",
      "view_garden"
    ]);
  });

  test("Arabic and English wording give the same keys", () => {
    expect(F.matchFeatureKeys("north facing corner unit with nanny room")).toEqual(
      F.matchFeatureKeys("بحري ناصية غرفة ناني")
    );
  });

  test("longer phrases win (فيو حديقة is a view, not a private garden)", () => {
    expect(F.matchFeatureKeys("فيو حديقة")).toEqual(["view_garden"]);
    expect(F.matchFeatureKeys("حديقة خاصة")).toEqual(["private_garden"]);
  });

  test("matching is whole-word (no feature inside an unrelated word)", () => {
    expect(F.matchFeatureKeys("acacia compound")).toEqual([]);
  });

  test("classifyFeatures keeps unknown extras as free text, never invents keys", () => {
    expect(F.classifyFeatures(["Nanny Room", "ناصية", "corner", "جاكوزي في الحمام", "north_facing"])).toEqual({
      keys: ["north_facing", "corner", "nanny_room"],
      other: ["جاكوزي في الحمام"]
    });
  });

  test("structured detail flags become keys", () => {
    expect(F.keysFromDetails({ has_nanny_room: true, orientation: "بحري", has_dressing_room: true, roof_area: 40 })).toEqual([
      "north_facing",
      "dressing_room",
      "nanny_room",
      "roof"
    ]);
  });

  test("labels per language, search terms bilingual", () => {
    expect(F.featureLabel("corner", "ar")).toBe("ناصية");
    expect(F.featureLabel("corner", "en")).toBe("Corner unit");
    expect(F.featureLabel("nope")).toBeNull();
    const terms = F.searchTermsFor(["corner"]);
    expect(terms).toEqual(expect.arrayContaining(["ناصية", "corner unit", "corner"]));
  });
});

describe("Delivery parsing", () => {
  const p = (x) => D.parseDelivery(x);
  test.each([
    ["2027", { delivery_year: 2027, delivery_quarter: null, is_ready: null }],
    ["Q3 2027", { delivery_year: 2027, delivery_quarter: 3 }],
    ["2027 Q3", { delivery_year: 2027, delivery_quarter: 3 }],
    ["تسليم ٢٠٢٨", { delivery_year: 2028 }],
    ["الربع التالت 2027", { delivery_year: 2027, delivery_quarter: 3 }],
    ["12/2026", { delivery_year: 2026, delivery_month: 12, delivery_quarter: 4 }],
    ["ديسمبر 2026", { delivery_year: 2026, delivery_month: 12 }],
    ["استلام فوري", { is_ready: true, delivery_year: null }],
    ["Ready to move", { is_ready: true }]
  ])("%s", (input, expected) => {
    expect(p(input)).toMatchObject(expected);
  });

  test("unknown wording keeps only the raw text (nothing guessed)", () => {
    expect(p("بعد سنتين")).toEqual({
      delivery_year: null,
      delivery_quarter: null,
      delivery_month: null,
      is_ready: null,
      delivery_raw: "بعد سنتين"
    });
    expect(p("")).toMatchObject({ delivery_raw: null, is_ready: null });
  });

  test("structured AI object is validated", () => {
    expect(p({ year: 2027, quarter: 9 })).toMatchObject({ delivery_year: 2027, delivery_quarter: null });
    expect(p({ ready: true })).toMatchObject({ is_ready: true });
    expect(p({ raw: "Q2 2029" })).toMatchObject({ delivery_year: 2029, delivery_quarter: 2 });
  });

  test("highlight formatting", () => {
    expect(D.formatDelivery({ delivery_year: 2027, delivery_quarter: 3 })).toBe("🗓 تسليم 2027 Q3");
    expect(D.formatDelivery({ is_ready: true })).toBe("🔑 استلام فوري");
    expect(D.formatDelivery({ is_ready: true }, "en")).toBe("🔑 Ready to move");
    expect(D.formatDelivery({})).toBeNull();
  });
});
