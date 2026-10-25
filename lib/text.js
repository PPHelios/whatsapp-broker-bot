// lib/text.js — String Cleaners, Code Parsers, Normalization & Bilingual Templates
"use strict";

const Describe = require("../domain/describe");
const Rules = require("../domain/fieldRules");

/* ====================================================================== */
/* 1. Universal Lenient Code Normalizer                                   */
/* ====================================================================== */

/**
 * Normalizes Arabic and Eastern-Arabic numerals to standard ASCII digits.
 */
function normalizeDigits(str) {
  return String(str ?? "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0]);
}

/**
 * Strips formatting artifacts, invisible Unicode marks, and punctuation from codes.
 * Handles: `KKJ654`, [N4-105], #KKJ654, \u200EKKJ654\u200F, "KKJ654".
 */
function extractCleanCode(rawCode) {
  if (!rawCode) return "";
  // Same folding as listings.code_norm (Arabic digits, case).
  return normalizeDigits(String(rawCode))
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "") // Invisible Unicode
    .replace(/^[`'"\[\(#\s_]+|[`'"\]\)#\s_]+$/g, "") // Outer punctuation & brackets
    .trim()
    .toUpperCase();
}

/**
 * Parses user input for explicit property codes with full boundary detection.
 * Supports multi-line forwarded cards, embedded labels, and markdown wrappers.
 */
function parseExplicitUnitCode(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { hasCode: false, code: null };
  }

  // Normalize Eastern Arabic numerals and strip direction overrides
  const clean = normalizeDigits(
    text.replace(/[\u200E\u200F\u202A-\u202E]/g, "")
  ).trim();

  // Pattern 1: Explicit keyword prefix (supports multi-line cards and compound labels like كود الوحدة or الكود الداخلي)
  const prefixRegex =
    /(?:كود(?:\s*(?:الوحدة|الداخلي))?|code|unit(?:\s*[\/\-]\s*(?:ref|code))?|ref)\s*[:\-\s#]*([A-Za-z0-9_\-\.\/]{2,30})/i;
  let match = clean.match(prefixRegex);
  if (match && match[1]) {
    const candidate = extractCleanCode(match[1]);
    if (
      candidate.length >= 2 &&
      !/^(?:REF|UNIT|CODE|كود)$/i.test(candidate) &&
      !/[\u0600-\u06FF]/.test(candidate)
    ) {
      return { hasCode: true, code: candidate };
    }
  }

  // Pattern 2: Explicit Markdown/Wrapper tokens: `CODE`, [CODE], #CODE
  const wrapperRegex = /[`\[#]([A-Za-z0-9_\-\.\/]{2,30})[`\]]?/;
  match = clean.match(wrapperRegex);
  if (match && match[1]) {
    const candidate = extractCleanCode(match[1]);
    if (
      candidate.length >= 2 &&
      /[A-Za-z0-9]/.test(candidate) &&
      !/[\u0600-\u06FF]/.test(candidate)
    ) {
      return { hasCode: true, code: candidate };
    }
  }

  // Pattern 3: Standalone alphanumeric identifier with letters and numbers (e.g. KKJ654, N4-105, HAS-101)
  const standaloneRegex =
    /\b([A-Za-z]+[0-9_\-\.\/][A-Za-z0-9_\-\.\/]*|[0-9]+[A-Za-z_\-\.\/][A-Za-z0-9_\-\.\/]*)\b/;
  match = clean.match(standaloneRegex);
  if (match && match[1]) {
    const candidate = extractCleanCode(match[1]);
    if (candidate.length >= 2 && !/[\u0600-\u06FF]/.test(candidate)) {
      return { hasCode: true, code: candidate };
    }
  }

  return { hasCode: false, code: null };
}

/* ====================================================================== */
/* 2. Deterministic Arabic Normalization (Mirrors PostgreSQL Function)     */
/* ====================================================================== */

function cleanArabicText(inputText) {
  if (!inputText) return "";
  return String(inputText)
    .replace(/[\u064B-\u065F\u0670]/g, "") // Remove Tashkeel
    .replace(/\u0640/g, "") // Remove Tatweel (ـ)
    .replace(/[إأآٱ]/g, "ا") // Normalize Alef
    .replace(/ى/g, "ي") // Normalize Yaa
    .replace(/ة/g, "ه") // Normalize Taa Marbouta
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAr(input) {
  if (!input) return "";
  const withDigits = normalizeDigits(input);
  return cleanArabicText(withDigits)
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[.,،;:!?؟()"/|+*_=<>@#%^&~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ====================================================================== */
/* 3. Anti-Poaching & Marketing Scrubber                                  */
/* ====================================================================== */

function stripMarketingFluff(rawText) {
  if (!rawText) return "";

  return String(rawText)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/wa\.me\/\S+/gi, "")
    .replace(/t\.me\/\S+/gi, "")
    .replace(/(?:\+?20|0)?1[0125]\d{8}\b/g, "")
    .replace(/\b(?:19|16|15)\d{3}\b/g, "")
    .replace(/@[\w.]+/g, "")
    .replace(/#[\w\u0600-\u06FF]+/g, "")
    .replace(
      /(?:للتواصل|للاستفسار|اتصل الان|كلمنا|للحجز|call us|contact us).*$/gim,
      ""
    )
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/* ====================================================================== */
/* 4. Amenity & Feature Canonical Mapping & Bilingual Dictionaries        */
/* ====================================================================== */

const FEATURE_CANONICAL_MAP = {
  بول: "حمام سباحة",
  البول: "حمام سباحة",
  "سويمينج بول": "حمام سباحة",
  "private pool": "حمام سباحة خاص",
  pool: "حمام سباحة",
  "swimming pool": "حمام سباحة",
  جاردن: "حديقة",
  حديقه: "حديقة",
  "private garden": "حديقة خاصة",
  garden: "حديقة",
  بلكونة: "شرفة",
  بلكونه: "شرفة",
  تراس: "تراس",
  balcony: "شرفة",
  terrace: "تراس",
  "غرفة دادة": "غرفة ناني",
  "غرفة داده": "غرفة ناني",
  "غرفة شغالة": "غرفة ناني",
  "غرفة شغاله": "غرفة ناني",
  "غرفة خادمة": "غرفة ناني",
  "غرفه خادمه": "غرفة ناني",
  "maid room": "غرفة ناني",
  "maids room": "غرفة ناني",
  "nanny room": "غرفة ناني",
  دريسنج: "غرفة دريسنج",
  "dressing room": "غرفة دريسنج",
  "walk-in closet": "غرفة دريسنج",
  ماستر: "غرفة ماستر",
  "master bedroom": "غرفة ماستر",
  مطبخ: "مطبخ",
  "open kitchen": "مطبخ مفتوح",
  اسانسير: "مصعد",
  أسانسير: "مصعد",
  elevator: "مصعد",
  lift: "مصعد",
  جراج: "جراج",
  "موقف سيارات": "جراج",
  parking: "جراج",
  امن: "حراسة وأمن",
  أمن: "حراسة وأمن",
  security: "حراسة وأمن",
  "فيو مفتوح": "إطلالة مفتوحة",
  "open view": "إطلالة مفتوحة",
  بحري: "بحري",
  "بحري صريح": "بحري صريح",
  "north facing": "بحري"
};

const COMPOUND_MAP = {
  "هايد بارك": "Hyde Park",
  سوديك: "SODIC",
  فيليت: "Villette",
  بادية: "Badya",
  "بالم هيلز": "Palm Hills",
  ميفيدا: "Mivida",
  "ماونتن فيو": "Mountain View",
  نول: "NOLL",
  مدينتي: "Madinaty",
  الرحاب: "Al Rehab",
  "تاج سيتي": "Taj City",
  سراي: "Sarai",
  الجونة: "El Gouna",
  مراسي: "Marassi",
  "ايست تاون": "Eastown",
  زيد: "Zed",
  "اب تاون كايرو": "Uptown Cairo",
  هايدبارك: "Hyde Park",
  "كايرو فيستيفال": "Cairo Festival City",
  البروج: "Al Burouj"
};

const FINISHING_MAP = {
  "بدون تشطيب": "Core & Shell",
  "على المحارة": "Core & Shell",
  "نصف تشطيب": "Semi-Finished",
  "تشطيب كامل": "Fully Finished",
  "سوبر لوكس": "Super Lux",
  "الترا سوبر لوكس": "Ultra Super Lux",
  "الترا لوكس": "Ultra Lux",
  ديلوكس: "Deluxe",
  مفروش: "Furnished"
};

const ORIENTATION_MAP = {
  بحري: "North Facing",
  "بحري صريح": "Prime North Facing",
  قبلي: "South Facing",
  شرقي: "East Facing",
  غربي: "West Facing",
  "بحري شرقي": "North-East Facing",
  "بحري غريي": "North-West Facing",
  "بحري غربي": "North-West Facing"
};

const PROPERTY_TYPE_MAP = {
  apartment: { ar: "شقة", en: "Apartment" },
  villa: { ar: "فيلا مستقلة", en: "Standalone Villa" },
  townhouse: { ar: "تاون هاوس", en: "Townhouse" },
  twinhouse: { ar: "توين هاوس", en: "Twinhouse" },
  duplex: { ar: "دوبلكس", en: "Duplex" },
  penthouse: { ar: "بنتهاوس", en: "Penthouse" },
  chalet: { ar: "شاليه", en: "Chalet" },
  studio: { ar: "استوديو", en: "Studio" },
  office: { ar: "مكتب إداري", en: "Office" },
  commercial: { ar: "محل تجاري", en: "Commercial" },
  land: { ar: "أرض", en: "Land" }
};

function toEnglishSpec(value, category = "finishing") {
  if (!value) return null;
  const str = String(value).trim();
  const lower = str.toLowerCase();

  const pick = (map) => {
    const entries = Object.entries(map).sort(
      (a, b) => b[0].length - a[0].length
    );
    for (const [ar, en] of entries) {
      if (str.includes(ar) || lower === en.toLowerCase()) return en;
    }
    return str;
  };

  if (category === "finishing") return pick(FINISHING_MAP);
  if (category === "orientation") return pick(ORIENTATION_MAP);
  if (category === "compound") return pick(COMPOUND_MAP);
  if (category === "type") {
    const cleanType = lower.replace(/[\s_-]/g, "");
    return (
      PROPERTY_TYPE_MAP[cleanType]?.en || PROPERTY_TYPE_MAP[lower]?.en || str
    );
  }

  return str;
}

function cleanFeaturesList(features) {
  if (!Array.isArray(features)) return [];
  const seen = new Set();
  const cleaned = [];

  for (const item of features) {
    if (!item || typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    const lower = trimmed.toLowerCase();
    const mapped = FEATURE_CANONICAL_MAP[lower] || trimmed;
    const normalized = mapped
      .replace(/[إأآا]/g, "ا")
      .replace(/ة/g, "ه")
      .toLowerCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      cleaned.push(mapped);
    }
  }
  return cleaned;
}

/* ====================================================================== */
/* 5. Egyptian Colloquial Price Parsing & Abbreviation                    */
/* ====================================================================== */

function detectCurrency(text) {
  if (!text) return "EGP";
  const s = String(text).toLowerCase();
  if (/(\$|usd|dollar|دولار)/i.test(s)) return "USD";
  if (/(€|eur|euro|يورو)/i.test(s)) return "EUR";
  return "EGP";
}

function normalizePriceInput(str) {
  if (!str) return "";
  let s = normalizeDigits(String(str)).replace(/٫/g, ".").replace(/،/g, ",");

  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:مليون|m)\s*(?:و\s*)?(?:نص|نصف)/gi,
    "$1.5 مليون"
  );
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:مليون|m)\s*(?:و\s*)?ربع/gi,
    "$1.25 مليون"
  );
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:مليون|m)\s*(?:و\s*)?(?:تلت|ثلث)/gi,
    "$1.33 مليون"
  );
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:و\s*)?(?:نص|نصف)\s*(?:مليون|m)/gi,
    "$1.5 مليون"
  );
  s = s.replace(/(?:^|\s)(?:نص|نصف)\s*(?:مليون|m)/gi, " 0.5 مليون");
  s = s.replace(/(?:^|\s)ربع\s*(?:مليون|m)/gi, " 0.25 مليون");
  s = s.replace(/(?<![\d.]\s*)مليونين(?=[\s,،]|$)/g, "2 مليون");
  s = s.replace(/(?<![\d.]\s*)مليون(?=[\s,،]|$)/g, "1 مليون");
  s = s.replace(/(?<![\d.]\s*)(?:ألفين|الفين)(?=[\s,،]|$)/g, "2 الف");

  return s.trim();
}

