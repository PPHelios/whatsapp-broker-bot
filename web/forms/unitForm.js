// web/forms/unitForm.js — The add/edit form ⇄ listing fields (pure). The form is the full desired
// state of the unit: a cleared field becomes NULL, unticked features are removed.
"use strict";

const L = require("../../lib/listing");
const T = require("../../lib/text");
const Features = require("../../domain/features");
const { PROPERTY_TYPES, unitKind } = require("../../domain/fieldRules");

const FINISHING = ["core_and_shell", "semi_finished", "fully_finished", "super_lux", "ultra_super_lux"];
const FURNISHING = ["furnished", "semi_furnished", "unfurnished"];
const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"];
const PLAN_ROWS = 3;

// Columns and detail keys the form owns (everything else on the row is kept as it is).
const FORM_COLUMNS = [
  "listing_type", "market", "property_type", "compound", "district", "city", "price_value", "area_value", "bedrooms",
  "bathrooms", "floor_level", "finishing", "furnishing", "delivery_year", "delivery_quarter", "delivery_month", "is_ready",
  "delivery_raw", "down_payment_value", "remaining_amount", "installment_value", "payment_frequency", "installments_end",
  "installment_years", "maintenance_pct"
];
const FORM_DETAILS = ["land_area", "garden_area", "roof_area", "project", "developer", "rent_period", "currency", "owner_name", "owner_phone", "owner_lead", "commission", "co_broker", "notes", "clean_summary"];
const INTERNAL_DETAILS = ["owner_name", "owner_phone", "owner_lead", "commission", "co_broker", "notes"];

