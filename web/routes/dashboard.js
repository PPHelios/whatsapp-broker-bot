// web/routes/dashboard.js — The agency dashboard and leaderboard (7.2, managers: /app/dashboard) and the owner's tracking
// dashboard (5.4, OWNER_BROKER_IDS only: /app/owner; everyone else gets the ordinary 404). Numbers only: no client's name
// or phone appears on either page. Queries live in services/dashboards.js.
"use strict";

const Dash = require("../../services/dashboards");
const Stages = require("../../domain/leadStages");
const Commission = require("../../domain/commission");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => Commission.money(n, lang);
const minutes = (m, lang) => {
  if (m === null || m === undefined) return "—";
  if (m < 60) return L(lang, `${m} د`, `${m} min`);
  if (m < 48 * 60) return L(lang, `${Math.round(m / 60)} س`, `${Math.round(m / 60)} h`);
  return L(lang, `${Math.round(m / 1440)} يوم`, `${Math.round(m / 1440)} d`);
};
const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}`;
const notFound = (req, res, page) =>
  page(req, res, { title: L(langOf(req), "غير موجود", "Not found"), body: html`<div class="card"><h1>🔍 ${L(langOf(req), "الصفحة غير موجودة", "Page not found")}</h1><p><a href="/app/">${L(langOf(req), "الرئيسية", "Home")}</a></p></div>` }, 404);

function agencyPage(d, lang) {
  const tile = (label, value, attr) => html`<div class="card tile" data-kpi="${attr}"><div class="muted">${label}</div><strong>${value}</strong></div>`;
  return html`<h1>📈 ${L(lang, "لوحة الوكالة", "Agency dashboard")}</h1>
<nav class="row" aria-label="${L(lang, "الفترة", "Period")}">${Dash.PERIODS.map(
    (p) => html`<a class="btn ${p === d.days ? "" : "secondary"}" href="/app/dashboard?days=${p}"${p === d.days ? html` aria-current="page"` : ""}>${L(lang, `${p} يوم`, `${p} days`)}</a>`
  )}</nav>
<div class="grid">
  ${tile(L(lang, "عملاء جداد", "New leads"), d.leads, "leads")}
  ${tile(L(lang, "صفقات", "Deals"), d.deals.n, "deals")}
  ${tile(L(lang, "العمولة", "Commission"), money(d.deals.commission, lang), "commission")}
  ${tile(L(lang, "لسه محدش كلمهم", "Not contacted yet"), d.uncontacted, "uncontacted")}
  ${tile(L(lang, "متابعات متأخرة", "Overdue follow-ups"), d.overdue, "overdue")}
  ${tile(L(lang, "من غير بروكر", "Unassigned"), d.unassigned, "unassigned")}
  ${tile(L(lang, "وحدات متاحة", "Active units"), d.units.active, "units")}
  ${tile(L(lang, "محتاجة تأكيد (21 يوم)", "To confirm (21 days)"), d.units.stale, "stale")}
</div>
<section class="card">
  <h2>${L(lang, "المراحل دلوقتي", "Pipeline now")}</h2>
  <table><tbody>${Stages.STAGES.map((s) => html`<tr data-stage="${s}"><td>${Stages.stageLabel(s, lang)}</td><td>${d.pipeline[s]}</td></tr>`)}</tbody></table>
</section>
<section class="card">
  <h2>🏆 ${L(lang, `ترتيب البروكرز (آخر ${d.days} يوم)`, `Leaderboard (last ${d.days} days)`)}</h2>
  ${d.board.length
    ? html`<div class="scroll"><table>
  <thead><tr><th>#</th><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "صفقات", "Deals")}</th><th>${L(lang, "عمولته", "Commission")}</th><th>${L(lang, "عملاء جداد", "New leads")}</th><th>${L(lang, "مكالمات", "Contacted")}</th><th>${L(lang, "تحريك للأمام", "Moved forward")}</th><th>${L(lang, "معاينات", "Viewings")}</th><th>${L(lang, "وحدات أضافها", "Units added")}</th><th>${L(lang, "وقت الرد", "Response time")}</th><th>${L(lang, "عملاء مفتوحين", "Open leads")}</th></tr></thead>
  <tbody>${d.board.map(
    (b, i) => html`<tr data-broker="${b.id}"><td>${medal(i)}</td><td>${b.name}</td><td>${b.deals}</td><td>${money(b.commission, lang)}</td><td>${b.leads}</td><td>${b.contacted}</td><td>${b.forward}</td><td>${b.viewings}</td><td>${b.units}</td><td>${minutes(b.responseMin, lang)}</td><td>${b.open}</td></tr>`
  )}</tbody></table></div>
  <p class="muted">${L(lang, "الترتيب: الصفقات، بعدين العمولة، بعدين التحريك للأمام. وقت الرد = الوسيط من وصول العميل لأول مكالمة.", "Ranked by deals, then commission, then moves forward. Response time = median from a lead arriving to its first contact.")}</p>`
    : html`<p class="muted">${L(lang, "مفيش نشاط في الفترة دي.", "No activity in this period.")}</p>`}
