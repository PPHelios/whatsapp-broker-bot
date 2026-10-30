// tests/crm/seed-poc.test.js — the POC demo seed runs through the app's own services and sends nothing.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { clean, seed, UNITS, LEADS } = require("../../scripts/seed-poc");

jest.setTimeout(120000);

let h;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("clean then seed builds the demo set", async () => {
  await h.seedBroker("owner");
  await clean(h.pool, h.AGENCY_A);
  await seed(h.pool, h.AGENCY_A);
  const n = async (t) => Number((await h.query(`SELECT count(*) AS c FROM ${t}`))[0].c);
  expect(await n("listings")).toBe(UNITS.length);
  expect(await n("leads")).toBe(LEADS.length);
  expect(await n("deals")).toBeGreaterThanOrEqual(3);
  expect(await n("viewings")).toBeGreaterThan(0);
  expect(await n("unit_owners")).toBeGreaterThan(0);
  expect(await h.query("SELECT 1 FROM leads WHERE flagged_at IS NOT NULL")).not.toEqual([]);
});
