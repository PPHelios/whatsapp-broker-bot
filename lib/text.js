// lib/text.js
"use strict";

/* ------------------------------------------------------------------ */
/* Arabic normalization (MUST mirror normalize_arabic() in the SQL)    */
/* ------------------------------------------------------------------ */
function normalizeAr(input) {
  return String(input ?? "")
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
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
// In lib/text.js

const FEATURE_CANONICAL_MAP = {
  // Swimming pool variations
  بول: "حمام سباحة",
  البول: "حمام سباحة",
  "سويمينج بول": "حمام سباحة",
  "سويمينغ بول": "حمام سباحة",
  "private pool": "حمام سباحة خاص",
  pool: "حمام سباحة",
  "swimming pool": "حمام سباحة",

  // Garden / Landscape
  جاردن: "حديقة",
  حديقه: "حديقة",
  "private garden": "حديقة خاصة",
  garden: "حديقة",

  // Balcony / Terrace
  بلكونة: "شرفة",
  بلكونه: "شرفة",
  تراس: "تراس",
  balcony: "شرفة",
  terrace: "تراس",

  // Maid / Nanny room
  "غرفة دادة": "غرفة مربية",
  "غرفة داده": "غرفة مربية",
  "غرفة شغالة": "غرفة مربية",
  "غرفة شغاله": "غرفة مربية",
  "غرفة خادمة": "غرفة خادمة",
  "غرفه خادمه": "غرفة خادمة",
  "maid room": "غرفة خادمة",
  "maids room": "غرفة خادمة",
  "nanny room": "غرفة مربية",

  // Kitchen / Appliances
  مطبخ: "مطبخ",
  "مطبخ مجهز": "مطبخ مجهز",
  "open kitchen": "مطبخ مفتوح",
  "american kitchen": "مطبخ أمريكي",

  // Elevator
  اسانسير: "مصعد",
  أسانسير: "مصعد",
  elevator: "مصعد",
  lift: "مصعد",

  // Parking / Garage
  جراج: "موقف سيارات",
  كراج: "موقف سيارات",
  باركنج: "موقف سيارات",
  parking: "موقف سيارات",
  garage: "موقف سيارات",

  // Security / View
  امن: "حراسة وأمن",
  أمن: "حراسة وأمن",
  security: "حراسة وأمن",
  "فيو مفتوح": "إطلالة مفتوحة",
  "open view": "إطلالة مفتوحة",
  "sea view": "إطلالة على البحر",
  "lake view": "إطلالة على البحيرة"
};

/**
 * Sanitizes and normalizes an array of listing features/amenities.
 * @param {string[]} features - Raw list of features extracted by AI
 * @returns {string[]} Deduplicated, sanitized feature list
 */
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

    // Normalize spacing and Arabic characters
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
/* Help & Command Catalog                                              */
/* ------------------------------------------------------------------ */

function getHelpMessage(lang = "ar") {
  if (lang === "en") {
    return `*🤖 Broker Assistant - Commands Guide*

*📥 Adding Listings:*
• Send text, voice notes, or photos (together or in sequence).
• Type *done* or *go* to start processing immediately.

*⚡ Context Shortcuts (No Code Needed):*
_Commands apply automatically to the unit you just added, searched, or tapped:_
• *flyer* → Verified dark brochure
• *flyer light* → Light-themed brochure
• *client* → Marketing copy ready to forward to clients
• *price 18.5M* → Update asking price
• *sold* → Mark active unit as SOLD
• *archive* → Move active unit to archive

*🎯 Specific Unit Commands:*
• *flyer #CODE* or *flyer light #CODE*
• *client #CODE*
• *price #CODE to 19M*
• *sold #CODE* | *archive #CODE* | *activate #CODE*
• *delete #CODE* (Permanent wipe)

*🔍 Inventory Search:*
• Search in natural language (text or voice):
  _e.g., "Apartment in Mivida 3 bedrooms under 18M"_
• Tap *View Units* on the interactive list to inspect specs.
• Type *more* to view next search results page.

*📊 Tools & Settings:*
• *stats* → View total active, sold, and archived inventory
• *excel* or *csv* → Export complete inventory spreadsheet
• *lang ar* | *lang en* → Switch assistant language`;
  }

  return `*🤖 دليل أوامر المساعد العقاري الذكي*

*📥 إضافة وتحديث الوحدات:*
• أرسل التفاصيل (نص، تسجيل صوتي، أو صور) دفعة واحدة أو متتالية.
• اكتب *تم* للبدء في الحفظ فوراً دون انتظار المؤقت.

*⚡ أوامر سريعة (بدون كتابة الكود):*
_تُطبق تلقائياً على آخر وحدة قمت بإضافتها، فحصها، أو البحث عنها:_
• *كتالوج* ← بروشور معتمد (Dark)
• *كتالوج فاتح* ← بروشور معتمد (Light)
• *عميل* ← صيغة تسويقية جاهزة للإرسال للزبائن
• *سعر 18.5 مليون* ← تحديث السعر مباشرة
• *مباع* ← تحويل الوحدة لحالة تم البيع
• *أرشيف* ← أرشفة الوحدة

*🎯 أوامر برقم الكود:*
• *كتالوج #الكود* أو *كتالوج فاتح #الكود*
• *عميل #الكود*
• *سعر #الكود إلى 19 مليون*
• *مباع #الكود* | *أرشيف #الكود* | *تنشيط #الكود*
• *حذف #الكود* (حذف نهائي للوحدة وصورها)

*🔍 البحث في المخزون:*
• اكتب أو سجل صوتياً بمواصفات طلبك:
  _مثال: "شقة في ميفيدا 3 غرف تحت 18 مليون"_
• اضغط *عرض الوحدات* من القائمة التفاعلية لعرض المواصفات والأزرار.
• اكتب *المزيد* لعرض باقي نتائج البحث.

*📊 الأدوات والإعدادات:*
• *إحصائيات* ← تقرير سريع بحالة المخزون
• *اكسل* أو *csv* ← تصدير كامل قاعدة البيانات في شيت إكسل
• *عربي* | *english* ← تغيير لغة الردود والتأكيدات`;
}

/* ------------------------------------------------------------------ */
/* Money & Price Formatting                                            */
/* ------------------------------------------------------------------ */
function normalizePriceInput(str) {
  if (!str) return "";
  let s = String(str)
    // 1. Convert Eastern Arabic digits (٠-٩) and Persian digits (۰-۹)
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0])
    .replace(/٫/g, ".")
    .replace(/،/g, ",");

  // 2. Post-fixed fractions: "6 مليون ونص", "6 مليون ونصف" -> "6.5 مليون"
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
    /(\d+(?:\.\d+)?)\s*(?:مليون|m)\s*و\s*(\d{1,3})\s*(?:الف|ألف|k)/gi,
    (_, m, k) => `${parseFloat(m) + parseFloat(k) / 1000} مليون`
  );

  // 3. Pre-fixed fractions: "6 ونص مليون", "6 ونصف مليون" -> "6.5 مليون"
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:و\s*)?(?:نص|نصف)\s*(?:مليون|m)/gi,
    "$1.5 مليون"
  );
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:و\s*)?ربع\s*(?:مليون|m)/gi,
    "$1.25 مليون"
  );
  s = s.replace(
    /(\d+(?:\.\d+)?)\s*(?:و\s*)?(?:تلت|ثلث)\s*(?:مليون|m)/gi,
    "$1.33 مليون"
  );

  // 4. Standalone fractions with million: "نص مليون" -> "0.5 مليون"
  s = s.replace(/(?:^|\s)(?:نص|نصف)\s*(?:مليون|m)/gi, " 0.5 مليون");
  s = s.replace(/(?:^|\s)ربع\s*(?:مليون|m)/gi, " 0.25 مليون");

  // 5. Fractions without explicit units: "6 ونص" -> "6.5"
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:و\s*)?(?:نص|نصف)/g, "$1.5");
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:و\s*)?ربع/g, "$1.25");
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:و\s*)?(?:تلت|ثلث)/g, "$1.33");
  s = s.replace(/(?:^|\s)(?:نص|نصف)(?=$|\s)/g, " 0.5");
  s = s.replace(/(?:^|\s)ربع(?=$|\s)/g, " 0.25");

  // 6. Standalone words ONLY when NOT preceded by digits (prevents "7 مليون" -> "71 مليون")
  s = s
    .replace(/(?<![\d.]\s*)مليونين(?=[\s,،]|$)/g, "2 مليون")
    .replace(/(?<![\d.]\s*)مليون(?=[\s,،]|$)/g, "1 مليون")
    .replace(/(?<![\d.]\s*)(?:ألفين|الفين)(?=[\s,،]|$)/g, "2 الف");

  return s.trim();
}

