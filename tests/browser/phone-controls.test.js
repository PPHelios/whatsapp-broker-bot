// tests/browser/phone-controls.test.js — Phone-sized browser pass over every search box, form and voice button.
// Fake data, fake AI, fake speech recognition, and no outside network: a run uses no credits and sends nothing.
// Needs Chromium and Playwright (the sandbox has them at /opt/node-tools). Run: npm run test:browser
// Output is quiet: a failing check names its page, control and symptom, and nothing else prints.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Leads = require("../../services/leads");

process.env.OWNER_BROKER_IDS = "10000000-0000-0000-0000-000000000003";
jest.setTimeout(900000);

const PHONE = { width: 390, height: 844 };
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
const BAD = /undefined|NaN|\[object Object\]|Internal Server Error|Something went wrong|Cannot read prop/;
const SEARCH_TEXT = "شقة 3 غرف في التجمع تحت 9 مليون";
const TRANSCRIPT = "شقة 3 غرف في التجمع";

// Pages a broker and a manager open on the phone. Same lists as ui-audit/form-test-script.js.
const BROKER_PAGES = [
  ["home", "/app/"], ["search", "/app/search"], ["searches", "/app/searches"], ["ask", "/app/ask"], ["units", "/app/units"],
  ["unit", "/app/units/NH-A20"], ["unit-new", "/app/units/new"], ["unit-edit", "/app/units/NH-A20/edit"], ["leads", "/app/leads"],
  ["lead", "/app/leads/LEAD_REF"], ["lead-new", "/app/leads/new"], ["lead-import", "/app/leads/import"], ["deals", "/app/deals"],
  ["deal-new", "/app/deals/new"], ["import", "/app/import"], ["catalogue", "/app/catalogue"], ["commissions", "/app/commissions"],
  ["notifications", "/app/notifications"], ["settings", "/app/settings"], ["plan", "/app/plan"], ["report", "/app/report"]
];
const MANAGER_PAGES = [["dashboard", "/app/dashboard"], ["team", "/app/team"], ["usage", "/app/usage"], ["owner", "/app/owner"], ["sources", "/app/sources"]];

// Headless Chromium has no speech service: a fake recogniser "hears" TRANSCRIPT and ends, as the real one does.
const FAKE_SPEECH = `
  window.__heard = ${JSON.stringify(TRANSCRIPT)};
  class FakeSpeech {
    start() {
      setTimeout(() => { const ev = { results: [[{ transcript: window.__heard }]] }; this.onresult && this.onresult(ev); }, 100);
      setTimeout(() => this.onend && this.onend(), 400);
    }
    stop() { this.onend && this.onend(); }
  }
  window.SpeechRecognition = FakeSpeech;
  window.webkitSpeechRecognition = FakeSpeech;
`;

let h, browser, server, base;
const problems = [];
const note = (where, what) => problems.push(`${where}: ${what}`);

function watch(pg, where) {
  pg.on("pageerror", (e) => note(where, `page error: ${e.message.split("\n")[0]}`));
  pg.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) note(where, `console error: ${m.text().slice(0, 120)}`);
  });
  pg.on("response", (r) => {
    if (r.status() >= 500 && LOCAL.test(r.url())) note(where, `HTTP ${r.status()} on ${new URL(r.url()).pathname}`);
  });
}

// A form or voice post can still be navigating; read the page once it has settled.
async function checkBody(pg, where) {
  const read = () => pg.evaluate(() => (document.body ? document.body.innerText : ""));
  await pg.waitForLoadState("networkidle").catch(() => {});
  const text = await read().catch(async () => {
    await pg.waitForLoadState("networkidle").catch(() => {});
    return read();
  });
  const hit = text.match(BAD);
  if (hit) note(where, `page shows "${hit[0]}"`);
}

