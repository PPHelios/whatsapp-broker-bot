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
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0]);
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

  const validPattern = /^[A-Za-z0-9_-]{2,30}$/;
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
/* Gemini Ingestion Prompt (Dual AR/EN + Elevated Specs & Resale Structure)    */
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
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const list = (v, max, len = 60) =>
    (Array.isArray(v) ? v : [])
      .map((x) => str(x, len))
      .filter(Boolean)
      .slice(0, max);

  const rawType = str(d.property_type)
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  const type = ALL_TYPES.includes(rawType) ? rawType : "apartment";

  const isStudio = type === "studio";
  const isLanded = [
    "villa",
    "townhouse",
    "twinhouse",
    "penthouse",
    "land"
  ].includes(type);

  // Studio exemption: bedrooms default to 0
  let beds = num(d.bedrooms, 0, 30);
  if (isStudio && (beds === null || beds === undefined)) {
    beds = 0;
  }

  const baths = num(det.bathrooms, 1, 30);

  // Floor handling with villa/landed exemption and ground-floor normalization
  let floor = str(det.floor, 40) || null;
  let floor_en = str(det.floor_en, 40) || null;
  const rawTextBlob = `${d.title || ""} ${det.clean_summary || ""} ${
    floor || ""
  }`.toLowerCase();

  if (isLanded) {
    floor = null;
    floor_en = null;
  } else if (/أرضي|ارضي|ground/i.test(rawTextBlob)) {
    floor = floor || "أرضي";
    floor_en = floor_en || "Ground Floor";
  }

  // Delivery handling
  let ready_to_move = null;
  if (
    det.ready_to_move === true ||
    det.ready_to_move === "true" ||
    /فوري|جاهز للاستلام|ready to move|immediate/i.test(rawTextBlob)
  ) {
    ready_to_move = true;
  }
  const delivery_date =
    str(det.delivery_date, 40) || (ready_to_move ? "فوري" : null);

  // Orientation handling
  let orientation = str(det.orientation, 40) || null;
  let orientation_en = str(det.orientation_en, 40) || null;
  if (!orientation) {
    if (/بحري صريح/i.test(rawTextBlob)) {
      orientation = "بحري صريح";
      orientation_en = orientation_en || "Prime North Facing";
    } else if (/بحري/i.test(rawTextBlob)) {
      orientation = "بحري";
      orientation_en = orientation_en || "North Facing";
    } else if (/قبلي/i.test(rawTextBlob)) {
      orientation = "قبلي";
      orientation_en = orientation_en || "South Facing";
    } else if (/شرقي/i.test(rawTextBlob)) {
      orientation = "شرقي";
      orientation_en = orientation_en || "East Facing";
    } else if (/غربي/i.test(rawTextBlob)) {
      orientation = "غربي";
      orientation_en = orientation_en || "West Facing";
    }
  }

  // Nanny room consistency (support both has_nanny_room & nanny_room)
  const has_nanny = Boolean(
    det.has_nanny_room || det.nanny_room || /ناني|dada|maid/i.test(rawTextBlob)
  );
  const has_dressing = Boolean(
    det.has_dressing_room || /دريسنج|dressing/i.test(rawTextBlob)
  );

  // Resale financials & upfront cash calculation
  const down_payment_value = num(det.down_payment_value, 1, 1e11);
  const over_price = num(det.over_price, 0, 1e10);
  const club_fee = num(det.club_fee, 0, 1e9);
  const transfer_fee = num(det.transfer_fee, 0, 1e9);
  const maintenance_fee = num(det.maintenance_fee, 0, 1e9);
  const remaining_balance = num(det.remaining_balance, 0, 1e11);

  let total_upfront_cash = num(det.total_upfront_cash, 1, 1e11);
  if (!total_upfront_cash && down_payment_value) {
    total_upfront_cash =
      down_payment_value +
      (over_price || 0) +
      (club_fee || 0) +
      (transfer_fee || 0);
  }

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

  return {
    title: str(d.title, 160),
    property_type: type,
    listing_type: d.listing_type === "rent" ? "rent" : "sale",
    price_raw: d.price_value ?? d.price_display ?? null,
    area_value: num(d.area_value, 10, 100000),
    bedrooms: beds !== null ? Math.round(beds) : null,
    location: str(d.location, 160),
    compound: str(d.compound, 80),
    compound_en: str(d.compound_en || det.compound_en, 80) || null,
    district: str(d.district, 80),
    city: str(d.city, 80),
    location_keywords: S.normalizeKeywords(d.location_keywords),
    details: {
      currency: ["USD", "EUR", "EGP"].includes(det.currency)
        ? det.currency
        : "EGP",
      floor,
      floor_en,
      compound_en: str(d.compound_en || det.compound_en, 80) || null,
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
      has_dressing_room: has_dressing,
      has_nanny_room: has_nanny,
      nanny_room: has_nanny, // Backward compatibility
      orientation,
      orientation_en,
      ready_to_move,
      delivery_date,
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
      down_payment_value,
      over_price,
      club_fee,
      transfer_fee,
      maintenance_fee,
      maintenance_paid:
        det.maintenance_paid === true || det.maintenance_paid === "true"
          ? true
          : null,
      remaining_balance,
      total_upfront_cash,
      installment_years: num(det.installment_years, 1, 30),
      installment_amount: num(det.installment_amount, 1, 1e10),
      installment_frequency: str(det.installment_frequency, 30) || null,
      i18n
    }
  };
}