const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v);
const many = (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);
const str = (v, max = 200) => {
  const s = String(one(v) ?? "").trim();
  return s ? s.slice(0, max) : null;
};
const num = (v) => {
  const s = T.normalizeDigits(String(one(v) ?? "")).replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const pos = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
/** "8.5 مليون", "9,500,000", "750 الف" → number. */
const money = (v) => {
  const s = str(v, 60);
  if (!s) return null;
  const plain = pos(s);
  if (plain !== null) return plain;
  const p = T.parseEgyptianPrice(T.normalizeDigits(s));
  return p?.priceValue > 0 ? p.priceValue : null;
};
const oneOf = (v, list) => (list.includes(one(v)) ? one(v) : null);
const checked = (v) => ["1", "on", "true", "yes"].includes(String(one(v) ?? ""));
const monthToDate = (v) => {
  const s = str(v, 10);
  return s && /^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(s) ? `${s.slice(0, 7)}-01` : null;
};

/** Form body → listing fields (columns + details + payment_terms + features). */
function unitFromForm(body = {}) {
  const market = oneOf(body.market, ["resale", "primary"]) || "resale";
  const ready = checked(body.is_ready);
  const plans = [];
  for (let i = 1; i <= PLAN_ROWS; i++) {
    const p = {
      plan_id: `p${plans.length + 1}`,
      down_payment_pct: num(body[`plan_down_${i}`]),
      years: num(body[`plan_years_${i}`]),
      frequency: oneOf(body[`plan_freq_${i}`], FREQUENCIES),
      delivery_pct: null
    };
    if (p.down_payment_pct !== null || p.years !== null) plans.push(p);
  }
  const year = int(body.delivery_year);
  const out = {
    code: str(body.code, 30),
    listing_type: oneOf(body.listing_type, ["sale", "rent"]),
    market,
    property_type: oneOf(body.property_type, PROPERTY_TYPES),
    compound: str(body.compound, 120),
    district: str(body.district, 120),
    city: str(body.city, 120),
    price_value: money(body.price_value),
    area_value: pos(body.area_value),
    bedrooms: int(body.bedrooms),
    bathrooms: int(body.bathrooms),
    floor_level: int(body.floor_level),
    finishing: oneOf(body.finishing, FINISHING),
    furnishing: oneOf(body.furnishing, FURNISHING),
    is_ready: ready ? true : null,
    delivery_year: ready ? null : year && year >= 2000 && year <= 2100 ? year : null,
    delivery_quarter: ready ? null : oneOf(int(body.delivery_quarter), [1, 2, 3, 4]),
    delivery_month: null,
    delivery_raw: null,
    down_payment_value: market === "resale" ? money(body.down_payment_value) : null,
    remaining_amount: market === "resale" ? money(body.remaining_amount) : null,
    installment_value: market === "resale" ? money(body.installment_value) : null,
    payment_frequency: market === "resale" ? oneOf(body.payment_frequency, FREQUENCIES) : null,
    installments_end: market === "resale" ? monthToDate(body.installments_end) : null,
    installment_years: null,
    maintenance_pct: market === "primary" ? pos(body.maintenance_pct) : null,
    feature_keys: Features.sortKeys(many(body.feature).filter((k) => Features.featureLabel(k, "en"))),
    features_other: [...new Set(String(one(body.features_other) || "").split(/[,،\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 20),
    payment_terms: market === "primary" ? { plans, cash_price: money(body.cash_price), maintenance_terms: str(body.maintenance_terms, 200) } : {},
    details: {
      land_area: pos(body.land_area),
      garden_area: pos(body.garden_area),
      roof_area: pos(body.roof_area),
      project: str(body.project, 120),
      developer: str(body.developer, 120),
      rent_period: oneOf(body.rent_period, ["monthly", "yearly"]),
      currency: oneOf(body.currency, ["USD", "EUR"]),
      owner_name: str(body.owner_name, 120),
      owner_phone: str(body.owner_phone, 40),
      owner_lead: str(body.owner_lead, 20),
      commission: str(body.commission, 120),
      co_broker: str(body.co_broker, 120),
      notes: str(body.notes, 1000),
      clean_summary: str(body.clean_summary, 600)
    }
  };
  return out;
}

/**
 * The stored row a form asks for: composeFields with the existing row (title, images, search
 * keywords, ... are kept), then every form-owned field set exactly as the form says.
 */
function composeFromForm({ existing = null, form, lang = "ar" }) {
  const composed = L.composeFields({ existing, draft: form, lang });
  for (const col of FORM_COLUMNS) composed[col] = form[col] ?? null;
  composed.feature_keys = form.feature_keys;
  composed.features_other = form.features_other;
  composed.market = form.market;
  composed.inventory_type = form.market === "primary" ? "primary_unit" : existing?.inventory_type && existing.inventory_type !== "primary_unit" ? existing.inventory_type : "resale_unit";
  // Payment terms: the form owns plans, cash price and maintenance terms; other stored terms stay.
  composed.payment_terms = form.market === "primary" ? { ...(existing?.payment_terms || {}), ...form.payment_terms } : {};
  const details = { ...(existing?.details || {}) };
  for (const k of FORM_DETAILS) {
    if (form.details[k] === null || form.details[k] === undefined) delete details[k];
    else details[k] = form.details[k];
  }
  if (!existing) details.lang = lang;
  if (unitKind(composed.property_type) === "villa") {
    composed.floor_level = null;
    delete details.floor;
    delete details.floor_en;
    details.bua = composed.area_value ?? null;
  }
  composed.details = details;
  return composed;
}

const fmt = (v) => (v === null || v === undefined ? "" : String(v));
const toMonth = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 7) : "");

/** A listing (stored or composed) → form values. */
function formFromUnit(l = {}) {
  const d = l.details || {};
  const plans = l.payment_terms?.plans || [];
  const v = {
    code: fmt(l.code),
    listing_type: fmt(l.listing_type),
    market: fmt(l.market || "resale"),
    property_type: fmt(l.property_type),
    compound: fmt(l.compound),
    district: fmt(l.district),
    city: fmt(l.city),
    price_value: fmt(l.price_value),
    area_value: fmt(l.area_value),
    bedrooms: fmt(l.bedrooms),
    bathrooms: fmt(l.bathrooms),
    floor_level: fmt(l.floor_level),
    finishing: fmt(l.finishing),
    furnishing: fmt(l.furnishing),
    is_ready: l.is_ready === true,
    delivery_year: fmt(l.delivery_year),
    delivery_quarter: fmt(l.delivery_quarter),
    down_payment_value: fmt(l.down_payment_value),
    remaining_amount: fmt(l.remaining_amount),
    installment_value: fmt(l.installment_value),
    payment_frequency: fmt(l.payment_frequency),
    installments_end: toMonth(l.installments_end),
    maintenance_pct: fmt(l.maintenance_pct),
    cash_price: fmt(l.payment_terms?.cash_price),
    maintenance_terms: fmt(l.payment_terms?.maintenance_terms),
    feature: l.feature_keys || [],
    features_other: (l.features_other || []).join("، ")
  };
  for (let i = 1; i <= PLAN_ROWS; i++) {
    const p = plans[i - 1] || {};
    v[`plan_down_${i}`] = fmt(p.down_payment_pct);
    v[`plan_years_${i}`] = fmt(p.years);
    v[`plan_freq_${i}`] = fmt(p.frequency);
  }
  for (const k of FORM_DETAILS) v[k] = fmt(d[k]);
  return v;
}

module.exports = {
  FORM_COLUMNS,
  FORM_DETAILS,
  INTERNAL_DETAILS,
  PLAN_ROWS,
  FREQUENCIES,
  unitFromForm,
  composeFromForm,
  formFromUnit,
  money
};
