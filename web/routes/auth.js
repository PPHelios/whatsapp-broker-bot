// web/routes/auth.js — Magic-link sign-in. The link (from WhatsApp) opens a confirm page (GET, uses
// nothing), whose button signs in with a POST: link previews and scanners can never use the token.
"use strict";

const WebAuth = require("../../lib/webAuth");
const RateLimit = require("../../lib/rateLimit");
const Links = require("../../lib/links");
const Onboarding = require("../../lib/onboarding");
const { notifyPreferred } = require("../../lib/dispatcher");
const { logOperation } = require("../../lib/db");
const { t } = require("../../lib/copy");
const TgInit = require("../../domain/tgInitData");
const TgLink = require("../../lib/tgLink");
const Passkeys = require("../../services/passkeys");
const S = require("../session");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);

const tooMany = (page, req, res, gate) => {
  res.set("Retry-After", String(gate.retryAfterSec));
  const lang = req.lang;
  return page(
    req,
    res,
    { title: L(lang, "محاولات كتير", "Too many attempts"), langSwitch: true, body: html`<div class="card notice bad"><h1>⏳ ${L(lang, "محاولات كتير", "Too many attempts")}</h1><p>${L(lang, "استنى شوية وحاول تاني.", "Wait a little and try again.")}</p></div>` },
    429
  );
};

