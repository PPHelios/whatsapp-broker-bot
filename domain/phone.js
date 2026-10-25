// domain/phone.js — The one phone rule (P1): normalization, kinds, display and links (pure)
"use strict";

// Stored form: international digits without "+" (Egypt mobile 2010xxxxxxxx), the same shape as
// brokers.phone_normalized and WhatsApp's `from`. E.164 is "+" + that.

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → ASCII digits; everything else unchanged. */
function toAsciiDigits(s) {
  return String(s ?? "").replace(/[٠-٩۰-۹]/g, (c) => {
    const i = AR_DIGITS.indexOf(c);
    return String(i >= 0 ? i : FA_DIGITS.indexOf(c));
  });
}

const EG_MOBILE = /^201[0125]\d{8}$/;
// Cairo/Giza 02 + 8 digits, other governorates 0XX + 7 digits: both 9 digits after the country code.
const EG_LANDLINE = /^20[2-9]\d{8}$/;

/**
 * Any written phone → international digits ("201012345678"), or null when it isn't a phone.
 * Accepts Arabic digits, spaces, dashes, dots, brackets, "+", "00", WhatsApp JIDs (…@s.whatsapp.net),
 * Egyptian national forms (01…, 02…, 0XX…) and a mobile missing its leading 0 (10…).
 */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = toAsciiDigits(raw).replace(/@.*$/, "").trim();
  if (!s) return null;
  // Only phone characters may appear; letters mean this isn't a phone.
  if (/[^\d\s+\-().‎‏‪-‮]/.test(s)) return null;
  const plus = /^\s*[‎‏‪-‮]*\+/.test(s);
  let d = s.replace(/\D/g, "");
  if (!d) return null;

  let intl = plus;
  if (!plus && d.startsWith("00")) {
    d = d.slice(2);
    intl = true;
  }
  if (!intl) {
    if (/^01[0125]\d{8}$/.test(d)) return `2${d}`; // national mobile
    if (/^0[2-9]\d{8}$/.test(d)) return `20${d.slice(1)}`; // national landline
    if (/^1[0125]\d{8}$/.test(d)) return `20${d}`; // mobile without the 0
    if (EG_MOBILE.test(d) || EG_LANDLINE.test(d)) return d;
    if (d.startsWith("0")) return null; // an unknown national form
  }
  if (d.startsWith("20")) {
    // "+20 010…" and "0020 010…": a stray national 0 after the country code.
    if (/^200[1-9]/.test(d)) d = `20${d.slice(3)}`;
    return EG_MOBILE.test(d) || EG_LANDLINE.test(d) ? d : null;
  }
  // Other countries: E.164 allows up to 15 digits; shorter than 8 is never a full number.
  return d.length >= 8 && d.length <= 15 && !d.startsWith("0") ? d : null;
}

const isEgyptMobile = (d) => EG_MOBILE.test(String(d || ""));
const isLandline = (d) => EG_LANDLINE.test(String(d || ""));
const isForeign = (d) => !!d && !String(d).startsWith("20");

/** "+201012345678" (or null). */
const toE164 = (raw) => {
  const d = normalizePhone(raw);
  return d ? `+${d}` : null;
};

/** Human form in Latin digits (tappable everywhere): 0101 234 5678 · 02 1234 5678 · +966 512345678. */
function displayPhone(raw) {
  const d = normalizePhone(raw);
  if (!d) return String(raw ?? "");
  if (isEgyptMobile(d)) {
    const n = `0${d.slice(2)}`;
    return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  }
  if (isLandline(d)) {
    const n = `0${d.slice(2)}`;
    return n.startsWith("02") ? `${n.slice(0, 2)} ${n.slice(2, 6)} ${n.slice(6)}` : `${n.slice(0, 3)} ${n.slice(3)}`;
  }
  return `+${d}`;
}

/** wa.me link (with optional prefilled text); null for landlines, which have no WhatsApp. */
function waMeUrl(raw, text) {
  const d = normalizePhone(raw);
  if (!d || isLandline(d)) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** tel: link for a real Call button. */
function telUrl(raw) {
  const d = normalizePhone(raw);
  return d ? `tel:+${d}` : null;
}

/** The last 4 digits ("5678"): the "Client ••5678" fallback and the erase confirmation. */
function last4(raw) {
  const d = normalizePhone(raw) || String(raw ?? "").replace(/\D/g, "");
  return d.slice(-4);
}

module.exports = {
  toAsciiDigits,
  normalizePhone,
  isEgyptMobile,
  isLandline,
  isForeign,
  toE164,
  displayPhone,
  waMeUrl,
  telUrl,
  last4
};
