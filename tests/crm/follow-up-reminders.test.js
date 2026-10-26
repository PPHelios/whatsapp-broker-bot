// tests/crm/follow-up-reminders.test.js — Follow-ups and viewings (Release 3 step 8), on a fixed clock: a date with no
// time reminds at 10:00 Cairo, quiet hours hold the reminder, one grouped reminder per broker, a viewing carries the
// unit and its place, [✅ Done] [📅 Postpone] on WhatsApp and the website, a reassigned lead reminds the new broker,
// two instances remind once, the 24-hour nudge, and the "no next step" filter.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Reminders = require("../../services/followUpReminders");
const Notifications = require("../../lib/notifications");
const Stages = require("../../domain/leadStages");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
let seq = 0;
const openWindow = (who, at) =>
  h.query("INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, '{}', 'completed', $3)", [
    `wamid.win.${++seq}`,
    h.BROKERS[who].phone,
    new Date(at.getTime() - 3600 * 1000).toISOString()
  ]);
const reminders = (who = "broker") =>
  h.query("SELECT title, body, status, lead_id, deliver_after, channel FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE 'fu:%' ORDER BY id", [h.BROKERS[who].id]);
const sentTo = (who) => h.WA.outbox.filter((m) => m.to === h.BROKERS[who].phone);
const ids = (m) => (m.buttons || []).map((b) => b.id);
async function lead(who = "broker", phones = "01012345678", name = "Sara") {
  return (await Leads.captureLead(h.pool, await row(who), { phones, name })).lead;
}
// Two days ahead, so the follow-up is always in the future when it's set.
const day = (hour, minute = 0) => new Date(Stages.cairoDayAt(new Date(), 2, hour).getTime() + minute * 60000);

test("a date with no time means 10:00 Cairo; the reminder comes at 10:00, not before, with Done and Postpone", async () => {
  const l = await lead();
  const date = Stages.toCairoLocal(day(10)).slice(0, 10);
  const at = Stages.fromCairoLocal(date);
  expect(at.toISOString()).toBe(day(10).toISOString());
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at, note: "ask about the budget" });
  await openWindow("broker", at);

  expect(await Reminders.remindDue(h.pool, { now: new Date(at.getTime() - 60000) })).toEqual({ reminded: 0, brokers: 0 });
  expect(await Reminders.remindDue(h.pool, { now: at })).toEqual({ reminded: 1, brokers: 1 });
  const [n] = await reminders();
  expect(n).toMatchObject({ status: "sent", channel: "whatsapp", lead_id: l.id });
  expect(n.title).toBe("📅 متابعة: Sara (L-0001)");
  expect(n.body).toContain("📝 ask about the budget");
  const wa = sentTo("broker").pop();
  expect(ids(wa)).toEqual(["ld:fudone:L-0001", "ld:fupost:L-0001"]);
  // Once only.
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() + 60000) })).reminded).toBe(0);
});

test("quiet hours hold the reminder until they end", async () => {
  await h.query(`UPDATE brokers SET notify_prefs = '{"quiet":{"enabled":true,"start":22,"end":8}}' WHERE id = $1`, [h.BROKERS.broker.id]);
  const l = await lead();
  const at = day(23);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  await openWindow("broker", at);
  await Reminders.remindDue(h.pool, { now: at });
  const [held] = await reminders();
  expect(held.status).toBe("held");
  const morning = new Date(Stages.cairoDayAt(at, 1, 8));
  expect(new Date(held.deliver_after).toISOString()).toBe(morning.toISOString());
  await openWindow("broker", morning);
  await Notifications.deliverDue(h.pool, { now: morning });
  expect((await reminders())[0].status).toBe("sent");
});

