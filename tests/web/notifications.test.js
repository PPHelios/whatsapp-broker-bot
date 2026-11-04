// tests/web/notifications.test.js — The notification centre (one channel per alert), message credits,
// the inbox, settings, usage and web push (Release 3 step 2, Q15)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const N = require("../../lib/notifications");
const Credits = require("../../lib/credits");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const brokerRow = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
let seq = 0;
/** The broker messaged the bot recently: their 24-hour window is open. */
const openWindow = (who, ago = "1 hour") =>
  h.query(`INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, '{}', 'completed', NOW() - $3::interval)`, [
    `wamid.win.${++seq}`,
    h.BROKERS[who].phone,
    ago
  ]);
/** n accepted WhatsApp sends this month for a broker (credits used). */
const used = (who, n, kind = "reply") =>
  h.query(
    `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, metadata, created_at)
     SELECT $1, $2, 'wa_outbound', 'success', jsonb_build_object('kind', $4::text, 'action', 'search'), NOW() FROM generate_series(1, $3)`,
    [h.BROKERS[who].agency_id, h.BROKERS[who].id, n, kind]
  );
const event = (over = {}) => ({ kind: "match", dedupeKey: `ev:${++seq}`, title: "🏠 VIL-08 fits your client", url: "/app/notifications", ...over });
const rowsOf = (who) => h.query("SELECT kind, channel, reason, status FROM notifications WHERE broker_id = $1 ORDER BY id", [h.BROKERS[who].id]);
const waTo = (who) => h.WA.outbox.filter((m) => m.to === h.BROKERS[who].phone);

describe("one notification, one channel (Q15)", () => {
  test("alerts never go on WhatsApp: a broker without Telegram gets web push, even with a saved WhatsApp choice", async () => {
    await openWindow("broker");
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    await h.query(`UPDATE brokers SET notify_prefs = '{"channels":{"match":"whatsapp"},"quiet":{"enabled":false}}' WHERE id = $1`, [h.BROKERS.broker.id]);
    const b = await brokerRow("broker");
    expect(N.prefsOf(b).channels.match).toBe("web");
    const r = await N.notifyBroker(h.pool, b, event());
    expect(r).toMatchObject({ channel: "webpush", reason: "chosen", status: "sent" });
    expect(h.WA.outbox).toHaveLength(0);
    expect(h.Push.sent).toHaveLength(1);
    expect(h.Push.sent[0].raw).toMatch(/VIL-08 fits your client/);
  });

  test("saving a WhatsApp choice is ignored; the default stays", async () => {
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "whatsapp", lead_new: "web" }, quiet: { enabled: false } });
    const p = N.prefsOf(await brokerRow("broker"));
    expect(p.channels.match).toBe("web");
    expect(p.channels.lead_new || "web").toBe("web");
  });

  test("website chosen and no push enabled: the inbox alone (status skipped, reason no_push)", async () => {
    await openWindow("broker");
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "web" }, quiet: { enabled: false } });
    const r = await N.notifyBroker(h.pool, await brokerRow("broker"), event());
    expect(r).toMatchObject({ channel: "inbox", reason: "no_push", status: "skipped" });
    expect(h.WA.outbox).toHaveLength(0);
    expect(await N.unreadCount(h.pool, b)).toBe(1);
  });

  test("the same event twice notifies once", async () => {
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const b = await brokerRow("broker");
    const ev = event({ dedupeKey: "same" });
    await N.notifyBroker(h.pool, b, ev);
    expect(await N.notifyBroker(h.pool, b, ev)).toEqual({ duplicate: true });
    await Promise.all([N.notifyBroker(h.pool, b, ev), N.notifyBroker(h.pool, b, ev)]);
    expect(await rowsOf("broker")).toHaveLength(1);
    expect(h.Push.sent).toHaveLength(1);
  });

  test("alerts of one kind within 2 minutes go out as one grouped message", async () => {
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const b = await brokerRow("broker");
    await N.notifyBroker(h.pool, b, event({ title: "first" }));
    const q1 = await N.notifyBroker(h.pool, b, event({ title: "second" }));
    const q2 = await N.notifyBroker(h.pool, b, event({ title: "third" }));
    expect(q1).toMatchObject({ queued: true });
    expect(q2).toMatchObject({ queued: true });
    expect(h.Push.sent).toHaveLength(1);
    // Another kind is not merged.
    await N.notifyBroker(h.pool, b, event({ kind: "share_opened", title: "opened" }));
    expect(h.Push.sent).toHaveLength(2);

    expect(await N.deliverDue(h.pool, { now: new Date(Date.now() + 60 * 1000) })).toEqual({ delivered: 0, groups: 0 });
    expect(await N.deliverDue(h.pool, { now: new Date(Date.now() + 3 * 60 * 1000) })).toEqual({ delivered: 2, groups: 1 });
    const grouped = JSON.stringify(h.Push.sent[2].payload);
    expect(grouped).toMatch(/2 تنبيهات/);
    const rows = await h.query("SELECT title, reason, status, merged_into IS NOT NULL AS merged FROM notifications WHERE broker_id = $1 ORDER BY id", [h.BROKERS.broker.id]);
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ["first", "sent"],
      ["second", "sent"],
      ["third", "sent"],
      ["opened", "sent"]
    ]);
    expect(rows[2]).toMatchObject({ reason: "merged", merged: true });
  });

  test("quiet hours hold alerts until they end, then one message", async () => {
    await h.query(`UPDATE brokers SET notify_prefs = '{"quiet":{"enabled":true,"start":22,"end":8}}' WHERE id = $1`, [h.BROKERS.broker.id]);
    const b = await brokerRow("broker");
    const night = new Date("2026-11-03T21:30:00Z"); // 23:30 Cairo
    expect(N.inQuietHours(N.prefsOf(b), night)).toBe(true);
    const r = await N.notifyBroker(h.pool, b, event({ now: night }));
    expect(r).toMatchObject({ held: true });
    const [{ deliver_after }] = await h.query("SELECT deliver_after FROM notifications");
    expect(new Date(deliver_after).toISOString()).toBe("2026-11-04T06:00:00.000Z"); // 08:00 Cairo
    expect(await N.deliverDue(h.pool, { now: new Date("2026-11-04T05:00:00Z") })).toEqual({ delivered: 0, groups: 0 });
    await h.Push.subscribe(h.pool, h.BROKERS.broker);
    const out = await N.deliverDue(h.pool, { now: new Date("2026-11-04T06:01:00Z") });
    expect(out).toEqual({ delivered: 1, groups: 1 });
    expect(await rowsOf("broker")).toEqual([{ kind: "match", channel: "webpush", reason: "chosen", status: "sent" }]);
  });

  test("an inactive broker is never messaged; the url must be an /app/ path", async () => {
    await openWindow("broker");
    const b = { ...(await brokerRow("broker")), is_active: false };
    expect(await N.notifyBroker(h.pool, b, event())).toMatchObject({ status: "skipped" });
    expect(h.WA.outbox).toHaveLength(0);
    await expect(N.notifyBroker(h.pool, await brokerRow("broker"), event({ url: "https://evil.example" }))).rejects.toThrow(/\/app\//);
  });
});

