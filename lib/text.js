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
/* Help                                                                */
/* ------------------------------------------------------------------ */
function getHelpMessage() {
  return [
    "🤖 *المساعد الذكي لإدارة العقارات*",
    "",
    "📌 *القواعد الأساسية:*",
    "1. *أضف وحدة:* أرسل الصور (حتى 15) مع المواصفات نصاً أو صوتاً. تبدأ المعالجة تلقائياً بعد ثواني من آخر رسالة، أو اكتب `تم` لبدء المعالجة فوراً.",
    "2. *اختيار الصور:* يفحص الذكاء الاصطناعي الصور ويختار أفضل 9 للكتالوج ويحدد الصورة الرئيسية. الصور الزائدة عن 15 تُتجاهل وسنخبرك بذلك.",
    "3. *الرسائل الصوتية:* حتى *دقيقتين* لإضافة عقار، وحتى *45 ثانية* للبحث.",
    "4. *تكرار الكود:* إرسال كود موجود (`إضافة #الكود`) يضيف الصور/التعديلات لنفس الوحدة، و`استبدال #الكود` يستبدل صورها.",
    "5. *الأخطاء:* لو تعذرت المعالجة اكتب `أعد المحاولة` ولن تحتاج لإعادة إرسال الصور.",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "🎙️ *بالصوت أو بالكتابة:*",
    "• *البحث في المخزون:*",
    '  _"شقة 3 غرف في ابتاون تحت 20 مليون"_',
    '  _"عايز دوبلكس للبيع في التجمع الخامس"_',
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "📲 *مشاركة العروض مع العملاء:*",
    "• `عميل الكود` ← نص نظيف للعميل بدون بيانات داخلية",
    "• `كتالوج عميل الكود` ← صورة الكتالوج + نص العميل",
    "",
    "━━━━━━━━━━━━━━━━━━━━",
    "⌨️ *أوامر المخزون:*",
    "• `#الكود` ← بيانات الوحدة داخلياً",
    "• `كتالوج الكود` ← صورة الكتالوج",
    "• `المزيد` ← النتائج التالية للبحث",
    "• `سعر الكود إلى 19.5 مليون` ← تعديل السعر وإعادة تصميم الكتالوج",
    "• `اكسيل` ← تصدير الوحدات CSV",
    "• `احصائيات` ← ملخص المخزون"
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Money                                                               */
/* ------------------------------------------------------------------ */
function normalizePriceInput(str) {
  if (!str) return "";
  return String(str)
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/٫/g, ".")
    .replace(/،/g, ",")
    .trim();
}

// -> { value, hadUnit, bare } | null
function parseMoney(raw, { listingType = "sale" } = {}) {
  if (raw === null || raw === undefined || raw === "") return null;
  const normalized = normalizePriceInput(String(raw));

  const isMillion =
    /(?:^|\s|\d)(?:m|million)(?![a-z])/i.test(normalized) || /مليون|ملايين/.test(normalized);
  const isThousand =
    /(?:^|\s|\d)(?:k|thousand)(?![a-z])/i.test(normalized) || /ألف|الف|الاف|آلاف/.test(normalized);

  // "18,5" is a decimal comma, "18,500,000" is a thousands separator.
  const cleaned = normalized.replace(/,(\d{1,2})(?!\d)/g, ".$1").replace(/,/g, "");
  const m = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let val = parseFloat(m[1]);
  if (!Number.isFinite(val)) return null;

  const hadUnit = isMillion || isThousand;
  if (isMillion) val = Math.round(val * 1e6);
  else if (isThousand) val = Math.round(val * 1e3);
  else if (val < 100) val = Math.round(val * (listingType === "rent" ? 1e3 : 1e6));
  else val = Math.round(val);
  return { value: val, hadUnit, bare: !hadUnit && val !== Math.round(parseFloat(m[1])) };
}

function parseEgyptianPrice(rawPriceText, options = {}) {
  const lang = options.lang || "ar";
  const fallbackDisplay = lang === "en" ? "Upon Request" : "عند الطلب";
  const currency = lang === "en" ? "EGP" : "ج.م";
  if (!rawPriceText) return { priceValue: null, priceDisplay: fallbackDisplay };

  const p = parseMoney(rawPriceText, { listingType: options.listingType || "sale" });
  if (!p) return { priceValue: null, priceDisplay: fallbackDisplay };
  return {
    priceValue: p.value,
    priceDisplay: `${p.value.toLocaleString("en-US")} ${currency}`
  };
}

// Plain number or null. implicitUnits=false rejects bare small numbers ("7") that have no unit word.
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
  return String(v);
}

