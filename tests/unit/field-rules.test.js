// tests/unit/field-rules.test.js — domain/fieldRules.js (the Release 1 field table) and extraction normalization
"use strict";

const R = require("../../domain/fieldRules");
const L = require("../../lib/listing");

const fields = (r) => r.map((x) => x.field);
const base = { listing_type: "sale", property_type: "apartment", compound: "Mivida", area_value: 150, bedrooms: 3, price_value: 8e6 };

describe("Mandatory fields (block saving)", () => {
  test("all units: sale/rent, type, compound (or district and city), area, price", () => {
    const r = R.evaluate({});
    expect(fields(r.blockers)).toEqual(["listing_type", "property_type", "location", "area_value", "price_value"]);
    expect(R.evaluate({ ...base, compound: null, district: "التجمع", city: "القاهرة الجديدة" }).ok).toBe(true);
    expect(fields(R.evaluate({ ...base, compound: null, district: "التجمع" }).blockers)).toEqual(["location"]);
  });

  test("apartment, duplex, penthouse need bedrooms", () => {
    for (const t of ["apartment", "duplex", "penthouse"]) {
      expect(fields(R.evaluate({ ...base, property_type: t, bedrooms: null }).blockers)).toEqual(["bedrooms"]);
    }
  });

  test("studio: bedrooms set to 0 automatically; a 0-bedroom apartment becomes a studio", () => {
    const r = R.evaluate({ ...base, property_type: "studio", bedrooms: null });
    expect(r.ok).toBe(true);
    expect(r.listing.bedrooms).toBe(0);
    expect(R.evaluate({ ...base, bedrooms: 0 }).listing.property_type).toBe("studio");
  });

  test("villa, townhouse, twin house need bedrooms; area means BUA", () => {
    const r = R.evaluate({ ...base, property_type: "townhouse", bedrooms: null, area_value: null });
    expect(fields(r.blockers)).toEqual(["bua", "bedrooms"]);
  });

  test("office, shop, clinic: no bedrooms asked, none stored", () => {
    for (const t of ["office", "shop", "clinic"]) {
      const r = R.evaluate({ ...base, property_type: t, bedrooms: 2 });
      expect(r.ok).toBe(true);
      expect(r.listing.bedrooms).toBeNull();
    }
  });

  test("resale with installments: two of total, paid, remaining; the third is derived", () => {
    const one = R.evaluate({ ...base, price_value: null, remaining_amount: 6e6 });
    expect(fields(one.blockers)).toEqual(["resale_two_of_three"]);
    expect(R.evaluate({ ...base, price_value: null, down_payment_value: 4e6, remaining_amount: 6e6 }).listing.price_value).toBe(10e6);
    expect(R.evaluate({ ...base, price_value: 10e6, remaining_amount: 6e6 }).listing.down_payment_value).toBe(4e6);
    expect(R.evaluate({ ...base, price_value: 10e6, down_payment_value: 4e6 }).listing.remaining_amount).toBe(6e6);
  });

  test("primary: price plus a plan (down %, years) or a cash price", () => {
    const p = { ...base, market: "primary" };
    expect(fields(R.evaluate(p).blockers)).toEqual(["primary_plan"]);
    expect(R.evaluate({ ...p, payment_terms: { plans: [{ down_payment_pct: 10, years: 8 }] } }).ok).toBe(true);
    expect(R.evaluate({ ...p, payment_terms: { cash_price: 7e6 } }).ok).toBe(true);
  });

  test("rent: monthly rent", () => {
    expect(fields(R.evaluate({ ...base, listing_type: "rent", price_value: null }).blockers)).toEqual(["monthly_rent"]);
  });
});

describe("Warnings (add/edit only)", () => {
  test("all units: photos and finishing", () => {
    expect(fields(R.evaluate({ ...base, bathrooms: 2, floor_level: 3, is_ready: true }, { photoCount: 0 }).warnings)).toEqual([
      "photos",
      "finishing"
    ]);
  });

  test("apartment: bathrooms, floor; villa: land area, bathrooms; office: floor", () => {
    const w = (l) => fields(R.evaluate({ ...base, finishing: "semi_finished", is_ready: true, ...l }).warnings);
    expect(w({})).toEqual(["bathrooms", "floor"]);
    expect(w({ property_type: "villa" })).toEqual(["land_area", "bathrooms"]);
    expect(w({ property_type: "office" })).toEqual(["floor"]);
  });

  test("resale cash: delivery or ready", () => {
    const w = fields(R.evaluate({ ...base, finishing: "x", bathrooms: 2, floor_level: 1 }).warnings);
    expect(w).toEqual(["delivery_or_ready"]);
  });

  test("resale installments: amount, frequency, end date, delivery, and a mismatch over 100 EGP", () => {
    const l = { ...base, finishing: "x", bathrooms: 2, floor_level: 1, price_value: 10e6, down_payment_value: 4e6, remaining_amount: 5.9e6 };
    expect(fields(R.evaluate(l).warnings)).toEqual(["installment_value", "payment_frequency", "installments_end", "delivery", "resale_mismatch"]);
    const within = { ...l, remaining_amount: 6e6 - 100 };
    expect(fields(R.evaluate(within).warnings)).not.toContain("resale_mismatch");
  });

  test("primary: project or developer, delivery, maintenance terms", () => {
    const l = { ...base, finishing: "x", bathrooms: 2, floor_level: 1, market: "primary", payment_terms: { cash_price: 7e6 } };
    expect(fields(R.evaluate(l).warnings)).toEqual(["project_or_developer", "delivery", "maintenance"]);
  });

  test("rent: furnished status", () => {
    const l = { ...base, listing_type: "rent", finishing: "x", bathrooms: 2, floor_level: 1 };
    expect(fields(R.evaluate(l).warnings)).toEqual(["furnishing"]);
  });

  test("warning lines read 'غير مسجل'", () => {
    const [w] = R.evaluate({ ...base, finishing: "x", bathrooms: 2, floor_level: 1 }).warnings;
    expect(R.warningLine(w, "ar")).toBe("⚠️ موعد التسليم (أو استلام فوري) غير مسجل");
    expect(R.warningLine(w, "en")).toBe("⚠️ Delivery (or ready to move) not recorded");
  });
});

