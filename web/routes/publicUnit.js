// web/routes/publicUnit.js — Public unit pages for clients: /<agency-slug>/<unit-code>?s=<share-token>.
// Rendered only from domain/publicUnit.js (the allowlist serializer); noindex; OG tags for link previews;
// a real client's open alerts the broker who shared the link. Phase 2 step 2: an "I'm interested" form (name, phone,
// consent; honeypot and rate limits) makes a lead for the broker who shared the link (source "Unit link") and alerts them.
"use strict";

const express = require("express");
const Leads = require("../../services/leads");
const Notifications = require("../../lib/notifications");
const Card = require("../../domain/leadCard");
const Share = require("../../lib/shareLinks");
const RateLimit = require("../../lib/rateLimit");
const Links = require("../../lib/links");
const PublicUnit = require("../../domain/publicUnit");
const { RESERVED_SLUGS } = require("../../domain/slug");
const Session = require("../session");
const { securityHeaders, sameOrigin } = require("../security");
const { html, layout } = require("../html");

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{1,29}$/;
const L = (lang, ar, en) => (lang === "en" ? en : ar);
const INTEREST_IP = { limit: 5, windowSec: 3600 };
const INTEREST_LINK = { limit: 20, windowSec: 24 * 3600 };

const INTEREST_ERRORS = {
  name: ["اكتب اسمك.", "Enter your name."],
  phone: ["اكتب رقم موبايل صحيح.", "Enter a valid mobile number."],
  consent: ["لازم توافق إننا نتواصل معاك.", "Please agree to be contacted."],
  rate: ["طلبات كتير؛ جرب بعد شوية.", "Too many requests; try again later."]
};

function interestForm(u, { action, error, values = {}, sent }) {
  const lang = u.lang;
  if (sent) {
    return html`<section class="card notice ok" id="interest" role="status"><h2>✅ ${L(lang, "وصلنا طلبك", "We got your request")}</h2>
  <p>${L(lang, "هنكلمك قريب بخصوص الوحدة دي.", "We'll call you soon about this unit.")}</p></section>`;
  }
  return html`<form method="post" action="${action}" class="card stack" id="interest">
  <h2>🙋 ${L(lang, "مهتم بالوحدة دي؟", "Interested in this unit?")}</h2>
  ${error ? html`<p class="notice bad" role="alert">❌ ${INTEREST_ERRORS[error][lang === "en" ? 1 : 0]}</p>` : ""}
  <label>${L(lang, "الاسم", "Name")} <input name="name" required maxlength="80" autocomplete="name" value="${values.name || ""}"></label>
  <label>${L(lang, "الموبايل", "Mobile")} <input name="phone" required inputmode="tel" autocomplete="tel" dir="ltr" maxlength="20" value="${values.phone || ""}"></label>
  <label>${L(lang, "رسالة (اختياري)", "Message (optional)")} <textarea name="message" maxlength="500" rows="2">${values.message || ""}</textarea></label>
  <label class="hp" aria-hidden="true">Website <input name="website" tabindex="-1" autocomplete="off"></label>
  <label class="check"><input type="checkbox" name="consent" value="1" required> ${L(lang, "موافق إن الوكالة تتواصل معايا بخصوص الوحدة دي وتحتفظ بالاسم والرقم لده.", "I agree that the agency may contact me about this unit and keep my name and number for that.")}</label>
  <button type="submit">${L(lang, "ابعت", "Send")}</button>
</form>`;
}

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

