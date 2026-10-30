// tests/web/quotas.test.js — Every limit in one list: shown on the manager dashboard (and the extra ones on the plan
// page), in the guide, with off switches shown as "Off".
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Quotas = require("../../services/quotas");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("one list for an agency: AI credits, units, users", async () => {
  await h.insertListing({ code: "Q-1" });
  const list = await Quotas.forAgency(h.pool, h.BROKERS.admin.agency_id);
  expect(list.map((q) => q.key)).toEqual(["credits", "units", "seats"]);
  const by = Object.fromEntries(list.map((q) => [q.key, q]));
  expect(by.units).toMatchObject({ used: 1, limit: 1500 });
  expect(by.credits).toMatchObject({ used: 0, limit: 2000 });
});

test("the manager dashboard shows the limits; brokers can't open it; the guide explains them", async () => {
  const { agent } = await signIn(h, "admin");
  const dash = await agent.get("/app/dashboard?lang=en");
  expect(dash.status).toBe(200);
  expect(dash.text).toContain('id="limits"');
  for (const k of ["credits", "units", "seats"]) expect(dash.text).toContain(`data-quota="${k}"`);
  await h.seedBroker("owner");
  const plan = await (await signIn(h, "owner")).agent.get("/app/plan?lang=en"); // the credit request is the agency owner's
  expect(plan.text).toContain("data-credit-table");
  expect(plan.text).toContain("data-credit-request");
  const guide = await agent.get("/app/guide?lang=en");
  expect(guide.text).toContain('id="limits"');
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/dashboard")).status).toBe(403);
});
