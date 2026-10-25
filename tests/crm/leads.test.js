// tests/crm/leads.test.js — services/leads.js: capture and the Q2 duplicate rules, role scoping, tenant isolation,
// version conflicts, stage rules, undo, and releasing a deactivated broker's leads (Release 3 step 3)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Brokers = require("../../services/brokers");

jest.setTimeout(90000);

let h;
let B;
const OWNER_ID = "10000000-0000-0000-0000-000000000004";
beforeEach(async () => {
  h = await createHarness();
  // A second manager, so "every manager" means more than one.
  await h.query(
    `INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang, notify_prefs)
     VALUES ($1, $2, '201000000004', 'Agency Owner', 'owner', true, 'ar', '{"quiet":{"enabled":false}}')`,
    [OWNER_ID, h.BROKERS.admin.agency_id]
  );
  B = {};
  for (const r of await h.query("SELECT * FROM brokers")) B[Object.keys(h.BROKERS).find((k) => h.BROKERS[k].id === r.id) || "owner"] = r;
});
afterAll(closeHarness);

const notes = (who) => h.query("SELECT kind, dedupe_key, title, body FROM notifications WHERE broker_id = $1 ORDER BY id", [B[who].id]);
const eventsOf = (leadId) => h.query("SELECT kind, broker_id, data, undone_at FROM lead_events WHERE lead_id = $1 ORDER BY id", [leadId]);
const capture = (who, input, opts) => Leads.captureLead(h.pool, B[who], input, opts);

