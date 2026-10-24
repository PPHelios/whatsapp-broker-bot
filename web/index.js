// web/index.js — The broker web app (/app/) and the site's public routes, in the same Express app
// (Release 2). Server-rendered HTML + htmx; PWA with a service worker scoped to /app/.
"use strict";

const express = require("express");
const { loadAssets } = require("./assets");
const { securityHeaders, sameOrigin } = require("./security");
const { html, layout } = require("./html");

const MANIFEST = {
  name: "AqarChat",
  short_name: "AqarChat",
  lang: "ar",
  dir: "rtl",
  start_url: "/app/",
  scope: "/app/",
  display: "standalone",
  background_color: "#f6f7f9",
  theme_color: "#0B132B"
};

/**
 * Mounts the web app on an Express app (after /webhook and /health).
 * @param {import("express").Express} app
 * @param {Object} deps - { pool, config }
 * @returns {{ assets }}
 */
function mountWeb(app, { pool, config }) {
  const assets = loadAssets();
  const page = (res, opts, status = 200) =>
    res.status(status).type("html").send(String(layout({ assets: assets.url, ...opts })));

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

  web.get("/offline", (_req, res) =>
    page(res, {
      title: "غير متصل",
      body: html`<div class="card notice"><h1>📴 مفيش اتصال بالإنترنت</h1><p>الصفحة دي محتاجة إنترنت. أول ما الاتصال يرجع، حاول تاني.</p><p class="muted">You are offline. This page needs a connection.</p></div>`
    })
  );

  // Pages added by later steps register here (login, search, units, import).
  const ctx = { pool, config, assets, page };
  for (const p of require("./routes").PAGES) p.register(web, ctx);

  web.use((_req, res) =>
    page(res, { title: "غير موجود", body: html`<div class="card"><h1>🔍 الصفحة غير موجودة</h1><p><a href="/app/">الرئيسية</a></p></div>` }, 404)
  );

  // "/app" without the slash is outside the service worker scope; routing is not strict, so check the raw URL.
  app.get("/app", (req, res, next) => (/^\/app(\?|$)/.test(req.originalUrl) ? res.redirect(301, "/app/") : next()));
  app.use("/app", web);
  return { assets };
}

module.exports = { MANIFEST, mountWeb };
