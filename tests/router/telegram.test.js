// tests/router/telegram.test.js — Telegram as the brokers' bot channel (Release 3T step 1): the webhook secret,
// linking (start link, own contact only), replies on Telegram (HTML, inline keyboards, no WhatsApp, no credits),
// button taps through callback_query (long ids via a stored token), media downloads, boot replay.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { resetConfig } = require("../../config");
const { createHarness, closeHarness, settle } = require("../harness/app");
const TgLink = require("../../lib/tgLink");
const Fmt = require("../../domain/tgFormat");
const Media = require("../../lib/media");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const texts = (out) => out.map((e) => e.text || e.caption || "").join("\n");

describe("webhook", () => {
  afterEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    resetConfig();
  });

  test("refused without the secret header, or when no secret is configured; accepted with it", async () => {
    let r = await request(h.app.app).post("/telegram/webhook").send({ update_id: 1 });
    expect(r.status).toBe(401);
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret-token-value";
    resetConfig();
    const app = require("../../server").createApp({ pool: h.pool });
    r = await request(app.app).post("/telegram/webhook").set("X-Telegram-Bot-Api-Secret-Token", "wrong-token-value!").send({ update_id: 1 });
    expect(r.status).toBe(401);
    r = await request(app.app).post("/telegram/webhook").set("X-Telegram-Bot-Api-Secret-Token", "s3cret-token-value").send({ update_id: 1 });
    expect(r.status).toBe(200);
  });
});

describe("linking", () => {
  test("an unknown user is asked to share their number; someone else's contact and an unregistered number are refused", async () => {
    const [ask] = await h.tgText(9999, "hello");
    expect(ask.params.reply_markup.keyboard[0][0].request_contact).toBe(true);
    const other = await h.tg(9999, { contact: { phone_number: "+201000000001", first_name: "X", user_id: 1234 } });
    expect(texts(other)).toMatch(/your own number/);
    const unknown = await h.tg(9999, { contact: { phone_number: "+201099999999", first_name: "X", user_id: 9999 } });
    expect(texts(unknown)).toMatch(/isn't registered/);
    expect((await row("broker")).telegram_user_id).toBeNull();
  });

  test("sharing their own registered number links the broker and shows the command list in their language", async () => {
    const out = await h.tg(5555, { contact: { phone_number: "+201000000001", first_name: "B", user_id: 5555 } });
    expect(out[0].text).toMatch(/تم ربط حسابك/);
    expect(out[0].params.reply_markup.remove_keyboard).toBe(true);
    expect(out.length).toBeGreaterThan(1); // the help text follows
    const b = await row("broker");
    expect(Number(b.telegram_user_id)).toBe(5555);
    expect(Number(b.telegram_chat_id)).toBe(5555);
    expect(h.WA.outbox).toEqual([]);
  });

  test("the start link works once; a used or made-up token is refused; a deactivated broker can't link", async () => {
    const token = await TgLink.issueLinkToken(h.pool, await row("admin"));
    expect(TgLink.startLink("aqar_test_bot", token)).toBe(`https://t.me/aqar_test_bot?start=${token}`);
    const out = await h.tgText(6001, `/start ${token}`);
    expect(out[0].text).toMatch(/Linked\. Welcome, Agency Admin/);
    expect(texts(await h.tgText(6002, `/start ${token}`))).toMatch(/invalid or already used/);
    expect(texts(await h.tgText(6003, "/start abcdefghijklmnopqrstuvwxyz123456"))).toMatch(/invalid/);
    const t2 = await TgLink.issueLinkToken(h.pool, await row("colleague"));
    await h.query("UPDATE brokers SET is_active = false WHERE id = $1", [h.BROKERS.colleague.id]);
    await h.tgText(6004, `/start ${t2}`);
    expect((await row("colleague")).telegram_user_id).toBeNull();
  });

  test("linking a Telegram account already tied to another broker moves it", async () => {
    await h.tgLink("broker");
    const token = await TgLink.issueLinkToken(h.pool, await row("colleague"));
    await h.tgText("broker", `/start ${token}`); // a linked user: /start shows help, the token isn't used
    expect(Number((await row("broker")).telegram_user_id)).toBe(h.TG_IDS.broker);
    await h.query("UPDATE brokers SET telegram_user_id = NULL WHERE id = $1", [h.BROKERS.broker.id]);
    await h.tgText("broker", `/start ${token}`);
    expect(Number((await row("colleague")).telegram_user_id)).toBe(h.TG_IDS.broker);
  });
});

describe("turns on Telegram", () => {
  test("replies go to the chat as HTML, never WhatsApp, and count as tg_outbound without credits", async () => {
    await h.tgLink("broker");
    const out = await h.tgText("broker", "مساعدة");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.chatId === String(h.TG_IDS.broker))).toBe(true);
    expect(texts(out)).toMatch(/<b>/);
    expect(texts(out)).not.toMatch(/(^|[^\w])\*[^*\n]+\*/);
    expect(h.WA.outbox).toEqual([]);
    const logs = await h.query("SELECT operation_type, metadata FROM operation_logs WHERE operation_type IN ('tg_outbound', 'wa_outbound')");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.operation_type === "tg_outbound" && l.metadata.egp === undefined)).toBe(true);
  });

  test("a contact card offers Save as client with inline buttons; tapping saves the lead", async () => {
    await h.tgLink("broker");
    const out = await h.tg("broker", { contact: { phone_number: "+201012345678", first_name: "Sara" } });
    const msg = out.find((e) => e.keyboard);
    const save = msg.keyboard.flat().find((b) => b.callback_data.startsWith("ld:save:"));
    expect(save.text).toMatch(/حفظ كعميل/);
    await h.tgTap("broker", save.callback_data);
    const [lead] = await h.query("SELECT name, phones FROM leads");
    expect(lead.name).toBe("Sara");
    expect(lead.phones).toEqual(["+201012345678"]);
  });

  test("a repeated update (Telegram retry) runs once", async () => {
    await h.tgLink("broker");
    const update = { message: { message_id: 77, from: { id: h.TG_IDS.broker }, chat: { id: h.TG_IDS.broker, type: "private" }, text: "مساعدة" } };
    await h.app.handleTelegramUpdate({ update_id: 1, ...update });
    const n = h.TG.outbox.length;
    await h.app.handleTelegramUpdate({ update_id: 1, ...update });
    await settle();
    expect(h.TG.outbox.filter((e) => e.method === "sendMessage").length).toBe(h.TG.outbox.slice(0, n).filter((e) => e.method === "sendMessage").length);
  });

  test("boot replays a pending Telegram turn to the linked chat", async () => {
    await h.tgLink("broker");
    const msg = { id: `tg:${h.TG_IDS.broker}:900`, from: `tg:${h.TG_IDS.broker}`, type: "text", text: { body: "مساعدة" } };
    await h.query("INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, $3, 'new', NOW())", [msg.id, `tg:${h.TG_IDS.broker}`, JSON.stringify(msg)]);
    await h.app.bootRecovery();
    await settle(10);
    expect(h.TG.outbox.some((e) => e.method === "sendMessage" && e.chatId === String(h.TG_IDS.broker))).toBe(true);
    expect(h.WA.outbox).toEqual([]);
  });
});