describe("message credits", () => {
  test("levels: ok → warn (80%) → limit (100%) → ceiling (110%)", async () => {
    await h.query("UPDATE agencies SET wa_credits_monthly = 100 WHERE id = $1", [h.AGENCY_A]);
    const b = await brokerRow("broker");
    const lvl = async () => (await Credits.check(h.pool, b)).level;
    expect(await lvl()).toBe("ok");
    await used("colleague", 80);
    expect(await lvl()).toBe("warn");
    await used("colleague", 20);
    expect(await lvl()).toBe("limit");
    await used("colleague", 10);
    expect(await lvl()).toBe("ceiling");
    // Another agency is unaffected; failed and dropped sends never count.
    expect((await Credits.check(h.pool, await brokerRow("rival"))).level).toBe("ok");
    await h.query("UPDATE operation_logs SET status = 'failed'");
    expect(await lvl()).toBe("ok");
  });

  test("a hint rides once per level on a reply already being sent; managers get one alert at 80%", async () => {
    await h.query("UPDATE agencies SET wa_credits_monthly = 100 WHERE id = $1", [h.AGENCY_A]);
    await used("colleague", 50);
    const first = await h.text("broker", "مساعدة");
    expect(first).toHaveLength(1);
    expect(textOf(first)).toMatch(/نص رصيد رسايل واتساب/);
    expect(textOf(await h.text("broker", "مساعدة"))).not.toMatch(/رصيد/);
    await used("colleague", 30);
    expect(textOf(await h.text("broker", "مساعدة"))).toMatch(/80%/);
    const alerts = await h.query("SELECT broker_id, kind, dedupe_key FROM notifications WHERE kind = 'manager_alert'");
    expect(alerts).toEqual([expect.objectContaining({ broker_id: h.BROKERS.admin.id, dedupe_key: expect.stringMatching(/^credits_warn:\d{4}-\d{2}:80$/) })]);
  });

  test("past the ceiling: one notice a day, then read ticks only (no fallback bubble)", async () => {
    await h.query("UPDATE agencies SET wa_credits_monthly = 10 WHERE id = $1", [h.AGENCY_A]);
    await used("colleague", 11);
    const first = await h.text("broker", "مساعدة");
    expect(first).toHaveLength(1);
    expect(first[0].text).toMatch(/وصلنا للحد الشهري/);
    const receiptsBefore = h.WA.receipts.length;
    expect(await h.text("broker", "مساعدة")).toEqual([]);
    expect(await h.text("broker", "شقة في التجمع")).toEqual([]);
    expect(h.WA.receipts.length).toBeGreaterThan(receiptsBefore); // still marked as read
    const inbox = await h.query("SELECT kind, dedupe_key FROM notifications WHERE broker_id = $1", [h.BROKERS.broker.id]);
    expect(inbox).toEqual([expect.objectContaining({ kind: "credits", dedupe_key: expect.stringMatching(/^credits_ceiling:/) })]);
  });

  test("the global ceiling (all agencies on our number) stops everyone", async () => {
    process.env.WA_GLOBAL_MONTHLY_CEILING = "15";
    require("../../config").resetConfig();
    try {
      await used("rival", 15);
      expect((await Credits.check(h.pool, await brokerRow("broker"))).level).toBe("ceiling");
    } finally {
      delete process.env.WA_GLOBAL_MONTHLY_CEILING;
      require("../../config").resetConfig();
    }
  });

  test("a per-broker daily cap stops that broker only", async () => {
    await h.query("UPDATE agencies SET wa_broker_daily_cap = 3 WHERE id = $1", [h.AGENCY_A]);
    await used("broker", 3);
    expect((await Credits.check(h.pool, await brokerRow("broker"))).level).toBe("ceiling");
    expect((await Credits.check(h.pool, await brokerRow("colleague"))).level).toBe("ok");
  });

  test("sign-in links are not counted in the credits and have their own ceiling", async () => {
    await h.query("UPDATE agencies SET wa_credits_monthly = 5 WHERE id = $1", [h.AGENCY_A]);
    await used("colleague", 5, "web_login_link");
    const s = await Credits.check(h.pool, await brokerRow("broker"));
    expect(s).toMatchObject({ used: 0, level: "ok", login: { used: 5, reached: false } });
    expect(Credits.allowsSend(s, "web_login_link")).toBe(true);
    await used("colleague", 195, "web_login_link");
    expect(Credits.allowsSend(await Credits.check(h.pool, await brokerRow("broker")), "web_login_link")).toBe(false);
    // «دخول» at the login ceiling gets no link (and no reply counted in the credits).
    const r = await h.text("broker", "دخول");
    expect(textOf(r)).not.toMatch(/\/app\/login\/confirm/);
    expect(textOf(r)).toMatch(/روابط الدخول الشهرية للوكالة خلصت/);
  });

  test("every paid send counts with its action; the usage page shows the same numbers", async () => {
    await h.text("broker", "مساعدة");
    await h.text("broker", "شقة في التجمع");
    const logs = await h.query("SELECT metadata->>'action' AS action, count(*)::int AS n FROM operation_logs WHERE operation_type = 'wa_outbound' AND status = 'success' AND broker_id = $1 GROUP BY 1 ORDER BY 1", [h.BROKERS.broker.id]);
    expect(logs.find((l) => l.action === "search")).toBeTruthy();
    const total = logs.reduce((s, l) => s + l.n, 0);
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/usage");
    expect(page.status).toBe(200);
    expect(page.text).toContain(`data-credits-used="${total}"`);
    for (const l of logs) expect(page.text).toMatch(new RegExp(`data-action="${l.action}"><td>[^<]+</td><td>\\d+</td><td>${l.n}</td>`));
    expect(page.text).not.toContain("data-broker="); // per-broker table is for managers
  });
});

