// web/routes/landing.js — The public landing page at / (phase 2 step 3), Arabic or English (?lang=en): what WehdatHub
// does, the plans, "Open in Telegram", and a "Try it with your agency" form (honeypot, rate limit, same-origin) that is
// kept in demo_requests and alerts the owner. Colours come from the brand tokens (domain/brand.js).
"use strict";

const express = require("express");
const Credits = require("../../services/credits");
const { creditTable } = require("../views/credits");
const RateLimit = require("../../lib/rateLimit");
const ErrorReports = require("../../lib/errorReports");
const Phone = require("../../domain/phone");
const Plans = require("../../domain/plans");
const Signup = require("../../services/signup");
const { BRAND } = require("../../domain/brand");
const { getConfig } = require("../../config");
const { securityHeaders, sameOrigin } = require("../security");
const { html, layout } = require("../html");

const T = (lang, ar, en) => (lang === "en" ? en : ar);
const TRY_IP = { limit: 5, windowSec: 3600 };
const num = (n, lang) => Number(n).toLocaleString(lang === "en" ? "en-US" : "ar-EG");

const FEATURES = [
  ["🎙️", ["ضيف وحدة بفويس وصور", "Add a unit with a voice note and photos"], ["البوت يفهم الكمبوند والمساحة والسعر ويعمل الكارت والكود لوحده.", "The bot picks out the compound, area and price and makes the card and code for you."]],
  ["🔍", ["دوّر بكلامك", "Search in your own words"], ["«شقة في التجمع ٣ غرف تحت ١٠ مليون» وتجيلك النتايج بالصور.", "\"3-bed apartment in New Cairo under 10M\" and the results come with photos."]],
  ["👤", ["عملاءك ومتابعاتك", "Your clients and follow-ups"], ["كارت لكل عميل، مراحل، متابعات، وعملاء إعلانات فيسبوك من ملف CSV.", "A card per client, stages, follow-ups, and Facebook ad leads from a CSV file."]],
  ["🔔", ["تنبيه لما وحدة تناسب عميل", "Alerts when a unit fits a client"], ["أول ما تنزل وحدة تناسب طلب عميل أو سعرها ينزل، بتتبلغ.", "As soon as a unit fits a client's request or drops its price, you hear about it."]],
  ["🔗", ["لينك للعميل", "A link for your client"], ["صفحة للوحدة بالصور، والعميل يقدر يقول «مهتم» من عليها.", "A unit page with photos where the client can say \"I'm interested\"."]],
  ["📈", ["لوحة للمدير", "A dashboard for managers"], ["العملاء والصفقات والعمولة وترتيب البروكرز.", "Leads, deals, commission and the broker leaderboard."]]
];

const ERRORS = {
  name: ["اكتب اسمك.", "Enter your name."],
  phone: ["اكتب رقم موبايل صحيح.", "Enter a valid mobile number."],
  rate: ["طلبات كتير؛ جرب بعد شوية.", "Too many requests; try again later."]
};

function tryForm(lang, { error, values = {}, sent }) {
  if (sent) {
    return html`<section class="card notice ok" id="try" role="status"><h2>✅ ${T(lang, "وصلنا طلبك", "We got your request")}</h2><p>${T(lang, "هنكلمك خلال يوم عمل.", "We'll call you within one working day.")}</p></section>`;
  }
  return html`<form method="post" action="/try?lang=${lang}#try" class="card stack" id="try">
  <h2>🤝 ${T(lang, "جرّبه مع وكالتك", "Try it with your agency")}</h2>
  ${error ? html`<p class="notice bad" role="alert">❌ ${ERRORS[error][lang === "en" ? 1 : 0]}</p>` : ""}
  <label>${T(lang, "اسمك", "Your name")} <input name="name" required maxlength="80" autocomplete="name" value="${values.name || ""}"></label>
  <label>${T(lang, "اسم الوكالة", "Agency name")} <input name="agency" maxlength="120" autocomplete="organization" value="${values.agency || ""}"></label>
  <div class="grid two"><label>${T(lang, "الموبايل", "Mobile")} <input name="phone" required inputmode="tel" autocomplete="tel" dir="ltr" maxlength="20" value="${values.phone || ""}"></label>
  <label>${T(lang, "عدد البروكرز", "Number of brokers")} <input name="team" type="number" min="1" max="1000" inputmode="numeric" value="${values.team || ""}"></label></div>
  <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
  <p class="muted">${T(lang, "بنستخدم الرقم بس عشان نكلمك بخصوص التجربة.", "We use the number only to call you about the trial.")}</p>
  <button type="submit">${T(lang, "اطلب تجربة", "Request a trial")}</button>
</form>`;
}

