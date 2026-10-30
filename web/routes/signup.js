// web/routes/signup.js — Agency self sign-up (phase 2 step 4): /app/signup, open to everyone while the owner has it
// switched on (services/signup.js). A request waits for the owner's approval; the trial starts when it is approved.
// An optional invite code (prefilled from ?ref=) links the agency that invited it (services/referrals.js).
// Honeypot, a rate limit per visitor, and the app's same-origin check.
"use strict";

const Signup = require("../../services/signup");
const Referrals = require("../../services/referrals");
const BillingNotices = require("../../services/billingNotices");
const Plans = require("../../domain/plans");
const RateLimit = require("../../lib/rateLimit");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const SIGNUP_IP = { limit: 3, windowSec: 3600 };
const ERRORS = {
  agency: ["اكتب اسم الوكالة.", "Enter the agency name."],
  name: ["اكتب اسمك.", "Enter your name."],
  phone: ["رقم موبايل مصري صحيح (01xxxxxxxxx).", "A valid Egyptian mobile (01xxxxxxxxx)."],
  referral: ["كود الدعوة ده مش موجود؛ راجعه أو سيبه فاضي.", "That invite code doesn't exist; check it or leave it empty."],
  phone_taken: ["الرقم ده متسجل بالفعل. ابعت «دخول» للبوت.", "This number is already registered. Send \"login\" to the bot."],
  consent: ["لازم توافق على الشروط.", "Please agree to the terms."],
  rate: ["طلبات كتير؛ جرب بعد شوية.", "Too many requests; try again later."]
};

function closedPage(lang) {
  return html`<div class="card auth"><h1>${L(lang, "التسجيل مقفول دلوقتي", "Sign-up is closed for now")}</h1>
<p>${L(lang, "سيب بياناتك في فورم «جرّبه مع وكالتك» وهنكلمك.", "Leave your details in the \"Try it with your agency\" form and we'll call you.")}</p>
<p><a class="btn" href="/?lang=${lang}#try">${L(lang, "جرّبه مع وكالتك", "Try it with your agency")}</a></p></div>`;
}

function signupForm(lang, { error, values = {} } = {}) {
  return html`<form method="post" action="/app/signup" class="card stack auth" id="signup">
  <h1>${L(lang, "سجّل وكالتك", "Sign up your agency")}</h1>
  <p class="muted">${L(lang, `${Plans.TRIAL.days} يوم تجربة مجانية على باقة المكتب بعد موافقتنا. بعدها تختار باقة أو تكمّل على الباقة المجانية.`, `A ${Plans.TRIAL.days}-day free trial on the Office plan once we approve it. Then pick a plan or carry on with the Free plan.`)}</p>
  ${error ? html`<p class="notice bad" role="alert">❌ ${ERRORS[error][lang === "en" ? 1 : 0]}</p>` : ""}
  <label>${L(lang, "اسم الوكالة", "Agency name")} <input name="agency" required maxlength="120" autocomplete="organization" value="${values.agency || ""}"></label>
  <label>${L(lang, "اسمك", "Your name")} <input name="name" required maxlength="80" autocomplete="name" value="${values.name || ""}"></label>
  <label>${L(lang, "موبايلك (هو اللي هتدخل بيه)", "Your mobile (you'll sign in with it)")} <input name="phone" required inputmode="tel" dir="ltr" placeholder="01xxxxxxxxx" maxlength="20" value="${values.phone || ""}"></label>
  <label>${L(lang, "كود دعوة من وكالة تانية (اختياري)", "Invite code from another agency (optional)")} <input name="referral" maxlength="12" dir="ltr" autocapitalize="characters" autocomplete="off" value="${values.referral || ""}"></label>
  ${values.referral ? html`<p class="muted">🎁 ${L(lang, "لما تدفع أول باقة، إنت والوكالة اللي دعتك تاخدوا شهر مجاني.", "When you pay for your first plan, you and the agency that invited you each get a free month.")}</p>` : ""}
  <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
  <label class="check"><input type="checkbox" name="consent" value="1" required> ${L(lang, "موافق إن بيانات الوكالة وعملاءها تتحفظ على WehdatHub عشان الخدمة، وإن رقمي يتستخدم للتواصل بخصوص الحساب.", "I agree that the agency's and its clients' data are stored on WehdatHub to provide the service, and that my number is used to contact me about the account.")}</label>
  <button type="submit">${L(lang, "ابعت الطلب", "Send the request")}</button>
</form>`;
}

function register(web, { pool, page }) {
  const title = (lang) => L(lang, "سجّل وكالتك", "Sign up your agency");

  web.get("/signup", async (req, res) => {
    const lang = req.lang;
    if (req.query.sent === "1") {
      return page(req, res, { title: title(lang), langSwitch: true, body: html`<div class="card notice ok" role="status"><h1>✅ ${L(lang, "وصلنا طلبك", "We got your request")}</h1><p>${L(lang, "هنراجعه ونبعتلك لينك تيليجرام على موبايلك أول ما نوافق.", "We'll review it and send a Telegram link to your mobile once it's approved.")}</p></div>` });
    }
    if (!(await Signup.isOpen(pool))) return page(req, res, { title: title(lang), langSwitch: true, body: closedPage(lang) });
    return page(req, res, { title: title(lang), langSwitch: true, body: signupForm(lang, { values: { referral: Referrals.normalize(req.query.ref) } }) });
  });

  web.post("/signup", async (req, res) => {
    const lang = req.lang;
    const body = req.body || {};
    const values = { agency: String(body.agency || "").slice(0, 120), name: String(body.name || "").slice(0, 80), phone: String(body.phone || "").slice(0, 20), referral: Referrals.normalize(body.referral) };
    const again = (error, status) => page(req, res, { title: title(lang), langSwitch: true, body: signupForm(lang, { error, values }) }, status);
    if (!(await Signup.isOpen(pool))) return page(req, res, { title: title(lang), langSwitch: true, body: closedPage(lang) }, 403);
    if (body.website) return res.redirect(303, "/app/signup?sent=1");
    if (body.consent !== "1") return again("consent", 400);
    const gate = await RateLimit.hit(pool, `signup:ip:${req.ip}`, SIGNUP_IP);
    if (!gate.allowed) return again("rate", 429);
    const r = await Signup.submit(pool, { ...values, lang });
    if (r.error === "closed") return page(req, res, { title: title(lang), langSwitch: true, body: closedPage(lang) }, 403);
    if (r.error) return again(r.error, 400);
    BillingNotices.signupRequested(r.agency, r.broker, r.referrer);
    return res.redirect(303, "/app/signup?sent=1");
  });
}

module.exports = { register };
