// web/routes/publicUnit.js — Public unit pages for clients: /<agency-slug>/<unit-code>?s=<share-token>.
// Rendered only from domain/publicUnit.js (the allowlist serializer); noindex; OG tags for link previews;
// a real client's open alerts the broker who shared the link.
"use strict";

const Share = require("../../lib/shareLinks");
const RateLimit = require("../../lib/rateLimit");
const Links = require("../../lib/links");
const PublicUnit = require("../../domain/publicUnit");
const { RESERVED_SLUGS } = require("../../domain/slug");
const Session = require("../session");
const { securityHeaders } = require("../security");
const { html, layout } = require("../html");

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{1,29}$/;
const L = (lang, ar, en) => (lang === "en" ? en : ar);

function ogTags(u, url) {
  return html`<meta property="og:type" content="website">
<meta property="og:title" content="${u.og.title}">
<meta property="og:description" content="${u.og.description}">
${u.og.image ? html`<meta property="og:image" content="${u.og.image}">` : ""}
<meta property="og:url" content="${url}">
<meta property="og:locale" content="${u.lang === "en" ? "en_US" : "ar_EG"}">
${u.agency.name ? html`<meta property="og:site_name" content="${u.agency.name}">` : ""}
<meta name="twitter:card" content="${u.og.image ? "summary_large_image" : "summary"}">`;
}

function unitBody(u, { otherLangUrl }) {
  const lang = u.lang;
  if (u.status !== "active") {
    return html`<article class="card" data-public-unit="${u.code}">
  <h1>${L(lang, "الوحدة دي مبقتش متاحة", "This unit is no longer available")}</h1>
  <p>${L(lang, "تواصل مع الوكالة لوحدات مشابهة.", "Contact the agency for similar units.")}</p>
  ${u.agency.name ? html`<p><strong>${u.agency.name}</strong>${u.agency.phone ? html` · <a href="tel:${u.agency.phone}" dir="ltr">${u.agency.phone}</a>` : ""}</p>` : ""}
</article>`;
  }
  const wa = u.contact?.phone ? `https://wa.me/${u.contact.phone.replace(/\D/g, "")}?text=${encodeURIComponent(`${L(lang, "استفسار عن الوحدة", "About unit")} ${u.code}`)}` : null;
  return html`<article class="card" data-public-unit="${u.code}">
  <header class="row">
    ${u.agency.logo_url ? html`<img class="logo" src="${u.agency.logo_url}" alt="">` : ""}
    <strong>${u.agency.name || ""}</strong>
    <a class="muted" href="${otherLangUrl}" hreflang="${lang === "en" ? "ar" : "en"}">${lang === "en" ? "عربي" : "English"}</a>
  </header>
  <h1>${u.headline}</h1>
  ${u.price ? html`<p class="line"><strong>💰 ${u.price}</strong></p>` : ""}
  ${u.images.length ? html`<div class="photos">${u.images.map((src) => html`<img src="${src}" alt="" loading="lazy">`)}</div>` : ""}
  <ul class="facts">${u.facts.map((f) => html`<li>${f}</li>`)}</ul>
  ${u.features.length ? html`<ul class="tags">${u.features.map((f) => html`<li>${f}</li>`)}</ul>` : ""}
  ${u.summary ? html`<p>${u.summary}</p>` : ""}
  <p class="muted">${L(lang, "كود الوحدة", "Unit code")}: <span dir="ltr">${u.code}</span></p>
  ${u.contact
    ? html`<section class="card notice"><h2>📞 ${L(lang, "للمعاينة والاستفسار", "For viewings and details")}</h2>
    <p>${u.contact.name || ""}</p>
    <div class="row">
      ${u.contact.phone ? html`<a class="btn" href="tel:${u.contact.phone}" dir="ltr">${u.contact.phone}</a>` : ""}
      ${wa ? html`<a class="btn secondary" href="${wa}" rel="noopener">WhatsApp</a>` : ""}
    </div></section>`
    : ""}
</article>`;
}

/** Mounts the public pages on the app (after /app, /webhook and /health). */
function mountPublic(app, { pool, assets }) {
  const notFound = (res) =>
    res
      .status(404)
      .type("html")
      .send(String(layout({ assets: assets.url, title: "غير موجود", scripts: false, manifest: false, body: html`<div class="card"><h1>🔍 الصفحة غير موجودة</h1><p class="muted">Page not found.</p></div>` })));

  app.get("/:slug/:code", securityHeaders, Session.loadSession(pool), async (req, res, next) => {
    const { slug, code } = req.params;
    if (!SLUG.test(slug) || RESERVED_SLUGS.includes(slug)) return next();
    res.set({ "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    if (!CODE.test(code)) return notFound(res);
    const gate = await RateLimit.hit(pool, `public:ip:${req.ip}`, RateLimit.LIMITS.publicPageIp);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).send("Too many requests");

    const token = String(req.query.s || "");
    const resolved = await Share.resolveShareLink(pool, slug, code, token);
    if (!resolved) return notFound(res);
    const lang = req.query.lang === "en" || req.query.lang === "ar" ? req.query.lang : resolved.link.lang;
    const { listing, agency, broker } = resolved;

    const pageUrl = Links.unitPageUrl(agency.slug, listing.code, token);
    const otherLangUrl = `/${agency.slug}/${encodeURIComponent(listing.code)}?s=${encodeURIComponent(token)}&lang=${lang === "en" ? "ar" : "en"}`;
    let unit;
    if (listing.status === "active") {
      const { rows: images } = await pool.query("SELECT url FROM listing_images WHERE listing_id = $1 AND agency_id = $2 ORDER BY position LIMIT 15", [listing.id, listing.agency_id]);
      unit = PublicUnit.toPublicUnit(listing, { agency, broker: broker?.is_active ? broker : null, images, lang });
    } else {
      unit = PublicUnit.unavailable(listing, { agency, lang });
    }
    if (req.method === "GET") {
      await Share.recordOpen(pool, resolved, { userAgent: req.get("user-agent"), viewerAgencyId: req.session?.agency?.id || null }).catch((e) =>
        console.warn("Share open record failed:", e.message)
      );
    }
    return res
      .status(unit.status === "active" ? 200 : 410)
      .type("html")
      .send(
        String(
          layout({
            assets: assets.url,
            lang,
            title: unit.status === "active" ? unit.og.title : L(lang, "غير متاحة", "Unavailable"),
            robots: "noindex, nofollow",
            scripts: false,
            manifest: false,
            head: unit.status === "active" ? ogTags(unit, pageUrl) : null,
            body: unitBody(unit, { otherLangUrl })
          })
        )
      );
  });
}

module.exports = { mountPublic };
