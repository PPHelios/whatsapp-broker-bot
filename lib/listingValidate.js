// lib/listingValidate.js — Draft completeness gate, draft validation and vision draft validation (photo roles and
// ranking). Pure; split out of lib/listing.js.
"use strict";

const { isVillaTypology, isStudioTypology } = require("./listingText");

const ROLES = [
  "view",
  "garden",
  "exterior",
  "facade",
  "reception",
  "living",
  "bedroom",
  "kitchen",
  "bathroom",
  "document",
  "other"
];

/* --------------------------------------------------------------------------- */
/* 6. Context-Aware Completeness & Validation Gatekeeper                      */
/* --------------------------------------------------------------------------- */

function checkDraftCompleteness(draft, parsedContext = {}) {
  const ctx = parsedContext || {};
  const lang = ctx.lang || "ar";
  const blockers = [];
  const warnings = [];

  const rawPropType = String(draft.property_type || "")
    .toLowerCase()
    .trim();
  const isLanded = isVillaTypology(rawPropType);
  const isStudio = isStudioTypology(rawPropType, draft.bedrooms);

  // Blocker rules
  if (!draft.price_value || Number(draft.price_value) <= 0) {
    blockers.push({
      field: "price_value",
      message:
        lang === "en" ? "Asking price is required" : "السعر الإجمالي مطلوب"
    });
  }
  if (!draft.compound || !String(draft.compound).trim()) {
    blockers.push({
      field: "compound",
      message:
        lang === "en"
          ? "Compound / Project name is required"
          : "اسم الكمبوند أو المشروع مطلوب"
    });
  }
  if (!draft.area_value || Number(draft.area_value) <= 0) {
    blockers.push({
      field: "area_value",
      message:
        lang === "en"
          ? "Unit area in sqm is required"
          : "المساحة بالمتر المربع مطلوبة"
    });
  }

  // Bedroom rule: Studios are open-concept (0 bedrooms is completely valid)
  if (!isStudio) {
    const beds =
      draft.bedrooms !== undefined && draft.bedrooms !== null
        ? Number(draft.bedrooms)
        : null;

    if (beds === null || isNaN(beds) || beds < 0) {
      blockers.push({
        field: "bedrooms",
        message:
          lang === "en" ? "Bedrooms count is required" : "عدد الغرف مطلوب"
      });
    } else if (beds === 0 && !isLanded) {
      // 0 bedrooms on residential unit: automatically adapt to studio
      draft.property_type = "studio";
    }
  }

  // Floor warning: Strictly exclude landed properties (villas, townhouses, twinhouses)
  const floorVal = draft.details?.floor ?? draft.floor;
  if (
    !isLanded &&
    (floorVal === null ||
      floorVal === undefined ||
      String(floorVal).trim() === "")
  ) {
    warnings.push({
      field: "floor",
      label_ar: "الدور",
      label_en: "Floor",
      note_ar: "رقم الدور غير محدد",
      note_en: "Floor level is missing",
      message: lang === "en" ? "Floor level is missing" : "رقم الدور غير محدد"
    });
  }

  // Resale financial balance check:
  // Enforce: Total Asking Price = Upfront Cash to Owner + Remaining Developer Debt
  let deltaWarning = null;
  const price = Number(draft.price_value) || Number(ctx.priceValue) || 0;
  const details = draft.details || {};
  const dp = Number(
    details.down_payment_value ?? draft.down_payment_value ?? 0
  );
  const over = Number(details.over_price ?? 0);
  const club = Number(details.club_fee ?? 0);
  const transfer = Number(details.transfer_fee ?? 0);
  const rem = Number(details.remaining_balance ?? draft.remaining_balance ?? 0);

  const upfrontCash =
    Number(details.total_upfront_cash) || dp + over + club + transfer;

  if (price > 0 && upfrontCash > 0 && rem > 0) {
    const sum = upfrontCash + rem;
    const diff = Math.abs(price - sum);
    if (diff > 100) {
      deltaWarning = {
        diff,
        price,
        upfront: upfrontCash,
        remaining: rem,
        message_en: `Financial Reconciliation Alert: Total Price (${price.toLocaleString()} EGP) ≠ Upfront Cash (${upfrontCash.toLocaleString()} EGP) + Remaining Debt (${rem.toLocaleString()} EGP). Discrepancy: ${diff.toLocaleString()} EGP.`,
        message_ar: `تنبيه المطابقة المالية: إجمالي السعر (${price.toLocaleString()} ج.م) لا يتطابق مع مجموع الكاش المطلوب (${upfrontCash.toLocaleString()} ج.م) + المتبقي أقساط (${rem.toLocaleString()} ج.م). الفارق: ${diff.toLocaleString()} ج.م.`
      };
    }
  } else if (price > 0 && dp > 0 && rem > 0 && !details.total_upfront_cash) {
    const sum = dp + rem;
    const diff = Math.abs(price - sum);
    if (diff > 100) {
      deltaWarning = {
        diff,
        price,
        upfront: dp,
        remaining: rem,
        message_en: `Financial Reconciliation Alert: Total Price (${price.toLocaleString()} EGP) ≠ Paid Cash (${dp.toLocaleString()} EGP) + Remaining Debt (${rem.toLocaleString()} EGP). Discrepancy: ${diff.toLocaleString()} EGP.`,
        message_ar: `تنبيه المطابقة المالية: إجمالي السعر (${price.toLocaleString()} ج.م) لا يتطابق مع مجموع المدفوع كاش (${dp.toLocaleString()} ج.م) + المتبقي أقساط (${rem.toLocaleString()} ج.م). الفارق: ${diff.toLocaleString()} ج.م.`
      };
    }
  }

  return {
    isComplete: blockers.length === 0,
    blockers,
    warnings,
    deltaWarning
  };
}

