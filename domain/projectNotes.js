// domain/projectNotes.js — Reads the unit offers written in a project's notes (price, area, down payment, installment)
// and matches them to what a search asked for. Pure: no database, no I/O. Notes are text, so a line counts only when it
// carries a price and an area; anything else in the notes is ignored.
"use strict";

const { normalizeSearch } = require("./searchText");
const { normalizeDigits } = require("../lib/text");

// Area names in the notes that a search may write differently (the project's district is stored in English).
const LOCATION_ALIASES = {
  obour: ["العبور", "عبور", "obour", "new obour", "العبور الجديده", "نيو عبور"],
  "new cairo": ["new cairo", "القاهره الجديده", "التجمع"],
  "new capital": ["العاصمه الاداريه", "العاصمة الإدارية", "العاصمه الاداريه الجديده", "new capital", "new administrative capital"],
  "6th of october": ["6 اكتوبر", "السادس من اكتوبر", "6th of october"],
  "sheikh zayed": ["الشيخ زايد", "sheikh zayed"]
};

const NOTE_MAX = 4000;
// "3 مليون", "3 مليون ونص", "3 مليون و200 ألف", "850 ألف" after a price word.
function priceWords(raw) {
  const m = raw.match(/(?:سعرها|السعر|بسعر|سعر|price)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(مليون|ألف|الف)(?:\s*و\s*(نص|\d{1,3}\s*(?:ألف|الف)))?/i);
  if (!m) return null;
  const base = Number(m[1]) * (m[2] === "مليون" ? 1000000 : 1000);
  const extra = m[3] == null ? 0 : m[3] === "نص" ? 500000 : parseInt(m[3], 10) * 1000;
  return Math.round(base + extra);
}

const num = (s) => (s == null ? null : Number(String(s).replace(/[,\s٬]/g, "")) || null);

/** The offers in one notes text: { area, floor, price, down, monthly, years, raw }, one per line that has a price and an area. */
function parseUnits(notes) {
  const text = normalizeDigits(String(notes || ""));
  const parts = text.split(/\n|__|🔥/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 3);
  const out = [];
  for (const raw of parts) {
    // "سعرها = 3,000,000", "بسعر 3,180,590", "السعر: 3000000", "price 3,000,000".
    const priceM = raw.match(/سعرها[^=]*=\s*([\d,٬]+)/) || raw.match(/(?:سعرها|بسعر|السعر|سعر|price)\s*[:=]?\s*([\d,٬]{6,})/i);
    const price = priceM ? num(priceM[1]) : priceWords(raw);
    if (!price || price < 100000) continue;
    // A price-only line (no size written) is kept: it answers price questions, and area searches skip it.
    const areaM = raw.match(/(?:يونت|يومت|وحده|وحدة|شقه|شقة)\s*(\d{2,4})(?!\d)/) || raw.match(/(\d{2,4})\s*(?:م|متر)(?![؀-ۿ])/);
    const area = areaM ? Number(areaM[1]) : null;
    const floor = (raw.match(/الدور\s+([^\s=]+(?:\s+(?:الاول|التاني|التالت|الرابع|الخامس|الارضي))?)/) || [])[1] || null;
    // "مقدم 10% = 290,000" or "ومقدم 159,029"; a percentage with no amount is not a down payment.
    const downRaw = num((raw.match(/مقدم\s*(?:\d+(?:\.\d+)?\s*%\s*(?:=|-|:)?\s*)?([\d,٬]{4,})/) || [])[1]);
    const down = downRaw && downRaw >= 1000 ? downRaw : null;
    const monthlyM = raw.match(/قسط\s*شهري[^=]*=\s*([\d,٬]+)/);
    // "قسط 25 ألف", "قسط شهري حوالي 25 ألف".
    const monthlyWords = raw.match(/قسط\s*(?:شهري)?\s*(?:حوالي|حوالى)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:ألف|الف)/);
    const monthly = monthlyM ? num(monthlyM[1]) : monthlyWords ? Math.round(Number(monthlyWords[1]) * 1000) : null;
    const years = num((raw.match(/(\d{1,2})\s*(?:سنين|سنوات|سنه|سنة)/) || [])[1]);
    // No monthly installment written: estimate it from the rest (no interest), and keep it apart from a written one.
    const monthly_est = monthly == null && down != null && years ? Math.round((price - down) / (years * 12)) : null;
    const bedrooms = num((raw.match(/(\d)\s*(?:غرف|غرفه|غرفة|bed(?:room)?s?|br)(?![a-z])/i) || raw.match(/(?:غرف|غرفه|غرفة)\s*(\d)(?!\d)/) || [])[1]);
    out.push({ area, floor, bedrooms, price, down, monthly, monthly_est, years, raw });
  }
  return out;
}

