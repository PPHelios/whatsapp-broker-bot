// web/routes/usage.js — "My usage": WhatsApp message credits this month (mine, the agency's; managers: per broker, caps)
"use strict";

const Credits = require("../../lib/credits");
const { MANAGER_ROLES } = require("../../lib/authz");
const { html } = require("../html");

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

function register(web, { pool, page }) {
  web.get("/usage", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const state = await Credits.check(pool, broker);
    const mine = await Credits.usage(pool, broker.agency_id, { brokerId: broker.id });
    const agency = manager ? await Credits.usage(pool, broker.agency_id) : null;
    const cls = state.level === "ok" ? "" : state.level === "warn" ? "warn" : "bad";
    return page(req, res, {
      title: L(lang, "استهلاكي", "My usage"),
      nav: "settings",
      body: html`<h1>📊 ${L(lang, "استهلاكي", "My usage")}</h1>
${req.query.saved === "1" ? html`<p class="card notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>` : ""}
<section class="card" data-credits-used="${state.used}" data-credits-limit="${state.limit}" data-level="${state.level}">
  <h2>${L(lang, "رصيد رسايل واتساب للوكالة (الشهر ده)", "Agency WhatsApp credits (this month)")}</h2>
  <meter class="${cls}" min="0" max="${state.limit}" low="${Math.round(state.limit * 0.8)}" high="${state.limit}" value="${Math.min(state.used, state.limit)}">${state.pct}%</meter>
  <p><strong>${state.used}</strong> / ${state.limit} · ${L(lang, `باقي ${state.remaining}`, `${state.remaining} left`)} (${state.pct}%)</p>
  <p class="muted">${L(
    lang,
    "١ رصيد = ١ رسالة البوت يبعتها (ردود وتنبيهات). ببلاش: كل حاجة على الموقع، إشعارات الموقع، وعلامة «اتقرت». عند 100% التنبيهات بتوصل على الموقع والردود مستمرة؛ عند الحد الأقصى البوت بيبعت تنبيه واحد في اليوم وبعدها بيعلّم الرسايل مقروءة بس.",
    "1 credit = 1 message the bot sends (replies and alerts). Free: everything on the website, website notifications and read ticks. At 100% alerts move to the website and replies continue; at the ceiling the bot sends one notice a day, then only marks messages as read."
  )}</p>
</section>
<section class="card">
  <h2>${L(lang, "رسايلي", "My messages")}</h2>
  <p>${L(lang, `النهارده: ${mine.today} · الشهر ده: ${mine.total}`, `Today: ${mine.today} · This month: ${mine.total}`)}</p>
  ${mine.actions.length
    ? html`<table><thead><tr><th>${L(lang, "العملية", "Action")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${mine.actions.map((a) => html`<tr data-action="${a.action}"><td>${actionLabel(a.action, lang)}</td><td>${a.today}</td><td>${a.n}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">${L(lang, "مفيش رسايل الشهر ده.", "No messages this month.")}</p>`}
  <p class="muted">${L(lang, "نصيحة: البحث الطويل والإضافة والاستيراد ببلاش على الموقع.", "Tip: long searches, adding units and imports are free on the website.")}</p>
</section>
${manager
  ? html`<section class="card">
  <h2>${L(lang, "كل الوسطاء", "Every broker")}</h2>
  <table><thead><tr><th>${L(lang, "الوسيط", "Broker")}</th><th>${L(lang, "النهارده", "Today")}</th><th>${L(lang, "الشهر", "Month")}</th></tr></thead>
  <tbody>${agency.brokers.map((b) => html`<tr data-broker="${b.id}"><td>${b.name}</td><td>${b.today}</td><td>${b.n}</td></tr>`)}</tbody></table>
  <p class="muted">${L(lang, `روابط الدخول (مش محسوبة من الرصيد): ${agency.login}`, `Sign-in links (not counted in the credits): ${agency.login}`)}</p>
</section>
<form method="post" action="/app/usage/agency" class="card stack">
  <h2>${L(lang, "رصيد الوكالة وحدود الوسطاء", "Agency credits and broker caps")}</h2>
  <label>${L(lang, "الرصيد الشهري (رسايل)", "Monthly credits (messages)")} <input type="number" name="monthly" min="0" max="100000" value="${state.limit}"></label>
  <label>${L(lang, "حد يومي لكل وسيط (فاضي = بدون حد)", "Daily cap per broker (empty = off)")} <input type="number" name="daily_cap" min="1" max="10000" value="${state.broker.dailyCap ?? ""}"></label>
  <label>${L(lang, "حد أسبوعي لكل وسيط (فاضي = بدون حد)", "Weekly cap per broker (empty = off)")} <input type="number" name="weekly_cap" min="1" max="50000" value="${state.broker.weeklyCap ?? ""}"></label>
  <button type="submit">${L(lang, "حفظ", "Save")}</button>
</form>`
  : ""}`
    });
  });

  web.post("/usage/agency", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send("Managers only");
    const monthly = parseInt(req.body.monthly, 10);
    await pool.query(
      "UPDATE agencies SET wa_credits_monthly = $2, wa_broker_daily_cap = $3, wa_broker_weekly_cap = $4 WHERE id = $1",
      [broker.agency_id, Number.isInteger(monthly) && monthly >= 0 && monthly <= 100000 ? monthly : null, optInt(req.body.daily_cap), optInt(req.body.weekly_cap)]
    );
    return res.redirect(303, "/app/usage?saved=1");
  });
}

module.exports = { register };
