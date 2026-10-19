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
  const brokerPhone = broker.phone || "";

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
function formatInternalListingDetails(listing) {
  const details = listing.details || {};
  const summaryText = details.clean_summary
    ? "\n\n📝 *الوصف:*\n" + details.clean_summary
    : "";
  const downPayment = details.down_payment_value
    ? "\n• المقدم: *" +
      Number(details.down_payment_value).toLocaleString("en-US") +
      " ج*"
    : "";

  let statusLabel = "مؤرشف ⚪";
  if (listing.status === "active") statusLabel = "نشط 🟢";
  if (listing.status === "sold") statusLabel = "مباع 🔴";

  return [
    "📋 *بيانات العقار الداخلية | #" + listing.code + "*",
    "• الحالة: *" + statusLabel + "*",
    "• الوحدة: " + listing.title,
    "• السعر: *" + (listing.price_display || "عند الطلب") + "*" + downPayment,
    "• المساحة: " +
      (listing.area_value ? listing.area_value + " م²" : "-") +
      " | الغرف: " +
      (listing.bedrooms || "-"),
    "• الموقع: " + (listing.location || "-") + summaryText,
    "",
    "💡 *أوامر سريعة:*",
    "• للكتالوج: كتالوج " + listing.code,
    "• للعميل (نص): عميل " + listing.code,
    "• للعميل (كتالوج): كتالوج عميل " + listing.code
  ].join("\n");
}

/**
 * Parses Arabic/English price strings like "19.5 مليون" or "850 الف" into numeric EGP and display string.
 * @param {string} rawPriceText
 * @returns {{ priceValue: number|null, priceDisplay: string }}
 */
function parseEgyptianPrice(rawPriceText) {
  if (!rawPriceText) return { priceValue: null, priceDisplay: "عند الطلب" };

  const normalized = String(rawPriceText)
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/,/g, "")
    .trim();

  const numMatch = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) {
    return { priceValue: null, priceDisplay: rawPriceText.trim() };
  }

  let val = parseFloat(numMatch[1]);
  if (/مليون|ملايين|million|m/i.test(normalized)) {
    val = Math.round(val * 1000000);
  } else if (/ألف|الف|الاف|آلاف|k|thousand/i.test(normalized)) {
    val = Math.round(val * 1000);
  } else if (val < 100) {
    // In Egyptian real estate, bare numbers like "18.5" almost always mean millions
    val = Math.round(val * 1000000);
  } else {
    val = Math.round(val);
  }

  return {
    priceValue: val,
    priceDisplay: `${val.toLocaleString("en-US")} ج`
  };
}

module.exports = {
  getHelpMessage,
  formatClientListingText,
  formatInternalListingDetails,
  parseEgyptianPrice
};
