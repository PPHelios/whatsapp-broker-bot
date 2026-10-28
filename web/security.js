// web/security.js — Headers for every web page (CSP, framing only by Telegram Web, no referrer leaks) and the same-origin check
"use strict";

const Links = require("../lib/links");

// The chat export zip goes from the browser straight to Supabase Storage (web/routes/imports.js), so its origin may
// be fetched; nothing else outside this site.
const STORAGE_ORIGIN = (() => {
  try {
    return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : null;
  } catch {
    return null;
  }
})();

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' blob:",
  STORAGE_ORIGIN ? `connect-src 'self' ${STORAGE_ORIGIN}` : "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  // "Send to client" posts, then redirects to WhatsApp (wa.me forwards to api.whatsapp.com).
  "form-action 'self' https://wa.me https://api.whatsapp.com",
  // Telegram Web shows the Mini App (the website opened from the bot) in an iframe; nobody else may frame us.
  "frame-ancestors 'self' https://web.telegram.org",
  "manifest-src 'self'",
  "worker-src 'self'"
].join("; ");

/** Security headers for HTML pages and static files of the web app and the public pages. */
function securityHeaders(_req, res, next) {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=(self), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin"
  });
  next();
}

/**
 * Rejects state-changing requests that a browser marks as coming from another site
 * (Sec-Fetch-Site, else Origin compared with the site origin). Defence in depth next to CSRF tokens.
 */
function sameOrigin() {
  return (req, res, next) => {
    const allowed = Links.siteOrigin();
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const site = req.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return res.status(403).send("Cross-site request refused");
    const origin = req.get("origin");
    if (origin && origin !== "null" && origin !== allowed) return res.status(403).send("Cross-site request refused");
    return next();
  };
}

module.exports = { CSP, securityHeaders, sameOrigin };
