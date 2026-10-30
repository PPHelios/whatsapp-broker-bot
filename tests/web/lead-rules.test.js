// tests/web/lead-rules.test.js — Release A R3: the lead response rule (working minutes, Cairo hours and days), a lead
// moving to the next broker with everyone told, the cap on moves, speed-to-lead, "away until" (no new leads, skipped,
// reminders to the managers), the managers' notification switches, and the Team and rules page (former brokers last).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const LeadRules = require("../../services/leadRules");
const Reminders = require("../../services/followUpReminders");
const Notifications = require("../../lib/notifications");
const Team = require("../../services/team");
const R = require("../../domain/leadRules");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const leadRow = async (id) => (await h.query("SELECT * FROM leads WHERE id = $1", [id]))[0];
const notes = (who, like) => h.query("SELECT title, body, status, reason, kind FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE $2 ORDER BY id", [h.BROKERS[who].id, like]);
const MIN = 60000;
const ALWAYS = { enabled: "on", wait_minutes: "30", start: "0", end: "24", days: ["0", "1", "2", "3", "4", "5", "6"], max_jumps: "2" };

describe("rules (Cairo working minutes)", () => {
  const rules = R.rulesOf({ enabled: true, wait_minutes: 30, start: 9, end: 21, days: [0, 1, 2, 3, 4, 6] }); // Friday off
  test("minutes count only in working hours; a 2 a.m. lead waits for the morning; a day off is skipped", () => {
    // 1 Dec 2026 is a Tuesday; Cairo is UTC+2 in winter.
    expect(R.dueAt(rules, new Date("2026-12-01T00:00:00Z")).toISOString()).toBe("2026-12-01T07:30:00.000Z"); // 02:00 → 09:30
    expect(R.dueAt(rules, new Date("2026-12-01T10:00:00Z")).toISOString()).toBe("2026-12-01T10:30:00.000Z"); // 12:00 → 12:30
    expect(R.dueAt(rules, new Date("2026-12-01T18:50:00Z")).toISOString()).toBe("2026-12-02T07:20:00.000Z"); // 20:50 → next day 09:20
    expect(R.dueAt(rules, new Date("2026-12-03T18:50:00Z")).toISOString()).toBe("2026-12-05T07:20:00.000Z"); // Thursday → Saturday
  });
  test("hours past midnight belong to the day they start; the form is validated", () => {
    const night = R.rulesOf({ enabled: true, wait_minutes: 30, start: 20, end: 4, days: [0, 1, 2, 3, 4, 6] });
    expect(R.inWorkHours(night, new Date("2026-12-03T23:00:00Z"))).toBe(true); // Fri 01:00, Thursday's night
    expect(R.inWorkHours(night, new Date("2026-12-04T23:00:00Z"))).toBe(false); // Sat 01:00, Friday's night (off)
    expect(R.rulesFields({ ...ALWAYS, wait_minutes: "2" })).toEqual({ error: "invalid", field: "wait_minutes" });
    expect(R.rulesFields({ ...ALWAYS, days: [] })).toEqual({ error: "invalid", field: "days" });
    expect(R.rulesFields({ ...ALWAYS, start: "9", end: "9" })).toEqual({ error: "invalid", field: "hours" });
    expect(R.rulesFields({ ...ALWAYS, wait_minutes: "٤٥" }).fields).toMatchObject({ enabled: true, wait_minutes: 45, start: 0, end: 24 });
  });
});