describe("Extraction normalization (never invents)", () => {
  test("empty AI output gives empty fields, no defaults", () => {
    const f = L.normalizeExtraction({});
    expect(f).toMatchObject({
      listing_type: null,
      property_type: null,
      price_value: null,
      finishing: null,
      payment_frequency: null,
      maintenance_pct: null,
      delivery_year: null,
      is_ready: null,
      feature_keys: [],
      features_other: []
    });
    expect(f.details).toEqual({});
    expect(f.market).toBeNull();
  });

  test("features: keys kept, labels mapped, unknown extras free text", () => {
    const f = L.normalizeExtraction({ features: ["corner", "بحري", "made-up-key"], features_other: ["جاكوزي"] });
    expect(f.feature_keys).toEqual(["north_facing", "corner"]);
    expect(f.features_other).toEqual(["made-up-key", "جاكوزي"]);
  });

  test("resale schedule: frequency aliases, end date from 'YYYY-MM' or from years left", () => {
    const f = L.normalizeExtraction({ resale: { installment_frequency: "semi-annual", installments_end: "2031-06" } });
    expect(f.payment_frequency).toBe("semi_annual");
    expect(f.installments_end).toBe("2031-06-01");
    const g = L.normalizeExtraction({ resale: { installment_years: 6 } }, { now: new Date("2026-10-24") });
    expect(g.installments_end).toBe("2032-10-01");
  });

  test("primary plans and market", () => {
    const f = L.normalizeExtraction({ primary: { plans: [{ down_payment_pct: "10", years: 8, frequency: "Quarterly" }] } });
    expect(f.market).toBe("primary");
    expect(f.payment_terms.plans).toEqual([{ plan_id: "p1", down_payment_pct: 10, years: 8, frequency: "quarterly", delivery_pct: null }]);
  });

  test("villa area is BUA and never has a floor", () => {
    const f = L.normalizeExtraction({ property_type: "villa", area_value: 400, floor: "الأول", floor_level: 1 });
    expect(f.floor_level).toBeNull();
    expect(f.details.floor).toBeUndefined();
    expect(f.details.bua).toBe(400);
  });

  test("a stated code is found in text only when explicit", () => {
    expect(L.findStatedCode(["شقة كود n4-105"])).toBe("N4-105");
    expect(L.findStatedCode(["#VIL-08 فيلا"])).toBe("VIL-08");
    expect(L.findStatedCode(["شقة 3 غرف 150 متر"])).toBeNull();
  });

  test("composeFields: stated value wins, unstated keeps the existing one; features merge", () => {
    const existing = { price_value: 7e6, bedrooms: 3, feature_keys: ["corner"], details: { floor: "الثالث" } };
    const out = L.composeFields({ existing, draft: { price_value: 8e6, bedrooms: null, feature_keys: ["north_facing"], details: {} } });
    expect(out).toMatchObject({ price_value: 8e6, bedrooms: 3, feature_keys: ["north_facing", "corner"] });
    expect(out.details.floor).toBe("الثالث");
  });
});

describe("Earlier search JSON shape (location_terms)", () => {
  const Q = require("../../domain/searchQuery");
  test("location_terms resolve to places when no compound is named", () => {
    const r = Q.normalizeAiSearch({ filters: { bedrooms_min: 3, bedrooms_max: 3 }, location_terms: ["fifth settlement", "التجمع الخامس"] });
    expect(r.filters.places).toEqual([{ kind: "area", key: "new_cairo" }]);
  });
  test("a named compound is the boundary: area terms do not widen it", () => {
    const r = Q.normalizeAiSearch({ filters: { compound: "Hyde Park" }, location_terms: ["hyde park", "new cairo"] });
    expect(r.filters.places).toEqual([{ kind: "compound", key: "hyde_park" }]);
  });
});
