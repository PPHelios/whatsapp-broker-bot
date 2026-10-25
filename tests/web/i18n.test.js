// tests/web/i18n.test.js — Bilingual web (Release 3 step 11b): every /app/ page renders in English with no Arabic
// left over (and in Arabic with dir="rtl"); ?lang= switches the language, remembers it in a cookie when signed out
// and in preferred_lang when signed in.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Deals = require("../../services/deals");

jest.setTimeout(90000);

let h;
beforeAll(async () => {
  h = await createHarness();
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await h.insertListing({ code: "VIL-08", title: "Villa in Hyde Park", property_type: "villa", broker_id: h.BROKERS.admin.id });
  await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara" });
  const r = await Deals.createDeal(h.pool, admin, { leadKey: 1, unitCode: "VIL-08", price: 8500000, mode: "pct", pct: 2 });
  expect(r.ok).toBe(true);
});
afterAll(closeHarness);

const PAGES = ["/app/", "/app/units", "/app/units/VIL-08", "/app/units/new", "/app/units/VIL-08/edit", "/app/leads", "/app/leads/new",
  "/app/leads/L-0001", "/app/leads/import", "/app/import", "/app/deals", "/app/deals/new", "/app/deals/D-0001", "/app/search",
  "/app/searches", "/app/notifications", "/app/notifications/log", "/app/settings", "/app/usage", "/app/share", "/app/dashboard", "/app/team", "/app/guide"];

const ARABIC = /[؀-ۿ]/;
/** Visible text and attribute values, without the language switch link (it names the other language on purpose). */
function visible(html) {
  return String(html)
    .replace(/<a [^>]*data-lang-switch[^>]*>[^<]*<\/a>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    // Place suggestions list every name in both languages on purpose (typing either one autocompletes).
    .replace(/<datalist[\s\S]*?<\/datalist>/g, "")
    // A language picker names Arabic in Arabic.
    .replace(/العربية/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]*\b(?:placeholder|title|aria-label|alt|value)="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]+>/g, " ");
}
const arabicIn = (text) => text.split(/\s{2,}|\n/).filter((s) => ARABIC.test(s)).map((s) => s.trim()).slice(0, 5);

test("every page renders in English without Arabic and in Arabic right to left", async () => {
  const a = await signIn(h, "admin");
  const leaks = {};
  for (const p of PAGES) {
    const en = await a.agent.get(p + (p.includes("?") ? "&" : "?") + "lang=en");
    expect([p, en.status]).toEqual([p, 200]);
    const found = arabicIn(visible(en.text));
    if (found.length) leaks[p] = found;
  }
  expect(leaks).toEqual({});
  for (const p of PAGES) {
    const ar = await a.agent.get(p + "?lang=ar");
    expect([p, ar.status]).toEqual([p, 200]);
    expect(ar.text).toMatch(/dir="rtl"/);
  }
  await a.agent.get("/app/?lang=en");
});

test("every POST form on every page carries exactly one CSRF field, so plain form submits pass", async () => {
  const a = await signIn(h, "admin");
  const missing = [];
  for (const p of PAGES) {
    const res = await a.agent.get(p);
    for (const form of res.text.match(/<form\b[^>]*method="post"[\s\S]*?<\/form>/gi) || []) {
      const n = (form.match(/name="_csrf"/g) || []).length;
      if (n !== 1) missing.push(`${p}: ${form.slice(0, 80)} (${n})`);
    }
  }
  expect(missing).toEqual([]);
  // A form posted exactly as the browser would (its own fields only) is accepted.
  const inbox = await a.agent.get("/app/notifications");
  const form = inbox.text.match(/<form method="post" action="\/app\/notifications\/read-all">[\s\S]*?<\/form>/)[0];
  const token = form.match(/name="_csrf" value="([^"]+)"/)[1];
  expect((await a.agent.post("/app/notifications/read-all").type("form").send({ _csrf: token })).status).toBe(303);
  expect((await a.agent.post("/app/logout").type("form").send({ _csrf: token })).status).toBe(303);
});

test("?lang= signed in updates preferred_lang; signed out it sets a cookie for the sign-in page", async () => {
  const b = await signIn(h, "colleague");
  await b.agent.get("/app/?lang=en");
  expect((await h.query("SELECT preferred_lang FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0].preferred_lang).toBe("en");
  const home = await b.agent.get("/app/");
  expect(home.text).toMatch(/dir="ltr"/);
  await b.agent.get("/app/?lang=ar");
  expect((await h.query("SELECT preferred_lang FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0].preferred_lang).toBe("ar");

  const anon = request.agent(h.app.app);
  const first = await anon.get("/app/login?lang=en");
  expect(first.headers["set-cookie"].join(";")).toMatch(/aq_lang=en/);
  expect(arabicIn(visible(first.text))).toEqual([]);
  const again = await anon.get("/app/login");
  expect(again.text).toMatch(/dir="ltr"/);
  expect(again.text).toMatch(/data-lang-switch[^>]*href="\?lang=ar"/);
  const ar = await anon.get("/app/login?lang=ar");
  expect(ar.text).toMatch(/dir="rtl"/);
  // The offline page is cached once for everybody, so it carries both languages.
  const offline = await anon.get("/app/offline");
  expect(offline.text).toContain("Offline");
  expect(offline.text).toMatch(ARABIC);
});
