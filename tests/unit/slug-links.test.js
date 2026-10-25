// tests/unit/slug-links.test.js — Release 2 step 1: agencies.slug and links built from PUBLIC_BASE_URL
"use strict";

const fs = require("fs");
const path = require("path");
const { createTestDb } = require("../harness/db");
const Slug = require("../../domain/slug");
const O = require("../../lib/onboarding");
const Config = require("../../config");

jest.setTimeout(60000);

let db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.pool.end());
beforeEach(async () => {
  await db.pool.query("TRUNCATE agencies, brokers CASCADE");
});

const addAgency = async (name, slug = null) =>
  (await db.pool.query("INSERT INTO agencies (name, slug) VALUES ($1, $2) RETURNING id, slug", [name, slug])).rows[0];

describe("agencies.slug (migration 005)", () => {
  test("JS baseSlug and SQL agency_slug_base agree", async () => {
    const id = "1234abcd-0000-0000-0000-000000000000";
    const names = ["Pilot Agency", "  Nile Homes & Co. ", "وكالة النيل", "App", "Real--Estate__2026", "a".repeat(60) + " b", "Ünïcode Ågency", "-x-", ""];
    for (const n of names) {
      const { rows } = await db.pool.query("SELECT agency_slug_base($1, $2::uuid) AS s", [n, id]);
      expect([n, rows[0].s]).toEqual([n, Slug.baseSlug(n, id)]);
    }
  });

  test("a new agency gets a slug from its name; duplicates get -2, -3", async () => {
    expect((await addAgency("Pilot Agency")).slug).toBe("pilot-agency");
    expect((await addAgency("Pilot  Agency!")).slug).toBe("pilot-agency-2");
    expect((await addAgency("pilot agency")).slug).toBe("pilot-agency-3");
  });

  test("Arabic-only and reserved names get agency-<id>", async () => {
    const ar = await addAgency("وكالة النيل");
    expect(ar.slug).toBe(`agency-${ar.id.replace(/-/g, "").slice(0, 8)}`);
    const app = await addAgency("APP");
    expect(app.slug).toMatch(/^agency-[0-9a-f]{8}$/);
  });

  test("an explicit slug is kept (lower-cased); renaming keeps the slug so shared links survive", async () => {
    const a = await addAgency("Nile", "Nile-Homes");
    expect(a.slug).toBe("nile-homes");
    await db.pool.query("UPDATE agencies SET name = 'Nile Homes Renamed' WHERE id = $1", [a.id]);
    const { rows } = await db.pool.query("SELECT slug FROM agencies WHERE id = $1", [a.id]);
    expect(rows[0].slug).toBe("nile-homes");
  });

  test("slugs are unique and must be URL-safe and not reserved", async () => {
    await addAgency("One", "same");
    await expect(addAgency("Two", "same")).rejects.toThrow(/unique|duplicate/i);
    await expect(addAgency("Three", "bad slug")).rejects.toThrow(/agencies_slug_format/);
    await expect(addAgency("Four", "webhook")).rejects.toThrow(/agencies_slug_format/);
  });

  test("isValidSlug mirrors the constraint", () => {
    expect(Slug.isValidSlug("pilot-agency")).toBe(true);
    for (const bad of ["", "-a", "a-", "Pilot", "a b", "app", "x".repeat(49), null]) expect(Slug.isValidSlug(bad)).toBe(false);
  });
});

describe("onboarding and slugs", () => {
  const file = (slug) => ({ agency: { name: "Pilot Agency", ...(slug ? { slug } : {}) }, brokers: [{ name: "Owner", phone: "01000000001", role: "owner" }] });

  test("the file may set the slug; it is validated", async () => {
    expect(O.validate(file("Bad Slug")).errors).toEqual([expect.stringMatching(/agency\.slug/)]);
    const res = await O.onboard(db.pool, file("pilot"));
    expect(res.slug).toBe("pilot");
  });

  test("without a slug one is derived once and kept on re-runs", async () => {
    const first = await O.onboard(db.pool, file());
    expect(first.slug).toBe("pilot-agency");
    const again = await O.onboard(db.pool, file());
    expect(again.slug).toBe("pilot-agency");
  });

  test("a slug used by another agency is refused", async () => {
    await addAgency("Someone Else", "pilot");
    await expect(O.onboard(db.pool, file("pilot"))).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });
});

describe("every outgoing link is built from PUBLIC_BASE_URL", () => {
  const saved = process.env.PUBLIC_BASE_URL;
  afterAll(() => {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = saved;
    Config.resetConfig();
  });

  test("lib/links.js builds absolute URLs from config.publicUrl", () => {
    process.env.PUBLIC_BASE_URL = "https://aqar-test.onrender.com/";
    Config.resetConfig();
    jest.isolateModules(() => {
      const Links = require("../../lib/links");
      expect(Links.appUrl("/")).toBe("https://aqar-test.onrender.com/app/");
      expect(Links.appUrl("search", { q: "شقة 3 غرف" })).toBe("https://aqar-test.onrender.com/app/search?q=%D8%B4%D9%82%D8%A9%203%20%D8%BA%D8%B1%D9%81");
      expect(Links.loginLinkUrl("tok_1")).toBe("https://aqar-test.onrender.com/app/login/confirm?t=tok_1");
      expect(Links.unitPageUrl("pilot-agency", "VIL/08", "s3cr3t")).toBe("https://aqar-test.onrender.com/pilot-agency/VIL%2F08?s=s3cr3t");
      expect(() => Links.unitPageUrl("pilot-agency", "VIL-08", null)).toThrow();
    });
  });

  test("nothing else reads PUBLIC_BASE_URL or hardcodes the site's host", () => {
    const root = path.join(__dirname, "..", "..");
    const files = ["lib", "routes", "services", "domain", "web"]
      .filter((d) => fs.existsSync(path.join(root, d)))
      .flatMap(function walk(d) {
        return fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".js") ? [`${d}/${e.name}`] : []
        );
      })
      .concat(["server.js"]);
    const allowed = ["lib/links.js"];
    for (const f of files) {
      const code = fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (!allowed.includes(f)) expect([f, /PUBLIC_BASE_URL|publicBaseUrl|publicUrl\(/.test(code)]).toEqual([f, false]);
      expect([f, /onrender\.com|aqarchat\.com|wehdathub\.com|localhost:\d/.test(code)]).toEqual([f, false]);
    }
  });
});
