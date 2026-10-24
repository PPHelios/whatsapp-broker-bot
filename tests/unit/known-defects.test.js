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

  test("F1: unknown maintenance % is not invented as 8% in client copy", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({}, { maintenance_pct: null }), broker, "p1", "ar");
    expect(line(copy, /صيانة/)).not.toMatch(/8%/);
  });

  test("F2: maintenance is not scheduled at the end of an 8-year term when copy says 'before delivery'", () => {
    // Delivery known (36 months): maintenance falls due at delivery, not in the last installments.
    const d = F.generateDetailedSchedule(BASE, { years: 8, down_payment_pct: 10, maintenance_pct: 8, delivery_after_months: 36 }, new Date("2026-01-01"));
    const maintYears = d.rows.filter((r) => r.maintenance_amount > 0).map((r) => Number(r.due_date.slice(-4)));
    expect(maintYears).toEqual([2029]);
    expect(d.rows.reduce((s, r) => s + r.maintenance_amount, 0)).toBe(800000);
    // Delivery unknown: nothing is scheduled; the summary says it is due on delivery.
    const u = F.generateDetailedSchedule(BASE, { years: 8, down_payment_pct: 10, maintenance_pct: 8 }, new Date("2026-01-01"));
    expect(u.rows.filter((r) => r.maintenance_amount > 0)).toHaveLength(0);
    expect(u.summary).toMatchObject({ total_maintenance: 800000, maintenance_due: "delivery", maintenance_scheduled: false });
  });

  test("F3: two milestones due in the same period are both scheduled", () => {
    const d = F.generateDetailedSchedule(
      BASE,
      { years: 2, down_payment_pct: 10, milestones: [{ pct: 10, due_after_months: 12, label: "A" }, { pct: 10, due_after_months: 12, label: "B" }] },
      new Date("2026-01-01")
    );
    const labels = d.rows.map((r) => r.label).join(" ");
    expect(labels).toMatch(/\bA\b/);
    expect(labels).toMatch(/\bB\b/);
  });

  test("F4: a cash plan (years 0) has no empty quarterly installment rows", () => {
    const d = F.generateDetailedSchedule(BASE, { years: 0, down_payment_pct: 100 }, new Date("2026-01-01"));
    expect(d.rows.filter((r) => r.type === "installment" && r.amount === 0)).toHaveLength(0);
  });

  test("F5: semi-annual installments are not labelled quarterly in Arabic copy", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({ frequency: "semi_annual" }), broker, "p1", "ar");
    expect(line(copy, /القسط/)).not.toMatch(/ربع سنوي/);
  });

  test("F6: a studio is not described as '1 غرف نوم'", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({}, { bedrooms: 0, property_type: "studio" }), broker, "p1", "ar");
    expect(copy).not.toMatch(/1 غرف نوم/);
  });

  test("F8: a monthly plan is compared against a quarterly budget in quarterly terms", () => {
    const r = F.filterMatchingPlans(BASE, [{ years: 8, down_payment_pct: 10, frequency: "monthly" }], { maxQuarterly: 150000 });
    expect(r.status).toBe("unmatched");
  });

  // F7, F9, F10 were defined in Release 1 step 4 from the code review.
  test("F7: annual installments are supported (not silently quarterly)", () => {
    const d = F.generateDetailedSchedule(BASE, { years: 5, down_payment_pct: 10, frequency: "annual" }, new Date("2026-01-01"));
    expect(d.rows.filter((r) => r.type === "installment")).toHaveLength(5);
    expect(d.rows[1].label).toMatch(/السنوي/);
  });

  test("F9: a fractional tenure gives a whole number of installments", () => {
    const s = F.calculatePlanSummary(BASE, { years: 2.5, down_payment_pct: 10, frequency: "semi_annual" });
    expect(s.total_installments_count).toBe(5);
    expect(Number.isInteger(s.total_installments_count)).toBe(true);
  });

  test("F10: unknown delivery / maintenance are not invented in the plan workbook or copy", () => {
    const copy = F.formatSinglePlanAdCopy(planListing({}, { maintenance_pct: null }), broker, "p1", "en");
    expect(copy).not.toMatch(/Under Construction|Ready to move|8%/);
    expect(copy).toMatch(/Maintenance: as per contract/);
    const src = require("fs").readFileSync(require("path").join(__dirname, "../../lib/excel.js"), "utf8");
    expect(src).not.toMatch(/\|\| "Ready"/);
    expect(src).not.toMatch(/Maintenance \(8%\)/);
  });

  test("Q-F: maintenance terms stored as data drive the copy", () => {
    const l = planListing({}, { maintenance_pct: null, payment_terms: { plans: [{ plan_id: "p1", years: 5, down_payment_pct: 10 }], maintenance: { pct: 10, due: "installments" } } });
    expect(F.maintenanceTerms({}, l)).toEqual({ pct: 10, due: "installments", splits: 1 });
    expect(F.formatSinglePlanAdCopy(l, broker, "p1", "ar")).toMatch(/الصيانة \(10%\): 1,000,000 ج.م \(مع الأقساط\)/);
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

  test("C1: English client copy contains no Arabic script", () => {
    const en = T.formatClientListingText(villa, broker, "en");
    const body = en.split("\n").filter((l) => !/VIL-08|Villette/.test(l)).join("\n");
    expect(body).not.toMatch(/[؀-ۿ]/);
  });

  test("C3: monthly rent is not double-suffixed", () => {
    const rent = { ...villa, code: "RNT-1", listing_type: "rent", price_value: 85000 };
    expect(T.formatClientListingText(rent, broker, "ar")).not.toMatch(/شهر \/ شهرياً/);
  });

  test("C4: an office with 0 bedrooms is not shown as a studio", () => {
    const office = { ...villa, code: "OFF-1", property_type: "office", bedrooms: 0, details: {} };
    expect(T.formatClientListingText(office, broker, "ar")).not.toMatch(/استوديو/);
  });

  // C2, C5, C6, C7 were defined in Release 1 step 4 from the code review.
  test("C2: client copy never contains internal data (owner, notes, commission, co-broker)", () => {
    const internal = { ...villa, details: { ...villa.details, owner_name: "OWNER-X", owner_phone: "01099998888", notes: "NOTE-X", commission: "2.5%", co_broker: "CB-X" } };
    for (const lang of ["ar", "en"]) {
      expect(T.formatClientListingText(internal, broker, lang)).not.toMatch(/OWNER-X|01099998888|NOTE-X|2\.5%|CB-X/);
    }
    expect(T.formatInternalListingDetails(internal, "ar")).toMatch(/OWNER-X/);
  });

  test("C5: unknown fields are left out (no '-' placeholders)", () => {
    const sparse = { code: "S-1", property_type: "apartment", listing_type: "sale", compound: "X", price_value: 5e6 };
    const copy = T.formatClientListingText(sparse, broker, "ar");
    expect(copy).not.toMatch(/: -|\| -|غير محدد/);
  });

  test("C6: structured delivery and feature keys appear in client copy", () => {
    const l = { ...villa, delivery_year: 2027, delivery_quarter: 3, feature_keys: ["corner", "view_garden"] };
    const ar = T.formatClientListingText(l, broker, "ar");
    expect(ar).toMatch(/🗓 تسليم 2027 Q3/);
    expect(ar).toMatch(/ناصية · فيو جاردن/);
  });

  test("C7: the plan copy names the unit type in the reader's language", () => {
    const ar = F.formatSinglePlanAdCopy(planListing({}), broker, "p1", "ar");
    expect(ar).not.toMatch(/apartment/);
    expect(ar).toMatch(/شقة/);
  });
});

describe("Database triggers (plan §5.8c)", () => {
  let db;
  beforeAll(async () => {
    db = await createTestDb();
    await db.pool.query("INSERT INTO agencies (id, name) VALUES ('a0000000-0000-0000-0000-00000000000a', 'A')");
  });
  afterAll(() => db.pool.end());

  test("D1: features written by the app are searchable (not overwritten by a later trigger)", async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO listings (agency_id, code, title, details)
       VALUES ('a0000000-0000-0000-0000-00000000000a', 'T-1', 'شقة', '{"features":["حمام سباحة"]}')
       RETURNING search_text_normalized`
    );
    expect(rows[0].search_text_normalized).toMatch(/سباحه|سباحة/);
  });

  test("D2: stored and query-side Arabic normalization agree on Eastern digits", async () => {
    const { rows } = await db.pool.query("SELECT normalize_arabic('٣ غرف') a, clean_arabic_text('٣ غرف') b");
    expect(rows[0].a).toBe(rows[0].b);
  });
});
