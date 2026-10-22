// lib/financials.js — Financial Calculations, Schedule Generator & Resale Friction Logic
"use strict";

/**
 * Safely adds N calendar months to a Date object without day overflow.
 * Handles month-end drift (e.g., Jan 31 + 1 month -> Feb 28/29).
 */
function addMonths(date, months) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return new Date();

  const targetMonth = d.getMonth() + Number(months || 0);
  d.setMonth(targetMonth);

  // Handle edge-of-month shifts
  if (d.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    d.setDate(0);
  }
  return d;
}

/**
 * Formats a Date object or timestamp to standard DD/MM/YYYY.
 */
function formatDate(d) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return "-";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/* ====================================================================== */
/* 1. Core Plan Mathematics & Discount Calculations                      */
/* ====================================================================== */

/**
 * Calculates a complete financial breakdown for a single payment plan.
 * Anti-drift rounding: all currency values rounded to the nearest integer EGP.
 */
function calculatePlanSummary(basePrice, plan = {}) {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  const discountPct = Math.max(0, Number(plan.discount_pct || 0));
  const effectivePrice = Math.round(base * (1 - discountPct / 100));

  const dpPct = Math.max(0, Number(plan.down_payment_pct || 0));
  const downPayment = Math.round(effectivePrice * (dpPct / 100));

  // Process custom milestone/balloon payments (e.g. stage 2 DP or delivery balloons)
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  let totalMilestonesAmount = 0;
  const normalizedMilestones = milestones.map((m, idx) => {
    const pct = Math.max(0, Number(m.pct || 0));
    const amount = Math.round(effectivePrice * (pct / 100));
    totalMilestonesAmount += amount;
    return {
      index: idx + 1,
      type: m.type || "balloon",
      label: m.label || `دفعة مرحلية (${pct}%)`,
      pct,
      amount,
      due_after_months: Math.max(0, Number(m.due_after_months || 0))
    };
  });

  // Calculate remaining balance for regular equal installments
  const remainingForInstallments = Math.max(
    0,
    effectivePrice - downPayment - totalMilestonesAmount
  );

  const years = Math.max(1, Number(plan.years || 1));
  const frequency = plan.frequency === "monthly" ? "monthly" : "quarterly";
  const periodsPerYear = frequency === "monthly" ? 12 : 4;
  const totalInstallmentsCount = Math.max(1, years * periodsPerYear);

  const installmentAmount = Math.round(
    remainingForInstallments / totalInstallmentsCount
  );

  // Maintenance Deposit calculations (calculated on Base Price before discounts)
  const maintenancePct = Math.max(0, Number(plan.maintenance_pct ?? 8.0));
  const totalMaintenance = Math.round(base * (maintenancePct / 100));
  const maintenanceSplitCount = Math.max(
    1,
    Number(plan.maintenance_splits || 3)
  );
  const maintenancePerInstallment = Math.round(
    totalMaintenance / maintenanceSplitCount
  );

  const grossTotal = effectivePrice + totalMaintenance;

  return {
    plan_id: plan.plan_id || `${years}yr_${discountPct}disc`,
    name: plan.name || `تقسيط ${years} سنوات (خصم ${discountPct}%)`,
    years,
    frequency,
    discount_pct: discountPct,
    base_price: base,
    effective_price: effectivePrice,
    down_payment_pct: dpPct,
    down_payment: downPayment,
    milestones: normalizedMilestones,
    total_milestones_amount: totalMilestonesAmount,
    total_installments_count: totalInstallmentsCount,
    installment_amount: installmentAmount,
    maintenance_pct: maintenancePct,
    total_maintenance: totalMaintenance,
    maintenance_splits: maintenanceSplitCount,
    maintenance_per_split: maintenancePerInstallment,
    gross_total: grossTotal
  };
}

/* ====================================================================== */
/* 2. Interactive Cash-Flow Matching (Budget Filter)                      */
/* ====================================================================== */

/**
 * Matches broker financial constraints against an array of payment plans.
 * If zero plans match, returns the closest plan with the required gap.
 */
