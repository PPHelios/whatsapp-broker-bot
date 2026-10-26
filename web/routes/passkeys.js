// web/routes/passkeys.js — Passkeys in Settings (Release B, R6): the user's own on/off switch (off by default; off
// removes their passkeys), adding a passkey on this device (web/static/app.js runs navigator.credentials.create with
// the options from here) and removing one. Signing in with a passkey is on the sign-in page (web/routes/auth.js).
"use strict";

const Passkeys = require("../../services/passkeys");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

/** The Settings card. */
function passkeySection({ enabled, keys, lang, notice = null }) {
  return html`<section class="card stack" id="passkeys" data-passkeys-enabled="${enabled ? "yes" : "no"}">
  <h2>🔑 ${L(lang, "الدخول بالبصمة أو الوش (Passkey)", "Sign in with a passkey")}</h2>
  <p class="muted">${L(lang, "بدل رابط البوت، تدخل الموقع ببصمة صباعك أو وشك أو قفل الشاشة. مقفولة لحد ما تفتحها؛ لو قفلتها، كل الـ Passkeys بتاعتك بتتمسح.", "Instead of a bot link, sign in with your fingerprint, face or screen lock. Off until you turn it on; turning it off removes all your passkeys.")}</p>
  ${notice ? html`<p class="notice" data-passkey-notice>${notice}</p>` : ""}
  <form method="post" action="/app/settings/passkey" class="row">
    <input type="hidden" name="enabled" value="${enabled ? "" : "on"}">
    <button type="submit" class="${enabled ? "secondary" : ""}">${enabled ? L(lang, "اقفل الدخول بالـ Passkey", "Turn passkeys off") : L(lang, "افتح الدخول بالـ Passkey", "Turn passkeys on")}</button>
  </form>
  ${enabled
    ? html`<div class="row"><button type="button" data-passkey-register>➕ ${L(lang, "ضيف Passkey على الجهاز ده", "Add a passkey on this device")}</button></div>
  <p class="muted" data-passkey-status></p>
  ${keys.length
    ? html`<ul>${keys.map((k) => html`<li data-passkey="${k.id}">${k.label || L(lang, "جهاز", "Device")} · ${L(lang, "اتضاف", "added")} ${day(k.created_at)} · ${L(lang, "آخر دخول", "last used")} ${day(k.last_used_at)}
      <form method="post" action="/app/passkeys/${k.id}/remove" class="inline"><button type="submit" class="secondary">${L(lang, "امسح", "Remove")}</button></form></li>`)}</ul>`
    : html`<p class="muted">${L(lang, "مفيش Passkeys لسه.", "No passkeys yet.")}</p>`}`
    : ""}
</section>`;
}

/** A short device label from the browser's user agent. */
function labelOf(ua) {
  const s = String(ua || "");
  const os = /iPhone|iPad/.test(s) ? "iPhone/iPad" : /Android/.test(s) ? "Android" : /Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : "Device";
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "";
  return br ? `${os} · ${br}` : os;
}

function register(web, { pool }) {
  web.post("/settings/passkey", async (req, res) => {
    const on = req.body.enabled === "on";
    await Passkeys.setEnabled(pool, req.session.broker, on);
    return res.redirect(303, `/app/settings?passkey=${on ? "on" : "off"}#passkeys`);
  });

  web.post("/passkey/register/options", async (req, res) => {
    const out = await Passkeys.registerOptions(pool, req.session.broker);
    return out.error ? res.status(400).json(out) : res.json(out);
  });

  web.post("/passkey/register", async (req, res) => {
    const b = req.body || {};
    const out = await Passkeys.register(pool, req.session.broker, { credentialId: b.credentialId, clientDataJSON: b.clientDataJSON, authenticatorData: b.authenticatorData, publicKey: b.publicKey, alg: b.alg }, { label: labelOf(req.get("user-agent")) });
    return out.error ? res.status(400).json(out) : res.json(out);
  });

  web.post("/passkeys/:id/remove", async (req, res) => {
    await Passkeys.remove(pool, req.session.broker, req.params.id);
    return res.redirect(303, "/app/settings?passkey=removed#passkeys");
  });
}

module.exports = { register, passkeySection, labelOf };
