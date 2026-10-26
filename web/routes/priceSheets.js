// web/routes/priceSheets.js — Catalogue prices (Release A, C2), managers: upload a developer's price sheet to a
// project, check the preview (new, changed from → to, no longer listed, invalid, repeated) and apply or discard it;
// announce an increase ("+7% from 1 November"). pricesSection() is the project page's prices card (freshness badge,
// units with price per m², sheets, increases). services/priceSheets.js does the work. Release B C5: a PDF or photos
// of a price list read by AI into the same preview (services/priceReading.js), when the app owner switched it on.
"use strict";

const PriceSheets = require("../../services/priceSheets");
const PriceReading = require("../../services/priceReading");
const Reading = require("../../domain/priceReading");
const Catalogue = require("../../services/catalogue");
const Commission = require("../../domain/commission");
const RateLimit = require("../../lib/rateLimit");
const Session = require("../session");
const { isManager } = require("../../lib/authz");
const { uploads } = require("../uploads");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => (n === null || n === undefined ? "—" : Commission.money(n, lang));
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
const SHEET = { name: "sheet", maxCount: 1, accept: /^(text\/(csv|plain|comma-separated-values)|application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-excel|csv|octet-stream|zip))$/ };
const uploadSheet = uploads([SHEET], { maxMb: 5 });
Session.allowMultipart(/^\/catalogue\/projects\/[^/]+\/sheets$/);
const DOC = { name: "doc", maxCount: Reading.MAX_PAGES, accept: /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/ };
const uploadDoc = uploads([DOC], { maxMb: 15 });
Session.allowMultipart(/^\/catalogue\/projects\/[^/]+\/sheets\/read$/);

const READ_ERRORS = {
  NOT_XLSX: ["الملف لازم يكون إكسيل .xlsx أو CSV.", "The file must be an .xlsx workbook or a CSV."],
  NOT_TEXT: ["الملف لازم يكون إكسيل .xlsx أو CSV.", "The file must be an .xlsx workbook or a CSV."],
  TOO_LARGE: ["الملف أكبر من 5 ميجا.", "The file is larger than 5 MB."],
  TOO_MANY_ROWS: ["الشيت فيه أكتر من 2000 صف.", "The sheet has more than 2,000 rows."],
  NO_HEADER: ["مش لاقيين صف العناوين (كود الوحدة، النوع، المساحة، السعر…).", "No header row found (unit code, type, area, price…)."],
  NO_PRICE: ["الشيت مفيهوش عمود سعر.", "The sheet has no price column."],
  OFF: ["قراءة ملفات PDF والصور مش مفعّلة لوكالتك.", "Reading PDFs and photos isn't switched on for your agency."],
  NO_FILE: ["اختار ملف PDF أو صور.", "Choose a PDF or photos."],
  ONE_PDF: ["ملف PDF واحد بس في المرة.", "One PDF at a time."],
  NOT_PDF: ["الملف ده مش PDF مقروء.", "That file isn't a readable PDF."],
  NOT_SUPPORTED: ["PDF أو صور (JPG / PNG) بس.", "A PDF or photos (JPG / PNG) only."],
  pages_required: ["اكتب أرقام الصفحات اللي فيها الأسعار (مثلاً 2-4).", "Enter the pages that hold the prices (e.g. 2-4)."],
  pages_invalid: ["أرقام الصفحات مش مظبوطة.", "The page numbers aren't valid."],
  too_many_pages: [`${Reading.MAX_PAGES} صفحات بالكتير في المرة.`, `At most ${Reading.MAX_PAGES} pages at a time.`],
  ALLOWANCE: ["صفحات الشهر مش كفاية للملف ده.", "This month's pages aren't enough for this file."],
  AI_FAILED: ["القراءة فشلت؛ جرب تاني أو ارفع شيت إكسيل.", "Reading failed; try again or upload an Excel sheet."],
  NO_ROWS: ["ملقيناش جدول أسعار في الصفحات دي.", "No price table found on those pages."]
};
const ROW_ERRORS = {
  price: ["سعر ناقص أو مش مفهوم", "Missing or unreadable price"],
  area: ["مساحة مش مفهومة", "Unreadable area"],
  property_type: ["نوع مش معروف (أو موديل من غير نوع)", "Unknown type (or a model without a type)"],
  status: ["حالة مش مفهومة (متاح / مباع)", "Unreadable status (available / sold)"]
};
const typeLabel = (t) => t || "—";
const areaText = (e) => (e.area ? `${e.area}${e.area_to ? `–${e.area_to}` : ""} m²` : "—");

