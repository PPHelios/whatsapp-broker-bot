// tests/web/targets.test.js — Release B N6: a manager sets a monthly target (deals and/or commission) per broker on
// the Team page; progress for the Cairo month (the broker's share from deal_splits, cancelled deals left out) shows on
// the agency dashboard and in the broker's morning brief; brokers can't set targets.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Deals = require("../../services/deals");
const Targets = require("../../services/targets");
const Digest = require("../../services/dailyDigest");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

async function deal(code, phone) {
  await h.insertListing({ code, price_value: 5000000 });
  const lead = (await Leads.captureLead(h.pool, await row("broker"), { phones: phone, name: "Client" })).lead;
  const r = await Deals.createDeal(h.pool, await row("admin"), { leadKey: lead.ref, unitCode: code, mode: "amount", amount: 100000, closingBrokerId: h.BROKERS.broker.id, status: "signed" });
  expect(r.ok).toBe(true);
  return r.deal;
}

test("month bounds in Cairo", () => {
  const m = Targets.monthOf(new Date("2026-11-15T12:00:00Z"));
  expect(m.days).toBe(30);
  expect(m.dayOf).toBe(15);
  expect(m.start.toISOString()).toBe("2026-10-31T22:00:00.000Z");
  expect(m.end.toISOString()).toBe("2026-11-30T22:00:00.000Z");
});

test("Team page target, dashboard progress, brief line; brokers can't set targets", async () => {
  const admin = await signIn(h, "admin");
  const bad = await admin.agent.post(`/app/team/${h.BROKERS.broker.id}/target`).type("form").send({ _csrf: admin.csrf, deals: "0" });
  expect(bad.status).toBe(400);
  const ok = await admin.agent.post(`/app/team/${h.BROKERS.broker.id}/target`).type("form").send({ _csrf: admin.csrf, deals: "4", commission: "400,000" });
  expect(ok.status).toBe(200);
  expect(ok.text).toContain('value="4"');
  expect((await Targets.setTarget(h.pool, await row("broker"), h.BROKERS.colleague.id, { deals: "3" })).error).toBe("forbidden");

  await deal("T-1", "01011110001");
  const cancelled = await deal("T-2", "01011110002");
  await h.query("UPDATE deals SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
  const p = (await Targets.progress(h.pool, h.AGENCY_A)).get(h.BROKERS.broker.id);
  expect(p).toMatchObject({ deals: 1, commission: 100000, target_deals: 4, target_commission: 400000 });

  const dash = await admin.agent.get("/app/dashboard");
  expect(dash.text).toContain(`data-target="${h.BROKERS.broker.id}"`);
  expect(dash.text).toContain("1 / 4");

  const line = Targets.briefLine(p, "en", (n) => `${n} EGP`);
  expect(line).toMatch(/^🎯 This month: 1\/4 deals · 100000 EGP\/400000 EGP \(25%\)/);
  const data = await Digest.briefData(h.pool, await row("broker"), new Date());
  expect(data.target).toMatchObject({ deals: 1 });
});
