// tests/web/unit-form-ui.test.js — The add/edit unit form: payment tabs (resale / primary), photo preview ordering hook,
// and the owner's lead code (must be an existing lead the broker can see; kept as L-0042; linked from the unit page).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished", force: "1", owner_phone: "01012345678" };
const post = (agent, csrf, fields) => {
  let r = agent.post("/app/units/new").field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r;
};

test("the form has payment tabs and the photo preview hook", async () => {
  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/units/new?lang=en");
  expect(page.text).toContain('data-tabs="pay"');
  expect(page.text).toContain('id="pay-tab-resale"');
  expect(page.text).toContain('id="pay-tab-primary"');
  expect(page.text).toContain("data-photo-sort");
  expect(page.text).toContain("data-photo-preview");
});

test("owner lead code: unknown codes are refused, a known one is kept as L-0042 and linked from the unit page", async () => {
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = await Leads.captureLead(h.pool, broker, { phones: ["01011112222"], name: "Mona Saeed" });
  const { agent, csrf } = await signIn(h, "broker");
  const bad = await post(agent, csrf, { ...FIELDS, owner_lead: "L-9999" });
  expect(bad.status).toBe(422);
  expect(bad.text).toContain("L-9999");
  const ok = await post(agent, csrf, { ...FIELDS, owner_lead: "l 1" });
  expect(ok.status).toBe(303);
  const code = decodeURIComponent(ok.headers.location.match(/units\/([^?]+)/)[1]);
  const row = (await h.query("SELECT details FROM listings WHERE code = $1", [code]))[0];
  expect(row.details.owner_lead).toBe(`L-${String(lead.lead.ref).padStart(4, "0")}`);
  const page = await agent.get(`/app/units/${encodeURIComponent(code)}`);
  expect(page.text).toContain("data-owner-lead");
  // A colleague's client is not linkable.
  const colleague = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.colleague.id]))[0];
  const theirs = await Leads.captureLead(h.pool, colleague, { phones: ["01033334444"], name: "Karim" });
  const other = await post(agent, csrf, { ...FIELDS, owner_lead: `L-${theirs.lead.ref}` });
  expect(other.status).toBe(422);
});