test("several due follow-ups: one grouped reminder per broker, 5 lines and the rest counted", async () => {
  const at = day(10);
  for (let i = 0; i < 7; i++) {
    const l = await lead("broker", `0101234567${i}`, `Client ${i}`);
    await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at: new Date(at.getTime() + i * 60000) });
  }
  const other = await lead("colleague", "01112345678", "Theirs");
  await Leads.setFollowUp(h.pool, await row("colleague"), other.id, { at });
  expect(await Reminders.remindDue(h.pool, { now: new Date(at.getTime() + 3600 * 1000) })).toEqual({ reminded: 8, brokers: 2 });
  const [mine] = await reminders();
  expect(mine.title).toBe("📅 7 متابعات دلوقتي");
  const lines = mine.body.split("\n");
  expect(lines).toHaveLength(6);
  expect(lines[0]).toContain("L-0001 Client 0");
  expect(lines[5]).toBe("…و2 كمان");
  expect(mine.body).not.toContain("Theirs");
  expect(await reminders("colleague")).toHaveLength(1);
});

test("a viewing reminder carries the unit's compact line and its place", async () => {
  const unit = await h.insertListing({ code: "VIL-08", compound: "Mivida", district: "التجمع الخامس", city: "القاهرة الجديدة", property_type: "villa" });
  const l = await lead();
  const at = day(17);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at, kind: "viewing", listingId: unit.id });
  await Reminders.remindDue(h.pool, { now: at });
  const [n] = await reminders();
  expect(n.title).toMatch(/^🏠 معاينة .+: Sara \(L-0001\)$/);
  expect(n.body).toContain("`VIL-08`");
  expect(n.body).toContain("📍 Mivida، التجمع الخامس، القاهرة الجديدة");
  expect(n.body).toContain("📞");
});

test("Done and Postpone from WhatsApp: done offers the next step; postpone moves a day and reminds again", async () => {
  const l = await lead();
  const due = new Date(Date.now() - 3600 * 1000);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at: due });
  await Reminders.remindDue(h.pool, { now: new Date() });

  const post = (await h.tap("broker", "ld:fupost:L-0001")).find((m) => m.to === h.BROKERS.broker.phone);
  expect(post.text).toMatch(/⏰ L-0001: متابعة/);
  let fresh = await Leads.getLead(h.pool, await row("broker"), l.id);
  expect(new Date(fresh.next_follow_up_at).getTime()).toBe(due.getTime() + 24 * 3600 * 1000);
  expect(fresh.follow_up_reminded_at).toBeNull();
  expect((await Reminders.remindDue(h.pool, { now: new Date(due.getTime() + 24 * 3600 * 1000) })).reminded).toBe(1);

  const done = (await h.tap("broker", "ld:fudone:L-0001")).find((m) => m.to === h.BROKERS.broker.phone);
  expect(done.text).toMatch(/✅ L-0001: المتابعة خلصت/);
  expect(ids(done)).toEqual(["ld:fuset:L-0001:2d", "ld:draft:L-0001", expect.stringMatching(/^ld:undo:\d+$/)]);
  fresh = await Leads.getLead(h.pool, await row("broker"), l.id);
  expect(fresh.follow_up_status).toBe("done");
  // An old button after it's done says so.
  const again = (await h.tap("broker", "ld:fupost:L-0001")).find((m) => m.to === h.BROKERS.broker.phone);
  expect(again.text).toMatch(/مفيش متابعة مفتوحة/);
});

test("Done and Postpone on the website notification", async () => {
  const l = await lead();
  const due = new Date(Date.now() - 3600 * 1000);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at: due });
  await Reminders.remindDue(h.pool, { now: new Date() });
  const b = await signIn(h, "broker");
  const inbox = await b.agent.get("/app/notifications");
  expect(inbox.text).toContain('action="/app/leads/L-0001/follow-up/done"');
  expect(inbox.text).toContain('action="/app/leads/L-0001/follow-up/postpone"');
  const res = await b.agent.post("/app/leads/L-0001/follow-up/postpone").type("form").send({ _csrf: b.csrf });
  expect(res.status).toBe(303);
  const fresh = await Leads.getLead(h.pool, await row("broker"), l.id);
  expect(new Date(fresh.next_follow_up_at).getTime()).toBe(due.getTime() + 24 * 3600 * 1000);
  await b.agent.post("/app/leads/L-0001/follow-up/done").type("form").send({ _csrf: b.csrf });
  expect((await b.agent.get("/app/notifications")).text).not.toContain("follow-up/postpone");
});

