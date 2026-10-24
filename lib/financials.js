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
/* 0. Frequencies and maintenance terms (data, not prose)                 */
/* ====================================================================== */

// Months per installment. Unknown frequencies fall back to quarterly (the market norm for plans).
const STEP_MONTHS = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };

/** Canonical frequency key: monthly | quarterly | semi_annual | annual. */
function normalizeFrequency(plan = {}) {
  const raw = String(plan.frequency || plan.installment_freq || "").toLowerCase().replace(/[\s-]+/g, "_");
  const alias = { semiannual: "semi_annual", yearly: "annual" };
  const k = alias[raw] || raw;
  return STEP_MONTHS[k] ? k : "quarterly";
}

/**
 * Maintenance terms as data (Q-F): { pct, due, splits }.
 * pct is null when unknown (never an invented 8%). due: "delivery" | "installments" | "contract".
 * Reads plan → listing payment_terms.maintenance → listing.maintenance_pct, first stated wins.
 */
function maintenanceTerms(plan = {}, listing = {}) {
  const fromTerms = listing.payment_terms?.maintenance || {};
  const pctRaw = plan.maintenance_pct ?? plan.maintenancePct ?? fromTerms.pct ?? listing.maintenance_pct;
  const pct = pctRaw === null || pctRaw === undefined || pctRaw === "" ? null : Math.max(0, Number(pctRaw));
  const due = plan.maintenance_due || fromTerms.due || (pct ? "delivery" : "contract");
  const splits = Math.max(1, Number(plan.maintenance_splits || fromTerms.splits || 1));
  return { pct: Number.isFinite(pct) ? pct : null, due, splits };
}

/** Months from today to the listing's delivery (start of its quarter/month); null when unknown. */
function planDeliveryMonths(listing = {}, now = new Date()) {
  if (!listing.delivery_year) return null;
  const month = listing.delivery_month || (listing.delivery_quarter ? (listing.delivery_quarter - 1) * 3 + 1 : 12);
  const months = (Number(listing.delivery_year) - now.getFullYear()) * 12 + (month - (now.getMonth() + 1));
  return months > 0 ? months : null;
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

  const years = Math.max(0, Number(plan.years || 0));
  const frequency = normalizeFrequency(plan);
  const periodsPerYear = 12 / STEP_MONTHS[frequency];

  // F9: a fractional tenure still gives a whole number of installments.
  const totalInstallmentsCount =
    years > 0 ? Math.max(1, Math.round(years * periodsPerYear)) : 0;
  const installmentAmount =
    totalInstallmentsCount > 0
      ? Math.round(remainingForInstallments / totalInstallmentsCount)
      : 0;

  // Maintenance deposit on the base price before discounts; unknown % stays unknown (F1).
  const maint = maintenanceTerms(plan);
  const maintenancePct = maint.pct;
  const totalMaintenance = maintenancePct ? Math.round(base * (maintenancePct / 100)) : 0;
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
    planId: plan.plan_id || `${years}yr_${discountPct}disc`,
    name:
      plan.name ||
      plan.name_ar ||
      (years === 0
        ? "الدفع كاش"
        : `تقسيط ${years} سنوات (خصم ${discountPct}%)`),
    nameAr:
      plan.name_ar || (years === 0 ? "الدفع كاش" : `تقسيط ${years} سنوات`),
    nameEn:
      plan.name_en || (years === 0 ? "Cash Payment" : `${years}-Year Plan`),
    years,
    frequency,
    discount_pct: discountPct,
    discountPct,
    base_price: base,
    effective_price: effectivePrice,
    effectivePrice,
    down_payment_pct: dpPct,
    downPaymentPct: dpPct,
    down_payment: downPayment,
    downPaymentValue: downPayment,
    milestones: normalizedMilestones,
    total_milestones_amount: totalMilestonesAmount,
    total_installments_count: totalInstallmentsCount,
    totalInstallments: totalInstallmentsCount,
    installment_amount: installmentAmount,
    installmentValue: installmentAmount,
    maintenance_pct: maintenancePct,
    maintenancePct,
    maintenance_due: maint.due,
    total_maintenance: totalMaintenance,
    maintenanceValue: totalMaintenance,
    maintenance_splits: maintenanceSplitCount,
    maintenance_per_split: maintenancePerInstallment,
    gross_total: grossTotal
  };
}

/**
 * Plural mapper expected by lib/excel.js and interactive controllers.
 */
