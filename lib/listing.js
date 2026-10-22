// lib/listing.js — Pure Helpers for Listing Extraction, Vision Curation, Validation & Merging
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
/* 1. Text Signals & Regex Parsing                                             */
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

  // Strip invisible Bidi marks: \u200E, \u200F, \u202A-\u202E
  const clean = text.replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim();

  // Pattern 1: Explicit keyword prefix: (كود|code|unit|ref) optionally followed by wrappers
  const prefixRegex =
    /(?:كود|code|unit|ref)\s*[:\/\-\s]*[`\[#]?([A-Za-z0-9_\-\.\/]+)[`\]]?/i;
  let match = clean.match(prefixRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "");
    if (candidate.length >= 2) {
      return { hasCode: true, code: candidate };
    }
  }

  // Pattern 2: Explicit Markdown/Wrapper tokens: `CODE`, [CODE], #CODE
  const wrapperRegex = /[`\[#]([A-Za-z0-9_\-\.\/]+)[`\]]/;
  match = clean.match(wrapperRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "");
    if (candidate.length >= 2 && /[A-Za-z\-_/]/.test(candidate)) {
      return { hasCode: true, code: candidate };
    }
  }

  // Pattern 3: Standalone alphanumeric identifier with both letters and numbers
  const standaloneRegex =
    /\b([A-Za-z]+[0-9_\-\.\/][A-Za-z0-9_\-\.\/]*|[0-9]+[A-Za-z_\-\.\/][A-Za-z0-9_\-\.\/]*)\b/;
  match = clean.match(standaloneRegex);
  if (match && match[1]) {
    return { hasCode: true, code: match[1] };
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
  )
    return false;
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
/* 2. Code Generator                                                          */
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
/* 3. Gemini Multimodal Ingestion Prompt                                      */
/* --------------------------------------------------------------------------- */

