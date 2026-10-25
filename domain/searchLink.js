// domain/searchLink.js — Search filters ⇄ URL token and ⇄ web form fields (pure)
// The token carries canonical filters (domain/searchQuery.js), so a WhatsApp search opened on the web
// ("refine and see all") runs the very same query without another AI call.
"use strict";

const Q = require("./searchQuery");
const Places = require("./places");
const Features = require("./features");
const { PROPERTY_TYPES } = require("./fieldRules");

const MAX_TOKEN = 2000;
const NUMBER_KEYS = ["price_min", "price_max", "area_min", "area_max", "bedrooms_min", "bedrooms_max", "bathrooms_min", "floor_min", "floor_max", "delivery_by_year", "max_down_payment", "max_installment"];
const FLAG_KEYS = ["delivery_ready", "payment_cash", "payment_installments"];
const FINISHING = ["core_and_shell", "semi_finished", "fully_finished", "super_lux", "ultra_super_lux"];
const FURNISHING = ["furnished", "semi_furnished", "unfurnished"];

const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const strList = (v, max = 12, len = 60) =>
  (Array.isArray(v) ? v : []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, len)).slice(0, max);
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Untrusted object → canonical filters: unknown keys dropped, every value type-checked. */
function sanitizeFilters(input) {
  const f = input && typeof input === "object" ? input : {};
  const out = Q.emptyFilters();
  if (typeof f.code === "string") out.code = Q.normalizeCode(f.code.slice(0, 30));
  if (["sale", "rent"].includes(f.listing_type)) out.listing_type = f.listing_type;
  if (["primary", "resale"].includes(f.market)) out.market = f.market;
  if (["EGP", "USD", "EUR"].includes(f.currency)) out.currency = f.currency;
  out.property_types = strList(f.property_types).filter((t) => PROPERTY_TYPES.includes(t));
  out.places = (Array.isArray(f.places) ? f.places : [])
    .filter((p) => p && ["compound", "developer", "area"].includes(p.kind) && typeof p.key === "string" && Places.placeName(p.kind, p.key))
    .map((p) => ({ kind: p.kind, key: p.key }))
    .slice(0, 8);
  out.place_terms = strList(f.place_terms, 6);
  out.features = strList(f.features, 40).filter((k) => Features.featureLabel(k, "en"));
  out.feature_terms = strList(f.feature_terms, 6);
  out.finishing = strList(f.finishing).filter((k) => FINISHING.includes(k));
  if (FURNISHING.includes(f.furnishing)) out.furnishing = f.furnishing;
  for (const k of NUMBER_KEYS) {
    const n = finite(f[k]);
    out[k] = n === null || n < (k.startsWith("floor") ? -5 : 0) || n > 1e12 ? null : n;
  }
  for (const k of FLAG_KEYS) out[k] = f[k] === true ? true : null;
  return Q.canonical(out);
}

/** Filters → compact URL-safe token (only the set fields). */
function encodeFilters(filters) {
  const f = sanitizeFilters(filters);
  const compact = Object.fromEntries(Object.entries(f).filter(([, v]) => !isEmpty(v)));
  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

/** URL token → canonical filters, or null when it is not a valid token. Never trusts the content. */
function decodeFilters(token) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    return sanitizeFilters(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

const one = (v) => (Array.isArray(v) ? v[0] : v);
const many = (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]);

/**
 * Web refine form (query string) → canonical filters, through the same normalizer as AI answers,
 * so a place typed in Arabic or English resolves to the same key.
 */
function filtersFromForm(q = {}) {
  const yes = (k) => ["1", "on", "true"].includes(String(one(q[k]) ?? ""));
  const parsed = Q.normalizeAiSearch({
    intent: "search",
    filters: {
      code: one(q.code) || null,
      listing_type: one(q.listing_type) || null,
      market: one(q.market) || null,
      property_types: many(q.type),
      // Several places ("التجمع، زايد") round-trip with formFromFilters.
      locations: String(one(q.place) || "")
        .split(/\s*[,،]\s*|\s+(?:او|أو|or)\s+/i)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
      price_min: one(q.price_min),
      price_max: one(q.price_max),
      area_min: one(q.area_min),
      area_max: one(q.area_max),
      bedrooms_min: one(q.bedrooms_min),
      bedrooms_max: one(q.bedrooms_max),
      bathrooms_min: one(q.bathrooms_min),
      floor_min: one(q.floor_min),
      floor_max: one(q.floor_max),
      finishing: many(q.finishing),
      furnishing: one(q.furnishing) || null,
      delivery: { ready: yes("ready") || null, by_year: one(q.by_year) },
      payment: {
        cash: yes("cash") || null,
        installments: yes("installments") || null,
        max_down_payment: one(q.max_down_payment),
        max_installment: one(q.max_installment)
      },
      features: many(q.feature),
      other_features: String(one(q.other) || "")
        .split(/[,،]/)
        .map((s) => s.trim())
        .filter(Boolean)
    }
  });
  // Feature checkboxes are keys; classifyFeatures maps keys only through their labels, so keep them as given.
  const keys = many(q.feature).filter((k) => Features.featureLabel(k, "en"));
  return sanitizeFilters({ ...parsed.filters, features: [...new Set([...parsed.filters.features, ...keys])] });
}

/** Canonical filters → values for the refine form fields. */
function formFromFilters(f, lang = "ar") {
  const filters = sanitizeFilters(f);
  const placeNames = filters.places.map((p) => Places.placeName(p.kind, p.key)?.[lang === "en" ? "en" : "ar"]).filter(Boolean);
  return {
    code: filters.code || "",
    listing_type: filters.listing_type || "",
    market: filters.market || "",
    type: filters.property_types,
    place: [...placeNames, ...filters.place_terms].join("، "),
    price_min: filters.price_min ?? "",
    price_max: filters.price_max ?? "",
    area_min: filters.area_min ?? "",
    area_max: filters.area_max ?? "",
    bedrooms_min: filters.bedrooms_min ?? "",
    bedrooms_max: filters.bedrooms_max ?? "",
    bathrooms_min: filters.bathrooms_min ?? "",
    floor_min: filters.floor_min ?? "",
    floor_max: filters.floor_max ?? "",
    finishing: filters.finishing,
    furnishing: filters.furnishing || "",
    ready: Boolean(filters.delivery_ready),
    by_year: filters.delivery_by_year ?? "",
    cash: Boolean(filters.payment_cash),
    installments: Boolean(filters.payment_installments),
    max_down_payment: filters.max_down_payment ?? "",
    max_installment: filters.max_installment ?? "",
    feature: filters.features,
    other: filters.feature_terms.join("، ")
  };
}

module.exports = { MAX_TOKEN, sanitizeFilters, encodeFilters, decodeFilters, filtersFromForm, formFromFilters };
