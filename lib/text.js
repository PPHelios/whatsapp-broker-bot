// lib/text.js

/**
 * Returns the comprehensive WhatsApp help guide.
 */
function getHelpMessage() {
  return [
    "🤖 *المساعد الذكي لإدارة العقارات*",
    "",
    "📌 *القواعد الأساسية:*",
    "1. *وحدة واحدة في كل مرة:* أرسل جميع صور وتفاصيل الوحدة معاً، وانتظر استلام الكتالوج قبل إرسال عقار جديد.",
    "2. *نظام اختيار الصور (الحد الأقصى للكتالوج 9 صور):*",
    "   • يمكنك إرسال حتى 15 صورة كحد أقصى.",
    "   • يقوم الذكاء الاصطناعي بفحص الصور، استبعاد المكرر واللقطات غير المناسبة، واختيار أفضل 9 صور لتصميم الكتالوج تلقائياً مع تحديد الصورة الرئيسية.",
    "   • إذا أرسلت أكثر من 15 صورة، سيتم فحص أول 15 صورة فقط واختيار أفضل 9 منها.",
    "3. *الرسائل الصوتية:*",
    "   • الحد الأقصى لتسجيل إضافة عقار: *دقيقتان (120 ثانية)*.",
    "   • الحد الأقصى لتسجيل البحث: *45 ثانية*.",
    "4. *عدم المقاطعة:* تجنب إرسال رسائل أو أوامر أثناء معالجة العقار لتجنب تداخل البيانات.",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "🎙️ *متاح بالصوت (تسجيل صوتي) أو بالكتابة:*",
    "• *إضافة عقار:* أرسل مواصفات الوحدة (صوت أو نص) مع الصور (حتى 15 صورة).",
    "• *البحث في المخزون:* تحدث أو اكتب طلبك مباشرة:",
    '  مثال: _"شقة 3 غرف في ابتاون تحت 20 مليون"_',
    '  مثال: _"عايز دوبلكس للبيع في التجمع الخامس بمقدم 3 مليون"_',
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📲 *مشاركة العروض مع العملاء (جاهزة للإرسال):*",
    "• *نص للعميل فقط:* أرسل `عميل الكود` (مثال: `عميل RK-D-31337`)",
    "  _(يجهز رسالة نظيفة بدون بيانات داخلية ومذيلة باسمك ورقم هاتفك)_",
    "• *كتالوج للعميل:* أرسل `كتالوج عميل الكود` (مثال: `كتالوج عميل RK-D-31337`)",
    "  _(يرسل صورة الكتالوج الأصلية مع نص العميل وبيانات تواصلك)_",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "⌨️ *أوامر الإدارة والمخزون:*",
    "• *بيانات الوحدة داخلياً:* `#الكود` (مثال: `#RK-D-31337`)",
    "• *كتالوج الوحدة داخلياً:* `كتالوج الكود` (مثال: `كتالوج RK-D-31337`)",
    "• *تصفح نتائج البحث:* أرسل `المزيد` لعرض النتائج التالية.",
    "• *تعديل السعر:* `سعر RK-D-31337 إلى 19.5 مليون`",
    "• *تحديث الحالة:* `تم البيع RK-D-31337` أو `ارشيف RK-D-31337` أو `تفعيل RK-D-31337`",
    "• *تصدير إكسيل:* أرسل `اكسيل` لتنزيل كل الوحدات في ملف CSV.",
    "• *تقرير الأداء:* أرسل `احصائيات` لعرض ملخص وحداتك."
  ].join("\n");
}

/**
 * Formats a clean, buyer-ready property listing.
 * Retains the unit code and appends the requesting broker's name and phone number.
 *
 * @param {object} listing - Database listing row
 * @param {object} broker - Requesting broker record { name, phone }
 * @returns {string}
 */
