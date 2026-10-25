// web/routes/home.js — /app/ home of a signed-in broker
"use strict";

const { html } = require("../html");
const Dash = require("../../services/dashboards");

function register(web, { page }) {
  web.get("/", (req, res) => {
    const { broker, agency } = req.session;
    const en = broker.preferred_lang === "en";
    return page(req, res, {
      title: en ? "Home" : "الرئيسية",
      body: html`<div class="card">
  <h1>${en ? `👋 Hello ${broker.name}` : `👋 أهلاً ${broker.name}`}</h1>
  <p class="muted">${agency.name}</p>
  <div class="row">
    <a class="btn" href="/app/search">${en ? "🔍 Search" : "🔍 بحث"}</a>
    <a class="btn secondary" href="/app/leads">${en ? "👤 Leads" : "👤 العملاء"}</a>
    <a class="btn secondary" href="/app/units/new">${en ? "➕ Add a unit" : "➕ إضافة وحدة"}</a>
    <a class="btn secondary" href="/app/import">${en ? "📥 Import" : "📥 استيراد"}</a>
    <a class="btn secondary" href="/app/catalogue">${en ? "🏗️ Catalogue" : "🏗️ كتالوج المطورين"}</a>
    ${Dash.isManager(broker) ? html`<a class="btn secondary" href="/app/dashboard">${en ? "📈 Dashboard" : "📈 لوحة الوكالة"}</a>` : ""}
    <a class="btn secondary" href="/app/guide">${en ? "📘 Guide" : "📘 الدليل"}</a>
    ${Dash.isOwner(broker) ? html`<a class="btn secondary" href="/app/owner">${en ? "🛠️ App tracking" : "🛠️ متابعة التطبيق"}</a>` : ""}
  </div>
</div>`
    });
  });
}

module.exports = { register };
