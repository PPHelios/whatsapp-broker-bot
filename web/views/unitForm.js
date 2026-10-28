// web/views/unitForm.js — Add/edit form, the review panel (the only web surface with field warnings)
"use strict";

const Describe = require("../../domain/describe");
const Features = require("../../domain/features");
const Rules = require("../../domain/fieldRules");
const { PLAN_ROWS, FREQUENCIES } = require("../forms/unitForm");
const { html, raw } = require("../html");
const { factList } = require("./units");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const pick = (pair, lang) => (pair ? (lang === "en" ? pair[1] : pair[0]) : "");
const sel = (on) => (on ? raw(" selected") : "");
const chk = (on) => (on ? raw(" checked") : "");

function input(name, label, value, { type = "text", dir = null, extra = "" } = {}) {
  return html`<label>${label}<input name="${name}" type="${type}" value="${value}"${dir ? html` dir="${dir}"` : ""}${raw(extra)}></label>`;
}
function select(name, label, value, options) {
  return html`<label>${label}<select name="${name}">${options.map(([v, t]) => html`<option value="${v}"${sel(String(value) === String(v))}>${t}</option>`)}</select></label>`;
}

const freqOptions = (lang) => [["", "—"], ...FREQUENCIES.map((f) => [f, Describe.frequencyLabel(f, lang)])];

/**
 * @param {Object} p - { values (formFromUnit), mode: "new"|"edit", code, version, images, lang, notice, error, review, duplicate (P13: the save button becomes "Save anyway") }
 */