function parseMoney(raw, { listingType = "sale" } = {}) {
  if (raw === null || raw === undefined || raw === "") return null;
  const currency = detectCurrency(raw);
  const normalized = normalizePriceInput(String(raw));

  const isMillion =
    /(?:^|\s|\d)(?:m|million)(?![a-z])/i.test(normalized) ||
    /مليون|ملايين/.test(normalized);
  const isThousand =
    /(?:^|\s|\d)(?:k|thousand)(?![a-z])/i.test(normalized) ||
    /ألف|الف|الاف|آلاف/.test(normalized);

  const cleaned = normalized
    .replace(/,(\d{1,2})(?!\d)/g, ".$1")
    .replace(/,/g, "");
  const m = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;

  let val = parseFloat(m[1]);
  if (!Number.isFinite(val)) return null;

  const hadUnit = isMillion || isThousand;
  if (isMillion) val = Math.round(val * 1e6);
  else if (isThousand) val = Math.round(val * 1e3);
  else if (val < 100)
    val = Math.round(val * (listingType === "rent" ? 1e3 : 1e6));
  else val = Math.round(val);

  return { value: val, currency, hadUnit };
}

function formatAbbreviatedPrice(
  val,
  currency = "EGP",
  lang = "ar",
  listingType = "sale"
) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return "-";

  const isRent = listingType === "rent";

  if (lang === "ar") {
    const curLabel =
      currency === "USD" ? "دولار" : currency === "EUR" ? "يورو" : "ج.م";
    const period = isRent ? " / شهر" : "";

    if (n >= 1_000_000) {
      const millions = parseFloat((n / 1_000_000).toFixed(2));
      return `${millions} مليون ${curLabel}${period}`;
    }
    if (n >= 1_000) {
      const thousands = parseFloat((n / 1_000).toFixed(1));
      return `${thousands} ألف ${curLabel}${period}`;
    }
    return `${n.toLocaleString("en-US")} ${curLabel}${period}`;
  }

  const period = isRent ? " / mo" : "";
  if (n >= 1_000_000) {
    const millions = parseFloat((n / 1_000_000).toFixed(2));
    return `${millions}M ${currency}${period}`;
  }
  if (n >= 1_000) {
    const thousands = parseFloat((n / 1_000).toFixed(1));
    return `${thousands}K ${currency}${period}`;
  }
  return `${n.toLocaleString("en-US")} ${currency}${period}`;
}