function unitBody(u, { otherLangUrl, interest = null }) {
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
  ${u.contact && interest ? interestForm(u, interest) : ""}
</article>`;
}

/** Mounts the public pages on the app (after /app, /webhook and /health). */
function mountPublic(app, { pool, assets }) {
  const notFound = (res) =>
    res
      .status(404)
      .type("html")
      .send(String(layout({ assets: assets.url, title: "غير موجود", scripts: false, manifest: false, body: html`<div class="card"><h1>🔍 الصفحة غير موجودة</h1><p class="muted">Page not found.</p></div>` })));

  /** The link behind /:slug/:code?s=, or null (unknown, revoked or expired). Sends the 404/429 itself when it returns null. */
  async function load(req, res) {
    const { slug, code } = req.params;
    res.set({ "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    if (!CODE.test(code)) {
      notFound(res);
      return null;
    }
    const gate = await RateLimit.hit(pool, `public:ip:${req.ip}`, RateLimit.LIMITS.publicPageIp);
    if (!gate.allowed) {
      res.status(429).set("Retry-After", String(gate.retryAfterSec)).send("Too many requests");
      return null;
    }
    const token = String(req.query.s || "");
    const resolved = await Share.resolveShareLink(pool, slug, code, token);
    if (!resolved) {
      notFound(res);
      return null;
    }
    const lang = req.query.lang === "en" || req.query.lang === "ar" ? req.query.lang : resolved.link.lang;
    return { resolved, token, lang };
  }

  async function render(req, res, { resolved, token, lang }, interest = {}, status = null) {
    const { listing, agency, broker } = resolved;
    const pageUrl = Links.unitPageUrl(agency.slug, listing.code, token);
    const base = `/${agency.slug}/${encodeURIComponent(listing.code)}?s=${encodeURIComponent(token)}`;
    const otherLangUrl = `${base}&lang=${lang === "en" ? "ar" : "en"}`;
    let unit;
    if (listing.status === "active") {
      const { rows: images } = await pool.query("SELECT url FROM listing_images WHERE listing_id = $1 AND agency_id = $2 ORDER BY position LIMIT 15", [listing.id, listing.agency_id]);
      unit = PublicUnit.toPublicUnit(listing, { agency, broker: broker?.is_active ? broker : null, images, lang });
    } else {
      unit = PublicUnit.unavailable(listing, { agency, lang });
    }
    return res
      .status(status || (unit.status === "active" ? 200 : 410))
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
            body: unitBody(unit, { otherLangUrl, interest: { action: `${base}&lang=${lang}#interest`, ...interest } })
          })
        )
      );
  }

  const skip = (req) => !SLUG.test(req.params.slug) || RESERVED_SLUGS.includes(req.params.slug);

  app.get("/:slug/:code", securityHeaders, Session.loadSession(pool), async (req, res, next) => {
    if (skip(req)) return next();
    const ctx = await load(req, res);
    if (!ctx) return undefined;
    const sent = req.query.sent === "1";
    if (!sent) {
      await Share.recordOpen(pool, ctx.resolved, { userAgent: req.get("user-agent"), viewerAgencyId: req.session?.agency?.id || null }).catch((e) =>
        console.warn("Share open record failed:", e.message)
      );
    }
    return render(req, res, ctx, { sent });
  });

  app.post("/:slug/:code", securityHeaders, sameOrigin(), express.urlencoded({ extended: false, limit: "8kb", parameterLimit: 20 }), async (req, res, next) => {
    if (skip(req)) return next();
    const ctx = await load(req, res);
    if (!ctx) return undefined;
    const { resolved, token, lang } = ctx;
    const { listing, agency } = resolved;
    const body = req.body || {};
    const values = { name: String(body.name || "").trim().slice(0, 80), phone: String(body.phone || "").trim().slice(0, 20), message: String(body.message || "").trim().slice(0, 500) };
    const done = () => res.redirect(303, `/${agency.slug}/${encodeURIComponent(listing.code)}?s=${encodeURIComponent(token)}&lang=${lang}&sent=1#interest`);
    const broker = resolved.broker?.is_active ? resolved.broker : null;
    if (listing.status !== "active" || !broker) return render(req, res, ctx, {}, 410);
    // A bot filled the hidden field: look successful, keep nothing.
    if (body.website) return done();
    if (!values.name) return render(req, res, ctx, { error: "name", values }, 400);
    if (body.consent !== "1") return render(req, res, ctx, { error: "consent", values }, 400);
    const byIp = await RateLimit.hit(pool, `interest:ip:${req.ip}`, INTEREST_IP);
    const byLink = byIp.allowed ? await RateLimit.hit(pool, `interest:link:${resolved.link.token_hash}`, INTEREST_LINK) : byIp;
    if (!byLink.allowed) return render(req, res, ctx, { error: "rate", values }, 429);

    const r = await Leads.captureLead(pool, broker, {
      phones: values.phone,
      name: values.name,
      lang,
      source: "Unit link",
      lawfulBasis: "consent",
      consentNote: `Interest form on the unit page ${listing.code}`,
      notes: [`${L(lang, "سأل عن", "Asked about")} ${listing.code}`, values.message].filter(Boolean).join("\n"),
      // They contacted us themselves, with consent: an earlier erasure doesn't block a fresh request.
      allowErased: true
    });
    if (r.outcome === "invalid") return render(req, res, ctx, { error: "phone", values }, 400);
    if (r.lead && r.outcome !== "colleague") {
      const lead = r.lead;
      const ref = Card.refLabel(lead.ref);
      const en = broker.preferred_lang === "en";
      await Notifications.notifyBroker(pool, broker, {
        kind: "hot_client",
        dedupeKey: `interest:${lead.id}:${listing.id}:${new Date().toISOString().slice(0, 10)}`,
        title: en ? `🙋 ${Card.displayName(lead, "en")} (${ref}) asked about ${listing.code}` : `🙋 ${Card.displayName(lead, "ar")} (${ref}) سأل عن ${listing.code}`,
        body: [`📞 ${lead.phone_e164 || ""}`, values.message].filter(Boolean).join("\n"),
        url: `/app/leads/${ref}`,
        leadId: lead.id,
        listingId: listing.id
      }).catch((e) => console.warn("Interest alert failed:", e.message));
    }
    return done();
  });
}

module.exports = { mountPublic };