function filterMatchingPlans(basePrice, plans = [], constraints = {}) {
  const maxDP =
    constraints.maxDownPayment != null &&
    !isNaN(Number(constraints.maxDownPayment))
      ? Number(constraints.maxDownPayment)
      : Infinity;
  const maxQuarterly =
    constraints.maxQuarterly != null && !isNaN(Number(constraints.maxQuarterly))
      ? Number(constraints.maxQuarterly)
      : Infinity;
  const maxYears =
    constraints.maxYears != null && !isNaN(Number(constraints.maxYears))
      ? Number(constraints.maxYears)
      : Infinity;

  const validPlans = Array.isArray(plans) ? plans : [];
  const evaluated = validPlans.map((p) => calculatePlanSummary(basePrice, p));

  const matching = evaluated.filter((p) => {
    const dpOk = p.down_payment <= maxDP;
    const instOk = p.installment_amount <= maxQuarterly;
    const yearsOk = p.years <= maxYears;
    return dpOk && instOk && yearsOk;
  });

  if (matching.length > 0) {
    // Sort matching plans by highest discount percentage first
    matching.sort((a, b) => b.discount_pct - a.discount_pct);
    return { status: "matched", matches: matching, closest: null };
  }

  // If 0 matches, identify the closest plan by minimal financial delta
  let closest = null;
  let minGap = Infinity;

  for (const p of evaluated) {
    const dpGap = Math.max(0, p.down_payment - maxDP);
    const instGap = Math.max(0, p.installment_amount - maxQuarterly) * 4; // annualize quarterly gap
    const totalGap = dpGap + instGap;

    if (totalGap < minGap) {
      minGap = totalGap;
      closest = {
        plan: p,
        dpGap: Math.max(0, p.down_payment - maxDP),
        instGap: Math.max(0, p.installment_amount - maxQuarterly)
      };
    }
  }

  return { status: "unmatched", matches: [], closest };
}

/* ====================================================================== */
/* 3. Chronological Cash Flow Schedule Generator                          */
/* ====================================================================== */

/**
 * Builds the exact chronological schedule table: dates, installment types,
 * balloon payments, and scheduled maintenance milestones.
 * Guaranteed zero arithmetic drift: any fractional difference is corrected on the final installment.
 */
function generateDetailedSchedule(basePrice, plan) {
  const discountPct = plan.discount_pct || 0;
  const effectivePrice = Math.round(basePrice * (1 - discountPct / 100));

  const downPaymentPct = plan.down_payment_pct || 0;
  const downPayment = Math.round(effectivePrice * (downPaymentPct / 100));

  const milestones = plan.milestones || [];
  let totalMilestonesAmount = 0;
  const milestoneMap = new Map();

  for (const ms of milestones) {
    const amount = Math.round(effectivePrice * (ms.pct / 100));
    totalMilestonesAmount += amount;
    // Map due_after_months to quarterly period (Month 36 = Period 12)
    const period = Math.round(ms.due_after_months / 3);
    milestoneMap.set(period, { label: ms.label, amount });
  }

  const totalQuarters = (plan.years || 0) * 4;
  const remainingForInstallments =
    effectivePrice - downPayment - totalMilestonesAmount;
  const baseQuarterly =
    totalQuarters > 0
      ? Math.floor(remainingForInstallments / totalQuarters)
      : 0;

  const rows = [];
  // Row 0: Down payment
  rows.push({
    period: 0,
    type: "down_payment",
    label: "الدفعة المقدمة (Down Payment)",
    amount: downPayment
  });

  let runningSum = downPayment;

  for (let q = 1; q <= totalQuarters; q++) {
    const milestone = milestoneMap.get(q);
    let rowAmount = baseQuarterly;
    let label = `القسط الربع سنوي ${q}`;

    if (milestone) {
      rowAmount += milestone.amount;
      label += ` + ${milestone.label}`;
    }

    // On final installment, absorb any rounding delta
    if (q === totalQuarters) {
      rowAmount = effectivePrice - runningSum;
    }

    rows.push({
      period: q,
      type: milestone ? "milestone_installment" : "installment",
      label,
      amount: rowAmount
    });

    runningSum += rowAmount;
  }

  return {
    summary: {
      effective_price: effectivePrice,
      down_payment: downPayment,
      installment_amount: baseQuarterly,
      total_milestones_amount: totalMilestonesAmount
    },
    rows
  };
}

/* ====================================================================== */
/* 4. Resale Friction Cost Calculator                                     */
/* ====================================================================== */

/**
 * Computes resale cash requirements including owner equity, transfer fees,
 * overprice, and club memberships.
 */
function calculateResaleFinancials(listing = {}) {
  const details = listing.details || {};
  const price = Math.max(0, Number(listing.price_value || 0));

  const downPayment = Math.max(
    0,
    Number(listing.down_payment_value || details.down_payment_value || 0)
  );
  const overPrice = Math.max(0, Number(details.over_price || 0));
  const paidToOwner = downPayment > 0 ? downPayment : price;

  const clubFee = Math.max(0, Number(details.club_fee || 0));
  const transferFee = Math.max(0, Number(details.transfer_fee || 0));
  const commission = Math.max(0, Number(details.broker_commission || 0));

  const totalUpfrontRequired =
    paidToOwner + overPrice + clubFee + transferFee + commission;
  const remainingInstallmentsBalance = Math.max(0, price - paidToOwner);

  return {
    total_property_price: price,
    paid_to_owner: paidToOwner,
    over_price: overPrice,
    club_fee: clubFee,
    transfer_fee: transferFee,
    commission,
    total_upfront_cash: totalUpfrontRequired,
    remaining_balance: remainingInstallmentsBalance
  };
}

module.exports = {
  addMonths,
  formatDate,
  calculatePlanSummary,
  filterMatchingPlans,
  generateDetailedSchedule,
  calculateResaleFinancials
};
