// tests/test_search_pipeline.js — Automated Pipeline & Bilingual Search Test Suite
"use strict";
// Needs DATABASE_URL pointing at a database with the Release 1 migrations applied (npm run migrate)
// and the fixture listings of agency a0000000-0000-0000-0000-000000000001 (HP-201, MIV-15, ZED-80 ...).

try {
  require("dotenv").config();
} catch (e) {
  // Fall back to process.env if dotenv is not loaded
}

const { Pool } = require("pg");
const { normalizeParsed, buildSearchQuery } = require("../lib/search");

const AGENCY_ID = "a0000000-0000-0000-0000-000000000001";
const connectionString =
  process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error("❌ ERROR: Neither DATABASE_URL nor SUPABASE_DB_URL is set.");
  process.exit(1);
}

const isLocalhost =
  connectionString.includes("localhost") ||
  connectionString.includes("127.0.0.1");

const pool = new Pool({
  connectionString,
  ssl: isLocalhost ? false : { rejectUnauthorized: false }
});

/**
 * Test Matrix covering:
 * 1. Bilingual transliterations (Arabic, English, comma-separated, slash-separated)
 * 2. Spaceless Arabic & English compound variations
 * 3. Non-dictionary dynamic compounds (e.g., Sarai, Badya)
 * 4. Typology invariants (Studio 0-bed vs. Office 0-bed vs. 1-bed apartment)
 * 5. Multi-pass Pass 1 -> Pass 2 boundary transition with strict compound lock
 * 6. Currency segregation (preventing USD units from polluting EGP budget queries)
 * 7. Negative status exclusion (sold & archived units strictly barred)
 */
