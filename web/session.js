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

const cookieOpts = (maxAgeMs) => ({ httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: maxAgeMs });

function setSessionCookie(res, sid) {
  res.cookie(SESSION_COOKIE(), sid, cookieOpts(WebAuth.SESSION_DAYS * 24 * 3600 * 1000));
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
  return res.status(401).send("Sign in first");
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
  return res.status(403).send("Invalid or missing CSRF token");
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
  allowMultipart,
  csrfAfterParse,
  issuePreToken,
  verifyPreToken,
  safeNext
};
