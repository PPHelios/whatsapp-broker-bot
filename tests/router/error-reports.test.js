// tests/router/error-reports.test.js — Errors land in error_events and alert the owner on Telegram (once per
// fingerprint per window); brokers report bugs with *bug …* in the bot or the website's "Report a problem" page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

process.env.TELEGRAM_BOT_TOKEN = "123:test";
process.env.ALERT_TELEGRAM_CHAT_ID = "999";

const { resetConfig } = require("../../config");
resetConfig();
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const S = require("../../lib/search");
const Notifications = require("../../lib/notifications");
const ErrorReports = require("../../lib/errorReports");
const { createScheduler } = require("../../lib/scheduler");

jest.setTimeout(90000);

const realFetch = global.fetch;
let alerts;
let h;
beforeEach(async () => {
  alerts = [];
  global.fetch = jest.fn(async (url, opts) => {
    if (String(url).startsWith("https://api.telegram.org/")) {
      alerts.push({ url: String(url), ...JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return realFetch(url, opts);
  });
  h = await createHarness();
});
afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = realFetch;
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ALERT_TELEGRAM_CHAT_ID;
  resetConfig();
  await closeHarness();
});

const flush = () => new Promise((r) => setTimeout(r, 30));
const events = (kind) => h.query("SELECT * FROM error_events WHERE kind = $1 ORDER BY id", [kind]);

test("a crashing turn is stored with its context, the broker gets the reference and the owner one alert per window", async () => {
  jest.spyOn(S, "handleSearchMessage").mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'price_value')"));

  const replies = await h.text("broker", "شقة في التجمع");
  await flush();
  const [row] = await events("error");
  expect(row).toMatchObject({ source: "turn", broker_id: h.BROKERS.broker.id, agency_id: h.BROKERS.broker.agency_id });
  expect(row.msg_id).toMatch(/^wamid\.in\./);
  expect(row.message).toContain("TypeError: Cannot read properties of undefined");
  expect(row.stack).not.toContain(process.cwd());
  expect(row.alerted_at).not.toBeNull();
  expect(textOf(replies)).toContain(`#E${row.id}`);
  expect(textOf(replies)).toContain("*عطل*");

  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({ chat_id: "999" });
  expect(alerts[0].text).toContain(`#E${row.id} (turn)`);
  expect(alerts[0].text).toContain("Broker One (broker, whatsapp)");

  // The same error again within the window: stored, not alerted again.
  await h.text("broker", "فيلا في الشيخ زايد");
  await flush();
  const rows = await events("error");
  expect(rows).toHaveLength(2);
  expect(rows[1].fingerprint).toBe(rows[0].fingerprint);
  expect(rows[1].alerted_at).toBeNull();
  expect(alerts).toHaveLength(1);
});

test("*bug …* sends a report at once; a bare *bug* asks, and the next message is the report (or cancel)", async () => {
  const r1 = await h.text("broker", "bug the flyer shows the wrong price, client 01012345678");
  await flush();
  const [rep] = await events("report");
  expect(rep).toMatchObject({ source: "whatsapp", broker_id: h.BROKERS.broker.id });
  expect(rep.message).toBe("the flyer shows the wrong price, client •••678");
  expect(textOf(r1)).toContain(`#R${rep.id}`);
  expect(alerts[0].text).toContain(`🐞 WehdatHub bug report #R${rep.id}`);
  expect(alerts[0].text).not.toContain("01012345678");

  const ask = await h.text("broker", "بلاغ");
  expect(textOf(ask)).toContain("🐞");
  const r2 = await h.text("broker", "الصور مش بتظهر في الكارت");
  await flush();
  const reports = await events("report");
  expect(reports).toHaveLength(2);
  expect(reports[1].message).toBe("الصور مش بتظهر في الكارت");
  expect(textOf(r2)).toContain(`#R${reports[1].id}`);

  await h.text("broker", "مشكلة");
  const c = await h.text("broker", "إلغاء");
  expect(textOf(c)).toContain("اتلغى");
  expect(await events("report")).toHaveLength(2);

  // A client's forwarded message that starts with "مشكلة" is not a report.
  expect(ErrorReports.maskPhones("مشكلة الشقة دي")).toBe("مشكلة الشقة دي");
  expect(require("../../lib/bugReports").COMMAND.test("مشكلة الشقة دي إن السعر عالي")).toBe(false);
});

test("the website: Report a problem, browser script errors, and a crashing page that shows the reference", async () => {
  const { agent, csrf } = await signIn(h, "admin");
  const home = await agent.get("/app/");
  expect(home.text).toContain('href="/app/report"');

  const form = await agent.get("/app/report?from=/app/leads");
  expect(form.status).toBe(200);
  const sent = await agent.post("/app/report").type("form").send({ _csrf: csrf, text: "Search page is blank", from: "/app/leads" });
  expect(sent.status).toBe(200);
  const [rep] = await events("report");
  expect(rep).toMatchObject({ source: "web", path: "/app/leads", broker_id: h.BROKERS.admin.id });
  expect(sent.text).toContain(`#R${rep.id}`);

  const ce = await agent
    .post("/app/client-error")
    .set("X-CSRF-Token", csrf)
    .send({ message: "x is not defined", file: "https://example.test/app/static/app.js?v=abc", line: 12, page: "/app/units?q=1" });
  expect(ce.status).toBe(204);
  const [client] = await events("error");
  expect(client).toMatchObject({ source: "client", path: "/app/units" });
  expect(client.metadata.frame).toBe("/app/static/app.js:12");

  jest.spyOn(Notifications, "listInbox").mockRejectedValue(new Error("boom"));
  const crash = await agent.get("/app/notifications");
  expect(crash.status).toBe(500);
  const web = (await events("error")).find((e) => e.source === "web");
  expect(web.path).toBe("GET /app/notifications");
  expect(crash.text).toContain(`#E${web.id}`);
  expect(crash.text).toContain("/app/report?from=");
});

test("a failing background job is captured through the scheduler's onError", async () => {
  const seen = [];
  const scheduler = createScheduler({
    pool: h.pool,
    jobs: [{ name: "boom", everyMs: 1000, run: async () => { throw new Error("job exploded"); } }],
    log: { error: () => {} },
    onError: (err, job) => ErrorReports.capture(err, { pool: h.pool, source: "job", metadata: { job: job.name } }).then((id) => seen.push(id))
  });
  await scheduler.tick();
  expect(seen).toHaveLength(1);
  const [row] = await events("error");
  expect(row).toMatchObject({ source: "job", message: "Error: job exploded" });
  expect(row.metadata.job).toBe("boom");
});

test("helpers: phones are masked, fingerprints ignore numbers and ids, alerts are off without a chat id", async () => {
  expect(ErrorReports.maskPhones("call +20 101 234 5678 or ٠١٠١٢٣٤٥٦٧٨, price 8500000")).toBe("call •••678 or •••٦٧٨, price 8500000");
  const a = ErrorReports.fingerprint("turn", "Error", "listing 10000000-0000-0000-0000-000000000001 has 3 photos", "lib/x.js:1");
  const b = ErrorReports.fingerprint("turn", "Error", "listing 20000000-0000-0000-0000-000000000009 has 7 photos", "lib/x.js:1");
  expect(a).toBe(b);
  expect(await ErrorReports.alertOwner("hi", { config: { alerts: { telegramToken: "t", telegramChatId: "" } } })).toBe(false);
});
