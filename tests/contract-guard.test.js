// tests/contract-guard.test.js
"use strict";

const fs = require("fs");
const path = require("path");

describe("API Contract & Variable Naming Guardians", () => {
  const root = path.join(__dirname, "..");
  const scanDirs = ["routes", "lib"];
  const jsFiles = [];

  function collectJsFiles(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", "tests", "scripts", ".git"].includes(entry.name)
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

  // 1. Mandatory Schema Naming Rules
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

      // GUARD 4: Forbidden legacy whatsapp_id
      expect(code).not.toMatch(/\bwhatsapp_id\b/);

      // GUARD 5: Naked phone query on brokers table
      expect(code).not.toMatch(
        /SELECT\s+[^;]*\bphone\b(?!\s*AS|\s*,\s*phone_number|\s*,\s*phone_normalized)[^;]*FROM\s+brokers/i
      );
    });
  });

  // 2. Export Contract Verification
  test("Core libraries must export exact historical function names", () => {
    const expectedExports = {
      "lib/whatsapp.js": [
        "sendWhatsAppText",
        "sendWhatsAppButtons",
        "sendWhatsAppImage",
        "uploadWhatsAppMedia",
        "downloadWhatsAppMedia"
      ],
      "lib/util.js": [
        "normalizePhone",
        "cleanAudioMime",
        "withTimeout",
        "sleep",
        "createSerializer",
        "createLimiter",
        "createRateGate"
      ],
      "lib/text.js": [
        "formatAbbreviatedPrice",
        "formatClientListingText",
        "parseEgyptianPrice",
        "cleanFeaturesList",
        "cleanArabicText",
        "getHelpMessage"
      ],
      "lib/search.js": [
        "parseSearchRequest",
        "buildSearchQuery",
        "fallbackParse",
        "enrichLocation"
      ],
      "lib/listing.js": [
        "composeFields",
        "generateListingCode",
        "validateDraft",
        "buildListingPrompt"
      ]
    };

    Object.entries(expectedExports).forEach(([relPath, fns]) => {
      const fullPath = path.join(root, relPath);
      if (!fs.existsSync(fullPath)) return;
      const mod = require(fullPath);
      fns.forEach((fn) => {
        expect(typeof mod[fn]).toBe("function");
      });
    });
  });

  // 3. Dynamic ESM Singleton Import Guard
  test("lib/ai.js must load @google/genai via dynamic import to prevent CommonJS crash", () => {
    const aiPath = path.join(root, "lib/ai.js");
    if (!fs.existsSync(aiPath)) return;
    const content = fs.readFileSync(aiPath, "utf8");
    expect(content).not.toMatch(/require\(["']@google\/genai["']\)/);
    expect(content).toMatch(/import\(["']@google\/genai["']\)/);
  });
});
