// tests/unit/known-defects.test.js — Audit findings (plan Part 5) pinned as executable specs.
// Each test.failing documents a confirmed defect; the fixing batch flips it to test().
"use strict";

const F = require("../../lib/financials");
const T = require("../../lib/text");
const { createTestDb } = require("../harness/db");

jest.setTimeout(30000);

const BASE = 10000000;
const broker = { name: "B", phone_normalized: "201000000001" };
const planListing = (plan, extra = {}) => ({
  code: "DEV-1",
  price_value: BASE,
  property_type: "apartment",
  area_value: 120,
  bedrooms: 2,
  compound: "X",
  details: {},
  payment_terms: { plans: [{ plan_id: "p1", years: 5, down_payment_pct: 10, ...plan }] },
  ...extra
});
const line = (text, re) => text.split("\n").find((l) => re.test(l)) || "";

describe("Financial correctness (plan §5.4)", () => {
  test("baseline: schedule rows always sum to the effective price", () => {
    const d = F.generateDetailedSchedule(BASE, { years: 8, down_payment_pct: 10 }, new Date("2026-01-31"));
    expect(d.rows.reduce((s, r) => s + r.amount, 0)).toBe(BASE);
  });

  test.failing("F1: unknown maintenance % is not invented as 8% in client copy", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({}, { maintenance_pct: null }), broker, "p1", "ar");
    expect(line(copy, /صيانة/)).not.toMatch(/8%/);
  });

  test.failing("F2: maintenance is not scheduled at the end of an 8-year term when copy says 'before delivery'", () => {
    const d = F.generateDetailedSchedule(BASE, { years: 8, down_payment_pct: 10, maintenance_pct: 8 }, new Date("2026-01-01"));
    const maintYears = d.rows.filter((r) => r.maintenance_amount > 0).map((r) => Number(r.due_date.slice(-4)));
    expect(Math.max(...maintYears)).toBeLessThan(2033);
  });

  test.failing("F3: two milestones due in the same period are both scheduled", () => {
    const d = F.generateDetailedSchedule(
      BASE,
      { years: 2, down_payment_pct: 10, milestones: [{ pct: 10, due_after_months: 12, label: "A" }, { pct: 10, due_after_months: 12, label: "B" }] },
      new Date("2026-01-01")
    );
    const labels = d.rows.map((r) => r.label).join(" ");
    expect(labels).toMatch(/\bA\b/);
    expect(labels).toMatch(/\bB\b/);
  });

  test.failing("F4: a cash plan (years 0) has no empty quarterly installment rows", () => {
    const d = F.generateDetailedSchedule(BASE, { years: 0, down_payment_pct: 100 }, new Date("2026-01-01"));
    expect(d.rows.filter((r) => r.type === "installment" && r.amount === 0)).toHaveLength(0);
  });

  test.failing("F5: semi-annual installments are not labelled quarterly in Arabic copy", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({ frequency: "semi_annual" }), broker, "p1", "ar");
    expect(line(copy, /القسط/)).not.toMatch(/ربع سنوي/);
  });

  test.failing("F6: a studio is not described as '1 غرف نوم'", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({}, { bedrooms: 0, property_type: "studio" }), broker, "p1", "ar");
    expect(copy).not.toMatch(/1 غرف نوم/);
  });

  test.failing("F8: a monthly plan is compared against a quarterly budget in quarterly terms", () => {
    const r = F.filterMatchingPlans(BASE, [{ years: 8, down_payment_pct: 10, frequency: "monthly" }], { maxQuarterly: 150000 });
    expect(r.status).toBe("unmatched");
  });
});

describe("Client-facing output (plan §5.5)", () => {
  const villa = {
    code: "VIL-08",
    property_type: "townhouse",
    listing_type: "sale",
    compound: "Villette",
    price_value: 19500000,
    area_value: 260,
    bedrooms: 3,
    details: { bua: 260, land_area: 310, orientation: "بحري", finishing: "نصف تشطيب", bathrooms: 4 }
  };

  test("baseline: client copy prints the agency's own code", () => {
    expect(T.formatClientListingText(villa, broker, "ar")).toMatch(/VIL-08/);
  });

  test.failing("C1: English client copy contains no Arabic script", () => {
    const en = T.formatClientListingText(villa, broker, "en");
    const body = en.split("\n").filter((l) => !/VIL-08|Villette/.test(l)).join("\n");
    expect(body).not.toMatch(/[؀-ۿ]/);
  });

  test.failing("C3: monthly rent is not double-suffixed", () => {
    const rent = { ...villa, code: "RNT-1", listing_type: "rent", price_value: 85000 };
    expect(T.formatClientListingText(rent, broker, "ar")).not.toMatch(/شهر \/ شهرياً/);
  });

  test.failing("C4: an office with 0 bedrooms is not shown as a studio", () => {
    const office = { ...villa, code: "OFF-1", property_type: "office", bedrooms: 0, details: {} };
    expect(T.formatClientListingText(office, broker, "ar")).not.toMatch(/استوديو/);
  });
});

describe("Database triggers (plan §5.8c)", () => {
  let db;
  beforeAll(async () => {
    db = await createTestDb();
    await db.pool.query("INSERT INTO agencies (id, name) VALUES ('a0000000-0000-0000-0000-00000000000a', 'A')");
  });
  afterAll(() => db.pool.end());

  test.failing("D1: features written by the app are searchable (not overwritten by a later trigger)", async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO listings (agency_id, code, title, details)
       VALUES ('a0000000-0000-0000-0000-00000000000a', 'T-1', 'شقة', '{"features":["حمام سباحة"]}')
       RETURNING search_text_normalized`
    );
    expect(rows[0].search_text_normalized).toMatch(/سباحه|سباحة/);
  });

  test.failing("D2: stored and query-side Arabic normalization agree on Eastern digits", async () => {
    const { rows } = await db.pool.query("SELECT normalize_arabic('٣ غرف') a, clean_arabic_text('٣ غرف') b");
    expect(rows[0].a).toBe(rows[0].b);
  });
});
