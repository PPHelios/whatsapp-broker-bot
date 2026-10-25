// web/routes/settings.js — A broker's settings: language, channel per notification kind, quiet hours, web push
"use strict";

const Notifications = require("../../lib/notifications");
const WebPush = require("../../lib/channels/webpush");
const { getConfig } = require("../../config");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

async function loadBroker(pool, broker) {
  const { rows } = await pool.query("SELECT notify_prefs, telegram_chat_id FROM brokers WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
  return { ...broker, notify_prefs: rows[0]?.notify_prefs || {}, telegram_chat_id: rows[0]?.telegram_chat_id || null };
}

function register(web, { pool, page }) {
  web.get("/settings", async (req, res) => {
    const lang = langOf(req);
    const broker = await loadBroker(pool, req.session.broker);
    const tgOn = getConfig().telegram.enabled;
    const prefs = Notifications.prefsOf(broker, { telegramLinked: tgOn && Boolean(broker.telegram_chat_id) });
    const opt = (k, v, label) => html`<option value="${v}"${prefs.channels[k] === v ? html` selected` : ""}>${label}</option>`;
    const pushes = await Notifications.pushCount(pool, broker);
    const key = getConfig().webPush.publicKey;
    const saved = req.query.saved === "1";
    const pushed = req.query.test;
    return page(req, res, {
      title: L(lang, "الإعدادات", "Settings"),
      nav: "settings",
      body: html`<h1>⚙️ ${L(lang, "الإعدادات", "Settings")}</h1>
${saved ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>` : ""}
${pushed === "ok" ? html`<p class="card notice ok" role="status">🔔 ${L(lang, "اتبعت إشعار تجربة.", "Test notification sent.")}</p>` : ""}
${pushed === "none" ? html`<p class="card notice bad" role="status">${L(lang, "الإشعارات مش مفعلة على أي جهاز لسه.", "Notifications aren't on in any browser yet.")}</p>` : ""}
<form method="post" action="/app/settings" class="card stack">
  <h2>🌐 ${L(lang, "اللغة", "Language")}</h2>
  <label>${L(lang, "لغة الموقع ورسايل البوت", "Website and bot language")}
    <select name="lang"><option value="ar"${lang === "ar" ? html` selected` : ""}>العربية</option><option value="en"${lang === "en" ? html` selected` : ""}>English</option></select>
  </label>
  <h2>🔔 ${L(lang, "التنبيهات توصلك فين؟", "Where do alerts reach you?")}</h2>
  <p class="muted">${L(
    lang,
    "واتساب بيستخدم رصيد رسايل الوكالة؛ الموقع ببلاش. لما رصيد واتساب يخلص أو نافذة الـ24 ساعة تتقفل، التنبيه بيوصل على الموقع. التنبيه بيوصل على قناة واحدة بس، وكله بيتسجل في 🔔.",
    "WhatsApp uses your agency's message credits; the website is free. When the credits run out or the 24-hour window closes, alerts come on the website. Each alert comes on one channel only, and all of them are kept in 🔔."
  )}</p>
  ${Notifications.KINDS.map(
    (k) => html`<label>${Notifications.KIND_LABELS[k][lang === "en" ? 1 : 0]}
    <select name="ch_${k}" data-kind="${k}">${tgOn ? opt(k, "telegram", L(lang, "تليجرام (ببلاش)", "Telegram (free)")) : ""}${opt(k, "web", L(lang, "الموقع (ببلاش)", "Website (free)"))}${opt(k, "whatsapp", L(lang, "واتساب (من الرصيد)", "WhatsApp (uses credits)"))}</select>
  </label>`
  )}
  <h2>🌙 ${L(lang, "ساعات الهدوء (بتوقيت القاهرة)", "Quiet hours (Cairo time)")}</h2>
  <label class="check"><input type="checkbox" name="quiet_on" value="1"${prefs.quiet.enabled ? html` checked` : ""}> ${L(lang, "متبعتليش تنبيهات في الوقت ده (بتتجمع وتوصل بعده)", "Hold alerts during these hours (they arrive together after)")}</label>
  <div class="row">
    <label>${L(lang, "من", "From")} <select name="quiet_start">${HOURS.map((h) => html`<option value="${h}"${h === prefs.quiet.start ? html` selected` : ""}>${hh(h)}</option>`)}</select></label>
    <label>${L(lang, "لحد", "Until")} <select name="quiet_end">${HOURS.map((h) => html`<option value="${h}"${h === prefs.quiet.end ? html` selected` : ""}>${hh(h)}</option>`)}</select></label>
  </div>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>
</form>
<section class="card" id="push" data-vapid="${key}" data-push-count="${pushes}">
  <h2>📲 ${L(lang, "إشعارات الموقع على الجهاز ده", "Website notifications on this device")}</h2>
  <p>${pushes
    ? L(lang, `مفعلة على ${pushes} جهاز.`, `On in ${pushes} browser(s).`)
    : L(lang, "مش مفعلة لسه.", "Not on yet.")}</p>
  ${key
    ? html`<div class="row">
    <button type="button" data-push="enable">${L(lang, "🔔 فعّل الإشعارات هنا", "🔔 Turn on here")}</button>
    <button type="button" class="secondary" data-push="disable">${L(lang, "إيقاف هنا", "Turn off here")}</button>
  </div>
  <p class="muted" data-push-status></p>`
    : html`<p class="muted">${L(lang, "الإشعارات لسه مش متجهزة على السيرفر.", "Push isn't configured on the server yet.")}</p>`}
  <form method="post" action="/app/push/test"><button type="submit" class="secondary">${L(lang, "ابعت إشعار تجربة", "Send a test notification")}</button></form>
  <p class="muted">${L(
    lang,
    "آيفون: افتح الموقع من Safari ← زرار المشاركة ← «إضافة إلى الشاشة الرئيسية»، وبعدين افتحه من الأيقونة وفعّل الإشعارات.",
    "iPhone: open the site in Safari → Share → \"Add to Home Screen\", then open it from the icon and turn notifications on."
  )}</p>
</section>`
    });
  });

  web.post("/settings", async (req, res) => {
    const { broker } = req.session;
    const channels = {};
    for (const k of Notifications.KINDS) channels[k] = req.body[`ch_${k}`];
    await Notifications.savePrefs(pool, broker, {
      channels,
      quiet: { enabled: req.body.quiet_on === "1", start: req.body.quiet_start, end: req.body.quiet_end }
    });
    const lang = req.body.lang === "en" ? "en" : "ar";
    if (lang !== broker.preferred_lang) {
      await pool.query("UPDATE brokers SET preferred_lang = $3 WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id, lang]);
    }
    return res.redirect(303, "/app/settings?saved=1");
  });

  // From the browser's PushManager (web/static/app.js): endpoint and keys as form fields.
  web.post("/push/subscribe", async (req, res) => {
    const ok = await Notifications.savePushSubscription(
      pool,
      req.session.broker,
      { endpoint: req.body.endpoint, keys: { p256dh: req.body.p256dh, auth: req.body.auth } },
      req.get("User-Agent") || ""
    );
    return res.status(ok ? 204 : 400).end();
  });

  web.post("/push/unsubscribe", async (req, res) => {
    await Notifications.removePushSubscription(pool, req.session.broker, req.body.endpoint);
    return res.status(204).end();
  });

  web.post("/push/test", async (req, res) => {
    const { broker } = req.session;
    const en = broker.preferred_lang === "en";
    const r = await WebPush.send(broker, { title: en ? "🔔 WehdatHub test" : "🔔 تجربة WehdatHub", url: "/app/notifications", push: { body: en ? "Notifications work on this device." : "الإشعارات شغالة على الجهاز ده." } }, { pool });
    return res.redirect(303, `/app/settings?test=${r.ok ? "ok" : "none"}`);
  });
}

module.exports = { register };
