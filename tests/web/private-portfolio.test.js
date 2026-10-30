// tests/web/private-portfolio.test.js — The agency owner's private units and leads: only the agency owner sets them and
// sees them; brokers and managers get nothing (lists, pages, board); they still count toward the plan limit; jobs skip them.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Billing = require("../../services/billing");
const Vis = require("../../lib/visibility");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("owner");
  await h.seedBroker("manager");
  await h.insertListing({ code: "PUB-1" });
  await h.insertListing({ code: "SECRET-1" });
  await h.query("UPDATE listings SET is_private = true WHERE code = 'SECRET-1'");
  const owner = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.owner.id]))[0];
  await Leads.captureLead(h.pool, owner, { phones: "01012345678", name: "Visible Client" });
  await Leads.captureLead(h.pool, owner, { phones: "01112345678", name: "Hidden Client" });
  await h.query("UPDATE leads SET is_private = true WHERE name = 'Hidden Client'");
});
afterAll(closeHarness);

test("managers and brokers never see private units or leads; the agency owner does", async () => {
  for (const who of ["manager", "broker"]) {
    const s = await signIn(h, who);
    expect((await s.agent.get("/app/units/SECRET-1")).status).toBe(404);
    expect((await s.agent.get("/app/units/PUB-1")).status).toBe(200);
    expect((await s.agent.get("/app/units")).text).not.toContain("SECRET-1");
  }
  const manager = await signIn(h, "manager");
  const list = (await manager.agent.get("/app/leads")).text;
  expect(list).toContain("Visible Client");
  expect(list).not.toContain("Hidden Client");
  expect((await manager.agent.get("/app/leads/board")).text).not.toContain("Hidden Client");
  expect((await manager.agent.get("/app/leads/L-0002")).status).toBe(404);
  const owner = await signIn(h, "owner");
  expect((await owner.agent.get("/app/units/SECRET-1")).status).toBe(200);
  expect((await owner.agent.get("/app/leads")).text).toContain("Hidden Client");
});

test("only the agency owner sets an item private, and the change is logged", async () => {
  const post = (s, path, value) => s.agent.post(path).set("X-CSRF-Token", s.csrf).type("form").send({ value });
  const manager = await signIn(h, "manager");
  expect((await post(manager, "/app/units/PUB-1/portfolio", "1")).status).toBe(404);
  const owner = await signIn(h, "owner");
  expect((await post(owner, "/app/units/PUB-1/portfolio", "1")).status).toBe(303);
  expect((await h.query("SELECT is_private FROM listings WHERE code = 'PUB-1'"))[0].is_private).toBe(true);
  expect((await post(owner, "/app/leads/L-0001/portfolio", "1")).status).toBe(303);
  expect((await h.query("SELECT is_private FROM leads WHERE ref = 1"))[0].is_private).toBe(true);
  expect((await h.query("SELECT 1 FROM operation_logs WHERE operation_type = 'portfolio_private'")).length).toBe(2);
  expect((await (await signIn(h, "manager")).agent.get("/app/units/PUB-1")).status).toBe(404);
});

test("private units still count toward the plan limit, and a job (no viewer) never sees them", async () => {
  const n = (await Billing.unitCapacity(h.pool, h.AGENCY_A)).used;
  expect(n).toBe(2);
  const jobSees = await Vis.run(null, async () => (await h.pool.query(`SELECT code FROM listings l WHERE ${Vis.units("l")}`)).rows.map((r) => r.code));
  expect(jobSees).toEqual(["PUB-1"]);
  const ownerSees = await Vis.run(h.BROKERS.owner, async () => (await h.pool.query(`SELECT code FROM listings l WHERE ${Vis.units("l")} ORDER BY code`)).rows.map((r) => r.code));
  expect(ownerSees).toEqual(["PUB-1", "SECRET-1"]);
});

test("the agency owner can list only the private items", async () => {
  const owner = await signIn(h, "owner");
  const units = (await owner.agent.get("/app/units?private=1")).text;
  expect(units).toContain("SECRET-1");
  expect(units).not.toContain("PUB-1");
  const leads = (await owner.agent.get("/app/leads?tab=private")).text;
  expect(leads).toContain("Hidden Client");
  expect(leads).not.toContain("Visible Client");
  const manager = await signIn(h, "manager");
  expect((await manager.agent.get("/app/leads?tab=private")).text).not.toContain("Hidden Client");
});
