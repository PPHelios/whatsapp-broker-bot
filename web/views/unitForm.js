// web/views/unitForm.js — Add/edit form, the review panel (the only web surface with field warnings)
"use strict";

const Describe = require("../../domain/describe");
const Features = require("../../domain/features");
const Rules = require("../../domain/fieldRules");
const { PLAN_ROWS, FREQUENCIES } = require("../forms/unitForm");
const Credits = require("../../services/credits");
const { html, raw } = require("../html");
const { factList } = require("./units");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const pick = (pair, lang) => (pair ? (lang === "en" ? pair[1] : pair[0]) : "");
const sel = (on) => (on ? raw(" selected") : "");
const chk = (on) => (on ? raw(" checked") : "");

/** A label with a star is a required field: it gets the "req" outline (neutral colour; red only after a failed check). */
const req = (label) => (/\*/.test(String(label)) ? raw(' class="req"') : "");
function input(name, label, value, { type = "text", dir = null, extra = "" } = {}) {
  return html`<label${req(label)}>${label}<input name="${name}" type="${type}" value="${value}"${dir ? html` dir="${dir}"` : ""}${raw(extra)}></label>`;
}
function select(name, label, value, options) {
  return html`<label${req(label)}>${label}<select name="${name}">${options.map(([v, t]) => html`<option value="${v}"${sel(String(value) === String(v))}>${t}</option>`)}</select></label>`;
}

const freqOptions = (lang) => [["", "—"], ...FREQUENCIES.map((f) => [f, Describe.frequencyLabel(f, lang)])];

/**
 * @param {Object} p - { values (formFromUnit), mode: "new"|"edit", code, version, images, lang, notice, error, review, duplicate (P13: the save button becomes "Save anyway") }
 */
/** One place box: type or pick; a known place fills its area (shown as one line); an unknown one warns, then opens the add-new part. */
function placeBox(v, areas, lang) {
  const nameOf = (a) => a.name_en || a.name_ar;
  const byId = (id) => areas.find((a) => String(a.id) === String(id));
  const path = [byId(v.area_id), byId(v.subzone_id)].filter(Boolean).map(nameOf).join(" › ");
  const isNew = v.compound_new === "1";
  const hid = (on) => (on ? raw(" hidden") : "");
  const tops = areas.filter((a) => !a.parent_id);
  return html`<div class="place" data-place
    data-msg-warn="${L(lang, "«%s» مش في القائمة. اختار اللي قريب منه، أو ضيفه كجديد.", "“%s” is not in the list. Pick a close match, or add it as new.")}"
    data-msg-did="${L(lang, "قصدك:", "Did you mean:")}">
    ${input("compound", L(lang, "الكمبوند (أو اختار منطقة)", "Compound (or pick an area)"), v.compound, { extra: ' list="approved-places" autocomplete="off" data-place-suggest' })}
    <p class="place-line" data-place-summary${hid(isNew || !path)}>📍 <b data-place-path>${path}</b></p>
    <div class="place-warn" data-place-warn hidden role="status">
      <p data-place-warn-text></p>
      <div class="row" data-place-did></div>
      <button type="button" class="btn ghost" data-place-add>${L(lang, "＋ ضيفه ككمبوند جديد", "+ Add it as a new compound")}</button>
    </div>
    <fieldset class="place-new" data-place-new${hid(!isNew)}>
      <legend>${L(lang, "كمبوند جديد", "New compound")}</legend>
      <p class="muted small">${L(lang, "بيتحفظ مع الوحدة وبيتراجع من الإدارة. الحقول اللي عليها * مطلوبة.", "It is saved with the unit and reviewed by the CRM owner. Fields with * are required.")}</p>
      <label class="req">${L(lang, "المنطقة *", "Area *")}<select name="area_id"><option value="">${L(lang, "اختار المنطقة (مثال: القاهرة الجديدة)", "Pick the area (e.g. New Cairo)")}</option>${tops.map((a) => html`<option value="${a.id}"${sel(String(v.area_id) === String(a.id))}>${nameOf(a)}</option>`)}</select></label>
      <label>${L(lang, "منطقة فرعية (اختياري)", "Sub-zone (optional)")}<select name="subzone_id"><option value="">—</option>${tops.map((t) => html`<optgroup label="${nameOf(t)}">${areas.filter((s2) => s2.parent_id === t.id).map((a) => html`<option value="${a.id}"${sel(String(v.subzone_id) === String(a.id))}>${nameOf(a)}</option>`)}</optgroup>`)}</select></label>
      <label>${L(lang, "الاسم بالعربي (اختياري)", "Arabic name (optional)")}<input name="compound_ar" value="${v.compound_ar || ""}" placeholder="${L(lang, "مثال: هايد بارك", "Arabic spelling, if you know it")}"></label>
      <label>${L(lang, "لينك جوجل ماب (اختياري)", "Google Maps link (optional)")}<input name="compound_pin" dir="ltr" value="${v.compound_pin || ""}" placeholder="https://www.google.com/maps/…"></label>
      <input type="hidden" name="compound_new" value="1"${isNew ? "" : raw(" disabled")}>
      <button type="button" class="btn ghost" data-place-cancel>${L(lang, "إلغاء", "Cancel")}</button>
    </fieldset>
  </div>`;
}

