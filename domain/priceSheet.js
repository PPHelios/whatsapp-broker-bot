// domain/priceSheet.js — A developer's price sheet (Release A, C2), pure: header matching, one row → an exact unit
// (the developer's unit code) or a model ("Apartment, 3 bedrooms, 165 to 180 m², from 9,200,000"), and the preview
// against the project's current units: new, changed (from → to), no longer listed, invalid and repeated rows.
// Inside a project the developer's unit code decides what is the same unit; models are never duplicates (C3).
"use strict";

const { money, propertyType } = require("./sheetImport");
const { normalizeSearch } = require("./searchText");

// Checked in order: the first match wins.
const COLUMNS = [
  ["owner_phone", /^(owner phone|owner mobile|owner|تليفون المالك|رقم المالك|موبايل المالك|المالك)$/],
  ["dev_code", /^(unit code|unit no|unit number|unit|code|unit id|كود|الكود|كود الوحده|رقم الوحده|الوحده)$/],
  ["building", /^(building|bldg|block|phase|zone|cluster|عماره|العماره|مبني|المبني|بلوك|المرحله|مرحله|زون)$/],
  ["property_type", /^(type|unit type|property type|model|النوع|نوع الوحده|نوع|الموديل|موديل)$/],
  ["floor", /^(floor|level|الدور|دور)$/],
  ["area_to", /^(area to|max area|bua to|المساحه الي|الي)$/],
  ["area", /^(area|bua|area from|min area|المساحه|مساحه|المساحه من|من)( (sqm|m2|m|م2|م|متر|بالمتر))?$/],
  ["bedrooms", /(bedrooms|beds|rooms|غرف|الغرف|عدد الغرف)/],
  ["garden", /(garden|حديقه|الحديقه|جاردن)/],
  ["roof", /(roof|روف|الروف|سطح)/],
  ["price_from", /^(price from|starting price|from price|يبدا من|السعر يبدا من|سعر يبدا من)$/],
  ["price", /^(price|total price|unit price|السعر|سعر|اجمالي السعر|السعر الاجمالي|سعر الوحده)( egp)?$/],
  ["status", /^(status|availability|الحاله|متاح)$/]
];

/** Header text → column key (or null). */
function columnFor(header) {
  const h = normalizeSearch(header).replace(/[()²]/g, "").replace(/\s+/g, " ").trim();
  if (!h) return null;
  for (const [key, re] of COLUMNS) if (re.test(h)) return key;
  return null;
}