function buildListingPrompt(
  targetLang = "ar",
  fenceToken = "USER_INPUT_BOUNDARY"
) {
  const other = targetLang === "en" ? "ar" : "en";
  return `You are an expert real estate data parser for the Egyptian property market (East/West Cairo, New Cairo, Zayed, North Coast).
Extract unit specifications from broker notes into clean, strictly valid JSON.
PRIMARY OBJECTIVE: Produce COMPLETE DUAL ARABIC & ENGLISH representations in ONE pass so search, WhatsApp cards, and luxury English flyers require zero secondary API translations.

CRITICAL SYSTEM RULES:
1. NEVER EXTRACT UNIT CODES: Ignore any unit codes (e.g. N4-105, HAS101) in text or voice (handled externally).
2. TERMINOLOGY ENFORCEMENT:
   - Arabic: Always use "غرفة ناني" or "ناني". NEVER use "خادمة".
   - English: Always use "Nanny Room". NEVER use "Maid's Room".
   - Orientation: Detect "بحري" (North Facing), "قبلي" (South Facing), "شرقي" (East Facing), "غربي" (West Facing).
3. ELEVATED SPECIFICATIONS:
   - Bathrooms: numeric integer count (e.g. 2, 3).
   - Nanny Room: has_nanny_room (boolean).
   - Dressing Room: has_dressing_room (boolean).
   - Master Bedrooms: has_master_bedroom (boolean), master_bedrooms (number or null).
   - Floor: Arabic (e.g. "أرضي", "الدور الثالث", "متكرر") and English floor_en (e.g. "Ground Floor", "3rd Floor", "Typical Floor"). If Villa/Townhouse, floor should be null.
   - Finishing: Arabic finishing (e.g. "الترا سوبر لوكس", "تشطيب كامل", "نصف تشطيب", "بدون تشطيب") and English finishing_en (e.g. "Ultra Super Lux", "Fully Finished", "Semi-Finished", "Core & Shell"). If unmentioned, return null (DO NOT INVENT DEFAULTS).
   - Delivery / Ready to Move:
     * ready_to_move: true ONLY if explicitly immediate/ready/فوري/جاهز للاستلام.
     * delivery_date: Year or timeline (e.g. "2026", "فوري", "Q4 2025") or null.
4. RESALE FINANCIALS & CASH BREAKDOWN (Crucial for Egyptian Resale Market):
   - price_value: Total Asking Price as pure number.
   - down_payment_value: Cash amount already paid by owner to developer.
   - over_price: Overprice amount over contract if mentioned (number, else null).
   - club_fee: Sports/community club membership fee (number, else null).
   - transfer_fee: Reassignment / transfer fee to developer (number, else null).
   - maintenance_fee: Maintenance deposit amount (number, else null).
   - maintenance_paid: boolean (true if paid by owner, false if due upon delivery, null if unstated).
   - remaining_balance: Total remaining balance / debt payable in installments to developer.
   - installment_years: remaining installment tenure in years.
   - installment_frequency: "quarterly" | "monthly" | "semi-annual" | "annual".
   - installment_amount: specific installment check amount.
   - total_upfront_cash: Calculate exact upfront cash required = (down_payment_value + (over_price || 0) + (club_fee || 0) + (transfer_fee || 0)).
5. DUAL-LANGUAGE SUMMARIES:
   - clean_summary (Arabic): Structured, professional narrative highlighting property type, location, orientation (بحري), delivery timeline, full price breakdown (كاش مطلوب + متبقي أقساط), and key room specs.
   - summary_en (English): 1-2 clean sentences highlighting specs, orientation (North Facing), delivery, and cash/installments split.
   - compound_en: Standardized Latin name (e.g. "Hyde Park", "Villette", "NOLL", "Badya", "Mivida").
   - title_en: Concise luxury English headline (e.g. "Prime 3-Bedroom Apartment in Hyde Park").
   - features_en: Array of English tags (e.g. ["North Facing", "Nanny Room", "Dressing Room", "Open View"]).

Return JSON strictly adhering to this schema:
{
  "title": "عنوان تسويقي رسمي جذاب مستوحى من الوصف (بدون ذكر كود)",
  "property_type": "${ALL_TYPES.join(" | ")}",
  "listing_type": "sale | rent",
  "price_value": null,
  "price_display": null,
  "area_value": null,
  "bedrooms": null,
  "location": "",
  "compound": "",
  "compound_en": "",
  "district": "",
  "city": "",
  "location_keywords": [],
  "details": {
    "currency": "EGP | USD | EUR",
    "floor": null,
    "floor_en": null,
    "bathrooms": null,
    "has_master_bedroom": false,
    "master_bedrooms": null,
    "has_dressing_room": false,
    "has_nanny_room": false,
    "nanny_room": false,
    "orientation": "بحري | قبلي | شرقي | غربي | null",
    "orientation_en": "North Facing | South Facing | East Facing | West Facing | null",
    "ready_to_move": null,
    "delivery_date": null,
    "finishing": null,
    "finishing_en": null,
    "title_en": "English marketing headline",
    "summary_en": "Clean 1-2 sentence English summary with financial split",
    "features_en": ["Feature 1", "Feature 2"],
    "clean_summary": "صياغة تنفيذية منسقة تشمل الوجهة والاستلام وتفاصيل الكاش والأقساط",
    "features": ["المميزات المذكورة صراحة فقط"],
    "down_payment_value": null,
    "over_price": null,
    "club_fee": null,
    "transfer_fee": null,
    "maintenance_fee": null,
    "maintenance_paid": null,
    "remaining_balance": null,
    "total_upfront_cash": null,
    "installment_years": null,
    "installment_amount": null,
    "installment_frequency": null,
    "rent_period": null,
    "i18n": { "${other}": { "title": "", "location": "", "clean_summary": "", "features": [] } }
  }
}`;
}

