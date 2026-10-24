// tests/test_search_db.js — Direct PostgreSQL Search Engine Integration Test
"use strict";
// Needs DATABASE_URL pointing at a database with the Release 1 migrations applied (npm run migrate)
// and the fixture listings of agency a0000000-0000-0000-0000-000000000001 (HP-201, MIV-15, ZED-80 ...).

// Automatically load environment variables from .env if present
try {
  require("dotenv").config();
} catch (e) {
  // dotenv not installed as standalone; fallback to process.env
}

const { Pool } = require("pg");
const { buildSearchQuery } = require("../lib/search");

const AGENCY_ID = "a0000000-0000-0000-0000-000000000001";

const connectionString =
  process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  console.error(
    "❌ ERROR: Neither DATABASE_URL nor SUPABASE_DB_URL is set in your environment or .env file."
  );
  process.exit(1);
}

const isLocalhost =
  connectionString.includes("localhost") ||
  connectionString.includes("127.0.0.1");

const pool = new Pool({
  connectionString,
  ssl: isLocalhost ? false : { rejectUnauthorized: false }
});

const TEST_SCENARIOS = [
  {
    name: "TC-DB-01: Direct Code Lookup (Exact)",
    parsed: {
      filters: { code: "HP-201" },
      location_terms: []
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["HP-201"],
    assertFn: (rows) => rows.length === 1 && rows[0].code === "HP-201"
  },
  {
    name: "TC-DB-02: Bilingual Compound Match (Hyde Park in Arabic)",
    parsed: {
      filters: {
        compound: "هايد بارك",
        listing_type: "sale"
      },
      location_terms: ["هايد بارك", "hyde park"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["HP-201", "HP-202", "HYD-90"],
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      const hasAll = ["HP-201", "HP-202", "HYD-90"].every((c) =>
        codes.includes(c)
      );
      const excludesSold = !codes.includes("HP-SOLD");
      return hasAll && excludesSold;
    }
  },
  {
    name: "TC-DB-03: Typology + Exact Bedrooms (Apartment, 3 Beds)",
    parsed: {
      filters: {
        property_types: ["apartment"],
        bedrooms_min: 3,
        bedrooms_max: 3,
        listing_type: "sale"
      },
      location_terms: ["fifth settlement", "التجمع الخامس"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["HP-201", "HP-202"],
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return (
        codes.includes("HP-201") &&
        codes.includes("HP-202") &&
        !codes.includes("MV-304") &&
        !codes.includes("HYD-90")
      );
    }
  },
  {
    name: "TC-DB-04: Studio Zero-Bedroom Invariant",
    parsed: {
      filters: {
        property_types: ["studio"],
        bedrooms_min: 0,
        bedrooms_max: 0,
        listing_type: "sale"
      },
      location_terms: []
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["ZED-80"],
    assertFn: (rows) =>
      rows.some((r) => r.code === "ZED-80") &&
      !rows.some((r) => r.code === "ZED-12")
  },
  {
    name: "TC-DB-05: Commercial Typology Invariant (Office)",
    parsed: {
      filters: {
        property_types: ["office"],
        listing_type: "sale"
      },
      location_terms: []
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["ZED-12"],
    assertFn: (rows) => rows.length === 1 && rows[0].code === "ZED-12"
  },
  {
    name: "TC-DB-06: Strict Price Ceiling (Max 5M EGP)",
    parsed: {
      filters: {
        price_max: 5000000,
        listing_type: "sale"
      },
      location_terms: []
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["HYD-90"],
    assertFn: (rows) =>
      rows.every((r) => Number(r.price_value) <= 5000000) &&
      rows.some((r) => r.code === "HYD-90")
  },
  {
    name: "TC-DB-07: Pass 1 to Pass 2 Transition (Relaxed Search)",
    // Mivida units are at 11.2M (MIV-15) and 22M (MV-304).
    // Searching max 10M must return 0 rows under Pass 1 (strict).
    // Under Pass 2 (relaxed +15% ceiling = 11.5M), MIV-15 (11.2M) must be returned.
    parsed: {
      filters: {
        compound: "ميفيدا",
        price_max: 10000000,
        listing_type: "sale"
      },
      location_terms: ["ميفيدا", "mivida"]
    },
    options: { limit: 5, offset: 0, relaxed: true },
    expectedCodes: ["MIV-15"],
    assertFn: (rows) =>
      rows.some((r) => r.code === "MIV-15") &&
      !rows.some((r) => r.code === "MV-304")
  },
  {
    name: "TC-DB-08: Negative Filter Invariant (Exclusion of Sold/Archived)",
    parsed: {
      filters: {},
      location_terms: []
    },
    options: { limit: 50, offset: 0, relaxed: false },
    expectedCodes: ["No inactive units"],
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return !codes.includes("HP-SOLD") && !codes.includes("ZED-ARCH");
    }
  },
  {
    name: "TC-DB-09: 100% English Query (Hyde Park Apartment)",
    parsed: {
      filters: {
        compound: "hyde park",
        property_types: ["apartment"],
        listing_type: "sale"
      },
      location_terms: ["hyde park", "new cairo"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["HP-201", "HP-202", "HYD-90"],
    assertFn: (rows) => {
      const codes = rows.map((r) => r.code);
      return ["HP-201", "HP-202", "HYD-90"].every((c) => codes.includes(c));
    }
  },
  {
    name: "TC-DB-10: English Micro-Location Search (Zed Sheikh Zayed Office)",
    parsed: {
      filters: {
        compound: "zed",
        property_types: ["office"],
        listing_type: "sale"
      },
      location_terms: ["zed", "sheikh zayed"]
    },
    options: { limit: 5, offset: 0, relaxed: false },
    expectedCodes: ["ZED-12"],
    assertFn: (rows) => rows.length === 1 && rows[0].code === "ZED-12"
  }
];

async function runSearchTestSuite() {
  console.log("\n========================================================");
  console.log("AQARCHAT DIRECT DATABASE SEARCH ENGINE TEST RUNNER");
  console.log("========================================================\n");

  let passed = 0;
  let failed = 0;

  for (const t of TEST_SCENARIOS) {
    const start = Date.now();
    try {
      const { sql, params } = buildSearchQuery(AGENCY_ID, t.parsed, t.options);
      const res = await pool.query(sql, params);
      const durationMs = Date.now() - start;
      const returnedCodes = res.rows.map((r) => r.code);

      const isPass = t.assertFn(res.rows);

      if (isPass) {
        passed++;
        console.log(`✅ [PASS] ${t.name} (${durationMs}ms)`);
        console.log(`   Returned Codes: [${returnedCodes.join(", ")}]`);
      } else {
        failed++;
        console.error(`❌ [FAIL] ${t.name} (${durationMs}ms)`);
        console.error(`   Expected Criteria: [${t.expectedCodes.join(", ")}]`);
        console.error(`   Actual Returned:   [${returnedCodes.join(", ")}]`);
        console.error(`   SQL:\n${sql}`);
        console.error(`   Params:`, params);
      }
    } catch (err) {
      failed++;
      console.error(`💥 [ERROR] ${t.name}: ${err.message}`);
    }
    console.log("--------------------------------------------------------");
  }

  console.log(
    `\nTEST EXECUTION SUMMARY: ${passed} Passed | ${failed} Failed\n`
  );
  await pool.end();

  if (failed > 0) {
    process.exit(1);
  }
}

runSearchTestSuite().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
