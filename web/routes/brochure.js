// web/routes/brochure.js — A project's highlights and brochure (Release B, C6) on the project page: everyone sees the
// saved highlight lines; managers type or edit them (Arabic and English, up to 5 each) and, when the owner switched
// document reading on, upload the brochure to read its facts and get suggested lines. services/brochure.js does the
// work.
"use strict";

const Brochure = require("../../services/brochure");
const B = require("../../domain/brochure");
const RateLimit = require("../../lib/rateLimit");
const Session = require("../session");
const { isManager } = require("../../lib/authz");
const { uploads } = require("../uploads");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const DOC = { name: "doc", maxCount: B.MAX_PAGES, accept: /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/ };
const uploadDoc = uploads([DOC], { maxMb: 25 });
Session.allowMultipart(/^\/catalogue\/projects\/[^/]+\/brochure$/);

const ERRORS = {
  OFF: ["قراءة الملفات مش مفعّلة لوكالتك.", "Document reading isn't switched on for your agency."],
  NO_FILE: ["اختار ملف PDF أو صور.", "Choose a PDF or photos."],
  ONE_PDF: ["ملف PDF واحد بس في المرة.", "One PDF at a time."],
  NOT_PDF: ["الملف ده مش PDF مقروء.", "That file isn't a readable PDF."],
  NOT_SUPPORTED: ["PDF أو صور (JPG / PNG) بس.", "A PDF or photos (JPG / PNG) only."],
  pages_required: ["اكتب أرقام الصفحات (مثلاً 1-6).", "Enter the page numbers (e.g. 1-6)."],
  pages_invalid: ["أرقام الصفحات مش مظبوطة.", "The page numbers aren't valid."],
  too_many_pages: [`${B.MAX_PAGES} صفحات بالكتير.`, `At most ${B.MAX_PAGES} pages.`],
  ALLOWANCE: ["رصيد الشهر مش كفاية.", "This month's credits aren't enough."],
  AI_FAILED: ["القراءة فشلت؛ جرب تاني.", "Reading failed; try again."],
  NO_FACTS: ["ملقيناش معلومات في الصفحات دي.", "No facts found on those pages."],
  too_many_lines: [`${B.MAX_LINES} سطور بالكتير.`, `At most ${B.MAX_LINES} lines.`],
  line_too_long: [`السطر ${B.MAX_LINE} حرف بالكتير.`, `Each line at most ${B.MAX_LINE} characters.`]
};
const errorText = (code, lang) => (ERRORS[code] || ERRORS.AI_FAILED)[lang === "en" ? 1 : 0];