/* --------------------------------------------------------------------------- */
/* 4. Gemini On-Demand Vision Curation Prompt (Runs on First Flyer Request)    */
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
/* 5. Validation & Normalization                                              */
/* --------------------------------------------------------------------------- */

function validateDraft(inputDraft, lang = "ar") {
  const details = inputDraft.details || {};

  return {
    ...inputDraft,
    details: {
      ...details,
      finishing: details.finishing ?? null,
      finishing_en: details.finishing_en ?? null,
      floor: details.floor ?? null,
      bathrooms: details.bathrooms ?? null,
      view: details.view ?? null,
      orientation_en: details.orientation_en ?? null,
      currency: details.currency || "EGP"
    }
  };
}

/* --------------------------------------------------------------------------- */
/* 6. Context-Aware Completeness & Validation Gatekeeper                      */
/* --------------------------------------------------------------------------- */

function checkDraftCompleteness(draft, parsedContext = {}) {
  const ctx = parsedContext || {};
  const blockers = [];
  const warnings = [];

  const propType = String(draft.property_type || "").toLowerCase();
  const isStudio = propType === "studio";
  const isLanded = ["villa", "townhouse", "twin_house", "stand_alone"].includes(
    propType
  );

  // Blocker rules
  if (!draft.price_value || draft.price_value <= 0) {
    blockers.push({
      field: "price_value",
      message: "Asking price is required"
    });
  }
  if (!draft.compound || !draft.compound.trim()) {
    blockers.push({ field: "compound", message: "Compound name is required" });
  }
  if (!draft.area_value || draft.area_value <= 0) {
    blockers.push({ field: "area_value", message: "Area space is required" });
  }
  if (
    !isStudio &&
    (draft.bedrooms === undefined ||
      draft.bedrooms === null ||
      draft.bedrooms <= 0)
  ) {
    blockers.push({ field: "bedrooms", message: "Bedrooms count is required" });
  }

  // Floor warning: Exclude landed properties
  const floorVal = draft.details?.floor ?? draft.floor;
  if (
    !isLanded &&
    (floorVal === null || floorVal === undefined || floorVal === "")
  ) {
    warnings.push({ field: "floor", message: "Floor number is missing" });
  }

  // Delta warning for resale math (safe navigation applied)
  let deltaWarning = null;
  const price = draft.price_value || ctx.priceValue || 0;
  const dp = draft.details?.down_payment_value || draft.down_payment_value || 0;
  const rem = draft.details?.remaining_balance || draft.remaining_balance || 0;

  if (dp > 0 && rem > 0 && price > 0 && dp + rem !== price) {
    deltaWarning = { diff: Math.abs(price - (dp + rem)) };
  }

  return {
    isComplete: blockers.length === 0,
    blockers,
    warnings,
    deltaWarning
  };
}

/* --------------------------------------------------------------------------- */
/* 7. Vision Draft Validation & Ranking Order Resolver                         */
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
/* 8. Field Merging & Safe Update Composition                                 */
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
    compound_en: old.compound_en || oldDetails.compound_en || null,
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
    "compound_en",
    "title_en",
    "finishing",
    "finishing_en",
    "summary_en",
    "bathrooms",
    "has_master_bedroom",
    "master_bedrooms",
    "has_dressing_room",
    "has_nanny_room",
    "nanny_room",
    "orientation",
    "orientation_en",
    "ready_to_move",
    "delivery_date",
    "rent_period",
    "clean_summary",
    "down_payment_value",
    "over_price",
    "club_fee",
    "transfer_fee",
    "maintenance_fee",
    "maintenance_paid",
    "remaining_balance",
    "total_upfront_cash",
    "installment_years",
    "installment_amount",
    "installment_frequency"
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
    compound_en:
      keep(draft.compound_en, old.compound_en) || details.compound_en || null,
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
  checkDraftCompleteness,
  validateVisionDraft,
  composeFields
};
