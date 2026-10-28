// tests/web/lead-routing.test.js — P2: the managers' round-robin switch and broker order. With an order, new leads go
// round in it (skipping anyone away); off, nobody is picked (leads stay with the managers); the Team page lists the
// brokers in order with their open leads and saves a new order (only the agency's active brokers kept).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const LeadRules = require("../../services/leadRules");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const id = (who) => h.BROKERS[who].id;

test("default: round robin on, no order; brokers before managers", async () => {
  const r = await LeadRules.routingOf(h.pool, h.BROKERS.admin.agency_id);
  expect(r).toEqual({ round_robin: true, order: [], last: null });
  const next = await LeadRules.nextBroker(h.pool, h.BROKERS.admin.agency_id);
  expect([id("broker"), id("colleague")]).toContain(next.id);
});

test("an order goes round, skips anyone away, and remembers who got the last lead", async () => {
  const admin = await row("admin");
  const agency = admin.agency_id;
  const saved = await LeadRules.saveRouting(h.pool, admin, { roundRobin: true, order: [id("colleague"), id("admin"), id("broker"), id("rival"), "junk"] });
  expect(saved.routing.order).toEqual([id("colleague"), id("admin"), id("broker")]);
  const picks = [];
  for (let i = 0; i < 4; i++) picks.push((await LeadRules.nextBroker(h.pool, agency, { advance: true })).id);
  expect(picks).toEqual([id("colleague"), id("admin"), id("broker"), id("colleague")]);
  // Without advance the same broker is offered again.
  expect((await LeadRules.nextBroker(h.pool, agency)).id).toBe(id("admin"));
  // Away is skipped.
  await h.query("UPDATE brokers SET away_until = now() + interval '3 days' WHERE id = $1", [id("admin")]);
  expect((await LeadRules.nextBroker(h.pool, agency)).id).toBe(id("broker"));
  // A broker can't change it.
  expect(await LeadRules.saveRouting(h.pool, await row("broker"), { roundRobin: false })).toEqual({ error: "forbidden" });
});

test("off: nobody is picked, so a lead nobody contacts stays put", async () => {
  const admin = await row("admin");
  await LeadRules.saveRouting(h.pool, admin, { roundRobin: false, order: [] });
  expect(await LeadRules.nextBroker(h.pool, admin.agency_id)).toBeNull();
});

test("Team page: ordered list with open leads; saving the switch and order", async () => {
  const admin = await row("admin");
  await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara", assignTo: id("colleague") });
  const { agent, csrf } = await signIn(h, "admin");
  const page = await agent.get("/app/team");
  expect(page.status).toBe(200);
  expect(page.text).toContain("data-lead-routing");
  expect(page.text).toMatch(new RegExp(`data-routing-broker="${id("colleague")}"[\\s\\S]*?1 open leads`));
  const post = await agent
    .post("/app/team/routing")
    .type("form")
    .send(`_csrf=${encodeURIComponent(csrf)}&order=${id("colleague")}&order=${id("broker")}&order=${id("admin")}`);
  expect(post.status).toBe(200);
  expect(post.text).toContain("round robin is off");
  const after = await LeadRules.routingOf(h.pool, admin.agency_id);
  expect(after).toMatchObject({ round_robin: false, order: [id("colleague"), id("broker"), id("admin")] });
  const list = await LeadRules.routingList(h.pool, admin.agency_id);
  expect(list.brokers.map((b) => b.id)).toEqual([id("colleague"), id("broker"), id("admin")]);
  expect(list.brokers[0].open_leads).toBe(1);
  // Brokers can't.
  const b = await signIn(h, "broker");
  expect((await b.agent.post("/app/team/routing").type("form").send({ _csrf: b.csrf, round_robin: "on" })).status).toBe(403);
});
