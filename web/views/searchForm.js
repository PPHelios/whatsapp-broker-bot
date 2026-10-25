// web/views/searchForm.js — The refine form: every search filter as a field, prefilled from filters
"use strict";

const Describe = require("../../domain/describe");
const Features = require("../../domain/features");
const Places = require("../../domain/places");
const { PROPERTY_TYPES } = require("../../domain/fieldRules");
const { formFromFilters } = require("../../domain/searchLink");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const sel = (on) => (on ? raw(" selected") : "");
const chk = (on) => (on ? raw(" checked") : "");
const pick = (pair, lang) => (lang === "en" ? pair[1] : pair[0]);

function numberField(name, label, value) {
  return html`<label>${label}<input type="number" name="${name}" value="${value}" min="0" step="any" inputmode="decimal"></label>`;
}

function select(name, label, value, options) {
  return html`<label>${label}<select name="${name}">${options.map(([v, t]) => html`<option value="${v}"${sel(String(value) === String(v))}>${t}</option>`)}</select></label>`;
}

/** Datalist of every known compound, developer and area name (both languages). */
function placeList() {
  const names = new Set();
  for (const [kind, dict] of [["compound", Places.COMPOUNDS], ["developer", Places.DEVELOPERS], ["area", Places.AREAS]]) {
    for (const key of Object.keys(dict)) {
      const n = Places.placeName(kind, key);
      if (n) {
        names.add(n.ar);
        names.add(n.en);
      }
    }
  }
  return html`<datalist id="places">${[...names].filter(Boolean).sort().map((n) => html`<option value="${n}">`)}</datalist>`;
}

/** The refine form (GET /app/search), prefilled from canonical filters. */
/**
 * The filter form. Search uses it as a GET to /app/search; a lead's request (step 7) as a POST to the lead page
 * ({ action, method: "post", hidden, summary, submit, clear: null }).
 */
function refineForm(filters, lang = "ar", { open = false, action = "/app/search", method = "get", hidden = "", summary = null, submit = null, clear = "/app/search" } = {}) {
  const v = formFromFilters(filters || {}, lang);
  const groups = [...new Set(Features.FEATURES.map((f) => f.group))];
  return html`<details class="card"${open ? raw(" open") : ""}>
<summary>${summary || L(lang, "🎛️ تعديل البحث", "🎛️ Refine")}</summary>
<form method="${method}" action="${action}" class="stack">${hidden}
  <div class="grid">
    ${select("listing_type", L(lang, "بيع / إيجار", "Sale / rent"), v.listing_type, [["", L(lang, "الكل", "Any")], ["sale", L(lang, "بيع", "Sale")], ["rent", L(lang, "إيجار", "Rent")]])}
    ${select("market", L(lang, "برايمري / ريسيل", "Primary / resale"), v.market, [["", L(lang, "الكل", "Any")], ["resale", L(lang, "ريسيل", "Resale")], ["primary", L(lang, "برايمري", "Primary")]])}
    <label>${L(lang, "المكان (كمبوند، مطور أو منطقة)", "Place (compound, developer or area)")}<input name="place" value="${v.place}" list="places" autocomplete="off"></label>
    <label>${L(lang, "كود الوحدة", "Unit code")}<input name="code" value="${v.code}" dir="ltr"></label>
  </div>
  <fieldset><legend>${L(lang, "النوع", "Type")}</legend><div class="row">
    ${PROPERTY_TYPES.map((t) => html`<label class="check"><input type="checkbox" name="type" value="${t}"${chk(v.type.includes(t))}>${pick(Describe.TYPE_LABELS[t], lang)}</label>`)}
  </div></fieldset>
  <div class="grid">
    ${numberField("price_min", L(lang, "السعر من", "Price from"), v.price_min)}
    ${numberField("price_max", L(lang, "السعر حتى", "Price up to"), v.price_max)}
    ${numberField("area_min", L(lang, "المساحة من (م²)", "Area from (m²)"), v.area_min)}
    ${numberField("area_max", L(lang, "المساحة حتى (م²)", "Area up to (m²)"), v.area_max)}
    ${numberField("bedrooms_min", L(lang, "غرف من", "Bedrooms from"), v.bedrooms_min)}
    ${numberField("bedrooms_max", L(lang, "غرف حتى", "Bedrooms up to"), v.bedrooms_max)}
    ${numberField("bathrooms_min", L(lang, "حمامات على الأقل", "Bathrooms at least"), v.bathrooms_min)}
    ${numberField("floor_min", L(lang, "الدور من", "Floor from"), v.floor_min)}
    ${numberField("floor_max", L(lang, "الدور حتى", "Floor up to"), v.floor_max)}
    ${select("furnishing", L(lang, "الفرش", "Furnishing"), v.furnishing, [["", L(lang, "الكل", "Any")], ["furnished", L(lang, "مفروشة", "Furnished")], ["semi_furnished", L(lang, "نصف فرش", "Semi-furnished")], ["unfurnished", L(lang, "بدون فرش", "Unfurnished")]])}
  </div>
  <fieldset><legend>${L(lang, "التشطيب", "Finishing")}</legend><div class="row">
    ${Object.entries(Describe.FINISHING_LABELS).map(([k, pair]) => html`<label class="check"><input type="checkbox" name="finishing" value="${k}"${chk(v.finishing.includes(k))}>${pick(pair, lang)}</label>`)}
  </div></fieldset>
  <fieldset><legend>${L(lang, "التسليم والدفع", "Delivery and payment")}</legend><div class="grid">
    <label class="check"><input type="checkbox" name="ready" value="1"${chk(v.ready)}>${L(lang, "استلام فوري", "Ready to move")}</label>
    ${numberField("by_year", L(lang, "تسليم قبل سنة", "Delivery by year"), v.by_year)}
    <label class="check"><input type="checkbox" name="cash" value="1"${chk(v.cash)}>${L(lang, "كاش", "Cash")}</label>
    <label class="check"><input type="checkbox" name="installments" value="1"${chk(v.installments)}>${L(lang, "تقسيط", "Installments")}</label>
    ${numberField("max_down_payment", L(lang, "أقصى مقدم", "Max down payment"), v.max_down_payment)}
    ${numberField("max_installment", L(lang, "أقصى قسط", "Max installment"), v.max_installment)}
  </div></fieldset>
  <fieldset><legend>${L(lang, "المميزات", "Features")}</legend>
    ${groups.map(
      (g) => html`<div class="row">${Features.FEATURES.filter((f) => f.group === g).map(
        (f) => html`<label class="check"><input type="checkbox" name="feature" value="${f.key}"${chk(v.feature.includes(f.key))}>${lang === "en" ? f.en : f.ar}</label>`
      )}</div>`
    )}
    <label>${L(lang, "مميزات تانية (افصل بفاصلة)", "Other features (comma separated)")}<input name="other" value="${v.other}"></label>
  </fieldset>
  <div class="row"><button type="submit">${submit || L(lang, "بحث", "Search")}</button>${clear ? html`<a class="btn secondary" href="${clear}">${L(lang, "مسح", "Clear")}</a>` : ""}</div>
</form>
${placeList()}
</details>`;
}

module.exports = { refineForm, placeList };