describe("a lead nobody contacts moves on", () => {
  test("deadline, move to the next broker, everyone told, cap, speed-to-lead", async () => {
    const admin = await row("admin");
    expect((await LeadRules.saveRules(h.pool, admin, { ...ALWAYS, max_jumps: "1" })).ok).toBe(true);
    const t0 = new Date();
    const r = await Leads.captureLead(h.pool, admin, { phones: "01012345678", name: "Sara", assignTo: h.BROKERS.broker.id }, { now: t0 });
    let lead = await leadRow(r.lead.id);
    expect(new Date(lead.response_due_at).getTime()).toBe(t0.getTime() + 30 * MIN);

    // A broker's own lead never gets a deadline.
    const own = await Leads.captureLead(h.pool, await row("broker"), { phones: "01087654321", name: "Own" }, { now: t0 });
    expect((await leadRow(own.lead.id)).response_due_at).toBeNull();

    expect(await LeadRules.moveOverdue(h.pool, { now: new Date(t0.getTime() + 29 * MIN) })).toEqual({ moved: 0, stopped: 0 });
    expect(await LeadRules.moveOverdue(h.pool, { now: new Date(t0.getTime() + 31 * MIN) })).toEqual({ moved: 1, stopped: 0 });
    lead = await leadRow(r.lead.id);
    expect(lead.assigned_broker_id).toBe(h.BROKERS.colleague.id); // brokers before managers
    expect(lead.response_jumps).toBe(1);
    expect((await notes("colleague", "lead_assigned:%"))[0].body).toContain("30");
    expect((await notes("broker", "lead_moved:%"))[0].title).toContain("Broker Two");
    expect((await notes("admin", "lead_jump:%"))[0].title).toBe("↪️ L-0001 moved from Broker One to Broker Two");
    const [ev] = await h.query("SELECT broker_id, data FROM lead_events WHERE lead_id = $1 AND kind = 'assigned'", [lead.id]);
    expect(ev).toMatchObject({ broker_id: null, data: { from: h.BROKERS.broker.id, to: h.BROKERS.colleague.id, reason: "no_response" } });

    // The cap (1 move): the next deadline stops with the managers instead of moving again.
    expect(await LeadRules.moveOverdue(h.pool, { now: new Date(t0.getTime() + 70 * MIN) })).toEqual({ moved: 0, stopped: 1 });
    lead = await leadRow(r.lead.id);
    expect(lead).toMatchObject({ assigned_broker_id: h.BROKERS.colleague.id, response_due_at: null });
    expect((await notes("admin", "lead_jump_stop:%"))[0].body).toContain("Broker Two");

    // The colleague calls: speed-to-lead counts from when they got it.
    await Leads.markContacted(h.pool, await row("colleague"), lead.id, { now: new Date(t0.getTime() + 75 * MIN) });
    const speed = await LeadRules.speedToLead(h.pool, h.BROKERS.broker.agency_id, { now: new Date(t0.getTime() + 80 * MIN) });
    expect(speed.get(h.BROKERS.colleague.id)).toEqual({ responded: 1, median: 44, on_time: 0, missed: 0 });
    expect(speed.get(h.BROKERS.broker.id)).toMatchObject({ responded: 0, missed: 1 });
  });

  test("contacting in time ends the deadline; switching the rule off drops open deadlines", async () => {
    const admin = await row("admin");
    await LeadRules.saveRules(h.pool, admin, ALWAYS);
    const t0 = new Date();
    const a = await Leads.captureLead(h.pool, admin, { phones: "01011111111", assignTo: h.BROKERS.broker.id }, { now: t0 });
    await Leads.markContacted(h.pool, await row("broker"), a.lead.id, { now: new Date(t0.getTime() + 5 * MIN) });
    expect((await leadRow(a.lead.id)).response_due_at).toBeNull();
    const b = await Leads.captureLead(h.pool, admin, { phones: "01022222222", assignTo: h.BROKERS.broker.id }, { now: t0 });
    expect((await leadRow(b.lead.id)).response_due_at).not.toBeNull();
    await LeadRules.saveRules(h.pool, admin, { ...ALWAYS, enabled: "" });
    expect((await leadRow(b.lead.id)).response_due_at).toBeNull();
    expect(await LeadRules.moveOverdue(h.pool, { now: new Date(t0.getTime() + 60 * MIN) })).toEqual({ moved: 0, stopped: 0 });
  });
});

