// web/routes/winLoss.js — "Win and loss" (Release B, N7, managers: /app/winloss): leads won and lost in the last 30,
// 90 or 365 days, why they were lost, and win rate and top loss reason per broker and per source
// (services/winLoss.js).
"use strict";

const WinLoss = require("../../services/winLoss");
const W = require("../../domain/winLoss");
const Stages = require("../../domain/leadStages");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const rate = (r) => (r === null ? "—" : `${r}%`);

function table(rows, head, name, lang) {
  if (!rows.length) return html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`;
  return html`<div class="scroll"><table><thead><tr><th>${head}</th><th>${L(lang, "اتقفلت", "Won")}</th><th>${L(lang, "ضاعت", "Lost")}</th><th>${L(lang, "نسبة النجاح", "Win rate")}</th><th>${L(lang, "أكتر سبب للضياع", "Top loss reason")}</th></tr></thead>
  <tbody>${rows.map((g) => html`<tr data-group="${g.key}"><td>${name(g)}</td><td>${g.won}</td><td>${g.lost}</td><td>${rate(g.rate)}</td><td>${g.top ? W.label(g.top, lang) : "—"}</td></tr>`)}</tbody></table></div>`;
}

function winLossPage(r, lang) {
  return html`<h1>📉 ${L(lang, "المكسب والخسارة", "Win and loss")}</h1>
<nav class="row" aria-label="${L(lang, "الفترة", "Period")}">${WinLoss.PERIODS.map(
    (p) => html`<a class="btn ${p === r.days ? "" : "secondary"}" href="/app/winloss?days=${p}"${p === r.days ? html` aria-current="page"` : ""}>${L(lang, `${p} يوم`, `${p} days`)}</a>`
  )}</nav>
<div class="grid">
  <div class="card tile" data-kpi="won"><div class="muted">${L(lang, "اتقفلت", "Won")}</div><strong>${r.won}</strong></div>
  <div class="card tile" data-kpi="lost"><div class="muted">${L(lang, "ضاعت", "Lost")}</div><strong>${r.lost}</strong></div>
  <div class="card tile" data-kpi="rate"><div class="muted">${L(lang, "نسبة النجاح", "Win rate")}</div><strong>${rate(r.rate)}</strong></div>
</div>
<section class="card" id="reasons"><h2>${L(lang, "ليه العملاء ضاعوا", "Why leads were lost")}</h2>
  ${r.reasons.length
    ? html`<table><tbody>${r.reasons.map((x) => html`<tr data-reason="${x.key}"><td>${W.label(x.key, lang)}</td><td>${x.n}</td><td><progress max="100" value="${x.pct}"></progress> ${x.pct}%</td><td class="muted">${x.examples.join(" · ")}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">${L(lang, "مفيش عملاء ضاعوا في الفترة دي.", "No lost leads in this period.")}</p>`}
  <p class="muted">${L(lang, "الأسباب بتتجمع من اختيار البوت ومن الكلام المكتوب (مثلاً «غالي» = السعر).", "Reasons are grouped from the bot's choices and from typed words (e.g. \"too expensive\" = Price).")}</p>
</section>
<section class="card" id="by-broker"><h2>${L(lang, "لكل بروكر", "Per broker")}</h2>
  ${table(r.brokers, L(lang, "البروكر", "Broker"), (g) => g.name || L(lang, "من غير بروكر", "Unassigned"), lang)}
</section>
<section class="card" id="by-source"><h2>${L(lang, "لكل مصدر", "Per source")}</h2>
  ${table(r.sources, L(lang, "المصدر", "Source"), (g) => (g.key === WinLoss.NONE ? L(lang, "من غير مصدر", "No source") : Stages.sourceLabel(g.key, lang)), lang)}
</section>`;
}

function register(web, { pool, page }) {
  web.get("/winloss", async (req, res) => {
    const lang = langOf(req);
    const r = await WinLoss.report(pool, req.session.broker, { days: req.query.days });
    if (!r) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    return page(req, res, { title: L(lang, "المكسب والخسارة", "Win and loss"), body: winLossPage(r, lang) });
  });
}

module.exports = { register };
