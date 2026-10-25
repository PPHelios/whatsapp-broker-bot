// domain/commission.js — Deal commission (Release 3 step 10, Q10: negotiated per deal), pure. The total comes from the
// amount or the percentage of the price the broker typed; an external co-broker's share comes off the top; colleagues'
// shares are whole EGP, rounded down, and the remainder goes to the closing broker, so the shares always add up exactly.
"use strict";

const MAX_PCT = 100;

const whole = (n) => Math.round(Number(n));
const isNum = (n) => n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n));

/**
 * @param {Object} input
 *   - price: the deal price (EGP)
 *   - mode: "pct" | "amount"; pct (e.g. 2.5) or amount (EGP)
 *   - external: null | { pct } | { amount } — the co-broker's share of the total
 *   - closingBrokerId
 *   - splits: [{ brokerId, pct }] — colleagues' percentages of the agency's share (the closing broker gets the rest)
 * @returns {{ total, external, agencyShare, shares: [{ brokerId, amount, pct }], errors: string[] }}
 */
function compute({ price, mode, pct = null, amount = null, external = null, closingBrokerId, splits = [] } = {}) {
  const errors = [];
  const p = Number(price);
  if (!isNum(price) || p <= 0) errors.push("price");
  let total = 0;
  if (mode === "pct") {
    if (!isNum(pct) || Number(pct) <= 0 || Number(pct) > MAX_PCT) errors.push("commission_pct");
    else total = whole((p * Number(pct)) / 100);
  } else if (mode === "amount") {
    if (!isNum(amount) || Number(amount) <= 0) errors.push("commission_amount");
    else if (Number(amount) > p) errors.push("commission_over_price");
    else total = whole(amount);
  } else errors.push("commission_missing");

  let ext = 0;
  if (external) {
    if (isNum(external.pct)) {
      if (Number(external.pct) < 0 || Number(external.pct) > MAX_PCT) errors.push("external_pct");
      else ext = whole((total * Number(external.pct)) / 100);
    } else if (isNum(external.amount)) {
      if (Number(external.amount) < 0) errors.push("external_amount");
      else ext = whole(external.amount);
    }
    if (ext > total) errors.push("external_over_total");
  }
  const agencyShare = Math.max(0, total - ext);

  if (!closingBrokerId) errors.push("closing_broker");
  const seen = new Set([closingBrokerId]);
  let pctSum = 0;
  const shares = [];
  for (const s of splits || []) {
    if (!s || !s.brokerId || s.brokerId === closingBrokerId) continue;
    if (seen.has(s.brokerId)) {
      errors.push("split_duplicate");
      continue;
    }
    seen.add(s.brokerId);
    if (!isNum(s.pct) || Number(s.pct) <= 0 || Number(s.pct) >= MAX_PCT) {
      errors.push("split_pct");
      continue;
    }
    pctSum += Number(s.pct);
    shares.push({ brokerId: s.brokerId, pct: Number(s.pct), amount: Math.floor((agencyShare * Number(s.pct)) / 100) });
  }
  if (pctSum >= MAX_PCT) errors.push("split_total");
  const given = shares.reduce((a, s) => a + s.amount, 0);
  shares.unshift({ brokerId: closingBrokerId, pct: Math.round((MAX_PCT - pctSum) * 1000) / 1000, amount: agencyShare - given });
  return { total, external: ext, agencyShare, shares, errors: [...new Set(errors)] };
}

/** "2%", "2.5 %", "٢٪" → { mode: "pct", pct } ; otherwise null (amounts are parsed by the caller). */
function parsePct(text) {
  const m = String(text || "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/٫/g, ".")
    .match(/(\d+(?:\.\d+)?)\s*(?:%|٪|في المية|في الميه|بالمية|percent)/i);
  return m ? { mode: "pct", pct: Number(m[1]) } : null;
}

/** "60/40" → [60, 40] (must add up to 100); otherwise null. */
function parseSplit(text) {
  const m = String(text || "")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .match(/(\d{1,2}(?:\.\d+)?)\s*[/\\-]\s*(\d{1,2}(?:\.\d+)?)/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a > 0 && b > 0 && Math.abs(a + b - 100) < 1e-9 ? [a, b] : null;
}

const money = (n, lang = "ar") => `${Number(n || 0).toLocaleString("en-US")} ${lang === "en" ? "EGP" : "ج.م"}`;

module.exports = { compute, parsePct, parseSplit, money };
