// domain/clientPlans.js — A unit's payment plans as a client may see them (Release A, C7), pure: the plan terms that
// matter to a buyer (down payment, years, frequency, milestones, maintenance, extra fees) and their worked numbers
// (lib/financials.js), never a plan's source, ids or notes. schedule() is the dated table behind the PDF.
"use strict";

const F = require("../lib/financials");

const FREQ = { monthly: ["شهري", "monthly"], quarterly: ["ربع سنوي", "quarterly"], semi_annual: ["نص سنوي", "semi-annual"], annual: ["سنوي", "annual"] };
const L = (lang, ar, en) => (lang === "en" ? en : ar);
const known = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v));

/** The plan with the unit's own maintenance and delivery (the same merge as the Excel export). */
function withTerms(plan, listing) {
  const m = F.maintenanceTerms(plan, listing);
  return { ...plan, maintenance_pct: m.pct, maintenance_due: m.due, delivery_after_months: plan.delivery_after_months ?? F.planDeliveryMonths(listing) };
}

/** The sale price the plans run on (0 when none). */
const basePrice = (listing) => (listing.listing_type === "rent" ? 0 : Math.round(Number(listing.price_value) || 0));

/** Client-safe plans with their numbers: [{ index, name, down_payment_pct, years, frequency, frequency_label, summary, fees }]. */
function clientPlans(listing, lang = "ar") {
  const price = basePrice(listing);
  if (!price) return [];
  const plans = (listing.payment_terms?.plans || []).filter((p) => known(p.down_payment_pct) || known(p.years));
  return plans.slice(0, 8).map((p, index) => {
    const merged = withTerms(p, listing);
    const s = F.calculatePlanSummary(price, merged);
    const frequency = F.normalizeFrequency(merged);
    return {
      index,
      name: String(p.name || (Number(s.years) ? `${s.down_payment_pct}% / ${s.years}y` : L(lang, "كاش", "Cash"))).slice(0, 80),
      down_payment_pct: s.down_payment_pct,
      years: s.years,
      frequency,
      frequency_label: L(lang, ...(FREQ[frequency] || FREQ.quarterly)),
      discount_pct: s.discount_pct,
      summary: {
        price: s.effective_price,
        down_payment: s.down_payment,
        installments: s.total_installments_count,
        installment: s.installment_amount,
        milestones: s.milestones.map((m) => ({ pct: m.pct, amount: m.amount, months: m.due_after_months })),
        maintenance: s.maintenance_pct ? s.total_maintenance : null,
        maintenance_pct: s.maintenance_pct
      },
      fees: (p.extra_fees || []).filter((f) => f && f.label && Number(f.amount) > 0).slice(0, 4).map((f) => ({ label: String(f.label).slice(0, 60), amount: Math.round(Number(f.amount)) }))
    };
  });
}

/** The dated schedule of one plan from a start day: { plan, rows: [{ n, date, label, amount, maintenance, total }], totals }. */
function schedule(listing, index, { lang = "ar", start = new Date() } = {}) {
  const plans = clientPlans(listing, lang);
  const plan = plans[index];
  if (!plan) return null;
  const raw = (listing.payment_terms?.plans || []).filter((p) => known(p.down_payment_pct) || known(p.years))[index];
  const out = F.generateDetailedSchedule(basePrice(listing), withTerms(raw, listing), start);
  const rows = out.rows.map((r) => ({
    n: r.period,
    date: r.due_date,
    label:
      r.type === "down_payment"
        ? L(lang, "المقدم", "Down payment")
        : r.type === "cash_payment"
          ? L(lang, "الدفع كاش", "Cash payment")
          : `${L(lang, "قسط", "Installment")} ${r.period}${r.type === "milestone_installment" ? L(lang, " + دفعة", " + milestone") : ""}`,
    amount: r.amount,
    maintenance: r.maintenance_amount || 0,
    total: r.total_outflow
  }));
  return {
    plan,
    rows,
    totals: { price: out.summary.effective_price, maintenance: out.summary.total_maintenance, maintenance_scheduled: out.summary.maintenance_scheduled, gross: out.summary.gross_total }
  };
}

module.exports = { clientPlans, schedule, basePrice };