function parseEgyptianPrice(rawText, opts = {}) {
  if (!rawText || typeof rawText !== "string") {
    return {
      priceValue: null,
      currency: opts.listingType === "rent" ? "EGP" : "EGP"
    };
  }

  let text = rawText.trim();

  let currency = "EGP";
  if (/[$]|usd|دولار/i.test(text)) {
    currency = "USD";
  } else if (/[€]|eur|يورو/i.test(text)) {
    currency = "EUR";
  }

  // 1. Handle fractions that appear AFTER "مليون" (e.g. "5 مليون ونص", "4 مليون وربع")
  text = text
    .replace(/(\d+)\s*مليون\s*ونص/g, "$1.5 مليون")
    .replace(/(\d+)\s*مليون\s*وربع/g, "$1.25 مليون")
    .replace(/(\d+)\s*مليون\s*وتلت/g, "$1.333 مليون")
    .replace(
      /(\d+)\s*مليون\s*إلا\s*ربع/g,
      (_, n) => `${parseFloat(n) - 0.25} مليون`
    );

  // 2. Handle fractions that appear BEFORE "مليون" (e.g. "5 ونص مليون", "4 وربع مليون")
  text = text
    .replace(/(\d+)\s*ونص/g, "$1.5")
    .replace(/(\d+)\s*وربع/g, "$1.25")
    .replace(/(\d+)\s*وتلت/g, "$1.333")
    .replace(/(\d+)\s*إلا\s*ربع/g, (_, n) => (parseFloat(n) - 0.25).toString())
    .replace(/مليونين\s*وربع/g, "2.25 مليون")
    .replace(/مليونين\s*ونص/g, "2.5 مليون")
    .replace(/مليونين/g, "2 مليون")
    .replace(/نص\s*مليون/g, "0.5 مليون");

  // 3. Match float followed by unit
  const match = text.match(/([\d\.,]+)\s*(مليون|ألف|الف|k|m)?/i);
  if (!match) {
    return { priceValue: null, currency };
  }

  let num = parseFloat(match[1].replace(/,/g, ""));
  if (isNaN(num)) return { priceValue: null, currency };

  const unit = (match[2] || "").toLowerCase();
  if (unit === "مليون" || unit === "m") {
    num = Math.round(num * 1000000);
  } else if (unit === "ألف" || unit === "الف" || unit === "k") {
    num = Math.round(num * 1000);
  }

  return { priceValue: num, currency };
}

