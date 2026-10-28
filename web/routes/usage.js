// web/routes/usage.js — "My usage": WhatsApp message credits this month (mine, the agency's; managers: per broker, caps)
"use strict";

const Credits = require("../../lib/credits");
const UnitCode = require("../../domain/unitCode");
const { MANAGER_ROLES } = require("../../lib/authz");
const AiLog = require("../../services/aiUsageLog");
const Dash = require("../../services/dashboards");
const { html } = require("../html");
const { tabs } = require("../views/tabs");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const isManager = (b) => MANAGER_ROLES.includes(String(b.role || "").toLowerCase());

const ACTIONS = {
  search: ["بحث", "Search"],
  add_unit: ["إضافة وحدة", "Add a unit"],
  edit: ["تعديل", "Edit"],
  quick_update: ["تحديث سريع", "Quick update"],
  flyer: ["بروشور", "Flyer"],
  client_copy: ["نص العميل", "Client copy"],
  crm: ["العملاء", "Clients (CRM)"],
  notification: ["تنبيهات", "Notifications"],
  other: ["أخرى", "Other"]
};
const actionLabel = (a, lang) => (ACTIONS[a] || ACTIONS.other)[lang === "en" ? 1 : 0];
const optInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** F24: the AI use log with its filters and the Excel link. base = the page's path. */
function aiLogPage(lang, log, filters, base, title) {
  const q = (extra = {}) => {
    const p = new URLSearchParams(Object.entries({ month: log.month, broker: filters.brokerId || "", feature: filters.feature || "", ...extra }).filter(([, v]) => v));
    return p.toString();
  };
  const KIND = { text: ["نص", "Text"], voice: ["فويس", "Voice"], page: ["صفحة", "Page"] };
  return html`<h1>🤖 ${title}</h1>
<form method="get" action="${base}" class="card row" data-ai-log-filter>
  <label>${L(lang, "الشهر", "Month")} <input type="month" name="month" value="${log.month}" dir="ltr"></label>
  <label>${L(lang, "المستخدم", "User")} <select name="broker"><option value="">${L(lang, "الكل", "Everyone")}</option>${log.brokers.map((b) => html`<option value="${b.id}"${filters.brokerId === b.id ? html` selected` : ""}>${b.name}</option>`)}</select></label>
  <label>${L(lang, "الخاصية", "Feature")} <select name="feature"><option value="">${L(lang, "الكل", "All")}</option>${log.features.map((f) => html`<option value="${f}"${filters.feature === f ? html` selected` : ""}>${AiLog.featureLabel(f, lang)}</option>`)}</select></label>
  <button type="submit" class="secondary">${L(lang, "عرض", "Show")}</button>
  <a class="btn secondary" href="${base}.xlsx?${q()}" data-ai-log-export>⬇️ ${L(lang, "إكسيل", "Excel")}</a>
</form>
<section class="card">
  <p data-ai-log-totals>${L(lang, `نص: ${log.totals.text} · فويس: ${log.totals.voice} · صفحات: ${log.totals.page} · صفحات ببلاش: ${log.totals.free}`, `Text: ${log.totals.text} · Voice: ${log.totals.voice} · Pages: ${log.totals.page} · Free pages: ${log.totals.free}`)}</p>
  <p class="muted">${L(lang, "النص والفويس من رصيد الباقة الشهري؛ الصفحات من صفحات قراءة الملفات. الصفحة اللي اتقرت قبل كده (لأي وكالة) ببلاش.", "Text and voice count against the plan's monthly allowance; pages against the document pages. A page read before (by any agency) is free.")}</p>
  ${log.rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "المستخدم", "User")}</th><th>${L(lang, "الخاصية", "Feature")}</th><th>${L(lang, "اتحسب من", "Counted as")}</th></tr></thead>
  <tbody>${log.rows.map((r) => html`<tr data-ai-row="${r.feature}"><td dir="ltr">${AiLog.cairoTime(r.at)}</td><td>${r.broker}</td><td>${AiLog.featureLabel(r.feature, lang)}</td><td>${KIND[r.kind][lang === "en" ? 1 : 0]}${r.free ? L(lang, " (ببلاش)", " (free)") : ""}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش استهلاك في الفترة دي.", "No use in this period.")}</p>`}
</section>`;
}

function register(web, { pool, page }) {
  // F24: managers see their agency's AI log; the app owner any agency's (/app/owner links here).
  const logFor = async (req, res, agencyId, base, title, xlsx) => {
    const lang = langOf(req);
    const filters = AiLog.filtersOf(req.query);
    const log = await AiLog.list(pool, agencyId, filters);
    if (xlsx) {
      return res
        .set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="ai-usage-${log.month}.xlsx"` })
        .send(await AiLog.workbook(log, lang));
    }
    return page(req, res, { title, nav: "settings", body: aiLogPage(lang, log, filters, base, title) });
  };
  for (const xlsx of [false, true]) {
    web.get(`/usage/log${xlsx ? ".xlsx" : ""}`, (req, res) => {
      const { broker } = req.session;
      if (!isManager(broker)) return res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
      return logFor(req, res, broker.agency_id, "/app/usage/log", L(langOf(req), "سجل استهلاك الذكاء الاصطناعي", "AI usage log"), xlsx);
    });
    web.get(`/owner/agencies/:id/ai-log${xlsx ? ".xlsx" : ""}`, async (req, res) => {
      if (!Dash.isOwner(req.session.broker) || !/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).type("text/plain").send("Not found");
      const { rows } = await pool.query("SELECT name FROM agencies WHERE id = $1", [req.params.id]);
      if (!rows[0]) return res.status(404).type("text/plain").send("Not found");
      return logFor(req, res, req.params.id, `/app/owner/agencies/${req.params.id}/ai-log`, `${L(langOf(req), "استهلاك الذكاء الاصطناعي", "AI usage")}: ${rows[0].name}`, xlsx);
    });
  }

  web.get("/usage", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const state = await Credits.check(pool, broker);
    const mine = await Credits.usage(pool, broker.agency_id, { brokerId: broker.id });
    const agency = manager ? await Credits.usage(pool, broker.agency_id) : null;
    const own = manager ? (await pool.query("SELECT name, code_prefix, crm_settings FROM agencies WHERE id = $1", [broker.agency_id])).rows[0] : null;
    const codePrefix = own ? own.code_prefix || UnitCode.prefixFrom(own.name) : "";
    const aiPhotos = own?.crm_settings?.ai_photo_order !== false;
    const cls = state.level === "ok" ? "" : state.level === "warn" ? "warn" : "bad";
    const mineCard = html`<section class="card">
  <h2>${L(lang, "رسايلي", "My messages")}</h2>
  <p>${L(lang, `النهارده: ${mine.today} · الشهر ده: ${mine.total}`, `Today: ${mine.today} · This month: ${mine.total}`)}</p>
  ${mine.actions.length
    ? html`<table><thead><tr><th>${L(lang, "العملية", "Action")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${mine.actions.map((a) => html`<tr data-action="${a.action}"><td>${actionLabel(a.action, lang)}</td><td>${a.today}</td><td>${a.n}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">${L(lang, "مفيش رسايل الشهر ده.", "No messages this month.")}</p>`}
  <p class="muted">${L(lang, "نصيحة: البحث الطويل والإضافة والاستيراد ببلاش على الموقع.", "Tip: long searches, adding units and imports are free on the website.")}</p>
</section>`;
    return page(req, res, {
      title: L(lang, "الاستهلاك", "Usage"),
      nav: "settings",
      body: html`<h1>${L(lang, "الاستهلاك", "Usage")}</h1>
${req.query.saved === "1" ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>` : ""}
<section class="card usage-hero" data-credits-used="${state.used}" data-credits-limit="${state.limit}" data-level="${state.level}">
  <h2>${L(lang, "رصيد رسايل واتساب للوكالة (الشهر ده)", "Agency WhatsApp credits (this month)")}</h2>
  <meter class="${cls}" min="0" max="${state.limit}" low="${Math.round(state.limit * 0.8)}" high="${state.limit}" value="${Math.min(state.used, state.limit)}">${state.pct}%</meter>
  <p class="big"><strong>${state.used}</strong> / ${state.limit} · ${L(lang, `باقي ${state.remaining}`, `${state.remaining} left`)} (${state.pct}%)</p>
  <details class="how"><summary>${L(lang, "الرصيد بيتحسب إزاي؟", "How credits work")}</summary><p class="muted">${L(
    lang,
    "١ رصيد = ١ رسالة البوت يبعتها (ردود وتنبيهات). ببلاش: كل حاجة على الموقع، إشعارات الموقع، وعلامة «اتقرت». عند 100% التنبيهات بتوصل على الموقع والردود مستمرة؛ عند الحد الأقصى البوت بيبعت تنبيه واحد في اليوم وبعدها بيعلّم الرسايل مقروءة بس.",
    "1 credit = 1 message the bot sends (replies and alerts). Free: everything on the website, website notifications and read ticks. At 100% alerts move to the website and replies continue; at the ceiling the bot sends one notice a day, then only marks messages as read."
  )}</p></details>
</section>
${manager
  ? tabs("usage_tab", [
      [L(lang, "أنا", "Me"), mineCard],
      [L(lang, "الفريق", "Team"), html`<section class="card">
  <h2>${L(lang, "كل الوسطاء", "Every broker")}</h2>
  <table><thead><tr><th>${L(lang, "الوسيط", "Broker")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${agency.brokers.map((b) => html`<tr data-broker="${b.id}"><td>${b.name}</td><td>${b.today}</td><td>${b.n}</td></tr>`)}</tbody></table>
  <p class="muted">${L(lang, `روابط الدخول (مش محسوبة من الرصيد): ${agency.login}`, `Sign-in links (not counted in the credits): ${agency.login}`)}</p>
</section>`],
      [L(lang, "الإعدادات", "Settings"), html`<form method="post" action="/app/usage/agency" class="card stack">
  <h2>${L(lang, "رصيد الوكالة وحدود الوسطاء", "Agency credits and broker caps")}</h2>
  <label>${L(lang, "الرصيد الشهري (رسايل)", "Monthly credits (messages)")} <input type="number" name="monthly" min="0" max="100000" value="${state.limit}"></label>
  <label>${L(lang, "حد يومي لكل وسيط (فاضي = بدون حد)", "Daily cap per broker (empty = off)")} <input type="number" name="daily_cap" min="1" max="10000" value="${state.broker.dailyCap ?? ""}"></label>
  <label>${L(lang, "حد أسبوعي لكل وسيط (فاضي = بدون حد)", "Weekly cap per broker (empty = off)")} <input type="number" name="weekly_cap" min="1" max="50000" value="${state.broker.weeklyCap ?? ""}"></label>
  <label>${L(lang, "حروف أكواد الوحدات (مثال NH ← NH-V12)", "Unit code letters (e.g. NH → NH-V12)")} <input name="code_prefix" maxlength="4" pattern="[A-Za-z]{1,4}" dir="ltr" value="${codePrefix}"></label>
  <p class="muted">${L(lang, "للوحدات اللي بتتضاف من غير كود. الأكواد القديمة مش بتتغير.", "For units added without a code. Existing codes don't change.")}</p>
  <label class="row"><input type="checkbox" name="ai_photo_order" value="on"${aiPhotos ? html` checked` : ""} data-ai-photo-order> ${L(lang, "الذكاء الاصطناعي يرتب صور الوحدات ويخفي المستندات", "AI orders unit photos and hides documents")}</label>
  <p class="muted">${L(lang, "لو قفلته بتوفر رصيد: الصور بتفضل بالترتيب اللي اتبعتت بيه، وتقدر ترتبها بإيدك من تعديل الوحدة.", "Off saves credits: photos keep the order they were sent in, and you can order them by hand when editing a unit.")}</p>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>
</form>
<p class="card"><a href="/app/usage/log" data-ai-log-link>🤖 ${L(lang, "سجل استهلاك الذكاء الاصطناعي (سطر بسطر، مع تصدير إكسيل)", "AI usage log (line by line, with Excel export)")}</a></p>`]
    ], { open: req.query.saved === "1" ? 2 : 0 })
  : mineCard}`
    });
  });

  web.post("/usage/agency", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send("Managers only");
    const monthly = parseInt(req.body.monthly, 10);
    // A prefix that isn't 1–4 Latin letters keeps the current one.
    await pool.query(
      `UPDATE agencies SET wa_credits_monthly = $2, wa_broker_daily_cap = $3, wa_broker_weekly_cap = $4, code_prefix = COALESCE($5, code_prefix),
              crm_settings = crm_settings || jsonb_build_object('ai_photo_order', $6::boolean) WHERE id = $1`,
      [broker.agency_id, Number.isInteger(monthly) && monthly >= 0 && monthly <= 100000 ? monthly : null, optInt(req.body.daily_cap), optInt(req.body.weekly_cap), UnitCode.cleanPrefix(req.body.code_prefix), req.body.ai_photo_order === "on"]
    );
    return res.redirect(303, "/app/usage?saved=1");
  });
}

module.exports = { register };
