// web/routes/units.js — Units in the web app: the agency's list and one unit's page (agency-scoped)
"use strict";

const Store = require("../../lib/listingStore");
const Authz = require("../../lib/authz");
const Describe = require("../../domain/describe");
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
</nav>
${rows.length ? html`<ol class="results">${rows.map((r) => resultItem(r, lang))}</ol>` : html`<p class="card">${L(lang, "مفيش وحدات هنا.", "No units here.")}</p>`}`
    });
  });

  web.get("/units/:code", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const images = await imagesOf(pool, listing);
    const status = { active: L(lang, "🟢 متاحة", "🟢 Available"), sold: L(lang, "🔴 مباعة", "🔴 Sold"), archived: L(lang, "📁 مؤرشفة", "📁 Archived") }[listing.status] || listing.status;
    const conf = Describe.compactLine({ code: "", confirmed_at: listing.confirmed_at }, lang).match(/✅ \S+/);
    return page(req, res, {
      title: listing.code,
      nav: "units",
      body: html`<article class="card" data-code="${listing.code}">
  ${req.query.saved ? html`<p class="notice card ok">✅ ${L(lang, "تم الحفظ", "Saved")}</p>` : ""}
  <h1>${listing.code} · ${status}${conf ? html` <span class="muted">${conf[0]}</span>` : ""}</h1>
  ${factList(listing, lang)}
  ${images.length ? html`<div class="photos">${images.map((i) => html`<img src="${i.url}" alt="" loading="lazy">`)}</div>` : ""}
  <div class="row" id="unit-actions">
    ${Authz.canEdit(broker, listing) ? html`<a class="btn" href="/app/units/${encodeURIComponent(listing.code)}/edit">✏️ ${L(lang, "تعديل", "Edit")}</a>` : ""}
  </div>
</article>`
    });
  });
}

module.exports = { register, imagesOf };
