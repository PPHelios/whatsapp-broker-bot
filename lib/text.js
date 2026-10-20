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

/* ------------------------------------------------------------------ */
/* Help & Command Catalog                                              */
/* ------------------------------------------------------------------ */
function getHelpMessage() {
  return [
    "🤖 *المساعد الذكي لإدارة العقارات*",
    "",
    "📌 *القواعد الأساسية:*",
    "1. *إضافة عقار:* أرسل المواصفات (صوتياً أو نصاً) مع الصور. تبدأ المعالجة تلقائياً بعد ثوانٍ من آخر رسالة، أو اكتب `تم` للبدء فوراً.",
    "2. *التسجيل الصوتي:* حتى دقيقتين للمواصفات، وحتى 45 ثانية للبحث.",
    "3. *تعديل وإضافة صور:* أرسل كود الوحدة مع الصور (`إضافة #الكود`) لضم صور جديدة، أو (`استبدال #الكود`) لتغيير كافة الصور.",
    "4. *حذف وحدة:* اكتب `حذف #الكود` لإلغاء العقار ومسح ملفاته وصوره بالكامل.",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "🎙️ *البحث في المخزون (بالصوت أو الكتابة):*",
    '• _"شقة 3 غرف في ميفيدا التجمع الخامس"_',
    '• _"عايز دوبلكس روف في المربع الذهبي بسعر 18 مليون"_',
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📲 *مشاركة العروض والكتالوجات:*",
    "• `عميل #الكود` ← نص تسويقي مخصص للعميل بدون بيانات داخلية",
    "• `كتالوج #الكود` ← تصميم الكتالوج الإنجليزي المعتمد للوحدة",
    "• `كتالوج فاتح #الكود` ← كتالوج معتمد بالثيم الفاتح",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "⌨️ *أوامر إدارة المخزون:*",
    "• `#الكود` ← مراجعة المواصفات والبيانات الداخلية الكاملة",
    "• `سعر #الكود إلى 19.5 مليون` ← تعديل السعر وإلغاء الكاش القديم",
    "• `مباع #الكود` / `تم البيع #الكود` ← تحديد الوحدة كمباعة واستبعادها من البحث",
    "• `ارشيف #الكود` ← أرشفة الوحدة واستبعادها من نتائج البحث",
    "• `تفعيل #الكود` ← إعادة تفعيل وحدة مؤرشفة",
    "• `احصائيات` ← تقرير فوري بمخزون الوكالة ووحداتك",
    "• `اكسيل` ← استخراج شيت إكسيل تنفيذي منظم بالوحدات",
    "• `أعد المحاولة` ← استئناف العملية في حال حدوث خطأ تقني"
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Money & Price Formatting                                            */
/* ------------------------------------------------------------------ */
function normalizePriceInput(str) {
  if (!str) return "";
  return (
    String(str)
      .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
      .replace(/٫/g, ".")
      .replace(/،/g, ",")
      // Spoken fraction conversions
      .replace(/(?:و\s*)?(?:نص|نصف)/g, ".5")
      .replace(/(?:و\s*)?(?:ربع)/g, ".25")
      .replace(/(?:و\s*)?(?:تلت|ثلث)/g, ".33")
      .replace(/(?:^|\s)مليونين(?=$|\s)/g, "2 مليون")
      .replace(/(?:^|\s)مليون(?=$|\s)/g, "1 مليون")
      .replace(/(?:^|\s)ألفين(?=$|\s)/g, "2 الف")
      .trim()
  );
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
  listingsToCsv
};
