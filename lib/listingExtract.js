// lib/listingExtract.js — The Gemini listing prompt, the extraction normalizer (AI JSON -> listing fields), the AI
// call and the vision curation prompt. Split out of lib/listing.js.
"use strict";

const crypto = require("crypto");
const Features = require("../domain/features");
const Delivery = require("../domain/delivery");
const { PROPERTY_TYPES, unitKind } = require("../domain/fieldRules");
const { normalizeArabicDigits } = require("./listingText");

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

module.exports = {
  buildListingPrompt,
  normalizeExtraction,
  findStatedCode,
  extractPropertyDetails,
  buildVisionPrompt
};
