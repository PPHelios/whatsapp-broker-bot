// domain/fieldRules.js — The Release 1 field table: what blocks saving and what is only warned (pure)
// Mandatory fields block saving. Warnings appear in the add/edit review only, never in client copy,
// search results or briefs. Optional fields are never asked about.
"use strict";

const { hasDelivery } = require("./delivery");

const APARTMENT_LIKE = ["apartment", "duplex", "penthouse", "chalet"];
const VILLA_LIKE = ["villa", "townhouse", "twinhouse"];
const COMMERCIAL = ["office", "shop", "clinic", "commercial"];
const PROPERTY_TYPES = [...APARTMENT_LIKE, "studio", ...VILLA_LIKE, ...COMMERCIAL, "land"];

const MISMATCH_TOLERANCE_EGP = 100;

const normType = (t) => String(t || "").toLowerCase().replace(/[\s_-]/g, "");
const present = (v) => v !== null && v !== undefined && v !== "" && !(typeof v === "number" && Number.isNaN(v));
const positive = (v) => present(v) && Number(v) > 0;

/** Unit kind for the field table: apartment | studio | villa | commercial | land | unknown. */
function unitKind(propertyType) {
  const t = normType(propertyType);
  if (t === "studio") return "studio";
  if (APARTMENT_LIKE.includes(t)) return "apartment";
  if (VILLA_LIKE.includes(t) || t === "standalone") return "villa";
  if (COMMERCIAL.includes(t)) return "commercial";
  if (t === "land") return "land";
  return "unknown";
}

/**
 * Payment case: rent | primary | resale_installments | resale_cash.
 * A resale is "with installments" as soon as any part of a remaining schedule is known.
 */
function paymentCase(l = {}) {
  if (l.listing_type === "rent") return "rent";
  if (l.market === "primary") return "primary";
  const installmentSignals = [l.remaining_amount, l.installment_value, l.installment_years, l.installments_end];
  if (installmentSignals.some(positive) || (positive(l.down_payment_value) && positive(l.price_value) && Number(l.down_payment_value) < Number(l.price_value))) {
    return "resale_installments";
  }
  return "resale_cash";
}

// Bilingual labels for every field the table can name.
const LABELS = {
  listing_type: ["بيع أو إيجار", "Sale or rent"],
  property_type: ["نوع الوحدة", "Property type"],
  location: ["الكمبوند (أو الحي والمدينة)", "Compound (or district and city)"],
  area_value: ["المساحة", "Area"],
  bua: ["مساحة المباني (BUA)", "Built-up area (BUA)"],
  price_value: ["السعر", "Price"],
  monthly_rent: ["الإيجار الشهري", "Monthly rent"],
  bedrooms: ["عدد الغرف", "Bedrooms"],
  resale_two_of_three: ["اتنين من: إجمالي السعر، المدفوع، المتبقي", "Two of: total price, paid, remaining"],
  primary_plan: ["نظام سداد (مقدم % وسنين) أو سعر كاش", "A payment plan (down % and years) or a cash price"],
  photos: ["الصور", "Photos"],
  finishing: ["التشطيب", "Finishing"],
  bathrooms: ["عدد الحمامات", "Bathrooms"],
  floor: ["الدور", "Floor"],
  land_area: ["مساحة الأرض", "Land area"],
  delivery: ["موعد التسليم", "Delivery date"],
  delivery_or_ready: ["موعد التسليم (أو استلام فوري)", "Delivery (or ready to move)"],
  installment_value: ["قيمة القسط", "Installment amount"],
  payment_frequency: ["دورية القسط", "Installment frequency"],
  installments_end: ["تاريخ آخر قسط", "Last installment date"],
  project_or_developer: ["المشروع أو المطور", "Project or developer"],
  maintenance: ["شروط الصيانة", "Maintenance terms"],
  furnishing: ["حالة الفرش", "Furnished status"]
};

function item(field, lang, extra = {}) {
  const [ar, en] = LABELS[field] || [field, field];
  return { field, label_ar: ar, label_en: en, label: lang === "en" ? en : ar, ...extra };
}

/**
 * Applies the automatic rules that need no question (studio → 0 bedrooms; commercial → no bedrooms)
 * and derives the third resale amount from the other two. Returns a new object.
 */
function normalizeForRules(input = {}) {
  const l = { ...input };
  const kind = unitKind(l.property_type);
  if (kind === "studio") l.bedrooms = 0;
  if (kind === "commercial" || kind === "land") l.bedrooms = null;
  // A 0-bedroom flat is a studio (never for villas or commercial units).
  if (kind === "apartment" && normType(l.property_type) === "apartment" && Number(l.bedrooms) === 0 && present(l.bedrooms)) {
    l.property_type = "studio";
  }

  if (paymentCase(l) === "resale_installments") {
    const total = positive(l.price_value) ? Number(l.price_value) : null;
    const paid = positive(l.down_payment_value) ? Number(l.down_payment_value) : null;
    const rem = positive(l.remaining_amount) ? Number(l.remaining_amount) : null;
    if (total === null && paid !== null && rem !== null) l.price_value = paid + rem;
    else if (paid === null && total !== null && rem !== null && total > rem) l.down_payment_value = total - rem;
    else if (rem === null && total !== null && paid !== null && total > paid) l.remaining_amount = total - paid;
  }
  return l;
}

/**
 * Evaluates a listing (draft or edited row) against the field table.
 * @param {Object} listing - top-level listing fields (+ details, payment_terms)
 * @param {Object} [opts] - { lang, photoCount }
 * @returns {{ ok, blockers, warnings, listing, kind, case }}
 */