describe("website: inbox, log, settings, usage, push", () => {
  test("🔔 count, inbox, open marks read and redirects; another broker can't touch it", async () => {
    const b = await brokerRow("broker");
    await N.savePrefs(h.pool, b, { channels: { match: "web" }, quiet: { enabled: false } });
    const { id } = await N.notifyBroker(h.pool, await brokerRow("broker"), event({ title: "🏠 match one", url: "/app/units" }));
    const me = await signIn(h, "broker");
    const home = await me.agent.get("/app/");
    expect(home.text).toContain('data-unread="1"');
    const inbox = await me.agent.get("/app/notifications");
    expect(inbox.text).toContain("🏠 match one");

    const other = await signIn(h, "colleague");
    const sneak = await other.agent.post(`/app/notifications/${id}/open`).set("X-CSRF-Token", other.csrf);
    expect(sneak.headers.location).toBe("/app/notifications");
    expect((await other.agent.get("/app/notifications")).text).not.toContain("match one");
    expect(await N.unreadCount(h.pool, b)).toBe(1);

    const open = await me.agent.post(`/app/notifications/${id}/open`).set("X-CSRF-Token", me.csrf);
    expect(open.status).toBe(303);
    expect(open.headers.location).toBe("/app/units");
    expect(await N.unreadCount(h.pool, b)).toBe(0);
    expect((await me.agent.get("/app/")).text).not.toContain("data-unread");
    // No CSRF token → refused.
    expect((await me.agent.post("/app/notifications/read-all")).status).toBe(403);
  });

  test("the notification log is for managers, and only their agency", async () => {
    await N.notifyBroker(h.pool, await brokerRow("broker"), event({ title: "alpha alert" }));
    await N.notifyBroker(h.pool, await brokerRow("rival"), event({ title: "beta alert" }));
    const broker = await signIn(h, "broker");
    expect((await broker.agent.get("/app/notifications/log")).status).toBe(403);
    const admin = await signIn(h, "admin");
    const log = await admin.agent.get("/app/notifications/log");
    expect(log.status).toBe(200);
    expect(log.text).toContain("alpha alert");
    expect(log.text).not.toContain("beta alert");
    expect(log.text).toMatch(/Broker One/);
  });

  test("settings round trip (CSRF): channel per kind, quiet hours, language", async () => {
    const me = await signIn(h, "broker");
    const page = await me.agent.get("/app/settings");
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-vapid="BTestPublicKey"');
    expect((await me.agent.post("/app/settings").type("form").send({ ch_match: "web" })).status).toBe(403);
    const save = await me.agent
      .post("/app/settings")
      .type("form")
      .send({ _csrf: me.csrf, ch_match: "web", ch_assignment: "whatsapp", ch_follow_up: "bogus", quiet_on: "1", quiet_start: "23", quiet_end: "7", lang: "en" });
    expect(save.status).toBe(303);
    const [b] = await h.query("SELECT notify_prefs, preferred_lang FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
    expect(b.preferred_lang).toBe("en");
    expect(b.notify_prefs.channels).toEqual({ match: "web" });
    expect(b.notify_prefs.quiet).toEqual({ enabled: true, start: 23, end: 7 });
    const again = await me.agent.get("/app/settings");
    expect(again.text).toMatch(/<select name="ch_match" data-kind="match"><option value="web" selected>Website \(free\)<\/option><\/select>/);
    expect(again.text).not.toMatch(/value="whatsapp"/);
  });

  test("push: subscribe from the browser, test push, 410 removes the subscription, payload has no phone", async () => {
    const me = await signIn(h, "broker");
    const bad = await me.agent.post("/app/push/subscribe").set("X-CSRF-Token", me.csrf).type("form").send({ endpoint: "http://insecure", p256dh: "x", auth: "y" });
    expect(bad.status).toBe(400);
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc123def456";
    const ok = await me.agent
      .post("/app/push/subscribe")
      .set("X-CSRF-Token", me.csrf)
      .type("form")
      .send({ endpoint, p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u", auth: "tBHItJI5svbpez7KI4CCXg" });
    expect(ok.status).toBe(204);
    const test = await me.agent.post("/app/push/test").set("X-CSRF-Token", me.csrf);
    expect(test.headers.location).toBe("/app/settings?test=ok");
    expect(h.Push.sent).toHaveLength(1);
    expect(Object.keys(h.Push.sent[0].payload).sort()).toEqual(["body", "title", "url"]);

    await N.notifyBroker(h.pool, await brokerRow("broker"), event({ title: "Client 01012345678 opened VIL-08", push: { title: "عميل 01012345678", body: "+201012345678" } }));
    const last = h.Push.sent[h.Push.sent.length - 1].raw;
    expect(last).not.toMatch(/01012345678|201012345678/);

    h.Push.statuses.set(endpoint, 410);
    await N.notifyBroker(h.pool, await brokerRow("broker"), event({ kind: "hot_client" }));
    expect(await h.query("SELECT * FROM push_subscriptions")).toEqual([]);
  });

  test("usage: managers see every broker and set credits and caps; brokers can't", async () => {
    await used("colleague", 7);
    const broker = await signIn(h, "broker");
    expect((await broker.agent.post("/app/usage/agency").set("X-CSRF-Token", broker.csrf).type("form").send({ monthly: "9" })).status).toBe(403);
    const admin = await signIn(h, "admin");
    const page = await admin.agent.get("/app/usage");
    expect(page.text).toMatch(new RegExp(`data-broker="${h.BROKERS.colleague.id}"><td>Broker Two</td><td>7</td><td>7</td>`));
    const save = await admin.agent.post("/app/usage/agency").set("X-CSRF-Token", admin.csrf).type("form").send({ monthly: "6000", daily_cap: "", weekly_cap: "300" });
    expect(save.status).toBe(303);
    expect(await h.query("SELECT wa_credits_monthly, wa_broker_daily_cap, wa_broker_weekly_cap FROM agencies WHERE id = $1", [h.AGENCY_A])).toEqual([
      { wa_credits_monthly: 6000, wa_broker_daily_cap: null, wa_broker_weekly_cap: 300 }
    ]);
  });
});
