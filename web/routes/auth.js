// web/routes/auth.js — Magic-link sign-in. The link (from WhatsApp) opens a confirm page (GET, uses
// nothing), whose button signs in with a POST: link previews and scanners can never use the token.
"use strict";

const WebAuth = require("../../lib/webAuth");
const RateLimit = require("../../lib/rateLimit");
const Links = require("../../lib/links");
const Onboarding = require("../../lib/onboarding");
const { notify } = require("../../lib/dispatcher");
const { logOperation } = require("../../lib/db");
const { t } = require("../../lib/copy");
const S = require("../session");
const { html } = require("../html");

const tooMany = (page, req, res, gate) => {
  res.set("Retry-After", String(gate.retryAfterSec));
  return page(req, res, { title: "محاولات كتير", body: html`<div class="card notice bad"><h1>⏳ محاولات كتير</h1><p>استنى شوية وحاول تاني.</p><p class="muted">Too many attempts. Try again later.</p></div>` }, 429);
};

function loginForm({ pre, next, message = null }) {
  return html`<div class="card">
  <h1>🔐 الدخول</h1>
  ${message ? html`<p class="notice card">${message}</p>` : ""}
  <p>ابعت <strong>«دخول»</strong> لرقم AqarChat على واتساب، وهيوصلك رابط الدخول على طول.</p>
  <p>أو اكتب رقم الموبايل المسجل وهنبعتلك الرابط على واتساب:</p>
  <form method="post" action="/app/login" class="stack">
    <input type="hidden" name="_csrf" value="${pre}">
    <input type="hidden" name="next" value="${next}">
    <label>رقم الموبايل <input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="01012345678" dir="ltr"></label>
    <button type="submit">ابعتلي رابط الدخول</button>
  </form>
  <p class="muted">Send "login" to the AqarChat WhatsApp number, or enter your registered mobile to get a sign-in link on WhatsApp.</p>
</div>`;
}

const expiredPage = html`<div class="card notice bad">
  <h1>⌛ الرابط ده انتهى أو اتستخدم قبل كده</h1>
  <p>ابعت <strong>«دخول»</strong> لرقم AqarChat على واتساب عشان يوصلك رابط جديد.</p>
  <p><a href="/app/login">صفحة الدخول</a></p>
  <p class="muted">This link has expired or was already used. Send "login" to the bot for a new one.</p>
</div>`;

function register(web, { pool, page }) {
  web.get("/login", S.noStore, (req, res) => {
    if (req.session) return res.redirect(303, S.safeNext(req.query.next));
    const pre = S.issuePreToken(req, res);
    return page(req, res, { title: "الدخول", body: loginForm({ pre, next: S.safeNext(req.query.next) }) });
  });

  // Asking for a link on the web: the answer is the same whether or not the number is registered.
  web.post("/login", S.noStore, async (req, res) => {
    if (!S.verifyPreToken(req)) return res.status(403).send("Invalid or missing CSRF token");
    const ipGate = await RateLimit.hit(pool, `login_request:ip:${req.ip}`, RateLimit.LIMITS.loginRequestIp);
    if (!ipGate.allowed) return tooMany(page, req, res, ipGate);
    const phone = Onboarding.normalizeEgyptMobile(req.body.phone) || String(req.body.phone || "").replace(/\D/g, "");
    if (phone.length >= 8) {
      const phoneGate = await RateLimit.hit(pool, `login_request:phone:${phone}`, RateLimit.LIMITS.loginRequestPhone);
      if (!phoneGate.allowed) return tooMany(page, req, res, phoneGate);
      const { rows } = await pool.query(
        `SELECT id, agency_id, name, phone_number, phone_normalized, role, preferred_lang
         FROM brokers WHERE phone_normalized = $1 AND is_active = true LIMIT 1`,
        [phone]
      );
      const broker = rows[0];
      if (broker) {
        const token = await WebAuth.issueLoginToken(pool, broker, { channel: "web" });
        const lang = broker.preferred_lang || "ar";
        const sent = await notify(broker, t("web_login_link", lang, { url: Links.loginLinkUrl(token), minutes: WebAuth.LOGIN_TOKEN_TTL_MINUTES }), {
          pool,
          kind: "web_login_link",
          action: "sign_in"
        });
        logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_login_link", status: sent ? "success" : "dropped" });
      }
    }
    const pre = S.issuePreToken(req, res);
    return page(req, res, {
      title: "الدخول",
      body: loginForm({
        pre,
        next: S.safeNext(req.body.next),
        message: "📲 لو الرقم ده مسجل، هيوصلك رابط الدخول على واتساب خلال دقيقة. لو موصلش، ابعت «دخول» للبوت مباشرة."
      })
    });
  });

  web.get("/login/confirm", S.noStore, async (req, res) => {
    // The token is in this URL: never send it to another site in a Referer.
    res.set("Referrer-Policy", "no-referrer");
    const broker = await WebAuth.peekLoginToken(pool, req.query.t);
    if (!broker) return page(req, res, { title: "الرابط انتهى", body: expiredPage }, 410);
    const pre = S.issuePreToken(req, res);
    const en = broker.preferred_lang === "en";
    return page(req, res, {
      title: en ? "Sign in" : "تأكيد الدخول",
      lang: en ? "en" : "ar",
      body: html`<div class="card">
  <h1>${en ? `👋 Hello ${broker.name}` : `👋 أهلاً ${broker.name}`}</h1>
  <p>${en ? "Tap to sign in to AqarChat on this device (you stay signed in for 30 days)." : "اضغط للدخول على AqarChat من الجهاز ده (هتفضل مسجل 30 يوم)."}</p>
  <form method="post" action="/app/login/confirm">
    <input type="hidden" name="_csrf" value="${pre}">
    <input type="hidden" name="t" value="${req.query.t}">
    <button type="submit">${en ? "Sign in" : "دخول"}</button>
  </form>
</div>`
    });
  });

  web.post("/login/confirm", S.noStore, async (req, res) => {
    res.set("Referrer-Policy", "no-referrer");
    if (!S.verifyPreToken(req)) return res.status(403).send("Invalid or missing CSRF token");
    const gate = await RateLimit.hit(pool, `login_confirm:ip:${req.ip}`, RateLimit.LIMITS.loginConfirmIp);
    if (!gate.allowed) return tooMany(page, req, res, gate);
    const broker = await WebAuth.consumeLoginToken(pool, req.body.t);
    if (!broker) return page(req, res, { title: "الرابط انتهى", body: expiredPage }, 410);
    // A new session id on every sign-in (no session fixation); an older session in this browser ends.
    if (req.sid) await WebAuth.revokeSession(pool, req.sid);
    const { sid } = await WebAuth.createSession(pool, broker, { userAgent: req.get("user-agent") });
    S.setSessionCookie(res, sid);
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_login" });
    return res.redirect(303, "/app/");
  });

  web.post("/logout", S.noStore, S.requireBroker, S.verifyCsrf, async (req, res) => {
    await WebAuth.revokeSession(pool, req.sid);
    S.clearSessionCookie(res);
    return res.redirect(303, "/app/login");
  });
}

module.exports = { register };