describe("away until", () => {
  test("no new leads, skipped by round robin, reminders go to the managers", async () => {
    const admin = await row("admin");
    const own = await Leads.captureLead(h.pool, await row("broker"), { phones: "01033333333", name: "Mona" });
    const at = new Date(Date.now() + 2 * 3600 * 1000);
    await Leads.setFollowUp(h.pool, await row("broker"), own.lead.id, { at });

    const back = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expect((await LeadRules.setAway(h.pool, admin, h.BROKERS.broker.id, "2020-01-01")).error).toBe("away_date");
    expect((await LeadRules.setAway(h.pool, await row("colleague"), h.BROKERS.broker.id, back)).error).toBe("forbidden");
    expect((await LeadRules.setAway(h.pool, admin, h.BROKERS.broker.id, back)).ok).toBe(true);

    expect((await Leads.captureLead(h.pool, admin, { phones: "01044444444", assignTo: h.BROKERS.broker.id })).error).toBe("assignee_away");
    const other = await Leads.captureLead(h.pool, admin, { phones: "01055555555" });
    expect((await Leads.assignLead(h.pool, admin, other.lead.id, h.BROKERS.broker.id)).error).toBe("assignee_away");
    expect((await LeadRules.nextBroker(h.pool, h.BROKERS.broker.agency_id, { exclude: [h.BROKERS.colleague.id] })).id).toBe(h.BROKERS.admin.id);

    await Reminders.remindDue(h.pool, { now: new Date(at.getTime() + MIN) });
    expect(await notes("broker", "fu:%")).toEqual([]);
    const [n] = await notes("admin", "fu:%");
    expect(n.title).toContain("for Broker One (away)");

    expect((await LeadRules.setAway(h.pool, admin, h.BROKERS.broker.id, null)).broker.away_until).toBeNull();
    expect((await Leads.assignLead(h.pool, admin, other.lead.id, h.BROKERS.broker.id)).ok).toBe(true);
  });
});

describe("notification switches", () => {
  test("a switched-off kind stays in the inbox; the broker's own settings keep the switch", async () => {
    const admin = await row("admin");
    expect((await LeadRules.setSwitches(h.pool, admin, h.BROKERS.broker.id, ["assignment", "nonsense"])).off).toEqual(["assignment"]);
    await Notifications.savePrefs(h.pool, await row("broker"), { channels: {}, quiet: { enabled: "off" } });
    expect((await row("broker")).notify_prefs.off).toEqual(["assignment"]);
    await Leads.captureLead(h.pool, admin, { phones: "01066666666", assignTo: h.BROKERS.broker.id });
    const [n] = await notes("broker", "lead_assigned:%");
    expect(n).toMatchObject({ status: "skipped", reason: "switched_off" });
  });
});

describe("Team and rules page", () => {
  test("managers save the rule, set away and switches; former brokers listed last, longest gone at the end", async () => {
    const { agent, csrf } = await signIn(h, "admin");
    const page = await agent.get("/app/team");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Lead rules");
    expect(page.text).toContain("data-lead-rules");

    const bad = await agent.post("/app/team/rules").type("form").send({ _csrf: csrf, ...ALWAYS, wait_minutes: "1" });
    expect(bad.status).toBe(400);
    const ok = await agent.post("/app/team/rules").type("form").send({ _csrf: csrf, ...ALWAYS, wait_minutes: "20" });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("20 minutes");

    const back = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const away = await agent.post(`/app/team/${h.BROKERS.colleague.id}/away`).type("form").send({ _csrf: csrf, until: back });
    expect(away.status).toBe(200);
    expect(away.text).toContain("data-away");
    const sw = await agent.post(`/app/team/${h.BROKERS.colleague.id}/notify`).type("form").send({ _csrf: csrf, sent: "1", on: ["follow_up", "match"] });
    expect(sw.status).toBe(200);
    expect((await row("colleague")).notify_prefs.off).toContain("assignment");

    const admin = await row("admin");
    await Team.deactivate(h.pool, admin, h.BROKERS.colleague.id, { now: new Date(Date.now() - 10 * 24 * 3600 * 1000) });
    await Team.deactivate(h.pool, admin, h.BROKERS.broker.id, { now: new Date() });
    const order = (await Team.listTeam(h.pool, admin)).map((b) => b.name);
    expect(order).toEqual(["Agency Admin", "Broker One", "Broker Two"]);
    expect((await row("colleague")).away_until).toBeNull();

    const { agent: b } = await signIn(h, "rival");
    expect((await b.get("/app/team")).status).toBe(403);
  });
});
