// tests/web/unit-owners.test.js — Unit owner profiles: made and merged by phone when a unit is saved, visible to the unit's
// broker while it is active and to managers (not for a private unit) and the agency owner; managers edit them and move a
// unit to another owner, including a lead who bought it; the lead and owner pages link to each other.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const post = (s, path, body) => s.agent.post(path).set("X-CSRF-Token", s.csrf).type("form").send(body);
const owners = () => h.query("SELECT * FROM unit_owners ORDER BY created_at");

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.seedBroker("owner");
  await h.insertListing({ code: "U-1", details: { owner_name: "Mr Owner", owner_phone: "01099998888" } });
});
afterAll(closeHarness);

test("a unit saved with an owner phone makes one profile; a second unit with the same phone joins it", async () => {
  const broker = await row("broker");
  const l1 = (await h.query("SELECT * FROM listings WHERE code = 'U-1'"))[0];
  await require("../../services/unitOwners").syncFromListing(h.pool, broker, l1);
  const l2 = await h.insertListing({ code: "U-2", details: { owner_name: "Mr Owner", owner_phone: "+20 109 999 8888" } });
  await require("../../services/unitOwners").syncFromListing(h.pool, broker, l2);
  const all = await owners();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ name: "Mr Owner", phones: ["201099998888"] });
  expect(await h.query("SELECT code FROM listings WHERE owner_id = $1 ORDER BY code", [all[0].id])).toEqual([{ code: "U-1" }, { code: "U-2" }]);
});

test("saving a unit on the website links the owner", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  await agent.post("/app/units/new").field("_csrf", csrf).field("listing_type", "sale").field("market", "resale").field("property_type", "apartment")
    .field("compound", "Hyde Park").field("price_value", "8.5 مليون").field("area_value", "150").field("bedrooms", "3").field("bathrooms", "2")
    .field("force", "1").field("code", "WEB-1").field("owner_name", "Hana").field("owner_phone", "01155556666");
  expect((await h.query("SELECT owner_id FROM listings WHERE code = 'WEB-1'"))[0].owner_id).toBeTruthy();
  expect((await owners()).map((o) => o.name)).toContain("Hana");
});

test("who sees a profile: the unit's broker while it is active, managers, the agency owner; a private unit's owner is hidden from managers", async () => {
  const broker = await row("broker");
  await require("../../services/unitOwners").syncFromListing(h.pool, broker, (await h.query("SELECT * FROM listings WHERE code = 'U-1'"))[0]);
  const [o] = await owners();
  const get = async (who) => (await (await signIn(h, who)).agent.get(`/app/owners/${o.id}`)).status;
  expect(await get("broker")).toBe(200);
  expect(await get("colleague")).toBe(404);
  expect(await get("manager")).toBe(200);
  await h.query("UPDATE listings SET status = 'sold' WHERE code = 'U-1'");
  expect(await get("broker")).toBe(404);
  await h.query("UPDATE listings SET status = 'active', is_private = true WHERE code = 'U-1'");
  expect(await get("manager")).toBe(404);
  expect(await get("owner")).toBe(200);
});

test("a manager edits the notes and flag, and the history records it; a broker cannot", async () => {
  const broker = await row("broker");
  await require("../../services/unitOwners").syncFromListing(h.pool, broker, (await h.query("SELECT * FROM listings WHERE code = 'U-1'"))[0]);
  const [o] = await owners();
  expect((await post(await signIn(h, "broker"), `/app/owners/${o.id}`, { name: "X", notes: "n", flag: "f" })).status).toBe(403);
  const manager = await signIn(h, "manager");
  expect((await post(manager, `/app/owners/${o.id}`, { name: "Mr Owner", notes: "Wants a quick sale", flag: "Slow payer" })).status).toBe(303);
  const page = (await manager.agent.get(`/app/owners/${o.id}`)).text;
  expect(page).toContain("Wants a quick sale");
  expect(page).toContain("Slow payer");
  expect((await h.query("SELECT kind FROM unit_owner_events WHERE owner_id = $1 ORDER BY id", [o.id])).map((e) => e.kind)).toEqual(["created", "unit_linked", "flag", "note"]);
});

test("a manager moves a unit to the lead who bought it; the lead becomes an owner profile and both histories record it", async () => {
  const broker = await row("broker");
  await require("../../services/unitOwners").syncFromListing(h.pool, broker, (await h.query("SELECT * FROM listings WHERE code = 'U-1'"))[0]);
  await Leads.captureLead(h.pool, broker, { phones: "01212345678", name: "Buyer Bob" });
  const manager = await signIn(h, "manager");
  expect((await post(await signIn(h, "broker"), "/app/units/U-1/owner", { lead: "L-0001" })).status).toBe(403);
  expect((await post(manager, "/app/units/U-1/owner", { lead: "L-0099" })).status).toBe(422);
  expect((await post(manager, "/app/units/U-1/owner", { lead: "L-0001" })).status).toBe(303);
  const all = await owners();
  expect(all).toHaveLength(2);
  const bob = all.find((x) => x.name === "Buyer Bob");
  const unit = (await h.query("SELECT owner_id, details FROM listings WHERE code = 'U-1'"))[0];
  expect(unit.owner_id).toBe(bob.id);
  expect(unit.details).toMatchObject({ owner_name: "Buyer Bob", owner_phone: "+201212345678" });
  const kinds = async (id) => (await h.query("SELECT kind FROM unit_owner_events WHERE owner_id = $1 ORDER BY id", [id])).map((e) => e.kind);
  expect(await kinds(bob.id)).toEqual(["created", "unit_moved_in"]);
  expect(await kinds(all.find((x) => x.name === "Mr Owner").id)).toContain("unit_moved_out");
  expect((await post(manager, "/app/units/U-1/owner", { lead: "L-0001" })).status).toBe(422);
  // The lead is still a lead, and the two pages link to each other.
  expect((await h.query("SELECT 1 FROM leads WHERE name = 'Buyer Bob'")).length).toBe(1);
  expect((await manager.agent.get(`/app/owners/${bob.id}`)).text).toContain("L-0001");
  expect((await manager.agent.get("/app/leads/L-0001")).text).toContain(`/app/owners/${bob.id}`);
});

test("deleting a profile keeps its units", async () => {
  const broker = await row("broker");
  await require("../../services/unitOwners").syncFromListing(h.pool, broker, (await h.query("SELECT * FROM listings WHERE code = 'U-1'"))[0]);
  const [o] = await owners();
  const manager = await signIn(h, "manager");
  expect((await post(manager, `/app/owners/${o.id}/delete`, {})).status).toBe(303);
  expect(await owners()).toHaveLength(0);
  expect((await h.query("SELECT owner_id FROM listings WHERE code = 'U-1'"))[0].owner_id).toBeNull();
});
