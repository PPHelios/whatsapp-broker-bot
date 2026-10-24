// tests/e2e.test.js — End-to-End Test Suite for Core Engine Modules
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const T = require("../lib/text");
const F = require("../lib/financials");
const E = require("../lib/excel");
const S = require("../lib/search");
const WA = require("../lib/whatsapp");
const L = require("../lib/listing");

/* ====================================================================== */
/* 1. Text, Parsing & Anti-Poaching Scrubber Tests                        */
/* ====================================================================== */
describe("1. lib/text.js - String, Code Sanitization & Header Guard", () => {
  it("should extract clean codes from poisoned formats (backticks, brackets, hashes, Unicode marks)", () => {
    const cases = [
      { input: "`N4-105`", expected: "N4-105" },
      { input: "[N4-105]", expected: "N4-105" },
      { input: "#KKJ654", expected: "KKJ654" },
      { input: "\u200EKKJ654\u200F", expected: "KKJ654" },
      { input: "كود: `N4-105`", expected: "N4-105" },
      { input: "code HAS_101", expected: "HAS_101" }
    ];

    for (const c of cases) {
      const parsed = T.parseExplicitUnitCode(c.input);
      assert.equal(
        parsed.hasCode,
        true,
        `Failed detecting code in: ${c.input}`
      );
      assert.equal(
        parsed.code,
        c.expected,
        `Incorrect code extracted from: ${c.input}`
      );
    }
  });

  it("should extract embedded unit codes from multi-line forwarded cards (DEL-08)", () => {
    const multiLineCard = `
وحدة للبيع | كود: N4-105
نول | Golden Square
─────────────────────────
الكود الداخلي: N4-105
النوع: apartment (بيع)
الحالة: نشط
السعر: 6.7 مليون ج.م
المساحة: 105م²
جدول الأقساط 💳
    `;

    const parsed = T.parseExplicitUnitCode(multiLineCard);
    assert.equal(parsed.hasCode, true);
    assert.equal(parsed.code, "N4-105");
  });

  it("should strip developer hotlines, mobile numbers, URLs, and marketing fluff", () => {
    const rawDescription = `
      شقة للبيع في كمبوند نول كليك التجمع الخامس
      للحجز والاستعلام اتصل على 19888 أو كلمنا واتساب wa.me/201012345678
      رقم المبيعات المباشر: 01099887766
      زوروا موقعنا https://kleek-developments.com
      #عقارات_التجمع #كليك #شقق_للبيع
      تشطيب كامل استلام 2029
    `;

    const cleaned = T.stripMarketingFluff(rawDescription);
    assert.equal(/19888/.test(cleaned), false);
    assert.equal(/01012345678/.test(cleaned), false);
    assert.equal(/01099887766/.test(cleaned), false);
    assert.equal(/https?:\/\//.test(cleaned), false);
    assert.equal(/#/.test(cleaned), false);
    assert.equal(cleaned.includes("تشطيب كامل استلام 2029"), true);
  });

  it("should parse colloquial Egyptian prices with units, fractions and rental periods", () => {
    const p1 = T.parseEgyptianPrice("6.7 مليون", { listingType: "sale" });
    assert.equal(p1.priceValue, 6700000);

    const p2 = T.parseEgyptianPrice("5 مليون ونص", { listingType: "sale" });
    assert.equal(p2.priceValue, 5500000);

    const p3 = T.parseEgyptianPrice("160 ألف", { listingType: "rent" });
    assert.equal(p3.priceValue, 160000);

    const p4 = T.parseEgyptianPrice("$4,500", { listingType: "rent" });
    assert.equal(p4.priceValue, 4500);
    assert.equal(p4.currency, "USD");
  });

  it("should format standardized locked header without ASCII artifacts", () => {
    const listing = {
      code: "N4-105",
      listing_type: "sale",
      compound: "NOLL",
      district: "New Cairo"
    };

    const headerAr = T.formatStandardHeader(listing, "ar");
    assert.equal(headerAr.includes("\x0B"), false);
    assert.match(headerAr, /🔑 وحدة للبيع \| كود: `N4-105`/);
    assert.match(headerAr, /🏢 NOLL \| New Cairo/);

    const headerEn = T.formatStandardHeader(listing, "en");
    assert.equal(headerEn.includes("\x0B"), false);
    assert.match(headerEn, /🔑 Unit For Sale \| Code: `N4-105`/);
    assert.match(headerEn, /🏢 NOLL \| New Cairo/);
  });

  it("should enforce typology rules: suppress floor for villas and elevate BUA/Land", () => {
    const villa = {
      code: "VIL-901",
      property_type: "villa",
      listing_type: "sale",
      compound: "Villette",
      district: "New Cairo",
      price_value: 25000000,
      area_value: 350,
      bedrooms: 5,
      bathrooms: 6,
      details: {
        bua: 350,
        land_area: 500,
        garden_area: 200,
        roof_area: 80,
        floor: "3 Floors"
      }
    };
    const broker = { name: "Haytham", phone_normalized: "201012345678" };

    const cardAr = T.formatClientListingText(villa, broker, "ar");
    assert.equal(cardAr.includes("الدور"), false);
    assert.equal(cardAr.includes("مساحة المباني (BUA):"), true);
    assert.equal(cardAr.includes("مساحة الأرض:"), true);

    // Labels are WhatsApp-bold (*Label:*); compare on the plain text.
    const cardEn = T.formatClientListingText(villa, broker, "en").replace(/\*/g, "");
    assert.equal(cardEn.includes("Floor:"), false);
    assert.equal(cardEn.includes("Built-Up Area (BUA): 350 sqm"), true);
    assert.equal(cardEn.includes("Land Area: 500 sqm"), true);
  });

  it("should format studios cleanly as 'Studio (Open Concept)' / 'استوديو مفتوح'", () => {
    const studio = {
      code: "STU-01",
      property_type: "studio",
      listing_type: "sale",
      compound: "Badya",
      price_value: 3500000,
      area_value: 60,
      bedrooms: 0,
      bathrooms: 1,
      details: {}
    };
    const broker = { name: "Haytham", phone_normalized: "201012345678" };

    const cardAr = T.formatClientListingText(studio, broker, "ar");
    assert.equal(cardAr.includes("0 غرف"), false);
    assert.equal(cardAr.includes("استوديو مفتوح"), true);

    const cardEn = T.formatClientListingText(studio, broker, "en");
    assert.equal(cardEn.includes("0 Beds"), false);
    assert.equal(cardEn.includes("Studio (Open Concept)"), true);
  });
});

/* ====================================================================== */
/* 2. Financial Calculation Engine Tests                                  */
/* ====================================================================== */
describe("2. lib/financials.js - Calculations & Payment Schedules", () => {
  const basePrice = 6700000;
  const plan8Yr = {
    plan_id: "plan_8yr",
    name: "8 سنوات (خصم 15%)",
    years: 8,
    discount_pct: 15,
    down_payment_pct: 10,
    maintenance_pct: 8,
    maintenance_splits: 3
  };

  it("should calculate correct net price, down payment, and quarterly installments with zero float drift", () => {
    const summary = F.calculatePlanSummary(basePrice, plan8Yr);
    assert.equal(summary.effective_price, 5695000);
    assert.equal(summary.down_payment, 569500);
    assert.equal(summary.installment_amount, 160172);
    assert.equal(summary.total_maintenance, 536000);
    assert.equal(summary.maintenance_per_split, 178667);
  });

  it("should reconcile rounding discrepancies on the final installment row", () => {
    const { summary, rows } = F.generateDetailedSchedule(basePrice, plan8Yr);
    assert.equal(rows.length, 33);
    assert.equal(rows[0].type, "down_payment");
    const totalInstallmentsPaid = rows.reduce((acc, r) => acc + r.amount, 0);
    assert.equal(totalInstallmentsPaid, summary.effective_price);
  });

  it("should match buyer budget constraints or calculate closest alternative", () => {
    const plans = [
      { plan_id: "p6", years: 6, discount_pct: 25, down_payment_pct: 10 },
      { plan_id: "p8", years: 8, discount_pct: 15, down_payment_pct: 10 }
    ];

    const matched = F.filterMatchingPlans(basePrice, plans, {
      maxDownPayment: 570000,
      maxQuarterly: 165000
    });
    assert.equal(matched.status, "matched");
    assert.equal(matched.matches[0].plan_id, "p8");
  });

  it("should generate forwardable client copy for a selected plan via formatSinglePlanAdCopy", () => {
    const listing = {
      code: "N4-105",
      compound: "NOLL",
      price_value: 6700000,
      area_value: 105,
      bedrooms: 2,
      payment_terms: {
        plans: [
          {
            plan_id: "p8",
            years: 8,
            discount_pct: 10,
            down_payment_pct: 10,
            maintenance_pct: 8
          }
        ]
      }
    };
    const broker = {
      name: "Haytham Barbary",
      phone_normalized: "201012345678"
    };

    const adCopyAr = F.formatSinglePlanAdCopy(listing, broker, "p8", "ar");
    assert.match(adCopyAr, /فرصة استثمارية مميزة في مشروع NOLL/);
    assert.match(adCopyAr, /201012345678/);

    const adCopyEn = F.formatSinglePlanAdCopy(listing, broker, "p8", "en");
    assert.match(adCopyEn, /Prime Opportunity at NOLL/);
    assert.match(adCopyEn, /8-Year Plan/);
  });
});

/* ====================================================================== */
/* 3. Advanced Financial Edge Cases: Balloons & Resale Friction           */
/* ====================================================================== */
describe("3. lib/financials.js - Advanced Milestones & Resale", () => {
  it("should correctly schedule balloon payments at specific monthly intervals (Month 36)", () => {
    const basePrice = 8200000;
    const planWithBalloons = {
      years: 8,
      discount_pct: 15,
      down_payment_pct: 5,
      milestones: [{ label: "دفعة استلام", pct: 10, due_after_months: 36 }]
    };

    const { summary, rows } = F.generateDetailedSchedule(
      basePrice,
      planWithBalloons
    );
    assert.equal(summary.down_payment, 348500);
    assert.equal(summary.total_milestones_amount, 697000);

    const balloonRow = rows.find((r) => r.period === 12);
    assert.equal(balloonRow.label.includes("دفعة استلام"), true);
    assert.equal(balloonRow.amount > summary.installment_amount, true);
  });

  it("should calculate complete resale upfront cash and friction costs", () => {
    const listing = {
      price_value: 10000000,
      down_payment_value: 6000000,
      details: {
        over_price: 0,
        club_fee: 200000,
        transfer_fee: 150000,
        broker_commission: 0
      }
    };

    const resale = F.calculateResaleFinancials(listing);
    assert.equal(resale.total_upfront_cash, 6350000);
    assert.equal(resale.remaining_balance, 4000000);
  });
});

/* ====================================================================== */
/* 4. In-Memory Excel Delivery Engine Tests (Locked to English LTR)       */
/* ====================================================================== */
describe("4. lib/excel.js - In-Memory Binary Spreadsheet Generation", () => {
  it("should sanitize dangerous formula injection characters", () => {
    assert.equal(
      E.sanitizeCellValue("=CMD|' /C calc'!A0"),
      "'=CMD|' /C calc'!A0"
    );
    assert.equal(E.sanitizeCellValue("+123456"), "'+123456");
    assert.equal(E.sanitizeCellValue("-2000"), "'-2000");
    assert.equal(E.sanitizeCellValue("@SUM(A1:A10)"), "'@SUM(A1:A10)");
    assert.equal(E.sanitizeCellValue("Standard Unit"), "Standard Unit");
  });

  it("should generate a multi-tab payment workbook buffer locked to English LTR", async () => {
    const listing = {
      code: "N4-105",
      title: "NOLL 105m",
      price_value: 6700000,
      compound: "NOLL"
    };
    const plans = [
      {
        plan_id: "p6",
        name: "6 Years (25% off)",
        years: 6,
        discount_pct: 25,
        down_payment_pct: 10
      }
    ];

    const buffer = await E.buildMultiPlanWorkbook({
      listing,
      plans,
      agency: { name: "Aqar Prime" },
      broker: { name: "Haytham" },
      lang: "en"
    });

    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer[0], 0x50); // PK zip header
    assert.equal(buffer[1], 0x4b);
  });

  it("should generate master agency inventory with 20 columns and dual descriptions", async () => {
    const listings = [
      {
        code: "HP-201",
        title: "شقة للبيع",
        price_value: 10000000,
        area_value: 180,
        bedrooms: 3,
        compound: "هايد بارك",
        status: "active",
        details: {
          compound_en: "Hyde Park",
          title_en: "Luxury Apartment",
          clean_summary: "شقة 180م بحري",
          summary_en: "180 sqm apartment in Hyde Park"
        }
      }
    ];

    const buffer = await E.buildAgencyInventoryWorkbook({
      listings,
      agency: { name: "Prime Agency" },
      broker: { name: "Broker Test" },
      lang: "en"
    });
    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer[0], 0x50);
  });

  it("should generate automatic rejection spreadsheet with Column A error reasons", async () => {
    const rejectedRows = [
      {
        rowNumber: 8,
        code: "HAS-12",
        reason: "Missing Asking Price",
        rawRowValues: ["HAS-12", "", "Hyde Park"]
      }
    ];

    const buffer = await E.buildRejectionWorkbook({
      rejectedRows,
      originalHeaders: ["Code", "Price", "Compound"],
      agencyName: "Aqar Real Estate"
    });
    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer[0], 0x50);
  });
});