/* --------------------------------------------------------------------------- */
/* 7. Validation & Normalization                                              */
/* --------------------------------------------------------------------------- */

/**
 * Synchronously normalizes input draft structure and completes structural validation.
 * Compatible with both:
 * 1. Synchronous calls in tests (const draft = L.validateDraft(input, "ar"))
 * 2. Async calls in command handlers (const res = await L.validateDraft(draft, lang, ctx))
 * Guaranteed to return an iterable `missingFields` array under all execution paths.
 */
function validateDraft(inputDraft, lang = "ar", ctx = null) {
  if (!inputDraft || typeof inputDraft !== "object") {
    const errorMsg =
      lang === "en"
        ? "Draft session is empty or uninitialized."
        : "مسودة الوحدة فارغة أو غير معرّفة.";
    return {
      valid: false,
      missingFields: [errorMsg],
      blockers: [{ field: "draft", message: errorMsg }],
      warnings: [],
      deltaWarning: null,
      extracted: {},
      details: {
        finishing: null,
        finishing_en: null,
        floor: null,
        bathrooms: null,
        view: null,
        orientation_en: null,
        currency: "EGP"
      }
    };
  }

  const details = inputDraft.details || {};
  const isVilla = isVillaTypology(inputDraft.property_type);
  const isStudio = isStudioTypology(
    inputDraft.property_type,
    inputDraft.bedrooms
  );

  const resolvedBathrooms =
    inputDraft.bathrooms !== null && inputDraft.bathrooms !== undefined
      ? Number(inputDraft.bathrooms)
      : details.bathrooms !== null && details.bathrooms !== undefined
      ? Number(details.bathrooms)
      : null;

  const resolvedBedrooms = isStudio
    ? 0
    : inputDraft.bedrooms !== null && inputDraft.bedrooms !== undefined
    ? Number(inputDraft.bedrooms)
    : null;

  const normalizedBase = {
    ...inputDraft,
    property_type: isStudio
      ? inputDraft.property_type || "studio"
      : inputDraft.property_type || "apartment",
    bedrooms: resolvedBedrooms,
    bathrooms: resolvedBathrooms,
    details: {
      ...details,
      finishing: details.finishing ?? null,
      finishing_en: details.finishing_en ?? null,
      floor: isVilla ? null : details.floor ?? null,
      floor_en: isVilla ? null : details.floor_en ?? null,
      bathrooms: resolvedBathrooms,
      bua: isVilla
        ? details.bua || inputDraft.area_value || null
        : details.bua ?? null,
      land_area: isVilla ? details.land_area ?? null : null,
      view: details.view ?? null,
      orientation_en: details.orientation_en ?? null,
      currency: details.currency || "EGP"
    }
  };

  const completeness = checkDraftCompleteness(normalizedBase, {
    lang,
    priceValue: inputDraft.price_value
  });

  const missingList = Array.isArray(completeness.blockers)
    ? completeness.blockers.map((b) => b.message)
    : [];

  return {
    valid: completeness.isComplete,
    missingFields: missingList,
    blockers: completeness.blockers,
    warnings: completeness.warnings,
    deltaWarning: completeness.deltaWarning,
    extracted: normalizedBase,
    ...normalizedBase
  };
}

/* --------------------------------------------------------------------------- */
/* 8. Vision Draft Validation & Ranking Order Resolver                         */
/* --------------------------------------------------------------------------- */

function validateVisionDraft(raw, nImages = 0) {
  const d = (Array.isArray(raw) ? raw[0] : raw) || {};
  const str = (v) =>
    String(v ?? "")
      .trim()
      .toLowerCase();
  const rawRoles = Array.isArray(d.image_roles) ? d.image_roles : [];
  const image_roles = Array.from({ length: nImages }, (_, i) => {
    const r = str(rawRoles[i]);
    return ROLES.includes(r) ? r : "other";
  });

  const seen = new Set();
  const image_order = [];
  for (const x of Array.isArray(d.image_order) ? d.image_order : []) {
    const i = Number(x);
    if (Number.isInteger(i) && i >= 0 && i < nImages && !seen.has(i)) {
      seen.add(i);
      image_order.push(i);
    }
  }

  const heroIndex = Number(d.hero_index);
  if (Number.isInteger(heroIndex) && heroIndex >= 0 && heroIndex < nImages) {
    const existingPos = image_order.indexOf(heroIndex);
    if (existingPos !== -1) {
      image_order.splice(existingPos, 1);
    }
    image_order.unshift(heroIndex);
    seen.add(heroIndex);
  }

  for (let i = 0; i < nImages; i++) {
    if (!seen.has(i)) image_order.push(i);
  }

  return {
    hero_index: Number.isInteger(heroIndex) ? heroIndex : null,
    image_roles,
    image_order
  };
}

module.exports = {
  ROLES,
  checkDraftCompleteness,
  validateDraft,
  validateVisionDraft
};