function unitForm({ values: v, mode = "new", code = null, version = null, images = [], lang = "ar", notice = null, error = null, review = null, csrf = "", duplicate = null }) {
  const action = mode === "edit" ? `/app/units/${encodeURIComponent(code)}/edit` : "/app/units/new";
  const groups = [...new Set(Features.FEATURES.map((f) => f.group))];
  return html`<form id="unit-form" method="post" action="${action}" enctype="multipart/form-data" class="stack">
  <input type="hidden" name="_csrf" value="${csrf}">
  ${notice ? html`<p class="card notice">${notice}</p>` : ""}
  ${error ? html`<p class="card notice bad" role="alert">${error}</p>` : ""}
  ${mode === "edit" ? html`<input type="hidden" name="version" value="${version}"><input type="hidden" name="code" value="${code}">` : ""}

  <section class="card stack">
    <h2>✨ ${L(lang, "املأ من وصف أو فويس", "Fill from a description or a voice note")}</h2>
    <label>${L(lang, "الوصف (زي ما بتبعته للبوت)", "Description (as you would send it to the bot)")}<textarea name="describe" rows="3"></textarea></label>
    <div class="row">
      <button type="button" class="secondary" hx-post="/app/units/extract" hx-encoding="multipart/form-data" hx-include="#unit-form" hx-target="#unit-form" hx-swap="outerHTML">✨ ${L(lang, "املأ من الوصف", "Fill from text")}</button>
      <button type="button" class="secondary" data-voice-target="#unit-form" data-voice-url="/app/units/extract" data-stop="■ ${L(lang, "إيقاف وإرسال", "Stop and send")}" data-unsupported="${L(lang, "المتصفح ده مش بيدعم التسجيل", "Recording is not supported here")}">🎙️ ${L(lang, "سجّل فويس", "Record voice")}</button>
      <span class="spinner" aria-hidden="true"></span>
    </div>
  </section>

  <section class="card"><h2>🏠 ${L(lang, "الوحدة", "Unit")}</h2><div class="grid">
    ${mode === "new" ? input("code", L(lang, "الكود (اختياري)", "Code (optional)"), v.code, { dir: "ltr" }) : html`<p><strong>${code}</strong></p>`}
    ${select("listing_type", L(lang, "بيع أو إيجار *", "Sale or rent *"), v.listing_type, [["", "—"], ["sale", L(lang, "بيع", "Sale")], ["rent", L(lang, "إيجار", "Rent")]])}
    ${select("market", L(lang, "ريسيل أو برايمري", "Resale or primary"), v.market, [["resale", L(lang, "ريسيل", "Resale")], ["primary", L(lang, "برايمري (من المطور)", "Primary (developer)")]])}
    ${select("property_type", L(lang, "النوع *", "Type *"), v.property_type, [["", "—"], ...Rules.PROPERTY_TYPES.map((t) => [t, pick(Describe.TYPE_LABELS[t], lang)])])}
    ${input("compound", L(lang, "الكمبوند *", "Compound *"), v.compound, { extra: ' list="places"' })}
    ${input("district", L(lang, "الحي", "District"), v.district)}
    ${input("city", L(lang, "المدينة", "City"), v.city)}
    ${input("price_value", L(lang, "السعر * (الإيجار الشهري للإيجار)", "Price * (monthly rent for rentals)"), v.price_value, { extra: ` inputmode="decimal" placeholder="${L(lang, "8.5 مليون", "8.5M")}"` })}
    ${select("currency", L(lang, "العملة", "Currency"), v.currency, [["", "EGP"], ["USD", "USD"], ["EUR", "EUR"]])}
    ${select("rent_period", L(lang, "الإيجار", "Rent period"), v.rent_period, [["", "—"], ["monthly", L(lang, "شهري", "Monthly")], ["yearly", L(lang, "سنوي", "Yearly")]])}
    ${input("area_value", L(lang, "المساحة م² * (المباني للفيلات)", "Area m² * (BUA for villas)"), v.area_value, { type: "number", extra: ' min="0" step="any"' })}
    ${input("bedrooms", L(lang, "الغرف", "Bedrooms"), v.bedrooms, { type: "number", extra: ' min="0"' })}
    ${input("bathrooms", L(lang, "الحمامات", "Bathrooms"), v.bathrooms, { type: "number", extra: ' min="0"' })}
    ${input("floor_level", L(lang, "الدور (0 = أرضي)", "Floor (0 = ground)"), v.floor_level, { type: "number" })}
    ${select("finishing", L(lang, "التشطيب", "Finishing"), v.finishing, [["", "—"], ...Object.entries(Describe.FINISHING_LABELS).map(([k, p]) => [k, pick(p, lang)])])}
    ${select("furnishing", L(lang, "الفرش", "Furnishing"), v.furnishing, [["", "—"], ["furnished", L(lang, "مفروشة", "Furnished")], ["semi_furnished", L(lang, "نصف فرش", "Semi-furnished")], ["unfurnished", L(lang, "بدون فرش", "Unfurnished")]])}
    ${input("land_area", L(lang, "مساحة الأرض م²", "Land area m²"), v.land_area, { type: "number", extra: ' min="0" step="any"' })}
    ${input("garden_area", L(lang, "الجنينة م²", "Garden m²"), v.garden_area, { type: "number", extra: ' min="0" step="any"' })}
    ${input("roof_area", L(lang, "الروف م²", "Roof m²"), v.roof_area, { type: "number", extra: ' min="0" step="any"' })}
  </div></section>

  <section class="card"><h2>🗓 ${L(lang, "التسليم", "Delivery")}</h2><div class="grid">
    <label class="check"><input type="checkbox" name="is_ready" value="1"${chk(v.is_ready)}>${L(lang, "استلام فوري", "Ready to move")}</label>
    ${input("delivery_year", L(lang, "سنة التسليم", "Delivery year"), v.delivery_year, { type: "number", extra: ' min="2000" max="2100"' })}
    ${select("delivery_quarter", L(lang, "الربع", "Quarter"), v.delivery_quarter, [["", "—"], ["1", "Q1"], ["2", "Q2"], ["3", "Q3"], ["4", "Q4"]])}
  </div></section>

  <section class="card"><h2>💳 ${L(lang, "الدفع", "Payment")}</h2>
    <h3>${L(lang, "ريسيل بالتقسيط", "Resale with installments")}</h3>
    <div class="grid">
      ${input("down_payment_value", L(lang, "المدفوع (الكاش المطلوب)", "Paid (cash required)"), v.down_payment_value, { extra: ' inputmode="decimal"' })}
      ${input("remaining_amount", L(lang, "المتبقي أقساط", "Remaining installments"), v.remaining_amount, { extra: ' inputmode="decimal"' })}
      ${input("installment_value", L(lang, "قيمة القسط", "Installment amount"), v.installment_value, { extra: ' inputmode="decimal"' })}
      ${select("payment_frequency", L(lang, "دورية القسط", "Frequency"), v.payment_frequency, freqOptions(lang))}
      ${input("installments_end", L(lang, "آخر قسط", "Last installment"), v.installments_end, { type: "month" })}
    </div>
    <h3>${L(lang, "برايمري", "Primary")}</h3>
    <div class="grid">
      ${input("cash_price", L(lang, "سعر الكاش", "Cash price"), v.cash_price, { extra: ' inputmode="decimal"' })}
      ${input("maintenance_pct", L(lang, "الصيانة %", "Maintenance %"), v.maintenance_pct, { type: "number", extra: ' min="0" step="any"' })}
      ${input("maintenance_terms", L(lang, "شروط الصيانة", "Maintenance terms"), v.maintenance_terms)}
      ${input("project", L(lang, "المشروع", "Project"), v.project)}
      ${input("developer", L(lang, "المطور", "Developer"), v.developer)}
    </div>
    ${Array.from({ length: PLAN_ROWS }, (_, k) => k + 1).map(
      (i) => html`<div class="grid">
      ${input(`plan_down_${i}`, L(lang, `نظام ${i}: مقدم %`, `Plan ${i}: down %`), v[`plan_down_${i}`], { type: "number", extra: ' min="0" max="100" step="any"' })}
      ${input(`plan_years_${i}`, L(lang, "سنين", "Years"), v[`plan_years_${i}`], { type: "number", extra: ' min="0" step="any"' })}
      ${select(`plan_freq_${i}`, L(lang, "الدورية", "Frequency"), v[`plan_freq_${i}`], freqOptions(lang))}
    </div>`
    )}
  </section>

  <section class="card"><h2>✨ ${L(lang, "المميزات", "Features")}</h2>
    ${groups.map(
      (g) => html`<div class="row">${Features.FEATURES.filter((f) => f.group === g).map(
        (f) => html`<label class="check"><input type="checkbox" name="feature" value="${f.key}"${chk(v.feature.includes(f.key))}>${lang === "en" ? f.en : f.ar}</label>`
      )}</div>`
    )}
    <label>${L(lang, "مميزات تانية (افصل بفاصلة)", "Other features (comma separated)")}<input name="features_other" value="${v.features_other}"></label>
    <label>${L(lang, "وصف للعميل", "Description for clients")}<textarea name="clean_summary" rows="2">${v.clean_summary}</textarea></label>
  </section>

  <section class="card"><h2>🔒 ${L(lang, "بيانات داخلية (مش بتظهر للعميل)", "Internal (never shown to clients)")}</h2><div class="grid">
    ${input("owner_name", L(lang, "المالك", "Owner"), v.owner_name)}
    ${input("owner_phone", L(lang, "تليفون المالك", "Owner phone"), v.owner_phone, { type: "tel", dir: "ltr" })}
    ${input("commission", L(lang, "العمولة", "Commission"), v.commission)}
    ${input("co_broker", L(lang, "وسيط مشارك", "Co-broker"), v.co_broker)}
  </div>
  <label>${L(lang, "ملاحظات", "Notes")}<textarea name="notes" rows="2">${v.notes}</textarea></label></section>

  <section class="card"><h2>📷 ${L(lang, "الصور (حتى 15)", "Photos (up to 15)")}</h2>
    ${images.length
      ? html`<p class="muted">${L(lang, "اسحب الصور (أو استخدم الأسهم) لترتيبها؛ الأولى هي الغلاف. الترتيب اليدوي مش بيتغير بالذكاء الاصطناعي.", "Drag the photos (or use the arrows) to order them; the first is the cover. A hand-set order is never changed by AI.")}</p>
    <ol data-sortable class="photo-order">${images.map(
          (i) => html`<li draggable="true" data-photo="${i.id}"><input type="hidden" name="photo_order" value="${i.id}"><img src="${i.url}" alt="" loading="lazy">
      <label class="check grow"><input type="checkbox" name="remove_photo" value="${i.id}">${L(lang, "حذف", "Remove")}</label>
      <button type="button" class="secondary" data-move="up" aria-label="${L(lang, "لفوق", "Up")}">↑</button><button type="button" class="secondary" data-move="down" aria-label="${L(lang, "لتحت", "Down")}">↓</button></li>`
        )}</ol>`
      : ""}
    <input type="file" name="photos" accept="image/*" multiple>
  </section>

  <div id="review">${review || ""}</div>
  <div class="row">
    <button type="button" class="secondary" hx-post="/app/units/review" hx-encoding="multipart/form-data" hx-include="#unit-form" hx-target="#review">📋 ${L(lang, "مراجعة", "Review")}</button>
    ${duplicate
      ? html`<button type="submit" name="force" value="1">✅ ${L(lang, "احفظ برضه", "Save anyway")}</button>`
      : html`<button type="submit" name="action" value="save">✅ ${L(lang, "حفظ", "Save")}</button>`}
    ${mode === "edit" ? html`<a class="btn secondary" href="/app/units/${encodeURIComponent(code)}">${L(lang, "إلغاء", "Cancel")}</a>` : ""}
  </div>
</form>`;
}

