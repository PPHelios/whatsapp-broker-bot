// domain/commissionTracker.js — The developer commission tracker's rules (Release A, C8), pure: a project's terms
// (rate or fixed amount, rate tiers by units sold in the year, claim trigger, payment days, registration validity), the
// expected amount of a deal, the states (expected → claimable → claimed → partly paid / paid; cancelled), due dates and
// the 7-day overdue reminder rule. No VAT: amounts are what the developer pays.
"use strict";

const STATUSES = ["expected", "claimable", "claimed", "partly_paid", "paid", "cancelled"];
const OPEN = ["expected", "claimable", "claimed", "partly_paid"];
const TRIGGERS = ["contract", "down_payment", "paid_pct"];
const MAX_TIERS = 5;
const REMIND_EVERY_DAYS = 7;

const DAY = 24 * 3600 * 1000;
const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[,،\s]/g, "").replace(/%$/, ""));
  return Number.isFinite(n) ? n : NaN;
};
const bad = (field) => ({ error: "invalid", field });

/** The terms form → { fields } | { error, field }. */
function termsFields(input = {}) {
  const mode = input.mode === "amount" ? "amount" : "pct";
  const pct = num(input.pct);
  const amount = num(input.amount);
  if (mode === "pct" && (pct === null || Number.isNaN(pct) || pct <= 0 || pct > 20)) return bad("pct");
  if (mode === "amount" && (amount === null || Number.isNaN(amount) || amount <= 0 || amount > 1e9)) return bad("amount");
  const tiers = [];
  const mins = [].concat(input.tier_min ?? []);
  const pcts = [].concat(input.tier_pct ?? []);
  for (let i = 0; i < Math.max(mins.length, pcts.length); i++) {
    const m = num(mins[i]);
    const p = num(pcts[i]);
    if (m === null && p === null) continue;
    if (m === null || p === null || Number.isNaN(m) || Number.isNaN(p) || m < 1 || !Number.isInteger(m) || p <= 0 || p > 20) return bad("tiers");
    tiers.push({ min_units: m, pct: p });
  }
  if (tiers.length > MAX_TIERS) return bad("tiers");
  tiers.sort((a, b) => a.min_units - b.min_units);
  if (mode === "amount" && tiers.length) return bad("tiers");
  const trigger = TRIGGERS.includes(input.claim_trigger) ? input.claim_trigger : "contract";
  const paidPct = num(input.claim_paid_pct);
  if (trigger === "paid_pct" && (paidPct === null || Number.isNaN(paidPct) || paidPct <= 0 || paidPct > 100)) return bad("claim_paid_pct");
  const days = num(input.payment_days) ?? 60;
  if (Number.isNaN(days) || days < 0 || days > 365 || !Number.isInteger(days)) return bad("payment_days");
  const reg = num(input.registration_days);
  if (Number.isNaN(reg) || (reg !== null && (reg < 1 || reg > 365 || !Number.isInteger(reg)))) return bad("registration_days");
  const notes = String(input.notes ?? "").trim().slice(0, 1000) || null;
  return {
    fields: {
      mode,
      pct: mode === "pct" ? pct : null,
      amount: mode === "amount" ? Math.round(amount) : null,
      tiers,
      claim_trigger: trigger,
      claim_paid_pct: trigger === "paid_pct" ? paidPct : null,
      payment_days: days,
      registration_days: reg,
      notes
    }
  };
}

/** The rate for the n-th unit sold in the year: the highest tier reached, else the base rate. */
function rateFor(terms, unitsThisYear) {
  if (!terms || terms.mode !== "pct") return null;
  let rate = Number(terms.pct);
  for (const t of terms.tiers || []) if (unitsThisYear >= Number(t.min_units)) rate = Number(t.pct);
  return rate;
}

/** { rate_pct, expected_amount } for a deal: the terms when the project has them, else the deal's own commission. */
function expectedFor(terms, { price, unitsThisYear, dealTotal }) {
  if (terms?.mode === "amount") return { rate_pct: null, expected_amount: Math.round(Number(terms.amount)) };
  const rate = rateFor(terms, unitsThisYear);
  if (rate) return { rate_pct: rate, expected_amount: Math.round((Number(price) * rate) / 100) };
  return { rate_pct: null, expected_amount: Math.max(0, Math.round(Number(dealTotal) || 0)) };
}

// pg reads a DATE as local midnight, so a Date is read back by its local parts; strings are already "YYYY-MM-DD…".
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => (d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** The status after a payment: paid once the expected amount is reached, else partly paid. */
const statusAfterPayment = (expected, paid) => (paid >= expected ? "paid" : "partly_paid");

/** Overdue claims are reminded on the first overdue day and every 7 days after (no stored state, the same for every manager). */
function remindOverdue(c, today) {
  if (!["claimed", "partly_paid"].includes(c.status) || !c.due_on) return false;
  const late = daysBetween(isoDay(c.due_on), today);
  return late >= 1 && (late - 1) % REMIND_EVERY_DAYS === 0;
}

/** A client registration is reminded 7 days and 1 day before it lapses, while the commission is not claimed yet. */
function remindRegistration(c, today) {
  if (!["expected", "claimable"].includes(c.status) || !c.registration_expires_on) return false;
  const left = daysBetween(today, isoDay(c.registration_expires_on));
  return left === 7 || left === 1;
}

const overdueDays = (c, today) => (c.due_on && ["claimed", "partly_paid"].includes(c.status) ? Math.max(0, daysBetween(isoDay(c.due_on), today)) : 0);

module.exports = { STATUSES, OPEN, TRIGGERS, REMIND_EVERY_DAYS, termsFields, rateFor, expectedFor, addDays, daysBetween, isoDay, statusAfterPayment, remindOverdue, remindRegistration, overdueDays, num };