describe("capture and dedupe", () => {
  test("a broker's lead is assigned to them, gets L-0001, and every manager is alerted; no broker is", async () => {
    const r = await capture("broker", { phones: "01012345678", name: "Sara" });
    expect(r.outcome).toBe("created");
    expect(r.lead).toMatchObject({ ref: 1, assigned_broker_id: B.broker.id, phone_e164: "+201012345678", stage: "new", lawful_basis: "client_request" });
    expect((await notes("admin")).map((n) => n.kind)).toEqual(["manager_alert"]);
    expect((await notes("owner")).map((n) => n.kind)).toEqual(["manager_alert"]);
    expect(await notes("colleague")).toEqual([]);
    expect(await notes("broker")).toEqual([]);
    expect((await notes("admin"))[0].title).toContain("L-0001");
    const second = await capture("colleague", { phones: "01112345678" });
    expect(second.lead.ref).toBe(2);
    expect((await eventsOf(r.lead.id)).map((e) => e.kind)).toEqual(["created"]);
  });

  test("the same number in 4 spellings is one lead", async () => {
    const first = await capture("broker", { phones: "01012345678" });
    for (const p of ["+20 101 234 5678", "٠١٠١٢٣٤٥٦٧٨", "0020-101-234-5678"]) {
      const r = await capture("broker", { phones: p });
      expect(r.outcome).toBe("merged");
      expect(r.lead.id).toBe(first.lead.id);
    }
    expect((await h.query("SELECT count(*)::int AS n FROM leads"))[0].n).toBe(1);
  });

  test("dedupe checks second numbers; new numbers are added up to three", async () => {
    const first = await capture("broker", { phones: ["01012345678", "0225551234"] });
    expect(first.lead.phones).toEqual(["+201012345678", "+20225551234"]);
    const r = await capture("broker", { phones: ["02 2555 1234", "01212345678"], name: "Sara" });
    expect(r.outcome).toBe("merged");
    expect(r.lead.phones).toEqual(["+201012345678", "+20225551234", "+201212345678"]);
    expect(r.lead.name).toBe("Sara");
    const full = await capture("broker", { phones: ["01012345678", "01512345678"] });
    expect(full.lead.phones).toHaveLength(3);
    expect((await eventsOf(first.lead.id)).map((e) => e.kind)).toEqual(["created", "inquiry", "merged", "inquiry"]);
  });

  test("Q2 duplicate with a colleague: the owner is not messaged, the managers get both names, nothing leaks", async () => {
    const mine = await capture("broker", { phones: "01012345678", name: "Sara" });
    await h.query("DELETE FROM notifications");
    const r = await capture("colleague", { phones: "+201012345678", name: "Someone else" });
    expect(r.outcome).toBe("colleague");
    expect(r.lead).toBeUndefined();
    expect(await notes("broker")).toEqual([]);
    expect(await notes("colleague")).toEqual([]);
    for (const m of ["admin", "owner"]) {
      const [n] = await notes(m);
      expect(n.kind).toBe("manager_alert");
      expect(n.body).toContain("Broker One");
      expect(n.body).toContain("Broker Two");
    }
    const lead = (await h.query("SELECT * FROM leads WHERE id = $1", [mine.lead.id]))[0];
    expect(lead.name).toBe("Sara");
    expect(lead.assigned_broker_id).toBe(B.broker.id);
    expect((await eventsOf(mine.lead.id)).pop()).toMatchObject({ kind: "inquiry", broker_id: B.colleague.id, data: { colleague: true } });
  });

  test("Q2 a manager assigns: the assignee gets the card, the other managers the alert, nobody else", async () => {
    const r = await capture("admin", { phones: "01012345678", name: "Sara", assignTo: B.colleague.id });
    expect(r.lead.assigned_broker_id).toBe(B.colleague.id);
    const [card] = await notes("colleague");
    expect(card.kind).toBe("assignment");
    expect(card.body).toContain("0101 234 5678");
    expect(await notes("admin")).toEqual([]);
    expect((await notes("owner")).map((n) => n.kind)).toEqual(["manager_alert"]);
    expect(await notes("broker")).toEqual([]);
    const unassigned = await capture("admin", { phones: "01112345678" });
    expect(unassigned.lead.assigned_broker_id).toBeNull();
  });

  test("a broker can't assign to a colleague; a manager can't assign to another agency", async () => {
    const r = await capture("broker", { phones: "01012345678", assignTo: B.colleague.id });
    expect(r.lead.assigned_broker_id).toBe(B.broker.id);
    expect((await capture("admin", { phones: "01112345678", assignTo: B.rival.id })).error).toBe("assignee");
  });

  test("a broker re-capturing an unassigned lead claims it; the managers hear", async () => {
    const r = await capture("admin", { phones: "01012345678" });
    await h.query("DELETE FROM notifications");
    const c = await capture("broker", { phones: "01012345678" });
    expect(c).toMatchObject({ outcome: "merged", claimed: true });
    expect(c.lead.assigned_broker_id).toBe(B.broker.id);
    expect((await notes("admin")).length).toBe(1);
    expect((await eventsOf(r.lead.id)).map((e) => e.kind)).toEqual(["created", "inquiry", "assigned"]);
  });

  test("invalid input is refused with a reason", async () => {
    expect((await capture("broker", {})).error).toBe("phone_required");
    expect((await capture("broker", { phones: "12" })).error).toBe("phone_invalid");
    expect((await capture("broker", { phones: ["01012345678", "01112345678", "01212345678", "01512345678"] })).error).toBe("too_many_phones");
    expect((await capture("broker", { phones: "01012345678", kind: "investor" })).error).toBe("kind");
    expect((await capture("broker", { phones: "01012345678", lawfulBasis: "because" })).error).toBe("lawful_basis");
  });

  test("an erased client is flagged before re-capture, and can be re-captured on purpose", async () => {
    await h.query("INSERT INTO lead_erasures (agency_id, phone_hash) VALUES ($1, $2)", [B.broker.agency_id, Leads.phoneHash("+201012345678")]);
    expect((await capture("broker", { phones: "01012345678" })).outcome).toBe("erased_before");
    expect((await capture("rival", { phones: "01012345678" })).outcome).toBe("created");
    expect((await capture("broker", { phones: "01012345678", allowErased: true })).outcome).toBe("created");
    expect((await h.query("SELECT count(*)::int AS n FROM lead_erasures"))[0].n).toBe(0);
  });

  test("names and phones never reach operation_logs (PDPL)", async () => {
    await capture("broker", { phones: "01012345678", name: "Sara Secret" });
    const logs = JSON.stringify(await h.query("SELECT * FROM operation_logs"));
    expect(logs).toContain("lead_capture");
    expect(logs).not.toMatch(/Sara|1012345678|5678/);
  });
});