/* --------------------------------------------------------------------------- */
/* Context-Aware Completeness & Validation Gatekeeper                          */
/* --------------------------------------------------------------------------- */
function checkDraftCompleteness(draft, parsedPrice = null) {
  const d = draft || {};
  const det = d.details || {};
  const blockers = [];
  const warnings = [];

  const priceVal = parsedPrice?.priceValue ?? d.price_value;
  if (!priceVal || Number(priceVal) <= 0) {
    blockers.push("السعر المطلوب غير محدد (Price is required)");
  }

  const location = d.compound || d.district || d.location;
  if (!location || String(location).trim().length < 2) {
    blockers.push(
      "اسم الكمبوند أو المنطقة غير محدد (Compound or district is required)"
    );
  }

  const area = Number(d.area_value);
  if (!area || area < 10) {
    blockers.push(
      "المساحة الإجمالية غير صالحة أو غير محددة (Area >= 10m² is required)"
    );
  }

  const isStudio = d.property_type === "studio";
  if (!isStudio && (d.bedrooms === null || d.bedrooms === undefined)) {
    blockers.push("عدد غرف النوم غير محدد (Bedrooms count is required)");
  }

  // Soft visual warnings for review card (will be stored as NULL if uncorrected)
  if (!det.finishing) {
    warnings.push({
      field: "finishing",
      label_ar: "التشطيب",
      label_en: "Finishing",
      note_ar: "غير محدد (سيترك فارغاً)",
      note_en: "Unstated (left blank)"
    });
  }

  if (!det.bathrooms) {
    warnings.push({
      field: "bathrooms",
      label_ar: "الحمامات",
      label_en: "Bathrooms",
      note_ar: "غير محدد (سيترك فارغاً)",
      note_en: "Unstated (left blank)"
    });
  }

  const isLanded = [
    "villa",
    "townhouse",
    "twinhouse",
    "penthouse",
    "land"
  ].includes(d.property_type);
  if (!isLanded && !det.floor) {
    warnings.push({
      field: "floor",
      label_ar: "الدور",
      label_en: "Floor",
      note_ar: "غير محدد (سيترك فارغاً)",
      note_en: "Unstated (left blank)"
    });
  }

  if (!det.ready_to_move && !det.delivery_date) {
    warnings.push({
      field: "delivery",
      label_ar: "الاستلام",
      label_en: "Delivery Date",
      note_ar: "غير محدد (سيترك فارغاً)",
      note_en: "Unstated (left blank)"
    });
  }

  // Resale Financial Reconciliation Warning
  let deltaWarning = null;
  if (priceVal && det.down_payment_value && det.remaining_balance) {
    const calculatedSum =
      Number(det.down_payment_value) +
      Number(det.remaining_balance) +
      Number(det.over_price || 0);
    const diff = Math.abs(Number(priceVal) - calculatedSum);
    if (diff > 10000) {
      deltaWarning = {
        totalPrice: Number(priceVal),
        calculatedSum,
        diff,
        message_ar: `تنبيه حسابي: مجموع المقدم (${det.down_payment_value.toLocaleString()}) والمتبقي (${det.remaining_balance.toLocaleString()}) لا يطابق إجمالي السعر (${Number(
          priceVal
        ).toLocaleString()}). الفارق: ${diff.toLocaleString()} ج.م.`,
        message_en: `Math Alert: Sum of down payment and remaining debt differs from total price by ${diff.toLocaleString()} EGP.`
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
