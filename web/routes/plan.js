// web/routes/plan.js — "Plan" (phase 2 step 4): the agency's plan in force, this month's AI credits (used / pool), seats; managers
// announce a payment (a plan for 1–12 months, or an extra credit bundle) and can ask the owner for more credits and get the amount, a
// reference and where to pay (InstaPay or bank, as the owner set it); the owner confirms on /app/owner. Managers also
// get the agency's invite code and link (Release B N9: both agencies get a free month when the invited one pays).
"use strict";

const Billing = require("../../services/billing");
const Referrals = require("../../services/referrals");
const BillingNotices = require("../../services/billingNotices");
const Plans = require("../../domain/plans");
const { MANAGER_ROLES } = require("../../lib/authz");
const { html } = require("../html");
const Credits = require("../../services/credits");
const { creditTable } = require("../views/credits");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const isManager = (b) => MANAGER_ROLES.includes(String(b.role || "").toLowerCase());
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
const num = (n) => Number(n).toLocaleString("en-US");

const SOURCE = {
  pilot: ["تجربة الإطلاق: باقة المكتب مجاناً لحد نهاية التجربة", "Pilot: Office plan free until the pilot ends"],
  paid: ["مدفوعة", "Paid"],
  trial: ["تجربة مجانية", "Free trial"],
  free: ["الباقة المجانية", "Free plan"]
};
const STATUS = { pending: ["مستني التأكيد", "Waiting for confirmation"], confirmed: ["اتأكد ✅", "Confirmed ✅"], cancelled: ["اتلغى", "Cancelled"] };
const REQUEST_STATUS = { pending: ["مستني الرد", "Waiting"], approved: ["اتوافق ✅", "Approved ✅"], declined: ["اترفض", "Declined"] };
const CREDIT_ERRORS = {
  credits: ["اكتب عدد رصيد من 1 لـ 100,000.", "Enter a number of credits from 1 to 100,000."],
  too_many: ["عندك 3 طلبات مستنية. استنى الرد.", "You already have 3 open requests. Wait for an answer."],
  forbidden: ["المدير بس يقدر يطلب رصيد.", "Only a manager can ask for credits."]
};
const ERRORS = {
  plan: ["اختار باقة ومدة.", "Pick a plan and a period."],
  too_many: ["عندك ٣ مدفوعات مستنية؛ استنى تأكيدها أو كلّمنا.", "You have 3 payments waiting; wait for them to be confirmed or contact us."],
  forbidden: ["للمديرين بس.", "Managers only."]
};

function meter(label, used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((used * 100) / limit)) : 100;
  return html`<div class="card tile" data-meter="${label[1].toLowerCase()}"><div class="muted">${label[0]}</div><strong>${num(used)} / ${num(limit)}</strong><progress max="100" value="${pct}">${pct}%</progress></div>`;
}

function paymentCard(p, payTo, lang) {
  return html`<section class="card notice" data-payment="${p.reference}">
  <h2>💳 ${L(lang, "ادفع كده", "How to pay")}</h2>
  <p>${L(lang, "المبلغ", "Amount")}: <strong>${num(p.amount_egp)} ${L(lang, "ج.م", "EGP")}</strong></p>
  <p>${L(lang, "اكتب المرجع ده في ملاحظة التحويل", "Put this reference in the transfer note")}: <strong dir="ltr">${p.reference}</strong></p>
  ${payTo.instapay ? html`<p>InstaPay: <strong dir="ltr">${payTo.instapay}</strong></p>` : ""}
  ${payTo.bank ? html`<p>${L(lang, "تحويل بنكي", "Bank transfer")}: <span dir="auto">${payTo.bank}</span></p>` : ""}
  ${!payTo.instapay && !payTo.bank ? html`<p class="muted">${L(lang, "تفاصيل الدفع هتوصلك مننا قريب.", "We'll send you the payment details shortly.")}</p>` : ""}
  <p class="muted">${L(lang, "أول ما الفلوس توصل بنأكد الدفع وتتبلغ.", "As soon as the money arrives we confirm it and you'll be told.")}</p>
</section>`;
}

