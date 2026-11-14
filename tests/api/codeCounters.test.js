// tests/api/codeCounters.test.js — owner and unit numbers never repeat, even when the stored counter fell behind.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Owners = require("../../services/unitOwners");
const Store = require("../../lib/listingStore");

jest.setTimeout(60000);
let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const A = () => h.BROKERS.broker.agency_id;

test("a new owner skips codes already used when the counter is behind", async () => {
  const a = await Owners.findOrCreate(h.pool, A(), { phone: "201011111111", name: "Ali", brokerId: h.BROKERS.broker.id });
  await Owners.findOrCreate(h.pool, A(), { phone: "201022222222", name: "Bob", brokerId: h.BROKERS.broker.id });
  await h.query("UPDATE agencies SET owner_code_next = 1 WHERE id = $1", [A()]);
  const c = await Owners.findOrCreate(h.pool, A(), { phone: "201033333333", name: "Cy", brokerId: h.BROKERS.broker.id });
  expect(c.code).not.toBe(a.code);
  expect(Number(c.code.slice(2))).toBeGreaterThan(2);
});

test("a new unit code skips codes already used when the counter is behind", async () => {
  const first = await Store.nextUnitCode(h.pool, A(), "apartment");
  await h.query("INSERT INTO listings (agency_id, broker_id, code, status, listing_type, property_type, compound, details, raw_text) VALUES ($1,$2,$3,'active','sale','apartment','X','{}','x')", [A(), h.BROKERS.broker.id, first]);
  await h.query("UPDATE agencies SET unit_code_seq = 0 WHERE id = $1", [A()]);
  const second = await Store.nextUnitCode(h.pool, A(), "apartment");
  expect(second).not.toBe(first);
});
