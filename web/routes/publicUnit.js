// web/routes/publicUnit.js — Public unit pages for clients: /<agency-slug>/<unit-code>?s=<share-token>.
// Rendered only from domain/publicUnit.js (the allowlist serializer); noindex; OG tags for link previews;
// a real client's open alerts the broker who shared the link. Phase 2 step 2: an "I'm interested" form (name, phone,
// a contact notice under Send (F19); honeypot and rate limits) makes a lead for the broker who shared the link (source "Unit link") and alerts them.
"use strict";

const express = require("express");
const Leads = require("../../services/leads");
const Gallery = require("../../services/projectGallery");
const Notifications = require("../../lib/notifications");
const Card = require("../../domain/leadCard");
const Share = require("../../lib/shareLinks");
const RateLimit = require("../../lib/rateLimit");
const Links = require("../../lib/links");
const PublicUnit = require("../../domain/publicUnit");
const ClientPlans = require("../../domain/clientPlans");
const Catalogue = require("../../services/catalogue");
const Stages = require("../../domain/leadStages");
const SchedulePdf = require("../../lib/schedulePdf");
const Compare = require("../../lib/compareLinks");
const { fetchBuf } = require("../../lib/flyerAssets");
const sharp = require("sharp");
const { RESERVED_SLUGS } = require("../../domain/slug");
const Session = require("../session");
const { securityHeaders, sameOrigin } = require("../security");
const { html, layout } = require("../html");

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{1,29}$/;
const L = (lang, ar, en) => (lang === "en" ? en : ar);
const INTEREST_IP = { limit: 5, windowSec: 3600 };
const INTEREST_LINK = { limit: 20, windowSec: 24 * 3600 };
const PDF_IP = { limit: 20, windowSec: 3600 };
const num = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
const money = (n, lang) => `${num(n)} ${L(lang, "ج.م", "EGP")}`;