function loginForm({ pre, next, message = null, lang = "ar" }) {
  return html`<div class="card">
  <h1>🔐 ${L(lang, "الدخول", "Sign in")}</h1>
  ${message ? html`<p class="notice card">${message}</p>` : ""}
  <p>${lang === "en" ? html`Send <strong>"login"</strong> to the WehdatHub bot (Telegram, or WhatsApp) and you'll get a sign-in link right away. Inside Telegram, the WehdatHub button opens the website already signed in.` : html`ابعت <strong>«دخول»</strong> لبوت WehdatHub (على تليجرام أو واتساب)، وهيوصلك رابط الدخول على طول. ومن جوه تليجرام، زرار WehdatHub بيفتح الموقع وانت داخل على طول.`}</p>
  <p>${L(lang, "أو اكتب رقم الموبايل المسجل وهنبعتلك الرابط على البوت:", "Or enter your registered mobile number and we'll send the link through the bot:")}</p>
  <form method="post" action="/app/login" class="stack">
    <input type="hidden" name="_csrf" value="${pre}">
    <input type="hidden" name="next" value="${next}">
    <label>${L(lang, "رقم الموبايل", "Mobile number")} <input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="01012345678" dir="ltr"></label>
    <button type="submit">${L(lang, "ابعتلي رابط الدخول", "Send me a sign-in link")}</button>
  </form>
  <div id="passkey-login" class="stack" data-csrf="${pre}" data-next="${next}" hidden>
    <p>${L(lang, "أو لو فعّلت الدخول بالبصمة/الوش من الإعدادات:", "Or, if you turned on passkeys in Settings:")}</p>
    <button type="button" class="secondary" data-passkey-login>🔑 ${L(lang, "ادخل بالبصمة أو الوش (Passkey)", "Sign in with a passkey")}</button>
    <p class="muted" data-passkey-status></p>
  </div>
</div>`;
}

const expiredPage = (lang) => html`<div class="card notice bad">
  <h1>⌛ ${L(lang, "الرابط ده انتهى أو اتستخدم قبل كده", "This link has expired or was already used")}</h1>
  <p>${lang === "en" ? html`Send <strong>"login"</strong> to the WehdatHub bot for a new link.` : html`ابعت <strong>«دخول»</strong> لبوت WehdatHub عشان يوصلك رابط جديد.`}</p>
  <p><a href="/app/login">${L(lang, "صفحة الدخول", "Sign-in page")}</a></p>
</div>`;

function register(web, { pool, page }) {
  web.get("/login", S.noStore, (req, res) => {
    if (req.session) return res.redirect(303, S.safeNext(req.query.next));
    const pre = S.issuePreToken(req, res);
    return page(req, res, { title: L(req.lang, "الدخول", "Sign in"), langSwitch: true, body: loginForm({ pre, next: S.safeNext(req.query.next), lang: req.lang }) });
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
        const sent = await notifyPreferred(broker, t("web_login_link", lang, { url: Links.loginLinkUrl(token), minutes: WebAuth.LOGIN_TOKEN_TTL_MINUTES }), {
          pool,
          kind: "web_login_link",
          action: "sign_in"
        });
        logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_login_link", status: sent ? "success" : "dropped" });
      }
    }
    const pre = S.issuePreToken(req, res);
    return page(req, res, {
      title: L(req.lang, "الدخول", "Sign in"),
      langSwitch: true,
      body: loginForm({
        pre,
        next: S.safeNext(req.body.next),
        lang: req.lang,
        message: L(
          req.lang,
          "📲 لو الرقم ده مسجل، هيوصلك رابط الدخول على البوت (تليجرام أو واتساب) خلال دقيقة. لو موصلش، ابعت «دخول» للبوت مباشرة.",
          "📲 If this number is registered, a sign-in link reaches you through the bot (Telegram or WhatsApp) within a minute. If not, send \"login\" to the bot directly."
        )
      })
    });
  });

  // Mini App: the website opened from the Telegram bot. The page hands Telegram's signed initData (from the URL
  // fragment, which never reaches us otherwise) to POST /tg/session, which signs the linked broker in.
  web.get("/tg", S.noStore, (req, res) =>
    page(req, res, {
      title: "WehdatHub",
      body: html`<div class="card" id="tg-signin" data-next="${S.safeNext(req.query.next)}">
  <h1>⏳ ${L(req.lang, "بنفتح WehdatHub…", "Opening WehdatHub…")}</h1>
  <p class="muted" data-tg-status hidden>${L(
    req.lang,
    "افتح الموقع من زرار WehdatHub في بوت تليجرام، أو ادخل برابط «دخول».",
    "Open the website from the WehdatHub button in the Telegram bot, or sign in with a \"login\" link."
  )} <a href="/app/login">${L(req.lang, "الدخول", "Sign in")}</a></p>
</div>`
    })
  );

  web.post("/tg/session", S.noStore, async (req, res) => {
    const gate = await RateLimit.hit(pool, `login_confirm:ip:${req.ip}`, RateLimit.LIMITS.loginConfirmIp);
    if (!gate.allowed) return res.status(429).json({ error: "too_many" });
    const v = TgInit.verify(String(req.body.initData || ""), process.env.TELEGRAM_BOT_TOKEN || "");
    if (!v) return res.status(403).json({ error: "invalid" });
    // Each signed initData signs in once (a copied one can't be replayed within its hour).
    const once = await RateLimit.hit(pool, `tg_initdata:${v.hash}`, { limit: 1, windowSec: TgInit.MAX_AGE_SEC });
    if (!once.allowed) return res.status(403).json({ error: "used" });
    const broker = await TgLink.findBroker(pool, v.userId);
    if (!broker) return res.status(403).json({ error: "not_linked" });
    if (req.sid) await WebAuth.revokeSession(pool, req.sid);
    const { sid } = await WebAuth.createSession(pool, broker, { userAgent: req.get("user-agent") });
    S.setSessionCookie(res, sid, { crossSite: req.body.framed === "1" });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_login_telegram" });
    return res.json({ next: S.safeNext(req.body.next) });
  });

  // R6: passkey sign-in (services/passkeys.js). Same double-submit token as the sign-in form, rate-limited by IP.
  web.post("/passkey/login/options", S.noStore, async (req, res) => {
    if (!S.verifyPreToken(req)) return res.status(403).json({ error: "csrf" });
    const gate = await RateLimit.hit(pool, `login_confirm:ip:${req.ip}`, RateLimit.LIMITS.loginConfirmIp);
    if (!gate.allowed) return res.status(429).json({ error: "too_many" });
    return res.json(await Passkeys.loginOptions(pool));
  });

  web.post("/passkey/login", S.noStore, async (req, res) => {
    if (!S.verifyPreToken(req)) return res.status(403).json({ error: "csrf" });
    const b = req.body || {};
    const out = await Passkeys.login(pool, { credentialId: b.credentialId, clientDataJSON: b.clientDataJSON, authenticatorData: b.authenticatorData, signature: b.signature, userHandle: b.userHandle || null });
    if (out.error) {
      logOperation(pool, { operation_type: "web_login_passkey", status: "failed", error_code: out.error });
      return res.status(403).json({ error: out.error });
    }
    if (req.sid) await WebAuth.revokeSession(pool, req.sid);
    const { sid } = await WebAuth.createSession(pool, out.broker, { userAgent: req.get("user-agent") });
    S.setSessionCookie(res, sid);
    logOperation(pool, { agency_id: out.broker.agency_id, broker_id: out.broker.id, operation_type: "web_login_passkey" });
    return res.json({ next: S.safeNext(b.next) });
  });

  web.get("/login/confirm", S.noStore, async (req, res) => {
    // The token is in this URL: never send it to another site in a Referer.
    res.set("Referrer-Policy", "no-referrer");
    const broker = await WebAuth.peekLoginToken(pool, req.query.t);
    if (!broker) return page(req, res, { title: L(req.lang, "الرابط انتهى", "Link expired"), langSwitch: true, body: expiredPage(req.lang) }, 410);
    const pre = S.issuePreToken(req, res);
    const en = broker.preferred_lang === "en";
    return page(req, res, {
      title: en ? "Sign in" : "تأكيد الدخول",
      lang: en ? "en" : "ar",
      body: html`<div class="card">
  <h1>${en ? `👋 Hello ${broker.name}` : `👋 أهلاً ${broker.name}`}</h1>
  <p>${en ? "Tap to sign in to WehdatHub on this device (you stay signed in for 30 days)." : "اضغط للدخول على WehdatHub من الجهاز ده (هتفضل مسجل 30 يوم)."}</p>
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
    if (!broker) return page(req, res, { title: L(req.lang, "الرابط انتهى", "Link expired"), langSwitch: true, body: expiredPage(req.lang) }, 410);
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
