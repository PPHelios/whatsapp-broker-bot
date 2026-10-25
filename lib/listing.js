// lib/listing.js — Pure Helpers for Listing Extraction, Vision Curation, Validation & Merging
"use strict";

const crypto = require("crypto");
const Features = require("../domain/features");
const Delivery = require("../domain/delivery");
const { PROPERTY_TYPES, unitKind } = require("../domain/fieldRules");

const ROLES = [
  "view",
  "garden",
  "exterior",
  "facade",
  "reception",
  "living",
  "bedroom",
  "kitchen",
  "bathroom",
  "document",
  "other"
];

const ALL_TYPES = PROPERTY_TYPES;

/* --------------------------------------------------------------------------- */
/* 1. Typology Identification Helpers                                         */
/* --------------------------------------------------------------------------- */

function isVillaTypology(propertyType) {
  const norm = String(propertyType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return [
    "villa",
    "townhouse",
    "twinhouse",
    "standalone",
    "mansion",
    "land"
  ].includes(norm);
}

function isStudioTypology(propertyType, bedrooms) {
  const norm = String(propertyType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return (
    norm === "studio" ||
    (Number(bedrooms) === 0 && !isVillaTypology(propertyType))
  );
}

/* --------------------------------------------------------------------------- */
/* 2. Text Signals & Regex Parsing                                             */
/* --------------------------------------------------------------------------- */

function normalizeArabicDigits(str) {
  return String(str || "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0]);
}

function parseExplicitUnitCode(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { hasCode: false, code: null };
  }

  const clean = normalizeArabicDigits(
    text.replace(/[\u200E\u200F\u202A-\u202E]/g, "")
  ).trim();

  // Pattern 1: Explicit keyword prefix: (كود|code|unit|ref) optionally followed by wrappers
  const prefixRegex =
    /(?:كود(?:\s*(?:الوحدة|الداخلي))?|code|unit(?:\s*[\/\-]\s*(?:ref|code))?|ref)\s*[:\/\-\s#]*([A-Za-z0-9_\-\.\/]{2,30})/i;
  let match = clean.match(prefixRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "").trim();
    if (
      candidate.length >= 2 &&
      !/^(?:REF|UNIT|CODE|كود)$/i.test(candidate) &&
      !/[\u0600-\u06FF]/.test(candidate)
    ) {
      return { hasCode: true, code: candidate.toUpperCase() };
    }
  }

  // Pattern 2: Explicit Markdown/Wrapper tokens: `CODE`, [CODE], #CODE
  const wrapperRegex = /[`\[#]([A-Za-z0-9_\-\.\/]{2,30})[`\]]?/;
  match = clean.match(wrapperRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "").trim();
    if (
      candidate.length >= 2 &&
      /[A-Za-z0-9]/.test(candidate) &&
      !/[\u0600-\u06FF]/.test(candidate)
    ) {
      return { hasCode: true, code: candidate.toUpperCase() };
    }
  }

  // Pattern 3: Standalone alphanumeric identifier with both letters and numbers
  const standaloneRegex =
    /\b([A-Za-z]+[0-9_\-\.\/][A-Za-z0-9_\-\.\/]*|[0-9]+[A-Za-z_\-\.\/][A-Za-z0-9_\-\.\/]*)\b/;
  match = clean.match(standaloneRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "").trim();
    if (candidate.length >= 2 && !/[\u0600-\u06FF]/.test(candidate)) {
      return { hasCode: true, code: candidate.toUpperCase() };
    }
  }

  return { hasCode: false, code: null };
}

function extractExplicitUnitCode(text) {
  const res = parseExplicitUnitCode(text);
  return res.hasCode && res.code ? res.code : null;
}

function isLikelyListingMetadata(text) {
  if (!text) return false;
  if (
    /(?:^|\s)(عايز|عاوز|محتاج|ابحث|دورلي|عندك|عندنا|search|find|looking for)(?=$|\s)/i.test(
      text
    )
  ) {
    return false;
  }
  return /(?:^|\s)(كود|code|للبيع|مطلوب|مساحة|دور|تشطيب|كمبوند|شقة|فيلا|غرف|حمام|حمامات|مقدم|تقسيط|ref|ناني|روف|ارضي|أرضي|متكرر|بنتهاوس|استلام|فوري|بحري|over|اوفر|تنازل|وديعة)(?=$|\s)/i.test(
    text
  );
}

function detectLang(text, fallback = "ar") {
  if (/(?:^|\s)(en|english|انجليزي|إنجليزي)(?=$|\s)/i.test(text)) return "en";
  if (/(?:^|\s)(ar|arabic|عربي)(?=$|\s)/i.test(text)) return "ar";
  return fallback;
}

