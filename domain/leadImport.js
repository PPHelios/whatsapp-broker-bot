// domain/leadImport.js — Lead spreadsheet rows (CSV or .xlsx) → capture inputs (pure). Q11: name, phone (required),
// second phone, type of lead, source, budget, area or compound, property type, bedrooms, sale or rent, notes, stage,
// assigned broker and lawful basis, with Arabic or English headers. Only what a cell states is read: nothing is guessed.
"use strict";

const Phone = require("./phone");
const Stages = require("./leadStages");
const Q = require("./searchQuery");
const { propertyType, money } = require("./sheetImport");
const { normalizeSearch } = require("./searchText");

// Checked in order: the first match wins ("second phone" before "phone", "property type" before "type").
const COLUMNS = [
  ["phone2", /^(phone 2|second phone|other phone|mobile 2|phone2|رقم تاني|رقم تان|رقم اخر|تليفون 2|موبايل 2|رقم 2|الرقم التاني)$/],
  ["phone", /^(phone|mobile|phone number|mobile number|whatsapp|tel|telephone|رقم|الرقم|رقم التليفون|التليفون|تليفون|الموبايل|موبايل|رقم الموبايل|واتساب|رقم الواتساب)$/],
  ["name", /^(name|client|client name|customer|customer name|lead name|full name|الاسم|اسم|اسم العميل|العميل)$/],
  ["property_type", /^(property type|unit type|property|نوع العقار|نوع الوحده|العقار)$/],
  ["kind", /^(type|lead type|client type|kind|type of lead|category|النوع|نوع|نوع العميل|تصنيف العميل)$/],
  ["listing_type", /^(sale or rent|sale rent|purpose|for|buy or rent|بيع او ايجار|بيع ايجار|شراء او ايجار|الغرض)$/],
  // A Meta Leads Center export names the campaign ("campaign_name"); it is the closest thing to a source there.
  ["source", /^(source|lead source|channel|campaign|campaign name|المصدر|مصدر|مصدر العميل|جه منين|الحمله)$/],
  ["budget", /^(budget|price|max price|budget egp|الميزانيه|ميزانيه|السعر|الميزانيه بالجنيه)$/],
  ["location", /^(area|location|compound|project|area or compound|district|city|المنطقه|منطقه|المكان|الكمبوند|كمبوند|المشروع|المنطقه او الكمبوند)$/],
  ["bedrooms", /^(bedrooms|beds|rooms|غرف|الغرف|عدد الغرف|اوض|عدد الاوض)$/],
  ["notes", /^(notes|note|comments|remarks|ملاحظات|ملاحظه|تعليق)$/],
  ["stage", /^(stage|status|pipeline|المرحله|الحاله)$/],
  ["assigned", /^(assigned|assigned to|broker|agent|owner|sales|المسوول|البروكر|الوسيط|السمسار|متسلم ل|مسند الي)$/],
  ["lawful_basis", /^(lawful basis|basis|consent|legal basis|الاساس القانوني|الموافقه)$/]
];
const KEYS = COLUMNS.map(([k]) => k);

/** Header text → column key (or null). */
function columnFor(header) {
  const h = normalizeSearch(header);
  if (!h) return null;
  for (const [key, re] of COLUMNS) if (re.test(h)) return key;
  return null;
}

const EMPTY = new Set(["", "-", "—", "n/a", "na", "null", "none", "لا يوجد"]);
const isEmpty = (v) => v === null || v === undefined || EMPTY.has(String(v).trim().toLowerCase());
const text = (v, max) => (isEmpty(v) ? null : String(v).replace(/\s+/g, " ").trim().slice(0, max));

const KIND_WORDS = [
  ["landlord", /(landlord|مؤجر|موجر|مالك عايز يأجر|عايز يأجر شقته)/],
  ["seller", /(seller|vendor|بايع|بائع|عايز يبيع|مالك)/],
  ["tenant", /(tenant|renter|مستاجر|مستأجر|ايجار)/],
  ["buyer", /(buyer|purchaser|مشتري|شاري|شراء)/]
];
function leadKind(v) {
  const t = normalizeSearch(v);
  if (!t) return null;
  if (Stages.KINDS.includes(t)) return t;
  return KIND_WORDS.find(([, re]) => re.test(t))?.[0] || null;
}

