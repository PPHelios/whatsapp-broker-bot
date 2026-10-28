// web/routes/gallery.js — A project's photo gallery (F23) on the project page: everyone sees the shared photos and the
// layouts; managers upload photos or a PDF (sorted by AI when document reading is on), fix a photo's role, pick the
// units for an unsure layout, or delete. services/projectGallery.js does the work.
"use strict";

const Gallery = require("../../services/projectGallery");
const G = require("../../domain/gallery");
const RateLimit = require("../../lib/rateLimit");
const Session = require("../session");
const { isManager } = require("../../lib/authz");
const { uploads } = require("../uploads");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const DOC = { name: "doc", maxCount: G.MAX_FILES, accept: /^(application\/pdf|image\/(jpeg|png|webp))$/ };
const uploadDoc = uploads([DOC], { maxMb: 25 });
Session.allowMultipart(/^\/catalogue\/projects\/[^/]+\/gallery$/);

const ERRORS = {
  OFF: ["ملف PDF محتاج قراءة الملفات تكون مفعّلة. ارفع صور.", "A PDF needs document reading switched on. Upload photos instead."],
  NO_FILE: ["اختار صور أو ملف PDF.", "Choose photos or a PDF."],
  ONE_PDF: ["ملف PDF واحد بس في المرة.", "One PDF at a time."],
  NOT_PDF: ["الملف ده مش PDF مقروء.", "That file isn't a readable PDF."],
  NOT_SUPPORTED: ["صور (JPG / PNG / WebP) أو PDF بس.", "Photos (JPG / PNG / WebP) or a PDF only."],
  pages_required: ["اكتب أرقام الصفحات (مثلاً 1-6).", "Enter the page numbers (e.g. 1-6)."],
  pages_invalid: ["أرقام الصفحات مش مظبوطة.", "The page numbers aren't valid."],
  too_many_pages: [`${G.MAX_FILES} بالكتير في المرة.`, `At most ${G.MAX_FILES} at a time.`],
  ALLOWANCE: ["صفحات الشهر مش كفاية.", "This month's pages aren't enough."]
};
const KIND = { render: ["منظور", "Render"], amenity: ["خدمات", "Amenity"], master_plan: ["المخطط العام", "Master plan"], layout: ["مخطط وحدة", "Layout"], other: ["تاني", "Other"] };
const ROLE = { shared: ["لكل الوحدات", "All units"], layout: ["مخطط وحدات", "Unit layout"], hidden: ["مخفي", "Hidden"] };
const T = (map, k, lang) => (map[k] || [k, k])[lang === "en" ? 1 : 0];

function layoutText(l, lang) {
  return [l.label, l.unit_type, l.area ? `${l.area} m²` : null, l.bedrooms !== null && l.bedrooms !== undefined ? L(lang, `${l.bedrooms} غرف`, `${l.bedrooms} bed`) : null].filter(Boolean).join(" · ");
}

