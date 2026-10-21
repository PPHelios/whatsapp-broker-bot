// lib/listing.js — pure helpers (no I/O) for listing extraction, validation, and field merging
"use strict";
const crypto = require("crypto");
const S = require("./search");

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
const ALL_TYPES = [...S.PROPERTY_TYPES, "land"];

/* --------------------------------------------------------------------------- */
/* Text signals & regex parsing                                                */
/* --------------------------------------------------------------------------- */

function normalizeArabicDigits(str) {
  return String(str || "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"["۰۱۲۳۴۵۶۷۸۹".indexOf(d)]);
}

function parseExplicitUnitCode(rawText) {
  if (!rawText) return { hasCode: false, code: null, cleanText: rawText };
  const normalized = normalizeArabicDigits(rawText.trim());

  const codeRegex = /(?:^|\s)(?:code|كود|الكود)\s*:?\s*#?\s*([^\s]+)/i;
  const match = normalized.match(codeRegex);
  if (!match) {
    return { hasCode: false, code: null, cleanText: rawText };
  }

  const rawCandidate = match[1].replace(/^[#\-_]+|[#\-_]+$/g, "");

  if (/[\u0600-\u06FF]/.test(rawCandidate)) {
    return {
      hasCode: true,
      invalidArabic: true,
      code: null,
      cleanText: rawText.replace(match[0], "").trim()
    };
  }

  const validPattern = /^[A-Za-z0-9_-]{3,30}$/;
  if (!validPattern.test(rawCandidate)) {
    return {
      hasCode: true,
      invalidFormat: true,
      code: null,
      cleanText: rawText.replace(match[0], "").trim()
    };
  }

  const cleanCode = rawCandidate.toUpperCase();
  const cleanText = rawText.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return {
    hasCode: true,
    code: cleanCode,
    cleanText
  };
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
  )
    return false;
  return /(?:^|\s)(كود|code|للبيع|مطلوب|مساحة|دور|تشطيب|كمبوند|شقة|فيلا|غرف|حمام|حمامات|مقدم|تقسيط|ref|ناني|روف|ارضي|أرضي|متكرر|بنتهاوس)(?=$|\s)/i.test(
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
/* Code generator                                                             */
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
/* Gemini Ingestion Prompt (Text & Audio Only — No Images, No Spoken Codes)    */
/* --------------------------------------------------------------------------- */
function buildListingPrompt(targetLang, fenceToken = "USER_INPUT_BOUNDARY") {
  const other = targetLang === "en" ? "ar" : "en";
  return `You are an expert real estate data parser for the Egyptian property market.
Extract unit specifications from broker notes into clean, strictly valid JSON.
Primary output language: "${targetLang}". Translate (title, location, clean_summary, features) to "${other}" in details.i18n.${other}.

CRITICAL SYSTEM CONSTRAINTS:
1. NEVER EXTRACT UNIT CODES: Ignore any codes mentioned in text or audio (codes are handled externally).
2. TERMINOLOGY ENFORCEMENT:
   - Arabic: Always use "ناني" or "غرفة ناني". NEVER use "خادمة".
   - English: Always use "Nanny Room". NEVER use "Maid's Room".
3. ELEVATED SPECIFICATIONS:
   - Master bedroom: detect if any bedrooms are master bedrooms (has_master_bedroom: boolean, master_bedrooms: number or null).
   - Dressing room: detect if a dressing room / walk-in closet is present (has_dressing_room: boolean).
   - Floor: Arabic floor name and English (floor_en: e.g. "Ground Floor", "1st Floor", "Typical Floor", "Penthouse").
   - Bathrooms: numeric count.
   - Finishing: Arabic finishing and English (finishing_en: e.g. "Ultra Super Lux", "Fully Finished", "Semi-Finished", "Core & Shell").
4. FINANCIAL & CURRENCY MODEL:
   - Currency: Detect "EGP", "USD", or "EUR". Default is "EGP".
   - Rent: If listing_type is rent, detect rent_period ("monthly" or "yearly").
   - Installments: If installment plan is mentioned, extract down_payment_value, installment_years, installment_frequency ("quarterly" | "monthly" | "semi-annual" | "annual"), and installment_amount.
5. REQUIRED FLYER ENGLISH FIELDS:
   - title_en: Concise luxury marketing headline in English.
   - summary_en: 1-2 clean English sentences highlighting prime specs.
   - features_en: Array of English strings (e.g. ["Master Suite", "Dressing Room", "Nanny Room", "Garden View"]).

Return JSON strictly adhering to this schema:
{
  "title": "عنوان تسويقي رسمي جذاب مستوحى من الوصف (بدون ذكر كود)",
  "property_type": "${ALL_TYPES.join(" | ")}",
  "listing_type": "sale | rent",
  "price_value": "السعر كرقم مجرد أو نص كما ذُكر أو null",
  "price_display": "السعر المنسق مع العملة أو null",
  "area_value": "المساحة بالمتر المربع كرقم مجرد أو null",
  "bedrooms": "عدد غرف النوم كرقم مجرد أو null",
  "location": "",
  "compound": "",
  "district": "",
  "city": "",
  "location_keywords": ["الكمبوند، المنطقة، المدينة، وأي أسماء دارجة"],
  "details": {
    "currency": "EGP | USD | EUR",
    "floor": "الدور بالعربية أو null",
    "floor_en": "Floor in English (e.g. Ground Floor, 1st Floor)",
    "bathrooms": "عدد الحمامات كرقم أو null",
    "has_master_bedroom": false,
    "master_bedrooms": null,
    "has_dressing_room": false,
    "nanny_room": false,
    "rent_period": "monthly | yearly | null",
    "installment_years": null,
    "down_payment_value": null,
    "installment_frequency": null,
    "installment_amount": null,
    "finishing": "نوع التشطيب بالعربية أو null",
    "finishing_en": "Finishing in English (e.g. Fully Finished, Core & Shell)",
    "title_en": "English marketing title",
    "summary_en": "Clean 1-2 sentence English summary",
    "features_en": ["Feature 1", "Feature 2"],
    "clean_summary": "صياغة تنفيذية منسقة لما ورد في الوصف والصوت",
    "features": ["المميزات المذكورة صراحة فقط"],
    "ready_to_move": "true فقط إذا ذُكر استلام فوري صراحة وإلا null",
    "i18n": { "${other}": { "title": "", "location": "", "clean_summary": "", "features": [] } }
  }
}`;
}

/* --------------------------------------------------------------------------- */
/* Gemini On-Demand Vision Prompt (Runs ONLY on First Flyer Request)           */
/* --------------------------------------------------------------------------- */
function buildVisionPrompt() {
  return `You are an expert real estate creative director. Analyze these property photos to curate a luxury marketing brochure.
Return ONE JSON object strictly adhering to:
{
  "hero_index": number,
  "image_roles": string[],
  "image_order": number[]
}

Rules & Constraints:
1. "image_roles": Array matching input indices with values strictly from:
   ["view", "garden", "exterior", "facade", "reception", "living", "bedroom", "kitchen", "bathroom", "document", "other"].
2. HERO IMAGE RULES:
   - "hero_index" MUST be an impressive wide-angle living/reception room, landscaped garden, panoramic view, or exterior building/villa facade.
   - Bathrooms, kitchens, corridors, floor plans, payment schedules, and close-up detail shots MUST NEVER be selected as the hero image.
3. DIVERSITY QUOTAS:
   - "image_order" must contain up to 9 distinct image indices.
   - Enforce variety: maximum 2 reception, maximum 2 bedrooms, maximum 1 kitchen, maximum 1 terrace/view.
   - Avoid selecting multiple repetitive angles of the exact same room or furniture piece.
4. REJECTION:
   - Mark payment schedules, text documents, screenshots, WhatsApp notes, and blurry/distorted shots as "document" or "other".
   - Strictly exclude them from "image_order".`;
}

/* --------------------------------------------------------------------------- */
/* Validation & Normalization                                                  */
/* --------------------------------------------------------------------------- */
function validateDraft(raw, targetLang = "ar") {
  const d = (Array.isArray(raw) ? raw[0] : raw) || {};
  const det = d.details && typeof d.details === "object" ? d.details : {};
  const str = (v, max = 200) =>
    String(v ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  const num = (v, lo, hi) => {
    const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const list = (v, max, len = 60) =>
    (Array.isArray(v) ? v : [])
      .map((x) => str(x, len))
      .filter(Boolean)
      .slice(0, max);

  const type = str(d.property_type)
    .toLowerCase()
    .replace(/[\s_-]/g, "");

  const other = targetLang === "en" ? "ar" : "en";
  const alt = det.i18n && typeof det.i18n === "object" ? det.i18n[other] : null;
  const i18n =
    alt && typeof alt === "object"
      ? {
          [other]: {
            title: str(alt.title, 160),
            location: str(alt.location, 160),
            clean_summary: str(alt.clean_summary, 600),
            features: list(alt.features, 8, 40)
          }
        }
      : null;

  const beds = num(d.bedrooms, 1, 30);
  const baths = num(det.bathrooms, 1, 30);

  return {
    title: str(d.title, 160),
    property_type: ALL_TYPES.includes(type) ? type : "apartment",
    listing_type: d.listing_type === "rent" ? "rent" : "sale",
    price_raw: d.price_value ?? d.price_display ?? null,
    area_value: num(d.area_value, 10, 100000),
    bedrooms: beds ? Math.round(beds) : null,
    location: str(d.location, 160),
    compound: str(d.compound, 80),
    district: str(d.district, 80),
    city: str(d.city, 80),
    location_keywords: S.normalizeKeywords(d.location_keywords),
    details: {
      currency: ["USD", "EUR", "EGP"].includes(det.currency)
        ? det.currency
        : "EGP",
      floor: str(det.floor, 40) || null,
      floor_en: str(det.floor_en, 40) || null,
      title_en: str(det.title_en, 160) || null,
      finishing: str(det.finishing, 40) || null,
      finishing_en: str(det.finishing_en, 40) || null,
      summary_en: str(det.summary_en, 600) || null,
      features_en: list(det.features_en, 8, 40),
      bathrooms: baths ? Math.round(baths) : null,
      has_master_bedroom: Boolean(
        det.has_master_bedroom || det.master_bedrooms
      ),
      master_bedrooms: num(det.master_bedrooms, 1, 10),
      has_dressing_room: Boolean(det.has_dressing_room),
      nanny_room: Boolean(det.nanny_room),
      rent_period:
        det.rent_period === "yearly"
          ? "yearly"
          : det.rent_period === "monthly"
          ? "monthly"
          : null,
      clean_summary: str(det.clean_summary, 600),
      ambiguous_location:
        det.ambiguous_location === true || det.ambiguous_location === "true",
      features: list(det.features, 10, 40),
      installment_years: num(det.installment_years, 1, 30),
      down_payment_value: num(det.down_payment_value, 1, 1e11),
      installment_amount: num(det.installment_amount, 1, 1e10),
      installment_frequency: str(det.installment_frequency, 30) || null,
      ready_to_move:
        det.ready_to_move === true || det.ready_to_move === "true"
          ? true
          : null,
      i18n
    }
  };
}

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
/* Compose & Merge (Safe Updates Without Data Loss)                            */
/* --------------------------------------------------------------------------- */
function composeFields({ existing, draft, price, imageOnly, lang, enriched }) {
  const old = existing || {};
  const oldDetails = old.details || {};
  const oldFields = {
    title: old.title,
    property_type: old.property_type,
    listing_type: old.listing_type,
    price_value: old.price_value,
    price_display: old.price_display,
    area_value: old.area_value,
    bedrooms: old.bedrooms,
    location: old.location,
    compound: old.compound,
    district: old.district,
    city: old.city,
    location_keywords: old.location_keywords || [],
    details: oldDetails
  };

  if (existing && imageOnly) return oldFields;

  const dd = draft.details || {};
  const details = { ...oldDetails, ...dd, lang };

  for (const k of [
    "currency",
    "floor",
    "floor_en",
    "title_en",
    "finishing",
    "finishing_en",
    "summary_en",
    "bathrooms",
    "has_master_bedroom",
    "master_bedrooms",
    "has_dressing_room",
    "nanny_room",
    "rent_period",
    "clean_summary",
    "installment_years",
    "down_payment_value",
    "installment_amount",
    "installment_frequency",
    "ready_to_move"
  ]) {
    if (dd[k] !== null && dd[k] !== undefined && dd[k] !== "") {
      details[k] = dd[k];
    }
  }

  if (Array.isArray(dd.features) && dd.features.length)
    details.features = dd.features;
  if (Array.isArray(dd.features_en) && dd.features_en.length)
    details.features_en = dd.features_en;
  if (dd.i18n) details.i18n = { ...(oldDetails.i18n || {}), ...dd.i18n };
  if (price && price.currency) details.currency = price.currency;
  if (enriched && enriched.basis) details.location_basis = enriched.basis;

  const keep = (nv, ov) =>
    nv !== null && nv !== undefined && nv !== "" ? nv : ov;
  const hasPrice = Boolean(price && price.priceValue);

  return {
    title:
      draft.title ||
      old.title ||
      (lang === "en" ? "Residential Property" : "وحدة سكنية معروضة"),
    property_type: keep(draft.property_type, old.property_type) || "apartment",
    listing_type: keep(draft.listing_type, old.listing_type) || "sale",
    price_value: hasPrice ? price.priceValue : old.price_value ?? null,
    price_display: hasPrice
      ? price.priceDisplay
      : old.price_display || (price && price.priceDisplay) || null,
    area_value: keep(draft.area_value, old.area_value) ?? null,
    bedrooms: keep(draft.bedrooms, old.bedrooms) ?? null,
    location: keep(draft.location, old.location) || "",
    compound: keep(draft.compound, old.compound) || "",
    district: keep(draft.district, old.district) || "",
    city: keep(draft.city, old.city) || "",
    location_keywords:
      draft.location_keywords && draft.location_keywords.length
        ? draft.location_keywords
        : old.location_keywords || [],
    details
  };
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
  buildVisionPrompt,
  validateDraft,
  validateVisionDraft,
  composeFields
};
