// tests/crm/lead-requests.test.js — A lead's requests (Release 3 step 7): saved searches tied to the lead, up to 3,
// the units that fit now recorded (never alerted), replace and remove, rights and tenant isolation.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Requests = require("../../services/leadRequests");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const lead = async (who = "broker", phones = "01012345678") => (await Leads.captureLead(h.pool, await row(who), { phones, name: "Sara" })).lead;
const HP = { property_types: ["apartment"], places: [{ kind: "compound", key: "hyde_park" }], price_max: 9000000 };

test("a request records the units that fit now (status new) and shows the first five", async () => {
  await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 8.5e6 });
  await h.insertListing({ code: "HP-2", compound: "Hyde Park", price_value: 12e6 });
  await h.insertListing({ code: "RIVAL", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: "Hyde Park", price_value: 8e6 });
  const l = await lead();
  const r = await Requests.saveRequest(h.pool, await row("broker"), l.id, HP);
  expect(r.ok).toBe(true);
  expect(r.matches.total).toBe(1);
  expect(r.matches.rows.map((x) => x.code)).toEqual(["HP-1"]);
  const saved = await h.query("SELECT * FROM saved_searches WHERE lead_id = $1", [l.id]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ broker_id: h.BROKERS.broker.id, alerts_enabled: true });
  const matches = await h.query("SELECT m.status, l.code FROM lead_matches m JOIN listings l ON l.id = m.listing_id");
  expect(matches).toEqual([{ status: "new", code: "HP-1" }]);
  const ev = await h.query("SELECT data FROM lead_events WHERE lead_id = $1 AND kind = 'request_set'", [l.id]);
  expect(ev[0].data.request_id).toBe(saved[0].id);
});

test("up to 3 per lead; replace and remove; a code-only or empty request is refused", async () => {
  const l = await lead();
  const b = await row("broker");
  for (let i = 0; i < 3; i++) expect((await Requests.saveRequest(h.pool, b, l.id, { ...HP, bedrooms_min: i + 1 })).ok).toBe(true);
  expect(await Requests.saveRequest(h.pool, b, l.id, HP)).toEqual({ error: "too_many_requests" });
  const [first] = await Requests.listRequests(h.pool, b, l);
  const replaced = await Requests.saveRequest(h.pool, b, l.id, { ...HP, bedrooms_min: 4 }, { requestId: first.id });
  expect(replaced.ok).toBe(true);
  expect((await Requests.listRequests(h.pool, b, l))[0].filters.bedrooms_min).toBe(4);
  expect((await Requests.removeRequest(h.pool, b, l.id, first.id)).ok).toBe(true);
  expect(await Requests.listRequests(h.pool, b, l)).toHaveLength(2);
  expect(await Requests.saveRequest(h.pool, b, l.id, { code: "HP-1" })).toEqual({ error: "request_empty" });
  expect(await Requests.saveRequest(h.pool, b, l.id, {})).toEqual({ error: "request_empty" });
});

test("a colleague or another agency can't add, list or remove; the request belongs to the lead's broker", async () => {
  const l = await lead();
  expect(await Requests.saveRequest(h.pool, await row("colleague"), l.id, HP)).toEqual({ error: "not_found" });
  expect(await Requests.saveRequest(h.pool, await row("rival"), l.id, HP)).toEqual({ error: "not_found" });
  // A manager adds one for the broker's lead: it alerts the lead's broker.
  const r = await Requests.saveRequest(h.pool, await row("admin"), l.id, HP);
  expect((await h.query("SELECT broker_id FROM saved_searches WHERE id = $1", [r.request.id]))[0].broker_id).toBe(h.BROKERS.broker.id);
  expect(await Requests.removeRequest(h.pool, await row("colleague"), l.id, r.request.id)).toEqual({ error: "not_found" });
  expect(await Requests.removeRequest(h.pool, await row("broker"), l.id, "x")).toEqual({ error: "not_found" });
});

test("lead requests never show among the broker's saved searches", async () => {
  const l = await lead();
  await Requests.saveRequest(h.pool, await row("broker"), l.id, HP);
  const { signIn } = require("../harness/web");
  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/searches");
  expect(page.status).toBe(200);
  expect(page.text).not.toContain("/app/searches/" + (await h.query("SELECT id FROM saved_searches"))[0].id);
});