const INVITED = {
  pending: ["مستنية موافقتنا", "Waiting for our approval"],
  approved: ["مستنية أول دفعة", "Waiting for its first payment"],
  rejected: ["اترفضت", "Rejected"],
  rewarded: ["دفعت: الشهر المجاني اتحسب 🎁", "Paid: free month earned 🎁"]
};

function referralSection(r, lang) {
  const text = L(lang, `جرّب WehdatHub لوكالتك. سجّل بالكود ${r.code} وناخد إحنا الاتنين شهر مجاني لما تشترك: ${r.link}`, `Try WehdatHub for your agency. Sign up with code ${r.code} and we both get a free month when you subscribe: ${r.link}`);
  return html`<section class="card stack" id="referral" data-referral="${r.code}">
  <h2>🎁 ${L(lang, "ادعي وكالة تانية", "Invite another agency")}</h2>
  <p>${L(lang, "لما الوكالة اللي دعيتها تدفع أول باقة، إنتوا الاتنين تاخدوا شهر مجاني.", "When an agency you invite pays for its first plan, you both get a free month.")}</p>
  <p>${L(lang, "كود الدعوة", "Invite code")}: <strong dir="ltr">${r.code}</strong></p>
  <label>${L(lang, "لينك التسجيل", "Sign-up link")} <span class="row"><input readonly dir="ltr" value="${r.link}" id="referral-link"> <button type="button" class="secondary" data-copy="#referral-link">📋 ${L(lang, "نسخ", "Copy")}</button></span></label>
  <p><a class="btn secondary" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>
  ${r.credit ? html`<p class="notice ok">${L(lang, `عندك ${r.credit} شهر مجاني هيتضاف لأول دفعة جاية.`, `You have ${r.credit} free month(s) that will be added to your next payment.`)}</p>` : ""}
  ${r.referredBy ? html`<p class="muted">${L(lang, `وكالتك اتدعت من ${r.referredBy}`, `Your agency was invited by ${r.referredBy}`)}${r.rewarded ? "" : L(lang, " — أول دفعة ليك فيها شهر مجاني.", " — your first payment includes a free month.")}</p>` : ""}
  ${r.invited.length
    ? html`<table><tbody>${r.invited.map((x) => html`<tr data-invited><td>${x.name}</td><td>${INVITED[x.referral_rewarded_at ? "rewarded" : x.approval][lang === "en" ? 1 : 0]}</td></tr>`)}</tbody></table>`
    : ""}
</section>`;
}