function evaluate(listing = {}, { lang = "ar", photoCount = null } = {}) {
  const l = normalizeForRules(listing);
  const d = l.details || {};
  const kind = unitKind(l.property_type);
  const pcase = paymentCase(l);
  const blockers = [];
  const warnings = [];

  // All units
  if (!["sale", "rent"].includes(l.listing_type)) blockers.push(item("listing_type", lang));
  if (kind === "unknown") blockers.push(item("property_type", lang));
  const hasPlace = present(String(l.compound || "").trim()) || (present(String(l.district || "").trim()) && present(String(l.city || "").trim()));
  if (!hasPlace) blockers.push(item("location", lang));
  if (!positive(l.area_value)) blockers.push(item(kind === "villa" ? "bua" : "area_value", lang));

  // Bedrooms
  if ((kind === "apartment" || kind === "villa") && !(present(l.bedrooms) && Number(l.bedrooms) >= 1)) {
    blockers.push(item("bedrooms", lang));
  }

  // Price by payment case
  if (pcase === "rent") {
    if (!positive(l.price_value)) blockers.push(item("monthly_rent", lang));
  } else if (pcase === "resale_installments") {
    const known = [l.price_value, l.down_payment_value, l.remaining_amount].filter(positive).length;
    if (known < 2) blockers.push(item("resale_two_of_three", lang));
  } else if (pcase === "primary") {
    const plans = (l.payment_terms?.plans || []).filter((p) => present(p.down_payment_pct) && present(p.years));
    const cashPrice = positive(l.payment_terms?.cash_price);
    if (!positive(l.price_value)) blockers.push(item("price_value", lang));
    if (!plans.length && !cashPrice) blockers.push(item("primary_plan", lang));
  } else if (!positive(l.price_value)) {
    blockers.push(item("price_value", lang));
  }

  // Warnings: all units
  if (photoCount !== null && photoCount === 0) warnings.push(item("photos", lang));
  if (kind !== "land" && !present(l.finishing) && !present(d.finishing)) warnings.push(item("finishing", lang));

  // Warnings by unit kind
  const floorKnown = present(l.floor_level) || present(d.floor);
  if (kind === "apartment" || kind === "studio") {
    if (!present(l.bathrooms)) warnings.push(item("bathrooms", lang));
    if (!floorKnown) warnings.push(item("floor", lang));
  } else if (kind === "villa") {
    if (!positive(d.land_area) && !positive(l.land_area)) warnings.push(item("land_area", lang));
    if (!present(l.bathrooms)) warnings.push(item("bathrooms", lang));
  } else if (kind === "commercial") {
    if (!floorKnown) warnings.push(item("floor", lang));
  }

  // Warnings by payment case
  if (pcase === "resale_cash") {
    if (!hasDelivery(l)) warnings.push(item("delivery_or_ready", lang));
  } else if (pcase === "resale_installments") {
    if (!positive(l.installment_value)) warnings.push(item("installment_value", lang));
    if (!present(l.payment_frequency)) warnings.push(item("payment_frequency", lang));
    if (!present(l.installments_end)) warnings.push(item("installments_end", lang));
    if (!hasDelivery(l)) warnings.push(item("delivery", lang));
    const mismatch = resaleMismatch(listing);
    if (mismatch) warnings.push({ ...item("resale_two_of_three", lang), field: "resale_mismatch", mismatch });
  } else if (pcase === "primary") {
    if (!present(d.project) && !present(d.developer)) warnings.push(item("project_or_developer", lang));
    if (!hasDelivery(l)) warnings.push(item("delivery", lang));
    if (!present(l.maintenance_pct) && !present(l.payment_terms?.maintenance_terms)) warnings.push(item("maintenance", lang));
  } else if (pcase === "rent") {
    if (!present(l.furnishing)) warnings.push(item("furnishing", lang));
  }

  return { ok: blockers.length === 0, blockers, warnings, listing: l, kind, case: pcase };
}

/** Total vs paid + remaining mismatch above the tolerance, on the values the broker gave. */
function resaleMismatch(l = {}) {
  const total = Number(l.price_value);
  const paid = Number(l.down_payment_value);
  const rem = Number(l.remaining_amount);
  if (!(total > 0 && paid > 0 && rem > 0)) return null;
  const diff = Math.abs(total - (paid + rem));
  return diff > MISMATCH_TOLERANCE_EGP ? { total, paid, remaining: rem, diff } : null;
}

/** One warning line, e.g. "⚠️ موعد التسليم غير مسجل". Only for add/edit review screens. */
function warningLine(w, lang = "ar") {
  if (w.field === "resale_mismatch") {
    const m = w.mismatch;
    const fmt = (n) => Number(n).toLocaleString("en-US");
    return lang === "en"
      ? `⚠️ Total ${fmt(m.total)} ≠ paid ${fmt(m.paid)} + remaining ${fmt(m.remaining)} (difference ${fmt(m.diff)})`
      : `⚠️ الإجمالي ${fmt(m.total)} لا يساوي المدفوع ${fmt(m.paid)} + المتبقي ${fmt(m.remaining)} (الفرق ${fmt(m.diff)})`;
  }
  return lang === "en" ? `⚠️ ${w.label_en} not recorded` : `⚠️ ${w.label_ar} غير مسجل`;
}

/** One blocker line for the "still needed" list. */
function blockerLine(b, lang = "ar") {
  return `• ${lang === "en" ? b.label_en : b.label_ar}`;
}

module.exports = {
  PROPERTY_TYPES,
  APARTMENT_LIKE,
  VILLA_LIKE,
  COMMERCIAL,
  MISMATCH_TOLERANCE_EGP,
  unitKind,
  paymentCase,
  normalizeForRules,
  evaluate,
  resaleMismatch,
  warningLine,
  blockerLine
};
