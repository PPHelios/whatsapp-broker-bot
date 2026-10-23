// tests/safeguards.test.js — Canonical Architectural Safeguard & Regression Guard Test Suite
"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

describe("AqarChat Master Safeguards & Regression Guard Suite", () => {
  const commandsPath = path.join(rootDir, "routes", "commands.js");
  const interactivePath = path.join(rootDir, "routes", "interactive.js");
  const mediaPath = path.join(rootDir, "routes", "media.js");
  const searchPath = path.join(rootDir, "lib", "search.js");
  const listingLibPath = path.join(rootDir, "lib", "listing.js");
  const contractsPath = path.join(rootDir, "API_CONTRACTS.json");
  const schemaRefPath = path.join(rootDir, "SCHEMA_REFERENCE.sql");

  let commandsSrc = "";
  let interactiveSrc = "";
  let mediaSrc = "";
  let searchSrc = "";
  let listingLibSrc = "";
  let contractsJson = {};
  let schemaRefSql = "";

  beforeAll(() => {
    commandsSrc = fs.readFileSync(commandsPath, "utf8");
    interactiveSrc = fs.readFileSync(interactivePath, "utf8");
    mediaSrc = fs.readFileSync(mediaPath, "utf8");
    searchSrc = fs.readFileSync(searchPath, "utf8");
    listingLibSrc = fs.readFileSync(listingLibPath, "utf8");
    contractsJson = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
    schemaRefSql = fs.readFileSync(schemaRefPath, "utf8");
  });

  /* ------------------------------------------------------------------------- */
  /* 1. COMMAND ROUTING & CANONICAL ALIASES (FEATURE_REGISTRY.md)             */
  /* ------------------------------------------------------------------------- */
  describe("1. Command Router Invariant Checks (routes/commands.js)", () => {
    test("DRF-01: Must support all canonical Add/New triggers in both languages", () => {
      expect(commandsSrc).toMatch(/اضافة|إضافة|add|new|جديد|وحدة جديدة/i);
    });

    test("EDT-01 & EDT-02: Must support Edit triggers in Arabic and English", () => {
      expect(commandsSrc).toMatch(/تعديل|edit/i);
    });

    test("SYS-01: Must support Help/Menu triggers in Arabic and English", () => {
      expect(commandsSrc).toMatch(/مساعدة|help|اوامر|الأوامر|menu|قائمة/i);
    });

    test("SYS-02: Must support dynamic language toggle (lang ar/en)", () => {
      expect(commandsSrc).toMatch(/lang/i);
      expect(commandsSrc).toMatch(/ar\|en/i);
      expect(commandsSrc).toMatch(/العربية|الإنجليزية/i);
    });

    test("DRF-05: Must support explicit Cancel / Abort triggers", () => {
      expect(commandsSrc).toMatch(/cancel|إلغاء|الغاء|خروج|abort|exit/i);
    });

    test("LFC-01 to LFC-03: Must support Sold, Archive, and Active status transitions", () => {
      expect(commandsSrc).toMatch(/تم البيع|مباع|sold/i);
      expect(commandsSrc).toMatch(/ارشفة|أرشفة|archive/i);
      expect(commandsSrc).toMatch(/تفعيل|نشط|active/i);
    });

    test("DEL-01: Must support two-phase deletion command triggers", () => {
      expect(commandsSrc).toMatch(/حذف|delete|مسح/i);
    });

    test("DEL-06 & STATS-01: Must support Excel export and inventory summary stats triggers", () => {
      expect(commandsSrc).toMatch(/تصدير|export|excel|شيت/i);
      expect(commandsSrc).toMatch(/مخزون|المخزون|stats|احصائيات|summary/i);
    });

    test("DEL-08: Must support multi-line forwarded listing card interception", () => {
      expect(commandsSrc).toMatch(/raw\.includes\("\\n"\)/);
      expect(commandsSrc).toMatch(/codeMatch/);
    });
  });

  /* ------------------------------------------------------------------------- */
  /* 2. STATE MACHINE, GUARDS & DEFENSIVE VALIDATIONS                          */
  /* ------------------------------------------------------------------------- */
  describe("2. State Machine Safeguards & Empty Draft Guards", () => {
    test("DRF-02: Pre-flight empty draft guard must exist before AI invocation", () => {
      expect(commandsSrc).toMatch(
        /mediaCount\s*===?\s*0\s*&&\s*voiceCount\s*===?\s*0\s*&&\s*textCount\s*===?\s*0/
      );
    });

    test("ING-05: Image-only draft blocker must prevent premature draft saves", () => {
      expect(commandsSrc).toMatch(
        /mediaCount\s*>\s*0\s*&&\s*voiceCount\s*===?\s*0\s*&&\s*textCount\s*===?\s*0/
      );
    });

    test("lib/listing.js: validateDraft must defensively initialize missingFields as an Array", () => {
      const Listing = require("../lib/listing");
      expect(typeof Listing.validateDraft).toBe("function");

      const resultNull = Listing.validateDraft(null);
      return Promise.resolve(resultNull).then((res) => {
        expect(res).toBeDefined();
        expect(Array.isArray(res.missingFields)).toBe(true);
        expect(res.valid).toBe(false);
      });
    });

    test("lib/listing.js: checkDraftCompleteness must enforce studio and landed property rules", () => {
      const Listing = require("../lib/listing");
      expect(typeof Listing.checkDraftCompleteness).toBe("function");

      const incompleteApt = { property_type: "apartment", price_value: 0 };
      const resApt = Listing.checkDraftCompleteness(incompleteApt);
      expect(resApt.isComplete).toBe(false);
      expect(Array.isArray(resApt.blockers)).toBe(true);
      expect(resApt.blockers.some((b) => b.field === "price_value")).toBe(true);

      const studioDraft = {
        property_type: "studio",
        price_value: 3500000,
        compound: "Palm Hills",
        area_value: 65,
        bedrooms: 0
      };
      const resStudio = Listing.checkDraftCompleteness(studioDraft);
      expect(resStudio.blockers.some((b) => b.field === "bedrooms")).toBe(
        false
      );
    });

    test("EDT-04: Direct inline price edit must block developer inventory models", () => {
      expect(commandsSrc).toMatch(/is_primary_developer|developer_model/);
    });
  });

  /* ------------------------------------------------------------------------- */
  /* 3. INTERACTIVE CALLBACK ROUTING & CONCURRENCY (routes/interactive.js)     */
  /* ------------------------------------------------------------------------- */
  describe("3. Interactive Callback Invariants", () => {
    test("Must support button debouncing mechanism", () => {
      expect(interactiveSrc).toMatch(/recentButtonClicks/);
      expect(interactiveSrc).toMatch(/allowSilentDrop/);
    });

    test("Must support DRAFT_CANCEL, DRAFT_EDIT, and Save & Exit callbacks", () => {
      expect(interactiveSrc).toMatch(/DRAFT_CANCEL|draft_cancel/);
      expect(interactiveSrc).toMatch(/DRAFT_EDIT|draft_edit/);
      expect(interactiveSrc).toMatch(
        /draft_save_exit|SAVE_AND_EXIT|DRAFT_SAVE|draft_confirm/
      );
    });

    test("SCH-02: Must support search pagination cursor persistence and MORE_SEARCH button", () => {
      expect(interactiveSrc).toMatch(/MORE_SEARCH|search_more:/);
      expect(interactiveSrc).toMatch(/session_type\s*=\s*'search_state'/);
    });

    test("DEL-02: Deletion confirmation must acquire 64-bit transactional advisory lock", () => {
      expect(interactiveSrc).toMatch(/pg_advisory_xact_lock/);
      expect(interactiveSrc).toMatch(/FOR UPDATE/);
    });

    test("SEC-04: File purge from Supabase Storage must be asynchronous and non-blocking", () => {
      expect(interactiveSrc).toMatch(/setImmediate/);
      expect(interactiveSrc).toMatch(/deleteStorageFiles/);
    });
  });

  /* ------------------------------------------------------------------------- */
  /* 4. MEDIA INGRESS & SILENT REACTIONS (routes/media.js)                     */
  /* ------------------------------------------------------------------------- */
  describe("4. Media Ingress & Silent Reactions (routes/media.js)", () => {
    test("ING-01: Photo ingress must emit silent WhatsApp emoji reaction (📸)", () => {
      expect(mediaSrc).toMatch(/sendWhatsAppReaction/);
      expect(mediaSrc).toMatch(/📸/);
    });
  });

  /* ------------------------------------------------------------------------- */
  /* 5. PHYSICAL SCHEMA CONTRACTS & VARIABLE INVARIANTS                        */
  /* ------------------------------------------------------------------------- */
  describe("5. Physical Schema Reference & Contract Consistency", () => {
    test("Brokers table contract: must use phone_normalized or phone_number, never 'phone'", () => {
      const brokerPhoneInvariant =
        contractsJson.invariant_variable_names.broker_phone;
      expect(brokerPhoneInvariant).toBeDefined();

      expect(commandsSrc).not.toMatch(/brokers\s+WHERE\s+phone\s*=/i);
      expect(interactiveSrc).not.toMatch(/brokers\s+WHERE\s+phone\s*=/i);
    });

    test("Multi-tenancy isolation: mutations must always scope to agency_id", () => {
      expect(commandsSrc).toMatch(/WHERE\s+agency_id\s*=\s*\$1/i);
      expect(interactiveSrc).toMatch(/WHERE\s+agency_id\s*=\s*\$1/i);
    });

    test("SCHEMA_REFERENCE.sql must contain all required operational and recovery tables", () => {
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.agencies/
      );
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.brokers/
      );
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.listings/
      );
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.broker_sessions/
      );
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.inbound_messages/
      );
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.processed_batches/
      );
      expect(schemaRefSql).toMatch(
        /CREATE TABLE IF NOT EXISTS public\.operation_logs/
      );
    });

    test("Operation logs contract: must support structured telemetry writes", () => {
      expect(schemaRefSql).toMatch(/public\.operation_logs/);
      expect(searchSrc).toMatch(/operation_logs/);
    });
  });
});
