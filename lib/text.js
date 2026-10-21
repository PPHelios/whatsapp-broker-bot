// lib/text.js
"use strict";

/* ------------------------------------------------------------------ */
/* Arabic normalization (MUST mirror normalize_arabic() in SQL)       */
/* ------------------------------------------------------------------ */
function normalizeAr(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0])
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[.,،;:!?؟()"/|+*_=<>@#%^&~`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Feature / Amenity Canonical Mapping                                */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* Money, Currency & Abbreviation Formatting                          */
/* ------------------------------------------------------------------ */
function detectCurrency(text) {
  if (!text) return "EGP";
  const s = String(text).toLowerCase();
  if (/(\$|usd|dollar|دولار)/i.test(s)) return "USD";
  if (/(€|eur|euro|يورو)/i.test(s)) return "EUR";
  return "EGP";
}

function normalizePriceInput(str) {
  if (!str) return "";
  let s = String(str)
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0])
    .replace(/٫/g, ".")
    .replace(/،/g, ",");

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

/**
 * Formats numeric prices into compact broker badges (e.g. "10M EGP", "40K EGP / mo", "10 مليون ج.م")
 */
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

  // English formatting
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
    priceDisplay: formatAbbreviatedPrice(p.value, p.currency, lang)
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
    let p = formatAbbreviatedPrice(listing.price_value, currency, lang);
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

