// web/index.js — The broker web app (/app/) and the site's public routes, in the same Express app
// (Release 2). Server-rendered HTML + htmx; PWA with a service worker scoped to /app/.
"use strict";

const express = require("express");
const { loadAssets } = require("./assets");
const { securityHeaders, sameOrigin } = require("./security");
const Session = require("./session");
const { html, layout, withCsrf } = require("./html");
const Notifications = require("../lib/notifications");
const ErrorReports = require("../lib/errorReports");
const { BRAND } = require("../domain/brand");

const MANIFEST = {
  name: "WehdatHub",
  short_name: "WehdatHub",
  lang: "ar",
  dir: "rtl",
  start_url: "/app/",
  scope: "/app/",
  display: "standalone",
  background_color: BRAND.colors.bg,
  theme_color: BRAND.colors.brand,
  // Android: "Share to WehdatHub" from WhatsApp opens the add-lead form with the shared text (nothing saved yet).
  share_target: { action: "/app/share", method: "GET", params: { title: "title", text: "text", url: "url" } }
};

/**
 * Mounts the web app on an Express app (after /webhook and /health).
 * @param {import("express").Express} app
 * @param {Object} deps - { pool, config }
 * @returns {{ assets }}
 */
function mountWeb(app, { pool, config }) {
  const assets = loadAssets();
  /** Renders a full page; the signed-in broker (top bar, language) and CSRF token come from req. */
  const page = (req, res, opts, status = 200) => {
    const s = req.session;
    const lang = opts.lang || (s ? (s.broker.preferred_lang === "en" ? "en" : "ar") : req.lang === "en" ? "en" : "ar");
    return res
      .status(status)
      .type("html")
      .send(withCsrf(layout({ assets: assets.url, broker: s?.broker || null, csrf: s?.csrf || null, unread: s?.unread || 0, path: String(req.originalUrl || ""), ...opts, lang }), s?.csrf));
  };
  // Behind Render's proxy, req.ip is the client from X-Forwarded-For (rate limits).
  if (config.isProd) app.set("trust proxy", 1);

  app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /app/\n"));

  const web = express.Router();
  web.use(securityHeaders);
  web.use(sameOrigin());
  web.use(express.urlencoded({ extended: false, limit: config.bodyLimit, parameterLimit: 500 }));

  web.get("/static/*file", (req, res) => {
    const name = [].concat(req.params.file).join("/");
    const f = assets.files[name];
    if (!f) return res.sendStatus(404);
    res.set("Cache-Control", req.query.v === f.hash ? "public, max-age=31536000, immutable" : "no-cache");
    return res.type(f.type).send(f.body);
  });

  web.get("/manifest.webmanifest", (_req, res) => {
    res.type("application/manifest+json").send(
      JSON.stringify({
        ...MANIFEST,
        icons: [
          { src: assets.url("icons/icon-192.png"), sizes: "192x192", type: "image/png" },
          { src: assets.url("icons/icon-512.png"), sizes: "512x512", type: "image/png" },
          { src: assets.url("icons/maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: assets.url("icons/icon.svg"), sizes: "any", type: "image/svg+xml" }
        ]
      })
    );
  });

  web.get("/sw.js", (_req, res) => {
    res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/app/" });
    res.type("application/javascript").send(assets.swSource);
  });

  web.get("/offline", (req, res) =>
    page(req, res, {
      title: "غير متصل / Offline",
      body: html`<div class="card notice"><h1>📴 مفيش اتصال بالإنترنت</h1><p>الصفحة دي محتاجة إنترنت. أول ما الاتصال يرجع، حاول تاني.</p><p class="muted" lang="en" dir="ltr">You are offline. This page needs a connection.</p></div>`
    })
  );

  const ctx = { pool, config, assets, page };
  const pages = require("./routes");
  web.use(Session.loadSession(pool));
  // P7: ?lang=ar|en on any page switches the language: a cookie before sign-in, the broker's preferred_lang after.
  web.use(async (req, res, next) => {
    try {
      const q = req.method === "GET" ? req.query.lang : null;
      if (q === "ar" || q === "en") {
        res.cookie("aq_lang", q, { path: "/app", maxAge: 365 * 24 * 3600 * 1000, sameSite: "lax", secure: Boolean(config.isProd), httpOnly: true });
        req.cookies.aq_lang = q;
        if (req.session && req.session.broker.preferred_lang !== q) {
          await pool.query("UPDATE brokers SET preferred_lang = $2 WHERE id = $1 AND agency_id = $3", [req.session.broker.id, q, req.session.broker.agency_id]);
          req.session.broker.preferred_lang = q;
        }
      }
      req.lang = req.session ? (req.session.broker.preferred_lang === "en" ? "en" : "ar") : req.cookies.aq_lang === "en" ? "en" : "ar";
      next();
    } catch (err) {
      next(err);
    }
  });
  // Sign-in pages are open; everything after them needs a session and a CSRF token on writes.
  for (const p of pages.PUBLIC) p.register(web, ctx);
  const priv = express.Router();
  priv.use(Session.noStore, Session.requireBroker, Session.verifyCsrf);
  // The 🔔 count in the top bar (pages only; htmx partials don't render the bar).
  priv.use(async (req, _res, next) => {
    if (req.method === "GET" && !req.get("HX-Request")) {
      req.session.unread = await Notifications.unreadCount(pool, req.session.broker).catch(() => 0);
    }
    next();
  });
  for (const p of pages.PRIVATE) p.register(priv, ctx);
  web.use(priv);

  web.use((req, res) =>
    req.lang === "en"
      ? page(req, res, { title: "Not found", body: html`<div class="card"><h1>🔍 Page not found</h1><p><a href="/app/">Home</a></p></div>` }, 404)
      : page(req, res, { title: "غير موجود", body: html`<div class="card"><h1>🔍 الصفحة غير موجودة</h1><p><a href="/app/">الرئيسية</a></p></div>` }, 404)
  );
  // eslint-disable-next-line no-unused-vars
  web.use(async (err, req, res, _next) => {
    // Path only (query strings may carry tokens); the owner is alerted with the broker and the page. A 4xx (a too-large
    // or broken body) is the request's fault, not a bug.
    const ours = !(err.status >= 400 && err.status < 500);
    const id = ours ? await ErrorReports.capture(err, { pool, source: "web", broker: req.session?.broker || null, path: `${req.method} ${req.baseUrl}${req.path}` }) : null;
    const ref = id ? ` #E${id}` : "";
    const report = req.session ? html`<p><a href="/app/report?from=${encodeURIComponent(req.baseUrl + req.path)}">${req.lang === "en" ? "🐞 Report a problem" : "🐞 بلّغ عن مشكلة"}</a></p>` : "";
    req.lang === "en"
      ? page(req, res, { title: "Error", body: html`<div class="card notice bad"><h1>❌ A temporary error${ref}</h1><p>Try again in a moment.</p>${report}</div>` }, 500)
      : page(req, res, { title: "خطأ", body: html`<div class="card notice bad"><h1>❌ حصل خطأ مؤقت${ref}</h1><p>حاول تاني بعد شوية.</p>${report}</div>` }, 500);
  });

  // "/app" without the slash is outside the service worker scope; routing is not strict, so check the raw URL.
  app.get("/app", (req, res, next) => (/^\/app(\?|$)/.test(req.originalUrl) ? res.redirect(301, "/app/") : next()));
  app.use("/app", web);
  // The landing page at / and its "try it" form (phase 2 step 3).
  require("./routes/landing").mountLanding(app, { pool, assets });
  // Public unit pages last: /<agency-slug>/<unit-code>?s=<token> (reserved slugs never reach them).
  require("./routes/publicUnit").mountPublic(app, { pool, assets });
  return { assets };
}

module.exports = { MANIFEST, mountWeb };
