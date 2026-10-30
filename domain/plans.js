// domain/plans.js — The monthly plans: price in EGP, seats, unit cap and the AI credit pool per agency per month.
// The database is the source of truth (credit_plans, credit_bundles: services/credits.js, edited on the owner page).
// These objects are filled from it (hydrate) at start and refreshed after each owner edit; the values below are only
// the starting copy of migration 053 so code that runs before the first load never meets an empty plan.
// A plan's pool is shared by the whole team (400 credits per seat); every AI action uses credits (credit_actions).
// The daily AI caps stay on top as a safety net.
"use strict";

const PLANS = [
  { id: "solo", name: ["سولو", "Solo"], priceEgp: 199, seats: 1, units: 300, credits: 400 },
  { id: "office", name: ["مكتب", "Office"], priceEgp: 830, seats: 5, units: 1500, credits: 2000 },
  { id: "agency", name: ["وكالة", "Agency"], priceEgp: 2090, seats: 15, units: 5000, credits: 6000 }
];
// After the trial: a small plan that keeps every record readable (never deleted) with a little room to keep working.
const FREE = { id: "free", name: ["مجاني", "Free"], priceEgp: 0, seats: 1, units: 25, credits: 80 };
// Extra credits bought for the month: { id, name: [ar, en], priceEgp, credits }.
const BUNDLES = [
  { id: "small", name: ["باقة صغيرة", "Small"], priceEgp: 79, credits: 200 },
  { id: "medium", name: ["باقة متوسطة", "Medium"], priceEgp: 175, credits: 500 },
  { id: "large", name: ["باقة كبيرة", "Large"], priceEgp: 349, credits: 1000 }
];
const TRIAL = Object.freeze({ plan: "office", days: 14 });

const ALL = [...PLANS, FREE];
const planById = (id) => ALL.find((p) => p.id === id) || null;
const planName = (plan, lang) => plan.name[lang === "en" ? 1 : 0];
const bundleById = (id) => BUNDLES.find((b) => b.id === id) || null;

/** Fills the plans and bundles in place from database rows (credit_plans, credit_bundles). */
function hydrate({ plans = [], bundles = [] } = {}) {
  const shape = (r) => ({ id: r.id, name: [r.name_ar, r.name_en], priceEgp: r.price_egp, seats: r.seats, units: r.units, credits: r.credits });
  const paid = plans.filter((r) => r.id !== "free" && r.active).sort((a, b) => a.sort - b.sort || a.price_egp - b.price_egp).map(shape);
  const free = plans.find((r) => r.id === "free");
  if (paid.length) PLANS.splice(0, PLANS.length, ...paid);
  if (free) Object.assign(FREE, shape(free));
  if (bundles.length) BUNDLES.splice(0, BUNDLES.length, ...bundles.map((r) => ({ id: r.id, name: [r.name_ar, r.name_en], priceEgp: r.price_egp, credits: r.credits })));
  ALL.splice(0, ALL.length, ...PLANS, FREE);
}

/** What a broker is told when the plan's unit cap is reached (limit = { used, limit, plan }). */
function unitLimitText(limit, lang = "ar") {
  const n = Number(limit.limit).toLocaleString("en-US");
  const name = planName(limit.plan, lang);
  return lang === "en"
    ? `⛔ Your ${name} plan holds ${n} available units and you have reached it. Archive sold units, or upgrade from the Plan page (/app/plan).`
    : `⛔ وصلت للحد الأقصى لباقة ${name}: ${n} وحدة متاحة. أرشف الوحدات المباعة، أو رقّي الباقة من صفحة الباقة (/app/plan).`;
}

module.exports = { unitLimitText, hydrate, ALL, PLANS, FREE, BUNDLES, TRIAL, planById, planName, bundleById };