function parseMoney(raw, { listingType = "sale" } = {}) {
  if (raw === null || raw === undefined || raw === "") return null;
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
  return {
    value: val,
    hadUnit,
    bare: !hadUnit && val !== Math.round(parseFloat(m[1]))
  };
}

function parseEgyptianPrice(rawPriceText, options = {}) {
  const lang = options.lang || "ar";
  const fallbackDisplay = lang === "en" ? "Upon Request" : "عند الطلب";
  const currency = lang === "en" ? "EGP" : "ج.م";
  if (!rawPriceText) return { priceValue: null, priceDisplay: fallbackDisplay };

  const p = parseMoney(rawPriceText, {
    listingType: options.listingType || "sale"
  });
  if (!p) return { priceValue: null, priceDisplay: fallbackDisplay };
  return {
    priceValue: p.value,
    priceDisplay: `${p.value.toLocaleString("en-US")} ${currency}`
  };
}

function parsePrice(raw, { implicitUnits = false, listingType = "sale" } = {}) {
  const p = parseMoney(raw, { listingType });
  if (!p) return null;
  if (!implicitUnits && !p.hadUnit && p.bare) return null;
  return p.value;
}

function formatPrice(n, lang = "ar") {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const en = lang === "en";
  if (v >= 1e6) return `${+(v / 1e6).toFixed(2)} ${en ? "M" : "مليون"}`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)} ${en ? "K" : "ألف"}`;
  return String(v.toLocaleString("en-US"));
}

function priceText(listing, lang) {
  if (listing.price_value) {
    return `${Number(listing.price_value).toLocaleString("en-US")} ${
      lang === "en" ? "EGP" : "ج.م"
    }`;
  }
  return (
    listing.price_display || (lang === "en" ? "Upon Request" : "عند الطلب")
  );
}

/* ------------------------------------------------------------------ */
/* Localization Overlay                                               */
/* ------------------------------------------------------------------ */
function localizeListing(listing, lang) {
  const d = listing.details || {};
  const base = d.lang || "ar";
  if (!lang || lang === base) return listing;
  const alt = d.i18n && d.i18n[lang];
  if (!alt) return listing;
  return {
    ...listing,
    title: alt.title || listing.title,
    location: alt.location || listing.location,
    details: {
      ...d,
      clean_summary: alt.clean_summary || d.clean_summary,
      features:
        Array.isArray(alt.features) && alt.features.length
          ? alt.features
          : d.features
    }
  };
}

/* ------------------------------------------------------------------ */
/* Client & Internal Text Presentation                                */
/* ------------------------------------------------------------------ */
function formatClientListingText(rawListing, broker = {}, lang = "ar") {
  const isEn = lang === "en";
  const listing = localizeListing(rawListing, lang);
  const details = listing.details || {};
  const brokerName =
    broker.name || (isEn ? "Real Estate Consultant" : "المستشار العقاري");
  const brokerPhone = broker.contact_phone || broker.phone || "";
  const installmentYears = details.installment_years || null;
  const features = Array.isArray(details.features) ? details.features : [];

  if (isEn) {
    let payment = `💰 *Price:* ${priceText(listing, "en")}`;
    if (details.down_payment_value)
      payment += `\n💵 *Down Payment:* ${Number(
        details.down_payment_value
      ).toLocaleString("en-US")} EGP`;
    if (installmentYears)
      payment += `\n🗓️ *Installments:* Over ${installmentYears} years`;

    const specs = [
      `📐 *Area:* ${listing.area_value ? `${listing.area_value} sqm` : "-"}`,
      details.floor ? `🏢 *Floor:* ${details.floor}` : null,
      `🛏️ *Bedrooms:* ${listing.bedrooms ? `${listing.bedrooms} Beds` : "-"}`,
      details.bathrooms ? `🛁 *Bathrooms:* ${details.bathrooms} Baths` : null,
      details.nanny_room ? `👩‍👧 *Maid's Room:* Available` : null,
      details.finishing ? `🎨 *Finishing:* ${details.finishing}` : null
    ]
      .filter(Boolean)
      .join("\n");

    return [
      `🏡 *Featured Property | Code: #${listing.code}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `📌 *Unit:* ${listing.title || "Residential Property"}`,
      `📍 *Location:* ${listing.location || "-"}`,
      payment,
      specs,
      features.length
        ? `\n✨ *Key Features:*\n${features.map((f) => `  ✓ ${f}`).join("\n")}`
        : "",
      details.clean_summary
        ? `\n📝 *Description:*\n${details.clean_summary}`
        : "",
      `━━━━━━━━━━━━━━━━━━━━`,
      `📞 *For inquiries and viewings:*`,
      `👤 *${brokerName}*`,
      `📱 *Phone / WhatsApp:* ${brokerPhone}`
    ]
      .filter(Boolean)
      .join("\n");
  }

  let payment = `💰 *السعر:* ${priceText(listing, "ar")}`;
  if (details.down_payment_value)
    payment += `\n💵 *المقدم:* ${Number(
      details.down_payment_value
    ).toLocaleString("en-US")} ج.م`;
  if (installmentYears)
    payment += `\n🗓️ *الأقساط:* على ${installmentYears} سنوات`;

  const specs = [
    `📐 *المساحة:* ${listing.area_value ? `${listing.area_value} م²` : "-"}`,
    details.floor ? `🏢 *الدور:* ${details.floor}` : null,
    `🛏️ *الغرف:* ${listing.bedrooms ? `${listing.bedrooms} غرف نوم` : "-"}`,
    details.bathrooms ? `🛁 *الحمامات:* ${details.bathrooms} حمام` : null,
    details.nanny_room ? `👩‍👧 *غرفة ناني:* متوفرة` : null,
    details.finishing ? `🎨 *التشطيب:* ${details.finishing}` : null
  ]
    .filter(Boolean)
    .join("\n");

  return [
    `🏡 *عرض عقاري مميز | كود: #${listing.code}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📌 *الوحدة:* ${listing.title || "وحدة سكنية معروضة"}`,
    `📍 *الموقع:* ${listing.location || "-"}`,
    payment,
    specs,
    features.length
      ? `\n✨ *أبرز المميزات:*\n${features.map((f) => `  ✓ ${f}`).join("\n")}`
      : "",
    details.clean_summary
      ? `\n📝 *الوصف والتفاصيل:*\n${details.clean_summary}`
      : "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `📞 *للتواصل ومزيد من التفاصيل والمعاينة:*`,
    `👤 *${brokerName}*`,
    `📱 *هاتف / واتساب:* ${brokerPhone}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatInternalListingDetails(listing, lang = "ar") {
  const details = listing.details || {};
  const isEn = lang === "en";
  const statusMap = {
    active: isEn ? "ACTIVE" : "نشط",
    sold: isEn ? "SOLD" : "تم البيع",
    archived: isEn ? "ARCHIVED" : "مؤرشف"
  };
  const status =
    statusMap[String(listing.status || "active").toLowerCase()] ||
    statusMap.active;
  const years = details.installment_years;
  const down = details.down_payment_value
    ? Number(details.down_payment_value).toLocaleString("en-US")
    : null;

  if (isEn) {
    const lines = [
      `📑 *INTERNAL LISTING SPECIFICATIONS*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `• *Unit Code:* #${listing.code}`,
      `• *Title:* ${listing.title || "-"}`,
      `• *Type:* ${listing.property_type || "-"} (${
        listing.listing_type === "rent" ? "Rent" : "Sale"
      })`,
      `• *Status:* ${status}`,
      `• *Asking Price:* ${priceText(listing, "en")}`,
      `• *Area:* ${listing.area_value ? `${listing.area_value} sqm` : "-"}`,
      details.floor ? `• *Floor:* ${details.floor}` : null,
      `• *Bedrooms:* ${listing.bedrooms || "-"}`,
      details.bathrooms ? `• *Bathrooms:* ${details.bathrooms}` : null,
      details.nanny_room ? `• *Maid's Room:* Yes` : null,
      details.finishing ? `• *Finishing:* ${details.finishing}` : null,
      `• *Location:* ${listing.location || "-"}`,
      `• *Compound:* ${listing.compound || "-"}`
    ].filter(Boolean);

    if (down) lines.push(`• *Down Payment:* ${down} EGP`);
    if (years) lines.push(`• *Installment Duration:* ${years} Years`);
    if (details.clean_summary)
      lines.push(`\n📝 *Summary:*\n_${details.clean_summary}_`);
    return lines.join("\n");
  }

  const lines = [
    `📑 *المواصفات والبيانات الداخلية للوحدة*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `• *كود الوحدة:* #${listing.code}`,
    `• *العنوان:* ${listing.title || "-"}`,
    `• *النوع:* ${listing.property_type || "-"} (${
      listing.listing_type === "rent" ? "إيجار" : "بيع"
    })`,
    `• *الحالة:* ${status}`,
    `• *السعر:* ${priceText(listing, "ar")}`,
    `• *المساحة:* ${listing.area_value ? `${listing.area_value} م²` : "-"}`,
    details.floor ? `• *الدور:* ${details.floor}` : null,
    `• *غرف النوم:* ${listing.bedrooms || "-"}`,
    details.bathrooms ? `• *الحمامات:* ${details.bathrooms}` : null,
    details.nanny_room ? `• *غرفة ناني:* نعم` : null,
    details.finishing ? `• *التشطيب:* ${details.finishing}` : null,
    `• *الموقع:* ${listing.location || "-"}`,
    `• *الكمبوند:* ${listing.compound || "-"}`
  ].filter(Boolean);

  if (down) lines.push(`• *المقدم:* ${down} ج.م`);
  if (years) lines.push(`• *سنوات التقسيط:* ${years} سنوات`);
  if (details.clean_summary)
    lines.push(`\n📝 *الوصف الداخلي:*\n_${details.clean_summary}_`);
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
  if (relaxed)
    out.push(
      en
        ? "ℹ️ Close matches — search range widened slightly."
        : "ℹ️ نتائج تقريبية — تم توسيع نطاق البحث قليلاً."
    );
  if (interpretation) out.push(`🧭 ${interpretation}`);
  out.push("");

  rows.forEach((u, i) => {
    const title = String(u.title || "").slice(0, 80);
    const det = u.details || {};
    const specs = [
      u.price_display || "-",
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
    "السعر / Price (EGP)",
    "المساحة / Area (sqm)",
    "الدور / Floor",
    "غرف النوم / Bedrooms",
    "الحمامات / Bathrooms",
    "غرفة ناني / Maid Room",
    "التشطيب والمميزات / Amenities",
    "الكمبوند / Compound",
    "الموقع الكامل / Location",
    "الحالة / Status",
    "تاريخ التسجيل / Created At"
  ];

  const esc = (v) => {
    let s = String(v ?? "").trim();
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV injection guard
    return `"${s.replace(/"/g, '""')}"`;
  };

  const lines = [headers.join(",")];

  for (const r of rows) {
    const det = r.details || {};
    const features = Array.isArray(det.features)
      ? det.features.join(" - ")
      : "";
    const amenities = [det.finishing, features].filter(Boolean).join(" | ");
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
          ? Number(r.price_value).toLocaleString("en-US")
          : r.price_display || "-"
      ),
      esc(r.area_value || "-"),
      esc(det.floor || "-"),
      esc(r.bedrooms || "-"),
      esc(det.bathrooms || "-"),
      esc(
        det.nanny_room === true
          ? "نعم / Yes"
          : det.nanny_room === false
          ? "لا / No"
          : "-"
      ),
      esc(amenities || "-"),
      esc(r.compound || "-"),
      esc(r.location || "-"),
      esc(STATUS_MAP[String(r.status).toLowerCase()] || r.status),
      esc(dateStr)
    ];

    lines.push(row.join(","));
  }

  return "\uFEFF" + lines.join("\r\n"); // UTF-8 BOM for Excel Arabic character compatibility
}

module.exports = {
  normalizeAr,
  getHelpMessage,
  parseEgyptianPrice,
  parsePrice,
  formatPrice,
  localizeListing,
  formatClientListingText,
  formatInternalListingDetails,
  formatSearchResults,
  listingsToCsv,
  cleanFeaturesList
};
