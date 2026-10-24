// domain/sheetImport.js — Inventory spreadsheet rows → listing fields (pure)
// Headers are matched in Arabic or English (including the agency export's own headers), wherever the
// header row is. Only the columns the sheet has are stated; a missing column never clears a field.
"use strict";

const Features = require("./features");
const Delivery = require("./delivery");
const { TYPE_TERMS } = require("./vocabulary");
const { normalizeSearch } = require("./searchText");

// Checked in order: the first match wins (e.g. "owner phone" before "owner").
const COLUMNS = [
  ["code", /^(code|unit code|unit id|ref|كود|الكود|كود الوحده|الكود الداخلي)$/],
  ["owner_phone", /(owner phone|owner mobile|تليفون المالك|رقم المالك|موبايل المالك)/],
  ["owner_name", /^(owner|owner name|المالك|اسم المالك)$/],
  ["summary_en", /^summary/],
  ["description", /(description|الوصف|وصف)/],
  ["title", /^(title|العنوان)$/],
  ["compound", /(compound|project|الكمبوند|كمبوند|المشروع)/],
  ["market", /(market|inventory|السوق|نوع المخزون)/],
  ["property_type", /^(property type|type|unit type|نوع|النوع|نوع العقار|نوع الوحده)$/],
  ["listing_type", /^(purpose|sale rent|sale or rent|بيع او ايجار|بيع ايجار|الغرض)$/],
  ["remaining_amount", /(remaining|المتبقي)/],
  ["down_payment_value", /(upfront cash|cash paid|paid|down payment|المدفوع|المقدم|مقدم)/],
  ["installment_value", /(quarterly check|installment amount|installment|قيمه القسط|القسط)/],
  ["payment_frequency", /(frequency|دوريه القسط)/],
  ["installment_years", /(tenure|years|سنوات|سنين)/],
  ["price_value", /^(price|total price|asking price|السعر|سعر|اجمالي السعر|السعر الاجمالي)( egp)?$/],
  ["area_value", /^(area|area sqm|bua|المساحه|مساحه|المساحه م2|المساحه بالمتر)/],
  ["bedrooms", /(bedrooms|beds|غرف|الغرف)/],
  ["bathrooms", /(bathrooms|baths|حمامات|الحمامات)/],
  ["floor", /^(floor|الدور|دور)$/],
  ["delivery", /(delivery|التسليم|الاستلام|استلام)/],
  ["finishing", /(finishing|التشطيب|تشطيب)/],
  ["orientation", /(orientation|الواجهه|واجهه)/],
  ["features", /(amenities|features|extras|المميزات|مميزات)/],
  ["district", /(district|city|area name|المنطقه|الحي|المدينه)/],
  ["status", /^(status|الحاله)$/],
  ["notes", /(notes|ملاحظات)/]
];

/** Header text → field key (or null). */
function columnFor(header) {
  const h = normalizeSearch(header);
  if (!h) return null;
  for (const [key, re] of COLUMNS) if (re.test(h)) return key;
  return null;
}