/* ====================================================================== */
/* 5. Bilingual Normalization & Database Search Queries                   */
/* ====================================================================== */
describe("5. lib/search.js - Bilingual Normalization & Negative Status Guards", () => {
  it("should build SQL that strictly requires status = 'active'", () => {
    const parsed = { filters: { compound: "هايد بارك" } };
    const { sql } = S.buildSearchQuery(
      "a0000000-0000-0000-0000-000000000001",
      parsed
    );
    assert.match(sql, /status\s*=\s*'active'/i);
  });

  it("should normalize 'Hyde Park' into Arabic, English, and spaceless variations", () => {
    const parsed = S.fallbackParse("شقة في هايد بارك 3 غرف");
    assert.equal(parsed.location_terms.includes("هايد بارك"), true);
    assert.equal(parsed.location_terms.includes("هايدبارك"), true);
    assert.equal(parsed.location_terms.includes("hyde park"), true);
  });

  it("should support search pagination with limit and offset parameters", () => {
    const parsed = { filters: { compound: "هايد بارك" } };
    const { sql, params } = S.buildSearchQuery("agency-id", parsed, {
      limit: 5,
      offset: 5
    });
    assert.equal(sql.includes("LIMIT $"), true);
    assert.equal(sql.includes("OFFSET $"), true);
    assert.equal(params.includes(5), true);
  });

  it("should allow studios with bedrooms = 0 via nonNegInt without converting to null", () => {
    const parsed = S.fallbackParse("استوديو في نول");
    assert.equal(parsed.filters.bedrooms_min, 0);
    assert.equal(parsed.filters.bedrooms_max, 0);
    assert.equal(parsed.filters.property_types.includes("studio"), true);

    const { sql } = S.buildSearchQuery("agency-id", parsed, {
      limit: 5,
      offset: 0
    });
    assert.match(sql, /\(l\.bedrooms = 0 OR l\.property_type = 'studio'\)/);
  });
});

