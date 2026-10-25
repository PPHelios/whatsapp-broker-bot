// web/routes/units.js — Units in the web app: the agency's list and one unit's page (agency-scoped)
"use strict";

const Store = require("../../lib/listingStore");
const Authz = require("../../lib/authz");
const Describe = require("../../domain/describe");
const Share = require("../../lib/shareLinks");
const LeadRequests = require("../../services/leadRequests");
const Card = require("../../domain/leadCard");
const Storage = require("../../lib/supabase");
const Insights = require("../../services/priceInsights");
const Catalogue = require("../../services/catalogue");
const { html } = require("../html");
const { resultItem, factList } = require("../views/units");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const STATUSES = ["active", "sold", "archived"];

async function imagesOf(pool, listing) {
  const { rows } = await pool.query("SELECT id, url, position FROM listing_images WHERE listing_id = $1 AND agency_id = $2 ORDER BY position", [
    listing.id,
    listing.agency_id
  ]);
  return rows;
}

/** Wow 1: "🔥 N clients want this unit", the broker's own listed with Send (the count is the agency's). */
async function wantedSection(pool, broker, listing, lang, csrf) {
  const w = await LeadRequests.whoWants(pool, broker, listing);
  if (!w.total) return "";
  return html`<section class="card" id="wanted"><h2>🔥 ${L(lang, `${w.total} عملاء عايزين الوحدة دي`, `${w.total} clients want this unit`)}</h2>
  <ul>${w.leads.map(
    (l) => html`<li data-lead="${Card.refLabel(l.ref)}"><a href="/app/leads/${Card.refLabel(l.ref)}">${Card.refLabel(l.ref)} · ${Card.displayName(l, lang)}</a>
    <form method="post" action="/app/leads/${Card.refLabel(l.ref)}/send" class="inline" target="_blank"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="code" value="${listing.code}"><button type="submit" class="link">💬 ${L(lang, "ابعت للعميل", "Send to client")}</button></form></li>`
  )}</ul>
  ${w.others ? html`<p class="muted">👥 ${L(lang, `و${w.others} مع زملائك.`, `And ${w.others} with your colleagues.`)}</p>` : ""}
</section>`;
}

/** "EGP 52,000 per m² · 8% above the median of 12 units in Hyde Park" (sale and rent apart; ≥ 5 other units). */
/** The unit's catalogue project (C1) and its links; internal ones are marked (brokers may use them, clients never see them). */
function projectLine(p, lang) {
  return html`<p data-project="${p.id}">🏗️ <a href="/app/catalogue/projects/${p.id}">${lang === "en" ? p.name_en || p.name : p.name}</a>${p.developer_name ? ` · ${p.developer_name}` : ""}</p>
  ${p.materials.length ? html`<p class="muted">${p.materials.map((m, i) => html`${i ? " · " : ""}<a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.label}</a>${m.client_visible ? "" : " 🔒"}`)}</p>` : ""}`;
}

function marketLine(m, listing, lang) {
  const n = (x) => Number(x).toLocaleString("en-US");
  const diff = m.diffPct === null || Math.abs(m.diffPct) < 3
    ? L(lang, "قريب من", "close to")
    : m.diffPct > 0 ? L(lang, `أعلى ${m.diffPct}% من`, `${m.diffPct}% above`) : L(lang, `أقل ${-m.diffPct}% من`, `${-m.diffPct}% below`);
  return html`<p class="muted" data-market="${m.diffPct}">📊 ${n(m.perM2)} ${L(lang, "ج.م للمتر", "EGP per m²")}${listing.listing_type === "rent" ? L(lang, " في الشهر", " a month") : ""} · ${diff} ${L(lang, `وسيط ${m.units} وحدة في ${m.place}`, `the median of ${m.units} units in ${m.place}`)} (${n(m.median)}) · <a href="/app/insights">${L(lang, "أسعار المتر", "Prices per m²")}</a></p>`;
}

