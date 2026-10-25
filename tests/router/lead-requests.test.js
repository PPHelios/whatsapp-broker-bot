// tests/router/lead-requests.test.js — «طلب …» / "request …" on WhatsApp (Release 3 step 7): on the open lead or by
// reference, by text or by voice (the same request), one reply with the summary and the units that fit now.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const one = (who, replies) => {
  const mine = to(who, replies);
  expect(mine).toHaveLength(1);
  return mine[0];
};
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const PARSE = { intent: "search", filters: { listing_type: "sale", property_types: ["apartment"], compound: "Hyde Park", price_max: 9000000, bedrooms_min: 3, bedrooms_max: 3 } };
const requests = () => h.query("SELECT filters FROM saved_searches WHERE lead_id IS NOT NULL ORDER BY created_at");

async function seed() {
  await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 8.5e6, bedrooms: 3 });
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara" });
}

test("«طلب …» after opening the lead: saved, one reply with the summary and the units that fit", async () => {
  await seed();
  h.AI.respond((c) => (c.operation === "search_parse" ? PARSE : null));
  await h.text("broker", "L-0001");
  const r = one("broker", await h.text("broker", "طلب شقة 3 غرف في هايد بارك تحت 9 مليون"));
  expect(r.text).toMatch(/طلب L-0001 اتحفظ/);
  expect(r.text).toMatch(/1 وحدة مناسبة دلوقتي/);
  expect(r.text).toContain("HP-1");
  expect(await requests()).toHaveLength(1);
});

test("a request by voice equals the same request by text", async () => {
  await seed();
  h.AI.respond((c) => (c.operation === "transcribe" ? "طلب L-0001 شقة 3 غرف في هايد بارك تحت 9 مليون" : c.operation === "search_parse" ? PARSE : null));
  one("broker", await h.voice("broker"));
  h.AI.respond((c) => (c.operation === "search_parse" ? PARSE : null));
  one("broker", await h.text("broker", "request L-0001 3 bedroom apartment in Hyde Park under 9M"));
  const [a, b] = await requests();
  expect(a.filters).toEqual(b.filters);
});

test("no open lead, an empty request, an unclear one, someone else's lead", async () => {
  await seed();
  expect(one("broker", await h.text("broker", "طلب شقة في زايد")).text).toMatch(/لمين الطلب ده/);
  expect(one("broker", await h.text("broker", "طلب L-0001")).text).toMatch(/اكتب الطلب بعد/);
  h.AI.respond((c) => (c.operation === "search_parse" ? { intent: "small_talk", filters: {} } : null));
  expect(one("broker", await h.text("broker", "طلب L-0001 ازيك")).text).toMatch(/مفهمتش الطلب/);
  expect(one("colleague", await h.text("colleague", "طلب L-0001 شقة")).text).toMatch(/مبقاش معاك/);
  expect(await requests()).toHaveLength(0);
});
