// web/routes/insights.js — "Prices per m²" (phase 2 step 8, every broker: /app/insights): per compound or district,
// sale and rent apart, from the agency's own active units, shown only with at least 5 units (services/priceInsights.js).
"use strict";

const Insights = require("../../services/priceInsights");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const num = (n) => Number(n).toLocaleString("en-US");

function table(rows, lang, kind) {
  const list = rows.filter((r) => r.listing_type === kind);
  const title = kind === "sale" ? L(lang, "🏷️ بيع (ج.م للمتر)", "🏷️ Sale (EGP per m²)") : L(lang, "🔑 إيجار (ج.م للمتر في الشهر)", "🔑 Rent (EGP per m² a month)");
  return html`<section class="card" data-kind="${kind}"><h2>${title}</h2>
  ${list.length
    ? html`<div class="scroll"><table>
    <thead><tr><th>${L(lang, "المكان", "Place")}</th><th>${L(lang, "وحدات", "Units")}</th><th>${L(lang, "المتوسط (الوسيط)", "Median")}</th><th>${L(lang, "من", "From")}</th><th>${L(lang, "لحد", "To")}</th></tr></thead>
    <tbody>${list.map((r) => html`<tr data-place="${r.place}"><td>${r.place}</td><td>${r.units}</td><td><strong>${num(r.median)}</strong></td><td>${num(r.low)}</td><td>${num(r.high)}</td></tr>`)}</tbody>
  </table></div>`
    : html`<p class="muted">${L(lang, `مفيش مكان فيه ${Insights.MIN_UNITS} وحدات أو أكتر لسه.`, `No place has ${Insights.MIN_UNITS} or more units yet.`)}</p>`}
</section>`;
}

function register(web, { pool, page }) {
  web.get("/insights", async (req, res) => {
    const lang = langOf(req);
    const rows = await Insights.byPlace(pool, req.session.broker.agency_id);
    return page(req, res, {
      title: L(lang, "أسعار المتر", "Prices per m²"),
      nav: "units",
      body: html`<h1>📊 ${L(lang, "أسعار المتر", "Prices per m²")}</h1>
<p class="muted">${L(lang, `من الوحدات المتاحة عندك بس، لكل كمبوند أو منطقة فيها ${Insights.MIN_UNITS} وحدات أو أكتر. الوسيط = نص الوحدات أغلى ونصها أرخص، فوحدة سعرها غريب مبتبوظش الرقم.`, `From your own available units only, for each compound or area with ${Insights.MIN_UNITS} or more units. Median = half the units cost more and half less, so one odd price doesn't skew it.`)}</p>
${table(rows, lang, "sale")}
${table(rows, lang, "rent")}`
    });
  });
}

module.exports = { register };
