// web/routes/report.js — "Report a problem" (a broker's bug report to the owner) and the browser's script errors
"use strict";

const ErrorReports = require("../../lib/errorReports");
const RateLimit = require("../../lib/rateLimit");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");

/** The page the broker came from (path only: query strings may carry tokens). */
function fromPath(req) {
  const v = String(req.query.from || req.body?.from || "");
  if (/^\/app\/[\w\-./]*$/.test(v)) return v.slice(0, 200);
  try {
    const ref = new URL(req.get("referer") || "");
    return ref.pathname.startsWith("/app/") && ref.pathname !== "/app/report" ? ref.pathname.slice(0, 200) : "";
  } catch {
    return "";
  }
}

function form(lang, { from, text = "", error = null }) {
  return html`<h1>🐞 ${L(lang, "بلّغ عن مشكلة", "Report a problem")}</h1>
<form method="post" action="/app/report" class="card stack">
  <p class="muted">${L(lang, "اكتب اللي حصل واللي كنت متوقعه. بنشوف كل بلاغ ونرد عليك.", "Tell us what happened and what you expected. We read every report.")}</p>
  ${error ? html`<p class="notice bad">${error}</p>` : ""}
  <textarea name="text" rows="6" maxlength="1000" required>${text}</textarea>
  <input type="hidden" name="from" value="${from}">
  <button type="submit">${L(lang, "ابعت البلاغ", "Send report")}</button>
</form>`;
}

function register(web, { pool, page }) {
  web.get("/report", (req, res) => {
    const lang = langOf(req);
    return page(req, res, { title: L(lang, "بلّغ عن مشكلة", "Report a problem"), body: form(lang, { from: fromPath(req) }) });
  });

  web.post("/report", async (req, res) => {
    const lang = langOf(req);
    const title = L(lang, "بلّغ عن مشكلة", "Report a problem");
    const text = String(req.body?.text || "").trim();
    const from = fromPath(req);
    if (text.length < 3) return page(req, res, { title, body: form(lang, { from, text, error: L(lang, "اكتب وصف المشكلة.", "Please describe the problem.") }) }, 400);
    const r = await ErrorReports.submitReport(pool, req.session.broker, { text, channel: "web", path: from || null, userAgent: req.get("user-agent") });
    if (r.limited) return page(req, res, { title, body: form(lang, { from, text, error: L(lang, "بعت بلاغات كتير الساعة دي، حاول تاني بعد شوية.", "Too many reports this hour; try again later.") }) }, 429);
    return page(req, res, {
      title,
      body: html`<div class="card notice"><h1>✅ ${L(lang, "وصلنا البلاغ", "Report sent")} #R${r.id}</h1><p>${L(lang, "شكراً! هنبص عليه في أقرب وقت.", "Thank you! We'll look into it soon.")}</p><p><a href="${from || "/app/"}">${L(lang, "ارجع", "Back")}</a></p></div>`
    });
  });

  // Script errors in the broker's browser (web/static/app.js): stored and alerted like server errors, 20 an hour.
  web.post("/client-error", async (req, res) => {
    const broker = req.session.broker;
    const limit = await RateLimit.hit(pool, `client_error:${broker.id}`, { limit: 20, windowSec: 3600 }).catch(() => ({ allowed: false }));
    if (!limit.allowed) return res.sendStatus(204);
    const b = req.body || {};
    const file = String(b.file || "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "").slice(0, 120);
    const err = { name: "ClientError", message: String(b.message || "unknown").slice(0, 500), stack: b.stack ? String(b.stack).slice(0, 2000) : null };
    await ErrorReports.capture(err, {
      pool,
      source: "client",
      broker,
      path: String(b.page || "").replace(/\?.*$/, "").slice(0, 200) || null,
      metadata: { frame: file ? `${file}:${Number(b.line) || 0}` : null, userAgent: String(req.get("user-agent") || "").slice(0, 200) }
    });
    return res.sendStatus(204);
  });
}

module.exports = { register };
