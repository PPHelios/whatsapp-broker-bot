// domain/plans.js — The monthly plans (phase 2 step 4): price in EGP, seats and AI allowances per agency per month.
// Text = AI text requests (adding units, searches, leads); voice = voice notes understood. The daily AI caps stay on top
// as a safety net. The landing page, the usage page and the allowance checks all read this list.
"use strict";

const PLANS = Object.freeze([
  { id: "solo", name: ["سولو", "Solo"], priceEgp: 139, seats: 1, text: 300, voice: 60 },
  { id: "office", name: ["مكتب", "Office"], priceEgp: 830, seats: 5, text: 1500, voice: 300 },
  { id: "agency", name: ["وكالة", "Agency"], priceEgp: 2090, seats: 15, text: 4500, voice: 900 }
]);
// After the trial: a small plan that keeps every record readable (never deleted) with a little room to keep working.
const FREE = Object.freeze({ id: "free", name: ["مجاني", "Free"], priceEgp: 0, seats: 1, text: 50, voice: 10 });
const VOICE_PACK = Object.freeze({ notes: 100, priceEgp: 79 });
const TRIAL = Object.freeze({ plan: "office", days: 14 });

const ALL = [...PLANS, FREE];
const planById = (id) => ALL.find((p) => p.id === id) || null;
const planName = (plan, lang) => plan.name[lang === "en" ? 1 : 0];

module.exports = { PLANS, FREE, VOICE_PACK, TRIAL, planById, planName };
