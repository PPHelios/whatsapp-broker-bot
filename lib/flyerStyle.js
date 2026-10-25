// lib/flyerStyle.js — Flyer canvas constants, colour science (WCAG contrast), themes and English-only text helpers.
// Pure functions shared by the flyer model, layout and renderer (split out of lib/flyer.js; no I/O).
"use strict";

const W = 1080;
const PAD = 32;
const INNER = W - PAD * 2; // 1016
const FLYER_VERSION = "v2";
const MIN_H = 1350; // short flyers grow their photos up to this height
const MAX_H = 2400; // taller flyers are compacted (thumbnail rows, chips)
const MAX_PHOTOS = 9;


/* ====================================================================== */
/* 2. Colour science (WCAG contrast) + themes                              */
/* ====================================================================== */
const normHex = (c, fb) => {
  let s = String(c || "")
    .trim()
    .replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s))
    s = s
      .split("")
      .map((x) => x + x)
      .join("");
  return /^[0-9a-f]{6}$/i.test(s) ? "#" + s.toLowerCase() : fb;
};
const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const toHex = (v) =>
  "#" +
  v
    .map((x) =>
      Math.round(Math.max(0, Math.min(255, x)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");
const mix = (a, b, t) => {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
};
const lum = (c) => {
  const [r, g, b] = rgb(c).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const readableOn = (bg) =>
  contrast(bg, "#FFFFFF") >= 4.5 ? "#FFFFFF" : "#0D1117";

/** Nudges `fg` towards white or black (whichever helps) until it reaches `min` contrast on `bg`. */
function ensureContrast(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg;
  const target = lum(bg) > 0.4 ? "#000000" : "#FFFFFF";
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}

function makeTheme(mode, P, S) {
  const isLight = mode === "light";
  const primary = normHex(P, isLight ? "#14365c" : "#0f2a4a");
  const secondary = normHex(S, "#e5b94c");
  const bg = isLight ? "#F5F7FA" : "#0B1020";
  const onHeader = readableOn(primary);
  return {
    isDark: !isLight,
    bg,
    fg: isLight ? "#0F172A" : "#F4F6FB",
    muted: isLight ? "#51607A" : "#A9B3C7",
    card: isLight ? "#FFFFFF" : "#141C33",
    line: isLight ? "#D9E0EA" : "#26304D",
    headerBg: primary,
    onHeader,
    onHeaderMuted: mix(onHeader, primary, 0.28),
    accent: secondary, // fills: tag, price card, avatar
    onAccent: readableOn(secondary),
    onAccentMuted: mix(readableOn(secondary), secondary, 0.22),
    accentText: ensureContrast(secondary, bg, 4.5), // icons / text drawn on the page background
    accentOnHeader: ensureContrast(secondary, primary, 3) // ref badge on the header band
  };
}

/* ====================================================================== */
/* 3. Text helpers (English only, never invent)                             */
/* ====================================================================== */
const ARABIC_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const hasArabic = (s) => ARABIC_RE.test(String(s == null ? "" : s));

const normDigits = (s) =>
  String(s == null ? "" : s)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

const clean = (s) =>
  String(s == null ? "" : s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** English-only text: Arabic characters are removed; <2 Latin letters left => null. */
function en(s) {
  let t = clean(s);
  if (!t) return null;
  if (hasArabic(t)) {
    t = t
      .replace(new RegExp(ARABIC_RE.source, "g"), " ")
      .replace(/\(\s*\)|\[\s*\]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s\-–—•,.:;|/]+|[\s\-–—•,.:;|/]+$/g, "")
      .trim();
  }
  return /[A-Za-z].*[A-Za-z]/.test(t) ? t : null;
}

function truncate(s, n) {
  const t = clean(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (
    (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.\-–•]+$/, "") + "…"
  );
}

const SMALL_WORDS = new Set([
  "in",
  "for",
  "of",
  "at",
  "and",
  "the",
  "to",
  "on",
  "with",
  "by"
]);
function titleCase(s) {
  return clean(s)
    .split(" ")
    .map((w, i) => {
      if (!w) return w;
      if (
        /\d/.test(w) ||
        (w.length <= 4 && w === w.toUpperCase() && /[A-Z]/.test(w))
      )
        return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

const firstNum = (...vals) => {
  for (const v of vals) {
    const n = Number(String(v == null ? "" : normDigits(v)).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
};
/** Like firstNum but accepts an explicit 0 (e.g. a "0% down payment" plan). Empty values are skipped. */
const firstNumOrZero = (...vals) => {
  for (const v of vals) {
    if (v === null || v === undefined || String(v).trim() === "") continue;
    const n = Number(normDigits(v).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
};
const firstText = (...vals) => {
  for (const v of vals) {
    const t = en(v);
    if (t) return t;
  }
  return null;
};
const trimNum = (n, d) => String(Number(n.toFixed(d)));
const money = (v) => Math.round(v).toLocaleString("en-US");
function abbr(v) {
  if (v >= 1e9) return trimNum(v / 1e9, 2) + "B";
  if (v >= 1e6) return trimNum(v / 1e6, 2) + "M";
  if (v >= 1e4) return trimNum(v / 1e3, 1) + "K";
  return money(v);
}
const ordinal = (n) => {
  const m100 = n % 100;
  const s =
    m100 >= 11 && m100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
  return n + (n % 10 > 3 ? "th" : s);
};

const FLOOR_WORDS = [
  [/ground|أرضي|ارضي|^g$/i, "Ground Floor"],
  [/roof|penthouse|روف|بنتهاوس/i, "Roof"],
  [/basement|بدروم/i, "Basement"],
  [/tenth|العاشر/i, "10th Floor"],
  [/ninth|التاسع/i, "9th Floor"],
  [/eighth|الثامن/i, "8th Floor"],
  [/seventh|السابع/i, "7th Floor"],
  [/sixth|السادس/i, "6th Floor"],
  [/fifth|الخامس/i, "5th Floor"],
  [/fourth|الرابع/i, "4th Floor"],
  [/third|الثالث/i, "3rd Floor"],
  [/second|الثاني|ثاني/i, "2nd Floor"],
  [/first|الأول|الاول|أول|اول/i, "1st Floor"]
];
/** "2" / "الثاني" / "ground" -> "2nd Floor"; unknown -> null (never a fake default). */
function formatFloor(raw) {
  const s = normDigits(clean(raw));
  if (!s) return null;
  const d = s.match(/^\D*(\d{1,2})\D*$/);
  if (d) {
    const n = parseInt(d[1], 10);
    return n === 0 ? "Ground Floor" : ordinal(n) + " Floor";
  }
  for (const [re, label] of FLOOR_WORDS) if (re.test(s)) return label;
  return null;
}

/** Egyptian mobile => "+20 10 5588 1114"; other numbers => "+<digits>". */
function formatPhone(raw) {
  let d = normDigits(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (/^0?1[0-25]\d{8}$/.test(d)) d = "20" + d.replace(/^0/, "");
  if (/^201[0-25]\d{8}$/.test(d))
    return `+20 ${d.slice(2, 4)} ${d.slice(4, 8)} ${d.slice(8)}`;
  return d.length >= 7 ? "+" + d : null;
}

module.exports = {
  W,
  PAD,
  INNER,
  FLYER_VERSION,
  MIN_H,
  MAX_H,
  MAX_PHOTOS,
  normHex,
  mix,
  lum,
  contrast,
  readableOn,
  ensureContrast,
  makeTheme,
  hasArabic,
  normDigits,
  clean,
  en,
  truncate,
  titleCase,
  firstNum,
  firstNumOrZero,
  firstText,
  trimNum,
  money,
  abbr,
  ordinal,
  formatFloor,
  formatPhone
};
