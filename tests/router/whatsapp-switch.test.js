// tests/router/whatsapp-switch.test.js — WHATSAPP_ENABLED=false: the webhook acknowledges and does nothing, nothing is
// sent on WhatsApp, and alerts fall back to the website inbox. Unset, WhatsApp works as before.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { resetConfig } = require("../../config");
const { createHarness, closeHarness } = require("../harness/app");
const Notifications = require("../../lib/notifications");

jest.setTimeout(60000);

let h;
afterEach(() => {
  delete process.env.WHATSAPP_ENABLED;
  resetConfig();
});
afterAll(closeHarness);

test("unset: WhatsApp is off by default (production), so the webhook acknowledges and nothing is sent", async () => {
  delete process.env.WHATSAPP_ENABLED;
  resetConfig();
  h = await createHarness();
  expect((await request(h.app.app).post("/webhook").send({ entry: [] })).text).toBe("WHATSAPP_DISABLED");
  expect(await h.text("broker", "مساعدة")).toEqual([]);
});

test("true: the bot replies on WhatsApp as before", async () => {
  process.env.WHATSAPP_ENABLED = "true";
  resetConfig();
  h = await createHarness();
  expect((await h.text("broker", "مساعدة")).length).toBeGreaterThan(0);
});

test("false: the webhook answers 200 without processing, verification is off, no WhatsApp sends, alerts go to the inbox", async () => {
  process.env.WHATSAPP_ENABLED = "false";
  resetConfig();
  h = await createHarness();
  const res = await request(h.app.app).post("/webhook").send({ entry: [] });
  expect(res.status).toBe(200);
  expect(res.text).toBe("WHATSAPP_DISABLED");
  expect((await request(h.app.app).get("/webhook?hub.mode=subscribe")).status).toBe(404);

  // Even a message that reaches the pipeline (e.g. replayed at boot) sends nothing on WhatsApp.
  expect(await h.text("broker", "مساعدة")).toEqual([]);
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  await h.query(`UPDATE brokers SET notify_prefs = '{"quiet":{"enabled":false}}' WHERE id = $1`, [broker.id]);
  await Notifications.notifyBroker(h.pool, { ...broker, notify_prefs: { quiet: { enabled: false } } }, { kind: "assignment", dedupeKey: "t1", title: "Test", body: "Hello", url: "/app/" });
  expect(h.WA.outbox).toEqual([]);
  const [n] = await h.query("SELECT channel, status FROM notifications");
  expect(n.channel).not.toBe("whatsapp");
});