/** The project page's highlights card. reading = the agency's document-reading usage (managers). */
function highlightsSection(lang, manager, project, { reading = null, query = {} } = {}) {
  const base = `/app/catalogue/projects/${project.id}`;
  const lines = B.highlightsFor(project.highlights, lang);
  const saved = project.highlights && (project.highlights.ar?.length || project.highlights.en?.length);
  const suggested = !saved && project.brochure?.suggested ? project.brochure.suggested : null;
  const value = (k) => ((saved ? project.highlights[k] : suggested?.[k]) || []).join("\n");
  const facts = project.brochure?.facts || [];
  const notice = query.brochure_error
    ? html`<p class="notice bad" role="alert">❌ ${errorText(query.brochure_error, lang)}${query.brochure_error === "ALLOWANCE" ? L(lang, ` محتاج ${Number(query.needed) || 0} وفاضل ${Number(query.left) || 0}.`, ` Needs ${Number(query.needed) || 0}, ${Number(query.left) || 0} left.`) : ""}</p>`
    : query.brochure_read
      ? html`<p class="notice ok" role="status">✅ ${L(lang, `اتقرا البروشور: ${facts.length} معلومة. راجع السطور المقترحة واحفظها.`, `Brochure read: ${facts.length} facts. Check the suggested lines and save them.`)}</p>`
      : query.highlights_saved
        ? html`<p class="notice ok" role="status">✅ ${L(lang, "اتحفظت.", "Saved.")}</p>`
        : "";
  return html`<section class="card stack" id="highlights">
  <h2>✨ ${L(lang, "أهم المميزات", "Highlights")}</h2>
  ${notice}
  ${lines.length ? html`<ul data-highlights>${lines.map((l) => html`<li>${l}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش.", "None yet.")}</p>`}
  ${manager
    ? html`<form method="post" action="${base}/highlights" class="stack" data-highlights-form>
    ${suggested ? html`<p class="muted" data-suggested>🤖 ${L(lang, "سطور مقترحة من البروشور، مش محفوظة ولا ظاهرة للعملاء لسه. عدّلها واحفظ.", "Lines suggested from the brochure; not saved or shown to clients yet. Edit and save.")}</p>` : ""}
    <label>${L(lang, "بالعربي (سطر لكل ميزة، 5 بالكتير)", "Arabic (one per line, up to 5)")} <textarea name="ar" rows="5" maxlength="900">${value("ar")}</textarea></label>
    <label>${L(lang, "بالإنجليزي (اختياري)", "English (optional)")} <textarea name="en" rows="5" maxlength="900" dir="ltr">${value("en")}</textarea></label>
    <p class="muted">${L(lang, "بتظهر في صفحة المشروع وفي صفحة الوحدة اللي بتبعتها للعميل.", "They show on the project page and on the unit page you send to clients.")}</p>
    <button type="submit" class="secondary">${L(lang, "احفظ المميزات", "Save highlights")}</button>
  </form>
  ${reading?.enabled
    ? html`<form method="post" action="${base}/brochure" enctype="multipart/form-data" class="stack" data-brochure-read>
    <label>🤖 ${L(lang, "اقرا البروشور (PDF أو صور)", "Read the brochure (PDF or photos)")} <input type="file" name="doc" accept="application/pdf,image/jpeg,image/png,image/webp" multiple required></label>
    <label>${L(lang, "الصفحات", "Pages")} <input name="pages" dir="ltr" placeholder="1-6" maxlength="40"></label>
    <p class="muted">${L(lang, `${B.MAX_PAGES} صفحات بالكتير، من صفحات الشهر (فاضل ${reading.left}). المعلومات اللي في البروشور بس بتتحفظ للمشروع، ومنها بنقترح السطور.`, `At most ${B.MAX_PAGES} pages, from this month's pages (${reading.left} left). Only what the brochure states is kept for the project, and the lines are suggested from it.`)}</p>
    <button type="submit" class="secondary">${L(lang, "اقرا واقترح", "Read and suggest")}</button>
  </form>`
    : ""}
  ${facts.length
    ? html`<details data-brochure-facts><summary>${L(lang, `معلومات البروشور (${facts.length})`, `Brochure facts (${facts.length})`)} · <span dir="ltr">${String(project.brochure.read_at || "").slice(0, 10)}</span></summary><ul>${facts.map((f) => html`<li>${f.text}</li>`)}</ul></details>`
    : ""}`
    : ""}
</section>`;
}

function register(web, { pool }) {
  const back = (req, q) => `/app/catalogue/projects/${req.params.id}?${q}#highlights`;
  const deny = (req, res, status, text) => res.status(status).type("text/plain").send(text);

  web.post("/catalogue/projects/:id/highlights", async (req, res) => {
    const lang = langOf(req);
    const r = await Brochure.saveHighlights(pool, req.session.broker, req.params.id, { ar: req.body.ar, en: req.body.en });
    if (r.error === "forbidden") return deny(req, res, 403, L(lang, "للمديرين بس", "Managers only"));
    if (r.error === "not_found") return deny(req, res, 404, L(lang, "مش موجود", "Not found"));
    if (r.error) return res.redirect(303, back(req, `brochure_error=${r.error}`));
    return res.redirect(303, back(req, "highlights_saved=1"));
  });

  web.post("/catalogue/projects/:id/brochure", uploadDoc, async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isManager(broker)) return deny(req, res, 403, L(lang, "للمديرين بس", "Managers only"));
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return deny(req, res, 429, L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment."));
    const r = await Brochure.read(pool, broker, req.params.id, { files: req.files?.doc || [], pages: req.body.pages });
    if (r.error === "not_found") return deny(req, res, 404, L(lang, "مش موجود", "Not found"));
    if (r.error) return res.redirect(303, back(req, `brochure_error=${encodeURIComponent(r.error)}${r.error === "ALLOWANCE" ? `&left=${r.left}&needed=${r.needed}` : ""}`));
    return res.redirect(303, back(req, "brochure_read=1"));
  });
}

module.exports = { register, highlightsSection };
