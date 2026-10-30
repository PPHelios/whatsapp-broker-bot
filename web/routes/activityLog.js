// web/routes/activityLog.js — The activity log page for managers and the agency owner (services/activityLog.js).
"use strict";

const ActivityLog = require("../../services/activityLog");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);

function register(web, { pool, page }) {
  web.get("/activity-log", async (req, res, next) => {
    const { broker } = req.session;
    const lang = broker.preferred_lang === "en" ? "en" : "ar";
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const log = await ActivityLog.list(pool, broker, { offset: n * ActivityLog.PAGE });
    if (!log) return next();
    return page(req, res, {
      title: L(lang, "سجل النشاط", "Activity log"),
      nav: "notifications",
      body: html`<h1>🗂️ ${L(lang, "سجل النشاط", "Activity log")}</h1>
<p class="muted">${L(lang, `طلبات البيانات الخاصة والردود عليها، وتنزيل الوحدات. بيتحفظ ${ActivityLog.KEEP_DAYS} يوم.`, `Requests for private details and the answers, and unit exports. Kept ${ActivityLog.KEEP_DAYS} days.`)}</p>
<table data-activity-log>
<thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "مين", "Who")}</th><th>${L(lang, "إيه اللي حصل", "What happened")}</th></tr></thead>
<tbody>${log.rows.map((r) => html`<tr data-log="${r.id}"><td>${new Date(r.created_at).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td>${r.broker_name || ""}</td><td>${ActivityLog.describe(r, lang)}</td></tr>`)}</tbody>
</table>
<p class="row">${n > 0 ? html`<a href="/app/activity-log?page=${n - 1}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${log.more ? html`<a href="/app/activity-log?page=${n + 1}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`
    });
  });
}

module.exports = { register };
