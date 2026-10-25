// web/html.js — Server-side HTML: an escaping tagged template and the page layout (RTL by default)
"use strict";

class SafeHtml {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Escapes text for HTML content and quoted attributes. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(value);
}

/** html`<p>${text}</p>`: every interpolated value is escaped unless it is already SafeHtml (or an array of it). */
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Marks trusted markup (never use on user input). */
const raw = (text) => new SafeHtml(String(text ?? ""));

/** JSON text for an attribute; html`` escapes it once when interpolated. */
const jsonAttr = (obj) => JSON.stringify(obj);

const HTMX_CONFIG = { includeIndicatorStyles: false, allowEval: false, allowScriptTags: false, selfRequestsOnly: true, historyCacheSize: 0 };

/**
 * Full page. lang "ar" renders RTL; assets(name) gives the versioned static path.
 * @param {Object} p - { title, lang, body, assets, csrf, broker, nav, head, robots, unread }
 */
function layout({ title, lang = "ar", body, assets, csrf = null, broker = null, nav = null, head = null, robots = "noindex, nofollow", scripts = true, manifest = true, unread = 0 }) {
  const en = lang === "en";
  return html`<!doctype html>
<html lang="${en ? "en" : "ar"}" dir="${en ? "ltr" : "rtl"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="#0B132B">
<meta name="htmx-config" content="${jsonAttr(HTMX_CONFIG)}">
${csrf ? html`<meta name="csrf-token" content="${csrf}">` : ""}
<title>${title ? `${title} · AqarChat` : "AqarChat"}</title>
${manifest ? html`<link rel="manifest" href="/app/manifest.webmanifest">` : ""}
<link rel="icon" href="${assets("icons/icon.svg")}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${assets("icons/icon-192.png")}">
<link rel="stylesheet" href="${assets("app.css")}">
${head || ""}
${scripts ? html`<script src="${assets("htmx.min.js")}" defer></script>
<script src="${assets("app.js")}" defer></script>` : ""}
</head>
<body>
${broker || nav ? topBar({ broker, nav, lang, unread }) : ""}
<main id="main">${body}</main>
</body>
</html>`;
}

const NAV = [
  { key: "search", href: "/app/search", ar: "🔍 بحث", en: "🔍 Search" },
  { key: "units", href: "/app/units", ar: "🏠 الوحدات", en: "🏠 Units" },
  { key: "leads", href: "/app/leads", ar: "👤 العملاء", en: "👤 Leads" },
  { key: "deals", href: "/app/deals", ar: "🤝 الصفقات", en: "🤝 Deals" },
  { key: "add", href: "/app/units/new", ar: "➕ إضافة", en: "➕ Add" },
  { key: "import", href: "/app/import", ar: "📥 استيراد", en: "📥 Import" }
];

function topBar({ broker, nav, lang, unread = 0 }) {
  const en = lang === "en";
  return html`<header class="top">
  <a class="brand" href="/app/">AqarChat</a>
  ${broker
    ? html`<nav class="nav">${NAV.map(
        (n) => html`<a href="${n.href}"${n.key === nav ? raw(' aria-current="page"') : ""}>${en ? n.en : n.ar}</a>`
      )}</nav>
  <a class="bell" href="/app/notifications" aria-label="${en ? "Notifications" : "التنبيهات"}"${nav === "notifications" ? raw(' aria-current="page"') : ""}>🔔${unread ? html`<span class="badge" data-unread="${unread}">${unread > 99 ? "99+" : unread}</span>` : ""}</a>
  <a href="/app/settings" aria-label="${en ? "Settings" : "الإعدادات"}"${nav === "settings" ? raw(' aria-current="page"') : ""}>⚙️</a>
  <form method="post" action="/app/logout" class="logout"><button type="submit" class="link">${en ? "Sign out" : "خروج"}</button></form>`
    : ""}
</header>`;
}

module.exports = { SafeHtml, html, raw, escapeHtml, jsonAttr, layout, NAV, HTMX_CONFIG };