/** The project page's prices card (C2). */
/** The AI reader's form (C5): only when the owner switched it on for the agency. */
function readForm(lang, base, reading) {
  if (!reading?.enabled) return "";
  return html`<form method="post" action="${base}/sheets/read" enctype="multipart/form-data" class="stack" data-ai-read>
    <label>🤖 ${L(lang, "أو ارفع قايمة الأسعار PDF أو صورها", "Or upload the price list as a PDF or photos")} <input type="file" name="doc" accept="application/pdf,image/jpeg,image/png,image/webp" multiple required></label>
    <label>${L(lang, "صفحات الأسعار في الـ PDF", "Price pages in the PDF")} <input name="pages" dir="ltr" placeholder="2-4, 7" maxlength="40"></label>
    <p class="muted" data-pages-left="${reading.left}">${L(lang, `افتح الملف واكتب أرقام صفحات جداول الأسعار بس (${Reading.MAX_PAGES} بالكتير). فاضل ${reading.left} من ${reading.pages_month} صفحة الشهر ده. الذكاء الاصطناعي بينقل اللي مكتوب بس، وهتراجع كل حاجة قبل الحفظ.`, `Open the file and enter only the pages with price tables (at most ${Reading.MAX_PAGES}). ${reading.left} of ${reading.pages_month} pages left this month. The AI copies only what the page shows, and you check everything before it is saved.`)}</p>
    <button type="submit" class="secondary">${L(lang, "اقرا ومعاينة", "Read and preview")}</button>
  </form>`;
}

