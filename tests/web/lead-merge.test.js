// tests/web/lead-merge.test.js — Release B N8: a manager merges a duplicate record into another. Numbers join (up to
// 3, extras kept in a note), history, requests, viewings and deals move over, the further stage and the open
// follow-up are kept, a "merged" event is added and the other record is gone. Confirmation by the other reference;
// brokers can't merge.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const LeadRequests = require("../../services/leadRequests");
const LeadMerge = require("../../services/leadMerge");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("merge: numbers, history, requests, stage and follow-up move; the other record is gone", async () => {
  const broker = await row("broker");
  const a = (await Leads.captureLead(h.pool, broker, { phones: ["01011112222"], name: "Sara" })).lead;
  const b = (await Leads.captureLead(h.pool, broker, { phones: ["01033334444", "01055556666", "01077778888"], name: "Sara Ali", source: "facebook" })).lead;
  await Leads.addNote(h.pool, broker, b.id, "wants a garden");
  await Leads.setStage(h.pool, broker, b.id, { stage: "interested" });
  await Leads.setFollowUp(h.pool, broker, b.id, { at: new Date(Date.now() + 86400000), kind: "call" });
  await LeadRequests.saveRequest(h.pool, broker, b.id, { listing_type: "sale", property_types: ["apartment"], price_max: 9000000 });

  expect((await LeadMerge.merge(h.pool, broker, a.id, "L-0002", { confirm: "L-0002" })).error).toBe("forbidden");
  const admin = await row("admin");
  expect((await LeadMerge.merge(h.pool, admin, a.id, "L-0002", { confirm: "L-0001" })).error).toBe("confirm");
  expect((await LeadMerge.merge(h.pool, admin, a.id, "L-0001", { confirm: "L-0001" })).error).toBe("same");

  const r = await LeadMerge.merge(h.pool, admin, a.id, "L-0002", { confirm: "l-0002" });
  expect(r.ok).toBe(true);
  expect(r.lead).toMatchObject({ name: "Sara", source: "facebook", stage: "interested", follow_up_status: "open" });
  expect(r.lead.phones).toEqual(["+201011112222", "+201033334444", "+201055556666"]);
  expect((await h.query("SELECT count(*)::int AS n FROM leads WHERE id = $1", [b.id]))[0].n).toBe(0);
  const events = await h.query("SELECT kind, data FROM lead_events WHERE lead_id = $1 ORDER BY id", [a.id]);
  expect(events.some((e) => e.kind === "note" && e.data.text === "wants a garden")).toBe(true);
  expect(events.some((e) => e.kind === "note" && e.data.text.includes("+201077778888"))).toBe(true);
  expect(events.find((e) => e.kind === "merged").data).toMatchObject({ from_ref: 2, from_name: "Sara Ali", phones_added: 2 });
  expect((await LeadRequests.listRequests(h.pool, admin, r.lead))).toHaveLength(1);
  // The moved number now finds the kept lead.
  expect((await Leads.findByPhone(h.pool, admin, "01033334444")).lead.id).toBe(a.id);
});

test("lead page: managers see the merge card and confirm by reference", async () => {
  const broker = await row("broker");
  await Leads.captureLead(h.pool, broker, { phones: ["01011112222"], name: "Sara" });
  await Leads.captureLead(h.pool, broker, { phones: ["01033334444"], name: "Sara 2" });
  const admin = await signIn(h, "admin");
  expect((await admin.agent.get("/app/leads/L-0001")).text).toContain('id="merge"');
  const bad = await admin.agent.post("/app/leads/L-0001/merge").type("form").send({ _csrf: admin.csrf, other: "L-0002", confirm: "L-0003" });
  expect(bad.status).toBe(422);
  const ok = await admin.agent.post("/app/leads/L-0001/merge").type("form").send({ _csrf: admin.csrf, other: "L-0002", confirm: "L-0002" });
  expect(ok.headers.location).toContain("done=merged");
  expect((await admin.agent.get("/app/leads/L-0001")).text).toMatch(/Merged with L-0002|اتدمج معاه L-0002/);
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/leads/L-0001")).text).not.toContain('id="merge"');
});
