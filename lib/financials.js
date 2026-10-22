// lib/financials.js
"use strict";

/**
 * Helper to add N calendar months to a Date object safely without day overflow.
 */
function addMonths(date, months) {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  // Handle edge-of-month shifts (e.g., Jan 31 -> Feb 28)
  if (d.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    d.setDate(0);
  }
  return d;
}

/**
 * Formats a Date object to standard DD/MM/YYYY.
 */
function formatDate(d) {
  const date = new Date(d);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

/* ====================================================================== */
/* 1. Core Plan Mathematics & Discount Calculations                      */
/* ====================================================================== */

/**
 * Calculates a complete financial overview for a single plan.
 * Anti-drift rounding: all values rounded to the nearest integer EGP.
 */
function calculatePlanSummary(basePrice, plan = {}) {
  const base = Math.max(0, Number(basePrice) || 0);
  const discountPct = Number(plan.discount_pct || 0);
  const effectivePrice = Math.round(base * (1 - discountPct / 100));

  const dpPct = Number(plan.down_payment_pct || 0);
  const downPayment = Math.round(effectivePrice * (dpPct / 100));

  // Process custom milestone/balloon payments (e.g., stage 2 DP or delivery balloons)
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  let totalMilestonesAmount = 0;
  const normalizedMilestones = milestones.map((m, idx) => {
    const pct = Number(m.pct || 0);
    const amount = Math.round(effectivePrice * (pct / 100));
    totalMilestonesAmount += amount;
    return {
      index: idx + 1,
      type: m.type || "balloon",
      label: m.label || `دفعة مرحلية (${pct}%)`,
      pct,
      amount,
      due_after_months: Number(m.due_after_months || 0)
    };
  });

  // Calculate remaining balance for regular equal installments
  const remainingForInstallments = Math.max(
    0,
    effectivePrice - downPayment - totalMilestonesAmount
  );

  const years = Math.max(1, Number(plan.years || 1));
  const frequency = plan.frequency || "quarterly"; // 'quarterly' | 'monthly'
  const periodsPerYear = frequency === "monthly" ? 12 : 4;
  const totalInstallmentsCount = years * periodsPerYear;

  const installmentAmount =
    totalInstallmentsCount > 0
      ? Math.round(remainingForInstallments / totalInstallmentsCount)
      : 0;

  // Maintenance Deposit calculations (usually calculated on Base Price)
  const maintenancePct = Number(plan.maintenance_pct ?? 8.0);
  const totalMaintenance = Math.round(base * (maintenancePct / 100));
  const maintenanceSplitCount = Number(plan.maintenance_splits || 3);
  const maintenancePerInstallment =
    maintenanceSplitCount > 0
      ? Math.round(totalMaintenance / maintenanceSplitCount)
      : 0;

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
  const maxDP = constraints.maxDownPayment
    ? Number(constraints.maxDownPayment)
    : Infinity;
  const maxQuarterly = constraints.maxQuarterly
    ? Number(constraints.maxQuarterly)
    : Infinity;
  const maxYears = constraints.maxYears
    ? Number(constraints.maxYears)
    : Infinity;

  const evaluated = plans.map((p) => calculatePlanSummary(basePrice, p));

  const matching = evaluated.filter((p) => {
    const dpOk = p.down_payment <= maxDP;
    const instOk = p.installment_amount <= maxQuarterly;
    const yearsOk = p.years <= maxYears;
    return dpOk && instOk && yearsOk;
  });

  if (matching.length > 0) {
    // Sort matching plans by highest discount first
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
 */
function generateDetailedSchedule(basePrice, plan, startDate = new Date()) {
  const summary = calculatePlanSummary(basePrice, plan);
  const rows = [];
  let runningTotal = 0;

  // 1. Row 0: Down Payment
  runningTotal += summary.down_payment;
  rows.push({
    period: 0,
    due_date_raw: new Date(startDate),
    due_date: formatDate(startDate),
    type: "down_payment",
    label: summary.down_payment > 0 ? "المقدم التعاقدي" : "بدون مقدم",
    amount: summary.down_payment,
    maintenance_amount: 0,
    total_outflow: summary.down_payment,
    running_total: runningTotal
  });

  const monthsPerStep = summary.frequency === "monthly" ? 1 : 3;
  const maintenanceStartYear = Number(plan.maintenance_start_year || 1); // e.g. starts at year 1 (month 12)
  let maintenancePaidSplits = 0;

  // 2. Installments & Periodic Milestones
  for (let i = 1; i <= summary.total_installments_count; i++) {
    const stepMonths = i * monthsPerStep;
    const stepDate = addMonths(startDate, stepMonths);

    let stepBaseAmount = summary.installment_amount;
    let stepMaintenanceAmount = 0;
    const notes = [];

    // Check if any milestone/balloon is due in this exact month
    const matchingMilestones = summary.milestones.filter(
      (m) => m.due_after_months === stepMonths
    );
    for (const m of matchingMilestones) {
      stepBaseAmount += m.amount;
      notes.push(m.label);
    }

    // Check if maintenance installment is due (annual check at months 12, 24, 36...)
    const isAnnualStep = stepMonths % 12 === 0;
    const currentYear = stepMonths / 12;
    if (
      isAnnualStep &&
      currentYear >= maintenanceStartYear &&
      maintenancePaidSplits < summary.maintenance_splits
    ) {
      stepMaintenanceAmount = summary.maintenance_per_split;
      maintenancePaidSplits++;
      notes.push(
        `وديعة صيانة (${maintenancePaidSplits}/${summary.maintenance_splits})`
      );
    }

    // Last installment discrepancy correction to ensure perfect arithmetic sum
    if (i === summary.total_installments_count) {
      const scheduledBaseTotal =
        rows
          .filter((r) => r.type !== "down_payment")
          .reduce((acc, r) => acc + (r.amount - (r.milestone_amount || 0)), 0) +
        summary.installment_amount;
      const expectedInstallmentsSum =
        summary.effective_price -
        summary.down_payment -
        summary.total_milestones_amount;
      const discrepancy = expectedInstallmentsSum - scheduledBaseTotal;
      stepBaseAmount += discrepancy;
    }

    const totalStepOutflow = stepBaseAmount + stepMaintenanceAmount;
    runningTotal += totalStepOutflow;

    rows.push({
      period: i,
      due_date_raw: stepDate,
      due_date: formatDate(stepDate),
      type: "installment",
      label: notes.length ? `القسط ${i} + ${notes.join(" + ")}` : `القسط ${i}`,
      amount: stepBaseAmount,
      maintenance_amount: stepMaintenanceAmount,
      total_outflow: totalStepOutflow,
      running_total: runningTotal
    });
  }

  return { summary, rows };
}

/* ====================================================================== */
/* 4. Resale Friction Cost Calculator                                     */
/* ====================================================================== */

/**
 * Computes resale cash requirements including transfer fees and club memberships.
 */
function calculateResaleFinancials(listing = {}) {
  const details = listing.details || {};
  const price = Number(listing.price_value || 0);

  const downPayment = Number(
    listing.down_payment_value || details.down_payment_value || 0
  );
  const overPrice = Number(details.over_price || 0);
  const paidToOwner = downPayment > 0 ? downPayment : price;

  const clubFee = Number(details.club_fee || 0);
  const transferFee = Number(details.transfer_fee || 0);
  const commission = Number(details.broker_commission || 0);

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
