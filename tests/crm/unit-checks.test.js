// tests/crm/unit-checks.test.js — "Still available?" (6.3) on a fixed clock: asked once after 21 days unconfirmed (one
// unit with the three quick buttons, several grouped with Review), not at night, not developer models, archived at 30
// days and told, "Still available" brings it back and resets the clock, two passes never ask twice.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { resetConfig } = require("../../config");
const UC = require("../../services/unitChecks");

jest.setTimeout(60000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  await h.tgLink("broker", "colleague");
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  resetConfig();
  await closeHarness();
});

const NOW = new Date("2026-11-04T09:00:00Z"); // 11:00 Cairo
const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * 24 * 3600 * 1000).toISOString();
const unit = (code, days, extra = {}) => h.insertListing({ code, confirmed_at: daysAgo(days), ...extra });
const notes = (who) => h.query("SELECT kind, title, body, channel FROM notifications WHERE broker_id = $1 AND kind = 'unit_check' ORDER BY id", [h.BROKERS[who].id]);
const tgTo = (who) => h.TG.outbox.filter((m) => m.method === "sendMessage" && m.chatId === String(h.TG_IDS[who]));

test("one stale unit: one question with Still available / Sold / Archive; fresh and developer units are left alone; once only", async () => {
  await unit("HP-1", 22);
  await unit("HP-2", 5);
  await unit("DEV-1", 40, { inventory_type: "developer_model" });
  expect(await UC.askStale(h.pool, { now: NOW })).toEqual({ asked: 1, brokers: 1 });
  const [n] = await notes("broker");
  expect(n.title).toBe("🤔 HP-1 لسه متاحة؟");
  expect(n.channel).toBe("telegram");
  expect(JSON.stringify(tgTo("broker").pop().keyboard)).toMatch(/qu:available:HP-1[\s\S]*qu:sold:HP-1[\s\S]*qu:archive:HP-1/);
  expect(h.WA.outbox).toHaveLength(0);
  expect((await UC.askStale(h.pool, { now: new Date(NOW.getTime() + 3600 * 1000) })).asked).toBe(0);
});

test("several units are grouped per broker with a Review list; nothing is asked at night", async () => {
  await unit("HP-1", 25);
  await unit("HP-2", 23);
  await unit("HP-3", 30, { broker_id: h.BROKERS.colleague.id });
  expect((await UC.askStale(h.pool, { now: new Date("2026-11-04T22:00:00Z") })).skipped).toBe(true); // midnight Cairo
  expect(await UC.askStale(h.pool, { now: NOW })).toEqual({ asked: 3, brokers: 2 });
  const [n] = await notes("broker");
  expect(n.title).toMatch(/^🤔 2 وحدات/);
  expect(n.body).toMatch(/HP-1[\s\S]*HP-2/);
  const review = await h.tgTap("broker", "uc:review");
  expect(JSON.stringify(review)).toMatch(/qu_menu:HP-1[\s\S]*qu_menu:HP-2/);
  expect(JSON.stringify(review)).not.toMatch(/HP-3/);
});

test("still unconfirmed at 30 days: archived and told; Still available brings it back and resets the clock", async () => {
  const u = await unit("HP-1", 22);
  await UC.askStale(h.pool, { now: NOW });
  // Nine days later (31 days unconfirmed) nobody has answered.
  const later = new Date(NOW.getTime() + 9 * 24 * 3600 * 1000);
  expect(await UC.hideStale(h.pool, { now: later })).toEqual({ hidden: 1, brokers: 1 });
  let [row] = await h.query("SELECT status, stale_hidden_at, confirmed_at FROM listings WHERE id = $1", [u.id]);
  expect(row.status).toBe("archived");
  expect((await notes("broker")).pop().title).toMatch(/HP-1 اتخفت من البحث/);
  expect((await UC.hideStale(h.pool, { now: later })).hidden).toBe(0);

  const replies = await h.tgTap("broker", "qu:available:HP-1");
  expect(textOf(replies)).toMatch(/HP-1/);
  [row] = await h.query("SELECT status, confirmed_at FROM listings WHERE id = $1", [u.id]);
  expect(row.status).toBe("active");
  // The tap vouches for the unit (confirmed_at = the database's now), which clears the question.
  expect(new Date(row.confirmed_at).getTime()).toBeGreaterThan(new Date(u.confirmed_at).getTime());
});

test("a unit confirmed after the question is never archived", async () => {
  const u = await unit("HP-1", 22);
  await UC.askStale(h.pool, { now: NOW });
  await h.query("UPDATE listings SET confirmed_at = $2 WHERE id = $1", [u.id, new Date(NOW.getTime() + 3600 * 1000).toISOString()]);
  expect((await UC.hideStale(h.pool, { now: new Date(NOW.getTime() + 9 * 24 * 3600 * 1000) })).hidden).toBe(0);
});

test("the job is registered", () => {
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("unit_checks");
});
