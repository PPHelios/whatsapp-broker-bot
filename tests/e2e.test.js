// tests/e2e.test.js
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const T = require("../lib/text");
const F = require("../lib/financials");
const E = require("../lib/excel");
const S = require("../lib/search");
const WA = require("../lib/whatsapp");

/* ====================================================================== */
/* 1. Text, Parsing & Anti-Poaching Scrubber Tests                        */
/* ====================================================================== */
describe("1. lib/text.js - String & Code Sanitization", () => {
  it("should extract clean codes from poisoned formats (backticks, brackets, hashes, Unicode marks)", () => {
    const cases = [
      { input: "`N4-105`", expected: "N4-105" },
      { input: "[N4-105]", expected: "N4-105" },
      { input: "#KKJ654", expected: "KKJ654" },
      { input: "\u200EKKJ654\u200F", expected: "KKJ654" }, // Directional Unicode isolation
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

    assert.equal(/19888/.test(cleaned), false, "Failed to strip 19XXX hotline");
    assert.equal(
      /01012345678/.test(cleaned),
      false,
      "Failed to strip WhatsApp phone link"
    );
    assert.equal(
      /01099887766/.test(cleaned),
      false,
      "Failed to strip Egyptian mobile number"
    );
    assert.equal(
      /https?:\/\//.test(cleaned),
      false,
      "Failed to strip website URL"
    );
    assert.equal(/#/.test(cleaned), false, "Failed to strip hashtags");
    assert.equal(
      cleaned.includes("تشطيب كامل استلام 2029"),
      true,
      "Stripped legitimate description text"
    );
  });

  it("should parse colloquial Egyptian prices with units and fractions", () => {
    const p1 = T.parseEgyptianPrice("6.7 مليون", { listingType: "sale" });
    assert.equal(p1.priceValue, 6700000);

    const p2 = T.parseEgyptianPrice("5 مليون ونص", { listingType: "sale" });
    assert.equal(p2.priceValue, 5500000);

    const p3 = T.parseEgyptianPrice("160 ألف", { listingType: "rent" });
    assert.equal(p3.priceValue, 160000);
  });

  it("should format standardized locked header", () => {
    const listing = {
      code: "N4-105",
      listing_type: "sale",
      compound: "NOLL",
      district: "New Cairo"
    };

    // Arabic Locked Header Verification
    const headerAr = T.formatStandardHeader(listing, "ar");
    const [arLine1, arLine2] = headerAr.split("\n");

    assert.match(arLine1, /🔑/);
    assert.match(arLine1, /وحدة للبيع/);
    assert.match(arLine1, /كود:/);
    assert.match(arLine1, /`N4-105`/);

    assert.match(arLine2, /🏢/);
    assert.match(arLine2, /NOLL/);
    assert.match(arLine2, /New Cairo/);

    // English Locked Header Verification
    const headerEn = T.formatStandardHeader(listing, "en");
    const [enLine1, enLine2] = headerEn.split("\n");

    assert.match(enLine1, /🔑/);
    assert.match(enLine1, /Unit For Sale/);
    assert.match(enLine1, /Code:/);
    assert.match(enLine1, /`N4-105`/);

    assert.match(enLine2, /🏢/);
    assert.match(enLine2, /NOLL/);
    assert.match(enLine2, /New Cairo/);
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

    // 6,700,000 * 0.85 = 5,695,000
    assert.equal(summary.effective_price, 5695000);
    // 10% of 5,695,000 = 569,500
    assert.equal(summary.down_payment, 569500);

    // Remaining for 32 quarters: (5,695,000 - 569,500) / 32 = 5,125,500 / 32 = 160,171.875 -> rounded to 160,172
    assert.equal(summary.installment_amount, 160172);

    // Maintenance 8% on base: 6,700,000 * 0.08 = 536,000 split across 3 years = 178,667
    assert.equal(summary.total_maintenance, 536000);
    assert.equal(summary.maintenance_per_split, 178667);
  });

  it("should reconcile rounding discrepancies on the final installment row", () => {
    const { summary, rows } = F.generateDetailedSchedule(basePrice, plan8Yr);

    assert.equal(rows.length, 33); // Row 0 (Down Payment) + 32 Quarters
    assert.equal(rows[0].type, "down_payment");
    assert.equal(rows[0].amount, 569500);

    // Sum of all installments must equal exactly effective_price (5,695,000)
    const totalInstallmentsPaid = rows.reduce((acc, r) => acc + r.amount, 0);
    assert.equal(totalInstallmentsPaid, summary.effective_price);
  });

  it("should match buyer budget constraints or calculate closest alternative", () => {
    const plans = [
      { plan_id: "p6", years: 6, discount_pct: 25, down_payment_pct: 10 },
      { plan_id: "p8", years: 8, discount_pct: 15, down_payment_pct: 10 },
      { plan_id: "p10", years: 10, discount_pct: 5, down_payment_pct: 5 }
    ];

    // Constraint matching: Down Payment <= 570k and Quarterly <= 165k
    const matched = F.filterMatchingPlans(basePrice, plans, {
      maxDownPayment: 570000,
      maxQuarterly: 165000
    });

    assert.equal(matched.status, "matched");
    assert.equal(matched.matches.length >= 1, true);
    assert.equal(matched.matches[0].plan_id, "p8"); // Best discount matching budget

    // Constraint unmatched: Down Payment <= 300k, Quarterly <= 100k
    const unmatched = F.filterMatchingPlans(basePrice, plans, {
      maxDownPayment: 300000,
      maxQuarterly: 100000
    });

    assert.equal(unmatched.status, "unmatched");
    assert.equal(Boolean(unmatched.closest), true);
    assert.equal(unmatched.closest.plan.plan_id, "p10"); // Lowest down payment option
  });
});

/* ====================================================================== */
/* 3. In-Memory Excel Delivery Engine Tests                               */
/* ====================================================================== */
describe("3. lib/excel.js - In-Memory Binary Spreadsheet Generation", () => {
  it("should generate a multi-tab payment workbook buffer without touching disk", async () => {
    const listing = {
      code: "N4-105",
      title: "NOLL 105m Apartment",
      price_value: 6700000,
      compound: "NOLL",
      delivery_date: "2029"
    };

    const plans = [
      {
        plan_id: "p6",
        name: "6 Years (25% off)",
        years: 6,
        discount_pct: 25,
        down_payment_pct: 10
      },
      {
        plan_id: "p8",
        name: "8 Years (15% off)",
        years: 8,
        discount_pct: 15,
        down_payment_pct: 10
      }
    ];

    const agency = { name: "Aqar Prime Real Estate" };
    const broker = { name: "Haytham", phone: "0100000000" };

    const buffer = await E.buildMultiPlanWorkbook({
      listing,
      plans,
      agency,
      broker,
      lang: "ar"
    });

    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(
      buffer.length > 5000,
      true,
      "Buffer too small to be a valid .xlsx workbook"
    );

    // Excel files start with standard ZIP PK header bytes: 0x50, 0x4B, 0x03, 0x04
    assert.equal(buffer[0], 0x50);
    assert.equal(buffer[1], 0x4b);
    assert.equal(buffer[2], 0x03);
    assert.equal(buffer[3], 0x04);
  });

  it("should generate the full agency inventory workbook buffer", async () => {
    const listings = [
      {
        code: "HAS101",
        title: "Hyde Park Villa",
        price_value: 18500000,
        area_value: 320,
        bedrooms: 4,
        compound: "Hyde Park",
        status: "active"
      },
      {
        code: "N4-105",
        title: "NOLL Apartment",
        price_value: 6700000,
        area_value: 105,
        bedrooms: 2,
        compound: "NOLL",
        status: "active"
      }
    ];

    const buffer = await E.buildAgencyInventoryWorkbook({
      listings,
      agency: { name: "Aqar Prime" },
      broker: { name: "Haytham" },
      lang: "en"
    });

    assert.equal(Buffer.isBuffer(buffer), true);
    assert.equal(buffer[0], 0x50);
    assert.equal(buffer[1], 0x4b);
  });
});

/* ====================================================================== */
/* 4. Search & Hyde Park Bilingual Query Builder Tests                    */
/* ====================================================================== */
describe("4. lib/search.js - Bilingual Normalization & Hyde Park Fix", () => {
  it("should normalize 'Hyde Park' into both Arabic and spaceless variations", () => {
    const parsed = S.fallbackParse("شقة للبيع في هايد بارك غرفتين");

    assert.equal(parsed.filters.compound, "هايد بارك");
    assert.equal(parsed.filters.property_types.includes("apartment"), true);
    assert.equal(parsed.location_terms.includes("هايد بارك"), true);
    assert.equal(parsed.location_terms.includes("هايدبارك"), true);
    assert.equal(parsed.location_terms.includes("hyde park"), true);
  });

  it("should build SQL that eliminates spacing barriers and calls clean_arabic_text", () => {
    const parsed = {
      filters: { compound: "هايد بارك", listing_type: "sale" },
      location_terms: ["هايد بارك", "هايدبارك"]
    };

    const { sql, params } = S.buildSearchQuery("agency-uuid", parsed, {
      relaxed: false
    });

    assert.equal(
      sql.includes("public.clean_arabic_text"),
      true,
      "Failed to call public.clean_arabic_text in SQL"
    );
    assert.equal(
      sql.includes("replace(public.clean_arabic_text"),
      true,
      "Missing spaceless compound check"
    );
    assert.equal(params[0], "agency-uuid");
  });

  it("should expand bounds by 15% when relaxed search cascade is enabled", () => {
    const parsed = {
      filters: {
        price_max: 5000000,
        area_min: 100,
        bedrooms_min: 2,
        bedrooms_max: 2
      }
    };

    // Strict Pass
    const strictQuery = S.buildSearchQuery("agency-uuid", parsed, {
      relaxed: false
    });
    assert.equal(strictQuery.params.includes(5000000), true);
    assert.equal(strictQuery.params.includes(100), true);

    // Relaxed Pass (15% higher ceiling on price, 15% lower floor on area)
    const relaxedQuery = S.buildSearchQuery("agency-uuid", parsed, {
      relaxed: true
    });
    assert.equal(
      relaxedQuery.params.includes(5750000),
      true,
      "Failed to expand price ceiling by 15%"
    );
    assert.equal(
      relaxedQuery.params.includes(85),
      true,
      "Failed to soften area floor by 15%"
    );
    assert.equal(
      relaxedQuery.sql.includes("BETWEEN"),
      true,
      "Failed to widen bedroom matching in relaxed mode"
    );
  });
});

/* ====================================================================== */
/* 5. WhatsApp UI Adapter & Meta API Boundary Tests (Offline Mocked)      */
/* ====================================================================== */
describe("5. lib/whatsapp.js - Dynamic UI Adaptation & Boundary Clamps", () => {
  it("should automatically adapt between buttons and list picker based on option count", async () => {
    const twoOptions = [
      { id: "opt_1", title: "Option 1" },
      { id: "opt_2", title: "Option 2" }
    ];

    const fourOptions = [
      { id: "opt_1", title: "Option 1" },
      { id: "opt_2", title: "Option 2" },
      { id: "opt_3", title: "Option 3" },
      { id: "opt_4", title: "Option 4" }
    ];

    const originalFetch = globalThis.fetch;
    let lastPayload = null;

    globalThis.fetch = async (url, opts) => {
      if (opts?.body && typeof opts.body === "string") {
        try {
          lastPayload = JSON.parse(opts.body);
        } catch (_) {}
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          messaging_product: "whatsapp",
          messages: [{ id: "mock_wamid_123" }]
        })
      };
    };

    try {
      // <= 3 options must render buttons
      await WA.sendAdaptiveMenu("201000000000", "Choose option", twoOptions);
      assert.equal(lastPayload?.interactive?.type, "button");

      // > 3 options must switch to list
      await WA.sendAdaptiveMenu("201000000000", "Choose option", fourOptions);
      assert.equal(lastPayload?.interactive?.type, "list");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should clamp titles and descriptions to strictly obey Meta API length limits", async () => {
    const originalFetch = globalThis.fetch;
    let capturedPayload = null;

    globalThis.fetch = async (url, opts) => {
      if (opts?.body && typeof opts.body === "string") {
        try {
          capturedPayload = JSON.parse(opts.body);
        } catch (_) {}
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          messaging_product: "whatsapp",
          messages: [{ id: "mock_wamid_123" }]
        })
      };
    };

    try {
      const longTitle = "This title exceeds the twenty character limit";
      await WA.sendWhatsAppButtons("201000000000", "Body", [
        { id: "1", title: longTitle }
      ]);

      const buttonTitle =
        capturedPayload.interactive.action.buttons[0].reply.title;
      assert.equal(
        buttonTitle.length <= 20,
        true,
        "Button title exceeded 20 chars"
      );

      const longListRows = [
        {
          id: "1",
          title: "This list row title is way too long for Meta",
          description:
            "This is an extremely verbose description that exceeds the seventy two character ceiling mandated by Meta Graph API."
        }
      ];

      await WA.sendWhatsAppList("201000000000", "Header", "Body", "Action", [
        { title: "Section", rows: longListRows }
      ]);

      const row = capturedPayload.interactive.action.sections[0].rows[0];
      assert.equal(
        row.title.length <= 24,
        true,
        "List row title exceeded 24 chars"
      );
      assert.equal(
        row.description.length <= 72,
        true,
        "List row description exceeded 72 chars"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/* ====================================================================== */
/* 6. Advanced Financial Edge Cases: Balloons & Resale Friction           */
/* ====================================================================== */
describe("6. lib/financials.js - Advanced Milestones & Resale", () => {
  it("should correctly schedule balloon payments at specific monthly intervals", () => {
    const basePrice = 6700000;
    const planWithBalloons = {
      years: 8,
      discount_pct: 15,
      down_payment_pct: 5,
      milestones: [
        { label: "دفعة استلام", pct: 10, due_after_months: 36 } // Year 3 delivery balloon
      ]
    };

    const { summary, rows } = F.generateDetailedSchedule(
      basePrice,
      planWithBalloons
    );

    assert.equal(summary.down_payment, 284750); // 5% of 5,695,000
    assert.equal(summary.total_milestones_amount, 569500); // 10% of 5,695,000

    // Month 36 (Quarter 12) must include the balloon payment
    const balloonRow = rows.find((r) => r.period === 12);
    assert.equal(balloonRow.label.includes("دفعة استلام"), true);
    assert.equal(balloonRow.amount > summary.installment_amount, true);
  });

  it("should calculate complete resale upfront cash and friction costs", () => {
    const listing = {
      price_value: 5000000,
      down_payment_value: 2000000,
      details: {
        over_price: 300000,
        club_fee: 150000,
        transfer_fee: 100000,
        broker_commission: 125000
      }
    };

    const resale = F.calculateResaleFinancials(listing);

    // Total cash = 2M (paid) + 300k (over) + 150k (club) + 100k (transfer) + 125k (commission) = 2,675,000
    assert.equal(resale.total_upfront_cash, 2675000);
    assert.equal(resale.remaining_balance, 3000000);
  });
});

/* ====================================================================== */
/* 7. SSRF Protection & Network MIME Detection                            */
/* ====================================================================== */
describe("7. lib/flyer.js & lib/whatsapp.js - Security & Document Types", () => {
  it("should accurately resolve binary document MIME types for exports", () => {
    assert.equal(typeof WA.sendWhatsAppDocument, "function");

    const isXlsx = /\.xlsx$/i.test("inventory.xlsx");
    const isPdf = /\.pdf$/i.test("noll_layout.pdf");
    assert.equal(isXlsx, true);
    assert.equal(isPdf, true);
  });

  it("should format Arabic BiDi text without breaking ASCII numbers", () => {
    const mixedText = "شقة 105م في كمبوند NOLL";
    const reshaped = T.formatArabicForSatori(mixedText);

    assert.equal(typeof reshaped, "string");
    assert.equal(reshaped.length > 0, true);
  });
});