describe("role scoping and tenant isolation", () => {
  test("brokers see their own leads; managers all; the other agency none", async () => {
    const a = await capture("broker", { phones: "01012345678", name: "Sara" });
    const b = await capture("colleague", { phones: "01112345678", name: "Omar" });
    await capture("admin", { phones: "01212345678", name: "Pool" });
    await capture("rival", { phones: "01512345678", name: "Rival client" });
    const names = async (who, f) => (await Leads.listLeads(h.pool, B[who], f)).rows.map((r) => r.name).sort();
    expect(await names("broker")).toEqual(["Sara"]);
    expect(await names("colleague")).toEqual(["Omar"]);
    expect(await names("admin")).toEqual(["Omar", "Pool", "Sara"]);
    expect(await names("admin", { brokerId: "none" })).toEqual(["Pool"]);
    expect(await names("admin", { brokerId: B.colleague.id })).toEqual(["Omar"]);
    expect(await names("broker", { brokerId: B.colleague.id })).toEqual(["Sara"]);
    expect(await names("rival")).toEqual(["Rival client"]);
    expect(await Leads.getLead(h.pool, B.colleague, a.lead.id)).toBeNull();
    expect(await Leads.getLead(h.pool, B.rival, a.lead.id)).toBeNull();
    expect((await Leads.getLead(h.pool, B.admin, "L-0001")).assignee_name).toBe("Broker One");
    expect((await Leads.getLead(h.pool, B.colleague, b.lead.ref)).name).toBe("Omar");
    expect(await Leads.timeline(h.pool, B.colleague, a.lead.id)).toBeNull();
    expect((await Leads.setStage(h.pool, B.colleague, a.lead.id, { stage: "won" })).error).toBe("forbidden");
    expect((await Leads.setStage(h.pool, B.rival, a.lead.id, { stage: "won" })).error).toBe("not_found");
  });

  test("search by name, phone digits or reference", async () => {
    await capture("broker", { phones: "01012345678", name: "Sara Ali" });
    await capture("broker", { phones: "01112345679", name: "Omar" });
    const q = async (text) => (await Leads.listLeads(h.pool, B.broker, { q: text })).rows.map((r) => r.name);
    expect(await q("sara")).toEqual(["Sara Ali"]);
    expect(await q("0101 234")).toEqual(["Sara Ali"]);
    expect(await q("٥٦٧٩")).toEqual(["Omar"]);
    expect(await q("L-0002")).toEqual(["Omar"]);
    expect(await q("100%")).toEqual([]);
  });

  test("filters: stage, kind, no next step, overdue; pages of 20", async () => {
    const now = new Date();
    for (let i = 0; i < 22; i++) await capture("broker", { phones: `0101000${String(i).padStart(4, "0")}`, kind: i % 2 ? "tenant" : "buyer" });
    const page1 = await Leads.listLeads(h.pool, B.broker, {});
    expect(page1.rows).toHaveLength(20);
    expect(page1.more).toBe(true);
    expect((await Leads.listLeads(h.pool, B.broker, { offset: 20 })).rows).toHaveLength(2);
    expect((await Leads.listLeads(h.pool, B.broker, { kind: "tenant", limit: 100 })).rows).toHaveLength(11);
    await Leads.setFollowUp(h.pool, B.broker, "L-0001", { at: new Date(now.getTime() - 3600e3) });
    await Leads.setFollowUp(h.pool, B.broker, "L-0002", { at: new Date(now.getTime() + 3600e3) });
    await Leads.setStage(h.pool, B.broker, "L-0003", { stage: "won" });
    expect((await Leads.listLeads(h.pool, B.broker, { overdue: true })).rows.map((r) => r.ref)).toEqual([1]);
    expect((await Leads.listLeads(h.pool, B.broker, { noNextStep: true, limit: 100 })).rows).toHaveLength(19);
    expect((await Leads.listLeads(h.pool, B.broker, { stage: "won" })).rows.map((r) => r.ref)).toEqual([3]);
  });

  test("who is calling: own lead shown, a colleague's only flagged, another agency unknown", async () => {
    await capture("broker", { phones: ["01012345678", "0225551234"], name: "Sara" });
    expect((await Leads.findByPhone(h.pool, B.broker, "02 2555 1234")).lead.name).toBe("Sara");
    expect(await Leads.findByPhone(h.pool, B.colleague, "+201012345678")).toEqual({ lead: null, elsewhere: true });
    expect(await Leads.findByPhone(h.pool, B.rival, "01012345678")).toEqual({ lead: null, elsewhere: false });
    expect((await Leads.findByPhone(h.pool, B.broker, "abc")).invalid).toBe(true);
  });

  test("the database refuses a lead pointing at another agency's broker or unit", async () => {
    const r = await capture("broker", { phones: "01012345678" });
    await expect(h.query("UPDATE leads SET assigned_broker_id = $1 WHERE id = $2", [B.rival.id, r.lead.id])).rejects.toThrow(/another agency/);
    const unit = await h.insertListing({ agency_id: B.rival.agency_id, broker_id: B.rival.id, code: "RV-1" });
    expect((await Leads.setFollowUp(h.pool, B.broker, r.lead.id, { at: new Date(), kind: "viewing", listingId: unit.id })).error).toBe("unit_not_found");
  });
});