/* ------------------------------------------------------------------ */
/* Client & Internal Property Presentations                           */
/* ------------------------------------------------------------------ */
function formatClientListingText(listing, broker = {}, lang = "ar") {
  const isEn = lang === "en";
  const details = listing.details || {};
  const brokerName =
    broker.name || (isEn ? "Real Estate Consultant" : "المستشار العقاري");
  const brokerPhone = broker.contact_phone || broker.phone || "";
  const features = Array.isArray(details.features) ? details.features : [];

  // Bedrooms breakdown
  let bedDesc = listing.bedrooms
    ? `${listing.bedrooms} ${isEn ? "Bedrooms" : "غرف نوم"}`
    : "-";
  const bedExtras = [];
  if (details.has_master_bedroom || details.master_bedrooms)
    bedExtras.push(isEn ? "Master" : "ماستر");
  if (details.has_dressing_room) bedExtras.push(isEn ? "Dressing" : "دريسنج");
  if (bedExtras.length) bedDesc += ` (${bedExtras.join(" + ")})`;

  // Financial breakdown
  let payment = `💰 *${isEn ? "Price:" : "السعر:"}* ${priceText(
    listing,
    isEn ? "en" : "ar"
  )}`;
  if (details.down_payment_value) {
    const downFormatted = formatAbbreviatedPrice(
      details.down_payment_value,
      details.currency || "EGP",
      isEn ? "en" : "ar"
    );
    payment += `\n💵 *${isEn ? "Down Payment:" : "المقدم:"}* ${downFormatted}`;
  }
  if (details.installment_years) {
    payment += `\n🗓️ *${isEn ? "Installments:" : "الأقساط:"}* ${
      details.installment_years
    } ${isEn ? "Years" : "سنوات"}`;
    if (details.installment_amount) {
      const instFormatted = formatAbbreviatedPrice(
        details.installment_amount,
        details.currency || "EGP",
        isEn ? "en" : "ar"
      );
      payment += ` (${
        details.installment_frequency || (isEn ? "Equal" : "أقساط")
      } ${instFormatted})`;
    }
  }

  // Finishing type
  const finishingDisplay = isEn
    ? details.finishing_en || details.finishing
    : details.finishing || details.finishing_en;

  const specs = [
    `📐 *${isEn ? "Area:" : "المساحة:"}* ${
      listing.area_value ? `${listing.area_value}${isEn ? "sqm" : "م²"}` : "-"
    }`,
    details.floor
      ? `🏢 *${isEn ? "Floor:" : "الدور:"}* ${
          isEn ? details.floor_en || details.floor : details.floor
        }`
      : null,
    `🛏️ *${isEn ? "Bedrooms:" : "الغرف:"}* ${bedDesc}`,
    details.bathrooms
      ? `🛁 *${isEn ? "Bathrooms:" : "الحمامات:"}* ${details.bathrooms} ${
          isEn ? "Baths" : "حمام"
        }`
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

  return [
    `🏡 *${
      isEn
        ? "Featured Property | Code: #" + listing.code
        : "عرض عقاري مميز | كود: #" + listing.code
    }*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📌 *${isEn ? "Unit:" : "الوحدة:"}* ${
      listing.title || (isEn ? "Residential Unit" : "وحدة سكنية")
    }`,
    `📍 *${isEn ? "Location:" : "الموقع:"}* ${listing.location || "-"}`,
    payment,
    specs,
    features.length
      ? `\n✨ *${isEn ? "Key Features:" : "أبرز المميزات:"}*\n${features
          .map((f) => `  ✓ ${f}`)
          .join("\n")}`
      : "",
    details.clean_summary
      ? `\n📝 *${isEn ? "Details:" : "الوصف:"}*\n${details.clean_summary}`
      : "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `📞 *${isEn ? "For inquiries and viewings:" : "للتواصل والمعاينة:"}*`,
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

  let bedStr = listing.bedrooms ? `${listing.bedrooms}` : "-";
  const extras = [];
  if (details.has_master_bedroom) extras.push(isEn ? "Master" : "ماستر");
  if (details.has_dressing_room) extras.push(isEn ? "Dressing" : "دريسنج");
  if (extras.length) bedStr += ` (${extras.join(" + ")})`;

  const finishingDisplay = isEn
    ? details.finishing_en || details.finishing
    : details.finishing || details.finishing_en;

  const lines = [
    `📑 *${
      isEn
        ? "INTERNAL LISTING SPECIFICATIONS"
        : "المواصفات والبيانات الداخلية للوحدة"
    }*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `• *${isEn ? "Code:" : "كود الوحدة:"}* #${listing.code}`,
    `• *${isEn ? "Title:" : "العنوان:"}* ${listing.title || "-"}`,
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
    }`,
    details.floor
      ? `• *${isEn ? "Floor:" : "الدور:"}* ${
          isEn ? details.floor_en || details.floor : details.floor
        }`
      : null,
    `• *${isEn ? "Bedrooms:" : "غرف النوم:"}* ${bedStr}`,
    details.bathrooms
      ? `• *${isEn ? "Bathrooms:" : "الحمامات:"}* ${details.bathrooms}`
      : null,
    finishingDisplay
      ? `• *${isEn ? "Finishing:" : "التشطيب:"}* ${finishingDisplay}`
      : null,
    details.nanny_room
      ? `• *${isEn ? "Nanny Room:" : "غرفة ناني:"}* ${isEn ? "Yes" : "نعم"}`
      : null,
    `• *${isEn ? "Location:" : "الموقع:"}* ${listing.location || "-"}`,
    `• *${isEn ? "Compound:" : "الكمبوند:"}* ${listing.compound || "-"}`
  ].filter(Boolean);

  if (details.down_payment_value) {
    lines.push(
      `• *${isEn ? "Down Payment:" : "المقدم:"}* ${formatAbbreviatedPrice(
        details.down_payment_value,
        details.currency || "EGP",
        lang
      )}`
    );
  }
  if (details.installment_years) {
    lines.push(
      `• *${isEn ? "Installment Duration:" : "سنوات التقسيط:"}* ${
        details.installment_years
      } ${isEn ? "Years" : "سنوات"}`
    );
  }
  if (details.clean_summary) {
    lines.push(
      `\n📝 *${isEn ? "Internal Summary:" : "الوصف الداخلي:"}*\n_${
        details.clean_summary
      }_`
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Search Results Presentation                                        */
/* ------------------------------------------------------------------ */
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
    const title = String(u.title || "").slice(0, 80);
    const det = u.details || {};
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
      `*${offset + i + 1}. #${u.code}* - ${title}\n   💰 ${specs}\n   📍 ${
        u.location || "-"
      }\n`
    );
  });

  const more = offset + rows.length < total;
  out.push(
    more
      ? en
        ? "➡️ Send *more* for next results • Send `#CODE` for details"
        : "➡️ أرسل *المزيد* لعرض باقي الوحدات • أرسل `#الكود` للتفاصيل"
      : en
      ? "Send `#CODE` for full property details"
      : "أرسل `#الكود` لعرض تفاصيل الوحدة كاملة"
  );
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Clean Executive CSV/Excel Export                                   */
/* ------------------------------------------------------------------ */
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
    "غرفة ماستر / Master Bed",
    "دريسنج / Dressing Room",
    "غرفة ناني / Nanny Room",
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
      esc(r.code),
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
      esc(det.has_master_bedroom ? "نعم / Yes" : "لا / No"),
      esc(det.has_dressing_room ? "نعم / Yes" : "لا / No"),
      esc(det.nanny_room ? "نعم / Yes" : "لا / No"),
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

/* ------------------------------------------------------------------ */
/* Comprehensive Help Menu                                            */
/* ------------------------------------------------------------------ */
function getHelpMessage(lang = "ar") {
  if (lang === "en") {
    return `*🏢 Real Estate Assistant - Master Guide*

*➕ Add New Listing:*
• Type *add* or *new* to start a blank draft.
• Or send property photos followed by a voice note/text with specifications.
• *Code Rule:* Send the code on a separate line or message (e.g. *code: HAS101* or *#HAS101*). Voice codes are strictly ignored to avoid transcription errors.
• Tap *Save* or type *done* when finished.

*🔍 Search Inventory:*
• Send your request via text or voice:
  _e.g., "Apartment in Hyde Park 3 beds with dressing under 12M"_
  _e.g., "Villa for rent in Zayed monthly"_
• Results stream in 5-unit batches with interactive buttons.
• Send *more* or tap *View More* to load the next 5 units.

*🎯 Instant Code Lookup:*
• Send *#CODE* or *code CODE* (e.g., *#HAS101* or *code HAS101*).

*✏️ Edit Listing Details:*
• Tap *[ ✏️ Edit ]* on any card to enter Edit Mode, then send only the updates (text or voice).
• Or type: *edit #CODE* followed by changes on a new line.

*🏷️ Change Listing Status:*
• *sold #CODE* → Mark as Sold
• *active #CODE* → Re-activate listing
• *archive #CODE* → Archive listing

*🗑️ Delete Listing:*
• *delete #CODE* → Permanently deletes listing, media, and brochure files (requires confirmation).

*📊 Tools & Settings:*
• *stats* → Live agency inventory metrics
• *excel* → Export complete inventory spreadsheet
• *lang ar* | *lang en* → Switch assistant language`;
  }

  return `*🏢 دليل استخدام المساعد العقاري المعتمد*

*➕ إضافة وحدة جديدة:*
• اكتب *اضافة* أو *add* لبدء مسودة فارغة.
• أو أرسل صور العقار متبوعة بفويس نوت أو رسالة بالمواصفات.
• *قاعدة الكود:* يُكتب الكود نصياً في رسالة أو سطر مستقل (مثل: *كود HAS101* أو *#HAS101*). لا تُقبل الأكواد الصوتية نهائياً منعاً لأخطاء الترجمة.
• اكتب *تم* أو اضغط *حفظ* عند الانتهاء.

*🔍 البحث في المعروض:*
• اكتب أو سجل صوتياً بمواصفات طلبك:
  _مثال: "شقة في هايد بارك 3 غرف دريسنج وماستر تحت 12 مليون"_
  _مثال: "فيلا للإيجار في زايد شهري"_
• تُعرض النتائج ككروت مستقلة (5 وحدات لكل دفعة) بأزرارها المباشرة.
• اكتب *المزيد* أو اضغط *عرض المزيد* لجلب الـ 5 وحدات التالية.

*🎯 فحص كود محدد مباشرة:*
• اكتب *#الكود* أو *كود الكود* (مثال: *#HAS101* أو *كود HAS101*).

*✏️ تعديل بيانات وحدة:*
• اضغط زر *[ ✏️ تعديل ]* للدخول في وضع التعديل، ثم أرسل التعديل فقط (صوت أو كتابة).
• أو اكتب: *تعديل #الكود* واذكر التعديلات في سطر مستقل.

*🏷️ تغيير حالة الوحدة:*
• *مباع #الكود* ← تحويل الوحدة لمباعة
• *متاح #الكود* أو *نشط #الكود* ← إعادة تفعيل الوحدة
• *أرشيف #الكود* ← أرشفة الوحدة

*🗑️ حذف وحدة نهائياً:*
• *حذف #الكود* ← مسح الوحدة وجميع صورها وبروشوراتها بالكامل مع رسالة تأكيد.

*📊 الأدوات والتقارير:*
• *تقرير* أو *stats* ← تقرير فوري بحالة المعروض والمباع
• *اكسل* أو *excel* ← تصدير شيت إكسيل لكافة الوحدات
• *عربي* | *english* ← تبديل لغة المساعد`;
}

module.exports = {
  normalizeAr,
  cleanFeaturesList,
  detectCurrency,
  formatAbbreviatedPrice,
  parseEgyptianPrice,
  parsePrice,
  formatPrice,
  priceText,
  formatClientListingText,
  formatInternalListingDetails,
  formatSearchResults,
  listingsToCsv,
  getHelpMessage
};