const isReplaceMode = (text) => /(?:^|\s)(استبدال|replace)(?=$|\s)/i.test(text);

/* --------------------------------------------------------------------------- */
/* 3. Code Generator                                                          */
/* --------------------------------------------------------------------------- */

function generateListingCode(customCode, propertyType) {
  if (customCode && typeof customCode === "string") {
    const cleaned = normalizeArabicDigits(customCode)
      .trim()
      .replace(/^(?:كود|code|ref|#)\s*/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .toUpperCase();
    if (cleaned.length >= 2) return { code: cleaned, explicit: true };
  }
  const prefix =
    {
      apartment: "APT",
      villa: "VIL",
      townhouse: "TWN",
      twinhouse: "TWN",
      duplex: "DUP",
      penthouse: "PNT",
      chalet: "CHL",
      studio: "STU",
      office: "OFF",
      commercial: "COM",
      land: "LND"
    }[String(propertyType || "").toLowerCase()] || "UNT";
  return {
    code: `RK-${prefix}-${crypto.randomInt(10000, 100000)}`,
    explicit: false
  };
}

/* --------------------------------------------------------------------------- */
/* 4. Gemini Multimodal Ingestion Prompt                                      */
/* --------------------------------------------------------------------------- */

function buildListingPrompt(
  targetLang = "ar",
  fenceToken = "USER_INPUT_BOUNDARY"
) {
  const featureList = Features.FEATURES.map((f) => `${f.key} (${f.ar} / ${f.en})`).join(", ");
  return `You are an expert real estate data parser for the Egyptian property market (East/West Cairo, New Cairo, Zayed, North Coast).
Extract ONE unit from the broker's notes and voice recordings (text between ===${fenceToken}=== fences, plus any audio) into strictly valid JSON.
The broker may correct themselves ("لا لا معلش خليها ...") — always keep the LAST stated value.

ABSOLUTE RULES:
1. NEVER INVENT. A field that was not stated is null (or [] for lists). No default finishing, delivery, maintenance %, frequency or bathrooms.
2. Numbers are plain numbers in EGP unless another currency is stated ("8 مليون ونص" = 8500000, "4300 ألف" = 4300000, "مليون وربع" = 1250000).
3. code: only if the broker explicitly states a unit code ("كود N4-105"); else null.
4. Studios: property_type "studio", bedrooms 0. Offices, shops and clinics: bedrooms null.
5. Villas, townhouses and twin houses: area_value is the built-up area (BUA); land_area is the plot; floor is null.
6. Terminology: "غرفة مربية" / "Nanny room" (never "خادمة" / "Maid's room").

FIELDS:
- listing_type: "sale" | "rent". market: "primary" for a new unit sold by/with the developer's payment plan, "resale" otherwise.
- property_type: one of ${PROPERTY_TYPES.join(" | ")}.
- compound (Arabic as said) and compound_en (standard Latin name, e.g. "Hyde Park", "Mivida", "Madinaty", "Al Rehab"); district, city, location (Arabic).
- area_value, land_area, garden_area, roof_area in m². bedrooms, bathrooms as integers.
- floor (Arabic as said, e.g. "الرابع", "أرضي"), floor_en, floor_level (integer: 0 ground, -1 basement, 4 for fourth floor; null for roof/unknown).
- finishing: "core_and_shell" | "semi_finished" | "fully_finished" | "super_lux" | "ultra_super_lux" | null.
- furnishing: "furnished" | "semi_furnished" | "unfurnished" | null (only if stated).
- price_value: total asking price (monthly rent for rentals). currency: "EGP" | "USD" | "EUR". rent_period: "monthly" | "yearly" | null.
- delivery: { "ready": true only if immediate/ready/فوري/استلام فوري, "year": 2027, "quarter": 1-4, "month": 1-12, "raw": "the words used" } — all null if not stated.
- features: array of keys from this fixed list ONLY when stated: ${featureList}.
  Orientation بحري/قبلي/شرقي/غربي, ناصية (corner), views (فيو جاردن ...), rooms (غرفة مربية, غرفة سائق, ماستر, دريسنج), roof, garden, furnished, appliances, ACs, elevator, parking, club membership...
- features_other: other stated extras that are not in the list, short Arabic phrases (e.g. "جاكوزي").
- resale (resale units with a remaining developer schedule): {
    "cash_paid": cash the buyer pays the owner (paid amount incl. any over price),
    "remaining_amount": remaining balance to the developer, only if stated (never total minus cash_paid),
    "installment_amount": one installment's amount,
    "installment_frequency": "monthly" | "quarterly" | "semi_annual" | "annual",
    "installment_years": years left,
    "installments_end": "YYYY-MM" of the last installment if stated,
    "over_price", "club_fee", "transfer_fee", "maintenance_fee": numbers or null,
    "maintenance_paid": true | false | null }
- primary (developer / primary units): {
    "project", "developer",
    "cash_price": cash price if stated,
    "plans": [ { "down_payment_pct": 10, "years": 8, "frequency": "quarterly" | "monthly" | "semi_annual" | "annual" | null, "delivery_pct": null } ],
    "maintenance_pct": number or null, "maintenance_terms": text or null }
- title (Arabic marketing headline without the code), title_en.
- clean_summary (Arabic, 1-3 sentences, only stated facts), summary_en (English, 1-2 sentences, only stated facts).

Return exactly this JSON shape:
{
  "code": null, "listing_type": null, "market": null, "property_type": null,
  "compound": null, "compound_en": null, "district": null, "city": null, "location": null, "location_keywords": [],
  "area_value": null, "land_area": null, "garden_area": null, "roof_area": null,
  "bedrooms": null, "bathrooms": null, "floor": null, "floor_en": null, "floor_level": null,
  "finishing": null, "furnishing": null,
  "price_value": null, "currency": "EGP", "rent_period": null,
  "delivery": { "ready": null, "year": null, "quarter": null, "month": null, "raw": null },
  "features": [], "features_other": [],
  "resale": { "cash_paid": null, "remaining_amount": null, "installment_amount": null, "installment_frequency": null, "installment_years": null, "installments_end": null, "over_price": null, "club_fee": null, "transfer_fee": null, "maintenance_fee": null, "maintenance_paid": null },
  "primary": { "project": null, "developer": null, "cash_price": null, "plans": [], "maintenance_pct": null, "maintenance_terms": null },
  "title": null, "title_en": null, "clean_summary": null, "summary_en": null
}
Output language for free text: ${targetLang === "en" ? "English for title_en/summary_en, Arabic for the Arabic fields" : "Arabic for Arabic fields, English for *_en fields"}.`;
}

/* --------------------------------------------------------------------------- */
/* 4b. Extraction normalizer (AI JSON → listing fields) and AI call             */
/* --------------------------------------------------------------------------- */

const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"];
const FINISHING_KEYS = ["core_and_shell", "semi_finished", "fully_finished", "super_lux", "ultra_super_lux"];
const FURNISHING_KEYS = ["furnished", "semi_furnished", "unfurnished"];

const numOrNull = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(normalizeArabicDigits(String(v)).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const posOrNull = (v) => {
  const n = numOrNull(v);
  return n !== null && n > 0 ? n : null;
};
const intOrNull = (v) => {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
};
const strOrNull = (v, max = 200) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s && s.toLowerCase() !== "null" ? s.slice(0, max) : null;
};
const oneOf = (v, list) => {
  const s = String(v ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const alias = { semiannual: "semi_annual", semi_annually: "semi_annual", yearly: "annual", core_shell: "core_and_shell" };
  const k = alias[s] || s;
  return list.includes(k) ? k : null;
};

function normalizePropertyType(t) {
  const k = String(t || "").toLowerCase().replace(/[\s_-]/g, "");
  const alias = { twinvilla: "twinhouse", standalone: "villa", standalonevilla: "villa", retail: "shop", store: "shop", administrative: "office" };
  const v = alias[k] || k;
  return PROPERTY_TYPES.includes(v) ? v : null;
}

/** "YYYY-MM" (or a Date-like string) → "YYYY-MM-01"; null when not a real date. */
function monthDate(v) {
  const m = String(normalizeArabicDigits(v || "")).match(/(20\d{2})[-/.](\d{1,2})/);
  if (!m) return null;
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, "0")}-01` : null;
}

/** End of a remaining schedule from years left, as of `now` (the broker said "باقي 6 سنين"). */
function endFromYears(years, now = new Date()) {
  if (!(years > 0)) return null;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() + Math.round(years * 12));
  return d.toISOString().slice(0, 10);
}

/**
 * Maps the AI's JSON into listing fields: top-level columns plus details and payment_terms.
 * Pure; never fills a field the AI left empty.
 */
function normalizeExtraction(raw, { now = new Date() } = {}) {
  const r = (Array.isArray(raw) ? raw[0] : raw) || {};
  const resale = r.resale || {};
  const primary = r.primary || {};
  const delivery = Delivery.parseDelivery(r.delivery && typeof r.delivery === "object" ? r.delivery : r.delivery_date ?? null, {
    ready: r.ready_to_move === true ? true : null
  });
  const { keys, other } = Features.classifyFeatures([...(r.features || []), ...(r.features_other || [])]);
  const property_type = normalizePropertyType(r.property_type);
  const listing_type = ["sale", "rent"].includes(r.listing_type) ? r.listing_type : null;

  const plans = (Array.isArray(primary.plans) ? primary.plans : [])
    .map((p, i) => ({
      plan_id: `p${i + 1}`,
      down_payment_pct: numOrNull(p?.down_payment_pct),
      years: numOrNull(p?.years),
      frequency: oneOf(p?.frequency, FREQUENCIES),
      delivery_pct: numOrNull(p?.delivery_pct)
    }))
    .filter((p) => p.down_payment_pct !== null || p.years !== null);

  const installmentYears = numOrNull(resale.installment_years);
  // Unstated market stays null (an edit must not turn a primary unit into a resale one).
  const market =
    r.market === "primary" || (r.market !== "resale" && (plans.length || posOrNull(primary.cash_price)))
      ? "primary"
      : r.market === "resale" || posOrNull(resale.cash_paid) || posOrNull(resale.remaining_amount)
      ? "resale"
      : null;

  const out = {
    code: strOrNull(r.code, 30),
    listing_type,
    market,
    property_type,
    title: strOrNull(r.title),
    compound: strOrNull(r.compound, 120),
    compound_en: strOrNull(r.compound_en, 120),
    district: strOrNull(r.district, 120),
    city: strOrNull(r.city, 120),
    location: strOrNull(r.location, 200),
    location_keywords: Array.isArray(r.location_keywords) ? r.location_keywords.map((k) => strOrNull(k, 60)).filter(Boolean).slice(0, 16) : [],
    price_value: posOrNull(r.price_value),
    currency: ["EGP", "USD", "EUR"].includes(r.currency) ? r.currency : null,
    area_value: posOrNull(r.area_value),
    bedrooms: intOrNull(r.bedrooms),
    bathrooms: intOrNull(r.bathrooms),
    floor_level: intOrNull(r.floor_level),
    finishing: oneOf(r.finishing, FINISHING_KEYS),
    furnishing: oneOf(r.furnishing, FURNISHING_KEYS),
    ...delivery,
    feature_keys: keys,
    features_other: other,
    down_payment_value: market !== "primary" ? posOrNull(resale.cash_paid) : null,
    remaining_amount: posOrNull(resale.remaining_amount),
    installment_value: posOrNull(resale.installment_amount),
    payment_frequency: oneOf(resale.installment_frequency, FREQUENCIES),
    installment_years: installmentYears !== null ? Math.round(installmentYears) : null,
    installments_end: monthDate(resale.installments_end) || endFromYears(installmentYears, now),
    maintenance_pct: numOrNull(primary.maintenance_pct),
    payment_terms: market === "primary" ? {
      plans,
      cash_price: posOrNull(primary.cash_price),
      maintenance_terms: strOrNull(primary.maintenance_terms)
    } : {},
    details: {
      // Only a stated non-default currency is stored; EGP is implied everywhere.
      currency: ["USD", "EUR"].includes(r.currency) ? r.currency : null,
      land_area: posOrNull(r.land_area),
      garden_area: posOrNull(r.garden_area),
      roof_area: posOrNull(r.roof_area),
      floor: strOrNull(r.floor, 40),
      floor_en: strOrNull(r.floor_en, 40),
      rent_period: oneOf(r.rent_period, ["monthly", "yearly"]),
      over_price: posOrNull(resale.over_price),
      club_fee: posOrNull(resale.club_fee),
      transfer_fee: posOrNull(resale.transfer_fee),
      maintenance_fee: posOrNull(resale.maintenance_fee),
      maintenance_paid: typeof resale.maintenance_paid === "boolean" ? resale.maintenance_paid : null,
      project: strOrNull(primary.project, 120),
      developer: strOrNull(primary.developer, 120),
      title_en: strOrNull(r.title_en),
      compound_en: strOrNull(r.compound_en, 120),
      clean_summary: strOrNull(r.clean_summary, 600),
      summary_en: strOrNull(r.summary_en, 600)
    }
  };

  // Villas: area is BUA, never a floor.
  if (unitKind(property_type) === "villa") {
    out.floor_level = null;
    out.details.floor = null;
    out.details.floor_en = null;
    out.details.bua = out.area_value;
  }
  // Drop empty detail keys so stored JSON holds only captured facts.
  for (const k of Object.keys(out.details)) if (out.details[k] === null) delete out.details[k];
  return out;
}

/** Unit code stated in the broker's own text ("كود N4-105", "#VIL-08", "`HP-201`"). */
function findStatedCode(texts = []) {
  for (const t of texts) {
    const clean = normalizeArabicDigits(String(t || "").replace(/[\u200E\u200F\u202A-\u202E]/g, ""));
    const m =
      clean.match(/(?:كود(?:\s*(?:الوحدة|الداخلي))?|code)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9_\-\/.]{1,29})/i) ||
      clean.match(/[#`]([A-Za-z0-9][A-Za-z0-9_\-\/.]{1,29})`?/);
    if (m && /[A-Za-z0-9]/.test(m[1])) return m[1].replace(/[.\/]+$/, "").toUpperCase();
  }
  return null;
}

/**
 * Runs listing extraction through the shared AI gateway (hedged tiers, telemetry, quota).
 * @param {Object} aiShim - lib/ai.js (or a stand-in exposing generateWithCascade)
 * @param {Object} input - { texts, voice: [{ base64 | buffer, mimeType }], lang, ctx }
 * @returns {Promise<{ fields, raw, modelUsed, usage }>}
 */
async function extractPropertyDetails(aiShim, { texts = [], voice = [], lang = "ar", ctx = {} } = {}) {
  const fence = crypto.randomBytes(4).toString("hex").toUpperCase();
  const rawText = texts.filter(Boolean).join("\n").trim();
  const parts = [{ text: buildListingPrompt(lang, fence) }];
  if (rawText) parts.push({ text: `===${fence}===\n${rawText}\n===${fence}===` });
  for (const v of voice) {
    const data = v.base64 || (Buffer.isBuffer(v.buffer) ? v.buffer.toString("base64") : null);
    if (data) parts.push({ inlineData: { mimeType: v.mimeType || "audio/ogg", data } });
  }

  const res = await aiShim.generateWithCascade({
    contents: [{ role: "user", parts }],
    config: { temperature: 0.1, responseMimeType: "application/json" },
    operationType: "listing_extraction",
    ctx
  });
  const parsed = JSON.parse(String(res.text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
  const fields = normalizeExtraction(parsed);
  const stated = findStatedCode(texts);
  if (stated) fields.code = stated;
  return { fields, raw: parsed, modelUsed: res.modelUsed, usage: res.usage };
}

/* --------------------------------------------------------------------------- */
/* 5. Gemini On-Demand Vision Curation Prompt (Runs on First Flyer Request)    */
/* --------------------------------------------------------------------------- */

function buildVisionPrompt() {
  return `You are an elite architectural creative director and luxury real estate marketer.
Analyze these property photos to curate and rank the best images for an editorial property brochure.
Return ONE JSON object strictly adhering to:
{
  "hero_index": number,
  "image_roles": string[],
  "image_order": number[]
}

Rules & Constraints:
1. "image_roles": Array matching input indices with values strictly from:
   ["view", "garden", "exterior", "facade", "reception", "living", "bedroom", "kitchen", "bathroom", "document", "other"].

2. HERO IMAGE RULES (Slot 0):
   - The primary hero image ("hero_index") MUST be the exterior building or standalone villa facade with architectural presence, clear skies, and landscaping whenever available.
   - For apartments in generic blocks where no distinctive facade exists, select the widest, brightest grand living/reception salon or panoramic open view.
   - Bathrooms, kitchens, corridors, stairwells, floor plans, payment schedules, and close-up detail shots MUST NEVER be selected as the hero image under any circumstances.

3. SPATIAL STORYTELLING & DIVERSITY:
   - "image_order" must contain up to 9 distinct image indices ranked by commercial storytelling impact:
     1. Slot 0: Hero Facade / Exterior Architecture (or Grand Reception)
     2. Slot 1: Secondary Living / Dining Salon
     3. Slot 2: Outdoor Amenity / Landscaped Garden / Private Pool / Panoramic Terrace
     4. Slot 3: Master Bedroom Suite
     5. Slot 4: Master En-Suite Bathroom or Luxury Dressing Room
     6. Slot 5: Modern Finished Kitchen
     7. Slot 6: Secondary Bedroom / Children's Room
     8. Slot 7: Architectural Highlight (Double-height ceiling, marble staircase, terrace view)
     9. Slot 8: Compound Amenities / Community Vista / Building Entrance
   - Enforce variety: maximum 2 living/reception, maximum 2 bedrooms, maximum 1 kitchen, maximum 1 bathroom.
   - Avoid selecting repetitive angles of the exact same room or furniture piece.

4. AUTOMATIC REJECTION:
   - Mark payment schedules, floor plans, text documents, screenshots, WhatsApp notes, blurry photos, and dark/distorted shots as "document" or "other".
   - Strictly exclude them from "image_order".`;
}

/* --------------------------------------------------------------------------- */
/* 6. Context-Aware Completeness & Validation Gatekeeper                      */
/* --------------------------------------------------------------------------- */

function checkDraftCompleteness(draft, parsedContext = {}) {
  const ctx = parsedContext || {};
  const lang = ctx.lang || "ar";
  const blockers = [];
  const warnings = [];

  const rawPropType = String(draft.property_type || "")
    .toLowerCase()
    .trim();
  const isLanded = isVillaTypology(rawPropType);
  const isStudio = isStudioTypology(rawPropType, draft.bedrooms);

  // Blocker rules
  if (!draft.price_value || Number(draft.price_value) <= 0) {
    blockers.push({
      field: "price_value",
      message:
        lang === "en" ? "Asking price is required" : "السعر الإجمالي مطلوب"
    });
  }
  if (!draft.compound || !String(draft.compound).trim()) {
    blockers.push({
      field: "compound",
      message:
        lang === "en"
          ? "Compound / Project name is required"
          : "اسم الكمبوند أو المشروع مطلوب"
    });
  }
  if (!draft.area_value || Number(draft.area_value) <= 0) {
    blockers.push({
      field: "area_value",
      message:
        lang === "en"
          ? "Unit area in sqm is required"
          : "المساحة بالمتر المربع مطلوبة"
    });
  }

  // Bedroom rule: Studios are open-concept (0 bedrooms is completely valid)
  if (!isStudio) {
    const beds =
      draft.bedrooms !== undefined && draft.bedrooms !== null
        ? Number(draft.bedrooms)
        : null;

    if (beds === null || isNaN(beds) || beds < 0) {
      blockers.push({
        field: "bedrooms",
        message:
          lang === "en" ? "Bedrooms count is required" : "عدد الغرف مطلوب"
      });
    } else if (beds === 0 && !isLanded) {
      // 0 bedrooms on residential unit: automatically adapt to studio
      draft.property_type = "studio";
    }
  }

  // Floor warning: Strictly exclude landed properties (villas, townhouses, twinhouses)
  const floorVal = draft.details?.floor ?? draft.floor;
  if (
    !isLanded &&
    (floorVal === null ||
      floorVal === undefined ||
      String(floorVal).trim() === "")
  ) {
    warnings.push({
      field: "floor",
      label_ar: "الدور",
      label_en: "Floor",
      note_ar: "رقم الدور غير محدد",
      note_en: "Floor level is missing",
      message: lang === "en" ? "Floor level is missing" : "رقم الدور غير محدد"
    });
  }

  // Resale financial balance check:
  // Enforce: Total Asking Price = Upfront Cash to Owner + Remaining Developer Debt
  let deltaWarning = null;
  const price = Number(draft.price_value) || Number(ctx.priceValue) || 0;
  const details = draft.details || {};
  const dp = Number(
    details.down_payment_value ?? draft.down_payment_value ?? 0
  );
  const over = Number(details.over_price ?? 0);
  const club = Number(details.club_fee ?? 0);
  const transfer = Number(details.transfer_fee ?? 0);
  const rem = Number(details.remaining_balance ?? draft.remaining_balance ?? 0);

  const upfrontCash =
    Number(details.total_upfront_cash) || dp + over + club + transfer;

  if (price > 0 && upfrontCash > 0 && rem > 0) {
    const sum = upfrontCash + rem;
    const diff = Math.abs(price - sum);
    if (diff > 100) {
      deltaWarning = {
        diff,
        price,
        upfront: upfrontCash,
        remaining: rem,
        message_en: `Financial Reconciliation Alert: Total Price (${price.toLocaleString()} EGP) ≠ Upfront Cash (${upfrontCash.toLocaleString()} EGP) + Remaining Debt (${rem.toLocaleString()} EGP). Discrepancy: ${diff.toLocaleString()} EGP.`,
        message_ar: `تنبيه المطابقة المالية: إجمالي السعر (${price.toLocaleString()} ج.م) لا يتطابق مع مجموع الكاش المطلوب (${upfrontCash.toLocaleString()} ج.م) + المتبقي أقساط (${rem.toLocaleString()} ج.م). الفارق: ${diff.toLocaleString()} ج.م.`
      };
    }
  } else if (price > 0 && dp > 0 && rem > 0 && !details.total_upfront_cash) {
    const sum = dp + rem;
    const diff = Math.abs(price - sum);
    if (diff > 100) {
      deltaWarning = {
        diff,
        price,
        upfront: dp,
        remaining: rem,
        message_en: `Financial Reconciliation Alert: Total Price (${price.toLocaleString()} EGP) ≠ Paid Cash (${dp.toLocaleString()} EGP) + Remaining Debt (${rem.toLocaleString()} EGP). Discrepancy: ${diff.toLocaleString()} EGP.`,
        message_ar: `تنبيه المطابقة المالية: إجمالي السعر (${price.toLocaleString()} ج.م) لا يتطابق مع مجموع المدفوع كاش (${dp.toLocaleString()} ج.م) + المتبقي أقساط (${rem.toLocaleString()} ج.م). الفارق: ${diff.toLocaleString()} ج.م.`
      };
    }
  }

  return {
    isComplete: blockers.length === 0,
    blockers,
    warnings,
    deltaWarning
  };
}

/* --------------------------------------------------------------------------- */
/* 7. Validation & Normalization                                              */
/* --------------------------------------------------------------------------- */

/**
 * Synchronously normalizes input draft structure and completes structural validation.
 * Compatible with both:
 * 1. Synchronous calls in tests (const draft = L.validateDraft(input, "ar"))
 * 2. Async calls in command handlers (const res = await L.validateDraft(draft, lang, ctx))
 * Guaranteed to return an iterable `missingFields` array under all execution paths.
 */
function validateDraft(inputDraft, lang = "ar", ctx = null) {
  if (!inputDraft || typeof inputDraft !== "object") {
    const errorMsg =
      lang === "en"
        ? "Draft session is empty or uninitialized."
        : "مسودة الوحدة فارغة أو غير معرّفة.";
    return {
      valid: false,
      missingFields: [errorMsg],
      blockers: [{ field: "draft", message: errorMsg }],
      warnings: [],
      deltaWarning: null,
      extracted: {},
      details: {
        finishing: null,
        finishing_en: null,
        floor: null,
        bathrooms: null,
        view: null,
        orientation_en: null,
        currency: "EGP"
      }
    };
  }

  const details = inputDraft.details || {};
  const isVilla = isVillaTypology(inputDraft.property_type);
  const isStudio = isStudioTypology(
    inputDraft.property_type,
    inputDraft.bedrooms
  );

  const resolvedBathrooms =
    inputDraft.bathrooms !== null && inputDraft.bathrooms !== undefined
      ? Number(inputDraft.bathrooms)
      : details.bathrooms !== null && details.bathrooms !== undefined
      ? Number(details.bathrooms)
      : null;

  const resolvedBedrooms = isStudio
    ? 0
    : inputDraft.bedrooms !== null && inputDraft.bedrooms !== undefined
    ? Number(inputDraft.bedrooms)
    : null;

  const normalizedBase = {
    ...inputDraft,
    property_type: isStudio
      ? inputDraft.property_type || "studio"
      : inputDraft.property_type || "apartment",
    bedrooms: resolvedBedrooms,
    bathrooms: resolvedBathrooms,
    details: {
      ...details,
      finishing: details.finishing ?? null,
      finishing_en: details.finishing_en ?? null,
      floor: isVilla ? null : details.floor ?? null,
      floor_en: isVilla ? null : details.floor_en ?? null,
      bathrooms: resolvedBathrooms,
      bua: isVilla
        ? details.bua || inputDraft.area_value || null
        : details.bua ?? null,
      land_area: isVilla ? details.land_area ?? null : null,
      view: details.view ?? null,
      orientation_en: details.orientation_en ?? null,
      currency: details.currency || "EGP"
    }
  };

  const completeness = checkDraftCompleteness(normalizedBase, {
    lang,
    priceValue: inputDraft.price_value
  });

  const missingList = Array.isArray(completeness.blockers)
    ? completeness.blockers.map((b) => b.message)
    : [];

  return {
    valid: completeness.isComplete,
    missingFields: missingList,
    blockers: completeness.blockers,
    warnings: completeness.warnings,
    deltaWarning: completeness.deltaWarning,
    extracted: normalizedBase,
    ...normalizedBase
  };
}

/* --------------------------------------------------------------------------- */
/* 8. Vision Draft Validation & Ranking Order Resolver                         */
/* --------------------------------------------------------------------------- */

function validateVisionDraft(raw, nImages = 0) {
  const d = (Array.isArray(raw) ? raw[0] : raw) || {};
  const str = (v) =>
    String(v ?? "")
      .trim()
      .toLowerCase();
  const rawRoles = Array.isArray(d.image_roles) ? d.image_roles : [];
  const image_roles = Array.from({ length: nImages }, (_, i) => {
    const r = str(rawRoles[i]);
    return ROLES.includes(r) ? r : "other";
  });

  const seen = new Set();
  const image_order = [];
  for (const x of Array.isArray(d.image_order) ? d.image_order : []) {
    const i = Number(x);
    if (Number.isInteger(i) && i >= 0 && i < nImages && !seen.has(i)) {
      seen.add(i);
      image_order.push(i);
    }
  }

  const heroIndex = Number(d.hero_index);
  if (Number.isInteger(heroIndex) && heroIndex >= 0 && heroIndex < nImages) {
    const existingPos = image_order.indexOf(heroIndex);
    if (existingPos !== -1) {
      image_order.splice(existingPos, 1);
    }
    image_order.unshift(heroIndex);
    seen.add(heroIndex);
  }

  for (let i = 0; i < nImages; i++) {
    if (!seen.has(i)) image_order.push(i);
  }

  return {
    hero_index: Number.isInteger(heroIndex) ? heroIndex : null,
    image_roles,
    image_order
  };
}

/* --------------------------------------------------------------------------- */
/* 9. Field Merging & Safe Update Composition                                 */
/* --------------------------------------------------------------------------- */

// Top-level listing columns composeFields owns (everything a draft or edit can set).
const LISTING_COLUMNS = [
  "title", "property_type", "listing_type", "market", "price_value", "area_value", "bedrooms", "bathrooms",
  "location", "compound", "compound_en", "district", "city", "floor_level", "finishing", "furnishing",
  "delivery_year", "delivery_quarter", "delivery_month", "is_ready", "delivery_raw",
  "down_payment_value", "remaining_amount", "installment_value", "payment_frequency", "installment_years",
  "installments_end", "maintenance_pct"
];

const filled = (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Composes the stored row from a normalized draft (normalizeExtraction output) and, for edits,
 * the existing row: a stated value wins, an unstated one keeps the existing value.
 * Sets the top-level columns (delivery, features, resale schedule, market...) as well as details.
 */
function composeFields({ existing = null, draft = {}, lang = "ar" } = {}) {
  const old = existing || {};
  const d = draft || {};
  const out = {};
  for (const col of LISTING_COLUMNS) {
    out[col] = filled(d[col]) ? d[col] : old[col] ?? null;
  }
  // Delivery is one unit: a newly stated delivery replaces the whole old one.
  if (filled(d.delivery_year) || d.is_ready === true || filled(d.delivery_raw)) {
    for (const k of ["delivery_year", "delivery_quarter", "delivery_month", "is_ready", "delivery_raw"]) out[k] = d[k] ?? null;
  }
  out.market = d.market || old.market || "resale";
  out.listing_type = out.listing_type || null;
  out.compound_en = out.compound_en || d.details?.compound_en || old.details?.compound_en || null;
  out.location_keywords = filled(d.location_keywords) ? d.location_keywords : old.location_keywords || [];
  out.feature_keys = Features.sortKeys([...(old.feature_keys || []), ...(d.feature_keys || [])]);
  out.features_other = [...new Set([...(old.features_other || []), ...(d.features_other || [])])];

  const terms = filled(d.payment_terms) && Object.keys(d.payment_terms).length ? d.payment_terms : old.payment_terms || {};
  out.payment_terms = terms;
  out.inventory_type = out.market === "primary" ? "primary_unit" : old.inventory_type && old.inventory_type !== "primary_unit" ? old.inventory_type : "resale_unit";

  const details = { ...(old.details || {}) };
  for (const [k, v] of Object.entries(d.details || {})) if (filled(v)) details[k] = v;
  if (!existing) details.lang = lang;
  if (unitKind(out.property_type) === "villa") {
    out.floor_level = null;
    delete details.floor;
    delete details.floor_en;
    details.bua = out.area_value ?? details.bua ?? null;
  }
  const kind = unitKind(out.property_type);
  if (kind === "studio") out.bedrooms = 0;
  if (kind === "commercial") out.bedrooms = null;
  out.details = details;
  return out;
}

module.exports = {
  ROLES,
  ALL_TYPES,
  normalizeArabicDigits,
  parseExplicitUnitCode,
  extractExplicitUnitCode,
  isLikelyListingMetadata,
  detectLang,
  isReplaceMode,
  generateListingCode,
  buildListingPrompt,
  normalizeExtraction,
  findStatedCode,
  extractPropertyDetails,
  buildVisionPrompt,
  validateDraft,
  checkDraftCompleteness,
  validateVisionDraft,
  composeFields,
  LISTING_COLUMNS,
  isVillaTypology,
  isStudioTypology
};