function planPage({ a, actionsList = [], requests = [], limits = {}, payments, payTo, lang, manager, referral = null, notice = null, created = null }) {
  const p = a.plan;
  return html`<h1>${L(lang, "الباقة", "Plan")}</h1>
${notice || ""}
${created ? paymentCard(created, payTo, lang) : ""}
<section class="card" data-plan="${p.id}" data-source="${a.source}">
  <h2>${Plans.planName(p, lang)} · ${SOURCE[a.source][lang === "en" ? 1 : 0]}</h2>
  ${a.until ? html`<p>${L(lang, "لحد", "Until")} <span dir="ltr">${day(a.until)}</span></p>` : ""}
  <div class="grid">
    ${meter([L(lang, "رصيد الذكاء الاصطناعي الشهر الحالي", "AI credits this month"), "credits"], a.credits.used, a.credits.limit)}
    ${meter([L(lang, "المستخدمين", "Users"), "seats"], a.seats.used, a.seats.limit)}
    ${meter([L(lang, "وحدات متاحة", "Available units"), "units"], a.units.used, a.units.limit)}
  </div>
  <p class="muted" data-credit-split>${L(lang, `الرصيد: ${num(a.credits.plan)} من الباقة` + (a.credits.bundles ? ` + ${num(a.credits.bundles)} باقات زيادة` : "") + (a.credits.grants ? ` + ${num(a.credits.grants)} هدية من صاحب التطبيق` : ""), `Credits: ${num(a.credits.plan)} from the plan` + (a.credits.bundles ? ` + ${num(a.credits.bundles)} from bundles` : "") + (a.credits.grants ? ` + ${num(a.credits.grants)} granted by the app owner` : ""))}</p>
  ${creditTable(actionsList, lang)}
  <p class="muted">${L(lang, "لو الرصيد خلص، البحث والعملاء والوحدات بيفضلوا شغالين يدوي؛ اللي بيقف هو قراءة الفويس والوصف بالذكاء الاصطناعي لحد أول الشهر. بياناتك مش بتتمسح أبداً.", "When an allowance runs out, search, clients and units keep working by hand; only AI reading of voice notes and descriptions stops until the month turns. Your data is never deleted.")}</p>
</section>
${manager
  ? html`<form method="post" action="/app/plan/pay" class="card stack">
  <h2>${L(lang, "اختار باقة", "Choose a plan")}</h2>
  <div class="plancards">${Plans.PLANS.map(
    (x) => html`<label class="plancard"><input type="radio" name="plan" value="${x.id}" ${x.id === (a.source === "paid" ? p.id : "office") ? "checked" : ""}><strong>${Plans.planName(x, lang)}</strong><span class="price">${num(x.priceEgp)} <small>${L(lang, "ج.م/شهر", "EGP/month")}</small></span>
      <ul><li>${x.seats} ${L(lang, "مستخدم", "users")}</li><li>${num(x.credits)} ${L(lang, "رصيد ذكاء اصطناعي في الشهر", "AI credits a month")}</li><li>${num(limits[x.id] ?? x.units)} ${L(lang, "وحدة متاحة", "available units")}</li></ul></label>`
  )}</div>
  <label>${L(lang, "المدة", "Period")} <select name="months">${Billing.MONTHS.map((m) => html`<option value="${m}">${m === 1 ? L(lang, "شهر", "1 month") : L(lang, `${m} شهور`, `${m} months`)}</option>`)}</select></label>
  <input type="hidden" name="kind" value="plan">
  <button type="submit">${L(lang, "هدفع", "I'll pay")}</button>
</form>
<section class="card stack" data-bundles>
  <h2>${L(lang, "رصيد زيادة (صالح ٣٠ يوم)", "Extra credits (valid 30 days)")}</h2>
  ${Plans.BUNDLES.map(
    (x) => html`<form method="post" action="/app/plan/pay" class="row" data-bundle="${x.id}">
    <input type="hidden" name="kind" value="credit_bundle"><input type="hidden" name="bundle" value="${x.id}">
    <span>${num(x.credits)} ${L(lang, "رصيد", "credits")} · ${num(x.priceEgp)} ${L(lang, "ج.م", "EGP")}</span>
    <button type="submit" class="secondary">${L(lang, "اشتري", "Buy")}</button>
  </form>`
  )}
</section>
<form method="post" action="/app/plan/credit-request" class="card stack" data-credit-request>
  <h2>${L(lang, "اطلب رصيد زيادة", "Ask for more credits")}</h2>
  <p class="muted">${L(lang, "بتوصل لصاحب التطبيق على تليجرام، وبيرد عليك هنا.", "The app owner gets it on Telegram and answers here.")}</p>
  <label>${L(lang, "كام رصيد؟", "How many credits?")} <input name="credits" type="number" min="1" max="100000" required></label>
  <label>${L(lang, "ملاحظة (اختياري)", "Note (optional)")} <input name="note" maxlength="300"></label>
  <button type="submit" class="secondary">${L(lang, "ابعت الطلب", "Send request")}</button>
  ${requests.length ? html`<table data-credit-requests><tbody>${requests.map((x) => html`<tr data-request="${x.id}"><td>${num(x.credits)}</td><td>${(REQUEST_STATUS[x.status] || REQUEST_STATUS.pending)[lang === "en" ? 1 : 0]}</td><td dir="ltr">${day(x.created_at)}</td></tr>`)}</tbody></table>` : ""}
</form>`
  : html`<p class="muted">${L(lang, "المدير بس يقدر يغيّر الباقة.", "Only a manager can change the plan.")}</p>`}
${referral ? referralSection(referral, lang) : ""}
${payments.length
  ? html`<section class="card"><h2>${L(lang, "المدفوعات", "Payments")}</h2><div class="scroll"><table><tbody>${payments.map(
      (x) => html`<tr data-ref="${x.reference}"><td dir="ltr">${x.reference}</td><td>${x.kind === "credit_bundle" ? L(lang, `رصيد زيادة ${num(Plans.bundleById(x.bundle_id)?.credits ?? 0)}`, `Extra credits ${num(Plans.bundleById(x.bundle_id)?.credits ?? 0)}`) : x.kind === "voice_pack" ? L(lang, "باقة فويس", "Voice pack") : `${Plans.planName(Plans.planById(x.plan), lang)} × ${x.months}`}</td><td>${num(x.amount_egp)} ${L(lang, "ج.م", "EGP")}</td><td>${STATUS[x.status][lang === "en" ? 1 : 0]}</td><td dir="ltr">${day(x.created_at)}</td></tr>`
    )}</tbody></table></div></section>`
  : ""}`;
}