describe("notifications on Telegram (step 2)", () => {
  const N = require("../../lib/notifications");
  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    resetConfig();
  });
  afterAll(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfig();
  });
  let seq = 0;
  const event = (over = {}) => ({ kind: "match", dedupeKey: `tg-ev:${++seq}`, title: "🏠 VIL-08 fits your client", url: "/app/notifications", ...over });
  const toChat = (who) => h.TG.outbox.filter((e) => e.method === "sendMessage" && e.chatId === String(h.TG_IDS[who]));

  test("a linked broker with no choice gets alerts on Telegram: free, no WhatsApp, no credits", async () => {
    await h.tgLink("broker");
    const r = await N.notifyBroker(h.pool, await row("broker"), event());
    expect(r).toMatchObject({ channel: "telegram", status: "sent" });
    expect(toChat("broker")).toHaveLength(1);
    expect(toChat("broker")[0].text).toMatch(/VIL-08 fits your client/);
    expect(h.WA.outbox).toEqual([]);
    expect(await h.query("SELECT 1 FROM operation_logs WHERE operation_type = 'wa_outbound'")).toEqual([]);
    expect((await h.query("SELECT metadata->>'kind' AS kind FROM operation_logs WHERE operation_type = 'tg_outbound'"))[0].kind).toBe("notify_match");
  });

  test("Telegram chosen but not linked: no Telegram, no WhatsApp; the website inbox keeps it", async () => {
    await N.savePrefs(h.pool, h.BROKERS.broker, { channels: { match: "telegram" } });
    // Noon in Cairo: outside the default quiet hours, whatever time the suite runs.
    const r = await N.notifyBroker(h.pool, await row("broker"), event({ now: new Date("2026-10-25T10:00:00Z") }));
    expect(r.channel).not.toBe("telegram");
    expect(h.TG.outbox).toEqual([]);
    expect(h.WA.outbox).toEqual([]);
    const [n] = await h.query("SELECT channel, reason FROM notifications WHERE broker_id = $1", [h.BROKERS.broker.id]);
    expect(n.reason).toBe("not_linked");
  });

  test("an unlinked broker with no choice still defaults to WhatsApp", async () => {
    const prefs = N.prefsOf(await row("broker"), { telegramLinked: false });
    expect(prefs.channels.match).toBe("whatsapp");
    expect(N.prefsOf(await row("broker"), { telegramLinked: true }).channels.match).toBe("both");
  });

  test("a sign-in link asked for on the website goes to Telegram when linked", async () => {
    await h.tgLink("broker");
    const agent = request.agent(h.app.app);
    const form = await agent.get("/app/login");
    const pre = form.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const r = await agent.post("/app/login").type("form").send({ phone: "01000000001", _csrf: pre });
    expect(r.status).toBe(200);
    expect(toChat("broker").some((e) => /\/app\/login\/confirm\?t=/.test(e.text))).toBe(true);
    expect(h.WA.outbox).toEqual([]);
  });

  test("the settings page offers Telegram when the bot is on", async () => {
    await h.tgLink("broker");
    const { signIn } = require("../harness/web");
    const me = await signIn(h, "broker");
    const page = await me.agent.get("/app/settings");
    expect(page.text).toMatch(/<select name="ch_match" data-kind="match"><option value="both" selected>/);
  });
});

