// tests/web/landing.test.js — Phase 2 step 3: the landing page at / in Arabic and English (no Arabic left in English),
// the plans from domain/plans.js, "Open in Telegram", the "Try it" form (kept, owner sees it on /app/owner; honeypot,
// cross-site and rate limit), and the brand tokens stylesheet generated from domain/brand.js.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Plans = require("../../domain/plans");
const { BRAND } = require("../../domain/brand");

jest.setTimeout(90000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const ARABIC = /[؀-ۿ]/;
const visible = (t) =>
  String(t)
    .replace(/<a [^>]*data-lang-switch[^>]*>[^<]*<\/a>/g, "")
    .replace(/<[^>]*\b(?:placeholder|title|aria-label|alt|value|content)="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]+>/g, " ");
const post = (body, headers = {}) => request(h.app.app).post("/try").set(headers).type("form").send(body);

test("Arabic by default, English with ?lang=en and no Arabic left; plans, Telegram link and indexable", async () => {
  const ar = await request(h.app.app).get("/");
  expect(ar.status).toBe(200);
  expect(ar.text).toContain('dir="rtl"');
  expect(ar.text).toContain('content="index, follow"');
  const en = await request(h.app.app).get("/?lang=en");
  expect(en.text).toContain('dir="ltr"');
  expect(visible(en.text).split(/\s{2,}|\n/).filter((s) => ARABIC.test(s))).toEqual([]);
  expect(en.text).toContain("https://t.me/Wehdat_Hub_bot");
  for (const p of Plans.PLANS) expect(en.text).toMatch(new RegExp(`data-plan="${p.id}"[\\s\\S]*?${p.priceEgp.toLocaleString("en-US")} EGP`));
  expect(en.text).toContain('id="try"');
});

test("brand.css carries the brand colours and every page links it before app.css", async () => {
  const page = await request(h.app.app).get("/app/login");
  const m = page.text.match(/href="(\/app\/static\/brand\.css\?v=\w+)"[\s\S]*?href="\/app\/static\/app\.css/);
  expect(m).not.toBeNull();
  const css = await request(h.app.app).get(m[1]);
  expect(css.text).toContain(`--brand: ${BRAND.colors.brand}`);
  expect(css.text).toContain(`--accent: ${BRAND.colors.accent}`);
});

test("a trial request is kept and listed for the owner; honeypot, cross-site and the rate limit keep nothing more", async () => {
  const ok = await post({ name: "Ahmed", agency: "Nile Homes", phone: "01012345678", team: "6" });
  expect(ok.status).toBe(303);
  expect(ok.headers.location).toBe("/?lang=ar&sent=1#try");
  expect((await request(h.app.app).get("/?sent=1")).text).toMatch(/وصلنا طلبك/);
  expect(await h.query("SELECT name, agency_name, phone_e164, team_size FROM demo_requests")).toEqual([
    { name: "Ahmed", agency_name: "Nile Homes", phone_e164: "+201012345678", team_size: 6 }
  ]);
  expect((await post({ name: "", phone: "01012345678" })).status).toBe(400);
  expect((await post({ name: "X", phone: "12" })).status).toBe(400);
  expect((await post({ name: "Bot", phone: "01012345678", website: "x" })).status).toBe(303);
  expect((await post({ name: "X", phone: "01012345678" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  for (let i = 0; i < 4; i++) expect((await post({ name: `N${i}`, phone: "01012345678" })).status).toBe(303);
  expect((await post({ name: "Late", phone: "01012345678" })).status).toBe(429);
  expect((await h.query("SELECT count(*)::int AS n FROM demo_requests"))[0].n).toBe(5);

  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  const a = await signIn(h, "admin");
  const owner = await a.agent.get("/app/owner?lang=en");
  expect(owner.text).toMatch(/id="trials"[\s\S]*Nile Homes/);
});
