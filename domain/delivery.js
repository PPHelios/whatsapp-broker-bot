// domain/delivery.js — Structured delivery dates: parse broker wording, format the highlight (pure)
"use strict";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const toLatinDigits = (s) => String(s ?? "").replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

const READY_RE = /(فوري|فورى|جاهز(?:ة|ه)?\s*(?:للاستلام|للسكن)?|استلام\s*فوري|ريدي|ready(?:\s*to\s*move)?|immediate|delivered|متسلم(?:ة|ه)?|مستلم(?:ة|ه)?)/i;

const MONTHS = {
  jan: 1, january: 1, يناير: 1,
  feb: 2, february: 2, فبراير: 2,
  mar: 3, march: 3, مارس: 3,
  apr: 4, april: 4, ابريل: 4, أبريل: 4,
  may: 5, مايو: 5,
  jun: 6, june: 6, يونيو: 6,
  jul: 7, july: 7, يوليو: 7,
  aug: 8, august: 8, اغسطس: 8, أغسطس: 8,
  sep: 9, sept: 9, september: 9, سبتمبر: 9,
  oct: 10, october: 10, اكتوبر: 10, أكتوبر: 10,
  nov: 11, november: 11, نوفمبر: 11,
  dec: 12, december: 12, ديسمبر: 12
};

const AR_QUARTERS = { الاول: 1, الأول: 1, التاني: 2, الثاني: 2, التالت: 3, الثالث: 3, الرابع: 4 };

/**
 * Parses delivery wording into { delivery_year, delivery_quarter, delivery_month, is_ready, delivery_raw }.
 * Unknown wording keeps only delivery_raw; nothing is guessed.
 * Accepts a string, a year number, or an object from the AI ({ year, quarter, month, ready, raw }).
 */
function parseDelivery(input, { ready = null } = {}) {
  const empty = { delivery_year: null, delivery_quarter: null, delivery_month: null, is_ready: null, delivery_raw: null };
  if (input && typeof input === "object") {
    const year = validYear(input.year ?? input.delivery_year);
    const quarter = validRange(input.quarter ?? input.delivery_quarter, 1, 4);
    const month = validRange(input.month ?? input.delivery_month, 1, 12);
    const isReady = input.ready ?? input.is_ready ?? ready;
    const raw = input.raw ?? input.delivery_raw ?? null;
    const fromRaw = raw ? parseDelivery(raw) : empty;
    return {
      delivery_year: year ?? fromRaw.delivery_year,
      delivery_quarter: quarter ?? (month ? Math.ceil(month / 3) : fromRaw.delivery_quarter),
      delivery_month: month ?? fromRaw.delivery_month,
      is_ready: isReady === true || fromRaw.is_ready === true ? true : isReady === false ? false : null,
      delivery_raw: raw ? String(raw).trim().slice(0, 80) : null
    };
  }

  const raw = String(input ?? "").trim();
  if (!raw) return { ...empty, is_ready: ready === true ? true : null };
  const t = toLatinDigits(raw).toLowerCase();
  const out = { ...empty, delivery_raw: raw.slice(0, 80) };

  if (READY_RE.test(t) || ready === true) {
    out.is_ready = true;
    return out;
  }

  const yearMatch = t.match(/\b(20[2-4]\d)\b/);
  if (yearMatch) out.delivery_year = Number(yearMatch[1]);

  const q = t.match(/\bq\s*([1-4])\b/) || t.match(/\b([1-4])\s*q\b/) || t.match(/ربع\s*([1-4])/);
  if (q) out.delivery_quarter = Number(q[1]);
  else {
    for (const [word, n] of Object.entries(AR_QUARTERS)) {
      if (new RegExp(`الربع\\s*${word}`).test(t)) out.delivery_quarter = n;
    }
  }

  const slash = t.match(/\b(0?[1-9]|1[0-2])\s*[\/\-.]\s*(20[2-4]\d)\b/);
  if (slash) out.delivery_month = Number(slash[1]);
  else {
    for (const [name, n] of Object.entries(MONTHS)) {
      if (new RegExp(`(^|[^\\p{L}])${name}([^\\p{L}]|$)`, "u").test(t)) {
        out.delivery_month = n;
        break;
      }
    }
  }
  if (out.delivery_month && !out.delivery_quarter) out.delivery_quarter = Math.ceil(out.delivery_month / 3);
  if (!out.delivery_year) {
    out.delivery_quarter = null;
    out.delivery_month = null;
  }
  return out;
}

function validYear(v) {
  const n = Number(toLatinDigits(v));
  return Number.isInteger(n) && n >= 2000 && n <= 2060 ? n : null;
}
function validRange(v, lo, hi) {
  const n = Number(toLatinDigits(v));
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/** True when the listing has a known delivery (ready, or at least a year). */
function hasDelivery(l = {}) {
  return l.is_ready === true || Boolean(l.delivery_year);
}

/**
 * Highlight text: "🔑 استلام فوري" / "🗓 تسليم 2027 Q3"; null when unknown.
 */
function formatDelivery(l = {}, lang = "ar", { icon = true } = {}) {
  if (l.is_ready === true) {
    return `${icon ? "🔑 " : ""}${lang === "en" ? "Ready to move" : "استلام فوري"}`;
  }
  if (!l.delivery_year) return null;
  let when = String(l.delivery_year);
  if (l.delivery_quarter) when += ` Q${l.delivery_quarter}`;
  return `${icon ? "🗓 " : ""}${lang === "en" ? "Delivery" : "تسليم"} ${when}`;
}

module.exports = { parseDelivery, formatDelivery, hasDelivery, toLatinDigits };
