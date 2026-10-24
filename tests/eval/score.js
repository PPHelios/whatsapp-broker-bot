// tests/eval/score.js — Scores one AI listing extraction against a case's expected fields.
// The extraction prompt returns free-text Arabic/English for finishing, floor and orientation,
// so those fields are matched tolerantly; numbers must match exactly.
"use strict";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const toLatinDigits = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d));
const norm = (s) => toLatinDigits(s).toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, "");
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(toLatinDigits(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const AR_ORDINALS = { الارضي: 0, ارضي: 0, الاول: 1, الثاني: 2, الثالث: 3, الرابع: 4, الخامس: 5, السادس: 6, السابع: 7, الثامن: 8, التاسع: 9, العاشر: 10 };

const FINISHING = {
  fully_finished: /fully|كامل|سوبر لوكس|لوكس/i,
  semi_finished: /semi|نص|نصف/i,
  core_and_shell: /core|shell|محاره|محارة|بدون/i,
  furnished: /furnish|مفروش/i,
  furnished_with_ac: /furnish|مفروش/i
};

const TYPE_SYNONYMS = { commercial: ["commercial", "retail", "shop", "office"] };

/** Reads a field from the top level or details. */
function pick(out, ...keys) {
  for (const k of keys) {
    const v = out?.[k] ?? out?.details?.[k];
    if (v !== null && v !== undefined && v !== "") return v;
  }
  return null;
}

const CHECKS = {
  property_type: (exp, out) => (TYPE_SYNONYMS[exp] || [exp]).includes(String(out.property_type || "").toLowerCase()),
  listing_type: (exp, out) => (out.listing_type || "sale") === exp,
  compound: (exp, out) => {
    const got = norm(pick(out, "compound_en") || "") + "|" + norm(pick(out, "compound") || "");
    const e = norm(exp);
    // Accept a reasonable prefix (e.g. "Palm Hills" for "Palm Hills October", "Zed" for "ZED Sheikh Zayed").
    return got.includes(e) || got.split("|").some((g) => g.length >= 3 && e.startsWith(g));
  },
  floor: (exp, out) => {
    const raw = `${pick(out, "floor") || ""} ${pick(out, "floor_en") || ""}`;
    const digits = toLatinDigits(raw).match(/\d+/);
    if (digits) return Number(digits[0]) === exp;
    const ord = Object.entries(AR_ORDINALS).find(([w]) => norm(raw).includes(norm(w)));
    return ord ? ord[1] === exp : false;
  },
  finishing: (exp, out) => FINISHING[exp].test(`${pick(out, "finishing_en") || ""} ${pick(out, "finishing") || ""}`),
  orientation: (exp, out) => {
    const raw = `${pick(out, "orientation_en") || ""} ${pick(out, "orientation") || ""}`;
    return { north: /north|بحري/i, south: /south|قبلي/i, east: /east|شرقي/i, west: /west|غربي/i }[exp].test(raw);
  },
  nanny_room: (exp, out) => Boolean(pick(out, "has_nanny_room", "nanny_room")) === exp,
  ready_to_move: (exp, out) =>
    (pick(out, "ready_to_move") === true || /فوري|ready|immediate/i.test(String(pick(out, "delivery_date") || ""))) === exp,
  delivery_date: (exp, out) => String(pick(out, "delivery_date") || "").includes(String(exp)),
  bua: (exp, out) => num(pick(out, "bua")) === exp || (num(pick(out, "bua")) === null && num(out.area_value) === exp),
  total_upfront_cash: (exp, out) => [num(pick(out, "total_upfront_cash")), num(pick(out, "down_payment_value"))].includes(exp),
  remaining_debt: (exp, out) => num(pick(out, "remaining_balance", "remaining_debt")) === exp,
  down_payment_pct: (exp, out) => {
    const price = num(out.price_value);
    const dp = num(pick(out, "down_payment_value"));
    const pct = num(pick(out, "down_payment_pct"));
    return pct === exp || (price && dp !== null && Math.round((dp / price) * 100) === exp);
  },
  bedrooms: (exp, out) => (exp === null ? [null, 0].includes(num(pick(out, "bedrooms"))) : num(pick(out, "bedrooms")) === exp)
};

/**
 * @returns {{ correct: number, total: number, misses: Array<{field, expected, got}> }}
 */
function scoreExtraction(expected, out) {
  const misses = [];
  let correct = 0;
  const fields = Object.entries(expected);
  for (const [field, exp] of fields) {
    let ok;
    if (!out || typeof out !== "object") ok = false;
    else if (CHECKS[field]) ok = CHECKS[field](exp, out);
    else if (exp === null) ok = pick(out, field) === null; // must not be invented
    else ok = num(pick(out, field)) === exp;
    if (ok) correct++;
    else misses.push({ field, expected: exp, got: out ? pick(out, field) : undefined });
  }
  return { correct, total: fields.length, misses };
}

module.exports = { scoreExtraction };
