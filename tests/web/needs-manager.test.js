// tests/web/needs-manager.test.js — "Needs manager": a broker flags a lead with a note; managers are alerted (not the
// flagger) and see it on the Needs my action page, oldest first; handling clears it and tells the broker; one open flag per lead.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const post = (s, path, body) => s.agent.post(path).set("X-CSRF-Token", s.csrf).type("form").send(body);

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara Flag" });
});
afterAll(closeHarness);

test("a broker flags a lead; managers are alerted and list it; the manager handles it and the broker is told", async () => {
  const broker = await signIn(h, "broker");
  const empty = await post(broker, "/app/leads/L-0001/flag", { text: "  " });
  expect(empty.status).toBe(422);
  expect((await post(broker, "/app/leads/L-0001/flag", { text: "Client wants a discount" })).status).toBe(303);
  expect((await post(broker, "/app/leads/L-0001/flag", { text: "again" })).status).toBe(422);

  const alerts = await h.query("SELECT broker_id FROM notifications WHERE dedupe_key LIKE 'flag:%'");
  expect(alerts.map((a) => a.broker_id)).not.toContain(h.BROKERS.broker.id);
  expect(alerts.map((a) => a.broker_id)).toContain(h.BROKERS.manager.id);

  expect((await broker.agent.get("/app/leads/needs-action")).status).toBe(404);
  const manager = await signIn(h, "manager");
  const list = (await manager.agent.get("/app/leads/needs-action")).text;
  expect(list).toContain("Sara Flag");
  expect(list).toContain("Client wants a discount");
  expect((await manager.agent.get("/app/leads")).text).toContain('data-flag-count="1"');

  expect((await post(broker, "/app/leads/L-0001/flag/handle", { reply: "x" })).status).toBe(403);
  expect((await post(manager, "/app/leads/L-0001/flag/handle", { reply: "Offer 5% off" })).status).toBe(303);
  expect((await h.query("SELECT flagged_at FROM leads WHERE ref = 1"))[0].flagged_at).toBeNull();
  const told = await h.query("SELECT body FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE 'flag_done:%'", [h.BROKERS.broker.id]);
  expect(told[0].body).toBe("Offer 5% off");
  const page = (await broker.agent.get("/app/leads/L-0001")).text;
  expect(page).toContain("محتاج مدير");
  expect(page).toContain("المدير خلّص");
  expect((await manager.agent.get("/app/leads")).text).toContain('data-flag-count="0"');
});

test("a private lead flagged by the agency owner alerts nobody", async () => {
  await h.seedBroker("owner");
  await h.query("UPDATE leads SET is_private = true, assigned_broker_id = $1", [h.BROKERS.owner.id]);
  const owner = await signIn(h, "owner");
  expect((await post(owner, "/app/leads/L-0001/flag", { text: "mine" })).status).toBe(303);
  expect((await h.query("SELECT 1 FROM notifications WHERE dedupe_key LIKE 'flag:%'")).length).toBe(0);
});
