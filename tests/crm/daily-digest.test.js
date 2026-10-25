// tests/crm/daily-digest.test.js — Morning brief (6.1) and manager evening digest (6.2) on a fixed clock: only inside
// the Cairo window, once a day (also across two passes), Telegram first and never WhatsApp, empty briefs not sent, only
// the broker's own leads, the brief's buttons open the follow-ups and clients lists, and the digest's per-broker lines.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const Leads = require("../../services/leads");
const Digest = require("../../services/dailyDigest");

jest.setTimeout(60000);

const { resetConfig } = require("../../config");

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  resetConfig();
  await closeHarness();
});

// Wednesday 4 November 2026 (Cairo is UTC+2 after 29 October).
const MORNING = new Date("2026-11-04T07:30:00Z"); // 09:30 Cairo
const EVENING = new Date("2026-11-04T17:30:00Z"); // 19:30 Cairo
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
async function lead(who, phones, name, fields = {}) {
  const l = (await Leads.captureLead(h.pool, await row(who), { phones, name }, { now: new Date("2026-11-04T05:00:00Z") })).lead;
  const keys = Object.keys(fields);
  if (keys.length) await h.query(`UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [l.id, ...keys.map((k) => fields[k])]);
  return l;
}
const notes = (who, prefix) => h.query("SELECT kind, title, body, channel, status FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE $2", [h.BROKERS[who].id, `${prefix}%`]);

test("the brief lists today's viewings and calls, overdue, hot and uncontacted clients; Telegram, once a day", async () => {
  await h.tgLink("broker");
  const unit = await h.insertListing({ code: "HP-9" });
  await lead("broker", "01011111111", "Sara", { next_follow_up_at: "2026-11-04T12:00:00Z", follow_up_kind: "viewing", follow_up_status: "open", follow_up_listing_id: unit.id, stage: "viewing", last_contact_at: "2026-11-03T10:00:00Z" });
  await lead("broker", "01022222222", "Omar", { next_follow_up_at: "2026-11-04T14:00:00Z", follow_up_kind: "call", follow_up_status: "open", stage: "contacted", last_contact_at: "2026-11-03T10:00:00Z" });
  await lead("broker", "01033333333", "Mona", { next_follow_up_at: "2026-11-02T08:00:00Z", follow_up_kind: "call", follow_up_status: "open", stage: "interested", hot_at: "2026-11-03T08:00:00Z", last_contact_at: "2026-11-01T10:00:00Z" });
  await lead("broker", "01044444444", "Hany");
  // A colleague's lead never shows in this broker's brief.
  await lead("colleague", "01055555555", "Colleague Client", { next_follow_up_at: "2026-11-04T12:00:00Z", follow_up_kind: "viewing", follow_up_status: "open" });

  expect((await Digest.sendBriefs(h.pool, { now: new Date("2026-11-04T05:30:00Z") })).skipped).toBe(true); // 07:30 Cairo
  const r = await Digest.sendBriefs(h.pool, { now: MORNING, agencyId: h.AGENCY_A });
  expect(r.sent).toBeGreaterThanOrEqual(1);

  const [n] = await notes("broker", "brief:");
  expect(n).toMatchObject({ kind: "daily_brief", channel: "telegram", status: "sent" });
  expect(n.title).toMatch(/صباح الخير يا Broker/);
  expect(n.body).toMatch(/معاينات النهارده \(1\)[\s\S]*L-0001 Sara · HP-9/);
  expect(n.body).toMatch(/مكالمات النهارده \(1\)[\s\S]*L-0002 Omar/);
  expect(n.body).toMatch(/متأخرة \(1\)[\s\S]*L-0003 Mona/);
  expect(n.body).toMatch(/عملاء مهتمين جداً[\s\S]*Mona/);
  expect(n.body).toMatch(/1 عملاء جداد لسه محدش كلمهم/);
  expect(n.body).not.toMatch(/Colleague Client/);
  const tg = h.TG.outbox.filter((m) => m.method === "sendMessage" && m.chatId === String(h.TG_IDS.broker)).pop();
  expect(JSON.stringify(tg.keyboard)).toContain("ld:fulist");
  expect(h.WA.outbox.filter((m) => m.to === h.BROKERS.broker.phone)).toHaveLength(0);

  // A second pass the same morning sends nothing more.
  await Digest.sendBriefs(h.pool, { now: new Date(MORNING.getTime() + 3600 * 1000), agencyId: h.AGENCY_A });
  expect(await notes("broker", "brief:")).toHaveLength(1);
});

test("a broker with nothing today gets no brief; one without Telegram never gets WhatsApp", async () => {
  await lead("colleague", "01066666666", "Nadia", { next_follow_up_at: "2026-11-04T12:00:00Z", follow_up_kind: "call", follow_up_status: "open", stage: "contacted", last_contact_at: "2026-11-03T10:00:00Z" });
  await Digest.sendBriefs(h.pool, { now: MORNING, agencyId: h.AGENCY_A });
  expect(await notes("broker", "brief:")).toHaveLength(0);
  const [n] = await notes("colleague", "brief:");
  expect(n.channel).not.toBe("whatsapp");
  expect(h.WA.outbox).toHaveLength(0);
});

test("the brief's buttons open the follow-ups and clients lists", async () => {
  await h.tgLink("broker");
  await lead("broker", "01077777777", "Sara", { next_follow_up_at: "2026-11-04T12:00:00Z", follow_up_kind: "call", follow_up_status: "open", stage: "contacted" });
  expect(textOf(await h.tgTap("broker", "ld:fulist"))).toMatch(/L-0001/);
  expect(textOf(await h.tgTap("broker", "ld:mylist"))).toMatch(/Sara/);
});

test("the manager digest: new leads by source, uncontacted, stage moves and deals per broker; managers only, once", async () => {
  await h.tgLink("admin");
  const b = await row("broker");
  const l1 = await lead("broker", "01088888888", "Sara");
  await lead("colleague", "01099999999", "Omar");
  await h.query("UPDATE leads SET source = 'Facebook' WHERE id = $1", [l1.id]);
  await Leads.markContacted(h.pool, b, l1.id, { now: new Date("2026-11-04T09:00:00Z") }).catch(() => null);
  await h.query(
    `INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, 'stage', '{"from":"contacted","to":"interested"}', '2026-11-04T10:00:00Z')`,
    [h.AGENCY_A, l1.id, b.id]
  );

  expect((await Digest.sendDigests(h.pool, { now: MORNING })).skipped).toBe(true);
  await Digest.sendDigests(h.pool, { now: EVENING, agencyId: h.AGENCY_A });
  const [n] = await notes("admin", "digest:");
  expect(n).toMatchObject({ kind: "daily_digest", channel: "telegram" });
  expect(n.title).toBe("🌙 Today at the agency"); // the admin reads English
  expect(n.body).toMatch(/New leads today: 2 \(Facebook 1/);
  expect(n.body).toMatch(/Stage moves: .*Interested 1/);
  expect(n.body).toMatch(/Deals today: 0/);
  expect(n.body).toMatch(/• Broker One: 1 new/);
  expect(n.body).toMatch(/• Broker Two: 1 new/);
  expect(await notes("broker", "digest:")).toHaveLength(0);
  await Digest.sendDigests(h.pool, { now: new Date(EVENING.getTime() + 3600 * 1000), agencyId: h.AGENCY_A });
  expect(await notes("admin", "digest:")).toHaveLength(1);
});

test("the job runs both and is registered", async () => {
  const job = Digest.digestJob();
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("daily_digest");
  const out = await job.run({ pool: h.pool, now: new Date("2026-11-04T02:00:00Z"), watermark: {} });
  expect(out.watermark).toEqual({}); // 04:00 Cairo: neither window
  const morning = await job.run({ pool: h.pool, now: MORNING, watermark: {} });
  expect(morning.watermark.brief).toBe("2026-11-04");
});