/** The project page's gallery card. reading = the agency's document-reading usage (managers). */
function gallerySection(lang, manager, data, { reading = null, query = {} } = {}) {
  const { project, images, units } = data;
  const base = `/app/catalogue/projects/${project.id}/gallery`;
  const code = new Map(units.map((u) => [u.id, u.code]));
  const unsure = images.filter((i) => i.role === "layout" && i.match_status === "unsure");
  const notice = query.gallery_error
    ? html`<p class="notice bad" role="alert">❌ ${T(ERRORS, query.gallery_error, lang)}</p>`
    : query.gallery_added
      ? html`<p class="notice ok" role="status">✅ ${L(lang, `اتضاف ${Number(query.gallery_added) || 0}: ${Number(query.shared) || 0} لكل الوحدات، ${Number(query.matched) || 0} مخطط اتربط، ${Number(query.unsure) || 0} محتاج تراجعه.`, `${Number(query.gallery_added) || 0} added: ${Number(query.shared) || 0} for all units, ${Number(query.matched) || 0} layouts matched, ${Number(query.unsure) || 0} to check.`)}</p>`
      : "";
  const visible = manager ? images : images.filter((i) => i.role !== "hidden");
  const thumb = (i) => (i.mime.startsWith("image/") ? html`<img src="${i.url}" alt="${T(KIND, i.kind, lang)}" loading="lazy" width="160">` : html`<span>📄 PDF</span>`);
  return html`<section class="card stack" id="gallery">
  <h2>🖼️ ${L(lang, "صور المشروع", "Project gallery")}</h2>
  ${notice}
  <p class="muted">${L(lang, "الصور اللي «لكل الوحدات» بتظهر في صفحة كل وحدة في المشروع وفي الفلاير لو صور الوحدة قليلة. المخطط بيظهر مع الوحدات المربوطة بيه.", "\"All units\" photos show on every unit's client page in the project and fill the flyer when a unit has few photos. A layout shows with the units it is attached to.")}</p>
  ${manager && unsure.length
    ? html`<div class="notice" data-gallery-unsure>⚠️ ${L(lang, `${unsure.length} مخطط محتاج تختار وحداته:`, `${unsure.length} layout(s) need their units picked:`)}</div>`
    : ""}
  ${visible.length
    ? html`<ul class="gallery">${visible.map(
        (i) => html`<li data-gallery-image="${i.id}" data-role="${i.role}" data-match="${i.match_status || ""}">
      <a href="${i.url}" target="_blank" rel="noopener noreferrer">${thumb(i)}</a>
      <p>${T(KIND, i.kind, lang)} · ${T(ROLE, i.role, lang)}${i.role === "layout" ? html` · ${layoutText(i.layout || {}, lang)}` : ""}</p>
      ${i.role === "layout" ? html`<p class="muted">${(i.listing_ids || []).length ? (i.listing_ids || []).map((id) => code.get(id) || "").filter(Boolean).join(" ") : L(lang, "مش مربوط بوحدات", "Not attached to units")}</p>` : ""}
      ${manager
        ? html`<form method="post" action="${base}/${i.id}" class="stack">
        <select name="role" aria-label="${L(lang, "الدور", "Role")}">${Object.keys(ROLE).map((r) => html`<option value="${r}"${r === i.role ? html` selected` : ""}>${T(ROLE, r, lang)}</option>`)}</select>
        ${i.role === "layout" && units.length
          ? html`<details${i.match_status === "unsure" ? html` open` : ""}><summary>${L(lang, "الوحدات", "Units")}</summary>${units.map((u) => html`<label><input type="checkbox" name="unit" value="${u.id}"${(i.listing_ids || []).includes(u.id) ? html` checked` : ""}> ${u.code}${u.area_value ? ` · ${Number(u.area_value)} m²` : ""}${u.bedrooms !== null && u.bedrooms !== undefined ? ` · ${u.bedrooms}🛏` : ""}</label>`)}<input type="hidden" name="units_sent" value="1"></details>`
          : ""}
        <div class="row"><button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
        <button type="submit" class="link" formaction="${base}/${i.id}/delete">${L(lang, "حذف", "Delete")}</button></div>
      </form>`
        : ""}
    </li>`
      )}</ul>`
    : html`<p class="muted">${L(lang, "لسه مفيش صور.", "No photos yet.")}</p>`}
  ${manager
    ? html`<form method="post" action="${base}" enctype="multipart/form-data" class="stack" data-gallery-upload>
    <label>${L(lang, `ارفع صور (لحد ${G.MAX_FILES}) أو PDF`, `Upload photos (up to ${G.MAX_FILES}) or a PDF`)} <input type="file" name="doc" accept="image/jpeg,image/png,image/webp,application/pdf" multiple required></label>
    <label>${L(lang, "الصفحات (للـ PDF)", "Pages (for a PDF)")} <input name="pages" dir="ltr" placeholder="1-6" maxlength="40"></label>
    <p class="muted">${reading?.enabled
      ? L(lang, `الذكاء الاصطناعي بيفرز كل صورة (منظور، خدمات، مخطط عام، مخطط وحدة) ويربط المخططات بالوحدات حسب النوع والمساحة. من صفحات الشهر (فاضل ${reading.left}).`, `AI sorts each photo (render, amenity, master plan, unit layout) and attaches layouts to units by type and area. From this month's pages (${reading.left} left).`)
      : L(lang, "قراءة الملفات مقفولة: الصور بتتضاف «لكل الوحدات» وتقدر تغيّر دور كل صورة.", "Document reading is off: photos are added for all units and you can change each one's role.")}</p>
    <button type="submit" class="secondary">${L(lang, "رفع", "Upload")}</button>
  </form>`
    : ""}
</section>`;
}

function register(web, { pool }) {
  const back = (req, q = "") => `/app/catalogue/projects/${req.params.id}${q ? `?${q}` : ""}#gallery`;
  const deny = (req, res, status, text) => res.status(status).type("text/plain").send(text);
  const answer = (req, res, r) => {
    const lang = langOf(req);
    if (r.error === "forbidden") return deny(req, res, 403, L(lang, "للمديرين بس", "Managers only"));
    if (r.error === "not_found") return deny(req, res, 404, L(lang, "مش موجود", "Not found"));
    return res.redirect(303, back(req));
  };

  web.post("/catalogue/projects/:id/gallery", uploadDoc, async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isManager(broker)) return deny(req, res, 403, L(lang, "للمديرين بس", "Managers only"));
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return deny(req, res, 429, L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment."));
    const r = await Gallery.upload(pool, broker, req.params.id, { files: req.files?.doc || [], pages: req.body.pages });
    if (r.error === "not_found") return deny(req, res, 404, L(lang, "مش موجود", "Not found"));
    if (r.error) return res.redirect(303, back(req, `gallery_error=${encodeURIComponent(r.error)}`));
    return res.redirect(303, back(req, `gallery_added=${r.added}&shared=${r.shared}&matched=${r.matched}&unsure=${r.unsure}`));
  });
  web.post("/catalogue/projects/:id/gallery/:imageId", async (req, res) => {
    const units = req.body.units_sent ? [].concat(req.body.unit ?? []) : undefined;
    return answer(req, res, await Gallery.update(pool, req.session.broker, req.params.id, req.params.imageId, { role: req.body.role, listingIds: units }));
  });
  web.post("/catalogue/projects/:id/gallery/:imageId/delete", async (req, res) => answer(req, res, await Gallery.remove(pool, req.session.broker, req.params.id, req.params.imageId)));
}

module.exports = { register, gallerySection };
