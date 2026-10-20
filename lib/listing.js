// lib/listing.js — pure helpers (no I/O) so they can be unit-tested
"use strict";
const crypto = require("crypto");
const S = require("./search");

const ROLES = ["view", "garden", "exterior", "facade", "reception", "living", "bedroom", "kitchen", "bathroom", "other"];
const ALL_TYPES = [...S.PROPERTY_TYPES, "land"];

/* ---- text signals (note: `(?=$|\s)` is the end-of-text anchor; `\$` would be a literal dollar sign) ---- */
function extractExplicitUnitCode(text) {
  if (!text) return null;
  const m = String(text).match(
    /(?:^|[\s,،])(?:إضافة|اضافة|استبدال|add|replace|كود|code|ref)(?:\s+#?|\s*#)([A-Za-z0-9_-]{2,})(?=$|[\s,،])/i
  );
  return m && m[1] ? m[1].toUpperCase() : null;
}

function isLikelyListingMetadata(text) {
  if (!text) return false;
  if (/(?:^|\s)(عايز|عاوز|محتاج|ابحث|دورلي|عندك|عندنا|search|find|looking for)(?=$|\s)/i.test(text)) return false;
  return /(?:^|\s)(كود|code|للبيع|مطلوب|مساحة|دور|تشطيب|كمبوند|شقة|فيلا|غرف|مقدم|تقسيط|ref)(?=$|\s)/i.test(text);
}

function detectLang(text, fallback = "ar") {
  if (/(?:^|\s)(en|english|انجليزي|إنجليزي)(?=$|\s)/i.test(text)) return "en";
  if (/(?:^|\s)(ar|arabic|عربي)(?=$|\s)/i.test(text)) return "ar";
  return fallback;
}

const isReplaceMode = (text) => /(?:^|\s)(استبدال|replace)(?=$|\s)/i.test(text);

/* ---- listing code: explicit codes are kept; random ones are retried on collision (unique index) ---- */
function generateListingCode(customCode, propertyType) {
  if (customCode && typeof customCode === "string") {
    const cleaned = customCode
      .trim()
      .replace(/^(?:كود|code|ref|#)\s*/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .toUpperCase();
    if (cleaned.length >= 2) return { code: cleaned, explicit: true };
  }
  const prefix =
    {
      apartment: "APT", villa: "VIL", townhouse: "TWN", twinhouse: "TWN", duplex: "DUP",
      penthouse: "PNT", chalet: "CHL", studio: "STU", office: "OFF", commercial: "COM", land: "LND"
    }[String(propertyType || "").toLowerCase()] || "UNT";
  return { code: `RK-${prefix}-${crypto.randomInt(10000, 100000)}`, explicit: false };
}

/* ---- Gemini prompt ---- */
function buildListingPrompt(targetLang) {
  const other = targetLang === "en" ? "ar" : "en";
  return `أنت نظام تدقيق واستخراج بيانات عقارية عالي الدقة لمنصة وساطة معتمدة.
مهمتك استخراج مواصفات الوحدة العقارية بدقة متناهية وإخراجها حصراً في صيغة JSON صالحة.
اللغة الأساسية للمخرجات: "${targetLang}" (ar أو en فقط). بالإضافة إليها ترجم (title, location, clean_summary, features) إلى "${other}" داخل details.i18n.${other}.

قواعد عامة: لا تخمّن أي رقم أو معلومة غير مذكورة؛ استخدم null أو "" بدلاً من التخمين.

قواعد الموقع:
- غالباً يذكر الوسيط اسم الكمبوند أو المنطقة في بداية كلامه (مثال: "شقة ميفيدا"، "فيلا في بادية"). يحظر إهماله إذا ذُكر.
- (compound): اسم الكمبوند/المشروع. (district): الحي/المنطقة. (city): المدينة. (location): الموقع الكامل المعروض للعميل.

قواعد الصور (إن وُجدت صور):
- حدد دور كل صورة بنفس ترتيب إرسالها (index يبدأ من 0) في details.image_roles بإحدى القيم فقط: ${JSON.stringify(ROLES)}.
- رتب الصور في details.image_order (أرقام) بحيث يكون الأول أفضل صورة تسويقية (إطلالة/حديقة/واجهة/ريسبشن). يُمنع أن تكون الأولى مطبخاً أو حماماً.

JSON المطلوب:
{
  "custom_code": "كود ذكره الوسيط أو null",
  "title": "عنوان تسويقي رسمي مستوحى من النص/الصوت فقط",
  "property_type": "${ALL_TYPES.join(" | ")}",
  "listing_type": "sale | rent",
  "price_value": "السعر كرقم أو نص كما ذُكر أو null",
  "price_display": "السعر المنسق أو null",
  "area_value": "المساحة بالمتر المربع أو null",
  "bedrooms": "عدد غرف النوم أو null",
  "location": "", "compound": "", "district": "", "city": "",
  "location_keywords": ["اسم الكمبوند والمنطقة والمدينة ومرادفاتها"],
  "details": {
    "bathrooms": null,
    "clean_summary": "صياغة منسقة لما ورد في الوصف",
    "features": ["أبرز المميزات المذكورة فقط"],
    "installment_years": null,
    "down_payment_value": null,
    "finishing": "نوع التشطيب كما ذُكر أو null",
    "ready_to_move": "true فقط إذا ذُكر استلام فوري/جاهز للسكن صراحة وإلا null",
    "image_roles": [],
    "image_order": [],
    "i18n": { "${other}": { "title": "", "location": "", "clean_summary": "", "features": [] } }
  }
}`;
}

/* ---- validate / clamp everything the model returns before it touches the DB or the flyer ---- */
function validateDraft(raw, nImages = 0, targetLang = "ar") {
  const d = (Array.isArray(raw) ? raw[0] : raw) || {};
  const det = d.details && typeof d.details === "object" ? d.details : {};
  const str = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const num = (v, lo, hi) => {
    const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const list = (v, max, len = 60) => (Array.isArray(v) ? v : []).map((x) => str(x, len)).filter(Boolean).slice(0, max);

  const type = str(d.property_type).toLowerCase().replace(/[\s_-]/g, "");
  const roles = Array.isArray(det.image_roles) ? det.image_roles : [];
  const image_roles = Array.from({ length: nImages }, (_, i) => {
    const r = str(roles[i]).toLowerCase();
    return ROLES.includes(r) ? r : "other";
  });
  const seen = new Set();
  const image_order = [];
  for (const x of Array.isArray(det.image_order) ? det.image_order : []) {
    const i = Number(x);
    if (Number.isInteger(i) && i >= 0 && i < nImages && !seen.has(i)) {
      seen.add(i);
      image_order.push(i);
    }
  }
  for (let i = 0; i < nImages; i++) if (!seen.has(i)) image_order.push(i);

  const other = targetLang === "en" ? "ar" : "en";
  const alt = det.i18n && typeof det.i18n === "object" ? det.i18n[other] : null;
  const i18n =
    alt && typeof alt === "object"
      ? { [other]: { title: str(alt.title, 160), location: str(alt.location, 160), clean_summary: str(alt.clean_summary, 600), features: list(alt.features, 8, 40) } }
      : null;

  const beds = num(d.bedrooms, 1, 30);
  return {
    custom_code: str(d.custom_code, 30) || null,
    title: str(d.title, 160),
    property_type: ALL_TYPES.includes(type) ? type : null,
    listing_type: d.listing_type === "rent" ? "rent" : d.listing_type === "sale" ? "sale" : null,
    price_raw: d.price_value ?? d.price_display ?? null,
    area_value: num(d.area_value, 10, 100000),
    bedrooms: beds ? Math.round(beds) : null,
    location: str(d.location, 160),
    compound: str(d.compound, 80),
    district: str(d.district, 80),
    city: str(d.city, 80),
    location_keywords: S.normalizeKeywords(d.location_keywords),
    details: {
      bathrooms: num(det.bathrooms, 1, 30),
      clean_summary: str(det.clean_summary, 600),
      features: list(det.features, 8, 40),
      installment_years: num(det.installment_years, 1, 20),
      down_payment_value: num(det.down_payment_value, 1, 1e10),
      finishing: str(det.finishing, 40) || null,
      ready_to_move: det.ready_to_move === true || det.ready_to_move === "true" ? true : null,
      image_roles,
      image_order,
      i18n
    }
  };
}

/* ---- merge a draft into an existing row (or defaults for a new one) ---- */
function composeFields({ existing, draft, price, imageOnly, lang, enriched }) {
  const old = existing || {};
  const oldDetails = old.details || {};
  const oldFields = {
    title: old.title, property_type: old.property_type, listing_type: old.listing_type,
    price_value: old.price_value, price_display: old.price_display, area_value: old.area_value,
    bedrooms: old.bedrooms, location: old.location, compound: old.compound, district: old.district,
    city: old.city, location_keywords: old.location_keywords || [], details: oldDetails
  };
  if (existing && imageOnly) return oldFields; // photos only: never let the model overwrite text fields

  const dd = draft.details;
  const details = { ...oldDetails, lang };
  for (const k of ["bathrooms", "clean_summary", "installment_years", "down_payment_value", "finishing", "ready_to_move"]) {
    if (dd[k] !== null && dd[k] !== undefined && dd[k] !== "") details[k] = dd[k];
  }
  if (dd.features.length) details.features = dd.features;
  if (dd.i18n) details.i18n = { ...(oldDetails.i18n || {}), ...dd.i18n };
  if (enriched && enriched.basis) details.location_basis = enriched.basis;
  delete details.image_roles; // roles live on listing_images.role now
  delete details.image_order;

  const keep = (nv, ov) => (nv !== null && nv !== undefined && nv !== "" ? nv : ov);
  const hasPrice = Boolean(price && price.priceValue);
  return {
    title: draft.title || old.title || (lang === "en" ? "Residential Property" : "وحدة سكنية معروضة"),
    property_type: keep(draft.property_type, old.property_type) || "apartment",
    listing_type: keep(draft.listing_type, old.listing_type) || "sale",
    price_value: hasPrice ? price.priceValue : old.price_value ?? null,
    price_display: hasPrice ? price.priceDisplay : old.price_display || (price && price.priceDisplay) || null,
    area_value: keep(draft.area_value, old.area_value) ?? null,
    bedrooms: keep(draft.bedrooms, old.bedrooms) ?? null,
    location: keep(draft.location, old.location) || "",
    compound: keep(draft.compound, old.compound) || "",
    district: keep(draft.district, old.district) || "",
    city: keep(draft.city, old.city) || "",
    location_keywords: draft.location_keywords.length ? draft.location_keywords : old.location_keywords || [],
    details
  };
}

module.exports = {
  ROLES, ALL_TYPES,
  extractExplicitUnitCode, isLikelyListingMetadata, detectLang, isReplaceMode,
  generateListingCode, buildListingPrompt, validateDraft, composeFields
};