function landingBody(lang, { telegramUrl, form, logo, signupOpen, actions = [] }) {
  const trial = Plans.TRIAL.plan || "office";
  return html`<section class="hero lp-hero">
  <img class="hero-logo" src="${logo}" alt="" width="64" height="64">
  <h1>${T(lang, "وحداتك وعملاءك في مكان واحد", "Your units and clients in one place")}</h1>
  <p class="lead">${T(lang, "على تيليجرام والموقع. ابعت فويس، البوت يضيف الوحدة ويلاقي لعميلك المناسب. معمول للبروكرز والوكالات العقارية في مصر.", "On Telegram and the web. Send a voice note; the bot adds the unit and finds what fits your client. Built for real estate brokers and agencies in Egypt.")}</p>
  <div class="lp-cta">
    ${telegramUrl ? html`<a class="btn" href="${telegramUrl}" rel="noopener">✈️ ${T(lang, "افتح في تيليجرام", "Open in Telegram")}</a>` : ""}
    ${signupOpen ? html`<a class="btn${telegramUrl ? " secondary" : ""}" href="/app/signup?lang=${lang}">🏢 ${T(lang, "سجّل وكالتك", "Sign up your agency")}</a>` : ""}
    <a class="btn${telegramUrl || signupOpen ? " secondary" : ""}" href="#try">🤝 ${T(lang, "جرّبه مع وكالتك", "Try it with your agency")}</a>
  </div>
  <p class="lp-trust">${T(lang, `${num(Plans.TRIAL.days, lang)} يوم ببلاش · من غير كارت · بياناتك مش بتتمسح`, `${Plans.TRIAL.days} days free · no card · your data is never deleted`)}</p>
</section>
<section class="lp-features" aria-label="${T(lang, "المميزات", "Features")}">
  <ul>${FEATURES.map(
    ([icon, title, text]) => html`<li><span class="lp-ico" aria-hidden="true">${icon}</span><div><h2>${title[lang === "en" ? 1 : 0]}</h2><p>${text[lang === "en" ? 1 : 0]}</p></div></li>`
  )}</ul>
</section>
<section id="plans" class="lp-plans">
  <h2>${T(lang, "الباقات (شهري)", "Plans (monthly)")}</h2>
  <div class="lp-plan-row">${Plans.PLANS.map(
    (p) => html`<div class="lp-plan${p.id === trial ? " on" : ""}" data-plan="${p.id}">${p.id === trial ? html`<span class="chip">${T(lang, "التجربة عليها", "Trial plan")}</span>` : ""}<strong>${Plans.planName(p, lang)}</strong>
    <div class="price">${num(p.priceEgp, lang)} ${T(lang, "ج.م", "EGP")}</div>
    <ul><li>${p.seats === 1 ? T(lang, "مستخدم واحد", "1 user") : T(lang, `${num(p.seats, lang)} مستخدمين`, `${p.seats} users`)}</li>
    <li>${T(lang, `${num(p.credits, lang)} رصيد ذكاء اصطناعي في الشهر`, `${num(p.credits, "en")} AI credits a month`)}</li></ul></div>`
  )}</div>
  <p class="muted small">${T(
    lang,
    `أول ${num(Plans.TRIAL.days, lang)} يوم مجاناً على باقة المكتب. رصيد زيادة: ${Plans.BUNDLES.map((b) => `${num(b.credits, lang)} بـ ${num(b.priceEgp, lang)} ج.م`).join("، ")}. الدفع بإنستاباي أو تحويل بنكي. بياناتك مش بتتمسح أبداً.`,
    `The first ${Plans.TRIAL.days} days are free on the Office plan. Extra credits: ${Plans.BUNDLES.map((b) => `${b.credits} for ${b.priceEgp} EGP`).join(", ")}. Pay by InstaPay or bank transfer. Your data is never deleted.`
  )}</p>
</section>
${creditTable(actions, lang)}
${form}
<footer class="lp-foot"><span>${BRAND.name}</span><a href="/app/guide?lang=${lang}">${T(lang, "الدليل", "Guide")}</a><a href="/app/">${T(lang, "دخول", "Sign in")}</a></footer>`;
}