describe("changes, versions and undo", () => {
  test("stage rules: lost needs a reason; the same stage is a no-op; every move is logged", async () => {
    const { lead } = await capture("broker", { phones: "01012345678" });
    expect((await Leads.setStage(h.pool, B.broker, lead.id, { stage: "lost" })).error).toBe("lost_reason_required");
    expect((await Leads.setStage(h.pool, B.broker, lead.id, { stage: "nope" })).error).toBe("unknown_stage");
    expect((await Leads.setStage(h.pool, B.broker, lead.id, { stage: "new" })).unchanged).toBe(true);
    const r = await Leads.setStage(h.pool, B.broker, lead.id, { stage: "lost", lostReason: "bought elsewhere" });
    expect(r.lead).toMatchObject({ stage: "lost", lost_reason: "bought elsewhere", version: 2 });
    const back = await Leads.setStage(h.pool, B.broker, lead.id, { stage: "interested" });
    expect(back.lead).toMatchObject({ stage: "interested", lost_reason: null });
    expect((await eventsOf(lead.id)).filter((e) => e.kind === "stage").map((e) => e.data.to)).toEqual(["lost", "interested"]);
  });

  test("a stale version is a conflict and changes nothing", async () => {
    const { lead } = await capture("broker", { phones: "01012345678" });
    await Leads.addNote(h.pool, B.broker, lead.id, "called, no answer", { version: 1 });
    const r = await Leads.setStage(h.pool, B.admin, lead.id, { stage: "viewing", version: 1 });
    expect(r.conflict).toBe(true);
    expect((await h.query("SELECT stage, version FROM leads WHERE id = $1", [lead.id]))[0]).toEqual({ stage: "new", version: 2 });
  });

  test("contacted moves new → contacted; follow-ups: one open, done once", async () => {
    const { lead } = await capture("broker", { phones: "01012345678" });
    const c = await Leads.markContacted(h.pool, B.broker, lead.id);
    expect(c.lead.stage).toBe("contacted");
    expect(c.lead.last_contact_at).toBeTruthy();
    const unit = await h.insertListing({ code: "VIL-08" });
    await Leads.setFollowUp(h.pool, B.broker, lead.id, { at: "2026-11-01T08:00:00Z" });
    const v = await Leads.setFollowUp(h.pool, B.broker, lead.id, { at: "2026-11-02T15:00:00Z", kind: "viewing", listingId: unit.id, note: "bring keys" });
    expect(v.lead).toMatchObject({ follow_up_kind: "viewing", follow_up_listing_id: unit.id, follow_up_status: "open" });
    expect(new Date(v.lead.next_follow_up_at).toISOString()).toBe("2026-11-02T15:00:00.000Z");
    expect((await Leads.setFollowUp(h.pool, B.broker, lead.id, { at: "soon" })).error).toBe("follow_up_time");
    expect((await Leads.completeFollowUp(h.pool, B.broker, lead.id)).lead.follow_up_status).toBe("done");
    expect((await Leads.completeFollowUp(h.pool, B.broker, lead.id)).error).toBe("no_open_follow_up");
  });

  test("undo within 10 minutes restores the fields; after 10 minutes or a later change it can't", async () => {
    const { lead } = await capture("broker", { phones: "01012345678" });
    const t0 = new Date();
    const s = await Leads.setStage(h.pool, B.broker, lead.id, { stage: "lost", lostReason: "price", now: t0 });
    const u = await Leads.undo(h.pool, B.broker, s.eventId, { now: new Date(t0.getTime() + 9 * 60e3) });
    expect(u.ok).toBe(true);
    expect(u.lead).toMatchObject({ stage: "new", lost_reason: null });
    expect((await Leads.undo(h.pool, B.broker, s.eventId)).error).toBe("already_undone");

    const f = await Leads.setFollowUp(h.pool, B.broker, lead.id, { at: "2026-11-01T08:00:00Z", now: t0 });
    expect((await Leads.undo(h.pool, B.broker, f.eventId, { now: new Date(t0.getTime() + 11 * 60e3) })).error).toBe("undo_expired");
    const fu = await Leads.undo(h.pool, B.broker, f.eventId, { now: t0 });
    expect(fu.lead).toMatchObject({ follow_up_status: null, next_follow_up_at: null });

    const c = await Leads.markContacted(h.pool, B.broker, lead.id);
    await Leads.addNote(h.pool, B.broker, lead.id, "later change");
    expect((await Leads.undo(h.pool, B.broker, c.eventId)).conflict).toBe(true);
    const kinds = (await eventsOf(lead.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "undo")).toHaveLength(2);
  });

  test("undo: not someone else's event, not a created event, not another agency's", async () => {
    const { lead } = await capture("broker", { phones: "01012345678" });
    const n = await Leads.addNote(h.pool, B.broker, lead.id, "x");
    expect((await Leads.undo(h.pool, B.rival, n.eventId)).error).toBe("not_found");
    const [created] = await h.query("SELECT id FROM lead_events WHERE lead_id = $1 AND kind = 'created'", [lead.id]);
    expect((await Leads.undo(h.pool, B.broker, created.id)).error).toBe("not_undoable");
    expect((await Leads.undo(h.pool, B.broker, "1; DROP TABLE leads")).error).toBe("not_found");
    expect((await Leads.undo(h.pool, B.admin, n.eventId)).ok).toBe(true);
  });

  test("Q1 reassignment: managers only; the new broker gets the card; the old one loses access", async () => {
    const { lead } = await capture("broker", { phones: "01012345678", name: "Sara" });
    expect((await Leads.assignLead(h.pool, B.broker, lead.id, B.colleague.id)).error).toBe("forbidden");
    expect((await Leads.assignLead(h.pool, B.admin, lead.id, B.rival.id)).error).toBe("assignee");
    const r = await Leads.assignLead(h.pool, B.admin, lead.id, B.colleague.id);
    expect(r.lead.assigned_broker_id).toBe(B.colleague.id);
    expect((await notes("colleague")).map((n) => n.kind)).toEqual(["assignment"]);
    expect(await notes("broker")).toEqual([]);
    expect(await Leads.getLead(h.pool, B.broker, lead.id)).toBeNull();
    const tl = await Leads.timeline(h.pool, B.colleague, lead.id);
    expect(tl.rows.map((e) => e.kind)).toEqual(["assigned", "created"]);
    expect(tl.rows[1].broker_name).toBe("Broker One");
    expect((await Leads.undo(h.pool, B.colleague, r.eventId)).error).toBe("forbidden");
    expect((await Leads.undo(h.pool, B.admin, r.eventId)).lead.assigned_broker_id).toBe(B.broker.id);
  });
});

