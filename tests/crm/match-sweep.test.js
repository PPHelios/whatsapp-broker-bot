// tests/crm/match-sweep.test.js — Match alerts (Release 3 step 7): units from every write path alert exactly once,
// a price drop into range alerts, a rollback and a sold unit don't, alerts are grouped and capped per day, the
// sweep finds the same units as search, and nothing crosses agencies.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Requests = require("../../services/leadRequests");
const Sweep = require("../../services/matchSweep");
const Search = require("../../services/search");
const Store = require("../../lib/listingStore");

jest.setTimeout(90000);

let h;
let wm;
beforeEach(async () => {
  h = await createHarness();
  wm = { at: new Date(Date.now() - 1000).toISOString() };
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const HP = { listing_type: "sale", property_types: ["apartment"], places: [{ kind: "compound", key: "hyde_park" }], price_max: 9000000 };
const run = async (opts = {}) => {
  const out = await Sweep.sweep(h.pool, { now: new Date(Date.now() + 2000), watermark: wm, ...opts });
  wm = out.watermark;
  return out.counts;
};
const alerts = (who = "broker") => h.query("SELECT title, body, lead_id FROM notifications WHERE broker_id = $1 AND kind = 'match' ORDER BY id", [h.BROKERS[who].id]);
const matched = () => h.query("SELECT l.code, m.status FROM lead_matches m JOIN listings l ON l.id = m.listing_id ORDER BY l.code");

async function lead(who = "broker", phones = "01012345678", filters = HP) {
  const l = (await Leads.captureLead(h.pool, await row(who), { phones, name: "Sara" })).lead;
  await Requests.saveRequest(h.pool, await row(who), l.id, filters);
  return l;
}

test("units from the web form (createListing, as the draft and the imports use), a direct insert and a quick update each alert exactly once", async () => {
  await lead();
  const { agent, csrf } = await signIn(h, "broker");
  await agent.post("/app/units/new").field("_csrf", csrf).field("listing_type", "sale").field("market", "resale").field("property_type", "apartment")
    .field("compound", "Hyde Park").field("price_value", "8.5 مليون").field("area_value", "150").field("bedrooms", "3").field("bathrooms", "2").field("code", "WEB-1");
  expect((await run()).alerts).toBe(1);
  expect(await run()).toMatchObject({ matches: 0, alerts: 0 });

  // A unit above budget, then a quick price update into range (WhatsApp «سعر»).
  await h.insertListing({ code: "HP-9", compound: "Hyde Park", price_value: 10e6, area_value: 170 });
  expect((await run()).matches).toBe(0);
  await h.text("broker", "سعر HP-9 8.9 مليون");
  expect((await run()).matches).toBe(1);
  // Rolled back above budget, then dropped again: no second alert.
  await h.text("broker", "سعر HP-9 10 مليون");
  expect((await run()).matches).toBe(0);
  await h.text("broker", "سعر HP-9 8.8 مليون");
  expect((await run()).matches).toBe(0);
  expect((await matched()).map((m) => m.code)).toEqual(["HP-9", "WEB-1"]);
  expect(await alerts()).toHaveLength(2);
});

test("a sold unit never alerts; a won or lost lead's request is quiet", async () => {
  await h.insertListing({ code: "SOLD", compound: "Hyde Park", status: "sold" });
  const l = await lead();
  expect((await run()).matches).toBe(0);
  await Leads.setStage(h.pool, await row("broker"), l.id, { stage: "won" });
  await h.insertListing({ code: "HP-2", compound: "Hyde Park" });
  expect((await run()).matches).toBe(0);
});

test("several units for several leads: one grouped alert per broker", async () => {
  await lead("broker", "01012345678");
  await lead("broker", "01112345678", { ...HP, price_max: 20e6 });
  await h.insertListing({ code: "HP-1", compound: "Hyde Park" });
  await h.insertListing({ code: "HP-2", compound: "Hyde Park", area_value: 160 });
  const c = await run();
  expect(c).toMatchObject({ matches: 4, alerts: 1 });
  const [a] = await alerts();
  expect(a.title).toMatch(/4 وحدة جديدة تناسب 2 من عملائك/);
  expect(a.body.split("\n")).toHaveLength(4);
});

test("the daily cap holds; the matches are still recorded", async () => {
  await lead();
  for (let i = 1; i <= 3; i++) {
    await h.insertListing({ code: `HP-${i}`, compound: "Hyde Park", area_value: 140 + i });
    await run({ dailyCap: 2 });
  }
  expect(await alerts()).toHaveLength(2);
  expect(await matched()).toHaveLength(3);
});

test("the sweep finds the same units as search for the same filters", async () => {
  await lead();
  const specs = [
    { code: "A", compound: "Hyde Park", price_value: 8e6 },
    { code: "B", compound: "Hyde Park", price_value: 9e6 },
    { code: "C", compound: "Hyde Park", price_value: 9.5e6 },
    { code: "D", compound: "Mivida", price_value: 8e6 },
    { code: "E", compound: "Hyde Park", price_value: 8e6, property_type: "villa" },
    { code: "F", compound: "Hyde Park", price_value: 8e6, listing_type: "rent" }
  ];
  for (const s of specs) await h.insertListing(s);
  await run();
  const viaSearch = await Search.runSearch(h.pool, h.AGENCY_A, { filters: { ...require("../../domain/searchQuery").emptyFilters(), ...HP } });
  const codes = (await h.query("SELECT code FROM listings WHERE id = ANY($1::uuid[]) ORDER BY code", [viaSearch.ids])).map((r) => r.code);
  expect((await matched()).map((m) => m.code)).toEqual(codes);
  expect(codes).toEqual(["A", "B"]);
});

test("another agency's unit never alerts, and their requests never see ours", async () => {
  await lead();
  await lead("rival", "01212345678");
  await h.insertListing({ code: "RIVAL-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: "Hyde Park" });
  await run();
  expect(await alerts("broker")).toHaveLength(0);
  expect(await alerts("rival")).toHaveLength(1);
  const rows = await h.query("SELECT m.agency_id, l.agency_id AS unit_agency FROM lead_matches m JOIN listings l ON l.id = m.listing_id");
  expect(rows.every((r) => r.agency_id === r.unit_agency)).toBe(true);
});

test("the alert goes to the lead's current broker after a reassignment", async () => {
  const l = await lead();
  await Leads.assignLead(h.pool, await row("admin"), l.id, h.BROKERS.colleague.id);
  await h.insertListing({ code: "HP-1", compound: "Hyde Park" });
  await run();
  expect(await alerts("broker")).toHaveLength(0);
  expect(await alerts("colleague")).toHaveLength(1);
});

test("a lead moved back to the unassigned pool alerts nobody (not the broker who saved the request)", async () => {
  const l = await lead();
  await Leads.assignLead(h.pool, await row("admin"), l.id, null);
  await h.insertListing({ code: "HP-1", compound: "Hyde Park" });
  await run();
  expect(await alerts("broker")).toHaveLength(0);
  expect((await h.query("SELECT count(*)::int AS n FROM lead_matches"))[0].n).toBe(1);
});

test("the job is registered", () => {
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("match_sweep");
  expect(Store.findDuplicate).toBeInstanceOf(Function);
});

test("N3: a client quiet for 60 days gets the line in the alert; each user can switch it off in Settings", async () => {
  const l = await lead();
  await h.query("UPDATE leads SET last_contact_at = now() - interval '75 days', created_at = now() - interval '90 days' WHERE id = $1", [l.id]);
  await h.insertListing({ code: "HP-Q1", compound: "Hyde Park", price_value: 8e6, area_value: 150 });
  await run();
  expect((await alerts()).pop().body).toMatch(/بقالك 75 يوم مكلمتوش/);

  const { agent, csrf } = await signIn(h, "broker");
  expect((await agent.get("/app/settings")).text).toContain('id="quiet-line"');
  await agent.post("/app/settings/quiet-line").type("form").send({ _csrf: csrf });
  await h.insertListing({ code: "HP-Q2", compound: "Hyde Park", price_value: 8e6, area_value: 150 });
  await run();
  expect((await alerts()).pop().body).not.toMatch(/يوم/);

  // A recent call: no line even when switched on.
  await agent.post("/app/settings/quiet-line").type("form").send({ _csrf: csrf, on: "1" });
  await h.query("UPDATE leads SET last_contact_at = now() - interval '5 days' WHERE id = $1", [l.id]);
  await h.insertListing({ code: "HP-Q3", compound: "Hyde Park", price_value: 8e6, area_value: 150 });
  await run();
  expect((await alerts()).pop().body).not.toMatch(/مكلمتوش/);
});