function unitForm({ values: v, mode = "new", code = null, version = null, images = [], lang = "ar", notice = null, error = null, review = null, csrf = "", duplicate = null, areas = [], extraValues = null }) {
  if (extraValues) v = { ...v, ...extraValues };
  const action = mode === "edit" ? `/app/units/${encodeURIComponent(code)}/edit` : "/app/units/new";
  const groups = [...new Set(Features.FEATURES.map((f) => f.group))];
  // A new unit is added in 4 steps (app.js shows one at a time); editing, an error or a review shows everything.
  const stepped = mode === "new" && !error && !review && !duplicate;
  return html`<form id="unit-form" method="post" action="${action}" enctype="multipart/form-data" class="stack" data-progress${stepped ? html` data-steps="${L(lang, "الوحدة والسعر|التسليم والدفع|المميزات|الصور والحفظ", "Unit and price|Delivery and payment|Features|Photos and save")}" data-next="${L(lang, "التالي", "Next")}" data-prev="${L(lang, "رجوع", "Back")}" data-check="/app/units/step-check"` : ""}>
  <input type="hidden" name="_csrf" value="${csrf}">
  <input type="hidden" name="warn_gate" value="1">
  <input type="hidden" name="save_key" value="${require("crypto").randomBytes(12).toString("base64url")}">
  ${notice ? html`<p class="card notice">${notice}</p>` : ""}
  ${error ? html`<p class="card notice bad" role="alert">${error}</p>` : ""}
  ${mode === "edit" ? html`<input type="hidden" name="version" value="${version}"><input type="hidden" name="code" value="${code}">` : ""}

  <section class="card stack" data-step="1">
    <h2>✨ ${L(lang, "املأ من وصف أو فويس", "Fill from a description or a voice note")}</h2>
    <label>${L(lang, "الوصف (زي ما بتبعته للبوت)", "Description (as you would send it to the bot)")}<textarea name="describe" rows="3"></textarea></label>
    <div class="row">
      <button type="button" class="secondary" data-ai="unit_fill" hx-post="/app/units/extract" hx-encoding="multipart/form-data" hx-include="#unit-form" hx-target="#unit-form" hx-swap="outerHTML">✨ ${L(lang, "املأ من الوصف", "Fill from text")}</button>
      <button type="button" class="secondary" data-ai="voice_unit_add" data-voice-target="#unit-form" data-voice-url="/app/units/extract" data-stop="■ ${L(lang, "إيقاف وإرسال", "Stop and send")}" data-unsupported="${L(lang, "المتصفح ده مش بيدعم التسجيل", "Recording is not supported here")}">🎙️ ${L(lang, "سجّل فويس", "Record voice")} <span class="muted">(${L(lang, `${Credits.costOf("voice")} رصيد`, `${Credits.costOf("voice")} credits`)})</span></button>
      <label class="btn secondary">📎 ${L(lang, "حمل ملف فويس", "Upload voice file")} <span class="muted">(${L(lang, `${Credits.costOf("voice")} رصيد`, `${Credits.costOf("voice")} credits`)})</span><input type="file" name="voice" accept="audio/*" multiple hidden data-voice-file data-cost="${Credits.costOf("voice")}"></label>
      <span class="spinner" aria-hidden="true"></span>
    </div>
  </section>

  <section class="card" data-step="1"><h2>🏠 ${L(lang, "الوحدة", "Unit")}</h2><div class="grid">
    ${mode === "new" ? input("code", L(lang, "الكود (اختياري)", "Code (optional)"), v.code, { dir: "ltr" }) : html`<p><strong>${code}</strong></p>`}
    ${select("listing_type", L(lang, "بيع أو إيجار *", "Sale or rent *"), v.listing_type, [["", "—"], ["sale", L(lang, "بيع", "Sale")], ["rent", L(lang, "إيجار", "Rent")]])}
    ${v.market === "primary" ? select("market", L(lang, "ريسيل أو برايمري", "Resale or primary"), v.market, [["resale", L(lang, "ريسيل", "Resale")], ["primary", L(lang, "برايمري (من المطور)", "Primary (developer)")]]) : ""}
    ${select("property_type", L(lang, "النوع *", "Type *"), v.property_type, [["", "—"], ...Rules.PROPERTY_TYPES.map((t) => [t, pick(Describe.TYPE_LABELS[t], lang)])])}
    ${placeBox(v, areas, lang)}
    ${input("district", L(lang, "الحي", "District"), v.district)}
    ${input("city", L(lang, "المدينة", "City"), v.city)}
    ${input("price_value", L(lang, "السعر * (الإيجار الشهري للإيجار)", "Price * (monthly rent for rentals)"), v.price_value, { extra: ` inputmode="decimal" placeholder="${L(lang, "8.5 مليون", "8.5M")}"` })}
    ${select("currency", L(lang, "العملة", "Currency"), v.currency, [["", "EGP"], ["USD", "USD"], ["EUR", "EUR"]])}
    ${select("rent_period", L(lang, "الإيجار", "Rent period"), v.rent_period, [["", "—"], ["monthly", L(lang, "شهري", "Monthly")], ["yearly", L(lang, "سنوي", "Yearly")]])}
    ${input("area_value", L(lang, "المساحة م² * (المباني للفيلات)", "Area m² * (BUA for villas)"), v.area_value, { type: "number", extra: ' min="0" step="any"' })}
    ${input("bedrooms", L(lang, "الغرف *", "Bedrooms *"), v.bedrooms, { type: "number", extra: ' min="0"' })}
    ${input("bathrooms", L(lang, "الحمامات", "Bathrooms"), v.bathrooms, { type: "number", extra: ' min="0"' })}
    ${input("floor_level", L(lang, "الدور (0 = أرضي)", "Floor (0 = ground)"), v.floor_level, { type: "number" })}
    ${select("finishing", L(lang, "التشطيب", "Finishing"), v.finishing, [["", "—"], ...Object.entries(Describe.FINISHING_LABELS).map(([k, p]) => [k, pick(p, lang)])])}
    ${select("furnishing", L(lang, "الفرش", "Furnishing"), v.furnishing, [["", "—"], ["furnished", L(lang, "مفروشة", "Furnished")], ["semi_furnished", L(lang, "نصف فرش", "Semi-furnished")], ["unfurnished", L(lang, "بدون فرش", "Unfurnished")], ["kitchen_and_ac", L(lang, "مطبخ وتكييف", "Kitchen and AC")], ["ac_only", L(lang, "تكييف بس", "AC only")], ["kitchen_only", L(lang, "مطبخ بس", "Kitchen only")]])}
    ${input("land_area", L(lang, "مساحة الأرض م²", "Land area m²"), v.land_area, { type: "number", extra: ' min="0" step="any"' })}
    ${input("garden_area", L(lang, "الجنينة م²", "Garden m²"), v.garden_area, { type: "number", extra: ' min="0" step="any"' })}
    ${input("roof_area", L(lang, "الروف م²", "Roof m²"), v.roof_area, { type: "number", extra: ' min="0" step="any"' })}
  </div></section>

  <section class="card" data-step="2"><h2>🗓 ${L(lang, "التسليم", "Delivery")}</h2><div class="grid">
    <label class="check"><input type="checkbox" name="is_ready" value="1"${chk(v.is_ready)}>${L(lang, "استلام فوري", "Ready to move")}</label>
    ${input("delivery_year", L(lang, "سنة التسليم", "Delivery year"), v.delivery_year, { type: "number", extra: ' min="2000" max="2100"' })}
    ${select("delivery_quarter", L(lang, "الربع", "Quarter"), v.delivery_quarter, [["", "—"], ["1", "Q1"], ["2", "Q2"], ["3", "Q3"], ["4", "Q4"]])}
  </div></section>

  <section class="card tabs" data-tabs="pay" data-step="2"><h2>💳 ${L(lang, "الدفع", "Payment")}</h2>
    <input type="radio" name="pay_tab" id="pay-tab-resale" class="tab-radio" value="resale"${chk(v.market !== "primary")}>
    <input type="radio" name="pay_tab" id="pay-tab-primary" class="tab-radio" value="primary"${chk(v.market === "primary")}>
    <div class="tab-bar" role="tablist"><label for="pay-tab-resale" role="tab">${L(lang, "ريسيل بالتقسيط", "Resale with installments")}</label><label for="pay-tab-primary" role="tab">${L(lang, "برايمري", "Primary")}</label></div>
    <div class="tab-panel panel-resale" role="tabpanel">
      <div class="grid">
      ${input("down_payment_value", L(lang, "المدفوع (الكاش المطلوب)", "Paid (cash required)"), v.down_payment_value, { extra: ' inputmode="decimal"' })}
      ${input("remaining_amount", L(lang, "المتبقي أقساط", "Remaining installments"), v.remaining_amount, { extra: ' inputmode="decimal"' })}
      ${input("installment_value", L(lang, "قيمة القسط", "Installment amount"), v.installment_value, { extra: ' inputmode="decimal"' })}
      ${select("payment_frequency", L(lang, "دورية القسط", "Frequency"), v.payment_frequency, freqOptions(lang))}
      ${input("installments_end", L(lang, "آخر قسط", "Last installment"), v.installments_end, { type: "month" })}
      </div>
    </div>
    <div class="tab-panel panel-primary" role="tabpanel">
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
    </div>
  </section>

  <section class="card" data-step="3"><h2>✨ ${L(lang, "المميزات", "Features")}</h2>
    ${groups.map(
      (g) => html`<div class="row">${Features.FEATURES.filter((f) => f.group === g).map(
        (f) => html`<label class="check"><input type="checkbox" name="feature" value="${f.key}"${chk(v.feature.includes(f.key))}>${lang === "en" ? f.en : f.ar}</label>`
      )}</div>`
    )}
    <label>${L(lang, "مميزات تانية (افصل بفاصلة)", "Other features (comma separated)")}<input name="features_other" value="${v.features_other}"></label>
    <label>${L(lang, "وصف للعميل", "Description for clients")}<textarea name="clean_summary" rows="2">${v.clean_summary}</textarea></label>
  </section>

  <section class="card" data-step="3"><h2>🔒 ${L(lang, "بيانات داخلية (مش بتظهر للعميل)", "Internal (never shown to clients)")}</h2><div class="grid">
    ${input("owner_name", L(lang, "المالك *", "Owner *"), v.owner_name)}
    ${input("owner_phone", L(lang, "تليفون المالك *", "Owner phone *"), v.owner_phone, { type: "tel", dir: "ltr" })}
    <label class="check"><input type="checkbox" name="owner_name_from_phone" value="1"${chk(v.owner_name_from_phone)}>${L(lang, "مفيش اسم: استخدم التليفون كاسم", "No name: use the phone as the name")}</label>
    ${input("owner_lead", L(lang, "كود العميل لو المالك عميل عندك (L-0042)", "Lead code if the owner is your client (L-0042)"), v.owner_lead, { dir: "ltr", extra: ' placeholder="L-0042" list="lead-codes"' })}
    <details class="more"${[v.commission, v.co_broker, v.unit_no, v.address, v.pin].some(Boolean) ? raw(" open") : ""}><summary>${L(lang, "تفاصيل أكتر (عمولة، وسيط، عنوان، لوكيشن)", "More details (commission, co-broker, address, location)")}</summary><div class="grid">
    ${input("commission", L(lang, "العمولة", "Commission"), v.commission)}
    ${input("co_broker", L(lang, "وسيط مشارك", "Co-broker"), v.co_broker)}
    ${input("unit_no", L(lang, "رقم الوحدة", "Unit no."), v.unit_no, { dir: "ltr" })}
    ${input("address", L(lang, "العنوان (للشركة بس)", "Address (agency only)"), v.address)}
    ${input("pin", L(lang, "لينك جوجل ماب أو الإحداثيات", "Google Maps link or coordinates"), v.pin, { dir: "ltr" })}
    </div></details>
  </div>
  <label>${L(lang, "ملاحظات", "Notes")}<textarea name="notes" rows="2">${v.notes}</textarea></label></section>

  <section class="card" data-step="4"><h2>📷 ${L(lang, "الصور (حتى 15)", "Photos (up to 15)")}</h2>
    ${images.length
      ? html`<p class="muted">${L(lang, "اسحب الصور (أو استخدم الأسهم) لترتيبها؛ الأولى هي الغلاف. لو رتّبتها بنفسك مش بنستخدم الذكاء الاصطناعي للترتيب، وده بيوفر رصيدك.", "Drag the photos (or use the arrows) to order them; the first is the cover. A hand-set order skips AI ordering, which saves your AI credits.")}</p>
    <ol data-sortable class="photo-order">${images.map(
          (i) => html`<li draggable="true" data-photo="${i.id}"><input type="hidden" name="photo_order" value="${i.id}"><img src="${i.url}" alt="" loading="lazy" data-wait>
      <span class="grow"><input type="checkbox" name="remove_photo" value="${i.id}" hidden><button type="button" class="secondary" data-remove-photo>🗑 ${L(lang, "احذف", "Delete")}</button></span>
      <button type="button" class="secondary" data-move="up" aria-label="${L(lang, "لفوق", "Up")}">↑</button><button type="button" class="secondary" data-move="down" aria-label="${L(lang, "لتحت", "Down")}">↓</button></li>`
        )}</ol>`
      : ""}
    <input type="file" name="photos" accept="image/*" multiple data-photo-tray>
    <label class="muted">${L(lang, "أو زيب من \"تحميل الكل\" في واتساب (صور الوحدة دي بس؛ الفيديوهات بتتشال):", "Or a zip from WhatsApp \"Download all\" (this unit's photos; videos are dropped):")} <input type="file" accept=".zip,application/zip" data-photo-zip></label>
    <p class="notice warn" data-photo-note hidden></p>
    <ol data-sortable data-photo-preview class="photo-order" hidden></ol>
    <p class="muted" data-photo-preview-hint hidden>${L(lang, "اسحب الصور (أو الأسهم) لترتيبها قبل الحفظ؛ الأولى هي الغلاف.", "Drag the photos (or arrows) to order them before saving; the first is the cover.")}</p>
    <label class="check" data-photo-manual-box><input type="checkbox" name="photo_manual" value="on" data-photo-manual> ${L(lang, "رتّبتها بنفسي: من غير ترتيب بالذكاء الاصطناعي (بيوفر رصيد الذكاء الاصطناعي)", "I ordered them myself: no AI ordering (saves AI credits)")}</label>
  </section>

  <div id="review" data-step="4" data-auto-review hx-post="/app/units/review" hx-trigger="review-run" hx-encoding="multipart/form-data" hx-include="#unit-form" hx-target="this" hx-swap="innerHTML">${review || ""}</div>
  <div class="row" data-step="4" data-save-row>
    ${duplicate
      ? html`<button type="submit" name="force" value="1">✅ ${L(lang, "احفظ برضه", "Save anyway")}</button>`
      : html`<button type="submit" name="action" value="save" data-tg-main>✅ ${L(lang, "حفظ", "Save")}</button>`}
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
function reviewPanel(evaluation, lang = "ar", { duplicate = null, catalogue = null, changes = [] } = {}) {
  const { blockers, warnings, listing } = evaluation;
  return html`<section class="card" data-review="${blockers.length ? "blocked" : "ok"}">
  <h2>📋 ${L(lang, "مراجعة قبل الحفظ", "Review before saving")}</h2>
  ${blockers.length
    ? html`<div class="notice bad card"><strong>⛔ ${L(lang, "ناقص لإتمام الحفظ:", "Still needed to save:")}</strong><ul>${blockers.map((b) => html`<li data-blocker="${b.field}" role="button" tabindex="0">${lang === "en" ? b.label_en : b.label_ar}</li>`)}</ul></div>`
    : html`<p class="ok">✅ ${L(lang, "جاهزة للحفظ.", "Ready to save.")}${warnings.length ? "" : html` ${L(lang, "مفيش تنبيهات، مش محتاج تعلّم حاجة.", "No warnings, nothing to tick.")}`}</p>`}
  ${changes.length ? html`<div class="notice card" data-changes><strong>✏️ ${L(lang, "اللي اتغير:", "What changed:")}</strong><ul>${changes.map((c) => html`<li data-change="${c.field}">${lang === "en" ? c.en : c.ar}: <span dir="ltr">${c.from} → ${c.to}</span></li>`)}</ul></div>` : ""}
  ${duplicate ? duplicateNotice(duplicate, lang) : catalogue ? catalogueNotice(catalogue, lang) : ""}
  ${warnings.length ? html`<ul class="warn">${warnings.map((w) => html`<li data-warning="${w.field}">${Rules.warningLine(w, lang)}</li>`)}</ul>
  ${blockers.length ? "" : html`<label class="check ack"><input type="checkbox" name="warn_ack" value="1" data-warn-ack> ${L(lang, "راجعت التنبيهات وعايز أحفظ", "I checked the warnings and want to save")}</label><p class="muted" data-ack-hint>${L(lang, "زر الحفظ مقفول لحد ما تعلّم المربع ده.", "Save stays off until you tick this box.")}</p>`}` : ""}
  ${factList({ ...listing, code: listing.code || "—" }, lang)}
</section>`;
}

module.exports = { unitForm, reviewPanel };