function calculateDeveloperPaymentPlans(
  basePrice,
  plans = [],
  maintenancePct = null
) {
  const price = Number(basePrice) || 0;
  if (price <= 0 || !Array.isArray(plans)) return [];

  return plans.map((p) => {
    const merged = {
      ...p,
      maintenance_pct: p.maintenance_pct ?? maintenancePct
    };
    return calculatePlanSummary(price, merged);
  });
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

  // F8: a budget per quarter is compared with each plan's installment converted to a quarter.
  const perQuarter = (p) => Math.round(p.installment_amount * (3 / STEP_MONTHS[p.frequency]));
  const matching = evaluated.filter((p) => {
    const dpOk = p.down_payment <= maxDP;
    const instOk = perQuarter(p) <= maxQuarterly;
    const yearsOk = p.years <= maxYears;
    return dpOk && instOk && yearsOk;
  });

  if (matching.length > 0) {
    matching.sort((a, b) => b.discount_pct - a.discount_pct);
    return { status: "matched", matches: matching, closest: null };
  }

  let closest = null;
  let minGap = Infinity;

  for (const p of evaluated) {
    const dpGap = Math.max(0, p.down_payment - maxDP);
    const instGap = Math.max(0, perQuarter(p) - maxQuarterly) * 4;
    const totalGap = dpGap + instGap;

    if (totalGap < minGap) {
      minGap = totalGap;
      closest = {
        plan: p,
        dpGap: Math.max(0, p.down_payment - maxDP),
        instGap: Math.max(0, perQuarter(p) - maxQuarterly)
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
 * Supports quarterly, monthly, and semi-annual intervals.
 * Corrects fractional difference on the final installment.
 */
function generateDetailedSchedule(basePrice, plan, startDate = new Date()) {
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  const discountPct = Number(plan.discount_pct || plan.discountPct || 0);
  const effectivePrice = Math.round(base * (1 - discountPct / 100));

  const downPaymentPct = Number(
    plan.down_payment_pct || plan.downPaymentPct || 0
  );
  const downPayment = Math.round(effectivePrice * (downPaymentPct / 100));

  const frequency = normalizeFrequency(plan);
  const stepMonths = STEP_MONTHS[frequency];
  const periodsPerYear = 12 / stepMonths;
  const years = Math.max(0, Number(plan.years || 0));
  // F4: a cash plan (years 0) has no installment periods at all.
  const totalPeriods = years > 0 ? Math.max(1, Math.round(years * periodsPerYear)) : 0;

  // Milestones per period; F3: several milestones may fall due in the same period.
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  let totalMilestonesAmount = 0;
  const milestoneMap = new Map();

  for (const ms of milestones) {
    const amount = Math.round(effectivePrice * (Number(ms.pct || 0) / 100));
    totalMilestonesAmount += amount;
    const period = Math.min(
      Math.max(1, totalPeriods),
      Math.max(1, Math.round(Number(ms.due_after_months || 0) / stepMonths))
    );
    const list = milestoneMap.get(period) || [];
    list.push({ label: ms.label || "دفعة مرحلية", amount });
    milestoneMap.set(period, list);
  }

  const remainingForInstallments = Math.max(
    0,
    effectivePrice - downPayment - totalMilestonesAmount
  );
  const baseInstallment = totalPeriods
    ? Math.floor(remainingForInstallments / totalPeriods)
    : 0;

  // F1/F2: maintenance is scheduled only when its % is known, and at delivery
  // (plan.delivery_after_months), never at the end of the installment term.
  const maint = maintenanceTerms(plan);
  const totalMaintenance = maint.pct ? Math.round(base * (maint.pct / 100)) : 0;
  const maintenanceMap = new Map();
  const deliveryMonths = Number(plan.delivery_after_months);
  if (totalMaintenance > 0 && deliveryMonths > 0) {
    const splits = Math.max(1, Number(plan.maintenance_splits || 1));
    const first = Math.max(1, Math.round(deliveryMonths / stepMonths) - splits + 1);
    let scheduled = 0;
    for (let i = 0; i < splits; i++) {
      const amt = i === splits - 1 ? totalMaintenance - scheduled : Math.round(totalMaintenance / splits);
      maintenanceMap.set(first + i, amt);
      scheduled += amt;
    }
  }

  const rows = [];
  const baseDate = new Date(startDate);

  // Row 0: Down Payment (the whole price for a cash plan)
  const firstAmount = totalPeriods ? downPayment : effectivePrice;
  rows.push({
    period: 0,
    due_date: formatDate(baseDate),
    type: totalPeriods ? "down_payment" : "cash_payment",
    label: totalPeriods ? "الدفعة المقدمة (Down Payment)" : "الدفع كاش (Cash Payment)",
    amount: firstAmount,
    maintenance_amount: 0,
    total_outflow: firstAmount,
    running_total: firstAmount
  });

  let runningContractSum = firstAmount;
  let runningOutflowSum = firstAmount;

  for (let q = 1; q <= totalPeriods; q++) {
    const dueDate = addMonths(baseDate, q * stepMonths);
    const dueMilestones = milestoneMap.get(q) || [];
    const maintAmount = maintenanceMap.get(q) || 0;

    let rowAmount = baseInstallment;
    const freqLabel = { monthly: "الشهري", quarterly: "الربع سنوي", semi_annual: "النصف سنوي", annual: "السنوي" }[frequency];
    let label = `القسط ${freqLabel} ${q}`;

    for (const milestone of dueMilestones) {
      rowAmount += milestone.amount;
      label += ` + ${milestone.label}`;
    }
    const milestone = dueMilestones.length > 0;

    // On final installment, absorb rounding delta to guarantee sum(amount) === effectivePrice
    if (q === totalPeriods) {
      rowAmount = effectivePrice - runningContractSum;
    }

    runningContractSum += rowAmount;
    const rowOutflow = rowAmount + maintAmount;
    runningOutflowSum += rowOutflow;

    rows.push({
      period: q,
      due_date: formatDate(dueDate),
      type: milestone ? "milestone_installment" : "installment",
      label,
      amount: rowAmount,
      maintenance_amount: maintAmount,
      total_outflow: rowOutflow,
      running_total: runningContractSum
    });
  }

  return {
    summary: {
      base_price: base,
      effective_price: effectivePrice,
      down_payment: downPayment,
      installment_amount: baseInstallment,
      total_milestones_amount: totalMilestonesAmount,
      total_maintenance: totalMaintenance,
      maintenance_pct: maint.pct,
      maintenance_due: maint.due,
      maintenance_scheduled: maintenanceMap.size > 0,
      frequency,
      gross_total: effectivePrice + totalMaintenance
    },
    rows
  };
}

/* ====================================================================== */
/* 4. Resale Balances & Friction Calculator                              */
/* ====================================================================== */

/**
 * Reconciles resale financial figures.
 * Enforces: Total Asking Price = Upfront Cash + Remaining Developer Debt.
 */
function reconcileResaleBalance({ totalPrice, upfrontCash, remainingDebt }) {
  const total = Number(totalPrice) || 0;
  const upfront = Number(upfrontCash) || 0;
  const debt = Number(remainingDebt) || 0;

  const sum = upfront + debt;
  const diff = Math.abs(total - sum);

  return {
    valid: diff < 1,
    discrepancy: total - sum
  };
}

/**
 * Computes resale cash requirements including owner equity, transfer fees,
 * overprice, and club memberships.
 */
function calculateResaleFinancials(listing = {}) {
  const details = listing.details || {};
  const price = Math.max(0, Number(listing.price_value || 0));

  const upfront = Number(
    details.total_upfront_cash ||
      details.down_payment_value ||
      listing.down_payment_value ||
      0
  );
  const overPrice = Math.max(0, Number(details.over_price || 0));
  const paidToOwner = upfront > 0 ? upfront : price;

  const clubFee = Math.max(0, Number(details.club_fee || 0));
  const transferFee = Math.max(0, Number(details.transfer_fee || 0));
  const commission = Math.max(0, Number(details.broker_commission || 0));

  const totalUpfrontRequired =
    paidToOwner + overPrice + clubFee + transferFee + commission;
  const remainingInstallmentsBalance = Math.max(
    0,
    Number(
      details.remaining_debt || details.remaining_balance || price - paidToOwner
    )
  );

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

/* ====================================================================== */
/* 5. Client WhatsApp Ad Copy Formatter                                  */
/* ====================================================================== */

/**
 * Forwardable client copy for one payment plan (delegates to the single template, domain/describe.js).
 */
function formatSinglePlanAdCopy(listing, broker, selectedPlanIdOrYears, lang = "ar") {
  return require("../domain/describe").planCopy(listing, broker, selectedPlanIdOrYears, { lang });
}

module.exports = {
  STEP_MONTHS,
  normalizeFrequency,
  planDeliveryMonths,
  maintenanceTerms,
  addMonths,
  formatDate,
  calculatePlanSummary,
  calculateDeveloperPaymentPlans,
  filterMatchingPlans,
  generateDetailedSchedule,
  reconcileResaleBalance,
  calculateResaleFinancials,
  formatSinglePlanAdCopy
};