const AR = "٠١٢٣٤٥٦٧٨٩";
const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
const EMPTY = new Set(["", "-", "—", "n/a", "na", "null", "none", "لا يوجد"]);
const isEmpty = (v) => v === null || v === undefined || EMPTY.has(String(v).trim().toLowerCase());
const text = (v, max = 60) => (isEmpty(v) ? null : String(v).trim().replace(/^'+/, "").slice(0, max));
const num = (v) => {
  if (isEmpty(v)) return null;
  const n = typeof v === "number" ? v : Number(digits(v).replace(/[,،\s]/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** "165-180", "165 to 180", "من 165 إلى 180" → [165, 180]; "165" → [165, null]. */
function areaRange(v) {
  if (isEmpty(v)) return [null, null];
  if (typeof v === "number") return [v > 0 ? v : null, null];
  const nums = digits(v).replace(/,/g, "").match(/\d+(\.\d+)?/g) || [];
  const [a, b] = nums.map(Number);
  if (!a) return [null, null];
  return b && b > a ? [a, b] : [a, null];
}

const SOLD = /^(sold|reserved|booked|hold|on hold|مباع|مباعه|اتباع|محجوز|محجوزه|حجز)$/;
const AVAILABLE = /^(available|avail|open|متاح|متاحه|available now)$/;

/**
 * One sheet row → { kind: "unit" | "model", dev_code, property_type, building, floor, area, area_to, bedrooms,
 * garden, roof, price, price_from, sold } or { error }. A row without a unit code is a model; a model's price is
 * always a "from" price.
 */
function rowToEntry(cells = {}) {
  const has = (k) => !isEmpty(cells[k]);
  const devCode = text(cells.dev_code, 40);
  const type = has("property_type") ? propertyType(cells.property_type) : null;
  if (has("property_type") && !type) return { error: "property_type" };
  let [area, areaTo] = areaRange(cells.area);
  if (has("area_to")) areaTo = num(cells.area_to);
  if (has("area") && !area) return { error: "area" };
  if (areaTo && area && areaTo <= area) areaTo = null;
  const priceFromCol = has("price_from") ? money(cells.price_from) : null;
  const priceCol = has("price") ? money(cells.price) : null;
  // "from 9.2M" written in the price cell also marks a "from" price.
  const fromWord = has("price") && /(^|\s)(from|starting|يبدا|يبدأ|من)(?=\s|\d|$)/i.test(String(cells.price));
  const price = priceCol || priceFromCol || (fromWord ? money(String(cells.price).replace(/(from|starting at|starting|يبدا من|يبدأ من|من)/gi, "").trim()) : null);
  if ((has("price") || has("price_from")) && !price) return { error: "price" };
  if (!price) return { error: "price" };
  const statusText = has("status") ? normalizeSearch(String(cells.status)) : "";
  const sold = SOLD.test(statusText);
  if (statusText && !sold && !AVAILABLE.test(statusText)) return { error: "status" };
  const bedrooms = has("bedrooms") ? (/studio|استوديو/i.test(String(cells.bedrooms)) ? 0 : num(cells.bedrooms)) : null;
  const kind = devCode ? "unit" : "model";
  if (kind === "model" && !type) return { error: "property_type" };
  return {
    kind,
    owner_phone: text(cells.owner_phone, 40),
    dev_code: devCode ? devCode.toUpperCase() : null,
    property_type: type,
    building: text(cells.building, 40),
    floor: text(cells.floor, 20),
    area,
    area_to: areaTo,
    bedrooms: bedrooms === null ? null : Math.round(bedrooms),
    garden: has("garden") ? num(cells.garden) : null,
    roof: has("roof") ? num(cells.roof) : null,
    price: Math.round(price),
    price_from: kind === "model" || Boolean(priceFromCol && !priceCol) || fromWord,
    sold
  };
}

/** The key that tells two models of one project apart (type, bedrooms, area range). */
const modelKey = (e) => [e.property_type || "", e.bedrooms ?? "", Math.round(e.area || 0), Math.round(e.area_to || 0)].join("|");
/** The same key for a stored model listing. */
const listingModelKey = (l) => [l.property_type || "", l.bedrooms ?? "", Math.round(Number(l.area_value) || 0), Math.round(Number(l.details?.area_to) || 0)].join("|");

const perM2 = (price, area) => (price && area ? Math.round(price / area) : null);

/**
 * The preview of a sheet against the project's current units (nothing is written).
 * @param {Array} rows - [{ rowNumber, cells }]
 * @param {Array} existing - the project's listings (id, code, developer_unit_code, inventory_type, status, price_value,
 *   property_type, bedrooms, area_value, details)
 * @returns {{ entries, summary }} entries: [{ rowNumber, action: new|changed|same|invalid|repeated, ...entry,
 *   listing_id, code, old_price, old_status, error }]; removed listings are entries with action "removed".
 */
function preview(rows = [], existing = []) {
  const units = new Map();
  const models = new Map();
  for (const l of existing) {
    if (l.inventory_type === "developer_model") models.set(listingModelKey(l), l);
    else if (l.developer_unit_code) units.set(String(l.developer_unit_code).trim().toUpperCase(), l);
  }
  const seenCodes = new Set();
  const seenModels = new Set();
  const matched = new Set();
  const entries = [];
  for (const r of rows) {
    const e = rowToEntry(r.cells);
    if (e.error) {
      entries.push({ rowNumber: r.rowNumber, action: "invalid", error: e.error, raw: r.cells });
      continue;
    }
    const key = e.kind === "unit" ? e.dev_code : modelKey(e);
    const seen = e.kind === "unit" ? seenCodes : seenModels;
    if (seen.has(key)) {
      entries.push({ rowNumber: r.rowNumber, action: "repeated", ...e });
      continue;
    }
    seen.add(key);
    const l = e.kind === "unit" ? units.get(key) : models.get(key);
    const out = { rowNumber: r.rowNumber, ...e, per_m2: perM2(e.price, e.area) };
    if (!l) {
      entries.push({ ...out, action: e.sold ? "skipped" : "new" });
      continue;
    }
    matched.add(l.id);
    const oldPrice = l.price_value === null || l.price_value === undefined ? null : Number(l.price_value);
    const priceChanged = oldPrice !== e.price;
    const statusChanged = e.sold ? l.status === "active" : l.status === "sold";
    entries.push({
      ...out,
      action: priceChanged || statusChanged ? "changed" : "same",
      listing_id: l.id,
      code: l.code,
      old_price: oldPrice,
      old_status: l.status
    });
  }
  for (const l of existing) {
    if (matched.has(l.id) || l.status !== "active") continue;
    if (l.inventory_type !== "developer_model" && !l.developer_unit_code) continue; // a broker's own listing in the project
    entries.push({ action: "removed", listing_id: l.id, code: l.code, dev_code: l.developer_unit_code || null, kind: l.inventory_type === "developer_model" ? "model" : "unit", old_price: Number(l.price_value) || null, property_type: l.property_type });
  }
  const count = (a) => entries.filter((x) => x.action === a).length;
  return {
    entries,
    summary: { new: count("new"), changed: count("changed"), same: count("same"), removed: count("removed"), invalid: count("invalid"), repeated: count("repeated"), skipped: count("skipped") }
  };
}

module.exports = { COLUMNS, columnFor, areaRange, rowToEntry, modelKey, listingModelKey, perM2, preview };
