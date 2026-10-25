// tests/web/lead-sources.test.js — Phase 2 step 7: lead sources, monthly ad spend, cost per lead and per deal
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Deals = require("../../services/deals");
const Sources = require("../../services/leadSources");
const Stages = require("../../domain/leadStages");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const thisMonth = () => Stages.toCairoLocal(new Date()).slice(0, 7);

async function seed() {
  const admin = await row("admin");
  const broker = await row("broker");
  await h.insertListing({ code: "VIL-08", property_type: "villa" });
  const a = (await Leads.captureLead(h.pool, broker, { phones: "01012345678", name: "Sara Secret", source: "Facebook" }, { quiet: true })).lead;
  await Leads.captureLead(h.pool, broker, { phones: "01012345679", source: "Facebook" }, { quiet: true });
  await Leads.captureLead(h.pool, broker, { phones: "01012345670", source: "Sheikh Zayed Oct campaign" }, { quiet: true });
  await Leads.captureLead(h.pool, broker, { phones: "01012345671" }, { quiet: true });
  // 2% of 8.5M = 170,000 commission.
  expect((await Deals.createDeal(h.pool, admin, { leadKey: a.ref, unitCode: "VIL-08", price: 8500000, mode: "pct", pct: 2 })).ok).toBe(true);
  // Another agency's leads never count.
  await Leads.captureLead(h.pool, await row("rival"), { phones: "01212345678", source: "Facebook" }, { quiet: true });
  return { admin, broker };
}

test("per source: leads, deals, commission, spend, cost per lead and per deal; free-text sources and no source listed", async () => {
  const { admin } = await seed();
  expect((await Sources.saveSpend(h.pool, admin, { month: thisMonth(), spend: { Facebook: "10,000", "Sheikh Zayed Oct campaign": "٣٠٠٠" } })).ok).toBe(true);
  const r = await Sources.report(h.pool, admin, { month: thisMonth() });
  const fb = r.rows.find((x) => x.source === "Facebook");
  expect(fb).toMatchObject({ leads: 2, deals: 1, commission: 170000, spend: 10000, perLead: 5000, perDeal: 10000 });
  expect(r.rows.find((x) => x.source === "Sheikh Zayed Oct campaign")).toMatchObject({ leads: 1, deals: 0, spend: 3000, perLead: 3000, perDeal: null });
  expect(r.rows.find((x) => x.source === Sources.NONE)).toMatchObject({ leads: 1 });
  // Common sources are listed with no leads yet so spend can be typed.
  expect(r.rows.find((x) => x.source === "Property Finder")).toMatchObject({ leads: 0, spend: 0, perLead: null });
  expect(r.totals).toMatchObject({ leads: 4, deals: 1, spend: 13000, perLead: 3250, perDeal: 13000 });
  // Another month is empty.
  expect((await Sources.report(h.pool, admin, { month: "2020-01" })).totals.leads).toBe(0);
});

test("the page: managers type spend and see the costs; 0 or empty removes it; bad amounts are refused; brokers 403", async () => {
  await seed();
  const { agent, csrf } = await signIn(h, "admin");
  const page = await agent.get("/app/sources");
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/data-source="Facebook"/);
  expect(page.text).not.toMatch(/Sara Secret|01012345678/);
  const save = await agent.post("/app/sources").set("X-CSRF-Token", csrf).type("form").send(`month=${thisMonth()}&source=Facebook&amount=4000&source=Referral&amount=&new_source=Spring+flyer&new_amount=500`);
  expect(save.status).toBe(303);
  const after = (await agent.get(save.headers.location)).text;
  expect(after).toMatch(/المصروف اتحفظ|Spend saved/);
  expect(after).toMatch(/data-source="Facebook"[\s\S]*?data-per-lead>2,000 (ج\.م|EGP)/);
  expect(after).toMatch(/data-source="Spring flyer"/);
  expect((await h.query("SELECT source, amount_egp FROM ad_spend ORDER BY source")).map((x) => [x.source, Number(x.amount_egp)])).toEqual([
    ["Facebook", 4000],
    ["Spring flyer", 500]
  ]);
  await agent.post("/app/sources").set("X-CSRF-Token", csrf).type("form").send(`month=${thisMonth()}&source=Facebook&amount=0`);
  expect(await h.query("SELECT source FROM ad_spend WHERE source = 'Facebook'")).toHaveLength(0);
  expect((await agent.post("/app/sources").set("X-CSRF-Token", csrf).type("form").send(`month=${thisMonth()}&source=Facebook&amount=abc`)).status).toBe(400);
  expect((await agent.post("/app/sources").set("X-CSRF-Token", csrf).type("form").send(`month=bad&source=Facebook&amount=1`)).status).toBe(400);

  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/sources")).status).toBe(403);
  expect((await b.agent.post("/app/sources").set("X-CSRF-Token", b.csrf).type("form").send(`month=${thisMonth()}&source=Facebook&amount=1`)).status).toBe(403);
  // The dashboard links to it.
  expect((await agent.get("/app/dashboard")).text).toMatch(/href="\/app\/sources"/);
});

test("spend is per agency", async () => {
  const { admin } = await seed();
  await Sources.saveSpend(h.pool, admin, { month: thisMonth(), spend: { Facebook: "1000" } });
  const rivalAdmin = { ...(await row("rival")), role: "admin" };
  expect((await Sources.report(h.pool, rivalAdmin, { month: thisMonth() })).rows.find((x) => x.source === "Facebook")).toMatchObject({ leads: 1, spend: 0 });
});
