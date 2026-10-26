// tests/web/commissions.test.js — Release A C8: developer commission terms per project (rate tiers, trigger, payment
// days, registration), one commission per deal on a catalogue unit, expected → claimable → claimed → partly paid /
// paid, overdue reminders every 7 days in the managers' morning brief, statements (Excel), brokers' own share only
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const Commissions = require("../../services/commissions");
const Deals = require("../../services/deals");
const Leads = require("../../services/leads");
const Digest = require("../../services/dailyDigest");
const C = require("../../domain/commissionTracker");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const comm = async (code) => (await h.query("SELECT c.* FROM commissions c JOIN deals d ON d.id = c.deal_id WHERE d.unit_code = $1", [code]))[0];

async function seed() {
  const admin = await row("admin");
  const broker = await row("broker");
  const dev = (await Catalogue.saveDeveloper(h.pool, admin, { name: "Palm Hills" })).developer;
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya", developer_id: dev.id })).project;
  const t = await Commissions.saveTerms(h.pool, admin, project.id, { mode: "pct", pct: "3", tier_min: ["2", ""], tier_pct: ["4", ""], claim_trigger: "contract", payment_days: "30", registration_days: "60" });
  expect(t.ok).toBe(true);
  const cat = { broker_id: null, market: "primary", details: { catalogue: true }, project_id: project.id };
  await h.insertListing({ ...cat, code: "BD-1", price_value: 10000000 });
  await h.insertListing({ ...cat, code: "BD-2", price_value: 8000000 });
  await h.insertListing({ code: "HP-9", project_id: project.id, price_value: 5000000 }); // resale, linked: no developer commission
  const lead = async (phone) => (await Leads.captureLead(h.pool, broker, { phones: phone, name: "Client" })).lead;
  const deal = async (code, phone, extra = {}) => {
    const r = await Deals.createDeal(h.pool, admin, { leadKey: (await lead(phone)).ref, unitCode: code, mode: "pct", pct: 2, closingBrokerId: broker.id, splits: [{ brokerId: h.BROKERS.colleague.id, pct: 40 }], status: "signed", ...extra });
    expect(r.ok).toBe(true);
    return r.deal;
  };
  return { admin, broker, dev, project, deal };
}

describe("rules", () => {
  test("terms: tiers sorted, invalid tiers refused; the rate follows the units sold in the year", () => {
    const v = C.termsFields({ mode: "pct", pct: "2.5", tier_min: ["10", "5"], tier_pct: ["3.5", "3"] });
    expect(v.fields.tiers).toEqual([{ min_units: 5, pct: 3 }, { min_units: 10, pct: 3.5 }]);
    expect(C.rateFor(v.fields, 4)).toBe(2.5);
    expect(C.rateFor(v.fields, 7)).toBe(3);
    expect(C.rateFor(v.fields, 12)).toBe(3.5);
    expect(C.termsFields({ mode: "pct", pct: "2", tier_min: ["0"], tier_pct: ["3"] })).toMatchObject({ field: "tiers" });
    expect(C.termsFields({ mode: "pct", pct: "25" })).toMatchObject({ field: "pct" });
    expect(C.remindOverdue({ status: "claimed", due_on: "2026-11-01" }, "2026-11-02")).toBe(true);
    expect(C.remindOverdue({ status: "claimed", due_on: "2026-11-01" }, "2026-11-03")).toBe(false);
    expect(C.remindOverdue({ status: "claimed", due_on: "2026-11-01" }, "2026-11-09")).toBe(true);
    expect(C.remindOverdue({ status: "paid", due_on: "2026-11-01" }, "2026-11-02")).toBe(false);
  });
});

