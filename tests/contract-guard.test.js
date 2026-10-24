// tests/contract-guard.test.js
"use strict";

const fs = require("fs");
const path = require("path");

describe("API Contract, Database Schema & Variable Naming Guardians", () => {
  const root = path.join(__dirname, "..");
  const scanDirs = ["routes", "lib", "web", "services", "domain"];
  const jsFiles = [];

  function collectJsFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", "tests", "scripts", ".git", "static"].includes(entry.name)
      ) {
        collectJsFiles(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".js") &&
        !entry.name.endsWith(".test.js")
      ) {
        jsFiles.push(fullPath);
      }
    }
  }

  scanDirs.forEach((d) => collectJsFiles(path.join(root, d)));
  const serverPath = path.join(root, "server.js");
  if (fs.existsSync(serverPath)) {
    jsFiles.push(serverPath);
  }

  // 1. Mandatory Schema Naming & Column Reference Rules
  test("Never reference legacy, non-existent, or forbidden column names", () => {
    expect(jsFiles.length).toBeGreaterThan(0);

    jsFiles.forEach((file) => {
      const rawCode = fs.readFileSync(file, "utf8");
      // Strip comments so code documentation does not trigger false-positive regex matches
      const code = rawCode
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      // GUARD 1: broker.phone without _number or _normalized
      expect(code).not.toMatch(/broker\.phone\b(?!_number|_normalized)/);

      // GUARD 2: broker_sessions must use session_data (never context_data)
      expect(code).not.toMatch(/broker_sessions[^;]*context_data/i);

      // GUARD 3: broker_sessions must NOT reference non-existent updated_at or id
      expect(code).not.toMatch(/broker_sessions[^;]*\bupdated_at\b/i);
      expect(code).not.toMatch(/broker_sessions[^;]*\bbroker_sessions\.id\b/i);

      // GUARD 4: Forbidden legacy whatsapp_id
      expect(code).not.toMatch(/\bwhatsapp_id\b/);

      // GUARD 5: Naked phone query on brokers table
      expect(code).not.toMatch(
        /SELECT\s+[^;]*\bphone\b(?!\s*AS|\s*,\s*phone_number|\s*,\s*phone_normalized)[^;]*FROM\s+brokers/i
      );

      // GUARD 6: Non-existent listing_drafts table
      expect(code).not.toMatch(/\blisting_drafts\b/i);

      // GUARD 7: Deprecated arabic-persian-reshaper library is strictly banned
      expect(code).not.toMatch(/arabic-persian-reshaper/i);
    });
  });

  // 2. Export Contract Verification against API_CONTRACTS.json
  test("Core libraries must export all canonical function names", () => {
    const contractsPath = path.join(root, "API_CONTRACTS.json");
    let contracts = null;

    if (fs.existsSync(contractsPath)) {
      try {
        contracts = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
      } catch (e) {
        console.warn(
          "Could not read API_CONTRACTS.json for automated export check:",
          e.message
        );
      }
    }

    const fallbackExpectedExports = {
      "lib/whatsapp.js": [
        "sendWhatsAppText",
        "sendWhatsAppButtons",
        "sendWhatsAppList",
        "sendWhatsAppImage",
        "sendWhatsAppReaction",
        "sendWhatsAppDocument",
        "uploadWhatsAppMedia",
        "downloadWhatsAppMedia",
        "markAsRead",
        "safeTruncate"
      ],
      "lib/util.js": [
        "normalizePhone",
        "cleanAudioMime",
        "withTimeout",
        "sleep",
        "hashListingCode",
        "sha1",
        "isValidZipBuffer",
        "createSerializer",
        "createLimiter",
        "createRateGate"
      ],
      "lib/text.js": [
        "normalizeDigits",
        "extractCleanCode",
        "parseExplicitUnitCode",
        "cleanArabicText",
        "normalizeAr",
        "stripMarketingFluff",
        "cleanFeaturesList",
        "detectCurrency",
        "normalizePriceInput",
        "parseMoney",
        "formatAbbreviatedPrice",
        "parseEgyptianPrice",
        "parsePrice",
        "formatPrice",
        "priceText",
        "formatStandardHeader",
        "formatClientListingText",
        "formatDraftReviewCard",
        "formatInternalListingDetails",
        "formatSearchResults",
        "listingsToCsv",
        "getHelpMessage",
        "toEnglishSpec",
        "isVillaTypology",
        "isStudioTypology"
      ],
      "lib/search.js": [
        "parseSearchRequest",
        "buildSearchQuery",
        "fallbackParse",
        "enrichLocation",
        "formatInterpretation",
        "estimateCostUsd",
        "expandAmenitySynonyms",
        "normalizeKeywords",
        "normalizeTerm",
        "handleSearchMessage"
      ],
      "lib/listing.js": [
        "normalizeArabicDigits",
        "parseExplicitUnitCode",
        "extractExplicitUnitCode",
        "isLikelyListingMetadata",
        "detectLang",
        "isReplaceMode",
        "generateListingCode",
        "buildListingPrompt",
        "buildVisionPrompt",
        "validateDraft",
        "checkDraftCompleteness",
        "validateVisionDraft",
        "composeFields",
        "isVillaTypology",
        "isStudioTypology"
      ],
      "lib/vision.js": [
        "createVisionThumbnail",
        "analyzePhotosWithGemini",
        "ensureListingImagesCurated"
      ],
      "lib/drafts.js": [
        "getDraft",
        "createDraft",
        "clearDraft",
        "appendText",
        "appendVoice",
        "appendMedia",
        "commitDraftToDatabase"
      ],
      "lib/flyer.js": [
        "generateFlyerBuffer",
        "renderFlyerOnDemand",
        "loadFont"
      ],
      "lib/excel.js": [
        "buildAgencyInventoryWorkbook",
        "buildMultiPlanWorkbook",
        "buildRejectionWorkbook",
        "sanitizeCellValue"
      ],
      "lib/financials.js": ["formatSinglePlanAdCopy"],
      "lib/supabase.js": [
        "uploadListingImage",
        "uploadFlyerImage",
        "deleteStorageFiles"
      ],
      "lib/dispatcher.js": [
        "reply",
        "replyButtons",
        "allowSilentDrop",
        "executeGuardedTurn"
      ]
    };

    const targetMap = contracts?.libraries || fallbackExpectedExports;

    Object.entries(targetMap).forEach(([relPath, expected]) => {
      const fullPath = path.join(root, relPath);
      if (!fs.existsSync(fullPath)) return;
      const mod = require(fullPath);

      if (Array.isArray(expected)) {
        expected.forEach((fn) => {
          expect(typeof mod[fn]).toBe("function");
        });
      } else if (typeof expected === "object") {
        Object.keys(expected).forEach((key) => {
          expect(mod[key]).toBeDefined();
        });
      }
    });
  });

  // 2b. The contract lists exactly the real exports (no stale or missing names, same parameters).
  test("API_CONTRACTS.json matches every listed module's real exports (node scripts/api-contracts.js)", () => {
    const Contracts = require("../scripts/api-contracts");
    const contracts = JSON.parse(fs.readFileSync(path.join(root, "API_CONTRACTS.json"), "utf8"));
    for (const [relPath, expected] of Object.entries(contracts.libraries)) {
      expect({ [relPath]: Contracts.describeModule(relPath) }).toEqual({ [relPath]: expected });
    }
  });

  test("every module in lib/, domain/, services/ and web/ is in API_CONTRACTS.json", () => {
    const contracts = JSON.parse(fs.readFileSync(path.join(root, "API_CONTRACTS.json"), "utf8"));
    // Worker entry points export nothing.
    const entryPoints = ["lib/flyerWorker.js"];
    const modules = ["lib", "domain", "services", "web", "web/routes"].filter((d) => fs.existsSync(path.join(root, d))).flatMap((d) =>
      fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`)
    );
    const missing = modules.filter((m) => !entryPoints.includes(m) && !contracts.libraries[m]);
    expect(missing).toEqual([]);
  });

  // 3. Dynamic ESM Singleton Import Guard
  test("lib/ai.js must load @google/genai via dynamic import to prevent CommonJS crash", () => {
    const aiPath = path.join(root, "lib/ai.js");
    if (!fs.existsSync(aiPath)) return;
    const content = fs.readFileSync(aiPath, "utf8");
    expect(content).not.toMatch(/require\(["']@google\/genai["']\)/);
    expect(content).toMatch(/import\(["']@google\/genai["']\)/);
  });

  // 4. Distributed Multi-Pod Advisory Locking Guard
  test("Listing mutations in routes/ must use 64-bit transactional advisory locks", () => {
    const commandPath = path.join(root, "routes/commands.js");
    const interactivePath = path.join(root, "routes/interactive.js");

    [commandPath, interactivePath].forEach((filePath) => {
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toMatch(/pg_advisory_xact_lock/);
    });
  });

  // 5. Ephemeral Disk Guard (/tmp disk writes forbidden)
  test("Production routes and libraries must never write to /tmp or local filesystem", () => {
    jsFiles.forEach((file) => {
      const rawCode = fs.readFileSync(file, "utf8");
      const code = rawCode
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      expect(code).not.toMatch(/fs\.writeFileSync/);
      expect(code).not.toMatch(/fs\.writeFile\(/);
      expect(code).not.toMatch(/["']\/tmp\//);
    });
  });
});