function parsePrice(raw, { implicitUnits = false, listingType = "sale" } = {}) {
  const p = parseMoney(raw, { listingType });
  if (!p) return null;
  if (!implicitUnits && !p.hadUnit) return null;
  return p.value;
}

function formatPrice(n, lang = "ar", currency = "EGP") {
  return formatAbbreviatedPrice(n, currency, lang);
}

function priceText(listing, lang = "ar") {
  const currency = listing.details?.currency || "EGP";
  if (listing.price_value) {
    let p = formatAbbreviatedPrice(
      listing.price_value,
      currency,
      lang,
      listing.listing_type
    );
    if (listing.listing_type === "rent") {
      const period =
        listing.details?.rent_period === "yearly"
          ? lang === "en"
            ? "/ yr"
            : "/ سنوياً"
          : lang === "en"
          ? "/ mo"
          : "/ شهرياً";
      p += ` ${period}`;
    }
    return p;
  }
  return (
    listing.price_display || (lang === "en" ? "Upon Request" : "عند الطلب")
  );
}

/* ====================================================================== */
/* 6. Standard Header & Deliverable Card Formatting                       */
/* ====================================================================== */

function isVillaTypology(propertyType) {
  const norm = String(propertyType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return ["villa", "townhouse", "twinhouse", "standalone", "mansion"].includes(
    norm
  );
}

function isStudioTypology(propertyType, bedrooms) {
  const norm = String(propertyType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return (
    norm === "studio" || (bedrooms === 0 && !isVillaTypology(propertyType))
  );
}

function formatStandardHeader(listing, lang = "ar") {
  const isEn = lang === "en";
  const isRent = String(listing.listing_type || "").toLowerCase() === "rent";
  const safeCode = extractCleanCode(listing.code || "UNT");

  const actionPrefix = isRent
    ? isEn
      ? "🔑 Unit For Rent"
      : "🔑 وحدة للإيجار"
    : isEn
    ? "🔑 Unit For Sale"
    : "🔑 وحدة للبيع";

  const codeLabel = isEn ? "Code:" : "كود:";
  const headerLine1 = `${actionPrefix} | ${codeLabel} \`${safeCode}\``;

  const projectOrCompound = isEn
    ? listing.details?.compound_en ||
      listing.compound_en ||
      listing.compound ||
      listing.title ||
      "Prime Property"
    : listing.compound || listing.title || "عقار مميز";

  const locationOrDistrict =
    listing.district || listing.location || (isEn ? "Egypt" : "مصر");
  const headerLine2 = `🏢 ${projectOrCompound} | ${locationOrDistrict}`;

  return `${headerLine1}\n${headerLine2}`;
}

/** Client copy — delegates to the single template (domain/describe.js). */
function formatClientListingText(listing, broker = {}, lang = "ar") {
  return Describe.clientCopy(listing, broker, { lang });
}

/** Add/edit review card — delegates to domain/describe.js; warnings come from domain/fieldRules.js. */
function formatDraftReviewCard(draft, _parsedPrice = null, _validationResult = null, lang = "ar") {
  const ev = Rules.evaluate(draft || {}, { lang });
  return Describe.reviewCard({ code: "DRAFT", ...ev.listing }, { warnings: ev.warnings, blockers: ev.blockers, lang });
}

/** Broker card — delegates to domain/describe.js. */
function formatInternalListingDetails(listing, lang = "ar") {
  return Describe.brokerCard(listing, { lang });
}

/* ====================================================================== */
/* 7. Search Results Presentation & Exports                               */
/* ====================================================================== */

/**
 * Formats multi-unit search results into standard WhatsApp copy with defensive count resolution.
 */
/** Search results page — delegates to domain/describe.js (compact line + features line). */
function formatSearchResults(rows, { offset = 0, total = 0, lang = "ar" } = {}) {
  return Describe.searchResults(Array.isArray(rows) ? rows : [], { offset, total, lang });
}

function listingsToCsv(rows) {
  const TYPE_MAP = {
    apartment: "شقة / Apartment",
    villa: "فيلا / Villa",
    townhouse: "تاون هاوس / Townhouse",
    twinhouse: "توين هاوس / Twinhouse",
    duplex: "دوبلكس / Duplex",
    penthouse: "بنتهاوس / Penthouse",
    chalet: "شاليه / Chalet",
    studio: "استوديو / Studio",
    office: "مكتب / Office",
    commercial: "تجاري / Commercial",
    land: "أرض / Land"
  };

  const STATUS_MAP = {
    active: "نشط / Active",
    sold: "تم البيع / Sold",
    archived: "مؤرشف / Archived"
  };

  const headers = [
    "كود الوحدة / Code",
    "العنوان / Title",
    "النوع / Type",
    "المعاملة / Purpose",
    "السعر / Price",
    "المقدم أو الكاش / Upfront Cash",
    "العملة / Currency",
    "المساحة / Area (sqm)",
    "الدور / Floor",
    "غرف النوم / Bedrooms",
    "الحمامات / Bathrooms",
    "الوجهة / Orientation",
    "الاستلام / Delivery",
    "التشطيب / Finishing",
    "المميزات / Amenities",
    "الكمبوند / Compound",
    "الموقع الكامل / Location",
    "الحالة / Status",
    "الوصف الأصلي / Original Description",
    "الملخص الإنجليزي / English Summary"
  ];

  const esc = (v) => {
    let s = String(v ?? "").trim();
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  const lines = [headers.join(",")];

  for (const r of rows) {
    const det = r.details || {};
    const features = Array.isArray(det.features)
      ? det.features.join(" - ")
      : "";
    const delivery = det.ready_to_move
      ? "فوري / Immediate"
      : det.delivery_date || "-";

    const resolvedBathrooms =
      r.bathrooms !== null && r.bathrooms !== undefined
        ? r.bathrooms
        : det.bathrooms || "-";

    const row = [
      esc(extractCleanCode(r.code)),
      esc(r.title),
      esc(TYPE_MAP[String(r.property_type).toLowerCase()] || r.property_type),
      esc(r.listing_type === "rent" ? "إيجار / Rent" : "بيع / Sale"),
      esc(
        r.price_value
          ? formatAbbreviatedPrice(r.price_value, det.currency || "EGP", "en")
          : r.price_display || "-"
      ),
      esc(
        det.total_upfront_cash || det.down_payment_value
          ? formatAbbreviatedPrice(
              det.total_upfront_cash || det.down_payment_value,
              det.currency || "EGP",
              "en"
            )
          : "-"
      ),
      esc(det.currency || "EGP"),
      esc(r.area_value || "-"),
      esc(det.floor || "-"),
      esc(r.bedrooms !== null && r.bedrooms !== undefined ? r.bedrooms : "-"),
      esc(resolvedBathrooms),
      esc(det.orientation || "-"),
      esc(delivery),
      esc(det.finishing || "-"),
      esc(features || "-"),
      esc(r.compound || "-"),
      esc(r.location || "-"),
      esc(STATUS_MAP[String(r.status).toLowerCase()] || r.status),
      esc(det.clean_summary || r.raw_text || "-"),
      esc(det.summary_en || "-")
    ];

    lines.push(row.join(","));
  }

  return "\uFEFF" + lines.join("\r\n");
}

/* ====================================================================== */
/* 8. Comprehensive Bilingual Help Presentation                          */
/* ====================================================================== */

function getHelpMessage(lang = "ar") {
  if (lang === "en") {
    return `*🏢 Real Estate Assistant - Master Guide*

*➕ Add New Resale Listing:*
• Type *add* or *new* to start a fresh draft.
• Send property photos followed by a voice note or text with specs.
• Send *done* or *تم* to review your draft before saving.
• *Review Card:* Inspect verified attributes; tap *[✅ Confirm & Save]* or *[✏️ Edit]*.

*🔍 Search Inventory (Bilingual):*
• Voice or text search in Arabic or English:
  _e.g., "Apartment in Hyde Park 3 beds under 10M"_
  _e.g., "شقة بحري استلام فوري في التجمع"_
• Results return in batches with direct interactive buttons.

*🎯 Instant Code Lookup:*
• Send \`CODE\` or *#CODE* (e.g. \`N4-105\` or \`HP-201\`).

*📋 Deliverables & Marketing (Locked to English):*
• *flyer CODE* / *كتالوج CODE* → Luxury brochure (100% English)
• *unbranded CODE* / *بروشور بدون بيانات* → White-label brochure
• *client CODE* → Clean English client pitch text
• *عميل CODE* → Clean Arabic client pitch text
• *plans CODE* / *جدول CODE* → Multi-tier Excel schedule (Primary models)
• *layout CODE* / *مخطط CODE* → 2D Floor Plan & Drive Sales Kit
• *replace CODE* / *استبدال CODE* → Replace draft media and rebuild the draft

*✏️ Unit Management & Quick Patching:*
• Resale cards feature *[✏️ Edit]* directly on the card.
• Inline Patch: *edit CODE [field] [value]* (e.g. \`edit HP-201 price 9.5M\`)
• Two-Step Delete: *delete CODE* / *حذف CODE* (Requires explicit confirmation button)
• Mark Sold: *sold CODE* / *تم البيع CODE*
• Archive / Reactivate: *archive CODE* / *تفعيل CODE*

*📊 Tools & Bulk Management:*
• *excel* / *اكسل* → Export full agency inventory spreadsheet
• *Drop .xlsx file* in chat → Ingest bulk listings. Invalid rows are automatically returned in a rejection spreadsheet.
• *lang en* | *lang ar* → Toggle assistant language interface
• *login* / *دخول* → One-time sign-in link for the WehdatHub website (search, add, import)
• *bug* / *بلاغ* + what went wrong → Report a problem to the team (you get a reference like #R12)

*👤 Clients (CRM):*
• *lead* / *ليد* + the client's message (or forward it, or a voice note) → "I understood" card, saved on ✅ Confirm
• Send or forward a *phone number* or a *contact card* → the client's card (who is calling?)
• *my leads* / *عملائي* → your clients · *followups* / *متابعات* → your follow-ups
• *L-0042* → the client's card with [📞 Called] [📅 Follow-up] [🔄 Stage]
• *request* / *طلب* + what the client wants (after opening the client, or *request L-0042 …*) → saved; you hear when a unit fits
• Tell me what happened (text or voice): *called Sara, she wants to view VIL-08 Friday at 5* → updated after ✅ Confirm
• *deal L-0042 VIL-08 8.5M commission 2%* / *صفقة …* (optional *split 60/40 with Omar*, *external 10%*) → review, saved on ✅ Confirm
• *assign L-0042 to Sara* / *حول L-0042 لـ سارة* → managers only`;
  }

  return `*🏢 دليل استخدام المساعد العقاري المعتمد*

*➕ إضافة وحدة ريزيل جديدة:*
• اكتب *اضافة* أو *add* لبدء مسودة فارغة.
• أرسل صور الوحدة متبوعة بتسجيل صوتي أو رسالة بالمواصفات والأسعار.
• اكتب *تم* أو *done* لفتح كارت مراجعة المسودة قبل الحفظ.
• *كارت المراجعة:* افحص البيانات بدقة؛ اضغط *[✅ تأكيد وحفظ]* أو *[✏️ تعديل]*.

*🔍 البحث في المخزون (عربي وإنجليزي):*
• ابحث كتابة أو بالصوت بأي لغة:
  _مثال: "شقة بحري استلام فوري في التجمع 3 غرف"_
  _مثال: "apartment in hyde park north facing ready to move"_
• تُعرض النتائج ككروت مستقلة بأزرار تفاعلية فورية.

*🎯 فحص كود وحدة مباشرة:*
• اكتب الكود مباشرة (مثال: \`N4-105\` أو \`HP-201\`).

*📋 المخرجات والكتالوجات (إنجليزية قياسية):*
• *كتالوج الكود* / *flyer CODE* ← بروشور معتمد فائق الجودة (إنجليزي 100%)
• *بروشور بدون بيانات الكود* / *unbranded CODE* ← بروشور أبيض بدون بيانات الوكالة
• *عميل الكود* ← نص تسويقي منسق بالعربية لمشاركته مع المشتري
• *client CODE* ← نص تسويقي بالإنجليزية للعملاء الأجانب
• *جدول الكود* / *plans CODE* ← شيت إكسيل سداد ومقارنة أنظمة (للوحدات الأولية)
• *مخطط الكود* / *layout CODE* ← روابط المخطط والبروشور وملفات درايف

*✏️ إدارة وتعديل الوحدات:*
• كروت الريزيل تحتوي تلقائياً على زر *[✏️ تعديل]* بدلاً من أنظمة السداد.
• تعديل سريع: *تعديل الكود [الحقل] [القيمة]* (مثال: \`تعديل HP-201 السعر 9.5 مليون\`)
• حذف مؤكد: *حذف الكود* (يتطلب تأكيداً عبر زر تفاعلي لحماية البيانات)
• تم البيع: *تم البيع الكود*
• أرشفة / تفعيل: *أرشفة الكود* / *تفعيل الكود*

*📊 التقارير والإكسيل المجمع:*
• *اكسل* أو *excel* ← تصدير كامل مخزون الوكالة في شيت إكسيل منسق
• *سحب وإفلات ملف Excel بالدردشة* ← رفع وتحديث الوحدات مجمعة؛ يتم إرجاع شيت بالمرفوضات وأسبابها فوراً
• *عربي* | *english* | *lang ar* | *lang en* ← تبديل لغة القوائم والمحادثة
• *دخول* ← رابط دخول لموقع WehdatHub (بحث، إضافة، استيراد) صالح لمرة واحدة
• *بلاغ* + اللي حصل ← بلّغ الفريق عن مشكلة (هيوصلك رقم زي #R12)

*👤 العملاء (CRM):*
• *ليد* / *lead* + رسالة العميل (أو فوروارد أو فويس) ← كارت «فهمت كده» ويتحفظ بعد ✅ تأكيد
• ابعت أو حوّل *رقم تليفون* أو *جهة اتصال* ← كارت العميل (مين بيتصل؟)
• *عملائي* / *my leads* ← عملائك · *متابعات* / *followups* ← متابعاتك
• *L-0042* ← كارت العميل بأزرار [📞 كلمته] [📅 متابعة] [🔄 المرحلة]
• *طلب* / *request* + اللي العميل عايزه (بعد ما تفتح العميل، أو *طلب L-0042 …*) ← يتحفظ وتتبلغ لما تنزل وحدة تناسبه
• احكيلي اللي حصل (كتابة أو فويس): *كلمت سارة، عايزة تعاين VIL-08 الجمعة الساعة ٥* ← يتسجل بعد ✅ تأكيد
• *صفقة L-0042 VIL-08 8.5 مليون عمولة 2%* / *deal …* (ممكن *تقسيم 60/40 مع عمر*، *خارجي 10%*) ← مراجعة وتتحفظ بعد ✅ تأكيد
• *حول L-0042 لـ سارة* / *assign L-0042 to Sara* ← للمديرين بس`;
}

module.exports = {
  normalizeDigits,
  extractCleanCode,
  parseExplicitUnitCode,
  cleanArabicText,
  normalizeAr,
  stripMarketingFluff,
  cleanFeaturesList,
  detectCurrency,
  normalizePriceInput,
  parseMoney,
  formatAbbreviatedPrice,
  parseEgyptianPrice,
  parsePrice,
  formatPrice,
  priceText,
  formatStandardHeader,
  formatClientListingText,
  formatDraftReviewCard,
  formatInternalListingDetails,
  formatSearchResults,
  listingsToCsv,
  getHelpMessage,
  toEnglishSpec,
  isVillaTypology,
  isStudioTypology,
  COMPOUND_MAP,
  FINISHING_MAP,
  ORIENTATION_MAP,
  PROPERTY_TYPE_MAP
};
