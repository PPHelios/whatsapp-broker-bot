// lib/text.js
"use strict";

let bidiInstance = null;
try {
  const bidiFactory = require("bidi-js");
  bidiInstance = bidiFactory();
} catch (_) {}

let arabicReshaper = null;
try {
  arabicReshaper = require("arabic-persian-reshaper").ArabicShaper;
} catch (_) {}

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
  return String(rawCode)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "") // Invisible Unicode
    .replace(/^[`'"\[\(#\s_]+|[`'"\]\)#\s_]+$/g, "") // Outer punctuation & brackets
    .trim()
    .toUpperCase();
}

/**
 * Parses user input for explicit property codes with full boundary detection.
 */
function parseExplicitUnitCode(rawText) {
  if (!rawText) return { hasCode: false, code: null, cleanText: rawText };

  // 1. Strip invisible directional unicode characters first
  const sanitized = String(rawText)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "")
    .trim();

  const normalized = normalizeDigits(sanitized);

  // Check if the entire string is simply a wrapped code, e.g. [N4-105], `N4-105`, #KKJ654
  const standaloneClean = extractCleanCode(normalized);
  const validPattern = /^[A-Za-z0-9_\-\.\/]{2,30}$/;

  // Check regex for explicit prefixed markers: code:, كود:, #, `, [, etc.
  const codeRegex =
    /(?:^|\s)(?:#|`|\[|(?:code|كود|الكود)\s*[:=\-]?\s*)([A-Za-z0-9_\-\.\/`\]]+)(?:`|\]|\s|$)/i;
  const match = normalized.match(codeRegex);

  let rawCandidate = null;
  let matchedStr = "";

  if (match) {
    matchedStr = match[0];
    rawCandidate = extractCleanCode(match[1]);
  } else if (
    validPattern.test(standaloneClean) &&
    !/[\u0600-\u06FF]/.test(standaloneClean)
  ) {
    matchedStr = rawText;
    rawCandidate = standaloneClean;
  }

  if (!rawCandidate) {
    return { hasCode: false, code: null, cleanText: rawText };
  }

  // Reject candidates containing Arabic characters
  if (/[\u0600-\u06FF]/.test(rawCandidate)) {
    return {
      hasCode: true,
      invalidArabic: true,
      code: null,
      cleanText: rawText.replace(matchedStr, " ").trim()
    };
  }

  if (!validPattern.test(rawCandidate)) {
    return {
      hasCode: true,
      invalidFormat: true,
      code: null,
      cleanText: rawText.replace(matchedStr, " ").trim()
    };
  }

  const cleanText = rawText
    .replace(matchedStr, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    hasCode: true,
    code: rawCandidate.toUpperCase(),
    cleanText
  };
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
/* 4. Amenity & Feature Canonical Mapping                                 */
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
  جراج: "موقف سيارات",
  parking: "موقف سيارات",
  امن: "حراسة وأمن",
  أمن: "حراسة وأمن",
  security: "حراسة وأمن",
  "فيو مفتوح": "إطلالة مفتوحة",
  "open view": "إطلالة مفتوحة"
};

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

function parseEgyptianPrice(rawPriceText, options = {}) {
  const lang = options.lang || "ar";
  if (!rawPriceText) {
    return {
      priceValue: null,
      priceDisplay: lang === "en" ? "Upon Request" : "عند الطلب",
      currency: "EGP"
    };
  }

  const p = parseMoney(rawPriceText, {
    listingType: options.listingType || "sale"
  });
  if (!p) {
    return {
      priceValue: null,
      priceDisplay: lang === "en" ? "Upon Request" : "عند الطلب",
      currency: "EGP"
    };
  }

  return {
    priceValue: p.value,
    currency: p.currency,
    priceDisplay: formatAbbreviatedPrice(
      p.value,
      p.currency,
      lang,
      options.listingType
    )
  };
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
  const headerLine1 = `${actionPrefix} \vert{}${codeLabel} \`${safeCode}\``;

  const projectOrCompound =
    listing.compound ||
    listing.title ||
    (isEn ? "Prime Property" : "عقار مميز");
  const locationOrDistrict =
    listing.district || listing.location || (isEn ? "Egypt" : "مصر");
  const headerLine2 = `🏢 ${projectOrCompound} \vert{}${locationOrDistrict}`;

  return `${headerLine1}\n${headerLine2}`;
}

function formatClientListingText(listing, broker = {}, lang = "ar") {
  const isEn = lang === "en";
  const details = listing.details || {};
  const brokerName =
    broker.name || (isEn ? "Property Consultant" : "المستشار العقاري");
  const brokerPhone = broker.contact_phone || broker.phone || "";
  const features = Array.isArray(details.features) ? details.features : [];

  const header = formatStandardHeader(listing, lang);

  let bedDesc = listing.bedrooms
    ? `${listing.bedrooms}${isEn ? "Bedrooms" : "غرف نوم"}`
    : "-";
  const bedExtras = [];
  if (details.has_master_bedroom || details.master_bedrooms)
    bedExtras.push(isEn ? "Master" : "ماستر");
  if (details.has_dressing_room) bedExtras.push(isEn ? "Dressing" : "دريسنج");
  if (bedExtras.length) bedDesc += ` (${bedExtras.join(" + ")})`;

  let payment = `💰 *${isEn ? "Price:" : "السعر:"}* ${priceText(
    listing,
    isEn ? "en" : "ar"
  )}`;

  if (listing.payment_terms?.plans?.length) {
    payment += `\n💳 *${
      isEn ? "Payment Terms Available:" : "أنظمة السداد المتاحة:"
    }*`;
    listing.payment_terms.plans.slice(0, 3).forEach((plan) => {
      payment += `\n • ${plan.name || `${plan.years} سنين`}: مقدم ${
        plan.down_payment_pct
      }%`;
    });
  } else {
    if (details.down_payment_value || listing.down_payment_value) {
      const dp = details.down_payment_value || listing.down_payment_value;
      const downFormatted = formatAbbreviatedPrice(
        dp,
        details.currency || "EGP",
        isEn ? "en" : "ar"
      );
      payment += `\n💵 *${
        isEn ? "Down Payment:" : "المقدم:"
      }* ${downFormatted}`;
    }
    if (details.installment_years || listing.installment_years) {
      const yrs = details.installment_years || listing.installment_years;
      payment += `\n🗓️ *${isEn ? "Installments:" : "الأقساط:"}* ${yrs}${
        isEn ? "Years" : "سنوات"
      }`;
      if (details.installment_value || listing.installment_value) {
        const instVal = details.installment_value || listing.installment_value;
        const instFormatted = formatAbbreviatedPrice(
          instVal,
          details.currency || "EGP",
          isEn ? "en" : "ar"
        );
        payment += ` (${instFormatted} ربع سنوي)`;
      }
    }
  }

  const finishingDisplay = isEn
    ? details.finishing_en || details.finishing || listing.finishing_type
    : details.finishing || details.finishing_en || listing.finishing_type;

  const specs = [
    `📐 *${isEn ? "Area:" : "المساحة:"}* ${
      listing.area_value ? `${listing.area_value} ${isEn ? "sqm" : "م²"}` : "-"
    }`,
    details.floor
      ? `🏢 *${isEn ? "Floor:" : "الدور:"}* ${
          isEn ? details.floor_en || details.floor : details.floor
        }`
      : null,
    `🛏️ *${isEn ? "Bedrooms:" : "الغرف:"}* ${bedDesc}`,
    details.bathrooms
      ? `🛁 *${isEn ? "Bathrooms:" : "الحمامات:"}* ${details.bathrooms}`
      : null,
    finishingDisplay
      ? `🎨 *${isEn ? "Finishing:" : "التشطيب:"}* ${finishingDisplay}`
      : null,
    details.nanny_room
      ? `👩‍👧 *${isEn ? "Nanny Room:" : "غرفة ناني:"}* ${
          isEn ? "Available" : "متوفرة"
        }`
      : null
  ]
    .filter(Boolean)
    .join("\n");

  const cleanDesc = stripMarketingFluff(
    details.clean_summary || listing.raw_text
  );

  return [
    header,
    `─────────────────────────`,
    payment,
    specs,
    features.length
      ? `\n✨ *${isEn ? "Key Features:" : "المميزات:"}*\n${features
          .map((f) => `  ✓ ${f}`)
          .join("\n")}`
      : "",
    cleanDesc ? `\n📝 *${isEn ? "Overview:" : "الوصف:"}*\n${cleanDesc}` : "",
    `─────────────────────────`,
    `📞 *${isEn ? "For viewings & consultations:" : "للمعاينة والاستفسار:"}*`,
    `👤 *${brokerName}*`,
    `📱 *${isEn ? "WhatsApp:" : "واتساب:"}* ${brokerPhone}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatInternalListingDetails(listing, lang = "ar") {
  const isEn = lang === "en";
  const details = listing.details || {};
  const statusMap = {
    active: isEn ? "ACTIVE" : "نشط",
    sold: isEn ? "SOLD" : "تم البيع",
    archived: isEn ? "ARCHIVED" : "مؤرشف"
  };
  const status =
    statusMap[String(listing.status || "active").toLowerCase()] ||
    statusMap.active;
  const safeCode = extractCleanCode(listing.code);

  const lines = [
    formatStandardHeader(listing, lang),
    `─────────────────────────`,
    `• *${isEn ? "Internal Code:" : "الكود الداخلي:"}* \`${safeCode}\``,
    `• *${isEn ? "Type:" : "النوع:"}* ${listing.property_type || "-"} (${
      listing.listing_type === "rent"
        ? isEn
          ? "Rent"
          : "إيجار"
        : isEn
        ? "Sale"
        : "بيع"
    })`,
    `• *${isEn ? "Status:" : "الحالة:"}* ${status}`,
    `• *${isEn ? "Price:" : "السعر:"}* ${priceText(listing, lang)}`,
    `• *${isEn ? "Area:" : "المساحة:"}* ${
      listing.area_value ? `${listing.area_value}${isEn ? "sqm" : "م²"}` : "-"
    }`
  ];

  if (listing.collateral?.layout_pdf_url) {
    lines.push(
      `• *${isEn ? "Layout PDF:" : "رابط المخطط الهندسي:"}* ${
        listing.collateral.layout_pdf_url
      }`
    );
  }

  return lines.join("\n");
}

/* ====================================================================== */
/* 7. Search Results Presentation & Exports                               */
/* ====================================================================== */

function formatSearchResults(
  rows,
  {
    offset = 0,
    total = 0,
    lang = "ar",
    interpretation = "",
    relaxed = false
  } = {}
) {
  const en = lang === "en";
  const out = [
    en
      ? `🔍 Found ${total} matching unit(s)`
      : `🔍 تم العثور على ${total} وحدة مطابقة`
  ];

  if (relaxed) {
    out.push(
      en
        ? "ℹ️ Close matches — search range widened slightly."
        : "ℹ️ نتائج تقريبية — تم توسيع نطاق البحث قليلاً."
    );
  }
  if (interpretation) out.push(`🧭 ${interpretation}`);
  out.push("");

  rows.forEach((u, i) => {
    const title = String(u.title || u.compound || "").slice(0, 80);
    const det = u.details || {};
    const safeCode = extractCleanCode(u.code);
    const specs = [
      priceText(u, lang),
      `${u.area_value || "-"} ${en ? "sqm" : "م²"}`,
      `${u.bedrooms || "-"} ${en ? "Beds" : "غرف"}`,
      det.bathrooms ? `${det.bathrooms} ${en ? "Baths" : "حمام"}` : null,
      det.floor || null
    ]
      .filter(Boolean)
      .join(" | ");

    out.push(
      `*${offset + i + 1}. \`${safeCode}\`* - ${title}\n   💰 ${specs}\n   📍 ${
        u.location || "-"
      }\n`
    );
  });

  const more = offset + rows.length < total;
  out.push(
    more
      ? en
        ? "➡️ Send *more* for next results • Send `CODE` for details"
        : "➡️ أرسل *المزيد* لعرض باقي الوحدات • أرسل `الكود` للتفاصيل"
      : en
      ? "Send `CODE` for full property details"
      : "أرسل `الكود` لعرض تفاصيل الوحدة كاملة"
  );
  return out.join("\n");
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
    "العملة / Currency",
    "المساحة / Area (sqm)",
    "الدور / Floor",
    "غرف النوم / Bedrooms",
    "الحمامات / Bathrooms",
    "التشطيب / Finishing",
    "المميزات / Amenities",
    "الكمبوند / Compound",
    "الموقع الكامل / Location",
    "الحالة / Status",
    "تاريخ التسجيل / Created At"
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
    const dateStr = r.created_at
      ? new Date(r.created_at).toISOString().slice(0, 10)
      : "";

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
      esc(det.currency || "EGP"),
      esc(r.area_value || "-"),
      esc(det.floor || "-"),
      esc(r.bedrooms || "-"),
      esc(det.bathrooms || "-"),
      esc(det.finishing || "-"),
      esc(features || "-"),
      esc(r.compound || "-"),
      esc(r.location || "-"),
      esc(STATUS_MAP[String(r.status).toLowerCase()] || r.status),
      esc(dateStr)
    ];

    lines.push(row.join(","));
  }

  return "\uFEFF" + lines.join("\r\n");
}

