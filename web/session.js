// web/session.js — Session cookie, signed-in broker on req, CSRF checks and sign-in gate for /app/
"use strict";

const WebAuth = require("../lib/webAuth");
const Links = require("../lib/links");

const secure = () => Links.siteOrigin().startsWith("https:");
// __Host- cookies are bound to this host, Path=/ and Secure (https only).
const SESSION_COOKIE = () => (secure() ? "__Host-aq_sid" : "aq_sid");
const PRE_COOKIE = () => (secure() ? "__Host-aq_pre" : "aq_pre");

/** Cookie header → { name: value }. */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// crossSite: the website inside Telegram Web's iframe (Mini App) only gets its cookie with SameSite=None (https only).
const cookieOpts = (maxAgeMs, { crossSite = false } = {}) => ({
  httpOnly: true,
  sameSite: crossSite && secure() ? "none" : "lax",
  secure: secure(),
  path: "/",
  maxAge: maxAgeMs
});

function setSessionCookie(res, sid, { crossSite = false } = {}) {
  res.cookie(SESSION_COOKIE(), sid, cookieOpts(WebAuth.SESSION_DAYS * 24 * 3600 * 1000, { crossSite }));
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE(), { path: "/", secure: secure(), sameSite: "lax", httpOnly: true });
}

/** Loads req.session = { broker, agency, csrf } from the cookie (or null). */
function loadSession(pool) {
  return async (req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    req.sid = req.cookies[SESSION_COOKIE()] || null;
    try {
      req.session = req.sid ? await WebAuth.getSession(pool, req.sid) : null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Private pages: never cached by the browser or a proxy. */
function noStore(_req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

/** Signed-in brokers only. Pages redirect to the sign-in page (htmx via HX-Redirect); other requests get 401. */
function requireBroker(req, res, next) {
  if (req.session) return next();
  const back = req.method === "GET" ? `?next=${encodeURIComponent(req.originalUrl)}` : "";
  if (req.get("HX-Request")) {
    res.set("HX-Redirect", `/app/login${back}`);
    return res.sendStatus(401);
  }
  if (req.method === "GET") return res.redirect(303, `/app/login${back}`);
  // A form left open after the session ended: sign in, then back to the page the form was on.
  const from = sameSiteReferer(req);
  if (from) return res.redirect(303, `/app/login?next=${encodeURIComponent(from)}`);
  return res.status(401).send("Sign in first");
}

/** The /app/ path of a same-site Referer (or null). */
function sameSiteReferer(req) {
  try {
    const u = new URL(req.get("Referer") || "");
    if (u.origin !== Links.siteOrigin() && u.hostname !== String(req.get("host") || "").replace(/:\d+$/, "")) return null;
    const p = u.pathname + u.search;
    return safeNext(p) === p ? p : null;
  } catch {
    return null;
  }
}

/**
 * A write with an old token (the page was open before a new sign-in): htmx reloads the page so it gets the current
 * token; a plain form gets a short page with a link back instead of a bare error.
 */
function staleToken(req, res) {
  if (req.get("HX-Request")) {
    res.set("HX-Refresh", "true");
    return res.status(403).send("Invalid or missing CSRF token");
  }
  const en = req.lang === "en";
  const back = sameSiteReferer(req) || "/app/";
  const t = en
    ? ["Page out of date", "This page was open from an earlier sign-in, so nothing was saved.", "Open the page again and retry"]
    : ["الصفحة قديمة", "الصفحة دي كانت مفتوحة من دخول قديم، فما اتحفظش حاجة.", "افتح الصفحة تاني وجرّب"];
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return res
    .status(403)
    .type("html")
    .send(`<!doctype html><html lang="${en ? "en" : "ar"}" dir="${en ? "ltr" : "rtl"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t[0]}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem"><h1>⌛ ${t[0]}</h1><p>${t[1]}</p><p><a href="${esc(back)}">${t[2]}</a></p><!-- Invalid or missing CSRF token --></body></html>`);
}

// Routes that parse multipart bodies with web/uploads.js; only there may the form field be checked
// after parsing (a plain multipart POST anywhere else without the header is refused).
const MULTIPART_ROUTES = [];
function allowMultipart(re) {
  MULTIPART_ROUTES.push(re);
}

/** Every state-changing request of a signed-in broker must carry the session's CSRF token. */
function verifyCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const header = req.get("X-CSRF-Token");
  if (!header && req.is("multipart/form-data") && MULTIPART_ROUTES.some((re) => re.test(req.path))) {
    req.csrfDeferred = true; // checked by web/uploads.js once the body is parsed
    return next();
  }
  const sent = header || req.body?._csrf;
  if (req.session && WebAuth.safeEqual(sent, req.session.csrf)) return next();
  return staleToken(req, res);
}

/** The deferred multipart check (form field _csrf). */
function csrfAfterParse(req) {
  return !req.csrfDeferred || Boolean(req.session && WebAuth.safeEqual(req.body?._csrf, req.session.csrf));
}

/** Pre-session CSRF (sign-in forms): a random cookie that the form must echo (double submit). */
function issuePreToken(req, res) {
  let token = req.cookies?.[PRE_COOKIE()];
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
    token = WebAuth.randomToken(24);
    res.cookie(PRE_COOKIE(), token, cookieOpts(3600 * 1000));
  }
  return token;
}
function verifyPreToken(req) {
  return WebAuth.safeEqual(req.body?._csrf, req.cookies?.[PRE_COOKIE()]);
}

/** Only same-site paths are accepted as a post-sign-in target. */
function safeNext(next) {
  const n = String(next || "");
  return /^\/app\/[^\\]*$/.test(n) && !n.startsWith("//") && !/^\/app\/log(in|out)/.test(n) ? n : "/app/";
}

module.exports = {
  SESSION_COOKIE,
  PRE_COOKIE,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  loadSession,
  noStore,
  requireBroker,
  verifyCsrf,
  staleToken,
  allowMultipart,
  csrfAfterParse,
  issuePreToken,
  verifyPreToken,
  safeNext
};
