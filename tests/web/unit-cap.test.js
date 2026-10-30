// tests/web/unit-cap.test.js — The plan's cap on available units: sold and archived units don't count, a new unit past
// the cap isn't saved (web form, price-sheet apply, import) and the broker is told to upgrade; the owner edits the caps.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Credits = require("../../services/credits");
const Billing = require("../../services/billing");
const Store = require("../../lib/listingStore");
const Plans = require("../../domain/plans");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const setCap = async (plan, units) => {
  await h.query("UPDATE credit_plans SET units = $2 WHERE id = $1", [plan, units]);
  await Credits.refresh(h.pool);
};
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3", bathrooms: "2", finishing: "fully_finished" };

test("defaults per plan, owner overrides, and what counts", async () => {
  expect(Plans.planById("free").units).toBe(25);
  expect(await Billing.planLimits(h.pool)).toEqual({ solo: 300, office: 1500, agency: 5000, free: 25 });
  await setCap("office", 2);
  await h.insertListing({ code: "CAP-1" });
  await h.insertListing({ code: "CAP-2", status: "sold" });
  await h.insertListing({ code: "CAP-3", status: "archived" });
  const a = await Billing.allowance(h.pool, h.BROKERS.broker.agency_id);
  expect(a.units).toEqual({ used: 1, limit: 2 });
  expect((await Billing.unitCapacity(h.pool, h.BROKERS.broker.agency_id)).ok).toBe(true);
  expect((await Billing.unitCapacity(h.pool, h.BROKERS.broker.agency_id, { adding: 2 })).ok).toBe(false);
});

test("a unit past the cap is refused with the upgrade message; archiving makes room", async () => {
  await setCap("office", 1);
  await h.insertListing({ code: "CAP-1" });
  const { agent, csrf } = await signIn(h, "broker");
  const r = await agent.post("/app/units/new").field("_csrf", csrf).field("force", "1").field("listing_type", "sale").field("market", "resale").field("property_type", "apartment").field("compound", "Hyde Park").field("price_value", "9 مليون").field("area_value", "150").field("bedrooms", "3").field("bathrooms", "2").field("finishing", "fully_finished");
  expect(r.status).toBe(403);
  expect(r.text).toContain("وصلت للحد الأقصى");
  expect((await h.query("SELECT count(*)::int AS n FROM listings WHERE agency_id = $1", [h.BROKERS.broker.agency_id]))[0].n).toBe(1);
  await h.query("UPDATE listings SET status = 'archived' WHERE code = 'CAP-1'");
  const ok = await agent.post("/app/units/new").field("_csrf", csrf).field("force", "1").field("listing_type", "sale").field("market", "resale").field("property_type", "apartment").field("compound", "Hyde Park").field("price_value", "9 مليون").field("area_value", "150").field("bedrooms", "3").field("bathrooms", "2").field("finishing", "fully_finished");
  expect(ok.status).toBe(303);
});

test("createListing reports the cap and plan; English text", async () => {
  await setCap("office", 1);
  await h.insertListing({ code: "CAP-1" });
  const res = await Store.createListing(h.pool, await row("broker"), { fields: { listing_type: "sale", property_type: "apartment", price_value: 5e6, area_value: 100 }, code: null, lang: "en" });
  expect(res.limit).toMatchObject({ used: 1, limit: 1 });
  expect(Plans.unitLimitText(res.limit, "en")).toContain("Office plan holds 1 available units");
});

test("owner edits the caps on /app/owner; the plan page shows the meter", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  require("../../config").resetConfig();
  try {
    const { agent, csrf } = await signIn(h, "admin");
    expect((await agent.get("/app/owner")).text).toContain("data-credit-plans");
    const form = { _csrf: csrf };
    for (const p of await Credits.plans(h.pool)) Object.assign(form, { [`p_${p.id}_name_ar`]: p.name_ar, [`p_${p.id}_name_en`]: p.name_en, [`p_${p.id}_price`]: p.price_egp, [`p_${p.id}_seats`]: p.seats, [`p_${p.id}_units`]: p.id === "solo" ? 200 : p.units, [`p_${p.id}_credits`]: p.credits, [`p_${p.id}_active`]: "on" });
    const r = await agent.post("/app/owner/credit-plans").type("form").send(form);
    expect(r.status).toBe(200);
    expect((await Billing.planLimits(h.pool)).solo).toBe(200);
    const plan = await agent.get("/app/plan?lang=en");
    expect(plan.text).toContain("Available units");
    const b = await signIn(h, "broker");
    expect((await b.agent.post("/app/owner/credit-plans").type("form").send({ _csrf: b.csrf })).status).toBe(404);
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  }
});
