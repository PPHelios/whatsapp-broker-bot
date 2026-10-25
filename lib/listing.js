// lib/listing.js — Pure Helpers for Listing Extraction, Vision Curation, Validation & Merging
// Text signals and codes: lib/listingText.js · AI prompts and extraction: lib/listingExtract.js ·
// completeness and validation: lib/listingValidate.js. This file merges fields and re-exports the rest.
"use strict";

const Features = require("../domain/features");
const { PROPERTY_TYPES, unitKind } = require("../domain/fieldRules");
const Text = require("./listingText");
const Extract = require("./listingExtract");
const Validate = require("./listingValidate");

const ALL_TYPES = PROPERTY_TYPES;

/* --------------------------------------------------------------------------- */
/* 9. Field Merging & Safe Update Composition                                 */
/* --------------------------------------------------------------------------- */

// Top-level listing columns composeFields owns (everything a draft or edit can set).
const LISTING_COLUMNS = [
  "title", "property_type", "listing_type", "market", "price_value", "area_value", "bedrooms", "bathrooms",
  "location", "compound", "compound_en", "district", "city", "floor_level", "finishing", "furnishing",
  "delivery_year", "delivery_quarter", "delivery_month", "is_ready", "delivery_raw",
  "down_payment_value", "remaining_amount", "installment_value", "payment_frequency", "installment_years",
  "installments_end", "maintenance_pct"
];

const filled = (v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/**
 * Composes the stored row from a normalized draft (normalizeExtraction output) and, for edits,
 * the existing row: a stated value wins, an unstated one keeps the existing value.
 * Sets the top-level columns (delivery, features, resale schedule, market...) as well as details.
 */
function composeFields({ existing = null, draft = {}, lang = "ar" } = {}) {
  const old = existing || {};
  const d = draft || {};
  const out = {};
  for (const col of LISTING_COLUMNS) {
    out[col] = filled(d[col]) ? d[col] : old[col] ?? null;
  }
  // Delivery is one unit: a newly stated delivery replaces the whole old one.
  if (filled(d.delivery_year) || d.is_ready === true || filled(d.delivery_raw)) {
    for (const k of ["delivery_year", "delivery_quarter", "delivery_month", "is_ready", "delivery_raw"]) out[k] = d[k] ?? null;
  }
  out.market = d.market || old.market || "resale";
  out.listing_type = out.listing_type || null;
  out.compound_en = out.compound_en || d.details?.compound_en || old.details?.compound_en || null;
  out.location_keywords = filled(d.location_keywords) ? d.location_keywords : old.location_keywords || [];
  out.feature_keys = Features.sortKeys([...(old.feature_keys || []), ...(d.feature_keys || [])]);
  out.features_other = [...new Set([...(old.features_other || []), ...(d.features_other || [])])];

  const terms = filled(d.payment_terms) && Object.keys(d.payment_terms).length ? d.payment_terms : old.payment_terms || {};
  out.payment_terms = terms;
  out.inventory_type = out.market === "primary" ? "primary_unit" : old.inventory_type && old.inventory_type !== "primary_unit" ? old.inventory_type : "resale_unit";

  const details = { ...(old.details || {}) };
  for (const [k, v] of Object.entries(d.details || {})) if (filled(v)) details[k] = v;
  if (!existing) details.lang = lang;
  if (unitKind(out.property_type) === "villa") {
    out.floor_level = null;
    delete details.floor;
    delete details.floor_en;
    details.bua = out.area_value ?? details.bua ?? null;
  }
  const kind = unitKind(out.property_type);
  if (kind === "studio") out.bedrooms = 0;
  if (kind === "commercial") out.bedrooms = null;
  out.details = details;
  return out;
}

module.exports = {
  ROLES: Validate.ROLES,
  ALL_TYPES,
  normalizeArabicDigits: Text.normalizeArabicDigits,
  parseExplicitUnitCode: Text.parseExplicitUnitCode,
  extractExplicitUnitCode: Text.extractExplicitUnitCode,
  isLikelyListingMetadata: Text.isLikelyListingMetadata,
  detectLang: Text.detectLang,
  isReplaceMode: Text.isReplaceMode,
  generateListingCode: Text.generateListingCode,
  buildListingPrompt: Extract.buildListingPrompt,
  normalizeExtraction: Extract.normalizeExtraction,
  findStatedCode: Extract.findStatedCode,
  extractPropertyDetails: Extract.extractPropertyDetails,
  buildVisionPrompt: Extract.buildVisionPrompt,
  validateDraft: Validate.validateDraft,
  checkDraftCompleteness: Validate.checkDraftCompleteness,
  validateVisionDraft: Validate.validateVisionDraft,
  composeFields,
  LISTING_COLUMNS,
  isVillaTypology: Text.isVillaTypology,
  isStudioTypology: Text.isStudioTypology
};
