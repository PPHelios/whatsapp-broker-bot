// domain/priceReading.js — Reading a developer's PDF or photographed price list with AI (Release B, C5), pure: the
// pages a manager picks ("1-3, 5"), the agency's switch and monthly page allowance (set by the app owner), the prompt
// and turning the model's answer into price-sheet rows (domain/priceSheet.js), so the usual preview (new, changed,
// no longer listed) and apply follow. The model may only copy what the page shows; it never fills a gap.
"use strict";

const MAX_PAGES = 10;
const DEFAULT_PAGES_MONTH = 30;
const MAX_PAGES_MONTH = 1000;
const MAX_ROWS_PAGE = 300;
const PROMPT_VERSION = "v1";
const FIELDS = ["dev_code", "building", "property_type", "floor", "area", "area_to", "bedrooms", "garden", "roof", "price", "price_from", "status"];

const digits = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));

/** "1-3, 5" → [1, 2, 3, 5] (sorted, unique, within the file) | { error }. Empty means page 1 for a one-page file. */
function parsePages(input, total, { max = MAX_PAGES } = {}) {
  const s = digits(input).replace(/[،؛;]/g, ",").replace(/\s*(-|–|to|الى|إلى|لـ)\s*/gi, "-").trim();
  if (!s) return total === 1 ? [1] : { error: "pages_required" };
  const out = new Set();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
    if (!m) return { error: "pages_invalid" };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > total) return { error: "pages_invalid" };
    for (let i = a; i <= b; i++) out.add(i);
    if (out.size > max) return { error: "too_many_pages" };
  }
  return [...out].sort((x, y) => x - y);
}

/** The agency's setting (agencies.price_reading) with defaults: off until the owner switches it on. */
function settingOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pages = Number.isInteger(r.pages_month) && r.pages_month >= 0 && r.pages_month <= MAX_PAGES_MONTH ? r.pages_month : DEFAULT_PAGES_MONTH;
  return { enabled: r.enabled === true, pages_month: pages };
}

/** The owner's form → { fields } | { error }. */
function settingFields(input = {}) {
  const n = Number(digits(input.pages_month).trim() || DEFAULT_PAGES_MONTH);
  if (!Number.isInteger(n) || n < 0 || n > MAX_PAGES_MONTH) return { error: "pages_month" };
  return { fields: { enabled: input.enabled === "on" || input.enabled === "1" || input.enabled === true, pages_month: n } };
}

/** The Cairo month of a moment, "2026-10". */
function monthKey(now = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" });
  return f.format(now).slice(0, 7);
}

/** The first moment of that Cairo month (Egypt keeps summer time, so the offset is read for the day). */
function monthStart(now = new Date()) {
  const [y, m] = monthKey(now).split("-").map(Number);
  const utc = Date.UTC(y, m - 1, 1);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hour12: false }).format(new Date(utc))) % 24;
  return new Date(utc - hour * 3600 * 1000);
}

const PROMPT = `You read ONE page of an Egyptian real-estate developer's price list (a PDF page or a photo).
Return JSON only: {"rows":[...]} with one object per unit or unit model row in the page's price table.
Keys (omit a key, or use null, when the page does not show it; NEVER guess or fill a gap):
- dev_code: the developer's unit code or number exactly as written (null for a model row such as "Apartment 3 bedrooms from ...").
- building: building, block, phase, zone or cluster as written.
- property_type: the unit type as written (apartment, villa, twin house, townhouse, duplex, penthouse, chalet, studio, office, shop, شقة، فيلا ...).
- floor: as written.
- area: the area in m² (number); for a range "165-180" area is 165.
- area_to: the upper end of an area range (number), else null.
- bedrooms: number of bedrooms (number).
- garden: garden area in m² (number) or null.
- roof: roof area in m² (number) or null.
- price: the total unit price in Egyptian pounds as a plain number (write "9.2M" or "9.2 مليون" as 9200000). Not a down payment, installment or price per m².
- price_from: true when the price is a "starting from" price of a model row.
- status: "available" or "sold" only when the page marks it.
Skip headers, totals, notes, payment-plan tables and anything that is not a unit or model row. If the page has no price table, return {"rows":[]}.`;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const s = digits(v).toLowerCase().replace(/[,،\s]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(m|mn|million|مليون|k|الف|ألف)?/);
  if (!m) return null;
  const mult = /^(m|mn|million|مليون)$/.test(m[2] || "") ? 1e6 : /^(k|الف|ألف)$/.test(m[2] || "") ? 1e3 : 1;
  const n = Number(m[1]) * mult;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const str = (v, max = 60) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().slice(0, max));

/** The model's text → { rows: [{ cells }] } (cells in priceSheet column keys) | { error: "AI_BAD_JSON" }. */
function rowsFromAnswer(text) {
  let data;
  try {
    data = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return { error: "AI_BAD_JSON" };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : null;
  if (!list) return { error: "AI_BAD_JSON" };
  const rows = [];
  for (const r of list.slice(0, MAX_ROWS_PAGE)) {
    if (!r || typeof r !== "object") continue;
    const cells = {
      dev_code: str(r.dev_code, 40),
      building: str(r.building),
      property_type: str(r.property_type, 40),
      floor: str(r.floor, 20),
      area: num(r.area),
      area_to: num(r.area_to),
      bedrooms: num(r.bedrooms),
      garden: num(r.garden),
      roof: num(r.roof),
      price: r.price_from === true ? null : num(r.price),
      price_from: r.price_from === true ? num(r.price) : null,
      status: ["available", "sold"].includes(r.status) ? r.status : null
    };
    if (!cells.price && !cells.price_from && !cells.dev_code && !cells.property_type) continue;
    rows.push({ cells: Object.fromEntries(Object.entries(cells).filter(([, v]) => v !== null)) });
  }
  return { rows };
}

module.exports = { MAX_PAGES, DEFAULT_PAGES_MONTH, MAX_PAGES_MONTH, PROMPT_VERSION, FIELDS, PROMPT, parsePages, settingOf, settingFields, monthKey, monthStart, rowsFromAnswer };
