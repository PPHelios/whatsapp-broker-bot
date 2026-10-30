// tests/router/flag-telegram.test.js — "Needs manager" from Telegram: the broker is asked for an optional note (or sends it
// bare); a manager sees "Handled" on a flagged lead, is asked for an optional reply, and the broker is told.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const flagOf = async () => (await h.query("SELECT flagged_at, flag_note FROM leads"))[0];
const buttonsOf = (out) => out.flatMap((e) => (e.keyboard || []).flat()).map((b) => b.callback_data);

beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  await h.tgLink("broker");
  await h.tgLink("manager");
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01012345678", name: "Sara Tg" });
});
afterAll(closeHarness);

test("a broker picks Needs manager from the stage menu, is asked for an optional note, and the note goes to the managers", async () => {
  const asked = await h.tgTap("broker", "ld:st:L-0001:flag");
  const ids = buttonsOf(asked);
  expect(ids).toContain("ld:flagnow:L-0001");
  expect(await flagOf()).toEqual({ flagged_at: null, flag_note: null });

  await h.tgText("broker", "Asked for a discount on the deposit");
  expect((await flagOf()).flag_note).toBe("Asked for a discount on the deposit");
  const alerts = await h.query("SELECT broker_id FROM notifications WHERE dedupe_key LIKE 'flag:%'");
  expect(alerts.map((a) => a.broker_id)).toContain(h.BROKERS.manager.id);
  expect(alerts.map((a) => a.broker_id)).not.toContain(h.BROKERS.broker.id);
});

test("sending without a note flags the lead with the default text", async () => {
  await h.tgTap("broker", "ld:st:L-0001:flag");
  await h.tgTap("broker", "ld:flagnow:L-0001");
  expect((await flagOf()).flag_note).toBe("محتاج مدير يساعد");
});

test("a manager sees Handled on a flagged lead, gives an optional reply, and the broker is told", async () => {
  await h.tgTap("broker", "ld:st:L-0001:flag");
  await h.tgText("broker", "Asked for a discount");
  const menu = await h.tgTap("manager", "ld:stage:L-0001");
  expect(buttonsOf(menu)).toContain("ld:handle:L-0001");
  expect(buttonsOf(await h.tgTap("broker", "ld:stage:L-0001"))).not.toContain("ld:handle:L-0001");

  await h.tgTap("manager", "ld:handle:L-0001");
  await h.tgText("manager", "Called the client, we will offer a 2% discount");
  expect(await flagOf()).toEqual({ flagged_at: null, flag_note: null });
  const [ev] = await h.query("SELECT data FROM lead_events WHERE kind = 'flag_handled' ORDER BY created_at DESC LIMIT 1");
  expect(ev.data.reply).toBe("Called the client, we will offer a 2% discount");
  const told = await h.query("SELECT broker_id FROM notifications WHERE broker_id = $1", [h.BROKERS.broker.id]);
  expect(told.length).toBeGreaterThan(0);
});

test("the broker never gets Handled, and a manager can mark it handled without a reply", async () => {
  await h.tgTap("broker", "ld:st:L-0001:flag");
  await h.tgText("broker", "Asked for a discount");
  const denied = await h.tgTap("broker", "ld:handle:L-0001");
  expect(denied.some((e) => /ld|handle/i.test(e.text || "") && e.keyboard)).toBe(false);
  await h.tgTap("manager", "ld:handle:L-0001");
  await h.tgTap("manager", "ld:handlenow:L-0001");
  expect((await flagOf()).flagged_at).toBeNull();
});
