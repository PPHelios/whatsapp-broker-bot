// tests/web/leases.test.js — Release B N4: opt-in rental renewal reminders. A rented unit's lease (start, months,
// rent, yearly increase, "remind me") is saved on the unit page; reminders go once each to the broker 60 and 30 days
// before the end and 30 days before each yearly increase; nothing without the tick; managers see the next 90 days of
// lease ends on the agency dashboard.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leases = require("../../services/leases");
const Lz = require("../../domain/leases");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const notes = () => h.query("SELECT title, body FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE 'lease:%' ORDER BY id", [h.BROKERS.broker.id]);

test("rules: end date, increases, the nearest reminder only", () => {
  expect(Lz.ymd(Lz.endDate({ start_date: "2025-01-31", months: 1 }))).toBe("2025-02-28");
  const lease = { start_date: "2025-01-01", months: 36, remind: true, reminded: [] };
  expect(Lz.increaseDates(lease).map((x) => Lz.ymd(x.date))).toEqual(["2026-01-01", "2027-01-01"]);
  expect(Lz.dueReminders(lease, "2027-11-05").map((r) => r.key)).toEqual(["end60"]);
  expect(Lz.dueReminders(lease, "2027-12-10").map((r) => r.key)).toEqual(["end30"]);
  expect(Lz.dueReminders(lease, "2026-12-10").map((r) => r.key)).toEqual(["inc2"]);
  expect(Lz.dueReminders({ ...lease, remind: false }, "2027-12-10")).toEqual([]);
  expect(Lz.fromForm({ start_date: "x", months: "12" })).toEqual({ error: "start_date" });
});

test("unit page: save a lease with reminders; reminders once each; managers see lease ends", async () => {
  await h.insertListing({ code: "RENT-1", listing_type: "rent", broker_id: h.BROKERS.broker.id, price_value: 20000 });
  const { agent, csrf } = await signIn(h, "broker");
  const page = await agent.get("/app/units/RENT-1");
  expect(page.text).toContain('data-lease="no"');
  const start = new Date(Date.now() - 320 * 24 * 3600 * 1000).toISOString().slice(0, 10); // 12 months: ends in ~45 days
  const saved = await agent.post("/app/units/RENT-1/lease").type("form").send({ _csrf: csrf, start_date: start, months: "12", rent: "20,000", increase_pct: "10", tenant_name: "Omar", remind: "1" });
  expect(saved.headers.location).toContain("lease=saved");
  expect((await agent.get("/app/units/RENT-1")).text).toContain("data-lease-end");

  expect(await Leases.remindDue(h.pool)).toEqual({ sent: 1 });
  expect(await Leases.remindDue(h.pool)).toEqual({ sent: 0 });
  expect((await notes())[0].title).toMatch(/RENT-1: الإيجار بيخلص/);
  // Fifteen days on: the 30-day reminder.
  expect(await Leases.remindDue(h.pool, { now: new Date(Date.now() + 16 * 24 * 3600 * 1000) })).toEqual({ sent: 1 });

  const admin = await signIn(h, "admin");
  const dash = await admin.agent.get("/app/dashboard");
  expect(dash.text).toContain('data-lease-end="RENT-1"');
  expect(dash.text).toContain("Omar");

  // A colleague can't edit it; a sale unit has no lease card.
  const other = await signIn(h, "colleague");
  expect((await other.agent.post("/app/units/RENT-1/lease").type("form").send({ _csrf: other.csrf, start_date: start, months: "12" })).status).toBe(403);
  await h.insertListing({ code: "SALE-1", broker_id: h.BROKERS.broker.id });
  expect((await agent.get("/app/units/SALE-1")).text).not.toContain('id="lease"');
});

test("no tick, no reminders", async () => {
  await h.insertListing({ code: "RENT-2", listing_type: "rent", broker_id: h.BROKERS.broker.id });
  const { agent, csrf } = await signIn(h, "broker");
  const start = new Date(Date.now() - 320 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await agent.post("/app/units/RENT-2/lease").type("form").send({ _csrf: csrf, start_date: start, months: "12" });
  expect(await Leases.remindDue(h.pool)).toEqual({ sent: 0 });
});

test("F10: the tenant is picked by lead ref; the lease shows on that lead; an unknown ref is refused", async () => {
  await h.insertListing({ code: "RENT-3", listing_type: "rent", broker_id: h.BROKERS.broker.id });
  const { agent, csrf } = await signIn(h, "broker");
  await require("../../services/leads").captureLead(h.pool, { ...h.BROKERS.broker }, { phones: "01012340000", name: "Omar Tenant", kind: "tenant" });
  const [{ ref }] = await h.query("SELECT ref FROM leads");
  const label = `L-${String(ref).padStart(4, "0")}`;
  const form = await agent.get("/app/units/RENT-3");
  expect(form.text).toContain(`<option value="${label} Omar Tenant">`);
  const bad = await agent.post("/app/units/RENT-3/lease").type("form").send({ _csrf: csrf, start_date: "2026-11-01", months: "12", tenant_name: "L-9999" });
  expect(bad.headers.location).toContain("lease=bad_bad_tenant");
  await agent.post("/app/units/RENT-3/lease").type("form").send({ _csrf: csrf, start_date: "2026-11-01", months: "12", tenant_name: label });
  const [lease] = await h.query("SELECT tenant_name, tenant_lead_id FROM leases");
  expect(lease.tenant_name).toBe(`${label} Omar Tenant`);
  expect(lease.tenant_lead_id).toBeTruthy();
  expect((await agent.get(`/app/leads/${label}`)).text).toContain('data-tenant-lease="RENT-3"');
});
