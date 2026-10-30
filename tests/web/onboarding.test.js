// tests/web/onboarding.test.js — A new broker's first week: the welcome card (closed once), the "?" tip of each main
// screen, the bot's one-time hints, the day 1/3/7 nudges (first missing step), "talk to a person" and the owner's stuck list.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Onboarding = require("../../services/onboarding");
const O = require("../../domain/onboarding");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const DAY = 86400000;

test("rules: the first missing step is nudged; day 7 with everything done sends a tip", () => {
  expect(O.nudge(1, { telegram: false, units: 0, leads: 0, searches: 0 }, "en").url).toBe("/app/onboarding/telegram");
  expect(O.nudge(3, { telegram: true, units: 0, leads: 0, searches: 0 }, "en").url).toBe("/app/units/new");
  expect(O.nudge(3, { telegram: true, units: 2, leads: 0, searches: 0 }, "ar").url).toBe("/app/leads");
  expect(O.nudge(3, { telegram: true, units: 2, leads: 1, searches: 1 }, "ar")).toBeNull();
  expect(O.nudge(7, { telegram: true, units: 2, leads: 1, searches: 1 }, "ar").url).toBe("/app/ask");
  expect(O.tip("add", "ar")).toHaveLength(4);
  expect(O.tip("nope")).toBeNull();
});

test("welcome card shows once after sign-in and stays closed; managers also see the team step", async () => {
  const { agent, csrf } = await signIn(h, "admin");
  const home = await agent.get("/app/?lang=en");
  expect(home.text).toContain("data-welcome");
  expect(home.text).toContain("Invite your team");
  expect((await signIn(h, "broker")).agent.get("/app/?lang=en").then((r) => r.text)).resolves.not.toContain("Invite your team");
  const closed = await agent.post("/app/onboarding/welcome").type("form").send({ _csrf: csrf });
  expect(closed.status).toBe(303);
  expect((await agent.get("/app/")).text).not.toContain("data-welcome");
});

test("each main screen has its '?' tip, and the footer offers a person when support is set", async () => {
  const { agent } = await signIn(h, "broker");
  const search = await agent.get("/app/search?lang=en");
  expect(search.text).toContain('data-tip="search"');
  expect(search.text).not.toContain("data-support");
  process.env.SUPPORT_TELEGRAM = "@wehdat_support";
  require("../../config").resetConfig();
  try {
    const page = await agent.get("/app/leads?lang=en");
    expect(page.text).toContain('data-tip="leads"');
    expect(page.text).toContain('href="https://t.me/wehdat_support"');
    expect(page.text).not.toMatch(/wa\.me|api\.whatsapp/);
  } finally {
    delete process.env.SUPPORT_TELEGRAM;
    require("../../config").resetConfig();
  }
});

test("bot hints come once per kind", async () => {
  const broker = await row("broker");
  expect(await Onboarding.firstHint(h.pool, broker, "unit")).toContain("أول وحدة اتحفظت");
  expect(await Onboarding.firstHint(h.pool, await row("broker"), "unit")).toBeNull();
  expect(await Onboarding.firstHint(h.pool, broker, "lead")).toContain("أول عميل");
  expect(await Onboarding.firstHint(h.pool, broker, "nope")).toBeNull();
});

test("hint is added to the lead card the first time a lead is saved over Telegram", async () => {
  await h.tgLink("broker");
  const offer = await h.tgText("broker", "ليد 01011112222");
  const save = JSON.stringify(offer).match(/ld:save:[0-9a-f]+/)[0];
  const first = await h.tgTap("broker", save);
  expect(JSON.stringify(first)).toMatch(/أول عميل اتسجل/);
  const offer2 = await h.tgText("broker", "ليد 01033334444");
  const second = await h.tgTap("broker", JSON.stringify(offer2).match(/ld:save:[0-9a-f]+/)[0]);
  expect(JSON.stringify(second)).not.toMatch(/أول عميل اتسجل/);
});

test("nudges: day 1, 3, 7 once each, about the first missing step; stuck list for the owner", async () => {
  const t0 = new Date("2026-11-10T09:00:00Z");
  await h.query("UPDATE brokers SET created_at = $2 WHERE id = $1", [h.BROKERS.broker.id, new Date(t0.getTime() - DAY).toISOString()]);
  const r1 = await Onboarding.nudgeDue(h.pool, { now: t0 });
  expect(r1.counts.nudges).toBeGreaterThanOrEqual(1);
  const notes = await h.query("SELECT title, kind, dedupe_key FROM notifications WHERE broker_id = $1 AND kind = 'onboarding'", [h.BROKERS.broker.id]);
  expect(notes).toHaveLength(1);
  expect(notes[0].dedupe_key).toBe("onboarding:d1");
  // Not twice.
  await Onboarding.nudgeDue(h.pool, { now: new Date(t0.getTime() + 3600000) });
  expect(await h.query("SELECT 1 FROM notifications WHERE broker_id = $1 AND kind = 'onboarding'", [h.BROKERS.broker.id])).toHaveLength(1);
  // Two days on, day 3 is due.
  await h.query("UPDATE brokers SET created_at = $2 WHERE id = $1", [h.BROKERS.broker.id, new Date(t0.getTime() - 3 * DAY).toISOString()]);
  await Onboarding.nudgeDue(h.pool, { now: t0 });
  expect((await h.query("SELECT dedupe_key FROM notifications WHERE broker_id = $1 AND kind = 'onboarding' ORDER BY dedupe_key", [h.BROKERS.broker.id])).map((n) => n.dedupe_key)).toEqual(["onboarding:d1", "onboarding:d3"]);

  const stuck = await Onboarding.stuckList(h.pool, { now: t0 });
  const mine = stuck.find((s) => s.id === h.BROKERS.broker.id);
  expect(mine.reasons).toEqual(expect.arrayContaining(["nothing_added", "no_telegram"]));

  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  require("../../config").resetConfig();
  try {
    const { agent } = await signIn(h, "admin");
    const owner = await agent.get("/app/owner");
    expect(owner.status).toBe(200);
    expect(owner.text).toContain('id="stuck"');
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  }
});
