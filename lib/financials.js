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

  const years = Math.max(0, Number(plan.years || 0));
  const frequency =
    plan.frequency === "monthly" || plan.installment_freq === "monthly"
      ? "monthly"
      : plan.frequency === "semi_annual" ||
        plan.installment_freq === "semi_annual"
      ? "semi_annual"
      : "quarterly";

  let periodsPerYear = 4;
  if (frequency === "monthly") periodsPerYear = 12;
  if (frequency === "semi_annual") periodsPerYear = 2;

  const totalInstallmentsCount =
    years > 0 ? Math.max(1, years * periodsPerYear) : 0;
  const installmentAmount =
    totalInstallmentsCount > 0
      ? Math.round(remainingForInstallments / totalInstallmentsCount)
      : 0;

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
  maintenancePct = 8
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

  const matching = evaluated.filter((p) => {
    const dpOk = p.down_payment <= maxDP;
    const instOk = p.installment_amount <= maxQuarterly;
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
    const instGap = Math.max(0, p.installment_amount - maxQuarterly) * 4;
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

  // Determine Step Frequency
  const frequency =
    plan.frequency === "monthly" || plan.installment_freq === "monthly"
      ? "monthly"
      : plan.frequency === "semi_annual" ||
        plan.installment_freq === "semi_annual"
      ? "semi_annual"
      : "quarterly";

  const stepMonths =
    frequency === "monthly" ? 1 : frequency === "semi_annual" ? 6 : 3;
  const periodsPerYear = 12 / stepMonths;
  const totalPeriods = Math.max(1, (plan.years || 1) * periodsPerYear);

  // Milestones Map (e.g. Delivery Balloon at Month 36)
  const milestones = Array.isArray(plan.milestones) ? plan.milestones : [];
  let totalMilestonesAmount = 0;
  const milestoneMap = new Map();

  for (const ms of milestones) {
    const amount = Math.round(effectivePrice * (Number(ms.pct || 0) / 100));
    totalMilestonesAmount += amount;
    const period = Math.max(
      1,
      Math.round(Number(ms.due_after_months || 0) / stepMonths)
    );
    milestoneMap.set(period, { label: ms.label || "دفعة مرحلية", amount });
  }

  const remainingForInstallments = Math.max(
    0,
    effectivePrice - downPayment - totalMilestonesAmount
  );
  const baseInstallment = Math.floor(remainingForInstallments / totalPeriods);

  // Maintenance Schedule (Split across final installments or default 3 splits)
  const maintenancePct = Math.max(
    0,
    Number(plan.maintenance_pct ?? plan.maintenancePct ?? 8.0)
  );
  const totalMaintenance = Math.round(base * (maintenancePct / 100));
  const maintenanceSplits = Math.max(1, Number(plan.maintenance_splits || 3));
  const maintPerSplit = Math.round(totalMaintenance / maintenanceSplits);

  const maintenanceStartPeriod = Math.max(
    1,
    totalPeriods - maintenanceSplits + 1
  );
  const maintenanceMap = new Map();
  let scheduledMaintSum = 0;

  for (let q = maintenanceStartPeriod; q <= totalPeriods; q++) {
    const isFinalSplit = q === totalPeriods;
    const splitAmt = isFinalSplit
      ? totalMaintenance - scheduledMaintSum
      : maintPerSplit;
    maintenanceMap.set(q, splitAmt);
    scheduledMaintSum += splitAmt;
  }

  const rows = [];
  const baseDate = new Date(startDate);

  // Row 0: Down Payment
  rows.push({
    period: 0,
    due_date: formatDate(baseDate),
    type: "down_payment",
    label: "الدفعة المقدمة (Down Payment)",
    amount: downPayment,
    maintenance_amount: 0,
    total_outflow: downPayment,
    running_total: downPayment
  });

  let runningContractSum = downPayment;
  let runningOutflowSum = downPayment;

  for (let q = 1; q <= totalPeriods; q++) {
    const dueDate = addMonths(baseDate, q * stepMonths);
    const milestone = milestoneMap.get(q);
    const maintAmount = maintenanceMap.get(q) || 0;

    let rowAmount = baseInstallment;
    const freqLabel =
      frequency === "monthly"
        ? "الشهري"
        : frequency === "semi_annual"
        ? "النصف سنوي"
        : "الربع سنوي";
    let label = `القسط ${freqLabel} ${q}`;

    if (milestone) {
      rowAmount += milestone.amount;
      label += ` + ${milestone.label}`;
    }

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
 * Formats a forwardable client ad copy for a single payment plan.
 */
function formatSinglePlanAdCopy(
  listing,
  broker,
  selectedPlanIdOrYears,
  lang = "ar"
) {
  const price = Number(listing.price_value) || 0;
  const plans = listing.payment_terms?.plans || [];
  const calculated = calculateDeveloperPaymentPlans(
    price,
    plans,
    listing.maintenance_pct || 8
  );

  const plan =
    calculated.find(
      (p) =>
        String(p.planId) === String(selectedPlanIdOrYears) ||
        String(p.years) === String(selectedPlanIdOrYears)
    ) || calculated[0];

  if (!plan) return "";

  const compound = listing.compound || listing.location || "";
  const area = listing.area_value || "";
  const beds = listing.bedrooms || 1;
  const details = listing.details || {};
  const finishing =
    details.finishing_en || details.finishing || "Standard Finishing";
  const brokerName = broker.name || "";
  const brokerPhone = broker.phone_normalized || broker.phone_number || "";

  if (lang === "en") {
    return `🌟 *Prime Opportunity at ${compound}*
Direct Developer Inventory | Certified Payment Matrix

📌 *Property Overview:*
• Typology: ${listing.property_type || "Apartment"}
• Area: ${area} SQM
• Layout: ${beds} Bedrooms | ${
      details.bathrooms ? `${details.bathrooms} Bathrooms` : ""
    }
• Handover: ${
      listing.delivery_date ||
      (details.ready_to_move ? "Ready to Move" : "Under Construction")
    }
• Finishing: ${finishing}

💰 *Financial Breakdown (${plan.nameEn}):*
• Official List Price: ${price.toLocaleString()} EGP
${
  plan.discountPct > 0
    ? `• Plan Discount (${
        plan.discountPct
      }%): ${plan.effectivePrice.toLocaleString()} EGP\n`
    : ""
}• Down Payment (${
      plan.downPaymentPct
    }%): ${plan.downPaymentValue.toLocaleString()} EGP
• Equal Installment: ${plan.installmentValue.toLocaleString()} EGP (${
      plan.frequency
    })
• Tenure: ${plan.years} Years (${plan.totalInstallments} payments)
• Maintenance Deposit (${
      plan.maintenancePct
    }%): ${plan.maintenanceValue.toLocaleString()} EGP (due upon delivery)

📞 *For inquiries and private viewings:*
${brokerName} | ${brokerPhone}`.trim();
  }

  // Arabic Professional Real Estate Copy
  const bedroomsDisplay = beds > 0 ? `${beds} غرف نوم` : "استوديو";
  const bathroomsDisplay = details.bathrooms
    ? ` + ${details.bathrooms} حمام`
    : "";
  const nannyDisplay = details.nanny_room ? " + غرفة مربية" : "";
  const dressingDisplay = details.has_dressing_room ? " + دريسنج رووم" : "";
  const deliveryStatus = details.ready_to_move
    ? "جاهز للاستلام الفوري (Ready to Move)"
    : listing.delivery_date
    ? `استلام ${listing.delivery_date}`
    : "تحت الإنشاء";

  const finishingArabic =
    {
      core_and_shell: "نصف تشطيب (محارة وحلوق)",
      semi_finished: "تشطيب جزئي",
      fully_finished: "تشطيب كامل الترا سوبر لوكس",
      furnished_with_ac: "مفروش بالكامل بالتكييفات"
    }[details.finishing] ||
    details.finishing ||
    "حسب التعاقد";

  return `🌟 *فرصة استثمارية مميزة في مشروع ${compound}*
مباشرة من الشركة المطورة وبأفضل أنظمة السداد.

📌 *مواصفات وتفاصيل الوحدة:*
• النوع: ${listing.property_type || "شقة سكنية"}
• المساحة: ${area} متر مربع
• التقسيم الداخلي: ${bedroomsDisplay}${dressingDisplay}${bathroomsDisplay}${nannyDisplay}
• موعد الاستلام: ${deliveryStatus}
• حالة التشطيب: ${finishingArabic}

💰 *تفاصيل السداد المعتمدة (${plan.nameAr}):*
• إجمالي السعر الرسمي: ${price.toLocaleString()} جنيه
${
  plan.discountPct > 0
    ? `• السعر بعد خصم (${
        plan.discountPct
      }%): ${plan.effectivePrice.toLocaleString()} جنيه\n`
    : ""
}• الدفعة المقدمة (${
    plan.downPaymentPct
  }%): ${plan.downPaymentValue.toLocaleString()} جنيه
• القسط المتساوي: ${plan.installmentValue.toLocaleString()} جنيه (${
    plan.frequency === "monthly" ? "شهري" : "ربع سنوي"
  })
• فترة السداد: ${plan.years} سنوات (${plan.totalInstallments} قسط)
• وديعة الصيانة (${
    plan.maintenancePct
  }%): ${plan.maintenanceValue.toLocaleString()} جنيه (تسدد قبل الاستلام)

📞 *للتواصل ومراجعة شيت الأقساط والمعاينة:*
${brokerName} | ${brokerPhone}`.trim();
}

module.exports = {
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