function formatClientListingText(listing, broker) {
  const details = listing.details || {};
  const brokerName = broker.name || "المستشار العقاري";
  const brokerPhone =
    broker && (broker.contact_phone || broker.phone)
      ? broker.contact_phone || broker.phone
      : "";

  let paymentDetails = `• السعر الإجمالي: *${
    listing.price_display || "عند الطلب"
  }*`;
  if (details.down_payment_value) {
    paymentDetails += `\n• المقدم المطلوب: *${Number(
      details.down_payment_value
    ).toLocaleString("en-US")} ج*`;
  }
  if (details.installments_years) {
    paymentDetails += `\n• الأقساط: متبقي أقساط على ${details.installments_years} سنوات`;
  }

  let featuresText = "";
  if (Array.isArray(details.features) && details.features.length > 0) {
    featuresText =
      `\n\n✨ *أبرز المميزات:*\n` +
      details.features.map((f) => `  ✓ ${f}`).join("\n");
  }

  let summaryText = "";
  if (details.clean_summary) {
    summaryText = `\n\n📝 *الوصف والتفاصيل:*\n${details.clean_summary}`;
  }

  return [
    `🏡 *عرض عقاري مميز | كود: #${listing.code}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📌 *الوحدة:* ${listing.title}`,
    `📍 *الموقع:* ${listing.location || "-"}`,
    paymentDetails,
    `📐 *المساحة:* ${listing.area_value ? `${listing.area_value} م²` : "-"}`,
    `🛏️ *التقسيم الداخلي:* ${
      listing.bedrooms ? `${listing.bedrooms} غرف نوم` : "غير محدد"
    }`,
    featuresText,
    summaryText,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📞 *للتواصل ومزيد من التفاصيل أو المعاينة:*`,
    `👤 *${brokerName}*`,
    `📱 *هاتف / واتساب:* ${brokerPhone}`
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Formats internal property details for the broker.
 */
function formatInternalListingDetails(listing, lang = "ar") {
  const details = listing.details || {};

  if (lang === "en") {
    return [
      `📑 *INTERNAL LISTING DETAILS - #${listing.code}*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `• *Title:* ${listing.title || "-"}`,
      `• *Type:* ${listing.property_type || "-"} | *Offer:* ${
        listing.listing_type === "rent" ? "Rent" : "Sale"
      }`,
      `• *Price:* ${listing.price_display || "-"}`,
      `• *Area:* ${listing.area_value ? listing.area_value + " sqm" : "-"}`,
      `• *Bedrooms:* ${listing.bedrooms || "-"}`,
      `• *Location:* ${listing.location || "-"}`,
      `• *Compound:* ${listing.compound || "-"}`,
      `• *Status:* ${listing.status ? listing.status.toUpperCase() : "ACTIVE"}`,
      `• *Images Count:* ${listing.flyer_url ? "Flyer Ready" : "No Images"}`,
      details.clean_summary ? `\n📝 *Summary:*\n_${details.clean_summary}_` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    `📑 *المواصفات الداخلية للعقار - #${listing.code}*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `• *العنوان:* ${listing.title || "-"}`,
    `• *النوع:* ${listing.property_type || "-"} | *المعاملة:* ${
      listing.listing_type === "rent" ? "إيجار" : "بيع"
    }`,
    `• *السعر:* ${listing.price_display || "-"}`,
    `• *المساحة:* ${listing.area_value ? listing.area_value + " م²" : "-"}`,
    `• *الغرف:* ${listing.bedrooms || "-"}`,
    `• *الموقع:* ${listing.location || "-"}`,
    `• *الكمبوند:* ${listing.compound || "-"}`,
    `• *الحالة:* ${
      listing.status === "active"
        ? "نشط"
        : listing.status === "sold"
        ? "تم البيع"
        : "مؤرشف"
    }`,
    `• *الكتالوج:* ${
      listing.flyer_url ? "جاهز ومصمم ✅" : "بدون كتالوج (لا توجد صور) ❌"
    }`,
    details.clean_summary
      ? `\n📝 *الوصف التفصيلي:*\n_${details.clean_summary}_`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Parses Arabic/English price strings like "19.5 مليون" or "850 الف" into numeric EGP and display string.
 * @param {string} rawPriceText
 * @returns {{ priceValue: number|null, priceDisplay: string }}
 */
/**
 * Normalizes Eastern Arabic numerals and separators into standard numeric text.
 * Handles digits (٠-٩), Arabic comma (،), and Arabic decimal separator (٫).
 */
function normalizePriceInput(str) {
  if (!str) return "";
  return String(str)
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/٫/g, ".")
    .replace(/،/g, ",")
    .trim();
}

/**
 * Parses user price inputs across Arabic and English shorthand notations.
 * Supports: "18.5m", "18,5 مليون", "850k", "850 ألف", "18500000", "25 ألف إيجار"
 *
 * @param {string|number} rawPriceText
 * @param {Object} [options={}]
 * @param {string} [options.lang='ar'] - 'ar' yields 'ج.م', 'en' yields 'EGP'
 * @param {string} [options.listingType='sale'] - 'sale' or 'rent' (influences bare number threshold)
 * @returns {{ priceValue: number|null, priceDisplay: string }}
 */
function parseEgyptianPrice(rawPriceText, options = {}) {
  const lang = options.lang || "ar";
  const listingType = options.listingType || "sale";
  const fallbackDisplay = lang === "en" ? "Upon Request" : "عند الطلب";
  const currency = lang === "en" ? "EGP" : "ج.م";

  if (!rawPriceText) {
    return { priceValue: null, priceDisplay: fallbackDisplay };
  }

  const rawStr = String(rawPriceText).trim();
  const normalized = normalizePriceInput(rawStr);

  // Extract multiplier intent using word boundaries and digit adjacencies
  const isMillion =
    /(?:^|\s|\d)(?:m|million)\b/i.test(normalized) ||
    /مليون|ملايين/i.test(normalized);

  const isThousand =
    /(?:^|\s|\d)(?:k|thousand)\b/i.test(normalized) ||
    /ألف|الف|الاف|آلاف/i.test(normalized);

  // Distinguish thousands separators (18,500,000) from decimal commas (18,5)
  // If comma is followed by 1 or 2 digits followed by non-digits or end-of-string, it's a decimal.
  let sanitizedNumberText = normalized
    .replace(/,(\d{1,2})(?!\d)/g, ".$1")
    .replace(/,/g, "");

  const numMatch = sanitizedNumberText.match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) {
    return { priceValue: null, priceDisplay: rawStr };
  }

  let val = parseFloat(numMatch[1]);
  if (isNaN(val)) {
    return { priceValue: null, priceDisplay: rawStr };
  }

  if (isMillion) {
    val = Math.round(val * 1000000);
  } else if (isThousand) {
    val = Math.round(val * 1000);
  } else if (val < 100) {
    // In Egyptian real estate, bare small numbers (e.g., "18.5" or "7") mean millions for sales,
    // but typically thousands for rentals (e.g. "25" rent means 25k/month, not 25M).
    if (listingType === "rent") {
      val = Math.round(val * 1000);
    } else {
      val = Math.round(val * 1000000);
    }
  } else {
    val = Math.round(val);
  }

  return {
    priceValue: val,
    priceDisplay: `${val.toLocaleString("en-US")} ${currency}`
  };
}

module.exports = {
  getHelpMessage,
  formatClientListingText,
  formatInternalListingDetails,
  parseEgyptianPrice
};
