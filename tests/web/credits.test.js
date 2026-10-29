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

describe("owner page: plans and credits", () => {
  const { signIn } = require("../harness/web");
  const owner = async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    require("../../config").resetConfig();
    return signIn(h, "admin");
  };
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  });

  test("edits plans, adds a plan and a bundle, prices actions; the plan page follows", async () => {
    const { agent, csrf } = await owner();
    const page = await agent.get("/app/owner");
    expect(page.text).toContain("data-credit-plans");
    expect(page.text).toContain("data-credit-bundles");
    expect(page.text).toContain("data-credit-actions");

    const form = { _csrf: csrf, new_id: "team", new_name_ar: "فريق", new_name_en: "Team", new_price: "1200", new_seats: "8", new_units: "900", new_credits: "3200" };
    for (const p of await Credits.plans(h.pool)) Object.assign(form, { [`p_${p.id}_name_ar`]: p.name_ar, [`p_${p.id}_name_en`]: p.name_en, [`p_${p.id}_price`]: p.id === "solo" ? 249 : p.price_egp, [`p_${p.id}_seats`]: p.seats, [`p_${p.id}_units`]: p.units, [`p_${p.id}_credits`]: p.credits, [`p_${p.id}_active`]: "on" });
    expect((await agent.post("/app/owner/credit-plans").type("form").send(form)).status).toBe(200);
    const byId = Object.fromEntries((await Credits.plans(h.pool)).map((p) => [p.id, p]));
    expect(byId.solo.price_egp).toBe(249);
    expect(byId.team).toMatchObject({ price_egp: 1200, seats: 8, credits: 3200 });
    expect(require("../../domain/plans").planById("team")).toBeTruthy();
    // A bad number is refused and nothing else changes.
    const bad = await agent.post("/app/owner/credit-plans").type("form").send({ ...form, p_solo_price: "abc" });
    expect(bad.status).toBe(400);

    const bundles = { _csrf: csrf, new_bundle_id: "b2000", new_bundle_name_ar: "٢٠٠٠", new_bundle_name_en: "2,000", new_bundle_price: "650", new_bundle_credits: "2000" };
    for (const b of await Credits.bundles(h.pool)) Object.assign(bundles, { [`b_${b.id}_name_ar`]: b.name_ar, [`b_${b.id}_name_en`]: b.name_en, [`b_${b.id}_price`]: b.price_egp, [`b_${b.id}_credits`]: b.credits, [`b_${b.id}_active`]: "on" });
    expect((await agent.post("/app/owner/credit-bundles").type("form").send(bundles)).status).toBe(200);
    expect((await Credits.bundles(h.pool)).map((b) => b.credits)).toContain(2000);

    const acts = { _csrf: csrf, fx: "55", cost_usd: "0.003" };
    for (const a of await Credits.actions(h.pool)) acts[`a_${a.action}`] = a.action === "flyer" ? 5 : a.credits;
    expect((await agent.post("/app/owner/credit-actions").type("form").send(acts)).status).toBe(200);
    expect(await Credits.creditsFor(h.pool, "flyer")).toBe(5);
    expect(await Credits.planningRate(h.pool)).toBe(55);
  });

  test("a manager's request reaches the owner page; approving grants the credits; owner can grant directly", async () => {
    const { agent, csrf } = await owner();
    const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
    expect((await Credits.requestMore(h.pool, admin, { credits: 300, note: "busy month" })).ok).toBe(true);
    const page = await agent.get("/app/owner");
    expect(page.text).toContain("data-credit-request=");
    const [req] = await Credits.pendingRequests(h.pool);
    const before = (await Credits.poolFor(h.pool, admin.agency_id, "free")).total;
    expect((await agent.post(`/app/owner/credit-requests/${req.id}`).type("form").send({ _csrf: csrf, decision: "approve", credits: "250" })).status).toBe(200);
    expect((await Credits.poolFor(h.pool, admin.agency_id, "free")).total).toBe(before + 250);
    expect(await Credits.pendingRequests(h.pool)).toEqual([]);
    expect((await agent.post("/app/owner/credit-grant").type("form").send({ _csrf: csrf, agency: admin.agency_id, credits: "100", note: "gift" })).status).toBe(200);
    expect((await Credits.poolFor(h.pool, admin.agency_id, "free")).total).toBe(before + 350);
    expect((await agent.post("/app/owner/credit-grant").type("form").send({ _csrf: csrf, agency: admin.agency_id, credits: "0" })).status).toBe(400);
  });
});
