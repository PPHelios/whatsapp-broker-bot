// tests/web/credits.test.js — 053 AI credit pool: plans, bundles and credits per action come from the database.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Credits = require("../../services/credits");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await closeHarness(h);
});

describe("AI credit pool (053)", () => {
  test("seeds the plans with 400 credits per seat on the paid plans and Solo at 199 EGP", async () => {
    const plans = await Credits.plans(h.pool);
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
    expect(byId.solo).toMatchObject({ price_egp: 199, seats: 1, credits: 400 });
    expect(byId.office).toMatchObject({ price_egp: 830, seats: 5, credits: 2000 });
    expect(byId.agency).toMatchObject({ price_egp: 2090, seats: 15, credits: 6000 });
    expect(byId.free).toMatchObject({ price_egp: 0, credits: 80 });
  });

  test("seeds the three extra bundles", async () => {
    const list = (await Credits.bundles(h.pool)).map((b) => [b.credits, b.price_egp]);
    expect(list).toEqual([
      [200, 79],
      [500, 175],
      [1000, 349]
    ]);
  });

  test("prices each action in credits and reads 0 for an unknown action", async () => {
    expect(await Credits.creditsFor(h.pool, "text")).toBe(1);
    expect(await Credits.creditsFor(h.pool, "voice")).toBe(3);
    expect(await Credits.creditsFor(h.pool, "page")).toBe(10);
    expect(await Credits.creditsFor(h.pool, "search_grounded")).toBe(0);
  });

  test("the planning rate defaults to 60 EGP per dollar and follows the app setting", async () => {
    expect(await Credits.planningRate(h.pool)).toBe(60);
    await h.pool.query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [Credits.FX_KEY, JSON.stringify(62)]);
    expect(await Credits.planningRate(h.pool)).toBe(62);
  });
});