function register(web, { pool, page }) {
  web.get("/units", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const status = STATUSES.includes(req.query.status) ? req.query.status : "active";
    const mine = req.query.mine === "1";
    const { rows } = await pool.query(
      `SELECT * FROM listings WHERE agency_id = $1 AND status = $2 ${mine ? "AND broker_id = $3" : ""}
       ORDER BY confirmed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 200`,
      mine ? [broker.agency_id, status, broker.id] : [broker.agency_id, status]
    );
    const tab = (s, label) => html`<a href="/app/units?status=${s}${mine ? "&mine=1" : ""}"${s === status ? html` aria-current="page"` : ""}>${label}</a>`;
    return page(req, res, {
      title: L(lang, "الوحدات", "Units"),
      nav: "units",
      body: html`<h1>🏠 ${L(lang, "الوحدات", "Units")}</h1>
<nav class="row card">
  ${tab("active", L(lang, "🟢 متاحة", "🟢 Available"))} ${tab("sold", L(lang, "🔴 مباعة", "🔴 Sold"))} ${tab("archived", L(lang, "📁 مؤرشفة", "📁 Archived"))}
  <a href="/app/units?status=${status}${mine ? "" : "&mine=1"}">${mine ? L(lang, "كل الوكالة", "Whole agency") : L(lang, "وحداتي بس", "Mine only")}</a>
  <a href="/app/insights">📊 ${L(lang, "أسعار المتر", "Prices per m²")}</a>
</nav>
${rows.length
  ? html`<form id="bulk" method="post" action="/app/units/bulk" class="card row">
  <strong>${L(lang, "للمختار:", "Selected:")}</strong>
  <select name="action">
    <option value="available">${L(lang, "🟢 لسه متاحة (تأكيد)", "🟢 Still available (confirm)")}</option>
    <option value="sold">${L(lang, "✅ اتباعت", "✅ Sold")}</option>
    <option value="archive">${L(lang, "📁 أرشفة", "📁 Archive")}</option>
    <option value="price_pct">${L(lang, "💰 تغيير السعر %", "💰 Change price %")}</option>
  </select>
  <label>% <input class="narrow" name="pct" type="number" step="0.5" min="-50" max="100"></label>
  <button type="submit">${L(lang, "تطبيق", "Apply")}</button>
</form>
<ol class="results">${rows.map((r) => resultItem(r, lang, { selectable: true }))}</ol>`
  : html`<p class="card">${L(lang, "مفيش وحدات هنا.", "No units here.")}</p>`}`
    });
  });

  /** Share section: a new client link (public page) and the broker's earlier links with their opens. */
  async function shareSection(broker, listing, lang, fresh = null) {
    if (listing.status !== "active") return "";
    const links = await Share.linksFor(pool, broker, listing);
    const copy = fresh ? `${Describe.clientCopy(listing, broker, { lang: fresh.lang })}\n\n🔗 ${fresh.url}` : null;
    return html`<section class="card" id="share">
  <h2>🔗 ${L(lang, "رابط للعميل", "Link for a client")}</h2>
  ${fresh
    ? html`<p class="share-url" data-share-url>${fresh.url}</p>
  <p><a class="btn" href="https://wa.me/?text=${encodeURIComponent(copy)}" rel="noopener">${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>`
    : ""}
  <form method="post" action="/app/units/${encodeURIComponent(listing.code)}/share" class="row">
    <select name="lang"><option value="ar">عربي</option><option value="en">English</option></select>
    <button type="submit" class="secondary">${L(lang, "رابط جديد", "New link")}</button>
  </form>
  ${links.length
    ? html`<ul class="muted">${links.map(
        (k) => html`<li data-link-opens="${k.open_count}">${new Date(k.created_at).toISOString().slice(0, 10)} · ${k.channel} · ${L(lang, `اتفتح ${k.open_count} مرة`, `opened ${k.open_count} time(s)`)}</li>`
      )}</ul>`
    : ""}
  <p class="muted">${L(lang, "الصفحة بتظهر للعميل الصور والمواصفات بس — مفيش بيانات داخلية. هيوصلك تنبيه لما يفتحها.", "The page shows clients the photos and facts only — nothing internal. You get an alert when it is opened.")}</p>
</section>`;
  }

  web.post("/units/:code/share", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing) || listing.status !== "active") return next();
    const linkLang = req.body.lang === "en" ? "en" : "ar";
    const fresh = await Share.createShareLink(pool, broker, listing, { channel: "web", lang: linkLang });
    return page(req, res, { title: listing.code, nav: "units", body: html`<h1>${listing.code}</h1>${await shareSection(broker, listing, lang, { ...fresh, lang: linkLang })}<p><a href="/app/units/${encodeURIComponent(listing.code)}">${L(lang, "رجوع للوحدة", "Back to the unit")}</a></p>` });
  });

  // Photos to a client in one tap: the browser's share sheet (navigator.share with files) opens WhatsApp with the
  // pictures; Telegram can't forward several photos without its own captions and timestamps.
  web.get("/units/:code/share-media", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing) || listing.status !== "active") return next();
    const images = (await imagesOf(pool, listing)).slice(0, 10);
    const code = encodeURIComponent(listing.code);
    const text = Describe.clientCopy(listing, broker, { lang });
    return page(req, res, {
      title: listing.code,
      nav: "units",
      body: html`<h1>📤 ${L(lang, `صور ${listing.code} للعميل`, `${listing.code} photos for a client`)}</h1>
<section class="card stack" id="share-media" data-share-text="${text}">
  ${images.length
    ? html`<div class="photos">${images.map((i) => html`<img src="/app/units/${code}/photos/${i.id}" alt="" loading="lazy" data-share-photo>`)}</div>
  <button type="button" data-share-media>📤 ${L(lang, `ابعت ${images.length} صور (واتساب أو أي تطبيق)`, `Send ${images.length} photos (WhatsApp or any app)`)}</button>
  <p class="muted" data-share-status></p>
  <p class="muted">${L(lang, "لو الزرار مش شغال على جهازك: اضغط على الصورة مطولاً واحفظها، أو ابعت رابط الوحدة.", "If the button doesn't work on this device: long-press a photo to save it, or send the unit link.")}</p>`
    : html`<p class="muted">${L(lang, "مفيش صور للوحدة دي.", "This unit has no photos.")}</p>`}
</section>
<p><a href="/app/units/${code}">${L(lang, "رجوع للوحدة", "Back to the unit")}</a></p>`
    });
  });

  // One of the unit's photos served same-origin (the share page turns them into files for the share sheet).
  web.get("/units/:code/photos/:id", async (req, res, next) => {
    const { broker } = req.session;
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return next();
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const { rows } = await pool.query("SELECT url FROM listing_images WHERE id = $1 AND listing_id = $2 AND agency_id = $3", [
      req.params.id,
      listing.id,
      listing.agency_id
    ]);
    const file = rows[0] ? await Storage.downloadListingImage(rows[0].url) : null;
    if (!file) return next();
    res.set({ "Content-Type": /^image\/(jpeg|png|webp)$/.test(file.mimeType) ? file.mimeType : "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    return res.send(file.buffer);
  });

  web.get("/units/:code", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const images = await imagesOf(pool, listing);
    const market = listing.status === "active" ? await Insights.forUnit(pool, listing) : null;
    const project = await Catalogue.projectForUnit(pool, listing);
    const status = { active: L(lang, "🟢 متاحة", "🟢 Available"), sold: L(lang, "🔴 مباعة", "🔴 Sold"), archived: L(lang, "📁 مؤرشفة", "📁 Archived") }[listing.status] || listing.status;
    const conf = Describe.compactLine({ code: "", confirmed_at: listing.confirmed_at }, lang).match(/✅ \S+/);
    return page(req, res, {
      title: listing.code,
      nav: "units",
      body: html`<article class="card" data-code="${listing.code}">
  ${req.query.saved ? html`<p class="notice card ok">✅ ${L(lang, "تم الحفظ", "Saved")}</p>` : ""}
  <h1>${listing.code} · ${status}${conf ? html` <span class="muted">${conf[0]}</span>` : ""}</h1>
  ${factList(listing, lang)}
  ${project ? projectLine(project, lang) : ""}
  ${market ? marketLine(market, listing, lang) : ""}
  ${images.length ? html`<div class="photos">${images.map((i) => html`<img src="${i.url}" alt="" loading="lazy">`)}</div>` : ""}
  <div class="row" id="unit-actions">
    ${Authz.canEdit(broker, listing) ? html`<a class="btn" href="/app/units/${encodeURIComponent(listing.code)}/edit">✏️ ${L(lang, "تعديل", "Edit")}</a>` : ""}
    ${images.length && listing.status === "active" ? html`<a class="btn secondary" href="/app/units/${encodeURIComponent(listing.code)}/share-media">📤 ${L(lang, "ابعت الصور للعميل", "Send photos to a client")}</a>` : ""}
  </div>
</article>
${listing.status === "active" ? await wantedSection(pool, broker, listing, lang, req.session.csrf) : ""}
${await shareSection(broker, listing, lang)}`
    });
  });
}

module.exports = { register, imagesOf };