/** P13: "looks like VIL-08" with a link to open it. */
const duplicateNotice = (code, lang) =>
  html`<p class="notice warn" data-duplicate="${code}">⚠️ ${L(lang, "شكلها نفس الوحدة", "This looks like")} <a href="/app/units/${encodeURIComponent(code)}">${code}</a> ${L(lang, "اللي عندك. لو دي وحدة تانية، احفظ برضه.", "already listed. If it is another unit, save anyway.")}</p>`;

const catalogueNotice = (c, lang) =>
  html`<p class="notice" data-catalogue-match="${c.code}">ℹ️ ${L(lang, "شبه", "Looks like")} ${c.model ? L(lang, "نموذج", "a model") : c.dev_code ? `${L(lang, "الوحدة", "unit")} ${c.dev_code}` : L(lang, "وحدة", "a unit")} ${L(lang, "في مشروع", "in")} ${c.project || "—"} ${L(lang, "في الكتالوج", "in your catalogue")} (<a href="/app/units/${encodeURIComponent(c.code)}">${c.code}</a>). ${L(lang, "لو هي نفسها، استخدم وحدة الكتالوج.", "If it is the same, use the catalogue unit.")}</p>`;

/** Review panel: what blocks saving, the field warnings (only here and in WhatsApp review), the preview. */
function reviewPanel(evaluation, lang = "ar", { duplicate = null, catalogue = null } = {}) {
  const { blockers, warnings, listing } = evaluation;
  return html`<section class="card" data-review="${blockers.length ? "blocked" : "ok"}">
  <h2>📋 ${L(lang, "مراجعة قبل الحفظ", "Review before saving")}</h2>
  ${blockers.length
    ? html`<div class="notice bad card"><strong>⛔ ${L(lang, "ناقص لإتمام الحفظ:", "Still needed to save:")}</strong><ul>${blockers.map((b) => html`<li data-blocker="${b.field}">${lang === "en" ? b.label_en : b.label_ar}</li>`)}</ul></div>`
    : html`<p class="ok">✅ ${L(lang, "جاهزة للحفظ.", "Ready to save.")}</p>`}
  ${duplicate ? duplicateNotice(duplicate, lang) : catalogue ? catalogueNotice(catalogue, lang) : ""}
  ${warnings.length ? html`<ul class="warn">${warnings.map((w) => html`<li data-warning="${w.field}">${Rules.warningLine(w, lang)}</li>`)}</ul>` : ""}
  ${factList({ ...listing, code: listing.code || "—" }, lang)}
</section>`;
}

module.exports = { unitForm, reviewPanel };