function pricesSection(lang, manager, { project, units, sheets, increases, phases, reading = null, now = new Date() }) {
  const base = `/app/catalogue/projects/${project.id}`;
  const fresh = PriceSheets.freshness(project, { now });
  const badge = project.prices_updated_at
    ? html`<p data-prices-fresh="${fresh}">${fresh === "stale" ? "⚠️ " : "🏷️ "}${L(lang, "الأسعار من شيت", "Prices from the sheet of")} <span dir="ltr">${day(project.prices_updated_at)}</span>${fresh === "stale" ? html` · <strong>${L(lang, "عدى عليها أكتر من 30 يوم، السعر ممكن يكون اتغير", "over 30 days old; prices may have changed")}</strong>` : ""}</p>`
    : html`<p class="muted" data-prices-fresh="none">${L(lang, "لسه مفيش شيت أسعار للمشروع ده.", "No price sheet for this project yet.")}</p>`;
  const priced = units.filter((u) => u.price_value);
  return html`<section class="card" id="prices">
  <h2>🏷️ ${L(lang, "الأسعار", "Prices")}</h2>
  ${badge}
  ${priced.length ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "كود المطور", "Developer code")}</th><th>${L(lang, "النوع", "Type")}</th><th>${L(lang, "المساحة", "Area")}</th><th>${L(lang, "السعر", "Price")}</th><th>${L(lang, "للمتر", "Per m²")}</th></tr></thead>
  <tbody>${priced.map((u) => html`<tr data-unit-price="${u.code}"><td><a href="/app/units/${encodeURIComponent(u.code)}">${u.code}</a></td><td dir="ltr">${u.developer_unit_code || (u.inventory_type === "developer_model" ? L(lang, "موديل", "Model") : "—")}</td><td>${typeLabel(u.property_type)}${u.bedrooms !== null && u.bedrooms !== undefined ? ` · ${u.bedrooms} ${L(lang, "غرف", "bd")}` : ""}</td><td dir="ltr">${u.area_value ? `${Number(u.area_value)}${u.details?.area_to ? `–${u.details.area_to}` : ""}` : "—"}</td><td>${u.details?.price_from ? L(lang, "من ", "from ") : ""}${money(Number(u.price_value), lang)}${u.status === "sold" ? html` <span class="muted">(${L(lang, "مباعة", "sold")})</span>` : ""}</td><td>${u.area_value ? money(Math.round(Number(u.price_value) / Number(u.area_value)), lang) : "—"}</td></tr>`)}</tbody></table></div>` : ""}
  ${manager ? html`<form method="post" action="${base}/sheets" enctype="multipart/form-data" class="stack" data-sheet-upload>
    <label>${L(lang, "ارفع شيت المطور (.xlsx أو CSV)", "Upload the developer's sheet (.xlsx or CSV)")} <input type="file" name="sheet" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required></label>
    <p class="muted">${L(lang, "الأعمدة: كود الوحدة، النوع، المبنى أو المرحلة، الدور، المساحة (أو من–إلى)، الغرف، الحديقة، الروف، السعر، الحالة. صف من غير كود = موديل «يبدأ من». هتشوف الجديد والمتغير قبل أي حفظ.", "Columns: unit code, type, building or phase, floor, area (or from–to), bedrooms, garden, roof, price, status. A row without a code is a model (\"from\" price). You see what is new and what changed before anything is saved.")}</p>
    <button type="submit" class="secondary">${L(lang, "معاينة الشيت", "Preview the sheet")}</button>
  </form>
  ${readForm(lang, base, reading)}
  <form method="post" action="${base}/increases" class="row" data-increase-form>
    <label>${L(lang, "زيادة معلنة %", "Announced change %")} <input name="pct" required inputmode="decimal" dir="ltr" size="5" placeholder="7"></label>
    <label>${L(lang, "من يوم", "From")} <input name="effective_on" type="date" required></label>
    ${phases.length ? html`<label>${L(lang, "المرحلة", "Phase")} <select name="phase_id"><option value="">${L(lang, "كل المشروع", "Whole project")}</option>${phases.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>` : ""}
    <button type="submit" class="secondary">${L(lang, "سجّل الزيادة", "Schedule it")}</button>
  </form>
  <p class="muted">${L(lang, "في اليوم ده كل وحدات المشروع (أو المرحلة) المتاحة بتزيد بالنسبة دي، مقربة لأقرب 1,000. اكتب -5 للتخفيض.", "On that date every available unit of the project (or phase) moves by that %, rounded to the nearest 1,000. Type -5 for a cut.")}</p>` : ""}
  ${increases.length ? html`<ul>${increases.map((i) => html`<li data-increase="${i.id}" data-increase-status="${i.status}">${Number(i.pct) > 0 ? "+" : ""}${Number(i.pct)}% · <span dir="ltr">${day(i.effective_on)}</span>${i.phase_name ? ` · ${i.phase_name}` : ""} · ${i.status === "applied" ? L(lang, `اتطبقت على ${i.units ?? 0} وحدة`, `applied to ${i.units ?? 0} units`) : L(lang, "مستنية ميعادها", "scheduled")}${manager && i.status === "scheduled" ? html` <form method="post" action="${base}/increases/${i.id}/cancel" class="inline"><button type="submit" class="link">${L(lang, "إلغاء", "Cancel")}</button></form>` : ""}</li>`)}</ul>` : ""}
  ${manager && sheets.length ? html`<details><summary>${L(lang, "الشيتات السابقة", "Earlier sheets")}</summary><ul>${sheets.map((s) => html`<li data-sheet="${s.id}"><span dir="ltr">${day(s.created_at)}</span> · ${s.file_name || "—"} · ${s.status === "applied" ? L(lang, "اتطبق", "applied") : html`<a href="${base}/sheets/${s.id}">${L(lang, "معاينة", "preview")}</a>`} · ${L(lang, "جديد", "new")} ${s.summary?.new ?? 0} · ${L(lang, "متغير", "changed")} ${s.summary?.changed ?? 0}</li>`)}</ul></details>` : ""}
</section>`;
}

function previewPage(lang, project, sheet) {
  const base = `/app/catalogue/projects/${project.id}`;
  const by = (a) => sheet.entries.filter((e) => e.action === a);
  const s = sheet.summary || {};
  const errText = (e) => (ROW_ERRORS[e] || [e, e])[lang === "en" ? 1 : 0];
  const row = (e, extra = "") => html`<tr><td dir="ltr">${e.rowNumber ?? ""}</td><td dir="ltr">${e.dev_code || L(lang, "موديل", "Model")}</td><td>${typeLabel(e.property_type)}${e.bedrooms !== null && e.bedrooms !== undefined ? ` · ${e.bedrooms}` : ""}</td><td dir="ltr">${areaText(e)}</td>${extra}</tr>`;
  const live = sheet.status === "preview";
  return html`<p><a href="${base}#prices">‹ ${project.name}</a></p>
<h1>🏷️ ${L(lang, "معاينة شيت الأسعار", "Price sheet preview")}</h1>
${sheet.source === "ai" ? html`<p class="card notice" data-ai-sheet>🤖 ${L(lang, "الأسعار دي اتقرت بالذكاء الاصطناعي من الملف؛ راجعها مع الملف قبل التطبيق. رقم الصف = الصفحة × 1000 + الصف.", "These prices were read by AI from the file; check them against it before applying. Row number = page × 1000 + row.")}${sheet.summary?.ai?.failed?.length ? html` <strong>${L(lang, `صفحات متقرتش: ${sheet.summary.ai.failed.join("، ")}`, `Pages not read: ${sheet.summary.ai.failed.join(", ")}`)}</strong>` : ""}</p>` : ""}
<p class="muted">${sheet.file_name || ""} · <span dir="ltr">${day(sheet.created_at)}</span>${live ? "" : html` · <strong>${sheet.status === "applied" ? L(lang, "اتطبق", "Applied") : L(lang, "اتلغى", "Discarded")}</strong>`}</p>
<p data-summary>🆕 ${s.new || 0} ${L(lang, "جديد", "new")} · ✏️ ${s.changed || 0} ${L(lang, "متغير", "changed")} · ➖ ${s.removed || 0} ${L(lang, "مش موجود في الشيت", "no longer listed")} · ✅ ${s.same || 0} ${L(lang, "زي ما هو", "unchanged")} · ⚠️ ${(s.invalid || 0) + (s.repeated || 0)} ${L(lang, "صفوف فيها مشكلة", "rows with problems")}</p>
${s.unmapped?.length ? html`<p class="muted">${L(lang, "أعمدة اتجاهلت", "Ignored columns")}: ${s.unmapped.join("، ")}</p>` : ""}
<form method="post" action="${base}/sheets/${sheet.id}/apply" class="stack">
${by("new").length ? html`<section class="card"><h2>🆕 ${L(lang, "وحدات جديدة", "New units")}</h2><div class="scroll"><table><thead><tr><th>#</th><th>${L(lang, "كود المطور", "Developer code")}</th><th>${L(lang, "النوع", "Type")}</th><th>${L(lang, "المساحة", "Area")}</th><th>${L(lang, "السعر", "Price")}</th><th>${L(lang, "للمتر", "Per m²")}</th></tr></thead><tbody>${by("new").map((e) => row(e, html`<td data-new-price>${e.price_from ? L(lang, "من ", "from ") : ""}${money(e.price, lang)}</td><td>${money(e.per_m2, lang)}</td>`))}</tbody></table></div></section>` : ""}
${by("changed").length ? html`<section class="card"><h2>✏️ ${L(lang, "اتغيرت", "Changed")}</h2><div class="scroll"><table><thead><tr><th>#</th><th>${L(lang, "كود المطور", "Developer code")}</th><th>${L(lang, "النوع", "Type")}</th><th>${L(lang, "المساحة", "Area")}</th><th>${L(lang, "السعر", "Price")}</th><th>${L(lang, "الحالة", "Status")}</th></tr></thead><tbody>${by("changed").map((e) => row(e, html`<td data-changed="${e.code}">${money(e.old_price, lang)} → <strong>${money(e.price, lang)}</strong></td><td>${e.sold ? L(lang, "🔴 مباعة", "🔴 Sold") : e.old_status === "sold" ? L(lang, "🟢 رجعت متاحة", "🟢 Available again") : ""}</td>`))}</tbody></table></div></section>` : ""}
${by("removed").length ? html`<section class="card"><h2>➖ ${L(lang, "مش موجودة في الشيت الجديد", "No longer listed")}</h2><p class="muted">${L(lang, "علّم اللي اتباعت عشان تختفي من البحث. اللي مش متعلم بيفضل زي ما هو.", "Tick the ones that sold so they leave search. Unticked ones stay as they are.")}</p><ul>${by("removed").map((e) => html`<li><label><input type="checkbox" name="sold" value="${e.listing_id}"${live ? "" : " disabled"}> ${e.code}${e.dev_code ? ` · ${e.dev_code}` : ""} · ${typeLabel(e.property_type)} · ${money(e.old_price, lang)}</label></li>`)}</ul></section>` : ""}
${by("invalid").length || by("repeated").length ? html`<section class="card"><h2>⚠️ ${L(lang, "صفوف مش هتتحفظ", "Rows that will not be saved")}</h2><ul>${by("invalid").map((e) => html`<li data-invalid-row="${e.rowNumber}">${L(lang, "صف", "Row")} ${e.rowNumber}: ${errText(e.error)}</li>`)}${by("repeated").map((e) => html`<li data-repeated-row="${e.rowNumber}">${L(lang, "صف", "Row")} ${e.rowNumber}: ${L(lang, `الكود ${e.dev_code || ""} متكرر في الشيت`, `code ${e.dev_code || ""} appears twice in the sheet`)}</li>`)}</ul></section>` : ""}
${live ? html`<button type="submit">✅ ${L(lang, "تطبيق الشيت", "Apply the sheet")}</button>` : ""}
</form>
${live ? html`<form method="post" action="${base}/sheets/${sheet.id}/discard"><button type="submit" class="secondary">${L(lang, "إلغاء الشيت", "Discard")}</button></form>` : ""}`;
}

function register(web, { pool, page }) {
  const forbidden = (req, res) => res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
  const notFound = (req, res) => res.status(404).type("text/plain").send(L(langOf(req), "مش موجود", "Not found"));
  const back = (req, extra) => `/app/catalogue/projects/${req.params.id}?${extra}#prices`;
  const projectOf = async (req) => (await Catalogue.getProject(pool, req.session.broker, req.params.id))?.project || null;

  web.post("/catalogue/projects/:id/sheets", uploadSheet, async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isManager(broker)) return forbidden(req, res);
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return res.status(429).type("text/plain").send(L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment."));
    const file = req.files?.sheet?.[0];
    if (!file) return res.redirect(303, back(req, "sheet_error=NOT_XLSX"));
    const r = await PriceSheets.upload(pool, broker, req.params.id, file.buffer, { fileName: file.originalname });
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return res.redirect(303, back(req, `sheet_error=${encodeURIComponent(r.error)}`));
    return res.redirect(303, `/app/catalogue/projects/${req.params.id}/sheets/${r.sheet.id}`);
  });

  web.post("/catalogue/projects/:id/sheets/read", uploadDoc, async (req, res) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    if (!isManager(broker)) return forbidden(req, res);
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return res.status(429).type("text/plain").send(L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment."));
    const r = await PriceReading.read(pool, broker, req.params.id, { files: req.files?.doc || [], pages: req.body.pages });
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return res.redirect(303, back(req, `sheet_error=${encodeURIComponent(r.error)}${r.error === "ALLOWANCE" ? `&left=${r.left}&needed=${r.needed}` : ""}`));
    return res.redirect(303, `/app/catalogue/projects/${req.params.id}/sheets/${r.sheet.id}`);
  });

  web.get("/catalogue/projects/:id/sheets/:sid", async (req, res) => {
    const broker = req.session.broker;
    if (!isManager(broker)) return forbidden(req, res);
    const project = await projectOf(req);
    const sheet = project && (await PriceSheets.getSheet(pool, broker, project.id, req.params.sid));
    if (!sheet) return notFound(req, res);
    return page(req, res, { title: L(langOf(req), "معاينة الشيت", "Sheet preview"), body: previewPage(langOf(req), project, sheet) });
  });

  web.post("/catalogue/projects/:id/sheets/:sid/apply", async (req, res) => {
    const lang = langOf(req);
    const r = await PriceSheets.apply(pool, req.session.broker, req.params.id, req.params.sid, { markSold: [].concat(req.body.sold || []) });
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return res.status(409).type("text/plain").send(L(lang, "الشيت ده اتطبق أو اتلغى قبل كده.", "This sheet was already applied or discarded."));
    return res.redirect(303, back(req, `applied=${r.created}.${r.updated}.${r.sold}`));
  });

  web.post("/catalogue/projects/:id/sheets/:sid/discard", async (req, res) => {
    const r = await PriceSheets.discard(pool, req.session.broker, req.params.id, req.params.sid);
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error) return notFound(req, res);
    return res.redirect(303, back(req, "discarded=1"));
  });

  web.post("/catalogue/projects/:id/increases", async (req, res) => {
    const r = await PriceSheets.scheduleIncrease(pool, req.session.broker, req.params.id, { pct: req.body.pct, effectiveOn: req.body.effective_on, phaseId: req.body.phase_id || null });
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return res.redirect(303, back(req, `increase_error=${encodeURIComponent(r.field)}`));
    return res.redirect(303, back(req, r.applied ? `increased=${r.applied.units}` : "scheduled=1"));
  });

  web.post("/catalogue/projects/:id/increases/:iid/cancel", async (req, res) => {
    const r = await PriceSheets.cancelIncrease(pool, req.session.broker, req.params.id, req.params.iid);
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error) return notFound(req, res);
    return res.redirect(303, back(req, "saved=1"));
  });
}