</section>`;
}

function ownerPage(d, lang) {
  const usd = (n) => `$${Number(n).toFixed(n < 1 ? 4 : 2)}`;
  return html`<h1>🛠️ ${L(lang, "متابعة التطبيق", "App tracking")}</h1>
<section class="card">
  <h2>${L(lang, "كل أسبوع", "Weekly")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الأسبوع", "Week")}</th><th>${L(lang, "وكالات نشطة", "Active agencies")}</th><th>${L(lang, "وسطاء نشطين", "Active brokers")}</th><th>${L(lang, "وحدات", "Units")}</th><th>${L(lang, "عملاء", "Leads")}</th><th>${L(lang, "صفقات", "Deals")}</th><th>${L(lang, "أخطاء", "Errors")}</th><th>${L(lang, "بلاغات", "Bug reports")}</th></tr></thead>
  <tbody>${d.weeks.map(
    (w) => html`<tr data-week="${w.week}"><td dir="ltr">${w.week}</td><td>${w.agencies}</td><td>${w.brokers}</td><td>${w.units}</td><td>${w.leads}</td><td>${w.deals}</td><td>${w.errors}</td><td>${w.reports}</td></tr>`
  )}</tbody></table></div>
  <p class="muted">${L(lang, "نشط = استخدم البوت أو الموقع في الأسبوع ده (الأسبوع بيبدأ الاتنين).", "Active = used the bot or the website that week (weeks start on Monday).")}</p>
</section>
<section class="card">
  <h2>${L(lang, "الذكاء الاصطناعي لكل وكالة (آخر 30 يوم)", "AI per agency (last 30 days)")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوكالة", "Agency")}</th><th>${L(lang, "وسطاء", "Brokers")}</th><th>Telegram</th><th>${L(lang, "طلبات AI", "AI calls")}</th><th>${L(lang, "فشلت", "Failed")}</th><th>${L(lang, "التكلفة", "Cost")}</th></tr></thead>
  <tbody>${d.agencies.map(
    (a) => html`<tr data-agency="${a.id}"><td>${a.name}</td><td>${a.brokers ?? 0}</td><td>${a.telegram ?? 0}</td><td>${a.calls}</td><td>${a.failed}</td><td dir="ltr">${usd(a.usd)}</td></tr>`
  )}</tbody>
  <tfoot><tr><td colspan="5">${L(lang, "الإجمالي", "Total")}</td><td dir="ltr" data-total-usd="${d.totalUsd.toFixed(4)}">${usd(d.totalUsd)}</td></tr></tfoot></table></div>
</section>
<section class="card">
  <h2>${L(lang, "أخطاء وبلاغات مفتوحة (آخر 7 أيام)", "Open errors and reports (last 7 days)")}</h2>
  ${d.topErrors.length
    ? html`<table><thead><tr><th>#</th><th>${L(lang, "النوع", "Kind")}</th><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "الرسالة", "Message")}</th><th>${L(lang, "مرات", "Times")}</th></tr></thead>
  <tbody>${d.topErrors.map((e) => html`<tr><td dir="ltr">${e.kind === "report" ? "#R" : "#E"}${e.last_id}</td><td>${e.kind}</td><td>${e.source}</td><td dir="ltr">${String(e.message || "").slice(0, 140)}</td><td>${e.n}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">✅ ${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card" id="trials">
  <h2>🤝 ${L(lang, "طلبات التجربة", "Trial requests")}</h2>
  ${d.trials.length
    ? html`<div class="scroll"><table><tbody>${d.trials.map(
        (t) => html`<tr data-trial="${t.id}"><td dir="ltr">#T${t.id}</td><td>${t.name}</td><td>${t.agency_name || "—"}</td><td dir="ltr"><a href="tel:${t.phone_e164}">${t.phone_e164}</a></td><td>${t.team_size ?? "—"}</td><td dir="ltr">${new Date(t.created_at).toISOString().slice(0, 10)}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش لسه.", "None yet.")}</p>`}
</section>
<section class="card">
  <h2>${L(lang, "المهام الخلفية", "Background jobs")}</h2>
  <table><tbody>${d.jobs.map(
    (j) => html`<tr data-job="${j.name}"><td dir="ltr">${j.name}</td><td>${j.last_status === "failed" ? "❌" : j.last_status === "running" ? "⏳" : "✅"} ${j.last_status || "—"}</td><td dir="ltr">${j.last_finished_at ? new Date(j.last_finished_at).toISOString().slice(0, 16).replace("T", " ") : "—"}</td></tr>`
  )}</tbody></table>
</section>`;
}

function register(web, { pool, page }) {
  web.get("/dashboard", async (req, res) => {
    const lang = langOf(req);
    const d = await Dash.agencyDashboard(pool, req.session.broker, { days: req.query.days });
    if (!d) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    return page(req, res, { title: L(lang, "لوحة الوكالة", "Agency dashboard"), body: agencyPage(d, lang) });
  });

  web.get("/owner", async (req, res) => {
    const d = await Dash.ownerDashboard(pool, req.session.broker);
    if (!d) return notFound(req, res, page);
    return page(req, res, { title: L(langOf(req), "متابعة التطبيق", "App tracking"), body: ownerPage(d, langOf(req)) });
  });
}

module.exports = { register };