/* ====================================================================== */
/* 8. Arabic Reshaping & BiDi for Satori Vector Engine                    */
/* ====================================================================== */

function formatArabicForSatori(text) {
  if (!text || !/[\u0600-\u06FF]/.test(text)) return text;

  try {
    let output = text;
    if (arabicReshaper && typeof arabicReshaper.convertArabic === "function") {
      output = arabicReshaper.convertArabic(output);
    }
    if (bidiInstance && typeof bidiInstance.getEmbeddingLevels === "function") {
      const embeddingLevels = bidiInstance.getEmbeddingLevels(output);
      output = bidiInstance.getReorderedString(output, embeddingLevels);
    }
    return output;
  } catch (_) {
    return text;
  }
}

/* ====================================================================== */
/* 9. Help Message Presentation                                           */
/* ====================================================================== */

function getHelpMessage(lang = "ar") {
  if (lang === "en") {
    return `*🏢 Real Estate Assistant - Master Guide*

*➕ Add New Listing:*
• Type *add* or *new* to start a blank draft.
• Or send property photos followed by a voice note/text with specifications.
• *Code Rule:* Send the code clearly (e.g. \`HAS101\` or *#HAS101*).
• Tap *Save* or type *done* when finished.

*🔍 Search Inventory:*
• Text or voice search:
  _e.g., "Apartment in New Cairo 2 beds under 6M"_
  _e.g., "NOLL 105m installments"_
• Results return in batches with interactive action buttons.

*🎯 Instant Code Lookup:*
• Send \`CODE\` or *#CODE* (e.g., \`N4-105\` or \`KKJ654\`).

*✏️ Edit Listing Details:*
• Tap *[ ✏️ Edit ]* on any card to update details.

*📊 Tools & Settings:*
• *stats* → Live agency inventory metrics
• *excel* → Export complete inventory spreadsheet
• *lang ar* | *lang en* → Switch assistant language`;
  }

  return `*🏢 دليل استخدام المساعد العقاري المعتمد*

*➕ إضافة وحدة جديدة:*
• اكتب *اضافة* أو *add* لبدء مسودة فارغة.
• أو أرسل صور العقار متبوعة بفويس نوت أو رسالة بالمواصفات.
• *قاعدة الكود:* يُكتب الكود نصياً (مثل: \`HAS101\` أو *#HAS101*).
• اكتب *تم* أو اضغط *حفظ* عند الانتهاء.

*🔍 البحث في المعروض:*
• اكتب أو سجل صوتياً بمواصفات طلبك:
  _مثال: "شقة في التجمع غرفتين بحدود 5 مليون"_
  _مثال: "أنظمة سداد مشروع NOLL"_
• تُعرض النتائج ككروت مستقلة بأزرار تفاعلية فورية.

*🎯 فحص كود محدد مباشرة:*
• اكتب الكود مباشرة (مثال: \`N4-105\` أو \`KKJ654\`).

*✏️ تعديل بيانات وحدة:*
• اضغط زر *[ ✏️ تعديل ]* للدخول في وضع التعديل السريع.

*📊 الأدوات والتقارير:*
• *تقرير* أو *stats* ← تقرير فوري بحالة المعروض والمباع
• *اكسل* أو *excel* ← تصدير شيت إكسيل لكافة الوحدات
• *عربي* | *english* ← تبديل لغة المساعد`;
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
  formatAbbreviatedPrice,
  parseEgyptianPrice,
  parsePrice,
  formatPrice,
  priceText,
  formatStandardHeader,
  formatClientListingText,
  formatInternalListingDetails,
  formatSearchResults,
  listingsToCsv,
  formatArabicForSatori,
  getHelpMessage
};
