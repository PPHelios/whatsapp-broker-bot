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

/** Chip-style checkbox / radio (the input stays real for forms and screen readers). */
const pill = (type, name, value, on, label) => html`<label class="pill"><input type="${type}" name="${name}" value="${value}"${chk(on)}><span>${label}</span></label>`;

/** One collapsible group in the filter sheet; open when any of its fields is set. */
const group = (title, on, body) => html`<details class="fgroup"${on ? raw(" open") : ""}><summary>${title}</summary><div class="fbody">${body}</div></details>`;

/** How many filters are set (shown on the sheet's button). */
function countSet(v) {
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (k === "other" || k === "code" || k === "place") n += val ? 1 : 0;
    else if (Array.isArray(val)) n += val.length;
    else if (val !== "" && val !== false && val != null) n += 1;
  }
  return n;
}

/**
 * The filter sheet. Search uses it as a GET to /app/search; a lead's request (step 7) as a POST to the lead page
 * ({ action, method: "post", hidden, summary, submit, clear: null }). Quick filters sit on top; the rest fold into
 * groups so the sheet fits a phone screen.
 */
function refineForm(filters, lang = "ar", { open = false, action = "/app/search", method = "get", hidden = "", summary = null, submit = null, clear = "/app/search" } = {}) {
  const v = formFromFilters(filters || {}, lang);
  const groups = [...new Set(Features.FEATURES.map((f) => f.group))];
  const n = countSet(v);
  const any = (...vals) => vals.some((x) => (Array.isArray(x) ? x.length : x !== "" && x !== false && x != null));
  return html`<details class="card sheet"${open ? raw(" open") : ""}>
<summary>${summary || html`${L(lang, "الفلاتر", "Filters")}${n ? html` <span class="chip">${n}</span>` : ""}`}</summary>
<form method="${method}" action="${action}" class="stack">${hidden}
  <div class="pills" role="group" aria-label="${L(lang, "بيع / إيجار", "Sale / rent")}">
    ${pill("radio", "listing_type", "", !v.listing_type, L(lang, "الكل", "Any"))}${pill("radio", "listing_type", "sale", v.listing_type === "sale", L(lang, "بيع", "Sale"))}${pill("radio", "listing_type", "rent", v.listing_type === "rent", L(lang, "إيجار", "Rent"))}
    <span class="sep"></span>
    ${pill("radio", "market", "", !v.market, L(lang, "الكل", "Any"))}${pill("radio", "market", "resale", v.market === "resale", L(lang, "ريسيل", "Resale"))}${pill("radio", "market", "primary", v.market === "primary", L(lang, "برايمري", "Primary"))}
  </div>
  <label>${L(lang, "المكان (كمبوند، مطور أو منطقة)", "Place (compound, developer or area)")}<input name="place" value="${v.place}" list="places" autocomplete="off"></label>
  <div class="pills" role="group" aria-label="${L(lang, "النوع", "Type")}">
    ${PROPERTY_TYPES.map((t) => pill("checkbox", "type", t, v.type.includes(t), pick(Describe.TYPE_LABELS[t], lang)))}
  </div>
  <div class="grid two">
    ${numberField("price_min", L(lang, "السعر من", "Price from"), v.price_min)}
    ${numberField("price_max", L(lang, "السعر حتى", "Price up to"), v.price_max)}
  </div>
  ${group(L(lang, "المساحة والغرف والدور", "Size, rooms and floor"), any(v.area_min, v.area_max, v.bedrooms_min, v.bedrooms_max, v.bathrooms_min, v.floor_min, v.floor_max), html`<div class="grid two">
    ${numberField("area_min", L(lang, "المساحة من (م²)", "Area from (m²)"), v.area_min)}
    ${numberField("area_max", L(lang, "المساحة حتى (م²)", "Area up to (m²)"), v.area_max)}
    ${numberField("bedrooms_min", L(lang, "غرف من", "Bedrooms from"), v.bedrooms_min)}
    ${numberField("bedrooms_max", L(lang, "غرف حتى", "Bedrooms up to"), v.bedrooms_max)}
    ${numberField("bathrooms_min", L(lang, "حمامات على الأقل", "Bathrooms at least"), v.bathrooms_min)}
    ${numberField("floor_min", L(lang, "الدور من", "Floor from"), v.floor_min)}
    ${numberField("floor_max", L(lang, "الدور حتى", "Floor up to"), v.floor_max)}
  </div>`)}
  ${group(L(lang, "التشطيب والفرش", "Finishing and furnishing"), any(v.finishing, v.furnishing), html`<div class="pills">
    ${Object.entries(Describe.FINISHING_LABELS).map(([k, pair]) => pill("checkbox", "finishing", k, v.finishing.includes(k), pick(pair, lang)))}
  </div>
  ${select("furnishing", L(lang, "الفرش", "Furnishing"), v.furnishing, [["", L(lang, "الكل", "Any")], ["furnished", L(lang, "مفروشة", "Furnished")], ["semi_furnished", L(lang, "نصف فرش", "Semi-furnished")], ["unfurnished", L(lang, "بدون فرش", "Unfurnished")]])}`)}
  ${group(L(lang, "التسليم والدفع", "Delivery and payment"), any(v.ready, v.by_year, v.cash, v.installments, v.max_down_payment, v.max_installment), html`<div class="pills">
    ${pill("checkbox", "ready", "1", v.ready, L(lang, "استلام فوري", "Ready to move"))}${pill("checkbox", "cash", "1", v.cash, L(lang, "كاش", "Cash"))}${pill("checkbox", "installments", "1", v.installments, L(lang, "تقسيط", "Installments"))}
  </div>
  <div class="grid two">
    ${numberField("by_year", L(lang, "تسليم قبل سنة", "Delivery by year"), v.by_year)}
    ${numberField("max_down_payment", L(lang, "أقصى مقدم", "Max down payment"), v.max_down_payment)}
    ${numberField("max_installment", L(lang, "أقصى قسط", "Max installment"), v.max_installment)}
  </div>`)}
  ${group(L(lang, "المميزات", "Features"), any(v.feature, v.other), html`${groups.map(
    (g) => html`<div class="pills">${Features.FEATURES.filter((f) => f.group === g).map((f) => pill("checkbox", "feature", f.key, v.feature.includes(f.key), lang === "en" ? f.en : f.ar))}</div>`
  )}
    <label>${L(lang, "مميزات تانية (افصل بفاصلة)", "Other features (comma separated)")}<input name="other" value="${v.other}"></label>`)}
  ${group(L(lang, "كود الوحدة", "Unit code"), any(v.code), html`<label>${L(lang, "كود الوحدة", "Unit code")}<input name="code" value="${v.code}" dir="ltr"></label>`)}
  <div class="row sheet-actions"><button type="submit">${submit || L(lang, "بحث", "Search")}</button>${clear ? html`<a class="btn secondary" href="${clear}">${L(lang, "مسح", "Clear")}</a>` : ""}</div>
</form>
${placeList()}
</details>`;
}

module.exports = { refineForm, placeList };