/** Does the project belong to the place the search named (district, city, or name)? No place named = yes. */
function matchesPlace(project, places) {
  if (!places.length) return true;
  const fields = [project.district, project.city, project.name, project.name_en].map((f) => normalizeSearch(f || ""));
  return places.some((p) => {
    // The place and every spelling listed with it (either direction): "العبور" finds "obour".
    const words = new Set([p]);
    for (const [key, alts] of Object.entries(LOCATION_ALIASES)) {
      const group = [key, ...alts].map((w) => normalizeSearch(w));
      if (group.includes(p)) group.forEach((w) => words.add(w));
    }
    return [...words].some((w) => w && fields.some((f) => f.includes(w)));
  });
}

/**
 * The offers that fit a search: area at least the asked size when one number is asked (a range when two), price and installment and down
 * payment at most the budget. Filters that are not set are not applied. Rent searches are not answered from notes.
 * @param {Array<{project, units}>} projects parsed notes per project
 * @param {Object} f search filters (domain/searchQuery shape)
 */
function matchUnits(projects, f = {}) {
  if (f.listing_type === "rent") return [];
  const places = [...(f.locations || []), ...(f.places || []).map((p) => p.key), ...(f.place_terms || [])]
    .map((p) => normalizeSearch(p))
    .filter(Boolean);
  // A request with no area, place, price or installment asked is not a question about one offer: nothing is listed.
  const asked = places.length || [f.area_min, f.area_max, f.price_min, f.price_max, f.max_installment, f.max_down_payment, f.bedrooms_min, f.bedrooms_max].some((v) => v != null);
  if (!asked) return [];
  const hits = [];
  for (const { project, units } of projects) {
    if (!matchesPlace(project, places)) continue;
    for (const u of units) {
      // One number asked ("أكتر من 120") is a minimum, the same meaning the search parser and unit search give it.
      if (f.area_min != null && f.area_max == null && u.area < f.area_min) continue;
      if (f.area_min != null && f.area_max != null && (u.area < f.area_min || u.area > f.area_max)) continue;
      if (f.area_min == null && f.area_max != null && (u.area == null || u.area > f.area_max)) continue;
      if (f.area_min != null && u.area == null) continue;
      if (f.bedrooms_min != null && (u.bedrooms == null || u.bedrooms < f.bedrooms_min)) continue;
      if (f.bedrooms_max != null && f.bedrooms_min != null && f.bedrooms_max !== f.bedrooms_min && u.bedrooms > f.bedrooms_max) continue;
      if (f.price_max != null && u.price > f.price_max) continue;
      if (f.price_min != null && u.price < f.price_min) continue;
      if (f.max_installment != null && ((u.monthly ?? u.monthly_est) == null || (u.monthly ?? u.monthly_est) > f.max_installment)) continue;
      if (f.max_down_payment != null && (u.down == null || u.down > f.max_down_payment)) continue;
      hits.push({ project, unit: u });
    }
  }
  return hits.sort((a, b) => a.unit.price - b.unit.price);
}

module.exports = { parseUnits, matchUnits, matchesPlace, LOCATION_ALIASES, NOTE_MAX };