function mountLanding(app, { pool, assets }) {
  const render = async (req, res, lang, form = {}, status = 200) => {
    const signupOpen = await Signup.isOpen(pool);
    const actions = await Credits.actions(pool);
    const username = getConfig().telegram.botUsername;
    const telegramUrl = /^[A-Za-z0-9_]{5,32}$/.test(username || "") ? `https://t.me/${username}` : null;
    const other = lang === "en" ? "ar" : "en";
    return res
      .status(status)
      .type("html")
      .send(
        String(
          layout({
            assets: assets.url,
            lang,
            title: T(lang, "وحداتك وعملاءك على تيليجرام", "Units and clients on Telegram"),
            robots: "index, follow",
            scripts: false,
            manifest: false,
            head: html`<meta name="description" content="${T(lang, "WehdatHub: مساعد الوحدات والعملاء للبروكرز والوكالات العقارية في مصر، على تيليجرام والموقع.", "WehdatHub: the units and clients assistant for real estate brokers and agencies in Egypt, on Telegram and the web.")}">
<meta property="og:title" content="${BRAND.name}">
<link rel="alternate" hreflang="${other}" href="/?lang=${other}">`,
            body: html`<nav class="top lp-top"><span class="brand"><img src="${assets.url(BRAND.logo)}" alt="" width="28" height="28">${BRAND.name}</span><a class="logout" href="/?lang=${other}" data-lang-switch hreflang="${other}">${other === "en" ? "English" : "العربية"}</a><a class="btn small" href="/app/">${T(lang, "دخول", "Sign in")}</a></nav>
${landingBody(lang, { telegramUrl, form: tryForm(lang, form), logo: assets.url(BRAND.logo), signupOpen, actions })}`
          })
        )
      );
  };
  const langOf = (req) => (req.query.lang === "en" ? "en" : "ar");

  app.get("/", securityHeaders, async (req, res) => {
    res.set("Cache-Control", "no-cache");
    return render(req, res, langOf(req), { sent: req.query.sent === "1" });
  });

  app.post("/try", securityHeaders, sameOrigin(), express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }), async (req, res) => {
    const lang = langOf(req);
    const body = req.body || {};
    const values = {
      name: String(body.name || "").trim().slice(0, 80),
      agency: String(body.agency || "").trim().slice(0, 120),
      phone: String(body.phone || "").trim().slice(0, 20),
      team: String(body.team || "").trim().slice(0, 4)
    };
    const done = () => res.redirect(303, `/?lang=${lang}&sent=1#try`);
    if (body.website) return done();
    if (!values.name) return render(req, res, lang, { error: "name", values }, 400);
    const e164 = Phone.toE164(values.phone);
    if (!e164) return render(req, res, lang, { error: "phone", values }, 400);
    const gate = await RateLimit.hit(pool, `try:ip:${req.ip}`, TRY_IP);
    if (!gate.allowed) return render(req, res, lang, { error: "rate", values }, 429);
    const team = /^\d{1,4}$/.test(values.team) && Number(values.team) >= 1 && Number(values.team) <= 1000 ? Number(values.team) : null;
    const { rows } = await pool.query(
      "INSERT INTO demo_requests (name, agency_name, phone_e164, team_size, lang) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [values.name, values.agency || null, e164, team, lang]
    );
    ErrorReports.alertOwner(
      [`🤝 Trial request #T${rows[0].id}`, `${values.name}${values.agency ? ` · ${values.agency}` : ""}`, `📞 ${e164}`, team ? `👥 ${team} brokers` : ""].filter(Boolean).join("\n")
    ).catch(() => {});
    return done();
  });
}

module.exports = { mountLanding, FEATURES };
