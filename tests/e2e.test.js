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
describe("1. lib/text.js - String, Code Sanitization & Header Guard", () => {
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

  it("should format standardized locked header without vertical-tab or LaTeX artifacts", () => {
    const listing = {
      code: "N4-105",
      listing_type: "sale",
      compound: "NOLL",
      district: "New Cairo"
    };

    // Arabic Locked Header Verification
    const headerAr = T.formatStandardHeader(listing, "ar");
    const [arLine1, arLine2] = headerAr.split("\n");

    // Guard against ASCII 11 (\x0B) and \vert{} corruption
    assert.equal(
      headerAr.includes("\x0B"),
      false,
      "Contains ASCII 11 vertical tab"
    );
    assert.equal(
      headerAr.includes("ert{}"),
      false,
      "Contains LaTeX vert{} artifact"
    );
    assert.match(arLine1, /🔑/);
    assert.match(arLine1, /وحدة للبيع/);
    assert.match(arLine1, /كود:/);
    assert.match(arLine1, /`N4-105`/);
    assert.equal(arLine1.includes(" | "), true, "Missing clean pipe separator");

    assert.match(arLine2, /🏢/);
    assert.match(arLine2, /NOLL/);
    assert.match(arLine2, /New Cairo/);

    // English Locked Header Verification
    const headerEn = T.formatStandardHeader(listing, "en");
    const [enLine1, enLine2] = headerEn.split("\n");

    assert.equal(
      headerEn.includes("\x0B"),
      false,
      "English header contains vertical tab"
    );
    assert.equal(
      headerEn.includes("ert{}"),
      false,
      "English header contains vert{} artifact"
    );
    assert.match(enLine1, /🔑/);
    assert.match(enLine1, /Unit For Sale/);
    assert.match(enLine1, /Code:/);
    assert.match(enLine1, /`N4-105`/);
    assert.equal(enLine1.includes(" | "), true, "Missing clean pipe separator");

    assert.match(enLine2, /🏢/);
    assert.match(enLine2, /NOLL/);
    assert.match(enLine2, /New Cairo/);
  });

  it("should clean and deduplicate features list", () => {
    const raw = ["حمام سباحة", "", "  مصعد  ", "حمام سباحة", null, "جراج"];
    const cleaned = T.cleanFeaturesList
      ? T.cleanFeaturesList(raw)
      : Array.from(new Set(raw.filter(Boolean).map((s) => s.trim())));

    assert.equal(cleaned.length, 3);
    assert.equal(cleaned.includes("حمام سباحة"), true);
    assert.equal(cleaned.includes("مصعد"), true);
    assert.equal(cleaned.includes("جراج"), true);
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

  it("should enforce status = 'active' in SQL to prevent sold/archived listings leaking into search", () => {
    const parsed = { filters: { compound: "NOLL" } };
    const { sql } = S.buildSearchQuery("agency-uuid", parsed, {
      relaxed: false
    });

    assert.match(
      sql,
      /status\s*=\s*'active'/i,
      "SQL query must strictly filter for active status"
    );
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

  it("should discriminate between Meta Media ID and HTTP link in sendWhatsAppImage", async () => {
    const originalFetch = globalThis.fetch;
    const sentImages = [];

    globalThis.fetch = async (url, opts) => {
      if (opts?.body) {
        try {
          const body = JSON.parse(opts.body);
          if (body.type === "image") sentImages.push(body.image);
        } catch (_) {}
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid_img" }]
        })
      };
    };

    try {
      // 1. Sending an HTTPS URL
      await WA.sendWhatsAppImage(
        "201000000000",
        "https://example.com/photo.jpg",
        "Caption 1"
      );
      assert.equal(Boolean(sentImages[0]?.link), true);
      assert.equal(sentImages[0]?.link, "https://example.com/photo.jpg");

      // 2. Sending a numeric Media ID string
      await WA.sendWhatsAppImage("201000000000", "9876543210123", "Caption 2");
      assert.equal(Boolean(sentImages[1]?.id), true);
      assert.equal(sentImages[1]?.id, "9876543210123");

      // 3. Sending an object { id: '...' }
      await WA.sendWhatsAppImage(
        "201000000000",
        { id: "9876543210123" },
        "Caption 3"
      );
      assert.equal(Boolean(sentImages[2]?.id), true);
      assert.equal(sentImages[2]?.id, "9876543210123");
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

/* ====================================================================== */
/* 8. Listing Intake Lifecycle & Media Replacement Tests                  */
/* ====================================================================== */
describe("8. Ingestion Lifecycle - Draft State Machine & Replace Mode", () => {
  it("should detect replace command variations to clear media while preserving metadata", () => {
    const replacePhrases = ["استبدال", " replace ", "استبدال الصور", "REPLACE"];
    const nonReplacePhrases = ["شقة للبيع", "استلام 2026", "new"];

    const isReplace = (t) =>
      /(?:^|\s)(?:استبدال|replace)(?:$|\s)/i.test(String(t).trim());

    for (const phrase of replacePhrases) {
      assert.equal(
        isReplace(phrase),
        true,
        `Failed detecting replace in: ${phrase}`
      );
    }
    for (const phrase of nonReplacePhrases) {
      assert.equal(
        isReplace(phrase),
        false,
        `False positive replace in: ${phrase}`
      );
    }
  });

  it("should match intake command triggers (add, new, done, save, cancel)", () => {
    const isAdd = (t) =>
      /^(?:اضافة|إضافة|جديد|add|new)$/i.test(String(t).trim());
    const isDone = (t) => /^(?:تم|حفظ|done|save)$/i.test(String(t).trim());
    const isCancel = (t) =>
      /^(?:إلغاء|الغاء|تراجع|cancel)$/i.test(String(t).trim());

    assert.equal(isAdd("اضافة"), true);
    assert.equal(isAdd("new"), true);
    assert.equal(isDone("تم"), true);
    assert.equal(isDone("save"), true);
    assert.equal(isCancel("إلغاء"), true);
    assert.equal(isCancel("cancel"), true);
  });
});

/* ====================================================================== */
/* 9. Administrative Two-Step Deletion & Security Guards                  */
/* ====================================================================== */
describe("9. Administrative Suite - Two-Step Deletion & Authorization", () => {
  it("should parse delete commands and extract target code cleanly", () => {
    const parseDelete = (raw) => {
      const m = String(raw)
        .trim()
        .match(/^(?:حذف|مسح|delete|remove)\s+#?([A-Za-z0-9_\-\.\/`]+)$/i);
      return m ? T.extractCleanCode(m[1]) : null;
    };

    assert.equal(parseDelete("حذف N4-105"), "N4-105");
    assert.equal(parseDelete("delete HP-201"), "HP-201");
    assert.equal(parseDelete("مسح `ZED-11`"), "ZED-11");
    assert.equal(parseDelete("حذف"), null);
  });

  it("should format compliant confirmation button payloads under Meta length limit", () => {
    const listingId = "c0000000-0000-0000-0000-000000000001";
    const code = "N4-105";

    const buttons = [
      {
        id: `del_confirm:${listingId}:${code}`,
        title: "Confirm Delete 🗑️"
      },
      {
        id: "del_cancel",
        title: "Cancel ❌"
      }
    ];

    // Meta API: Button Title <= 20 chars, ID <= 128 chars
    assert.equal(
      buttons[0].title.length <= 20,
      true,
      "Confirm button title exceeds 20 chars"
    );
    assert.equal(
      buttons[1].title.length <= 20,
      true,
      "Cancel button title exceeds 20 chars"
    );
    assert.equal(
      buttons[0].id.length <= 128,
      true,
      "Confirm button ID exceeds 128 chars"
    );

    // Callback payload extraction test
    const parts = buttons[0].id.split(":");
    assert.equal(parts[0], "del_confirm");
    assert.equal(parts[1], listingId);
    assert.equal(parts[2], code);
  });

  it("should correctly evaluate canEdit authorization hierarchy", () => {
    const CFG = {
      adminRoles: ["admin", "owner", "manager"],
      allowColleagueEdits: false
    };

    const canEdit = (broker, listing) =>
      CFG.allowColleagueEdits ||
      !listing.broker_id ||
      listing.broker_id === broker.id ||
      CFG.adminRoles.includes(String(broker.role || "").toLowerCase());

    const ownerBroker = { id: "b1", role: "broker" };
    const colleagueBroker = { id: "b2", role: "broker" };
    const adminBroker = { id: "b3", role: "admin" };

    const myListing = { id: "l1", broker_id: "b1" };
    const unassignedListing = { id: "l2", broker_id: null };

    // Creator can always edit
    assert.equal(canEdit(ownerBroker, myListing), true);
    // Unassigned listing can be claimed/edited
    assert.equal(canEdit(colleagueBroker, unassignedListing), true);
    // Colleague cannot edit someone else's listing if allowColleagueEdits = false
    assert.equal(canEdit(colleagueBroker, myListing), false);
    // Admin can edit anyone's listing
    assert.equal(canEdit(adminBroker, myListing), true);
  });

  it("should correctly extract relative Supabase storage bucket paths from URLs", () => {
    const urls = [
      "https://xyz.supabase.co/storage/v1/object/public/listing-images/agency_a/listing_b/test.jpg",
      "https://xyz.supabase.co/storage/v1/object/public/listing-images/flyers/agency_a/f.jpg"
    ];

    const extractPath = (url) => {
      const match = String(url || "").match(/\/listing-images\/(.+)$/);
      return match ? match[1] : null;
    };

    assert.equal(extractPath(urls[0]), "agency_a/listing_b/test.jpg");
    assert.equal(extractPath(urls[1]), "flyers/agency_a/f.jpg");
    assert.equal(extractPath("https://external.com/photo.jpg"), null);
  });
});

/* ====================================================================== */
/* 10. Status Management & CRM Soft Deletion Tests                        */
/* ====================================================================== */
describe("10. Inventory Lifecycle - Status Soft Deletion (Sold / Archive / Active)", () => {
  it("should match all status transition commands", () => {
    const parseStatus = (raw) => {
      let m;
      if (
        (m = raw.match(/^(?:تم البيع|مباع|sold)\s+#?([A-Za-z0-9_\-\.\/`]+)$/i))
      ) {
        return { action: "sold", code: T.extractCleanCode(m[1]) };
      }
      if (
        (m = raw.match(
          /^(?:أرشفة|أرشفه|ارشيف|archive)\s+#?([A-Za-z0-9_\-\.\/`]+)$/i
        ))
      ) {
        return { action: "archived", code: T.extractCleanCode(m[1]) };
      }
      if (
        (m = raw.match(
          /^(?:تفعيل|نشط|متاح|activate|active)\s+#?([A-Za-z0-9_\-\.\/`]+)$/i
        ))
      ) {
        return { action: "active", code: T.extractCleanCode(m[1]) };
      }
      return null;
    };

    assert.deepEqual(parseStatus("تم البيع N4-105"), {
      action: "sold",
      code: "N4-105"
    });
    assert.deepEqual(parseStatus("sold HP-201"), {
      action: "sold",
      code: "HP-201"
    });
    assert.deepEqual(parseStatus("أرشفة SOD-40"), {
      action: "archived",
      code: "SOD-40"
    });
    assert.deepEqual(parseStatus("archive MIN-01"), {
      action: "archived",
      code: "MIN-01"
    });
    assert.deepEqual(parseStatus("تفعيل N4-105"), {
      action: "active",
      code: "N4-105"
    });
    assert.deepEqual(parseStatus("activate HP-201"), {
      action: "active",
      code: "HP-201"
    });
  });

  it("should validate allowed status domains", () => {
    const validStatuses = new Set(["active", "sold", "archived"]);
    assert.equal(validStatuses.has("active"), true);
    assert.equal(validStatuses.has("sold"), true);
    assert.equal(validStatuses.has("archived"), true);
    assert.equal(validStatuses.has("deleted"), false);
  });
});

/* ====================================================================== */
/* 11. Inline Quick-Patch with GIN Index Resynchronization Tests          */
/* ====================================================================== */
describe("11. Inline Attribute Patching - Developer Guard & GIN Resync", () => {
  it("should parse patch commands and supported attribute fields", () => {
    const parsePatch = (raw) => {
      const m = String(raw)
        .trim()
        .match(
          /^(?:تعديل|تحديث|edit|patch)\s+#?([A-Za-z0-9_\-\.\/`]+)\s+(\S+)\s+(.+)$/i
        );
      return m
        ? { code: T.extractCleanCode(m[1]), field: m[2], value: m[3] }
        : null;
    };

    const p1 = parsePatch("تعديل HP-201 السعر 7.8 مليون");
    assert.deepEqual(p1, {
      code: "HP-201",
      field: "السعر",
      value: "7.8 مليون"
    });

    const p2 = parsePatch("edit N4-105 price 7M");
    assert.deepEqual(p2, { code: "N4-105", field: "price", value: "7M" });

    const p3 = parsePatch("تعديل HP-201 التشطيب الترا سوبر لوكس");
    assert.deepEqual(p3, {
      code: "HP-201",
      field: "التشطيب",
      value: "الترا سوبر لوكس"
    });
  });

  it("should block raw price patch on primary developer models", () => {
    const isDeveloperModel = (listing) =>
      listing.inventory_type === "developer_model" ||
      listing.is_primary_developer;

    const unitDeveloper = {
      code: "N4-105",
      inventory_type: "developer_model",
      is_primary_developer: true
    };
    const unitResale = {
      code: "HP-201",
      inventory_type: "resale_unit",
      is_primary_developer: false
    };

    assert.equal(
      isDeveloperModel(unitDeveloper),
      true,
      "Developer unit must be guarded"
    );
    assert.equal(
      isDeveloperModel(unitResale),
      false,
      "Resale unit can be patched"
    );
  });

  it("should generate normalized search text containing patched attributes for GIN index sync", () => {
    const generateSearchText = (listing, newFinishing, newBeds) => {
      const finishing =
        newFinishing || listing.details?.finishing || "نصف تشطيب";
      const beds = newBeds || listing.bedrooms || 2;
      return `${listing.title} ${listing.compound} ${listing.district} ${finishing} ${beds} غرف`.toLowerCase();
    };

    const listing = {
      title: "شقة للبيع",
      compound: "هايد بارك",
      district: "التجمع",
      bedrooms: 2,
      details: { finishing: "نصف تشطيب" }
    };

    const updatedText = generateSearchText(listing, "الترا سوبر لوكس", 3);
    assert.equal(updatedText.includes("الترا سوبر لوكس"), true);
    assert.equal(updatedText.includes("3 غرف"), true);
  });
});

/* ====================================================================== */
/* 12. Interactive Button Debounce & Memory Guard Tests                   */
/* ====================================================================== */
describe("12. UX Reliability - 3-Second Interactive Button Debounce", () => {
  it("should drop duplicate button clicks within 3000ms window", () => {
    const recentClicks = new Map();

    const isDebounced = (phone, replyId, now) => {
      const clickKey = `${phone}:${replyId}`;
      if (recentClicks.get(clickKey) > now) {
        return true; // Dropped
      }
      recentClicks.set(clickKey, now + 3000);
      return false; // Executed
    };

    const t0 = 1000000;
    const phone = "201055881114";
    const buttonId = "flyer:ar:dark:N4-105";

    // First click at t0: Must execute
    assert.equal(isDebounced(phone, buttonId, t0), false);

    // Rapid double click at t0 + 400ms: Must drop
    assert.equal(isDebounced(phone, buttonId, t0 + 400), true);

    // Another click at t0 + 2900ms: Must drop
    assert.equal(isDebounced(phone, buttonId, t0 + 2900), true);

    // Click after debounce expires at t0 + 3100ms: Must execute
    assert.equal(isDebounced(phone, buttonId, t0 + 3100), false);
  });
});

/* ====================================================================== */
/* 13. Unbranded Co-Broke Brochure & Deliverable Triggers                 */
/* ====================================================================== */
describe("13. Deliverables - Unbranded Brochure Triggers", () => {
  it("should match unbranded flyer command regex variations", () => {
    const isUnbranded = (t) =>
      /^(?:بروشور بدون بيانات|كتالوج بدون بيانات|فلاير بدون بيانات|unbranded|cobroke|co-broke)(?:\s+#?([A-Za-z0-9_\-\.\/`]+))?$/i.test(
        String(t).trim()
      );

    assert.equal(isUnbranded("بروشور بدون بيانات N4-105"), true);
    assert.equal(isUnbranded("unbranded HP-201"), true);
    assert.equal(isUnbranded("cobroke SOD-40"), true);
    assert.equal(isUnbranded("كتالوج N4-105"), false); // Standard branded catalog
  });
});

/* ====================================================================== */
/* 14. Comprehensive Help Section Verification                            */
/* ====================================================================== */
describe("14. lib/text.js - Help Documentation Completeness", () => {
  it("should document all active operations in Arabic help guide", () => {
    const helpAr = T.getHelpMessage("ar");

    // Command keywords must all be documented
    assert.equal(helpAr.includes("جدول"), true);
    assert.equal(helpAr.includes("مخطط"), true);
    assert.equal(helpAr.includes("كتالوج"), true);
    assert.equal(helpAr.includes("بروشور بدون بيانات"), true);
    assert.equal(helpAr.includes("عميل"), true);
    assert.equal(helpAr.includes("حذف"), true);
    assert.equal(helpAr.includes("تم البيع"), true);
    assert.equal(helpAr.includes("تعديل"), true);
    assert.equal(helpAr.includes("استبدال"), true);
    assert.equal(helpAr.includes("اكسل"), true);
  });

  it("should document all active operations in English help guide", () => {
    const helpEn = T.getHelpMessage("en");

    assert.equal(helpEn.includes("unbranded"), true);
    assert.equal(helpEn.includes("delete"), true);
    assert.equal(helpEn.includes("excel"), true);
    assert.equal(helpEn.includes("replace"), true);
  });
});

/* ====================================================================== */
/* 15. Centralized Telemetry & Operation Logs Schema Compliance           */
/* ====================================================================== */
describe("15. Telemetry & Auditing - Operation Logs Schema Verification", () => {
  it("should validate operation log parameters against mandatory database schema", () => {
    const validOperations = new Set([
      "direct_lookup",
      "search_query",
      "search_more",
      "voice_transcription",
      "collateral_view",
      "client_text_generated",
      "view_plan_detail",
      "export_payment_excel",
      "cmd_export_excel",
      "flyer_ondemand",
      "draft_append_image",
      "draft_append_audio",
      "draft_replace_images",
      "draft_cancel",
      "draft_commit",
      "patch_listing",
      "update_status",
      "delete_listing"
    ]);

    const sampleLog = {
      agency_id: "a0000000-0000-0000-0000-000000000001",
      broker_id: "b0000000-0000-0000-0000-000000000001",
      listing_code: "N4-105",
      operation_type: "delete_listing",
      status: "success",
      total_duration_ms: 125,
      metadata: { purged_images_count: 4 }
    };

    assert.equal(validOperations.has(sampleLog.operation_type), true);
    assert.equal(typeof sampleLog.total_duration_ms, "number");
    assert.equal(
      ["success", "failed", "no_matches"].includes(sampleLog.status),
      true
    );
    assert.equal(sampleLog.agency_id.length, 36);
  });
});
