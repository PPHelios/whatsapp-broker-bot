// services/quotas.js — Everything with a limit, in one list for an agency: AI credits this month, available units and
// users. The manager dashboard, the plan page
// and onboarding all show these, so a limit is never a surprise.
"use strict";

const Billing = require("./billing");

/** [{ key, label: [ar, en], used, limit, off, hint: [ar, en], href }] */
async function forAgency(db, agencyId, { now = new Date() } = {}) {
  const a = await Billing.allowance(db, agencyId, { now });
  return [
    { key: "credits", label: ["رصيد الذكاء الاصطناعي", "AI credits"], used: a.credits.used, limit: a.credits.limit, hint: ["كل عمل بالذكاء الاصطناعي بيتحسب، والجدول في صفحة الباقة. البحث والإضافة من الموقع ببلاش.", "Every AI action counts; the table is on the Plan page. Search and adding on the website are free."], href: "/app/plan" },
    { key: "units", label: ["وحدات متاحة", "Available units"], used: a.units.used, limit: a.units.limit, hint: ["المباعة والمؤرشفة مش بتتحسب.", "Sold and archived units don't count."], href: "/app/plan" },
    { key: "seats", label: ["المستخدمين", "Users"], used: a.seats.used, limit: a.seats.limit, hint: ["كل وسيط أو مدير نشط بياخد مكان.", "Each active broker or manager takes a seat."], href: "/app/team" }
  ];
}

module.exports = { forAgency };