function register(web, { pool, page }) {
  const render = async (req, res, extra = {}, status = 200) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    const [a, payTo, limits, actionsList] = await Promise.all([Billing.allowance(pool, broker.agency_id), Billing.payTo(pool), Billing.planLimits(pool), Credits.actions(pool)]);
    const payments = isManager(broker) ? await Billing.paymentsOf(pool, broker.agency_id) : [];
    const requests = isManager(broker) ? await Credits.requestsOf(pool, broker.agency_id) : [];
    const referral = isManager(broker) ? await Referrals.summary(pool, broker.agency_id) : null;
    return page(req, res, { title: L(lang, "الباقة", "Plan"), nav: "settings", body: planPage({ a, actionsList, requests, limits, payments, payTo, lang, manager: isManager(broker), referral, ...extra }) }, status);
  };

  web.get("/plan", (req, res) => render(req, res));

  web.post("/plan/credit-request", async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isManager(broker)) return res.status(403).type("text/plain").send(ERRORS.forbidden[lang === "en" ? 1 : 0]);
    const r = await Credits.requestMore(pool, broker, { credits: req.body.credits, note: req.body.note });
    if (r.error) return render(req, res, { notice: html`<p class="card notice bad" role="alert">❌ ${(CREDIT_ERRORS[r.error] || CREDIT_ERRORS.credits)[lang === "en" ? 1 : 0]}</p>` }, r.error === "forbidden" ? 403 : 400);
    return render(req, res, { notice: html`<p class="card notice ok" role="status" data-credit-request-sent>✅ ${L(lang, "الطلب وصل لصاحب التطبيق.", "Your request reached the app owner.")}</p>` });
  });

  web.post("/plan/pay", async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isManager(broker)) return res.status(403).type("text/plain").send(ERRORS.forbidden[lang === "en" ? 1 : 0]);
    const r = await Billing.requestPayment(pool, broker, { kind: req.body.kind, plan: req.body.plan, months: req.body.months, bundle: req.body.bundle });
    if (r.error) return render(req, res, { notice: html`<p class="card notice bad" role="alert">❌ ${(ERRORS[r.error] || ERRORS.plan)[lang === "en" ? 1 : 0]}</p>` }, r.error === "forbidden" ? 403 : 400);
    BillingNotices.paymentRequested(r.payment, r.agency, broker);
    return render(req, res, { created: r.payment });
  });
}

module.exports = { register };
