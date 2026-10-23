// tests/safeguards.test.js
"use strict";

const fs = require("fs");
const path = require("path");

describe("AqarChat Production Safeguards & Architectural Invariant Gates", () => {
  const rootDir = path.join(__dirname, "..");
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

  scanDirs.forEach((d) => collectJsFiles(path.join(rootDir, d)));
  const serverPath = path.join(rootDir, "server.js");
  if (fs.existsSync(serverPath)) {
    jsFiles.push(serverPath);
  }

  // 1. SCHEMA INVARIANT: Phone identifiers
  test("Codebase must strictly use phone_number or phone_normalized and NEVER naked broker.phone or whatsapp_id", () => {
    jsFiles.forEach((file) => {
      const rawContent = fs.readFileSync(file, "utf8");
      // تجريد التعليقات البرمجية قبل الفحص لعدم التقاط التوثيق
      const content = rawContent
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      // Forbids broker.phone (not followed by _number or _normalized)
      expect(content).not.toMatch(/broker\.phone\b(?!_number|_normalized)/);

      // Forbids references to legacy whatsapp_id
      expect(content).not.toMatch(/\bwhatsapp_id\b/);

      // Forbids naked SQL queries: SELECT phone FROM brokers
      expect(content).not.toMatch(
        /SELECT\s+[^;]*\bphone\b(?!\s*AS|\s*,\s*phone_number|\s*,\s*phone_normalized)[^;]*FROM\s+brokers/i
      );
    });
  });

  // 2. SCHEMA INVARIANT: broker_sessions strictly uses session_data without updated_at
  test("broker_sessions table queries must strictly reference session_data and never updated_at or id", () => {
    jsFiles.forEach((file) => {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toMatch(/broker_sessions[^;]*context_data/i);
      expect(content).not.toMatch(/broker_sessions[^;]*\bupdated_at\b/i);
    });
  });

  // 3. WHATSAPP CONSTRAINTS: Grapheme-safe button title character limits
  test("All hardcoded interactive button titles must be strictly <= 20 characters", () => {
    const interactiveFiles = [
      path.join(rootDir, "routes/interactive.js"),
      path.join(rootDir, "routes/commands.js"),
      path.join(rootDir, "routes/media.js"),
      path.join(rootDir, "server.js")
    ];

    interactiveFiles.forEach((file) => {
      if (!fs.existsSync(file)) return;
      const content = fs.readFileSync(file, "utf8");

      const buttonMatches = [...content.matchAll(/title:\s*["']([^"']+)["']/g)];
      buttonMatches.forEach(([, title]) => {
        // Enforce grapheme/character ceiling <= 20 (Array.from splits unicode correctly)
        const charCount = Array.from(title.trim()).length;
        expect(charCount).toBeLessThanOrEqual(20);
      });
    });
  });

  // 4. CONCURRENCY: 64-bit Transactional Advisory Lock on Mutations
  test("Mutation routes must acquire 64-bit advisory locks via pg_advisory_xact_lock", () => {
    const cmdFile = path.join(rootDir, "routes/commands.js");
    const interactiveFile = path.join(rootDir, "routes/interactive.js");

    [cmdFile, interactiveFile].forEach((file) => {
      if (!fs.existsSync(file)) return;
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("pg_advisory_xact_lock");
      expect(content).toContain("bit(64)::bigint");
    });
  });

  // 5. ASYNCHRONOUS STORAGE CLEANUP: Non-blocking deleteStorageFiles
  test("Storage file deletions must execute asynchronously outside DB transactions via setImmediate", () => {
    const interactiveFile = path.join(rootDir, "routes/interactive.js");
    if (!fs.existsSync(interactiveFile)) return;
    const content = fs.readFileSync(interactiveFile, "utf8");

    if (content.includes("deleteStorageFiles")) {
      expect(content).toContain("setImmediate");
    }
  });

  // 6. RENDER COMPLIANCE: Sharp in-memory limits and concurrency
  test("Media processing must enforce Sharp concurrency and avoid local disk writes", () => {
    const mediaFile = path.join(rootDir, "routes/media.js");
    if (!fs.existsSync(mediaFile)) return;
    const content = fs.readFileSync(mediaFile, "utf8");

    expect(content).toContain("sharp.concurrency(1)");
    expect(content).not.toContain("fs.writeFileSync");
    expect(content).not.toContain("/tmp/");
  });

  // 7. DEVELOPER MODEL INTEGRITY: Price edit blocker (EDT-04)
  test("Price editing routes must block direct price mutations on developer models", () => {
    const cmdFile = path.join(rootDir, "routes/commands.js");
    if (!fs.existsSync(cmdFile)) return;
    const content = fs.readFileSync(cmdFile, "utf8");

    expect(content).toContain("is_primary_developer");
    expect(content).toContain("developer_model");
  });

  // 8. RENDER DRAIN PROTOCOL: Server must implement graceful shutdown and inFlight tracking
  test("server.js must track inFlight tasks, return 503 during drain, and listen to SIGTERM", () => {
    if (!fs.existsSync(serverPath)) return;
    const content = fs.readFileSync(serverPath, "utf8");

    expect(content).toContain("inFlight");
    expect(content).toContain("isDraining");
    expect(content).toContain("SERVICE_DRAINING");
    expect(content).toContain("SIGTERM");
    expect(content).toContain("SIGINT");
    expect(content).toContain("25000"); // 25s window
  });

  // 9. WHATSAPP GATEWAY: 24-hour customer window circuit breaker (Error 131047)
  test("lib/whatsapp.js must intercept error 131047 without retrying", () => {
    const waPath = path.join(rootDir, "lib/whatsapp.js");
    if (!fs.existsSync(waPath)) return;
    const content = fs.readFileSync(waPath, "utf8");

    expect(content).toContain("131047");
    expect(content).toContain("nonRetryable");
  });

  // 10. COLLISION GUARD: server.js must check for active draft before search
  test("server.js must implement COL-01 draft vs search collision check", () => {
    if (!fs.existsSync(serverPath)) return;
    const content = fs.readFileSync(serverPath, "utf8");

    expect(content).toContain("cancel_and_search");
    expect(content).toContain("broker_sessions");
  });
});
