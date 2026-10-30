// domain/commandWords.js — F4 + F15: bot command words in any common Arabic spelling (pure). "اضافه", "إضافة" and "اضافة"
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
    .replace(/ئ/g, "ي")
    .replace(/[،,؛;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// F15: the bot's command words, one place (the owner's table). Every Arabic word is spelling-blind (arabicKey) and
// English is case-blind. The help reply (lib/text.js), the website guide (web/routes/guide.js) and docs/commands.md
// are built from COMMANDS; `to` is the spelling the matcher for that command reads (canonicalCommand rewrites to it).
// code: the word only counts as the command when a unit code (or nothing) follows, so "بيع شقة في التجمع" stays a
// search.
const COMMANDS = [
  { id: "add", group: "units", ar: ["إضافة"], en: ["add"], to: "اضافة", help: ["وحدة جديدة: ابعت الصور والتفاصيل (كتابة أو فويس) وبعدها «تم»", "New unit: send the photos and details (text or voice), then \"done\""] },
  { id: "done", group: "units", ar: ["تم"], en: ["done"], help: ["خلّص المسودة أو التعديل وافتح كارت المراجعة", "Finish a draft or an edit and open the review card"] },
  { id: "code", group: "units", ar: [], en: [], example: "NH-V12", help: ["الكود لوحده: كارت الوحدة", "The code alone: the unit's card"] },
  { id: "edit", group: "units", ar: ["تعديل"], en: ["edit"], arg: "CODE", help: ["عدّل وحدة (ممكن تكتب التعديل بعد الكود)", "Edit a unit (you can write the change after the code)"] },
  { id: "price", group: "units", ar: ["سعر"], en: ["price"], arg: "CODE 9.5M", help: ["غيّر السعر", "Change the price"] },
  { id: "sold", group: "units", ar: ["بيع"], en: ["sold"], arg: "CODE", code: true, to: "تم البيع", help: ["اتباعت", "Mark sold"] },
  { id: "archive", group: "units", ar: ["أرشيف"], en: ["archive"], arg: "CODE", code: true, to: "ارشفة", help: ["أرشفة (تختفي من البحث)", "Archive (hidden from search)"] },
  { id: "available", group: "units", ar: ["متاح"], en: ["available"], arg: "CODE", code: true, to: "متاحة", help: ["رجّعها متاحة", "Make it available again"] },
  { id: "delete", group: "units", ar: ["حذف"], en: ["delete"], arg: "CODE", code: true, help: ["احذف وحدة (بعد تأكيد)", "Delete a unit (after you confirm)"] },
  { id: "deal", group: "units", ar: ["صفقة"], en: ["deal"], arg: "L-0042 CODE 8.5M", help: ["سجّل صفقة وعمولتها", "Record a deal and its commission"] },
  { id: "update", group: "units", ar: ["تحديث"], en: ["update"], manager: true, help: ["تحديث مشروع أو الكتالوج (زيادة أسعار، اتباع...)", "Update a project or the catalogue (price rise, sold...)"] },
  { id: "flyer", group: "send", ar: ["فلاير"], en: ["flyer"], arg: "CODE", code: true, to: "flyer", help: ["فلاير باسم الوكالة", "Flyer with the agency's brand"] },
  { id: "broker_flyer", group: "send", ar: ["فلاير بروكر"], en: ["broker flyer"], arg: "CODE", code: true, to: "unbranded", toEn: "unbranded", help: ["فلاير من غير بيانات الوكالة (للبروكرز)", "Flyer without the agency's details (for brokers)"] },
  { id: "client", group: "send", ar: ["عميل"], en: ["client"], arg: "CODE", code: true, help: ["نص الوحدة جاهز تبعته للعميل", "The unit's text, ready to send to a client"] },
  { id: "plans", group: "send", ar: ["أنظمة"], en: ["plans"], arg: "CODE", code: true, to: "انظمة السداد", help: ["أنظمة السداد (شيت إكسيل)", "Payment plans (Excel sheet)"] },
  { id: "layout", group: "send", ar: ["مخطط"], en: ["layout"], arg: "CODE", code: true, help: ["المخطط وملفات المشروع", "The layout and the project's files"] },
  { id: "search", group: "search", ar: [], en: [], example: "شقة التجمع 3 غرف تحت 10 مليون", exampleEn: "apartment New Cairo 3 beds under 10M", help: ["اكتب أو سجّل اللي العميل عايزه بكلامك: بحث", "Type or say what the client wants: search"] },
  { id: "more", group: "search", ar: ["المزيد"], en: ["more"], help: ["نتايج أكتر", "More results"] },
  { id: "stats", group: "search", ar: ["مخزون"], en: ["stats"], help: ["ملخص المخزون", "Inventory summary"] },
  { id: "export", group: "search", ar: ["اكسيل"], en: ["excel"], help: ["المخزون كله في شيت إكسيل", "All the inventory in an Excel sheet"] },
  { id: "lead", group: "leads", ar: ["ليد"], en: ["lead"], arg: "…", help: ["عميل جديد: الكلمة ومعاها رسالة العميل أو فويس", "New lead: the word with the client's message or a voice note"] },
  { id: "my_leads", group: "leads", ar: ["عملائي"], en: ["leads"], help: ["عملائك", "Your leads"] },
  { id: "followups", group: "leads", ar: ["متابعات"], en: ["followups"], help: ["متابعاتك", "Your follow-ups"] },
  { id: "request", group: "leads", ar: ["طلب"], en: ["request"], arg: "L-0042 …", help: ["احفظ اللي العميل عايزه وتتبلغ لما تنزل وحدة تناسبه", "Save what the client wants; you hear when a unit fits"] },
  { id: "assign", group: "leads", ar: ["حول"], en: ["assign"], arg: "L-0042 لـ سارة", argEn: "L-0042 to Sara", manager: true, help: ["حوّل عميل لبروكر", "Hand a lead to a broker"] },
  { id: "lead_ref", group: "leads", ar: [], en: [], example: "L-0042", help: ["رقم العميل لوحده: كارت العميل", "The lead ref alone: the lead's card"] },
  { id: "phone", group: "leads", ar: [], en: [], example: "01012345678", help: ["رقم تليفون لوحده: مين بيتصل؟", "A phone number alone: who is calling?"] },
  { id: "help", group: "general", ar: ["مساعدة"], en: ["help"], help: ["الأوامر دي", "These commands"] },
  { id: "cancel", group: "general", ar: ["إلغاء"], en: ["cancel"], help: ["إلغاء اللي شغال", "Cancel what's open"] },
  { id: "lang_ar", group: "general", ar: ["عربي"], en: [], enHint: "lang ar", to: "العربية", help: ["البوت بالعربي", "The bot in Arabic"] },
  { id: "lang_en", group: "general", ar: [], en: ["english"], toEn: "lang en", help: ["البوت بالإنجليزي", "The bot in English"] },
  { id: "login", group: "general", ar: ["دخول"], en: ["login"], help: ["لينك دخول للموقع", "A sign-in link for the website"] },
  { id: "ask", group: "general", ar: ["اسأل"], en: ["ask"], arg: "…", help: ["اسأل المساعد عن بيانات وكالتك", "Ask the assistant about your agency's data"] },
  { id: "bug", group: "general", ar: ["عطل"], en: ["bug"], arg: "…", to: "بلاغ", help: ["بلّغ عن مشكلة (هيوصلك رقم زي #R12)", "Report a problem (you get a number like #R12)"] }
];
const GROUPS = {
  units: ["🏠 الوحدات", "🏠 Units"],
  send: ["📤 للعميل", "📤 For clients"],
  search: ["🔍 البحث والتقارير", "🔍 Search and reports"],
  leads: ["👤 العملاء", "👤 Leads"],
  general: ["⚙️ عام", "⚙️ General"]
};

// Words the matchers already read in another spelling (F4) keep working in any spelling, too.
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
const CODE_RE = /^[#`[]?[A-Za-z0-9][A-Za-z0-9_\-./]{1,29}[`\]]?$/;
const BY_KEY = new Map(); // spelling-blind phrase → { to, code }
for (const c of COMMANDS) {
  for (const w of c.ar) BY_KEY.set(arabicKey(w), { to: c.to || w, code: Boolean(c.code) });
  for (const w of c.en) BY_KEY.set(arabicKey(w), { to: c.toEn || w, code: Boolean(c.code) });
}
for (const w of WORDS) if (!BY_KEY.has(arabicKey(w))) BY_KEY.set(arabicKey(w), { to: w, code: false });
const MAX_WORDS = Math.max(...[...BY_KEY.keys()].map((w) => w.split(" ").length));

/**
 * The message with its leading command word(s) in the spelling the matchers read ("اضافه" → "اضافة", "الغاء" →
 * "إلغاء", "بيع NH-V12" → "تم البيع NH-V12", "Broker Flyer NH-V12" → "unbranded NH-V12"); any other message comes
 * back unchanged. Arabic or English punctuation right after the word (":" "،" ",") stays where it is.
 */
function canonicalCommand(text) {
  const raw = String(text || "");
  const m = raw.match(/^\s*/);
  const body = raw.slice(m[0].length);
  if (!/^[؀-ۿA-Za-z]/.test(body)) return raw;
  const words = body.split(/\s+/);
  for (let n = Math.min(MAX_WORDS, words.length); n >= 1; n--) {
    const last = words[n - 1].match(/^([\s\S]*?)([:：\-–,،؛;.!؟?]*)$/);
    const phrase = [...words.slice(0, n - 1), last[1]].join(" ");
    const hit = BY_KEY.get(arabicKey(phrase));
    if (!hit) continue;
    const rest = body.slice(body.match(new RegExp(`^(?:\\S+\\s+){${n - 1}}\\S+`))[0].length);
    if (hit.code && rest.trim() && !CODE_RE.test(rest.trim())) return raw;
    // An English word that is already the matcher's own spelling is left as typed (its case may matter).
    if (/^[A-Za-z]/.test(phrase) && phrase.toLowerCase() === hit.to.toLowerCase()) return raw;
    return `${hit.to}${last[2]}${rest}`;
  }
  return raw;
}

/** The words of a command as the help shows them: "*بيع* CODE / *sold* CODE". */
function usage(c, lang) {
  const arg = (en) => (en ? c.argEn || c.arg : c.arg);
  const show = (w, en) => `*${w}*${arg(en) ? ` ${arg(en)}` : ""}`;
  const ar = c.ar.map((w) => show(w, false));
  const en = c.en.map((w) => show(w, true));
  const list = lang === "en" ? [...en, ...ar] : [...ar, ...en];
  return list.length ? list.join(" / ") : `\`${c.example}\``;
}

/** Commands by group, for the help reply, the website guide and the docs. */
function grouped() {
  return Object.entries(GROUPS).map(([id, title]) => ({ id, title, commands: COMMANDS.filter((c) => c.group === id) }));
}

/** The bot's help reply. */
function helpText(lang = "ar") {
  const i = lang === "en" ? 1 : 0;
  const head = lang === "en" ? "*📖 Commands* (Arabic in any spelling; English in any case)" : "*📖 الأوامر* (العربي بأي طريقة كتابة؛ أ/ا، ة/ه، ى/ي زي بعض)";
  const mgr = lang === "en" ? " (managers)" : " (للمديرين)";
  return [head, ...grouped().map((g) => [`\n*${g.title[i]}*`, ...g.commands.map((c) => `• ${usage(c, lang)} ← ${c.help[i]}${c.manager ? mgr : ""}`)].join("\n"))].join("\n");
}

/** docs/commands.md (tests keep the file in step with COMMANDS). */
function markdown() {
  const cell = (s) => String(s).replace(/\*/g, "**").replace(/\|/g, "\\|");
  const lines = ["# WehdatHub bot commands", "", "Generated from `domain/commandWords.js` (F15). Arabic words work in any spelling (أ/إ/آ/ا, ة/ه, ى/ي, tatweel, diacritics, Arabic or Latin commas); English is case-blind. Older words still work but are not shown.", ""];
  for (const g of grouped()) {
    lines.push(`## ${g.title[1]}`, "", "| Words | What it does |", "|---|---|");
    for (const c of g.commands) lines.push(`| ${cell(usage(c, "ar"))} | ${cell(c.help[1])}${c.manager ? " (managers)" : ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}

module.exports = { arabicKey, canonicalCommand, WORDS, COMMANDS, GROUPS, usage, grouped, helpText, markdown };