test("a reassigned lead reminds its new broker, also after the old one was reminded", async () => {
  const l = await lead();
  const at = day(10);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  await Leads.assignLead(h.pool, await row("admin"), l.id, h.BROKERS.colleague.id);
  await Reminders.remindDue(h.pool, { now: at });
  expect(await reminders("broker")).toHaveLength(0);
  expect(await reminders("colleague")).toHaveLength(1);

  await Leads.assignLead(h.pool, await row("admin"), l.id, h.BROKERS.broker.id);
  expect((await Reminders.remindDue(h.pool, { now: new Date(at.getTime() + 60000) })).reminded).toBe(1);
  expect(await reminders("broker")).toHaveLength(1);
});

test("two instances running at once remind once", async () => {
  const l = await lead();
  const at = day(10);
  await Leads.setFollowUp(h.pool, await row("broker"), l.id, { at });
  const [a, b] = await Promise.all([Reminders.remindDue(h.pool, { now: at }), Reminders.remindDue(h.pool, { now: at })]);
  expect(a.reminded + b.reminded).toBe(1);
  expect(await reminders()).toHaveLength(1);
});

test("the 24-hour nudge: once, only for new leads nobody contacted, never for old ones", async () => {
  const now = new Date();
  const untouched = await lead("broker", "01012345678", "Quiet");
  const called = await lead("broker", "01112345678", "Called");
  const old = await lead("broker", "01212345678", "Old");
  await Leads.markContacted(h.pool, await row("broker"), called.id);
  await h.query("UPDATE leads SET created_at = $1 WHERE id = ANY($2::uuid[])", [new Date(now.getTime() - 25 * 3600 * 1000).toISOString(), [untouched.id, called.id]]);
  await h.query("UPDATE leads SET created_at = $1 WHERE id = $2", [new Date(now.getTime() - 5 * 24 * 3600 * 1000).toISOString(), old.id]);

  expect(await Reminders.nudgeUntouched(h.pool, { now })).toEqual({ nudged: 1, brokers: 1 });
  expect(await Reminders.nudgeUntouched(h.pool, { now })).toEqual({ nudged: 0, brokers: 0 });
  const [n] = await h.query("SELECT title, lead_id FROM notifications WHERE dedupe_key LIKE 'nudge:%'");
  expect(n).toEqual({ title: "⏰ Quiet (L-0001) لسه محدش كلمه من 24 ساعة", lead_id: untouched.id });
});

test("the reminder job runs all three, and the 'no next step' filter lists leads without an open follow-up", async () => {
  const job = Reminders.reminderJob();
  expect(job).toMatchObject({ name: "follow_up_reminders", everyMs: 60000 });
  expect((await job.run({ pool: h.pool, now: new Date() })).counts).toEqual({ reminded: 0, nudged: 0, interest: 0, brokers: 0 });
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("follow_up_reminders");

  const planned = await lead("broker", "01012345678", "Planned");
  await lead("broker", "01112345678", "Adrift");
  await Leads.setFollowUp(h.pool, await row("broker"), planned.id, { at: day(10) });
  const { rows } = await Leads.listLeads(h.pool, await row("broker"), { noNextStep: true });
  expect(rows.map((r) => r.name)).toEqual(["Adrift"]);
  const b = await signIn(h, "broker");
  const page = await b.agent.get("/app/leads?tab=no_next_step");
  expect(page.text).toContain("Adrift");
  expect(page.text).not.toContain("Planned");
});