describe("the tracker", () => {
  test("deals on catalogue units get their commission from the terms (tier on the 2nd unit); resale units none", async () => {
    const { deal } = await seed();
    await deal("BD-1", "01011111111");
    await deal("BD-2", "01022222222");
    await deal("HP-9", "01033333333");
    expect(await comm("BD-1")).toMatchObject({ status: "claimable", expected_amount: 300000 });
    expect(Number((await comm("BD-1")).rate_pct)).toBe(3);
    expect(await comm("BD-2")).toMatchObject({ expected_amount: 320000 });
    expect(Number((await comm("BD-2")).rate_pct)).toBe(4);
    expect(await comm("HP-9")).toBeUndefined();
  });

  test("claim → partly paid → paid; overdue reminders in the managers' brief every 7 days; a cancelled deal cancels it", async () => {
    const { admin, deal } = await seed();
    await deal("BD-1", "01011111111");
    const d2 = await deal("BD-2", "01022222222", { status: "pending" });
    const c = await comm("BD-1");
    expect((await Commissions.move(h.pool, admin, c.id, "claim", { invoice_no: "" })).field).toBe("invoice_no");
    expect((await Commissions.move(h.pool, admin, c.id, "claim", { invoice_no: "INV-7", invoice_url: "https://drive.example/inv7", claimed_on: "2026-10-01" })).ok).toBe(true);
    expect(await comm("BD-1")).toMatchObject({ status: "claimed", invoice_no: "INV-7" });
    expect(C.isoDay((await comm("BD-1")).due_on)).toBe("2026-10-31");

    const items = async (iso) => Commissions.briefItems(h.pool, h.AGENCY_A, { now: new Date(`${iso}T08:00:00Z`) });
    expect((await items("2026-11-01")).overdue.map((x) => x.unit_code)).toEqual(["BD-1"]);
    expect((await items("2026-11-02")).overdue).toEqual([]);
    expect((await items("2026-11-08")).overdue[0]).toMatchObject({ days: 8, outstanding: 300000 });

    const brief = Digest.briefMessage(admin, await Digest.briefData(h.pool, admin, new Date("2026-11-08T08:00:00Z")));
    expect(brief.body).toMatch(/Overdue developer commissions/);
    expect(brief.body).toMatch(/D-0001 BD-1 · Palm Hills/);

    await Commissions.move(h.pool, admin, c.id, "payment", { amount: "100,000", paid_on: "2026-11-10" });
    expect(await comm("BD-1")).toMatchObject({ status: "partly_paid", paid_amount: 100000 });
    await Commissions.move(h.pool, admin, c.id, "payment", { amount: "200000" });
    expect((await comm("BD-1")).status).toBe("paid");
    expect((await Commissions.move(h.pool, admin, c.id, "cancel")).error).toBe("state");

    // Registration: valid 60 days from the date; reminded 7 days and 1 day before it lapses.
    const c2 = await comm("BD-2");
    expect(c2.status).toBe("expected"); // pending deal: not claimable yet
    await Commissions.move(h.pool, admin, c2.id, "registration", { registered_on: "2026-10-01" });
    expect(C.isoDay((await comm("BD-2")).registration_expires_on)).toBe("2026-11-30");
    expect((await items("2026-11-23")).registrations.map((x) => x.unit_code)).toEqual(["BD-2"]);
    expect((await items("2026-11-24")).registrations).toEqual([]);

    await Deals.updateDeal(h.pool, admin, d2.ref, { status: "signed" });
    expect((await comm("BD-2")).status).toBe("claimable");
    await Deals.updateDeal(h.pool, admin, d2.ref, { status: "cancelled" });
    expect((await comm("BD-2")).status).toBe("cancelled");
    expect((await Commissions.move(h.pool, await row("broker"), c2.id, "reopen")).error).toBe("forbidden");
  });
});

describe("the pages", () => {
  test("managers: list with totals, one commission, statement and Excel, terms on the project page; brokers: own share only", async () => {
    const { project, dev, deal } = await seed();
    await deal("BD-1", "01011111111");
    const { agent, csrf } = await signIn(h, "admin");
    const list = (await agent.get("/app/commissions")).text;
    expect(list).toMatch(/data-commission-totals/);
    expect(list).toMatch(/300,000/);
    const id = (await comm("BD-1")).id;
    const claim = await agent.post(`/app/commissions/${id}`).type("form").send({ _csrf: csrf, action: "claim", invoice_no: "INV-1", version: "1" });
    expect(claim.status).toBe(303);
    const stale = await agent.post(`/app/commissions/${id}`).type("form").send({ _csrf: csrf, action: "payment", amount: "5000", version: "1" });
    expect(stale.status).toBe(409);
    const st = (await agent.get(`/app/commissions/developers/${dev.id}`)).text;
    expect(st).toMatch(/data-statement-totals="300000"/);
    const xlsx = await agent.get(`/app/commissions/developers/${dev.id}?format=xlsx`);
    expect(xlsx.headers["content-type"]).toMatch(/spreadsheetml/);
    expect((await agent.get(`/app/catalogue/projects/${project.id}`)).text).toMatch(/id="commission-terms"/);
    const bad = await agent.post(`/app/catalogue/projects/${project.id}/commission-terms`).type("form").send({ _csrf: csrf, mode: "pct", pct: "3", tier_min: "0", tier_pct: "4" });
    expect(bad.text).toMatch(/data-terms-error="tiers"/);
    const good = await agent.post(`/app/catalogue/projects/${project.id}/commission-terms`).type("form").send({ _csrf: csrf, mode: "amount", amount: "250,000", payment_days: "45" });
    expect(good.status).toBe(303);
    expect((await Commissions.getTerms(h.pool, await row("admin"), project.id))).toMatchObject({ mode: "amount", amount: 250000, payment_days: 45 });

    // The colleague shares 40% of the agency's 200,000 deal commission: 80,000; the developer's numbers stay hidden.
    const b = await signIn(h, "colleague");
    const mine = (await b.agent.get("/app/commissions")).text;
    expect(mine).toMatch(/data-my-share>80,000/);
    expect(mine).not.toMatch(/300,000|INV-1|data-commission-totals/);
    expect((await b.agent.get(`/app/commissions/${id}`)).status).toBe(403);
    expect((await b.agent.get(`/app/catalogue/projects/${project.id}`)).text).not.toMatch(/commission-terms/);
  });
});