const INTEREST_ERRORS = {
  name: ["اكتب اسمك.", "Enter your name."],
  phone: ["اكتب رقم موبايل صحيح.", "Enter a valid mobile number."],
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
  <button type="submit">${L(lang, "ابعت", "Send")}</button>
  <p class="muted small">${L(lang, "لما تبعت، بتوافق إن الوكالة تتواصل معاك بخصوص الوحدة دي وتحتفظ بالاسم والرقم لده.", "By sending, you agree the agency may contact you about this unit and keep your name and number for that.")}</p>
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

/** C7: the plans with their numbers; one plan's dated schedule when chosen (?plan=), and its PDF. */
function plansSection(u, { base, plan = null, schedule = null }) {
  const lang = u.lang;
  if (!u.plans.length) return "";
  return html`<section class="card" id="plans">
  <h2>💳 ${L(lang, "خطط الدفع", "Payment plans")}</h2>
  ${u.plans.map((p) => html`<div class="card${plan === p.index ? " notice" : ""}" data-plan="${p.index}">
    <h3>${p.name}</h3>
    <ul>
      <li>${L(lang, "المقدم", "Down payment")} ${p.down_payment_pct}%: <strong>${money(p.summary.down_payment, lang)}</strong></li>
      ${p.summary.installments ? html`<li>${p.summary.installments} ${L(lang, "قسط", "installments")} ${p.frequency_label}: <strong>${money(p.summary.installment, lang)}</strong></li>` : ""}
      ${p.summary.milestones.map((m) => html`<li>${L(lang, "دفعة", "Milestone")} ${m.pct}% ${L(lang, `بعد ${m.months} شهر`, `after ${m.months} months`)}: ${money(m.amount, lang)}</li>`)}
      ${p.discount_pct ? html`<li>${L(lang, "خصم", "Discount")} ${p.discount_pct}%</li>` : ""}
      ${p.summary.maintenance ? html`<li>${L(lang, "الصيانة", "Maintenance")} ${p.summary.maintenance_pct}%: ${money(p.summary.maintenance, lang)}</li>` : ""}
      ${p.fees.map((f) => html`<li>${f.label}: ${money(f.amount, lang)}</li>`)}
    </ul>
    <p class="row"><a class="btn secondary" href="${base}&plan=${p.index}#plans">🧮 ${L(lang, "جدول الدفع", "Payment schedule")}</a> <a class="btn secondary" href="${base.replace("?", "/schedule.pdf?")}&plan=${p.index}" data-schedule-pdf="${p.index}">📄 PDF</a></p>
  </div>`)}
  ${schedule ? html`<div class="scroll" data-schedule="${plan}"><table><thead><tr><th>#</th><th>${L(lang, "الميعاد", "Due")}</th><th>${L(lang, "البند", "Item")}</th><th>${L(lang, "المبلغ", "Amount")}</th>${schedule.totals.maintenance_scheduled ? html`<th>${L(lang, "الصيانة", "Maintenance")}</th>` : ""}</tr></thead>
    <tbody>${schedule.rows.map((r) => html`<tr><td>${r.n}</td><td dir="ltr">${r.date}</td><td>${r.label}</td><td>${money(r.amount, lang)}</td>${schedule.totals.maintenance_scheduled ? html`<td>${r.maintenance ? money(r.maintenance, lang) : "—"}</td>` : ""}</tr>`)}</tbody></table></div>
    <p class="muted">${L(lang, "جدول استرشادي محسوب من النهارده، مش عقد. الأسعار والخطط ممكن تتغير.", "An indicative schedule counted from today, not a contract. Prices and plans may change.")}</p>` : ""}
</section>`;
}

function projectSection(u) {
  const lang = u.lang;
  const p = u.project;
  if (!p || (!p.name && !p.links.length)) return "";
  return html`<section class="card" id="project"><h2>🏗️ ${p.name || ""}</h2>
  ${p.highlights?.length ? html`<ul data-public-highlights>${p.highlights.map((l) => html`<li>✨ ${l}</li>`)}</ul>` : ""}
  ${p.delivery ? html`<p>🔑 ${L(lang, "التسليم", "Delivery")}: <span dir="ltr">${p.delivery}</span></p>` : ""}
  ${p.links.length ? html`<ul>${p.links.map((m) => html`<li><a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.label}</a></li>`)}</ul>` : ""}
</section>`;
}

function unitBody(u, { otherLangUrl, interest = null, plans = {} }) {
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
  ${projectSection(u)}
  ${plansSection(u, plans)}
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

/** C7: 2 or 3 units side by side, client-safe only (the serializer's fields plus price per m²). */
function compareBody(units, { agency, contact, lang, otherLangUrl }) {
  const wa = contact?.phone ? `https://wa.me/${contact.phone.replace(/\D/g, "")}?text=${encodeURIComponent(`${L(lang, "استفسار عن الوحدات", "About units")} ${units.map((u) => u.code).join(", ")}`)}` : null;
  const row = (label, cell) => html`<tr><th scope="row">${label}</th>${units.map((u) => html`<td>${u.status === "active" ? cell(u) : html`<span class="muted">${L(lang, "مبقتش متاحة", "No longer available")}</span>`}</td>`)}</tr>`;
  const plan = (u) => u.plans[0];
  return html`<article class="card" data-compare="${units.map((u) => u.code).join(",")}">
  <header class="row">
    ${agency.logo_url ? html`<img class="logo" src="${agency.logo_url}" alt="">` : ""}
    <strong>${agency.name || ""}</strong>
    <a class="muted" href="${otherLangUrl}" hreflang="${lang === "en" ? "ar" : "en"}">${lang === "en" ? "عربي" : "English"}</a>
  </header>
  <h1>⚖️ ${L(lang, "مقارنة الوحدات", "Unit comparison")}</h1>
  <div class="scroll"><table class="compare">
    <thead><tr><th></th>${units.map((u) => html`<th scope="col" data-compare-unit="${u.code}">${u.images[0] ? html`<img src="${u.images[0]}" alt="" loading="lazy" class="thumb"><br>` : ""}${u.headline}<br><span class="muted" dir="ltr">${u.code}</span></th>`)}</tr></thead>
    <tbody>
      ${row(L(lang, "السعر", "Price"), (u) => html`<strong>${u.price || "—"}</strong>`)}
      ${row(L(lang, "سعر المتر", "Per m²"), (u) => (u.per_m2 ? money(u.per_m2, lang) : "—"))}
      ${row(L(lang, "المواصفات", "Details"), (u) => html`<ul class="facts">${u.facts.map((f) => html`<li>${f}</li>`)}</ul>`)}
      ${row(L(lang, "المشروع والتسليم", "Project and delivery"), (u) => (u.project ? `${u.project.name || ""}${u.project.delivery ? ` · ${u.project.delivery}` : ""}` : "—"))}
      ${row(L(lang, "أول خطة دفع", "First payment plan"), (u) => (plan(u) ? html`${plan(u).name}<br>${L(lang, "مقدم", "Down")} ${money(plan(u).summary.down_payment, lang)}${plan(u).summary.installments ? html`<br>${plan(u).summary.installments} × ${money(plan(u).summary.installment, lang)}` : ""}` : "—"))}
      ${row(L(lang, "مميزات", "Features"), (u) => (u.features.length ? u.features.join("، ") : "—"))}
    </tbody>
  </table></div>
  ${contact
    ? html`<section class="card notice"><h2>📞 ${L(lang, "للمعاينة والاستفسار", "For viewings and details")}</h2>
    <p>${contact.name || ""}</p>
    <div class="row">
      ${contact.phone ? html`<a class="btn" href="tel:${contact.phone}" dir="ltr">${contact.phone}</a>` : ""}
      ${wa ? html`<a class="btn secondary" href="${wa}" rel="noopener">WhatsApp</a>` : ""}
    </div></section>`
    : ""}
</article>`;
}

/** Cairo's today at midnight (UTC date), the first row of a schedule. */
const cairoToday = () => new Date(`${Stages.toCairoLocal(new Date()).slice(0, 10)}T00:00:00Z`);

/** The agency logo as a small PNG data URI for the PDF (the flyer's safe fetch), or null. */
async function logoData(url) {
  if (!url) return null;
  try {
    const buf = await fetchBuf(url);
    if (!buf) return null;
    const png = await sharp(buf, { failOn: "none" }).resize(240, 240, { fit: "inside" }).png().toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
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

  /** The unit's catalogue project and its client-visible links (C7). */
  async function projectOf(listing) {
    const project = await Catalogue.projectForUnit(pool, listing).catch(() => null);
    return project ? { project, materials: await Catalogue.clientMaterials(pool, listing) } : { project: null, materials: [] };
  }

  async function render(req, res, { resolved, token, lang }, interest = {}, status = null, { team = false } = {}) {
    const { listing, agency, broker } = resolved;
    const pageUrl = Links.unitPageUrl(agency.slug, listing.code, token);
    const base = `/${agency.slug}/${encodeURIComponent(listing.code)}?s=${encodeURIComponent(token)}`;
    const otherLangUrl = `${base}&lang=${lang === "en" ? "ar" : "en"}`;
    let unit;
    if (listing.status === "active") {
      const { rows: own } = await pool.query("SELECT url FROM listing_images WHERE listing_id = $1 AND agency_id = $2 AND (role IS NULL OR role NOT IN ('document', 'unrelated')) ORDER BY position LIMIT 15", [listing.id, listing.agency_id]);
      // F23: the unit's layouts and the project's shared photos follow the unit's own.
      const layouts = (await Gallery.layoutsFor(pool, listing)).filter((i) => i.mime.startsWith("image/"));
      const seen = new Set();
      const images = [...own, ...layouts, ...(await Gallery.sharedFor(pool, listing))].filter((i) => !seen.has(i.url) && seen.add(i.url)).slice(0, 15);
      unit = PublicUnit.toPublicUnit(listing, { agency, broker: broker?.is_active ? broker : null, images, lang, ...(await projectOf(listing)) });
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
            body: html`${team ? teamNotice(lang) : ""}${unitBody(unit, { otherLangUrl, interest: { action: `${base}&lang=${lang}#interest`, ...interest }, plans: plansView(unit, listing, `${base}&lang=${lang}`, req.query.plan, lang) })}`
          })
        )
      );
  }

  function teamNotice(lang) {
    return html`<p class="notice warn" data-team-view>${L(
      lang,
      "👁 إنت داخل على حساب المكتب، فالفتحة دي مش بتتحسب ومفيش تنبيه. التنبيه بيوصل لما العميل يفتحها. عشان تجرب، افتح الرابط في نافذة خاصة (Incognito) أو من موبايل تاني.",
      "👁 You are signed in to this agency, so this visit is not counted and no alert is sent. You get the alert when a client opens it. To test, open the link in a private (incognito) window or on another phone."
    )}</p>`;
  }

  function plansView(unit, listing, base, planParam, lang) {
    const plan = /^\d$/.test(String(planParam ?? "")) ? Number(planParam) : null;
    const schedule = plan !== null && unit.plans[plan] ? ClientPlans.schedule(listing, plan, { lang, start: cairoToday() }) : null;
    return { base, plan: schedule ? plan : null, schedule };
  }

  const skip = (req) => !SLUG.test(req.params.slug) || RESERVED_SLUGS.includes(req.params.slug);

  // C7: a comparison of 2 or 3 units the broker sent.
  app.get("/:slug/compare/:token", securityHeaders, Session.loadSession(pool), async (req, res, next) => {
    if (skip(req)) return next();
    res.set({ "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const gate = await RateLimit.hit(pool, `public:ip:${req.ip}`, RateLimit.LIMITS.publicPageIp);
    if (!gate.allowed) return res.status(429).set("Retry-After", String(gate.retryAfterSec)).send("Too many requests");
    const resolved = await Compare.resolveCompareLink(pool, req.params.slug, String(req.params.token));
    if (!resolved) return notFound(res);
    const lang = req.query.lang === "en" || req.query.lang === "ar" ? req.query.lang : resolved.link.lang;
    await Compare.recordOpen(pool, resolved, { userAgent: req.get("user-agent"), viewerAgencyId: req.session?.agency?.id || null }).catch((e) => console.warn("Compare open record failed:", e.message));
    const broker = resolved.broker?.is_active ? resolved.broker : null;
    const units = [];
    for (const listing of resolved.listings) {
      if (listing.status !== "active") {
        units.push({ ...PublicUnit.unavailable(listing, { agency: resolved.agency, lang }), per_m2: null });
        continue;
      }
      const { rows: images } = await pool.query("SELECT url FROM listing_images WHERE listing_id = $1 AND agency_id = $2 AND (role IS NULL OR role NOT IN ('document', 'unrelated', 'layout')) ORDER BY position LIMIT 1", [listing.id, listing.agency_id]);
      const u = PublicUnit.toPublicUnit(listing, { agency: resolved.agency, broker, images, lang, ...(await projectOf(listing)) });
      const perM2 = listing.listing_type !== "rent" && Number(listing.area_value) > 0 && Number(listing.price_value) > 0 ? Math.round(Number(listing.price_value) / Number(listing.area_value)) : null;
      units.push({ ...u, per_m2: perM2 });
    }
    const contact = PublicUnit.contactOf(broker);
    const self = `/${resolved.agency.slug}/compare/${encodeURIComponent(req.params.token)}`;
    return res.type("html").send(
      String(
        layout({
          assets: assets.url,
          lang,
          title: L(lang, "مقارنة الوحدات", "Unit comparison"),
          robots: "noindex, nofollow",
          scripts: false,
          manifest: false,
          body: compareBody(units, { agency: resolved.agency, contact, lang, otherLangUrl: `${self}?lang=${lang === "en" ? "ar" : "en"}` })
        })
      )
    );
  });

  // C7: one plan's schedule as a PDF (agency name and logo, the broker to call; nothing internal).
  app.get("/:slug/:code/schedule.pdf", securityHeaders, async (req, res, next) => {
    if (skip(req)) return next();
    const ctx = await load(req, res);
    if (!ctx) return undefined;
    const { listing, agency, broker } = ctx.resolved;
    if (listing.status !== "active") return notFound(res);
    const byIp = await RateLimit.hit(pool, `pdf:ip:${req.ip}`, PDF_IP);
    if (!byIp.allowed) return res.status(429).set("Retry-After", String(byIp.retryAfterSec)).send("Too many requests");
    const plan = /^\d$/.test(String(req.query.plan ?? "")) ? Number(req.query.plan) : 0;
    const schedule = ClientPlans.schedule(listing, plan, { lang: ctx.lang, start: cairoToday() });
    if (!schedule) return notFound(res);
    const unit = PublicUnit.toPublicUnit(listing, { agency, broker: broker?.is_active ? broker : null, lang: ctx.lang });
    const pdf = await SchedulePdf.renderSchedulePdf({
      lang: ctx.lang,
      agency: { name: unit.agency.name, logo: await logoData(unit.agency.logo_url) },
      unit: { code: unit.code, headline: unit.headline },
      schedule,
      contact: unit.contact,
      today: Stages.toCairoLocal(new Date()).slice(0, 10)
    });
    return res
      .set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${listing.code.replace(/[^A-Za-z0-9_-]/g, "")}-schedule.pdf"` })
      .send(pdf);
  });

  app.get("/:slug/:code", securityHeaders, Session.loadSession(pool), async (req, res, next) => {
    if (skip(req)) return next();
    const ctx = await load(req, res);
    if (!ctx) return undefined;
    const sent = req.query.sent === "1";
    let open = null;
    if (!sent) {
      open = await Share.recordOpen(pool, ctx.resolved, { userAgent: req.get("user-agent"), viewerAgencyId: req.session?.agency?.id || null }).catch((e) =>
        console.warn("Share open record failed:", e.message)
      );
    }
    // The agency's own signed-in brokers are not counted; say so, or a broker testing the link sees nothing happen.
    return render(req, res, ctx, { sent }, null, { team: open?.skipped === "team" });
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
    const byIp = await RateLimit.hit(pool, `interest:ip:${req.ip}`, INTEREST_IP);
    const byLink = byIp.allowed ? await RateLimit.hit(pool, `interest:link:${resolved.link.token_hash}`, INTEREST_LINK) : byIp;
    if (!byLink.allowed) return render(req, res, ctx, { error: "rate", values }, 429);

    const r = await Leads.captureLead(pool, broker, {
      phones: values.phone,
      name: values.name,
      lang,
      source: "Unit link",
      lawfulBasis: "consent",
      // F19: no tick box; the notice under the Send button says sending is agreeing to be contacted.
      consentNote: `Interest form on the unit page ${listing.code} (sent under the contact notice)`,
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