async function session(who) {
  const br = h.BROKERS[who];
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, permissions: ["microphone"] });
  await ctx.route(/.*/, (route) => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
  await ctx.addInitScript(FAKE_SPEECH);
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(15000);
  watch(pg, who);
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`${base}/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForURL((u) => u.pathname.startsWith("/app") && !u.pathname.includes("login"), { timeout: 10000 }).catch(() => {});
  await pg.waitForLoadState("networkidle");
  return { ctx, pg };
}

// A navigation can be cut off by a redirect still in flight after sign-in; one retry settles it.
async function open(pg, path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pg.goto(base + path, { waitUntil: "networkidle" });
    } catch (err) {
      if (attempt > 0 || !/ERR_ABORTED/.test(err.message)) throw err;
      await pg.waitForTimeout(300);
    }
  }
}

// Every visible search box: Enter must navigate or send a request, and the page must show no error.
async function searchBoxes(pg, who, name, path) {
  await open(pg, path);
  const count = (await pg.$$("input[name=q], input[type=search]")).length;
  for (let i = 0; i < count; i++) {
    await open(pg, path);
    const box = (await pg.$$("input[name=q], input[type=search]"))[i];
    if (!(await box.isVisible())) continue;
    const where = `${who} ${name} search box ${i + 1}`;
    const before = pg.url();
    let requests = 0;
    const onReq = (r) => { if (r.isNavigationRequest() || r.resourceType() === "fetch") requests++; };
    pg.on("request", onReq);
    await box.fill(SEARCH_TEXT);
    await box.press("Enter");
    await pg.waitForLoadState("networkidle").catch(() => {});
    pg.off("request", onReq);
    if (pg.url() === before && requests === 0) note(where, "Enter did nothing");
    await checkBody(pg, where);
  }
}

// Every visible form: fill it with fake values, tap its submit button, and check the page afterwards.
async function forms(pg, who, name, path) {
  await open(pg, path);
  const count = (await pg.$$("form")).length;
  for (let i = 0; i < count; i++) {
    for (const mode of ["empty", "filled"]) {
      await open(pg, path);
      const form = (await pg.$$("form"))[i];
      if (!form || !(await form.isVisible())) break;
      const action = (await form.getAttribute("action")) || "";
      if (/logout/.test(action)) break;
      const where = `${who} ${name} form ${i + 1} (${mode})`;
      if (mode === "filled") {
        await form.evaluate((el) => {
          const tom = new Date(Date.now() + 864e5);
          for (const inp of el.querySelectorAll("input, textarea, select")) {
            if (inp.type === "hidden" || inp.type === "file" || inp.disabled || !(inp.offsetWidth || inp.offsetHeight)) continue;
            if (inp.tagName === "SELECT") { if (inp.required && !inp.value && inp.options.length > 1) inp.selectedIndex = 1; continue; }
            if (inp.type === "checkbox" || inp.type === "radio" || inp.value) continue;
            const n = (inp.name || "").toLowerCase();
            let v = "اختبار";
            if (inp.type === "tel" || /phone|mobile/.test(n) || inp.inputMode === "tel") v = "01099998888";
            else if (inp.type === "number" || /numeric|decimal/.test(inp.inputMode) || /price|area|pct|amount|count|minutes|cap|credits|floor|bed|bath/.test(n)) v = "3";
            else if (inp.type === "date") v = tom.toISOString().slice(0, 10);
            else if (inp.type === "datetime-local") v = tom.toISOString().slice(0, 16);
            else if (inp.type === "time") v = "10:00";
            else if (inp.type === "email") v = "a@b.co";
            else if (inp.type === "url") v = "https://example.com";
            else if (/code|unit/.test(n)) v = "NH-A20";
            else if (/lead|ref/.test(n)) v = "L-0002";
            inp.value = v;
          }
        });
      }
      const submit = await form.$("button[type=submit], button:not([type]), input[type=submit]");
      if (!submit) break;
      await submit.tap({ timeout: 3000 }).catch(() => {});
      await pg.waitForLoadState("networkidle").catch(() => {});
      await checkBody(pg, where);
    }
  }
}

// One tap starts the mic and a second tap stops it. The AI path records on the first tap and sends the note on the second;
// the phone's own speech stops by itself, so the second tap is only needed when it is still listening.
async function hear(pg, btn) {
  await btn.tap();
  const recording = await pg.waitForSelector(".mic.recording", { timeout: 8000 }).then(() => true, () => false);
  if (recording) await btn.tap();
}

// Voice buttons: the search mic must hear, search and navigate; a recording button must send the note once it stops.
async function voice(pg, who, name, path) {
  await open(pg, path);
  const mics = (await pg.$$("[data-mic]")).length;
  for (let i = 0; i < mics; i++) {
    await open(pg, path);
    const btn = (await pg.$$("[data-mic]"))[i];
    if (!(await btn.isVisible())) continue;
    const where = `${who} ${name} voice search ${i + 1}`;
    await hear(pg, btn);
    const moved = await pg.waitForURL(/[?&]q=/, { timeout: 8000 }).then(() => true, () => false);
    if (!moved) note(where, "tapping the mic did not search");
    else await checkBody(pg, where);
  }
  await open(pg, path);
  const recs = await pg.$$("[data-voice-target]");
  for (let i = 0; i < recs.length; i++) {
    await open(pg, path);
    const btn = (await pg.$$("[data-voice-target]"))[i];
    if (!(await btn.isVisible())) continue;
    const where = `${who} ${name} voice note ${i + 1}`;
    const url = await btn.getAttribute("data-voice-url");
    await btn.tap();
    // Wait until the browser really records (permission and MediaRecorder start take a moment) before stopping.
    const recording = await pg.waitForSelector("[data-voice-target].recording", { timeout: 8000 }).then(() => true, () => false);
    if (!recording) {
      note(where, "tapping the voice button did not start a recording");
      continue;
    }
    await pg.waitForTimeout(500);
    const sent = pg.waitForResponse((r) => r.url().includes(url) && r.request().method() === "POST", { timeout: 10000 }).catch(() => null);
    await btn.tap().catch(() => {});
    const resp = await sent;
    if (!resp) note(where, "stopping the recording sent nothing");
    else if (resp.status() >= 500) note(where, `HTTP ${resp.status()} on ${url}`);
    await pg.waitForLoadState("networkidle").catch(() => {});
    await checkBody(pg, where);
  }
}

async function sweep(who, pages) {
  const { ctx, pg } = await session(who);
  try {
    for (const [name, path] of pages) {
      await open(pg, path);
      await searchBoxes(pg, who, name, path);
      await forms(pg, who, name, path);
      await voice(pg, who, name, path);
    }
  } finally {
    await ctx.close();
  }
}

beforeAll(async () => {
  h = await createHarness();
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  for (let i = 0; i < 5; i++) await h.insertListing({ code: `NH-A${20 + i}`, title: `NH-A${20 + i} unit`, compound: "Hyde Park", price_value: 4e6 + i * 1e5, area_value: 90 + i * 10, bedrooms: 2 + (i % 3) });
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  const lead = (await Leads.captureLead(h.pool, broker, { phones: ["01012345678"], name: "محمد سامي", quiet: true })).lead;
  BROKER_PAGES.forEach((p) => { p[1] = p[1].replace("LEAD_REF", lead.ref); });
  // Fake AI: search parses to a fixed filter, speech transcription returns TRANSCRIPT, other calls return an empty answer.
  h.AI.respond((c) => {
    if (c.operation === "transcribe") return TRANSCRIPT;
    if (c.operation === "search_parse") return { intent: "search", language: "ar", filters: { bedrooms_min: 3, bedrooms_max: 3, price_max: 9e6 } };
    return "{}";
  });
  server = h.app.app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  await closeHarness();
});

beforeEach(() => {
  problems.length = 0;
});

test("broker pages on the phone: every search box, form and voice button responds with no error", async () => {
  await sweep("broker", BROKER_PAGES);
  expect(problems).toEqual([]);
});

test("manager pages on the phone: every search box, form and voice button responds with no error", async () => {
  await sweep("admin", MANAGER_PAGES);
  expect(problems).toEqual([]);
});

test("voice search from the URL (?voice=1) hears, searches and lands on the results", async () => {
  const { ctx, pg } = await session("broker");
  try {
    await open(pg, "/app/search?voice=1");
    // Listening never starts on page load: nothing searches until the mic is tapped.
    const auto = await pg.waitForURL(/[?&]q=/, { timeout: 3000 }).then(() => true, () => false);
    if (auto) note("broker search ?voice=1", "listened on page load");
    await hear(pg, await pg.$("[data-mic]"));
    const moved = await pg.waitForURL(/[?&]q=/, { timeout: 8000 }).then(() => true, () => false);
    if (!moved) note("broker search ?voice=1", "tapping the mic did not search");
    await checkBody(pg, "broker search ?voice=1");
  } finally {
    await ctx.close();
  }
  expect(problems).toEqual([]);
});