const STAGE_WORDS = [
  ["contacted", /(contacted|اتكلمنا|تم التواصل|اتصلنا)/],
  ["interested", /(interested|مهتم)/],
  ["viewing", /(viewing|معاينه)/],
  ["negotiation", /(negotiation|negotiating|تفاوض)/],
  ["won", /(won|closed won|deal|اتقفلت|تم البيع|صفقه)/],
  ["lost", /(lost|closed lost|ضاعت|مش مهتم|ملغي)/],
  ["new", /(new|جديد)/]
];
function stage(v) {
  const t = normalizeSearch(v);
  if (!t) return null;
  if (Stages.STAGES.includes(t)) return t;
  return STAGE_WORDS.find(([, re]) => re.test(t))?.[0] || null;
}

const BASIS_WORDS = [
  ["consent", /(consent|موافقه|وافق)/],
  ["existing_client", /(existing|عميل حالي|عميل قديم)/],
  ["client_request", /(request|asked|inquiry|طلب|استفسار)/]
];
function lawfulBasis(v) {
  const t = normalizeSearch(v).replace(/ /g, "_");
  if (!t) return null;
  if (Stages.LAWFUL_BASES.includes(t)) return t;
  return BASIS_WORDS.find(([, re]) => re.test(normalizeSearch(v)))?.[0] || null;
}

const listingType = (v) => {
  const t = normalizeSearch(v);
  return /(rent|ايجار)/.test(t) ? "rent" : /(sale|buy|بيع|شراء|تمليك)/.test(t) ? "sale" : null;
};

/** "7-9 مليون", "من 7 لـ 9 مليون", "9M", 9000000 → { min, max }; a single amount is the most the client pays. */
function budget(v) {
  if (isEmpty(v)) return null;
  if (typeof v === "number") return v > 0 ? { min: null, max: v } : null;
  const s = Phone.toAsciiDigits(v).replace(/^\s*(من|from)\s*/i, "");
  const parts = s.split(/\s*(?:-|–|to|الى|إلى|لـ|ل)\s*(?=\d)/i);
  if (parts.length === 2) {
    const unit = (parts[1].match(/[^\d.,\s].*$/) || [""])[0];
    const lo = money(/[^\d.,\s]/.test(parts[0]) ? parts[0] : `${parts[0]} ${unit}`.trim());
    const hi = money(parts[1]);
    if (lo && hi) return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
  }
  const n = money(s);
  return n ? { min: null, max: n } : null;
}

/** A cell may hold several numbers ("0101… / 0122…"); each one is read on its own. */
function phonesIn(v) {
  if (isEmpty(v)) return { phones: [], bad: [] };
  const parts = typeof v === "number" ? [String(v)] : String(v).split(/\s*[,،;/|\n]\s*|\s+(?:or|او|أو)\s+/i).filter((p) => p.trim());
  const phones = [];
  const bad = [];
  for (const p of parts) {
    // Meta's Leads Center export writes numbers as "p:+2010…".
    const e164 = Phone.toE164(String(p).replace(/^\s*p:/i, ""));
    if (e164) {
      if (!phones.includes(e164)) phones.push(e164);
    } else bad.push(String(p).trim().slice(0, 30));
  }
  return { phones, bad };
}

/**
 * One row → { phones, name, kind, source, notes, stage, lawfulBasis, assigned, request, errors, warnings }.
 * errors stop the row (no valid phone); warnings are shown but the row is imported (an unread cell is left empty).
 * @param {Object} cells - column key → raw cell value
 */