/** The notice for the redirects above (shown on the project page). */
function pricesNotice(query, lang) {
  if (query.sheet_error) {
    const extra = query.sheet_error === "ALLOWANCE" ? L(lang, ` محتاج ${Number(query.needed) || 0} وفاضل ${Number(query.left) || 0}.`, ` Needs ${Number(query.needed) || 0}, ${Number(query.left) || 0} left.`) : "";
    return html`<p class="card notice bad" role="alert">❌ ${(READ_ERRORS[query.sheet_error] || READ_ERRORS.NOT_XLSX)[lang === "en" ? 1 : 0]}${extra}</p>`;
  }
  if (query.increase_error) return html`<p class="card notice bad" role="alert">❌ ${query.increase_error === "pct" ? L(lang, "النسبة رقم بين -50 و 100 (ومش صفر).", "The % is a number from -50 to 100 (not zero).") : L(lang, "اختار اليوم.", "Pick the date.")}</p>`;
  if (query.applied) {
    const [c, u, s] = String(query.applied).split(".").map((n) => Number(n) || 0);
    return html`<p class="card notice ok" role="status">✅ ${L(lang, `اتطبق: ${c} جديد، ${u} اتغير، ${s} اتعلم مباع.`, `Applied: ${c} new, ${u} changed, ${s} marked sold.`)}</p>`;
  }
  if (query.increased) return html`<p class="card notice ok" role="status">✅ ${L(lang, `اتطبقت على ${Number(query.increased) || 0} وحدة.`, `Applied to ${Number(query.increased) || 0} units.`)}</p>`;
  if (query.scheduled) return html`<p class="card notice ok" role="status">✅ ${L(lang, "الزيادة اتسجلت وهتتطبق في ميعادها.", "Scheduled; it applies on its date.")}</p>`;
  if (query.discarded) return html`<p class="card notice ok" role="status">✅ ${L(lang, "الشيت اتلغى.", "Sheet discarded.")}</p>`;
  return null;
}

module.exports = { register, pricesSection, pricesNotice };