describe("P6: a broker leaves", () => {
  test("deactivation sends their leads to the unassigned pool and tells every manager once", async () => {
    await capture("broker", { phones: "01012345678" });
    await capture("broker", { phones: "01112345678" });
    await capture("colleague", { phones: "01212345678" });
    await h.query("DELETE FROM notifications");
    const r = await Brokers.deactivateBroker(h.pool, { agencyId: B.broker.agency_id, phone: "+20 100 000 0001" });
    expect(r).toMatchObject({ ok: true, released: 2 });
    expect((await h.query("SELECT is_active FROM brokers WHERE id = $1", [B.broker.id]))[0].is_active).toBe(false);
    expect((await Leads.listLeads(h.pool, B.admin, { brokerId: "none" })).rows).toHaveLength(2);
    for (const m of ["admin", "owner"]) {
      const n = await notes(m);
      expect(n).toHaveLength(1);
      expect(n[0].title).toMatch(/2/);
      expect(n[0].body).toContain("Broker One");
    }
    expect(await notes("colleague")).toEqual([]);
    expect((await Brokers.deactivateBroker(h.pool, { agencyId: B.rival.agency_id, phone: "201000000002" })).error).toBe("not_found");
  });
});

test("every query services/leads.js sends is scoped by agency", async () => {
  // Records every statement the service sends (pool and transaction clients) through a full lead lifecycle.
  const seen = [];
  const spy = (q) => (sql, params) => (seen.push(String(sql.text || sql)), q(sql, params));
  const pool = {
    query: spy(h.pool.query.bind(h.pool)),
    connect: async () => {
      const c = await h.pool.connect();
      return { query: spy(c.query.bind(c)), release: () => c.release() };
    }
  };
  const { lead } = await Leads.captureLead(pool, B.broker, { phones: "01012345678" });
  await Leads.captureLead(pool, B.broker, { phones: ["01012345678", "01112345678"] });
  await Leads.captureLead(pool, B.colleague, { phones: "01012345678" });
  const s = await Leads.setStage(pool, B.broker, lead.id, { stage: "viewing" });
  await Leads.undo(pool, B.broker, s.eventId);
  await Leads.addNote(pool, B.broker, lead.id, "n");
  await Leads.markContacted(pool, B.broker, lead.id);
  await Leads.setFollowUp(pool, B.broker, lead.id, { at: new Date() });
  await Leads.completeFollowUp(pool, B.broker, lead.id);
  await Leads.assignLead(pool, B.admin, lead.id, B.colleague.id);
  await Leads.listLeads(pool, B.admin, { q: "sara", stage: "new" });
  await Leads.findByPhone(pool, B.broker, "01012345678");
  await Leads.timeline(pool, B.admin, lead.id);
  await Leads.releaseBrokerLeads(pool, B.colleague.agency_id, B.colleague.id);
  const leadSql = seen.filter((q) => /\b(FROM|INTO|UPDATE) (leads|lead_events|lead_erasures)\b/.test(q));
  expect(leadSql.length).toBeGreaterThan(20);
  for (const q of leadSql) expect(q).toMatch(/agency_id/);
});