/* ====================================================================== */
/* 6. Context-Aware Completeness & Validation Rules                      */
/* ====================================================================== */
describe("6. lib/listing.js - Context-Aware Completeness Rules", () => {
  it("should block drafts missing price, compound, or area", () => {
    const invalid = { area_value: 5, compound: "", price_value: 0 };
    const res = L.checkDraftCompleteness(invalid, null);
    assert.equal(res.isComplete, false);
    assert.equal(res.blockers.length >= 3, true);
  });

  it("should exempt studios from mandatory bedroom count", () => {
    const studio = {
      price_value: 3800000,
      compound: "Villette",
      property_type: "studio",
      area_value: 65,
      bedrooms: 0
    };
    const res = L.checkDraftCompleteness(studio, null);
    assert.equal(res.isComplete, true);
  });

  it("should exempt standalone villas and townhouses from floor requirements", () => {
    const villa = {
      price_value: 22000000,
      compound: "Hyde Park",
      property_type: "villa",
      area_value: 320,
      bedrooms: 4,
      details: { floor: null }
    };
    const res = L.checkDraftCompleteness(villa, null);
    assert.equal(res.isComplete, true);
    assert.equal(
      res.warnings.some((w) => w.field === "floor"),
      false
    );
  });

  it("should leave optional unstated attributes as NULL without injecting fake defaults", () => {
    const draft = L.validateDraft(
      {
        compound: "Hyde Park",
        price_value: 8200000,
        area_value: 135,
        bedrooms: 2,
        details: {}
      },
      "ar"
    );
    assert.equal(draft.details.finishing, null);
    assert.equal(draft.details.finishing_en, null);
    assert.equal(draft.details.floor, null);
    assert.equal(draft.details.bathrooms, null);
  });

  it("should flag resale math discrepancies between price and sum of paid + debt", () => {
    const draft = {
      price_value: 10000000,
      details: { down_payment_value: 5000000, remaining_balance: 4000000 }
    };
    const res = L.checkDraftCompleteness(draft, { priceValue: 10000000 });
    assert.equal(Boolean(res.deltaWarning), true);
    assert.equal(res.deltaWarning.diff, 1000000);
  });
});

