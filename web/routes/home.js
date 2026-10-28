// web/routes/home.js — /app/ home of a signed-in broker
"use strict";

const { html } = require("../html");
const Dash = require("../../services/dashboards");
const Onboarding = require("../../services/onboarding");

/** Onboarding: the welcome card after the first sign-in, until the broker closes it. */
function welcomeCard(w, en) {
  return html`<section class="card welcome stack" data-welcome>
  <h2>${w.title}</h2>
  <p class="muted">${en ? "Four steps and you're set:" : "أربع خطوات وتبقى جاهز:"}</p>
  <ol>${w.steps.map((s) => html`<li><a href="${s.href}">${s.text}</a></li>`)}</ol>
  <form method="post" action="/app/onboarding/welcome"><button type="submit">${en ? "Got it" : "تمام، فهمت"}</button></form>
</section>`;
}

function register(web, { pool, page }) {
  web.post("/onboarding/welcome", async (req, res) => {
    await Onboarding.closeWelcome(pool, req.session.broker);
    return res.redirect(303, "/app/");
  });
  // The welcome card's Telegram step: the broker links their own account.
  web.get("/onboarding/telegram", async (req, res) => {
    const url = await Onboarding.telegramLink(pool, req.session.broker);
    return res.redirect(303, url || "/app/settings");
  });
  // Open pages refresh their CSRF token from here (web/static/app.js) so a form left open still saves.
  web.get("/csrf", (req, res) => res.json({ csrf: req.session.csrf }));
  web.get("/", async (req, res) => {
    const { broker, agency } = req.session;
    const en = broker.preferred_lang === "en";
    const welcome = await Onboarding.welcomeFor(pool, broker);
    return page(req, res, {
      title: en ? "Home" : "الرئيسية",
      body: html`${welcome ? welcomeCard(welcome, en) : ""}<div class="card">
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
