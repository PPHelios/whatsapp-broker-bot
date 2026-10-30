// tests/web/unit-address-lead.test.js — The unit form keeps the agency-only unit no., address and map pin, and links
// the owner's phone to a lead (made when the agency has none). Colleagues see none of it on the unit page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const post = (agent, csrf, code, extra = {}) =>
  agent.post("/app/units/new").field("_csrf", csrf).field("listing_type", "sale").field("market", "resale").field("property_type", "apartment")
    .field("compound", "Hyde Park").field("price_value", "8.5 مليون").field("area_value", extra.area ?? "150").field("bedrooms", "3").field("bathrooms", "2")
    .field("code", code).field("owner_name", "Mr Owner").field("owner_phone", "01099998888").field("unit_no", "B-14")
    .field("address", "12 Street 90, Madinaty").field("pin", extra.pin ?? "30.0123, 31.4567");

const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code = $1", [code]))[0];

test("the form saves the unit no., address and pin, and links the owner to a new lead", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  await post(agent, csrf, "WEB-2");
  const l = await unit("WEB-2");
  expect(l.details).toMatchObject({ unit_no: "B-14", address: "12 Street 90, Madinaty" });
  expect(Number(l.lat)).toBeCloseTo(30.0123);
  expect(Number(l.lng)).toBeCloseTo(31.4567);
  expect(l.details.owner_lead).toMatch(/^L-\d{4}$/);

  const leads = await h.query("SELECT ref, kind, phones FROM leads");
  expect(leads).toHaveLength(1);
  expect(leads[0]).toMatchObject({ kind: "seller", phones: ["+201099998888"] });
  expect(l.details.owner_lead).toBe(`L-${String(leads[0].ref).padStart(4, "0")}`);
});

test("a second unit with the same owner phone links to the same lead instead of making another", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  await post(agent, csrf, "WEB-2");
  await post(agent, csrf, "WEB-3", { pin: "", area: "160" });
  expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
  expect((await unit("WEB-3")).details.owner_lead).toBe((await unit("WEB-2")).details.owner_lead);
  expect((await unit("WEB-3")).lat).toBeNull();
});

test("a colleague's unit page shows neither the address, unit no., pin nor the owner's lead", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  await post(agent, csrf, "WEB-2");
  const other = await signIn(h, "colleague");
  const page = (await other.agent.get("/app/units/WEB-2")).text;
  expect(page).not.toMatch(/12 Street 90|B-14|30\.0123|31\.4567|maps\.google|01099998888/);
});

test("an unclear pin is refused and nothing is saved", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const res = await post(agent, csrf, "WEB-4", { pin: "https://maps.app.goo.gl/abc" });
  expect(res.status).toBe(422);
  expect(await unit("WEB-4")).toBeUndefined();
  expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
});

test("a new owner number without a name is not made into a lead", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  await post(agent, csrf, "WEB-5", { pin: "" }).field("owner_name", "");
  expect((await unit("WEB-5")).details).not.toHaveProperty("owner_lead");
  expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
});