describe("getting things to clients (step 3)", () => {
  const TgSend = require("../../lib/tgSend");

  test("client copy on Telegram carries a Send on WhatsApp button with the text; WhatsApp brokers get plain text", async () => {
    await h.insertListing({ code: "HP-201" });
    await h.tgLink("broker");
    const out = await h.tgTap("broker", "client:HP-201");
    const msg = out.find((e) => e.method === "sendMessage" && e.keyboard);
    const btn = msg.keyboard[0][0];
    expect(btn.text).toMatch(/واتساب|WhatsApp/);
    expect(btn.url).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(decodeURIComponent(btn.url.split("text=")[1])).toMatch(/HP-201/);
    expect(h.WA.outbox).toEqual([]);

    await h.query("UPDATE brokers SET telegram_user_id = NULL, telegram_chat_id = NULL");
    const wa = await h.tap("broker", "client:HP-201");
    expect(wa.some((r) => r.type === "text" && /HP-201/.test(r.text))).toBe(true);
  });

  test("a wa.me link too long for a button goes through /go/wa/<token>; unknown tokens are 404", async () => {
    const short = await TgSend.waButtonUrl(h.pool, "hello", "01000000009");
    expect(short).toBe("https://wa.me/201000000009?text=hello");
    const long = await TgSend.waButtonUrl(h.pool, "ش".repeat(1500));
    const m = long.match(/\/go\/wa\/([A-Za-z0-9_-]{16})$/);
    expect(m).not.toBeNull();
    const r = await request(h.app.app).get(`/go/wa/${m[1]}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect((await request(h.app.app).get("/go/wa/AAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await request(h.app.app).get("/go/wa/../x")).status).toBe(404);
  });

  test("the photo share page serves the unit's photos same-origin, for that agency only", async () => {
    const { signIn } = require("../harness/web");
    const l = await h.insertListing({ code: "HP-301" });
    h.Storage.objects.set("u/a.jpg", Buffer.from("JPEGBYTES"));
    const [img] = await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, $3) RETURNING id", [l.id, h.AGENCY_A, `${h.Storage.BASE}u/a.jpg`]);
    const [bad] = await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 1, 'https://evil.example/x.jpg') RETURNING id", [l.id, h.AGENCY_A]);
    const me = await signIn(h, "broker");
    const unit = await me.agent.get("/app/units/HP-301");
    expect(unit.text).toMatch(/href="\/app\/units\/HP-301\/share-media"/);
    const page = await me.agent.get("/app/units/HP-301/share-media");
    expect(page.status).toBe(200);
    expect(page.text).toContain(`src="/app/units/HP-301/photos/${img.id}"`);
    expect(page.text).toMatch(/data-share-media/);
    const photo = await me.agent.get(`/app/units/HP-301/photos/${img.id}`);
    expect(photo.status).toBe(200);
    expect(photo.headers["content-type"]).toMatch(/image\/jpeg/);
    expect(photo.body.toString()).toBe("JPEGBYTES");
    expect((await me.agent.get(`/app/units/HP-301/photos/${bad.id}`)).status).toBe(404);
    const other = await signIn(h, "rival");
    expect((await other.agent.get(`/app/units/HP-301/photos/${img.id}`)).status).toBe(404);
    expect((await other.agent.get("/app/units/HP-301/share-media")).status).toBe(404);
  });
});

describe("the website inside Telegram (Mini App, step 4)", () => {
  const TgInit = require("../../domain/tgInitData");
  const TOKEN = "123:test";
  beforeAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    resetConfig();
  });
  afterAll(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfig();
  });
  const now = () => Math.floor(Date.now() / 1000);
  const initFor = (userId, over = {}) => TgInit.sign({ auth_date: String(now()), query_id: `q${userId}${Math.random()}`, user: JSON.stringify({ id: userId, first_name: "B" }), ...over }, TOKEN);
  const post = (agent, initData, extra = {}) => agent.post("/app/tg/session").type("form").send({ initData, ...extra });

  test("initData checks: Telegram's signature, fresh auth_date, a real user", () => {
    const good = initFor(42);
    expect(TgInit.verify(good, TOKEN)).toMatchObject({ userId: 42 });
    expect(TgInit.verify(good, "999:other")).toBeNull();
    expect(TgInit.verify(good.replace("42", "43"), TOKEN)).toBeNull();
    expect(TgInit.verify(initFor(42, { auth_date: String(now() - 7200) }), TOKEN)).toBeNull();
    expect(TgInit.verify(initFor(42, { user: "{}" }), TOKEN)).toBeNull();
    expect(TgInit.verify("", TOKEN)).toBeNull();
    expect(TgInit.verify(good, "")).toBeNull();
  });

  test("a linked broker opening the website from the bot is signed in; once per initData", async () => {
    await h.tgLink("broker");
    const page = await request(h.app.app).get("/app/tg?next=/app/leads");
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/id="tg-signin" data-next="\/app\/leads"/);
    const agent = request.agent(h.app.app);
    const data = initFor(h.TG_IDS.broker);
    const r = await post(agent, data, { next: "/app/leads" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ next: "/app/leads" });
    expect(r.headers["set-cookie"].join(";")).toMatch(/aq_sid=/);
    expect((await agent.get("/app/")).status).toBe(200);
    expect((await post(request.agent(h.app.app), data)).status).toBe(403); // replay
    const [op] = await h.query("SELECT broker_id FROM operation_logs WHERE operation_type = 'web_login_telegram'");
    expect(op.broker_id).toBe(h.BROKERS.broker.id);
  });

  test("refused: unlinked Telegram users, bad signatures, other sites", async () => {
    const r1 = await post(request.agent(h.app.app), initFor(777001));
    expect(r1.status).toBe(403);
    expect(r1.body.error).toBe("not_linked");
    await h.tgLink("broker");
    const forged = TgInit.sign({ auth_date: String(now()), user: JSON.stringify({ id: h.TG_IDS.broker }) }, "999:attacker");
    expect((await post(request.agent(h.app.app), forged)).status).toBe(403);
    const cross = await request(h.app.app).post("/app/tg/session").set("Sec-Fetch-Site", "cross-site").type("form").send({ initData: initFor(h.TG_IDS.broker) });
    expect(cross.status).toBe(403);
    const evil = await post(request.agent(h.app.app), initFor(h.TG_IDS.broker), { next: "https://evil.example" });
    expect(evil.body).toEqual({ next: "/app/" });
  });

  test("the iframe case gets a SameSite=None cookie over https only", () => {
    const S = require("../../web/session");
    expect(typeof S.setSessionCookie).toBe("function");
    const set = [];
    S.setSessionCookie({ cookie: (n, v, o) => set.push(o) }, "sid", { crossSite: true });
    expect(set[0].sameSite).toBe("lax"); // tests run on http://localhost
  });
});

describe("boot setup", () => {
  const Setup = require("../../lib/tgSetup");
  afterEach(() => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "PUBLIC_BASE_URL"]) delete process.env[k];
    resetConfig();
  });

  test("registers the webhook, the WehdatHub menu button and the commands only when fully configured", async () => {
    expect(await Setup.setup({ log: () => {} })).toEqual({ ok: false, skipped: "no_token" });
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    resetConfig();
    expect(await Setup.setup({ log: () => {} })).toEqual({ ok: false, skipped: "no_secret" });
    process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret-token-value";
    resetConfig();
    expect(await Setup.setup({ log: () => {} })).toEqual({ ok: false, skipped: "not_https" });
    process.env.PUBLIC_BASE_URL = "https://wehdathub.example";
    resetConfig();
    expect(await Setup.setup({ log: () => {} })).toEqual({ ok: true });
    const hook = h.TG.outbox.find((e) => e.method === "setWebhook");
    expect(hook).toMatchObject({ url: "https://wehdathub.example/telegram/webhook", secret: "s3cret-token-value" });
    const menu = h.TG.outbox.find((e) => e.method === "setChatMenuButton");
    expect(menu.params.menu_button.web_app.url).toBe("https://wehdathub.example/app/tg");
    expect(h.TG.outbox.filter((e) => e.method === "setMyCommands")).toHaveLength(2);
  });

  test("/help from the command menu reaches the router as help", async () => {
    await h.tgLink("broker");
    const out = await h.tgText(h.TG_IDS.broker, "/help@Wehdat_Hub_bot");
    expect(out.length).toBeGreaterThan(0);
    expect(texts(out)).not.toMatch(/\/help/);
  });
});

describe("free messages (step 5)", () => {
  test("a Telegram search shows 10 units a message; More is used once and leaves the earlier message", async () => {
    for (let i = 1; i <= 12; i++) await h.insertListing({ code: `TS-${i}`, price_value: 5000000 + i * 1000 });
    await h.tgLink("broker");
    const first = await h.tgText("broker", "شقة");
    const page1 = first.find((e) => e.method === "sendMessage" && /وحدة مطابقة|matching/.test(e.text || ""));
    expect(page1).toBeDefined();
    expect((page1.text.match(/^\d+\. /gm) || []).length).toBe(10);
    const more = page1.keyboard.flat().find((b) => /MORE|search_more/.test(b.callback_data));
    const next = await h.tgTap("broker", more.callback_data);
    expect(h.TG.outbox.some((e) => e.method === "editMessageReplyMarkup")).toBe(true);
    const page2 = next.find((e) => e.method === "sendMessage" && /^11\. /m.test(e.text || ""));
    expect((page2.text.match(/^\d+\. /gm) || []).length).toBe(2);
  });

  test("WhatsApp searches keep 5 a message", async () => {
    for (let i = 1; i <= 7; i++) await h.insertListing({ code: `WS-${i}` });
    const out = await h.text("broker", "شقة");
    const body = out.map((r) => r.text || "").join("\n");
    expect((body.match(/^\d+\. /gm) || []).length).toBe(5);
  });
});

describe("repeated taps and slow steps", () => {
  const fields = {
    code: null, listing_type: "sale", market: "resale", property_type: "apartment", compound: "ميفيدا", compound_en: "Mivida",
    area_value: 200, bedrooms: 3, bathrooms: null, price_value: 10000000,
    delivery: { ready: null, year: null, quarter: null, month: null, raw: null }, features: [], features_other: [],
    resale: { cash_paid: 10000000 }, primary: {}
  };
  const startDraft = async () => {
    await h.tgLink("broker");
    h.AI.respond((call) => (call.operation === "listing_extraction" ? fields : { intent: "search", filters: {}, locations: [], location_terms: [] }));
    await h.tgText("broker", "اضافة");
    await h.tgText("broker", "شقة في ميفيدا");
  };

  test("Review sends a working-on-it line first, then the review card, then deletes the line", async () => {
    await startDraft();
    const start = h.TG.outbox.length;
    await h.tgText("broker", "تم");
    const calls = h.TG.outbox.slice(start).filter((e) => e.method !== "sendChatAction");
    const working = calls.findIndex((e) => e.method === "sendMessage" && /بنراجع بيانات الوحدة/.test(e.text || ""));
    const card = calls.findIndex((e) => e.method === "sendMessage" && e.keyboard && /ميفيدا|Mivida/.test(e.text || ""));
    const del = calls.findIndex((e) => e.method === "deleteMessage");
    expect(working).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(working);
    expect(del).toBeGreaterThan(card);
    expect(calls[del].params.message_id).toBeDefined();
  });

  test("the same button tapped again right away gets a toast and runs once", async () => {
    await startDraft();
    await h.tgText("broker", "تم");
    const start = h.TG.outbox.length;
    await h.tgTap("broker", "draft_confirm");
    h.sameMoment();
    const again = await h.tgTap("broker", "draft_confirm");
    expect(again).toEqual([]);
    const toasts = h.TG.outbox.slice(start).filter((e) => e.method === "answerCallbackQuery");
    expect(toasts.map((e) => e.text)).toEqual(["", "✅ وصلت، مش محتاج تضغط تاني"]);
    expect(await h.query("SELECT id FROM listings")).toHaveLength(1);
  });

  test("WhatsApp brokers get the working-on-it line before the card too, without using message credits", async () => {
    h.AI.respond((call) => (call.operation === "listing_extraction" ? fields : { intent: "search", filters: {}, locations: [], location_terms: [] }));
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة في ميفيدا");
    const out = await h.text("broker", "تم");
    const working = out.findIndex((r) => /بنراجع بيانات الوحدة/.test(r.text || ""));
    const card = out.findIndex((r) => /ميفيدا|Mivida/.test(r.text || "") && (r.buttons || []).length);
    expect(working).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(working);
    expect(h.TG.outbox).toEqual([]);
    const logs = await h.query("SELECT operation_type, metadata FROM operation_logs WHERE operation_type = 'wa_progress'");
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata.egp).toBeUndefined();
  });
});

describe("onboarding and cleanup (step 6)", () => {
  test("start links for every active broker of the agency, each usable once", async () => {
    expect(await TgLink.startLinksForAgency(h.pool, h.AGENCY_A, "")).toEqual([]);
    const links = await TgLink.startLinksForAgency(h.pool, h.AGENCY_A, "Wehdat_Hub_bot");
    expect(links.length).toBeGreaterThan(1);
    expect(links[0].url).toMatch(/^https:\/\/t\.me\/Wehdat_Hub_bot\?start=[A-Za-z0-9_-]{32}$/);
    const out = await h.tg(6100, { text: `/start ${links[0].url.split("start=")[1]}` });
    expect(texts(out)).toMatch(/✅/);
  });

  test("the privacy job drops old callback tokens and spent start-link tokens", async () => {
    await TgLink.issueLinkToken(h.pool, h.BROKERS.broker);
    await h.query("UPDATE telegram_link_tokens SET expires_at = NOW() - INTERVAL '2 days'");
    await h.query("INSERT INTO telegram_callbacks (token, data, created_at) VALUES ('~old', 'x', NOW() - INTERVAL '31 days'), ('~new', 'y', NOW())");
    const { privacyJob } = require("../../services/privacy");
    const r = await privacyJob().run({ pool: h.pool, now: new Date() });
    expect(r.counts.telegram_purged).toBe(2);
    expect(await h.query("SELECT token FROM telegram_callbacks")).toEqual([{ token: "~new" }]);
  });
});

describe("pieces", () => {
  test("button ids over 64 bytes get a short stored token that decodes back", async () => {
    const long = `ld:undoset:${"1234567890-".repeat(8)}`;
    const data = await TgLink.encodeCallback(h.pool, long);
    expect(data).toMatch(/^~/);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(await TgLink.decodeCallback(h.pool, data)).toBe(long);
    expect(await TgLink.encodeCallback(h.pool, "ld:save:abc")).toBe("ld:save:abc");
    expect(await TgLink.decodeCallback(h.pool, "~unknown")).toBeNull();
  });

  test("WhatsApp formatting becomes escaped Telegram HTML", () => {
    expect(Fmt.toHtml("*مرحبا* <x> & _italic_ ~old~ code_name_here 5*3")).toBe("<b>مرحبا</b> &lt;x&gt; &amp; <i>italic</i> <s>old</s> code_name_here 5*3");
    expect(Fmt.toHtml("```a<b```")).toBe("<pre>a&lt;b</pre>");
  });

  test("tg: media ids download from Telegram, others from WhatsApp", async () => {
    h.TG.files.set("FILE1", { buffer: Buffer.from("x"), mimeType: "audio/ogg" });
    h.WA.media.set("wa1", { buffer: Buffer.from("y"), mimeType: "image/jpeg" });
    expect((await Media.download("tg:FILE1")).buffer.toString()).toBe("x");
    expect((await Media.download("wa1")).buffer.toString()).toBe("y");
  });
});
