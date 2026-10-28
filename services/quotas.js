// services/quotas.js — Everything with a limit, in one list for an agency: AI text and voice this month, price-list
// pages (PDF and photo reading), assistant web answers, available units and users. The manager dashboard, the plan page
// and onboarding all show these, so a limit is never a surprise.
"use strict";

const Billing = require("./billing");
const PriceReading = require("./priceReading");
const Assistant = require("./assistant");

/** [{ key, label: [ar, en], used, limit, off, hint: [ar, en], href }] */
async function forAgency(db, agencyId, { now = new Date() } = {}) {
  const [a, reading, web] = await Promise.all([Billing.allowance(db, agencyId, { now }), PriceReading.usage(db, agencyId, { now }), Assistant.webSetting(db, agencyId)]);
  const webUsed = web.web ? await Assistant.webUsed(db, agencyId, now) : 0;
  return [
    { key: "text", label: ["طلبات الذكاء الاصطناعي (نص)", "AI text requests"], used: a.text.used, limit: a.text.limit, hint: ["بتتحسب: إضافة الوحدات بالوصف، والبحث، وتسجيل العملاء بالكلام. ترتيب الصور بإيدك بيوفر منها.", "Counted: adding units by description, searches, saving clients by text. Ordering photos by hand saves them."], href: "/app/plan" },
    { key: "voice", label: ["رسائل الفويس", "Voice notes"], used: a.voice.used, limit: a.voice.limit, hint: ["كل فويس بيتفهم بيتحسب. تقدر تشتري باقة فويس زيادة.", "Each voice note understood counts. You can buy an extra voice pack."], href: "/app/plan" },
    { key: "pages", label: ["قراية قوايم الأسعار (صفحات PDF وصور)", "Price-list reading (PDF and photo pages)"], used: reading.used, limit: reading.pages_month, off: !reading.enabled, hint: ["كل صفحة بتتقرا بالذكاء الاصطناعي بتتحسب مرة؛ الصفحة المقروءة قبل كده ببلاش. مقفولة لحد ما صاحب التطبيق يفتحها.", "Each page read by AI counts once; a page read before is free. Off until the app owner switches it on."], href: "/app/catalogue" },
    { key: "web", label: ["ردود المساعد من الإنترنت", "Assistant web answers"], used: webUsed, limit: web.web_month, off: !web.web, hint: ["المساعد بيرد من بياناتك أولاً؛ الرد من الإنترنت اختياري ومكتوب عليه غير مؤكد. مقفول لحد ما صاحب التطبيق يفتحه.", "The assistant answers from your data first; a web answer is optional and labelled unverified. Off until the app owner switches it on."], href: "/app/ask" },
    { key: "units", label: ["وحدات متاحة", "Available units"], used: a.units.used, limit: a.units.limit, hint: ["المباعة والمؤرشفة مش بتتحسب.", "Sold and archived units don't count."], href: "/app/units" },
    { key: "seats", label: ["المستخدمين", "Users"], used: a.seats.used, limit: a.seats.limit, hint: ["كل وسيط أو مدير نشط بياخد مكان.", "Each active broker or manager takes a seat."], href: "/app/team" }
  ];
}

module.exports = { forAgency };