function priceText(listing, lang) {
  if (listing.price_value) {
    return `${Number(listing.price_value).toLocaleString("en-US")} ${lang === "en" ? "EGP" : "ج.م"}`;
  }
  return listing.price_display || (lang === "en" ? "Upon Request" : "عند الطلب");
}

/* ------------------------------------------------------------------ */
/* Localization overlay (title/location/summary/features in other lang) */
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
      features: Array.isArray(alt.features) && alt.features.length ? alt.features : d.features
    }
  };
}

/* ------------------------------------------------------------------ */
/* Client / internal listing text                                      */
/* ------------------------------------------------------------------ */
function formatClientListingText(rawListing, broker = {}, lang = "ar") {
  const isEn = lang === "en";
  const listing = localizeListing(rawListing, lang);
  const details = listing.details || {};
  const brokerName = broker.name || (isEn ? "Real Estate Consultant" : "المستشار العقاري");
  const brokerPhone = broker.contact_phone || broker.phone || "";
  const installmentYears = details.installment_years || details.installments_years || null;
  const features = Array.isArray(details.features) ? details.features : [];

  if (isEn) {
    let payment = `💰 *Price:* ${priceText(listing, "en")}`;
    if (details.down_payment_value)
      payment += `\n💵 *Down Payment:* ${Number(details.down_payment_value).toLocaleString("en-US")} EGP`;
    if (installmentYears) payment += `\n🗓️ *Installments:* Over ${installmentYears} years`;
    return [
      `🏡 *Featured Property | Code: #${listing.code}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `📌 *Unit:* ${listing.title || "Residential Property"}`,
      `📍 *Location:* ${listing.location || "-"}`,
      payment,
      `📐 *Area:* ${listing.area_value ? `${listing.area_value} sqm` : "-"}`,
      `🛏️ *Bedrooms:* ${listing.bedrooms ? `${listing.bedrooms} Beds` : "Not Specified"}`,
      features.length ? `\n✨ *Key Features:*\n${features.map((f) => `  ✓ ${f}`).join("\n")}` : "",
      details.clean_summary ? `\n📝 *Description:*\n${details.clean_summary}` : "",
      `━━━━━━━━━━━━━━━━━━━━`,
      `📞 *For inquiries or viewing appointments:*`,
      `👤 *${brokerName}*`,
      `📱 *Phone / WhatsApp:* ${brokerPhone}`
    ].filter(Boolean).join("\n");
  }

  let payment = `💰 *السعر الإجمالي:* ${priceText(listing, "ar")}`;
  if (details.down_payment_value)
    payment += `\n💵 *المقدم المطلوب:* ${Number(details.down_payment_value).toLocaleString("en-US")} ج.م`;
  if (installmentYears) payment += `\n🗓️ *الأقساط:* على ${installmentYears} سنوات`;
  return [
    `🏡 *عرض عقاري مميز | كود: #${listing.code}*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📌 *الوحدة:* ${listing.title || "وحدة سكنية معروضة"}`,
    `📍 *الموقع:* ${listing.location || "-"}`,
    payment,
    `📐 *المساحة:* ${listing.area_value ? `${listing.area_value} م²` : "-"}`,
    `🛏️ *التقسيم الداخلي:* ${listing.bedrooms ? `${listing.bedrooms} غرف نوم` : "غير محدد"}`,
    features.length ? `\n✨ *أبرز المميزات:*\n${features.map((f) => `  ✓ ${f}`).join("\n")}` : "",
    details.clean_summary ? `\n📝 *الوصف والتفاصيل:*\n${details.clean_summary}` : "",
    `━━━━━━━━━━━━━━━━━━━━`,
    `📞 *للتواصل ومزيد من التفاصيل أو المعاينة:*`,
    `👤 *${brokerName}*`,
    `📱 *هاتف / واتساب:* ${brokerPhone}`
  ].filter(Boolean).join("\n");
}

function formatInternalListingDetails(listing, lang = "ar") {
  const details = listing.details || {};
  const isEn = lang === "en";
  const statusMap = {
    active: isEn ? "ACTIVE" : "نشط",
    sold: isEn ? "SOLD" : "تم البيع",
    archived: isEn ? "ARCHIVED" : "مؤرشف"
  };
  const status = statusMap[String(listing.status || "active").toLowerCase()] || statusMap.active;
  const years = details.installment_years || details.installments_years;
  const down = details.down_payment_value ? Number(details.down_payment_value).toLocaleString("en-US") : null;

  if (isEn) {
    const lines = [
      `📑 *INTERNAL LISTING SPECIFICATIONS*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `• *Unit Code:* #${listing.code}`,
      `• *Title:* ${listing.title || "-"}`,
      `• *Type:* ${listing.property_type || "-"} (${listing.listing_type === "rent" ? "Rent" : "Sale"})`,
      `• *Asking Price:* ${priceText(listing, "en")}`,
      `• *Area:* ${listing.area_value ? `${listing.area_value} sqm` : "-"}`,
      `• *Bedrooms:* ${listing.bedrooms || "-"}`,
      `• *Location:* ${listing.location || "-"}`,
      `• *Compound:* ${listing.compound || "-"}`,
      `• *Status:* ${status}`,
      `• *Flyer Brochure:* ${listing.flyer_url ? "Generated ✅" : "No Flyer (Photos Required) ❌"}`
    ];
    if (down) lines.push(`• *Down Payment:* ${down} EGP`);
    if (years) lines.push(`• *Installment Duration:* ${years} Years`);
    if (details.clean_summary) lines.push(`\n📝 *Internal Summary:*\n_${details.clean_summary}_`);
    return lines.join("\n");
  }

  const lines = [
    `📑 *المواصفات والتفاصيل الداخلية للوحدة*`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `• *كود الوحدة:* #${listing.code}`,
    `• *العنوان:* ${listing.title || "-"}`,
    `• *النوع:* ${listing.property_type || "-"} (${listing.listing_type === "rent" ? "إيجار" : "بيع"})`,
    `• *السعر المطلوب:* ${priceText(listing, "ar")}`,
    `• *المساحة:* ${listing.area_value ? `${listing.area_value} م²` : "-"}`,
    `• *عدد الغرف:* ${listing.bedrooms || "-"}`,
    `• *الموقع:* ${listing.location || "-"}`,
    `• *الكمبوند:* ${listing.compound || "-"}`,
    `• *الحالة:* ${status}`,
    `• *الكتالوج المصور:* ${listing.flyer_url ? "جاهز ومصمم ✅" : "بدون كتالوج (لم تُرفق صور) ❌"}`
  ];
  if (down) lines.push(`• *المقدم المطلوب:* ${down} ج.م`);
  if (years) lines.push(`• *سنوات التقسيط:* ${years} سنوات`);
  if (details.clean_summary) lines.push(`\n📝 *الوصف التفصيلي:*\n_${details.clean_summary}_`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Search results + CSV                                                */
/* ------------------------------------------------------------------ */
function formatSearchResults(rows, { offset = 0, total = 0, lang = "ar", interpretation = "", relaxed = false, pageSize = 10 } = {}) {
  const en = lang === "en";
  const out = [en ? `🔍 ${total} matching unit(s)` : `🔍 تم العثور على ${total} وحدة`];
  if (relaxed)
    out.push(en ? "ℹ️ Close matches — budget/area range widened slightly." : "ℹ️ نتائج قريبة — تم توسيع الميزانية/المساحة قليلاً.");
  if (interpretation) out.push(`🧭 ${interpretation}`);
  out.push("");
  rows.forEach((u, i) => {
    const title = String(u.title || "").slice(0, 80);
    out.push(
      `*${offset + i + 1}. #${u.code}* - ${title}\n   💰 ${u.price_display || "-"} | 📐 ${u.area_value || "-"} ${en ? "sqm" : "م²"} | 🛏️ ${u.bedrooms || "-"}\n   📍 ${u.location || "-"}\n`
    );
  });
  const more = offset + rows.length < total;
  out.push(
    more
      ? en ? "➡️ Send *more* for the next results • `#CODE` for details" : "➡️ أرسل *المزيد* للنتائج التالية • `#الكود` للتفاصيل"
      : en ? "`#CODE` for details" : "`#الكود` للتفاصيل"
  );
  return out.join("\n");
}

function listingsToCsv(rows) {
  const cols = ["code", "title", "property_type", "listing_type", "price_value", "area_value", "bedrooms", "location", "compound", "status", "flyer_url", "created_at"];
  const esc = (v) => {
    let s = v instanceof Date ? v.toISOString() : String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV/formula injection guard
    return `"${s.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n");
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
