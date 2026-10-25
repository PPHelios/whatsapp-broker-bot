// web/routes/notifications.js — The website inbox (every notification, silently) and the managers' notification log
"use strict";

const Notifications = require("../../lib/notifications");
const { MANAGER_ROLES } = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const isManager = (b) => MANAGER_ROLES.includes(String(b.role || "").toLowerCase());
const PAGE = 20;
const when = (d) => new Date(d).toISOString().slice(0, 16).replace("T", " ");

const CHANNEL = {
  whatsapp: ["واتساب", "WhatsApp"],
  webpush: ["إشعار الموقع", "Web push"],
  inbox: ["الصندوق بس", "Inbox only"]
};
const REASON = {
  chosen: ["اختيارك", "your choice"],
  fallback: ["واتساب فشل", "WhatsApp failed"],
  no_credits: ["الرصيد خلص", "no credits"],
  window_closed: ["نافذة الـ24 ساعة مقفولة", "24-hour window closed"],
  quiet_hours: ["ساعات الهدوء", "quiet hours"],
  merged: ["متجمعة مع غيرها", "merged"],
  no_push: ["الإشعارات مش مفعلة", "push not enabled"]
};
const pick = (map, key, lang) => (map[key] ? map[key][lang === "en" ? 1 : 0] : key || "—");

function register(web, { pool, page }) {
  web.get("/notifications", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const { rows, more } = await Notifications.listInbox(pool, broker, { limit: PAGE, offset: n * PAGE });
    return page(req, res, {
      title: L(lang, "التنبيهات", "Notifications"),
      nav: "notifications",
      body: html`<h1>🔔 ${L(lang, "التنبيهات", "Notifications")}</h1>
<div class="row">
  <form method="post" action="/app/notifications/read-all"><button type="submit" class="secondary">${L(lang, "✓ علّم الكل مقروء", "✓ Mark all read")}</button></form>
  <a class="btn secondary" href="/app/settings">${L(lang, "⚙️ اختار القناة لكل تنبيه", "⚙️ Choose the channel per alert")}</a>
  ${isManager(broker) ? html`<a class="btn secondary" href="/app/notifications/log">${L(lang, "📋 سجل التنبيهات", "📋 Notification log")}</a>` : ""}
</div>
${rows.length
  ? html`<ul class="inbox">${rows.map(
      (r) => html`<li class="card${r.read_at ? "" : " unread"}" data-notification="${r.id}">
  <strong>${r.title}</strong>${r.body ? html`<div class="pre">${r.body}</div>` : ""}
  <div class="muted">${when(r.created_at)} · ${pick(CHANNEL, r.channel || "inbox", lang)}</div>
  ${r.url
    ? html`<form method="post" action="/app/notifications/${r.id}/open"><button type="submit" class="link">${L(lang, "افتح", "Open")}</button></form>`
    : !r.read_at
      ? html`<form method="post" action="/app/notifications/${r.id}/read"><button type="submit" class="link">${L(lang, "تم", "Mark read")}</button></form>`
      : ""}
</li>`
    )}</ul>
<p class="row">${n > 0 ? html`<a href="/app/notifications?page=${n - 1}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${more ? html`<a href="/app/notifications?page=${n + 1}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`
  : html`<p class="card">${L(lang, "مفيش تنبيهات لسه. التنبيهات بتتجمع هنا دايماً، حتى اللي وصلتك على واتساب.", "No notifications yet. Every alert lands here, even the ones you got on WhatsApp.")}</p>`}`
    });
  });

  // Opening marks read and goes to the notification's page (always an /app/ path).
  web.post("/notifications/:id/open", async (req, res) => {
    const r = await Notifications.markRead(pool, req.session.broker, req.params.id);
    if (!r) return res.redirect(303, "/app/notifications");
    return res.redirect(303, r.url && r.url.startsWith("/app/") ? r.url : "/app/notifications");
  });

  web.post("/notifications/:id/read", async (req, res) => {
    await Notifications.markRead(pool, req.session.broker, req.params.id);
    return res.redirect(303, "/app/notifications");
  });

  web.post("/notifications/read-all", async (req, res) => {
    await Notifications.markRead(pool, req.session.broker, "all");
    return res.redirect(303, "/app/notifications");
  });

  web.get("/notifications/log", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send(L(lang, "للمديرين بس.", "Managers only."));
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const log = await Notifications.agencyLog(pool, broker, { limit: 50, offset: n * 50 });
    return page(req, res, {
      title: L(lang, "سجل التنبيهات", "Notification log"),
      nav: "notifications",
      body: html`<h1>📋 ${L(lang, "سجل التنبيهات", "Notification log")}</h1>
<p class="muted">${L(lang, "كل تنبيه: مين استلمه، على أي قناة، وليه، واتبعت ولا لأ.", "Every alert: who got it, on which channel, why, and whether it went out.")}</p>
<table>
<thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "الوسيط", "Broker")}</th><th>${L(lang, "التنبيه", "Alert")}</th><th>${L(lang, "القناة", "Channel")}</th><th>${L(lang, "السبب", "Why")}</th><th>${L(lang, "الحالة", "Status")}</th></tr></thead>
<tbody>${log.rows.map(
        (r) => html`<tr data-log="${r.id}"><td>${when(r.created_at)}</td><td>${r.broker_name}</td><td>${r.title}</td><td>${pick(CHANNEL, r.channel || "inbox", lang)}</td><td>${pick(REASON, r.reason, lang)}</td><td>${r.status}</td></tr>`
      )}</tbody>
</table>
<p class="row">${n > 0 ? html`<a href="/app/notifications/log?page=${n - 1}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${log.more ? html`<a href="/app/notifications/log?page=${n + 1}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`
    });
  });
}

module.exports = { register };
