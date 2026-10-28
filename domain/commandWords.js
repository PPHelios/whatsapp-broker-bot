// domain/commandWords.js — F4: bot command words in any common Arabic spelling (pure). "اضافه", "إضافة" and "اضافة"
// are the same word: ة/ه, أ/إ/آ/ا, ى/ي, tatweel, diacritics and extra spaces don't matter. Only the first words of a
// message are rewritten, and only when they are a command word, so the rest of the text is never changed.
"use strict";

/** Spelling-blind key of a word or phrase. */
function arabicKey(s) {
  return String(s || "")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// One spelling each that the command matchers accept (routes/commands.js, lib/registry.js, domain/leadIntake.js,
// domain/assistant.js, lib/bugReports.js, routes/commandDeliverables.js). Longest phrases are tried first.
const WORDS = [
  "مساعدة", "اوامر", "قائمة", "العربية", "الإنجليزية", "إلغاء", "خروج", "قفل",
  "اضافة", "جديد", "وحدة جديدة", "تم", "حفظ", "خلاص", "مراجعة",
  "مخزون", "المخزون", "تقرير المخزون", "احصائيات", "تصدير", "اكسل", "اكسيل", "شيت", "حذف", "مسح",
  "كتالوج", "بروشور", "بدون بيانات", "عميل", "جدول", "انظمة السداد", "سداد", "مخطط", "ملفات",
  "صفقة", "دخول", "الدخول", "تسجيل الدخول", "الموقع", "الويب", "لوجين",
  "تحديث", "حدث", "تحديث مشروع", "تحديث كتالوج", "المزيد", "مزيد", "كمان",
  "تعديل", "عدل", "سعر", "السعر", "ارشفة", "ارشف", "تم البيع", "تم بيعها", "اتباعت", "متاحة", "لسه متاحة", "تفعيل",
  "ليد", "عميل جديد", "عملائي", "العملاء", "متابعات", "المتابعات", "متابعاتي", "حول", "طلب", "طلب العميل",
  "اسأل", "سؤال", "يا مساعد", "بلاغ", "مشكلة"
];
const BY_KEY = new Map();
for (const w of WORDS) if (!BY_KEY.has(arabicKey(w))) BY_KEY.set(arabicKey(w), w);
const MAX_WORDS = Math.max(...WORDS.map((w) => w.split(" ").length));

/**
 * The message with its leading command word(s) in the spelling the matchers know ("اضافه" → "اضافة",
 * "الغاء" → "إلغاء", "اسال  سؤال" → "اسأل سؤال"); any other message comes back unchanged.
 */
function canonicalCommand(text) {
  const raw = String(text || "");
  const m = raw.match(/^\s*/);
  const body = raw.slice(m[0].length);
  if (!/^[؀-ۿ]/.test(body)) return raw;
  const words = body.split(/\s+/);
  for (let n = Math.min(MAX_WORDS, words.length); n >= 1; n--) {
    // Punctuation right after the word (":" in "طلب: …") stays where it is.
    const last = words[n - 1].match(/^([\s\S]*?)([:：\-–,،.!؟?]*)$/);
    const phrase = [...words.slice(0, n - 1), last[1]].join(" ");
    const hit = BY_KEY.get(arabicKey(phrase));
    if (!hit) continue;
    const rest = body.slice(body.match(new RegExp(`^(?:\\S+\\s+){${n - 1}}\\S+`))[0].length);
    return `${hit}${last[2]}${rest}`;
  }
  return raw;
}

module.exports = { arabicKey, canonicalCommand, WORDS };
