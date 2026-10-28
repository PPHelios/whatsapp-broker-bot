// tests/web/unit-privacy.test.js — Agency-only unit location and secret details: who sees them, asking for access,
// the manager's switch, pins from the bot, the viewing place, and the managers-only Excel export.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const Privacy = require("../../services/unitPrivacy");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const SECRET = { owner_name: "Mr Secret", owner_phone: "01099998888", commission: "2.5%", unit_no: "B-14", address: "12 Street 90" };
const seed = () => h.insertListing({ code: "HP-1", details: SECRET, lat: 30.0123, lng: 31.4567 });
const page = async (agent) => (await agent.get("/app/units/HP-1")).text;

test("parsePin reads coordinates and the common Google Maps link shapes", () => {
  expect(Privacy.parsePin("30.0444, 31.2357")).toEqual({ lat: 30.0444, lng: 31.2357 });
  expect(Privacy.parsePin("https://www.google.com/maps/place/x/@30.0123,31.4567,17z")).toEqual({ lat: 30.0123, lng: 31.4567 });
  expect(Privacy.parsePin("https://maps.google.com/?q=30.1,31.2")).toEqual({ lat: 30.1, lng: 31.2 });
  expect(Privacy.parsePin("https://www.google.com/maps/place/x/data=!3d30.5!4d31.6")).toEqual({ lat: 30.5, lng: 31.6 });
  expect(Privacy.parsePin("https://maps.app.goo.gl/abc")).toBeNull();
  expect(Privacy.parsePin("200, 31")).toBeNull();
});

test("by default only the unit's broker and managers see the secret details; another broker asks and is let in", async () => {
  await seed();
  const own = await signIn(h, "broker");
  expect(await page(own.agent)).toMatch(/Mr Secret[\s\S]*B-14[\s\S]*maps\.google\.com\/\?q=30\.0123,31\.4567/);
  const admin = await signIn(h, "admin");
  expect(await page(admin.agent)).toContain("Mr Secret");

  const other = await signIn(h, "colleague");
  const hidden = await page(other.agent);
  expect(hidden).not.toMatch(/Mr Secret|01099998888|2\.5%|B-14|12 Street 90|30\.0123/);
  expect(hidden).toContain("/app/units/HP-1/access");
  const ask = await other.agent.post("/app/units/HP-1/access").type("form").send({ _csrf: other.csrf });
  expect(ask.status).toBe(303);
  expect(await page(other.agent)).not.toContain('action="/app/units/HP-1/access"');
  const notes = await h.query("SELECT broker_id FROM notifications WHERE dedupe_key LIKE 'unit_access:%' ORDER BY broker_id");
  expect(notes.map((n) => n.broker_id).sort()).toEqual([h.BROKERS.broker.id, h.BROKERS.admin.id].sort());

  // The colleague can't answer their own ask; the unit's broker can.
  const [{ id }] = await h.query("SELECT id FROM unit_access_requests");
  expect((await other.agent.post(`/app/units/HP-1/access/${id}`).type("form").send({ _csrf: other.csrf, approve: "1" })).status).toBe(403);
  expect(await page(own.agent)).toContain(`/app/units/HP-1/access/${id}`);
  expect((await own.agent.post(`/app/units/HP-1/access/${id}`).type("form").send({ _csrf: own.csrf, approve: "1" })).status).toBe(303);
  expect(await page(other.agent)).toContain("Mr Secret");
  const logs = await h.query("SELECT operation_type FROM operation_logs WHERE operation_type LIKE 'secret_details_%' ORDER BY operation_type");
  expect(logs.map((l) => l.operation_type)).toEqual(["secret_details_decision", "secret_details_request"]);
});

test("a manager can open secret details to every broker; brokers can't change it", async () => {
  await seed();
  const other = await signIn(h, "colleague");
  expect((await other.agent.post("/app/dashboard/secret-details").type("form").send({ _csrf: other.csrf, scope: "all" })).status).toBe(403);
  const admin = await signIn(h, "admin");
  expect((await admin.agent.get("/app/dashboard")).text).toContain('id="data-security"');
  expect((await admin.agent.post("/app/dashboard/secret-details").type("form").send({ _csrf: admin.csrf, scope: "all" })).status).toBe(303);
  expect(await page(other.agent)).toContain("Mr Secret");
});

test("the unit's broker saves a pin, unit number and address; client pages and search never show them", async () => {
  await h.insertListing({ code: "HP-2" });
  const own = await signIn(h, "broker");
  const bad = await own.agent.post("/app/units/HP-2/private").type("form").send({ _csrf: own.csrf, pin: "somewhere nice" });
  expect(bad.headers.location).toMatch(/private=bad_pin/);
  await own.agent.post("/app/units/HP-2/private").type("form").send({ _csrf: own.csrf, pin: "https://maps.google.com/?q=30.2,31.3", unit_no: "A-7", address: "Gate 2" });
  const [row] = await h.query("SELECT lat, lng, details FROM listings WHERE code = 'HP-2'");
  expect(row).toMatchObject({ lat: 30.2, lng: 31.3, details: { unit_no: "A-7", address: "Gate 2" } });
  const colleague = await signIn(h, "colleague");
  expect((await colleague.agent.post("/app/units/HP-2/private").type("form").send({ _csrf: colleague.csrf, pin: "30,31" })).status).toBe(404);
  const search = await own.agent.get("/app/search").query({ code: "HP-2" });
  expect(search.text).not.toMatch(/A-7|Gate 2|30\.2,31\.3/);
});

test("a pin sent to the bot goes on the unit the broker picks", async () => {
  await h.insertListing({ code: "HP-3" });
  const offer = await h.send("broker", { type: "location", location: { latitude: 30.111111, longitude: 31.222222 } });
  const buttons = offer.flatMap((r) => r.buttons || []);
  expect(buttons.map((b) => b.id)).toContain("pin:HP-3:30.111111:31.222222");
  const saved = await h.send("broker", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "pin:HP-3:30.111111:31.222222", title: "x" } } });
  expect(textOf(saved)).toMatch(/HP-3/);
  expect(await h.query("SELECT lat, lng FROM listings WHERE code = 'HP-3'")).toEqual([{ lat: 30.111111, lng: 31.222222 }]);
  // Another broker's tap on the same button changes nothing.
  await h.send("colleague", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "pin:HP-3:1:2", title: "x" } } });
  expect(await h.query("SELECT lat FROM listings WHERE code = 'HP-3'")).toEqual([{ lat: 30.111111 }]);
});

test("the bot's unit card hides secret details from other brokers", async () => {
  await seed();
  expect(textOf(await h.text("broker", "HP-1"))).toContain("Mr Secret");
  const other = textOf(await h.text("colleague", "HP-1"));
  expect(other).not.toMatch(/Mr Secret|01099998888|B-14/);
  expect(other).toMatch(/البيانات الخاصة/);
});

test("only managers can export every unit to Excel, on the bot and the web, and it is logged", async () => {
  await seed();
  expect(textOf(await h.text("broker", "export"))).toMatch(/للمديرين بس/);
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/units-export.xlsx")).status).toBe(403);
  const a = await signIn(h, "admin");
  const x = await a.agent.get("/app/units-export.xlsx");
  expect(x.status).toBe(200);
  expect(x.headers["content-type"]).toMatch(/spreadsheetml/);
  const logs = await h.query("SELECT status FROM operation_logs WHERE operation_type = 'command_inventory_export' ORDER BY created_at");
  expect(logs.map((l) => l.status)).toEqual(["failed", "success"]);
});
