// tests/crm/more-alerts.test.js — 6.5: a matched unit whose price drops 2%+ alerts once more (not for a small drop, not
// when dismissed); the daily match cap is lifted on Telegram (safety ceiling only) but holds on WhatsApp; an interested
// lead with no follow-up and a quiet day gets one nudge, again only after new activity.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { resetConfig } = require("../../config");
const Leads = require("../../services/leads");
const Requests = require("../../services/leadRequests");
const Sweep = require("../../services/matchSweep");
const Reminders = require("../../services/followUpReminders");

jest.setTimeout(90000);

let h;
let wm;
beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  wm = { at: new Date(Date.now() - 1000).toISOString() };
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  resetConfig();
  await closeHarness();
});

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const HP = { listing_type: "sale", property_types: ["apartment"], places: [{ kind: "compound", key: "hyde_park" }], price_max: 9000000 };
const run = async (opts = {}) => {
  const out = await Sweep.sweep(h.pool, { now: new Date(Date.now() + 2000), watermark: wm, ...opts });
  wm = out.watermark;
  return out.counts;
};
const alerts = (who = "broker") => h.query("SELECT title, body FROM notifications WHERE broker_id = $1 AND kind = 'match' ORDER BY id", [h.BROKERS[who].id]);
async function lead(who = "broker", phones = "01012345678", filters = HP) {
  const l = (await Leads.captureLead(h.pool, await row(who), { phones, name: "Sara" })).lead;
  await Requests.saveRequest(h.pool, await row(who), l.id, filters);
  return l;
}

describe("price drops (6.5)", () => {
  test("a matched unit that drops 2% or more alerts again with the old and new price; a 1% drop doesn't", async () => {
    await lead();
    await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 8.8e6 });
    expect((await run()).matches).toBe(1);
    await h.text("broker", "سعر HP-1 8.75 مليون"); // −0.6%
    expect(await run()).toMatchObject({ matches: 0, drops: 0 });
    await h.text("broker", "سعر HP-1 8.2 مليون"); // −6.8% from 8.8M (the price last alerted)
    expect(await run()).toMatchObject({ matches: 0, drops: 1, alerts: 1 });
    const last = (await alerts()).pop();
    expect(last.title).toMatch(/📉 سعر HP-1 نزل/);
    expect(last.body).toMatch(/8\.8[\s\S]*→[\s\S]*8\.2/);
    // The same price again is no news.
    await h.query("UPDATE listings SET updated_at = NOW() WHERE code = 'HP-1'");
    expect((await run()).drops).toBe(0);
  });

  test("a unit the broker dismissed for that client stays quiet when its price drops", async () => {
    await lead();
    await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 8.8e6 });
    await run();
    await h.query("UPDATE lead_matches SET status = 'dismissed'");
    await h.text("broker", "سعر HP-1 7 مليون");
    expect((await run()).drops).toBe(0);
  });
});

describe("daily cap on Telegram (6.5)", () => {
  test("the cap holds on WhatsApp but not for a broker whose match alerts go to Telegram", async () => {
    await lead("broker", "01012345678");
    await lead("colleague", "01112345678");
    await h.tgLink("colleague");
    for (let i = 1; i <= 3; i++) {
      await h.insertListing({ code: `HP-${i}`, compound: "Hyde Park", area_value: 140 + i });
      await run({ dailyCap: 2 });
    }
    expect(await alerts("broker")).toHaveLength(2);
    expect(await alerts("colleague")).toHaveLength(3);
  });
});

describe("interested with no follow-up (6.5)", () => {
  const NOW = new Date("2026-11-04T09:00:00Z");
  const nudges = () => h.query("SELECT title FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE 'interest:%' ORDER BY id", [h.BROKERS.broker.id]);

  test("one nudge after a quiet day, with Follow-up and Called; again only after new activity", async () => {
    const l = (await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara" })).lead;
    await h.query("UPDATE leads SET stage = 'interested', last_activity_at = $2 WHERE id = $1", [l.id, "2026-11-03T08:00:00Z"]);
    expect(await Reminders.nudgeInterested(h.pool, { now: new Date("2026-11-03T20:00:00Z") })).toEqual({ nudged: 0, brokers: 0 });
    expect(await Reminders.nudgeInterested(h.pool, { now: NOW })).toEqual({ nudged: 1, brokers: 1 });
    expect((await nudges())[0].title).toBe("👍 Sara (L-0001) مهتم ومفيش متابعة متحددة");
    expect((await Reminders.nudgeInterested(h.pool, { now: new Date(NOW.getTime() + 3 * 24 * 3600 * 1000) })).nudged).toBe(0);
    // New activity, then another quiet day: one more nudge.
    await h.query("UPDATE leads SET last_activity_at = $2 WHERE id = $1", [l.id, "2026-11-05T09:00:00Z"]);
    expect((await Reminders.nudgeInterested(h.pool, { now: new Date("2026-11-06T10:00:00Z") })).nudged).toBe(1);
  });

  test("a lead with an open follow-up, or in another stage, is never nudged", async () => {
    const a = (await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "A" })).lead;
    const b = (await Leads.captureLead(h.pool, await row("broker"), { phones: "01112345678", name: "B" })).lead;
    await h.query("UPDATE leads SET stage = 'interested', last_activity_at = '2026-11-01T08:00:00Z', follow_up_status = 'open', next_follow_up_at = '2026-11-10T08:00:00Z' WHERE id = $1", [a.id]);
    await h.query("UPDATE leads SET stage = 'contacted', last_activity_at = '2026-11-01T08:00:00Z' WHERE id = $1", [b.id]);
    expect((await Reminders.nudgeInterested(h.pool, { now: NOW })).nudged).toBe(0);
  });
});