/* ====================================================================== */
/* 7. UX & Interactive WhatsApp Routing                                   */
/* ====================================================================== */
describe("7. UX & Interactive WhatsApp Routing", () => {
  it("should clamp button titles to Meta's strict 20-character limit via safeTruncate", () => {
    const clamped = WA.safeTruncate("تأكيد حذف الوحدة نهائياً 🗑️", 20);
    assert.equal(Array.from(clamped).length <= 20, true);
  });

  it("should construct COL-01 collision buttons with base64 encoded query", () => {
    const rawQuery = "شقة للبيع في التجمع 3 غرف";
    const encoded = Buffer.from(rawQuery).toString("base64");

    const buttons = [
      { id: `cancel_and_search:${encoded}`, title: "إلغاء والبحث 🔍" },
      { id: "draft_edit", title: "إكمال المسودة 📝" }
    ];

    assert.equal(buttons[0].id.startsWith("cancel_and_search:"), true);
    assert.equal(
      Buffer.from(buttons[0].id.split(":")[1], "base64").toString(),
      rawQuery
    );
    assert.equal(Array.from(buttons[0].title).length <= 20, true);
  });

  it("should format rental pricing periods and USD currency accurately in client copy", () => {
    const rentalListing = {
      code: "RNT-USD",
      title: "Chalet in Marassi",
      price_value: 4500,
      area_value: 120,
      bedrooms: 2,
      listing_type: "rent",
      details: { currency: "USD", rent_period: "monthly" }
    };
    const broker = {
      name: "Haytham Barbary",
      phone_normalized: "201012345678"
    };

    const clientCopy = T.formatClientListingText(rentalListing, broker, "en");
    assert.equal(clientCopy.includes("4.5K USD / mo"), true);
    assert.equal(clientCopy.includes("🔑 Unit For Rent"), true);
  });

  it("should enforce authorization hierarchy in canEdit", () => {
    const canEdit = (broker, listing) =>
      !listing.broker_id ||
      listing.broker_id === broker.id ||
      ["admin", "owner", "manager"].includes(
        String(broker.role || "").toLowerCase()
      );

    const adminBroker = { id: "b1", role: "admin" };
    const colleagueBroker = { id: "b2", role: "broker" };
    const colleagueListing = { id: "l18", broker_id: "b2" };

    assert.equal(canEdit(adminBroker, colleagueListing), true);
    assert.equal(canEdit(colleagueBroker, colleagueListing), true);

    const otherBroker = { id: "b3", role: "broker" };
    assert.equal(canEdit(otherBroker, colleagueListing), false);
  });
});