const TEST_SCENARIOS = [
  {
    name: "TC-PIPE-01: Comma-Separated Bilingual Compound (Gemini Edge Case)",
    rawGeminiOutput: {
      intent: "search",
      language: "en",
      filters: {
        compound: "هايد بارك, hyde park",
        property_types: ["apartment"],
        listing_type: "sale"
      },
      location_terms: ["hyde park", "هايد بارك"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return ["HP-201", "HP-202", "HYD-90"].every((c) => codes.includes(c));
    }
  },
  {
    name: "TC-PIPE-02: 100% English Query (Hyde Park Apartment)",
    rawGeminiOutput: {
      intent: "search",
      language: "en",
      filters: {
        compound: "Hyde Park",
        property_types: ["apartment"],
        listing_type: "sale"
      },
      location_terms: ["hyde park", "new cairo"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return ["HP-201", "HP-202", "HYD-90"].every((c) => codes.includes(c));
    }
  },
  {
    name: "TC-PIPE-03: Slash-Delimited Bilingual Compound ('Mivida / ميفيدا')",
    rawGeminiOutput: {
      intent: "search",
      language: "ar",
      filters: {
        compound: "Mivida / ميفيدا",
        listing_type: "sale"
      },
      location_terms: ["ميفيدا", "mivida"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return codes.includes("MV-304") && codes.includes("MIV-15");
    }
  },
  {
    name: "TC-PIPE-04: Arabic Spaceless Compound ('هايدبارك')",
    rawGeminiOutput: {
      intent: "search",
      language: "ar",
      filters: {
        compound: "هايدبارك",
        listing_type: "sale"
      },
      location_terms: ["هايدبارك"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return (
        codes.includes("HP-201") &&
        codes.includes("HP-202") &&
        codes.includes("HYD-90")
      );
    }
  },
  {
    name: "TC-PIPE-05: Studio 0-Bedroom Invariant vs. 1-Bed Apartment",
    rawGeminiOutput: {
      intent: "search",
      language: "ar",
      filters: {
        property_types: ["studio"],
        bedrooms_min: 0,
        bedrooms_max: 0,
        listing_type: "sale"
      },
      location_terms: ["زد", "zed"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      // Must return ZED-80 (studio 0-bed); must strictly exclude ZED-12 (office) and HYD-90 (1-bed apartment)
      return (
        codes.includes("ZED-80") &&
        !codes.includes("ZED-12") &&
        !codes.includes("HYD-90")
      );
    }
  },
  {
    name: "TC-PIPE-06: Commercial Office Typology (0-Bed Commercial Partition)",
    rawGeminiOutput: {
      intent: "search",
      language: "en",
      filters: {
        property_types: ["office"],
        listing_type: "sale"
      },
      location_terms: ["zed"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      return rows.length === 1 && rows[0].code === "ZED-12";
    }
  },
  {
    name: "TC-PIPE-07: Pass 1 Fail -> Pass 2 Relaxed Boundary with Strict Compound Lock",
    // Mivida has MIV-15 (11.2M) and MV-304 (22M).
    // Broker asks for max 10M. Pass 1 returns 0.
    // Pass 2 (+15% price expansion = 11.5M ceiling) must find MIV-15 (11.2M),
    // but MUST NEVER leak units from other compounds like HP-201 (10M).
    rawGeminiOutput: {
      intent: "search",
      language: "ar",
      filters: {
        compound: "ميفيدا",
        price_max: 10000000,
        listing_type: "sale"
      },
      location_terms: ["ميفيدا"]
    },
    options: { limit: 5, offset: 0, relaxed: true },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      const hasMivida = codes.includes("MIV-15");
      const noLeakFromOtherCompounds =
        !codes.includes("HP-201") && !codes.includes("N4-105");
      return hasMivida && noLeakFromOtherCompounds;
    }
  },
  {
    name: "TC-PIPE-08: Currency Segregation (EGP Rental vs USD Rental)",
    // Broker searches rent under 10,000. MRS-901 is 4,500 USD/month.
    // Numerical 4,500 must not bleed into an EGP query.
    rawGeminiOutput: {
      intent: "search",
      language: "ar",
      filters: {
        listing_type: "rent",
        price_max: 10000,
        currency: "EGP"
      },
      location_terms: []
    },
    options: { limit: 5, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      // MRS-901 has currency 'USD' in details; it must not match EGP price ceilings
      return !codes.includes("MRS-901");
    }
  },
  {
    name: "TC-PIPE-10: Parity — Arabic and English requests return the same ids in the same order",
    rawGeminiOutput: { intent: "search", language: "ar", filters: { compound: "هايد بارك", property_types: ["apartment"] } },
    parityWith: { intent: "search", language: "en", filters: { compound: "Hyde Park", property_types: ["Apartment"] } },
    options: { limit: 50, offset: 0, relaxed: false },
    assertFn: (rows, parityRows) =>
      rows.length > 0 && JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(parityRows.map((r) => r.id))
  },
  {
    name: "TC-PIPE-09: Negative Lifecycle Invariant (Sold & Archived Exclusion)",
    rawGeminiOutput: {
      intent: "search",
      language: "ar",
      filters: {},
      location_terms: []
    },
    options: { limit: 50, offset: 0, relaxed: false },
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return !codes.includes("HP-SOLD") && !codes.includes("ZED-ARCH");
    }
  }
];

async function runPipelineTestSuite() {
  console.log("\n========================================================");
  console.log("AQARCHAT AUTOMATED PIPELINE & BILINGUAL SEARCH TEST SUITE");
  console.log("========================================================\n");

  let passed = 0;
  let failed = 0;

  for (const t of TEST_SCENARIOS) {
    const start = Date.now();
    try {
      // 1. Pass raw Gemini output through normalizeParsed (Contract Verification)
      const parsed = normalizeParsed(t.rawGeminiOutput);

      // 2. Build SQL statement
      const { sql, params } = buildSearchQuery(AGENCY_ID, parsed, t.options);

      // 3. Execute directly against PostgreSQL
      const res = await pool.query(sql, params);
      const durationMs = Date.now() - start;
      const returnedCodes = res.rows.map((r) => r.code);

      // 4. Assert invariants (parity scenarios run the second request too)
      let parityRows = null;
      if (t.parityWith) {
        const other = buildSearchQuery(AGENCY_ID, normalizeParsed(t.parityWith), t.options);
        parityRows = (await pool.query(other.sql, other.params)).rows;
      }
      const isPass = t.assertFn(res.rows, parityRows);

      if (isPass) {
        passed++;
        console.log(`✅ [PASS] ${t.name} (${durationMs}ms)`);
        console.log(`   Codes: [${returnedCodes.join(", ") || "none"}]`);
      } else {
        failed++;
        console.error(`❌ [FAIL] ${t.name} (${durationMs}ms)`);
        console.error(
          `   Actual Returned: [${returnedCodes.join(", ") || "none"}]`
        );
        console.error(`   Normalized places:`, JSON.stringify(parsed.filters?.places), "terms:", JSON.stringify(parsed.filters?.place_terms));
        console.error(`   SQL:\n${sql}`);
        console.error(`   Params:`, params);
      }
    } catch (err) {
      failed++;
      console.error(`💥 [ERROR] ${t.name}: ${err.message}`);
    }
    console.log("--------------------------------------------------------");
  }

  console.log(`\nTEST SUMMARY: ${passed} Passed | ${failed} Failed\n`);
  await pool.end();

  if (failed > 0) {
    process.exit(1);
  }
}

runPipelineTestSuite().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