const EMPTY = new Set(["", "-", "—", "n/a", "na", "null", "none", "لا يوجد"]);
// A leading apostrophe is the export's formula-injection guard (lib/excel.js sanitizeCellValue), not data.
const isEmpty = (v) => v === null || v === undefined || EMPTY.has(String(v).trim().replace(/^'+/, "").toLowerCase());
const text = (v, max = 200) => (isEmpty(v) ? null : String(v).trim().replace(/^'+/, "").slice(0, max));
const unquote = (v) => (typeof v === "string" ? v.trim().replace(/^'+/, "") : v);
const AR = "٠١٢٣٤٥٦٧٨٩";
const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

/** "8.5 مليون", "8,500,000", "8.5M", 8500000 → 8500000; 0 and unknown → null. */
function money(v) {
  if (isEmpty(v)) return null;
  if (typeof v === "number") return v > 0 ? v : null;
  const s = digits(v).toLowerCase().replace(/egp|le|ج\.?م|جنيه/g, "").trim();
  const m = s.match(/^([\d.,]+)\s*(m|mn|million|مليون|k|الف|ألف|thousand)?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || "";
  return /^(m|mn|million|مليون)$/.test(unit) ? Math.round(n * 1e6) : /^(k|الف|ألف|thousand)$/.test(unit) ? Math.round(n * 1e3) : n;
}
const number = (v) => {
  if (isEmpty(v)) return null;
  const n = typeof v === "number" ? v : Number(digits(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => {
  const n = number(v);
  return n !== null && n > 0 ? n : null;
};

const TYPE_LOOKUP = new Map(
  Object.entries({ ...TYPE_TERMS, villa: [...TYPE_TERMS.villa, "standalone villa"] }).flatMap(([key, words]) => words.map((w) => [normalizeSearch(w), key]))
);
function propertyType(v) {
  const t = normalizeSearch(v);
  if (!t) return null;
  if (TYPE_LOOKUP.has(t)) return TYPE_LOOKUP.get(t);
  for (const [w, key] of TYPE_LOOKUP) if (w.length >= 4 && t.includes(w)) return key;
  return null;
}

const FINISHING = [
  ["ultra_super_lux", /(ultra|الترا)/],
  ["super_lux", /(super ?lux|سوبر لوكس)/],
  ["semi_finished", /(semi|نص تشطيب|نصف تشطيب)/],
  ["core_and_shell", /(core|shell|بدون تشطيب|طوب احمر|خرسانه)/],
  ["fully_finished", /(fully|full|finished|تشطيب كامل|متشطب|كامل التشطيب|لوكس)/]
];
const finishing = (v) => {
  const t = normalizeSearch(v);
  return t ? FINISHING.find(([, re]) => re.test(t))?.[0] || null : null;
};
const listingType = (v) => {
  const t = normalizeSearch(v);
  return /(rent|ايجار)/.test(t) ? "rent" : /(sale|بيع)/.test(t) ? "sale" : null;
};
const market = (v) => {
  const t = normalizeSearch(v);
  return /(primary|developer|برايمري|مطور)/.test(t) ? "primary" : /(resale|ريسيل|اعاده بيع)/.test(t) ? "resale" : null;
};
const status = (v) => {
  const t = normalizeSearch(v);
  return /(sold|مباع|اتباع)/.test(t) ? "sold" : /(archiv|مؤرشف|مورشف|ارشيف)/.test(t) ? "archived" : /(active|available|متاح|نشط)/.test(t) ? "active" : null;
};
const FREQ = [["semi_annual", /(semi|نص سنوي|نصف سنوي)/], ["quarterly", /(quarter|ربع)/], ["monthly", /(month|شهري)/], ["annual", /(annual|year|سنوي)/]];
const frequency = (v) => {
  const t = normalizeSearch(v);
  return t ? FREQ.find(([, re]) => re.test(t))?.[0] || null : null;
};

/**
 * One sheet row → { code, status, draft } where draft has the normalizeExtraction shape with only the
 * stated fields; errors lists what could not be read.
 * @param {Object} cells - field key → raw cell value
 */
function rowToDraft(input = {}) {
  const cells = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, unquote(v)]));
  const draft = { details: {} };
  const errors = [];
  const has = (k) => k in cells && !isEmpty(cells[k]);
  const code = has("code") ? digits(String(cells.code)).trim().toUpperCase().replace(/^#/, "") : null;
  if (code && !/^[A-Z0-9][A-Z0-9_\-./]{1,29}$/.test(code)) errors.push("code");

  if (has("compound")) draft.compound = text(cells.compound, 120);
  if (has("title")) draft.title = text(cells.title);
  if (has("district")) draft.district = text(cells.district, 120);
  if (has("property_type")) {
    draft.property_type = propertyType(cells.property_type);
    if (!draft.property_type) errors.push("property_type");
  }
  if (has("listing_type")) draft.listing_type = listingType(cells.listing_type);
  if (has("market")) draft.market = market(cells.market);
  for (const k of ["price_value", "down_payment_value", "remaining_amount", "installment_value"]) {
    if (has(k)) {
      draft[k] = money(cells[k]);
      if (draft[k] === null && k === "price_value") errors.push(k);
    }
  }
  if (has("area_value")) {
    draft.area_value = positive(cells.area_value);
    if (!draft.area_value) errors.push("area_value");
  }
  for (const k of ["bedrooms", "bathrooms", "installment_years"]) {
    if (has(k)) {
      const n = number(cells[k]);
      draft[k] = n === null ? null : Math.round(n);
      if (k === "installment_years" && !draft[k]) delete draft[k];
    }
  }
  if (has("payment_frequency")) draft.payment_frequency = frequency(cells.payment_frequency);
  if (has("floor")) {
    const f = String(cells.floor).trim();
    const n = number(f);
    if (/^(ground|ارضي|أرضي|الارضي)$/i.test(f)) draft.floor_level = 0;
    else if (n !== null && /^\D*\d+\D*$/.test(digits(f))) draft.floor_level = Math.round(n);
    else draft.details.floor = text(f, 40);
  }
  if (has("delivery")) Object.assign(draft, Delivery.parseDelivery(text(cells.delivery, 60)));
  if (has("finishing")) draft.finishing = finishing(cells.finishing);
  if (has("features") || has("orientation")) {
    const words = [cells.features, cells.orientation]
      .filter((x) => !isEmpty(x))
      .flatMap((x) => String(x).split(/[•,،\/|\n;]+/))
      .map((x) => x.trim())
      .filter(Boolean);
    const { keys, other } = Features.classifyFeatures(words);
    draft.feature_keys = keys;
    draft.features_other = other;
  }
  if (has("description")) draft.details.clean_summary = text(cells.description, 600);
  if (has("summary_en")) draft.details.summary_en = text(cells.summary_en, 600);
  if (has("owner_name")) draft.details.owner_name = text(cells.owner_name, 120);
  if (has("owner_phone")) draft.details.owner_phone = text(digits(cells.owner_phone), 40);
  if (has("notes")) draft.details.notes = text(cells.notes, 1000);
  for (const k of Object.keys(draft)) if (draft[k] === null || draft[k] === undefined) delete draft[k];
  for (const k of Object.keys(draft.details)) if (draft.details[k] === null) delete draft.details[k];
  return { code, status: has("status") ? status(cells.status) : null, draft, errors };
}

module.exports = { COLUMNS, columnFor, rowToDraft, money, propertyType, finishing };
