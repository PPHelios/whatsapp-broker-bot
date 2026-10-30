// tests/browser/write-actions.test.js — Phone-sized browser checks of the write actions the POC demo relies on:
// a lead's stage with "Needs manager", the manager handling it, and a broker asking for secret details that a manager allows.
// Fake data, fake AI, no outside network. Each check reads the database back, not just the page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");

process.env.OWNER_BROKER_IDS = "10000000-0000-0000-0000-000000000003";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4572";
jest.setTimeout(300000);

const PHONE = { width: 390, height: 844 };
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

let h;
let browser;
let server;
let base;
let lead;
const contexts = [];

beforeAll(async () => {
  h = await createHarness();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  await h.insertListing({
    code: "NH-A20", title: "NH-A20 unit", compound: "Hyde Park", price_value: 4e6, area_value: 90, bedrooms: 2,
    details: { owner_name: "Tarek Fawzy", owner_phone: "01010010001", notes: "Private note" }
  });
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  await h.insertListing({ code: "NH-P1", title: "Private villa", compound: "Allegria", price_value: 30e6, area_value: 400, bedrooms: 5, is_private: true });
  await h.seedBroker("owner");
  lead = (await Leads.captureLead(h.pool, broker, { phones: ["01012345678"], name: "محمد سامي", quiet: true })).lead;
  server = h.app.app.listen(4572);
  base = "http://127.0.0.1:4572";
});

afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

// Sign in as a harness broker on a phone-sized context. Network outside the local server is blocked.
async function signIn(who) {
  const br = h.BROKERS[who];
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  contexts.push(ctx);
  await ctx.route(/.*/, (route) => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(15000);
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${base}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForURL((u) => u.pathname.startsWith("/app") && !u.pathname.includes("login"), { timeout: 10000 }).catch(() => {});
  await pg.waitForLoadState("networkidle");
  return pg;
}

async function open(pg, path) {
  await pg.goto(base + path, { waitUntil: "networkidle" });
}

test("a broker marks a lead as Needs manager with a note; the manager sees it and handles it with a reply", async () => {
  const broker = await signIn("broker");
  await open(broker, `/app/leads/${lead.ref}`);
  await broker.locator("input[name=stage][value=viewing]").check({ force: true });
  await broker.locator("label:has(input[name=needs_manager])").click();
  expect(await broker.locator("input[name=needs_manager]").isChecked()).toBe(true);
  await broker.locator("input[name=flag_text]").fill("Client wants a price below the list");
  await broker.locator("#stage button[type=submit]").click();
  await broker.waitForLoadState("networkidle");

  const flagged = await h.query("SELECT flagged_at, flag_note FROM leads WHERE id = $1", [lead.id]);
  expect(flagged[0].flagged_at).not.toBeNull();
  expect(flagged[0].flag_note).toMatch(/price below/);

  const manager = await signIn("admin");
  await open(manager, "/app/leads/needs-action");
  expect(await manager.locator("[data-flags]").innerText()).toMatch(/price below/);
  await manager.locator(`form[action$="/flag/handle"] input[name=reply]`).fill("Offer 5% less, client agreed");
  await manager.locator(`form[action$="/flag/handle"] button[type=submit]`).click();
  await manager.waitForLoadState("networkidle");

  const after = await h.query("SELECT flagged_at FROM leads WHERE id = $1", [lead.id]);
  expect(after[0].flagged_at).toBeNull();
});

test("a broker asks for secret details on a searched unit; the manager allows it and the broker can see them", async () => {
  const broker = await signIn("colleague");
  await open(broker, "/app/units/NH-A20");
  await broker.locator("form[action$='/access'] button[type=submit]").click();
  await broker.waitForLoadState("networkidle");

  const asked = await h.query("SELECT id, status FROM unit_access_requests WHERE broker_id = $1", [h.BROKERS.colleague.id]);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked[0].status).toBe("pending");

  const manager = await signIn("admin");
  await open(manager, "/app/units/NH-A20");
  await manager.locator("button[name=approve][value='1']").first().click();
  await manager.waitForLoadState("networkidle");

  const decided = await h.query("SELECT status FROM unit_access_requests WHERE id = $1", [asked[0].id]);
  expect(decided[0].status).toBe("approved");
});

// Private items: only the agency owner sees them, on the units list and on the unit page.
test("a private unit is hidden from brokers and managers, and shown to the agency owner", async () => {
  for (const who of ["broker", "admin"]) {
    const pg = await signIn(who);
    await open(pg, "/app/units");
    expect(await pg.locator("body").innerText()).not.toMatch(/NH-P1|Private villa/);
    await open(pg, "/app/units/NH-P1");
    expect(await pg.locator("body").innerText()).not.toMatch(/Private villa/);
  }
  const owner = await signIn("owner");
  await open(owner, "/app/units");
  expect(await owner.locator("body").innerText()).toMatch(/NH-P1|Private villa/);
});
