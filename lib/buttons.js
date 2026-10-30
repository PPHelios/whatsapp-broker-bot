// lib/buttons.js — Button catalog: one id and one title per action, in both languages
"use strict";

const b = (id, ar, en) => (lang) => ({ id, title: lang === "en" ? en : ar });

const BUTTONS = {
  draftReview: b("DRAFT_SAVE", "مراجعة ✅", "Review ✅"),
  draftConfirm: b("draft_confirm", "تأكيد وحفظ ✅", "Confirm & Save ✅"),
  draftEdit: b("draft_edit", "تعديل ✏️", "Edit ✏️"),
  draftCancel: b("draft_cancel", "إلغاء ❌", "Cancel ❌"),
  editReview: b("edit_review", "مراجعة ✅", "Review ✅"),
  editConfirm: b("edit_confirm", "تأكيد التعديل ✅", "Save changes ✅"),
  editCancel: b("edit_cancel", "إلغاء ❌", "Cancel ❌"),
  more: b("MORE_SEARCH", "المزيد ➡️", "More ➡️"),
  clientCopy: (code) => b(`client:${code}`, "نص العميل 📱", "Client Copy 📱"),
  flyer: (code) => b(`flyer:en:dark:${code}`, "الكتالوج 📄", "Flyer 📄"),
  edit: (code) => b(`edit:${code}`, "تعديل ✏️", "Edit ✏️"),
  plans: (code) => b(`plans_view:${code}`, "جدول الأقساط 💳", "Plans 💳"),
  askDetails: (code) => b(`unitask:${code}`, "اطلب البيانات 🔒", "Ask details 🔒"),
  quickMenu: (code) => b(`qu_menu:${code}`, "تحديث ⚙️", "Update ⚙️")
};

// Quick-update list rows (interactive list: title ≤ 24 chars, description ≤ 72).
const QUICK_ROWS = [
  { action: "available", ar: ["🟢 لسه متاحة", "تأكيد إن الوحدة متاحة النهارده"], en: ["🟢 Still available", "Confirm the unit is available today"] },
  { action: "sold", ar: ["✅ اتباعت", "تختفي من البحث"], en: ["✅ Sold", "Hidden from search"] },
  { action: "archive", ar: ["📁 أرشفة", "تختفي من البحث ويفضل سجلها"], en: ["📁 Archive", "Hidden from search, record kept"] },
  { action: "edit", ar: ["✏️ تعديل البيانات", "سعر، مساحة، تسليم، مميزات..."], en: ["✏️ Edit details", "Price, area, delivery, features..."] }
];

function quickSections(code, lang = "ar") {
  return [
    {
      title: lang === "en" ? "Quick update" : "تحديث سريع",
      rows: QUICK_ROWS.map((r) => {
        const [title, description] = lang === "en" ? r.en : r.ar;
        return { id: `qu:${r.action}:${code}`, title, description };
      })
    }
  ];
}

/** Buttons under a broker card. */
function cardButtons(listing, lang = "ar") {
  const code = listing.code;
  const third = listing.market === "primary" && (listing.payment_terms?.plans || []).length ? BUTTONS.plans(code) : BUTTONS.quickMenu(code);
  return [BUTTONS.clientCopy(code)(lang), BUTTONS.flyer(code)(lang), third(lang)];
}

module.exports = { BUTTONS, QUICK_ROWS, quickSections, cardButtons };