function rowToLead(cells = {}) {
  const errors = [];
  const warnings = [];
  const a = phonesIn(cells.phone);
  const b = phonesIn(cells.phone2);
  const phones = [...new Set([...a.phones, ...b.phones])];
  if (!phones.length) errors.push(isEmpty(cells.phone) && isEmpty(cells.phone2) ? "phone_required" : "phone_invalid");
  else if ([...a.bad, ...b.bad].length) warnings.push("phone_skipped");
  if (phones.length > 3) warnings.push("too_many_phones");

  let kind = null;
  let typeFromKind = null;
  if (!isEmpty(cells.kind)) {
    kind = leadKind(cells.kind);
    // A plain "Type" column holding "شقة" is the property type, not the kind of lead.
    if (!kind) typeFromKind = propertyType(cells.kind);
    if (!kind && !typeFromKind) warnings.push("kind");
  }
  const st = isEmpty(cells.stage) ? null : stage(cells.stage);
  if (!isEmpty(cells.stage) && !st) warnings.push("stage");
  const basis = isEmpty(cells.lawful_basis) ? null : lawfulBasis(cells.lawful_basis);
  if (!isEmpty(cells.lawful_basis) && !basis) warnings.push("lawful_basis");

  const ptype = isEmpty(cells.property_type) ? typeFromKind : propertyType(cells.property_type) || typeFromKind;
  if (!isEmpty(cells.property_type) && !ptype) warnings.push("property_type");
  const lt = isEmpty(cells.listing_type) ? null : listingType(cells.listing_type);
  const bud = budget(cells.budget);
  if (!isEmpty(cells.budget) && !bud) warnings.push("budget");
  const beds = isEmpty(cells.bedrooms) ? null : Number(Phone.toAsciiDigits(cells.bedrooms).replace(/[^\d]/g, "")) || null;
  const loc = text(cells.location, 120);

  let request = null;
  if (ptype || lt || bud || beds || loc) {
    const parsed = Q.normalizeAiSearch({
      filters: {
        listing_type: lt || (kind === "tenant" ? "rent" : kind === "buyer" ? "sale" : null),
        property_types: ptype ? [ptype] : [],
        locations: loc ? [loc] : [],
        price_min: bud?.min ?? null,
        price_max: bud?.max ?? null,
        bedrooms_min: beds
      }
    });
    if (Q.hasAnyFilter(parsed)) request = parsed.filters;
  }
  if (!kind && lt === "rent") kind = "tenant";

  return {
    phones: phones.slice(0, 3),
    name: text(cells.name, 120),
    kind,
    source: text(cells.source, 60),
    notes: text(cells.notes, 4000),
    stage: st,
    lawfulBasis: basis,
    assigned: text(cells.assigned, 120),
    request,
    errors,
    warnings
  };
}

/** The broker a cell names (by name, first name or phone), among the agency's active brokers. */
function matchBroker(value, brokers) {
  const t = normalizeSearch(value);
  if (!t) return null;
  const e164 = Phone.toE164(value);
  if (e164) return brokers.find((b) => Phone.toE164(b.phone_normalized || b.phone_number) === e164) || null;
  const exact = brokers.filter((b) => normalizeSearch(b.name) === t);
  if (exact.length === 1) return exact[0];
  const first = brokers.filter((b) => normalizeSearch(b.name).split(" ")[0] === t);
  return first.length === 1 ? first[0] : null;
}

const WARNING_LABELS = {
  phone_skipped: ["رقم مش مظبوط اتساب", "An invalid number was skipped"],
  too_many_phones: ["أكتر من 3 أرقام، اتاخد أول 3", "More than 3 numbers; the first 3 are kept"],
  kind: ["نوع العميل مش مفهوم (اتسجل مشتري)", "Unknown lead type (saved as buyer)"],
  stage: ["المرحلة مش مفهومة (اتسجل جديد)", "Unknown stage (saved as new)"],
  lawful_basis: ["الأساس القانوني مش مفهوم (اتاخد اللي اخترته)", "Unknown lawful basis (the one you picked is used)"],
  property_type: ["نوع العقار مش مفهوم", "Unknown property type"],
  budget: ["الميزانية مش مفهومة", "Budget not understood"],
  assigned: ["الوسيط مش معروف", "Unknown broker"],
  assigned_away: ["الوسيط في إجازة؛ مش هيتسلمله", "The broker is away; not given to them"]
};
const ERROR_LABELS = {
  phone_required: ["مفيش رقم", "No phone number"],
  phone_invalid: ["الرقم مش مظبوط", "Invalid phone number"]
};
const label = (labels, key, lang) => (labels[key] ? labels[key][lang === "en" ? 1 : 0] : key);
const warningLabel = (key, lang) => label(WARNING_LABELS, key, lang);
const errorLabel = (key, lang) => label(ERROR_LABELS, key, lang);

module.exports = { COLUMNS, KEYS, columnFor, leadKind, stage, lawfulBasis, budget, phonesIn, rowToLead, matchBroker, warningLabel, errorLabel };
