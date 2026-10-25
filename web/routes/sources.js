// web/routes/sources.js — "Lead sources" (phase 2 step 7, managers: /app/sources): per source and month, leads,
// deals, commission, the ad spend managers type, and cost per lead and per deal (services/leadSources.js).
"use strict";

const Sources = require("../../services/leadSources");
const Stages = require("../../domain/leadStages");
const Commission = require("../../domain/commission");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => (n === null || n === undefined ? "—" : Commission.money(n, lang));

function shift(month, by) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

function sourcesPage(r, lang, { notice = null } = {}) {
  const ym = r.month.slice(0, 7);
  const name = (s) => (s === Sources.NONE ? L(lang, "من غير مصدر", "No source") : Stages.sourceLabel(s, lang));
  return html`<h1>📣 ${L(lang, "مصادر العملاء", "Lead sources")}</h1>
${notice || ""}
<nav class="row" aria-label="${L(lang, "الشهر", "Month")}">
  <a class="btn secondary" href="/app/sources?month=${shift(r.month, -1)}">‹</a>
  <strong dir="ltr">${ym}</strong>
  <a class="btn secondary" href="/app/sources?month=${shift(r.month, 1)}">›</a>
</nav>
<form method="post" action="/app/sources" class="card stack">
  <input type="hidden" name="month" value="${ym}">
  <div class="scroll"><table>
    <thead><tr><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "عملاء", "Leads")}</th><th>${L(lang, "صفقات", "Deals")}</th><th>${L(lang, "عمولة الوكالة", "Agency commission")}</th><th>${L(lang, "مصروف الإعلانات (ج.م)", "Ad spend (EGP)")}</th><th>${L(lang, "تكلفة العميل", "Cost per lead")}</th><th>${L(lang, "تكلفة الصفقة", "Cost per deal")}</th></tr></thead>
    <tbody>${r.rows.map(
      (x) => html`<tr data-source="${x.source}"><td>${name(x.source)}</td><td>${x.leads}</td><td>${x.deals}</td><td>${money(x.commission, lang)}</td>
      <td>${x.source === Sources.NONE ? "—" : html`<input type="hidden" name="source" value="${x.source}"><input name="amount" inputmode="numeric" dir="ltr" size="9" value="${x.spend || ""}" aria-label="${name(x.source)}">`}</td>
      <td data-per-lead>${money(x.perLead, lang)}</td><td data-per-deal>${money(x.perDeal, lang)}</td></tr>`
    )}</tbody>
    <tfoot><tr data-total><th>${L(lang, "الإجمالي", "Total")}</th><th>${r.totals.leads}</th><th>${r.totals.deals}</th><th>${money(r.totals.commission, lang)}</th><th>${money(r.totals.spend, lang)}</th><th>${money(r.totals.perLead, lang)}</th><th>${money(r.totals.perDeal, lang)}</th></tr></tfoot>
  </table></div>
  <label>${L(lang, "مصدر تاني (اسم حملة مثلاً)", "Another source (a campaign name, say)")} <input name="new_source" maxlength="60"></label>
  <label>${L(lang, "مصروفه", "Its spend")} <input name="new_amount" inputmode="numeric" dir="ltr"></label>
  <button type="submit">${L(lang, "حفظ المصروف", "Save spend")}</button>
  <p class="muted">${L(lang, "العملاء: اللي اتسجلوا في الشهر ده. الصفقات: اللي اتقفلت في الشهر ده مع عميل من المصدر ده (غير الملغية). اسم المصدر لازم يطابق اللي على العميل (عملاء ملف Meta بياخدوا اسم الحملة).", "Leads: added this month. Deals: closed this month with a lead from that source (not cancelled). The source name must match the lead's (leads from a Meta file carry the campaign name).")}</p>
</form>`;
}

function register(web, { pool, page }) {
  const render = async (req, res, extra = {}, status = 200) => {
    const lang = langOf(req);
    const r = await Sources.report(pool, req.session.broker, { month: req.body?.month || req.query.month });
    if (!r) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    return page(req, res, { title: L(lang, "مصادر العملاء", "Lead sources"), body: sourcesPage(r, lang, extra) }, status);
  };

  web.get("/sources", (req, res) =>
    render(req, res, req.query.saved === "1" ? { notice: html`<p class="card notice ok" role="status">✅ ${L(langOf(req), "المصروف اتحفظ.", "Spend saved.")}</p>` } : {})
  );

  web.post("/sources", async (req, res) => {
    const lang = langOf(req);
    const sources = [].concat(req.body.source || []);
    const amounts = [].concat(req.body.amount || []);
    const spend = {};
    sources.forEach((s, i) => (spend[s] = amounts[i]));
    if (String(req.body.new_source || "").trim()) spend[String(req.body.new_source).trim()] = req.body.new_amount;
    const r = await Sources.saveSpend(pool, req.session.broker, { month: req.body.month, spend });
    if (r.error === "forbidden") return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    if (r.error) return render(req, res, { notice: html`<p class="card notice bad" role="alert">❌ ${L(lang, "اكتب المبلغ أرقام بس (جنيه).", "Type the amount in digits (EGP).")}</p>` }, 400);
    return res.redirect(303, `/app/sources?month=${encodeURIComponent(req.body.month)}&saved=1`);
  });
}

module.exports = { register };
