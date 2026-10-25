// tests/web/price-insights.test.js — Phase 2 step 8: price per m² by compound/area from the agency's own units
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Insights = require("../../services/priceInsights");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

async function units(compound, listing_type, perM2s, extra = {}) {
  let i = 0;
  for (const p of perM2s) {
    await h.insertListing({ code: `${compound.slice(0, 2).toUpperCase()}-${listing_type[0]}${i++}`, compound, listing_type, area_value: 100, price_value: p * 100, ...extra });
  }
}

test("median, lowest and highest per compound, sale and rent apart, only with 5+ active units of this agency", async () => {
  await units("Hyde Park", "sale", [40000, 45000, 50000, 55000, 300000]);
  await units("Hyde Park", "rent", [300, 350, 400, 450]); // 4: not enough
  await units("Mivida", "sale", [60000, 61000, 62000, 63000]);
  await h.insertListing({ code: "MV-SOLD", compound: "Mivida", listing_type: "sale", area_value: 100, price_value: 6e6, status: "sold" });
  await h.insertListing({ code: "RV-1", compound: "Mivida", listing_type: "sale", area_value: 100, price_value: 6e6, agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
  const rows = await Insights.byPlace(h.pool, h.AGENCY_A);
  expect(rows).toEqual([{ place: "Hyde Park", listing_type: "sale", units: 5, median: 50000, low: 40000, high: 300000 }]);
});

test("a unit is compared with the other units of its compound; too few others → nothing", async () => {
  await units("Hyde Park", "sale", [40000, 45000, 50000, 55000, 60000, 54000]);
  const [l] = await h.query("SELECT * FROM listings WHERE code = 'HY-s5'");
  expect(await Insights.forUnit(h.pool, l)).toEqual({ place: "Hyde Park", perM2: 54000, median: 50000, units: 5, diffPct: 8 });
  await units("Mivida", "sale", [60000, 61000, 62000, 63000, 64000]);
  const [m] = await h.query("SELECT * FROM listings WHERE code = 'MI-s0'");
  expect(await Insights.forUnit(h.pool, m)).toBeNull();

  const { agent } = await signIn(h, "broker");
  const page = await agent.get("/app/units/HY-s5");
  expect(page.text).toMatch(/data-market="8"/);
  const ins = await agent.get("/app/insights");
  expect(ins.status).toBe(200);
  expect(ins.text).toMatch(/data-kind="sale"[\s\S]*data-place="Hyde Park"/);
  expect(ins.text).toMatch(/data-place="Mivida"/);
  expect((await agent.get("/app/units")).text).toMatch(/href="\/app\/insights"/);
});
