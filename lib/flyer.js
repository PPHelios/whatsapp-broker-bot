// lib/flyer.js — Property flyer generator (100% English, LTR, auto height, dark + light themes)
//
// Inputs   : listing (+details), agency (name, logo_url, primary_color, secondary_color, phone),
//            broker (name, contact_phone / phone_normalized), 1-9 photos, theme "dark" | "light".
// Deal kinds (domain/fieldRules.js paymentCase): primary | resale (with installments) | cash | rent.
// Rules    : never invent data (hide what is missing) and never print Arabic text.
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const { Worker } = require("worker_threads");
const U = require("./util");
const { getConfig } = require("../config");
const Store = require("./listingStore");
const dns = require("dns").promises;

const Describe = require("../domain/describe");
const Delivery = require("../domain/delivery");
const Rules = require("../domain/fieldRules");
const Places = require("../domain/places");
const { ensureListingImagesCurated } = require("./vision");
const WA = require("./whatsapp");
const Supabase = require("./supabase");
const { reply, replyImage } = require("./dispatcher");
const { t } = require("./copy");

const W = 1080;
const PAD = 32;
const INNER = W - PAD * 2; // 1016
const FLYER_VERSION = "v2";
const MIN_H = 1350; // short flyers grow their photos up to this height
const MAX_H = 2400; // taller flyers are compacted (thumbnail rows, chips)
const MAX_PHOTOS = 9;

/* ====================================================================== */
/* 1. Fonts                                                                */
/* ====================================================================== */
const fontCache = new Map();

async function loadFont(filename) {
  if (fontCache.has(filename)) return fontCache.get(filename);
  const searchPaths = [
    path.join(process.cwd(), "fonts", filename),
    path.join(__dirname, "../fonts", filename),
    path.join(__dirname, "fonts", filename),
    path.join(process.cwd(), "assets/fonts", filename),
    path.join(__dirname, "../assets/fonts", filename),
    path.join(__dirname, "assets/fonts", filename),
    path.join(process.cwd(), filename)
  ];
  for (const candidate of searchPaths) {
    try {
      const buf = await fs.readFile(candidate);
      if (buf && buf.length > 0) {
        fontCache.set(filename, buf);
        return buf;
      }
    } catch {}
  }
  throw new Error(
    `Font file "${filename}" could not be found in any font directory.`
  );
}

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

/* ====================================================================== */
/* 4. SSRF guard, image fetching and logo preparation                      */
/* ====================================================================== */
function isPrivateIp(ip) {
  let c = String(ip || "")
    .trim()
    .toLowerCase();
  if (c.startsWith("::ffff:")) c = c.slice(7);
  return (
    /^127\./.test(c) ||
    /^10\./.test(c) ||
    /^192\.168\./.test(c) ||
    /^169\.254\./.test(c) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(c) ||
    c === "0.0.0.0" ||
    c === "::1" ||
    /^fe80:/i.test(c) ||
    /^fc00:/i.test(c) ||
    /^fd00:/i.test(c)
  );
}

async function validateSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "169.254.169.254"
  )
    return false;
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) return false;
  } catch {
    return false;
  }
  return true;
}

async function fetchBuf(src) {
  if (!src) return null;
  if (Buffer.isBuffer(src)) return src;
  if (typeof src !== "string") return null;
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    if (comma < 0) return null;
    const head = src.slice(0, comma);
    const body = src.slice(comma + 1);
    return head.includes(";base64")
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body));
  }
  if (!(await validateSafeUrl(src))) return null;
  try {
    const res = await fetch(src, {
      signal: AbortSignal.timeout(7000),
      redirect: "error"
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function cover(buf, w, h) {
  const out = await sharp(buf, { failOn: "none" })
    .rotate()
    .resize({
      width: Math.round(w),
      height: Math.round(h),
      fit: "cover",
      position: "centre"
    })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

/**
 * Logo -> { uri, w, h, ratio, light } or null. Trims empty margins, never enlarges.
 * `light` = the logo is mostly light on transparency (needs a dark plate to be visible).
 */
async function prepareLogo(src) {
  try {
    const buf = await fetchBuf(src);
    if (!buf) return null;
    const trimmed = await sharp(buf, { failOn: "none" })
      .rotate()
      .trim({ threshold: 12 })
      .toBuffer()
      .catch(() => buf);
    const meta = await sharp(trimmed).metadata();
    if (!meta.width || !meta.height) return null;

    // luminance of the opaque pixels on a tiny copy
    const tiny = await sharp(trimmed)
      .ensureAlpha()
      .resize(48, 48, { fit: "inside" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0;
    let n = 0;
    let transparent = 0;
    const ch = tiny.info.channels;
    for (let i = 0; i < tiny.data.length; i += ch) {
      if (tiny.data[i + 3] < 40) {
        transparent++;
        continue;
      }
      sum +=
        0.2126 * tiny.data[i] +
        0.7152 * tiny.data[i + 1] +
        0.0722 * tiny.data[i + 2];
      n++;
    }
    const total = tiny.data.length / ch;
    const light = transparent / total > 0.15 && n > 0 && sum / n / 255 > 0.78;

    const png = await sharp(trimmed)
      .resize({
        width: Math.min(meta.width, 900),
        height: Math.min(meta.height, 900),
        fit: "inside",
        withoutEnlargement: true
      })
      .png()
      .toBuffer();
    return {
      uri: `data:image/png;base64,${png.toString("base64")}`,
      w: meta.width,
      h: meta.height,
      ratio: meta.width / meta.height,
      light
    };
  } catch {
    return null;
  }
}

/** Slot size by logo shape (px on the 1080 canvas): { w, h, showName } */
function logoSlot(ratio) {
  if (ratio >= 2.2) return { maxW: 360, maxH: 84, showName: false };
  if (ratio >= 1.3) return { maxW: 280, maxH: 96, showName: false };
  return { maxW: 96, maxH: 96, showName: true };
}
function fitInto(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h);
  return {
    w: Math.max(1, Math.round(w * s)),
    h: Math.max(1, Math.round(h * s))
  };
}

/* ====================================================================== */
/* 5. Data model (pure: no I/O, fully unit-tested)                          */
/* ====================================================================== */
/**
 * Flyer data model. Facts come from the single description template (domain/describe.js, English)
 * and the structured columns (delivery, features, resale schedule, plans). Never invents, never Arabic.
 */
function buildFlyerModel({
  listing,
  agency,
  broker,
  theme = "dark",
  unbranded = false
} = {}) {
  const L = listing || {};
  const D = L.details && typeof L.details === "object" ? L.details : {};
  const A = agency || {};
  const B = broker || {};
  const rent = L.listing_type === "rent";
  const pcase = Rules.paymentCase(L);
  const deal = pcase === "rent" ? "rent" : pcase === "primary" ? "primary" : pcase === "resale_installments" ? "resale" : "cash";
  const curr = (firstText(D.currency, L.currency) || "EGP").toUpperCase().slice(0, 4);
  const kind = Rules.unitKind(L.property_type);
  const isStudio = kind === "studio";
  const isVilla = kind === "villa";
  const isLand = kind === "land";
  const isCommercial = kind === "commercial";

  /* ---- type / tag ---- */
  const typeName = L.property_type ? Describe.typeLabel(L, "en") : null;
  const tagText = `${typeName ? typeName.toUpperCase() + " " : ""}FOR ${rent ? "RENT" : "SALE"}`;
  const badge = deal === "primary" ? "PRIMARY" : deal === "resale" ? "RESALE" : null;

  /* ---- place / title / location (English only) ---- */
  const areaName = L.area_key ? Places.placeName("area", L.area_key)?.en : null;
  const compound = en(firstText(L.compound_en, D.compound_en, L.compound));
  const district = en(L.district) || null;
  const city = en(L.city) || null;
  const place = compound || district || (areaName ? titleCase(areaName) : null) || city || en(L.location) || null;

  let title = en(firstText(D.title_en, L.title_en));
  if (title) title = clean(title.replace(/\s+for\s+(sale|rent)\b/gi, "")).replace(/[\s\-–,]+$/, "");
  if (!title || title.length < 6) title = typeName ? (place ? `${typeName} in ${place}` : typeName) : place || "Property";
  title = truncate(title, 64);
  const titleIsFallback = !en(firstText(D.title_en, L.title_en));
  const tl = title.toLowerCase();
  const seen = new Set();
  const locParts = [compound, district, areaName ? titleCase(areaName) : null, city].filter(Boolean).filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k) || tl.includes(k)) return false;
    seen.add(k);
    return true;
  });
  const locationLine = locParts.length ? truncate(locParts.join(", "), 52) : null;

  /* ---- numbers ---- */
  const price = firstNum(L.price_value);
  const area = firstNum(L.area_value);
  const land = firstNum(D.land_area);
  const garden = firstNum(D.garden_area);
  const roof = firstNum(D.roof_area);
  const beds = firstNum(L.bedrooms);
  const baths = firstNum(L.bathrooms, D.bathrooms);
  const delivery = Delivery.formatDelivery(L, "en", { icon: false });

  /* ---- price card ---- */
  const period = rent ? (String(D.rent_period || "").toLowerCase() === "yearly" ? "year" : "month") : null;
  const card = { kind: deal, missing: !price, label: null, main: null, unit: null, full: null, perSqm: null, right: null, notes: [] };
  card.label = { rent: "Rent", primary: "Price", resale: "Total price", cash: "Asking price" }[deal];
  if (!price) {
    card.main = "Price on request";
  } else if (rent) {
    card.main = money(price);
    card.unit = `${curr} / ${period}`;
  } else {
    card.main = abbr(price);
    card.unit = curr;
    if (price >= 1e4 && abbr(price) !== money(price)) card.full = `${money(price)} ${curr}`;
    if (area && price / area >= 1) card.perSqm = `~${abbr(price / area)} ${curr} / sqm`;
  }

  const fees = [
    firstNum(D.over_price) && `Over price ${abbr(firstNum(D.over_price))}`,
    firstNum(D.club_fee) && `Club fee ${abbr(firstNum(D.club_fee))}`,
    firstNum(D.transfer_fee) && `Transfer fee ${abbr(firstNum(D.transfer_fee))}`
  ].filter(Boolean);
  const maintenance = firstNum(D.maintenance_fee);
  const maintLine = maintenance
    ? `Maintenance deposit ${abbr(maintenance)}${D.maintenance_paid === true ? " (paid)" : D.maintenance_paid === false ? " (due on delivery)" : ""}`
    : null;

  if (deal === "primary") {
    const plans = (L.payment_terms?.plans || []).filter((p) => p && (p.down_payment_pct != null || p.years != null));
    const lines = plans.slice(0, 3).map((p) => Describe.planHint(p, "en").replace(/ · /g, " • "));
    const cash = firstNum(L.payment_terms?.cash_price);
    if (cash) lines.unshift(`Cash ${abbr(cash)}`);
    card.right = { type: "lines", lines, bold: delivery ? [delivery] : [] };
    const maint = Describe.maintenanceText(L, "en");
    card.notes.push(`Maintenance ${maint}`);
    if (maintLine) card.notes.push(maintLine);
  } else if (deal === "resale") {
    const paid = firstNum(L.down_payment_value);
    const rem = firstNum(L.remaining_amount);
    const each = firstNum(L.installment_value);
    const freq = Describe.frequencyLabel(L.payment_frequency, "en");
    const yrs = Describe.yearsLeft(L);
    if (paid) card.right = { type: "figure", label: "Cash required", value: abbr(paid) };
    const sched = [
      rem && `Remaining ${abbr(rem)}`,
      each && `${freq ? freq + " " : ""}installment ${abbr(each)}`,
      !each && freq && `${freq} installments`,
      yrs && yrs > 0 && `${trimNum(yrs, 1)} years left`
    ].filter(Boolean);
    if (sched.length) card.notes.push(sched.join(" • "));
    if (fees.length) card.notes.push(fees.join(" • "));
    if (maintLine) card.notes.push(maintLine);
  } else if (fees.length || maintLine) {
    if (fees.length) card.notes.push(fees.join(" • "));
    if (maintLine) card.notes.push(maintLine);
  }

  /* ---- facts (typology based, only stated values) ---- */
  const floor = Describe.floorLabel(L, "en");
  const finishing = Describe.finishingLabel(L, "en");
  const f = {
    area: area && { icon: "area", label: isLand ? "Land" : isVilla ? "BUA" : "Area", value: `${money(area)} sqm` },
    land: isVilla && land && { icon: "land", label: "Land", value: `${money(land)} sqm` },
    beds: !isStudio && !isLand && !isCommercial && beds && { icon: "bed", label: "Bedrooms", value: `${beds} Bed${beds > 1 ? "s" : ""}` },
    studio: isStudio && { icon: "bed", label: "Layout", value: "Studio" },
    baths: !isLand && baths && { icon: "bath", label: "Bathrooms", value: `${baths} Bath${baths > 1 ? "s" : ""}` },
    floor: !isVilla && !isLand && floor && { icon: "floor", label: "Floor", value: floor.replace(/^Floor /, "") },
    finishing: !isLand && finishing && { icon: "finishing", label: "Finishing", value: truncate(finishing, 24) },
    garden: garden && { icon: "garden", label: "Garden", value: `${money(garden)} sqm` },
    roof: roof && { icon: "roof", label: "Roof", value: `${money(roof)} sqm` }
  };
  const order = isLand
    ? ["area"]
    : isCommercial
    ? ["area", "floor", "finishing", "baths"]
    : isStudio
    ? ["area", "studio", "baths", "floor", "finishing", "garden"]
    : isVilla
    ? ["area", "land", "beds", "baths", "finishing", "garden", "roof"]
    : ["area", "beds", "baths", "floor", "finishing", "garden", "roof"];
  const allFacts = order.map((k) => f[k]).filter(Boolean);
  let facts = allFacts.slice(0, 6);
  // Every captured detail appears: facts beyond the 6-cell grid become chips.
  const overflowFacts = allFacts.slice(6).map((x) => ({ t: x.icon === "finishing" ? x.value : `${x.label} ${x.value}` }));

  /* ---- chips: delivery, features, furnishing (English labels from the dictionary) ---- */
  const chipSrc = [...overflowFacts];
  if (delivery && deal !== "primary") chipSrc.unshift({ t: delivery, hi: true });
  const furnishing = Describe.furnishingLabel(L, "en");
  if (furnishing) chipSrc.push({ t: furnishing });
  for (const label of Describe.featureLabels(L, "en")) chipSrc.push({ t: label });

  const key = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  const used = new Set([key(tagText)]);
  const chips = [];
  for (const c of chipSrc) {
    const t = en(c.t);
    if (!t) continue;
    const k = key(t);
    if (!k || used.has(k)) continue;
    used.add(k);
    chips.push({ text: truncate(t, 22), hi: Boolean(c.hi) });
  }
  if (facts.length === 1 && !isLand) {
    chips.unshift({ text: `${facts[0].value} ${facts[0].label}`, hi: false });
    facts = [];
  }

  /* ---- contact / brand ---- */
  const co = Boolean(unbranded || L.is_unbranded);
  const agencyName = co ? null : en(firstText(A.name_en, A.name));
  const agentName = co ? null : en(firstText(B.name_en, B.name)) || agencyName;
  const phone = co ? null : formatPhone(B.contact_phone || B.phone_normalized || B.phone_number || A.contact_phone || A.phone);
  const code = String(L.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");

  return {
    deal,
    theme,
    tag: { text: tagText, badge },
    title,
    titleIsFallback,
    locationLine,
    typeName,
    place,
    card,
    facts,
    chips,
    ref: code || null,
    brand: { name: agencyName || null, logoUrl: co ? null : A.logo_url || null },
    contact: {
      name: agentName ? truncate(agentName, 24) : null,
      phone,
      role: "Property Consultant",
      initial: ((agentName || "").match(/[A-Za-z]/) || [""])[0].toUpperCase()
    },
    colors: { primary: A.primary_color, secondary: A.secondary_color },
    unbranded: co
  };
}

/* ====================================================================== */
/* 6. Layout (Satori element tree)                                          */
/* ====================================================================== */
const ICONS = {
  area: '<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>',
  land: '<path d="M3 21h18M5 21V7l7-4 7 4v14"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/>',
  bath: '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/>',
  floor: '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  finishing:
    '<path d="M18.37 2.63L14 7l-1.5-1.5 4.37-4.37a2.12 2.12 0 1 1 3 3zM12.5 5.5l-8 8a2.12 2.12 0 0 0-.62 1.5V19a1 1 0 0 0 1 1h3.5a2.12 2.12 0 0 0 1.5-.62l8-8L12.5 5.5z"/>',
  garden: '<path d="M12 22v-7M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM8 22h8"/>',
  roof: '<path d="M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  wa: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
};

const h = (type, style = {}, children) => {
  const kids = Array.isArray(children)
    ? children.filter((c) => c !== null && c !== undefined && c !== false)
    : children;
  return {
    type,
    props: {
      style: { display: "flex", ...style },
      ...(kids !== undefined ? { children: kids } : {})
    }
  };
};
const imgEl = (src, w, hh, style = {}) => ({
  type: "img",
  props: {
    src,
    width: w,
    height: hh,
    style: { width: w, height: hh, ...style }
  }
});
const txt = (s, o = {}) =>
  h(
    "div",
    {
      fontSize: o.size || 28,
      fontWeight: o.weight || 400,
      color: o.color,
      lineHeight: o.lh || 1.25,
      whiteSpace: o.nowrap ? "nowrap" : "normal",
      textAlign: o.align || "left",
      ...(o.style || {})
    },
    String(s)
  );
const icon = (key, color, size = 36) =>
  imgEl(
    `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
        ICONS[key] || ICONS.pin
      }</svg>`
    ).toString("base64")}`,
    size,
    size
  );

const HERO_H = {
  1: 860,
  2: 520,
  3: 440,
  4: 420,
  5: 400,
  6: 390,
  7: 380,
  8: 370,
  9: 360
};
const ROW_H = { 1: 300, 2: 215, 3: 170 };
const ROWS_FOR = [
  [],
  [1],
  [2],
  [3],
  [2, 2],
  [3, 2],
  [3, 3],
  [3, 2, 2],
  [3, 3, 2]
]; // by number of non-hero photos
const PHOTO_GAP = 10;

/** Photo grid geometry for n photos (0-9): { heroH, rows:[{count,w,h}] } */
function photoLayout(n, opts) {
  const count = Math.max(0, Math.min(MAX_PHOTOS, n));
  const rows = (ROWS_FOR[Math.max(0, count - 1)] || []).map((c) => ({
    count: c,
    w: Math.floor((INNER - (c - 1) * PHOTO_GAP) / c),
    h: Math.round(ROW_H[c] * opts.rowScale)
  }));
  const base = count === 0 ? 420 : HERO_H[count];
  return { heroH: Math.round(base * opts.heroScale) + opts.heroExtra, rows };
}

function buildTree(model, T, photos, logo, opts) {
  const { heroH, rows } = photoLayout(photos.length, opts);

  /* ---- header ---- */
  let left = null;
  if (!model.unbranded) {
    const parts = [];
    let showName = true;
    if (logo) {
      const slot = logoSlot(logo.ratio);
      const fit = fitInto(logo.w, logo.h, slot.maxW, slot.maxH);
      let plate = "#FFFFFF";
      if (logo.light) {
        plate = mix(T.headerBg, "#000000", 0.35);
        for (let t = 0.35; t <= 1 && contrast("#FFFFFF", plate) < 4.5; t += 0.1)
          plate = mix(T.headerBg, "#000000", t);
      }
      parts.push(
        h(
          "div",
          {
            background: plate,
            borderRadius: 20,
            padding: 14,
            alignItems: "center",
            justifyContent: "center"
          },
          imgEl(logo.uri, fit.w, fit.h)
        )
      );
      showName = slot.showName;
    }
    if (showName && model.brand.name) {
      parts.push(
        txt(truncate(model.brand.name, 22), {
          size: 34,
          weight: 700,
          color: T.onHeader,
          nowrap: true
        })
      );
    }
    if (parts.length) left = h("div", { alignItems: "center", gap: 18 }, parts);
  }
  const refEl = model.ref
    ? h(
        "div",
        {
          border: `2px solid ${T.accentOnHeader}`,
          borderRadius: 14,
          padding: "6px 16px"
        },
        txt(`Ref ${model.ref}`, {
          size: 28,
          weight: 700,
          color: T.accentOnHeader,
          nowrap: true
        })
      )
    : null;
  const header =
    left || refEl
      ? h(
          "div",
          {
            width: W,
            height: 140,
            background: T.headerBg,
            padding: `0 ${PAD}px`,
            alignItems: "center",
            justifyContent: left ? "space-between" : "flex-end"
          },
          [left, refEl]
        )
      : null;

  /* ---- photos ---- */
  const tag = h(
    "div",
    { position: "absolute", left: 20, top: 20, alignItems: "center", gap: 10 },
    [
      h(
        "div",
        { background: T.accent, borderRadius: 14, padding: "10px 22px" },
        txt(model.tag.text, {
          size: 30,
          weight: 700,
          color: T.onAccent,
          nowrap: true
        })
      ),
      model.tag.badge
        ? h(
            "div",
            {
              background: "rgba(0,0,0,0.55)",
              border: "2px solid #FFFFFF",
              borderRadius: 14,
              padding: "8px 18px"
            },
            txt(model.tag.badge, {
              size: 28,
              weight: 700,
              color: "#FFFFFF",
              nowrap: true
            })
          )
        : null
    ]
  );
  const hero = photos.length
    ? h("div", { position: "relative", width: INNER, height: heroH }, [
        imgEl(photos[0], INNER, heroH, { borderRadius: 20 }),
        tag
      ])
    : h(
        "div",
        {
          position: "relative",
          width: INNER,
          height: heroH,
          borderRadius: 20,
          background: T.headerBg,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14
        },
        [
          txt(truncate(model.typeName || "Property", 24), {
            size: 76,
            weight: 700,
            color: T.onHeader,
            align: "center"
          }),
          model.place
            ? txt(truncate(model.place, 36), {
                size: 38,
                color: T.onHeaderMuted,
                align: "center"
              })
            : null,
          tag
        ]
      );
  let cursor = 1;
  const rowEls = rows.map((r) => {
    const cells = [];
    for (let i = 0; i < r.count; i++)
      cells.push(imgEl(photos[cursor++], r.w, r.h, { borderRadius: 16 }));
    return h("div", { gap: PHOTO_GAP, width: INNER }, cells);
  });
  const photoBlock = h(
    "div",
    { flexDirection: "column", gap: PHOTO_GAP, width: INNER },
    [hero, ...rowEls]
  );

  /* ---- title + location ---- */
  const showTitle = photos.length || !model.titleIsFallback;
  const titleBlock = !showTitle && !model.locationLine ? null : h(
    "div",
    { flexDirection: "column", gap: 10, width: INNER },
    [
      showTitle ? txt(model.title, { size: 56, weight: 700, color: T.fg, lh: 1.2 }) : null,
      model.locationLine
        ? h("div", { alignItems: "center", gap: 10, width: INNER }, [
            icon("pin", T.accentText, 34),
            txt(model.locationLine, { size: 34, color: T.muted, nowrap: true })
          ])
        : null
    ]
  );

  /* ---- price card ---- */
  const c = model.card;
  const leftCol = h("div", { flexDirection: "column", gap: 6 }, [
    c.missing
      ? null
      : txt(c.label, { size: 28, weight: 700, color: T.onAccentMuted }),
    h("div", { alignItems: "flex-end", gap: 12 }, [
      txt(c.main, {
        size: c.missing ? 56 : 84,
        weight: 700,
        color: T.onAccent,
        lh: 1.05,
        nowrap: true
      }),
      c.unit
        ? txt(c.unit, {
            size: 36,
            weight: 700,
            color: T.onAccent,
            nowrap: true,
            style: { paddingBottom: 8 }
          })
        : null
    ]),
    c.full ? txt(c.full, { size: 28, color: T.onAccent }) : null,
    c.perSqm ? txt(c.perSqm, { size: 28, color: T.onAccentMuted }) : null
  ]);
  let rightCol = null;
  if (
    c.right &&
    c.right.type === "lines" &&
    (c.right.lines.length || c.right.bold.length)
  ) {
    rightCol = h(
      "div",
      {
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 6,
        maxWidth: 500
      },
      [
        txt("Payment plans", {
          size: 26,
          weight: 700,
          color: T.onAccentMuted,
          align: "right"
        }),
        ...c.right.lines.map((l) =>
          txt(l, { size: 28, color: T.onAccent, align: "right" })
        ),
        ...c.right.bold.map((l) =>
          txt(l, { size: 28, weight: 700, color: T.onAccent, align: "right" })
        )
      ]
    );
  } else if (c.right && c.right.type === "figure") {
    rightCol = h(
      "div",
      { flexDirection: "column", alignItems: "flex-end", gap: 4 },
      [
        txt(c.right.label, {
          size: 28,
          weight: 700,
          color: T.onAccentMuted,
          align: "right"
        }),
        txt(c.right.value, {
          size: 64,
          weight: 700,
          color: T.onAccent,
          lh: 1.05,
          nowrap: true
        })
      ]
    );
  } else if (c.right && c.right.type === "pill") {
    rightCol = h(
      "div",
      {
        border: `2px solid ${T.onAccent}`,
        borderRadius: 30,
        padding: "8px 22px"
      },
      txt(c.right.text, {
        size: 28,
        weight: 700,
        color: T.onAccent,
        nowrap: true
      })
    );
  }
  const priceCard = h(
    "div",
    {
      width: INNER,
      background: T.accent,
      borderRadius: 24,
      padding: "24px 28px",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 20
    },
    [leftCol, rightCol]
  );

  const notesCard = c.notes.length
    ? h(
        "div",
        {
          width: INNER,
          background: T.card,
          border: `2px solid ${T.line}`,
          borderRadius: 20,
          padding: "18px 24px",
          flexDirection: "column",
          gap: 8
        },
        c.notes.map((n) => txt(n, { size: 28, color: T.fg }))
      )
    : null;

  /* ---- facts grid ---- */
  let factsEl = null;
  const nf = model.facts.length;
  if (nf >= 1) {
    const cols = nf <= 3 ? nf : nf === 4 ? 2 : 3;
    const lines = [];
    for (let i = 0; i < nf; i += cols)
      lines.push(model.facts.slice(i, i + cols));
    factsEl = h(
      "div",
      {
        width: INNER,
        background: T.card,
        border: `2px solid ${T.line}`,
        borderRadius: 24,
        flexDirection: "column"
      },
      lines.map((row, ri) =>
        h(
          "div",
          {
            width: INNER - 4,
            ...(ri ? { borderTop: `2px solid ${T.line}` } : {})
          },
          row.map((f, ci) =>
            h(
              "div",
              {
                flexGrow: 1,
                flexBasis: 0,
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: "20px 10px",
                ...(ci ? { borderLeft: `2px solid ${T.line}` } : {})
              },
              [
                icon(f.icon, T.accentText, 36),
                txt(f.value, {
                  size: f.value.length > 16 ? 30 : 36,
                  weight: 700,
                  color: T.fg,
                  align: "center"
                }),
                txt(f.label, { size: 26, color: T.muted, align: "center" })
              ]
            )
          )
        )
      )
    );
  }

  /* ---- chips ---- */
  let chips = model.chips;
  if (chips.length > opts.chipMax) {
    const extra = chips.length - (opts.chipMax - 1);
    chips = [
      ...chips.slice(0, opts.chipMax - 1),
      { text: `+${extra} more`, hi: false }
    ];
  }
  const chipsEl = chips.length
    ? h(
        "div",
        { width: INNER, flexWrap: "wrap", gap: 10 },
        chips.map((ch) =>
          h(
            "div",
            {
              background: T.card,
              border: `2px solid ${ch.hi ? T.accentText : T.line}`,
              borderRadius: 30,
              padding: "8px 20px"
            },
            txt(ch.text, {
              size: 28,
              weight: 700,
              color: ch.hi ? T.accentText : T.fg,
              nowrap: true
            })
          )
        )
      )
    : null;

  /* ---- contact band ---- */
  const ct = model.contact;
  const who = ct.name
    ? h("div", { alignItems: "center", gap: 18 }, [
        ct.initial
          ? h(
              "div",
              {
                width: 88,
                height: 88,
                borderRadius: 44,
                background: T.accent,
                alignItems: "center",
                justifyContent: "center"
              },
              txt(ct.initial, { size: 44, weight: 700, color: T.onAccent })
            )
          : null,
        h("div", { flexDirection: "column", gap: 2 }, [
          txt(ct.name, {
            size: ct.name.length > 22 ? 36 : 42,
            weight: 700,
            color: T.onHeader,
            nowrap: true
          }),
          txt(ct.role, { size: 28, color: T.onHeaderMuted })
        ])
      ])
    : null;
  const call = ct.phone
    ? h(
        "div",
        {
          flexDirection: "column",
          alignItems: ct.name ? "flex-end" : "center",
          gap: 2
        },
        [
          h("div", { alignItems: "center", gap: 14 }, [
            icon("wa", T.onHeader, 44),
            txt(ct.phone, {
              size: 50,
              weight: 700,
              color: T.onHeader,
              nowrap: true
            })
          ]),
          txt("Call or WhatsApp", { size: 26, color: T.onHeaderMuted })
        ]
      )
    : null;
  const footer =
    who || call
      ? h(
          "div",
          {
            width: W,
            background: T.headerBg,
            padding: `28px ${PAD}px`,
            alignItems: "center",
            justifyContent: who && call ? "space-between" : "center"
          },
          [who, call]
        )
      : null;

  const body = h(
    "div",
    {
      width: W,
      flexDirection: "column",
      gap: 22,
      padding: `${header ? 24 : 32}px ${PAD}px ${
        (footer ? 32 : 40) + (opts.extraPad || 0)
      }px`
    },
    [photoBlock, titleBlock, priceCard, notesCard, factsEl, chipsEl]
  );

  return h(
    "div",
    {
      width: W,
      flexDirection: "column",
      background: T.bg,
      color: T.fg,
      fontFamily: "Cairo"
    },
    [header, body, footer]
  );
}

const svgHeight = (svg) => {
  const m = String(svg).match(/<svg[^>]*?\sheight="([\d.]+)"/);
  return m ? Math.ceil(parseFloat(m[1])) : 0;
};

const PASS_LEVELS = [
  { heroScale: 1, rowScale: 1, chipMax: 10, heroExtra: 0, extraPad: 0 },
  { heroScale: 0.9, rowScale: 0.88, chipMax: 8, heroExtra: 0, extraPad: 0 },
  { heroScale: 0.8, rowScale: 0.76, chipMax: 6, heroExtra: 0, extraPad: 0 }
];

async function renderPass(model, T, bufs, logo, opts, fonts) {
  const lay = photoLayout(bufs.length, opts);
  const dims = [];
  if (bufs.length) dims.push([INNER, lay.heroH]);
  for (const r of lay.rows)
    for (let i = 0; i < r.count; i++) dims.push([r.w, r.h]);
  const photos = await Promise.all(
    bufs.map((b, i) => cover(b, dims[i][0], dims[i][1]))
  );
  const tree = buildTree(model, T, photos, logo, opts);
  const svg = await satori(tree, { width: W, fonts });
  return { svg, height: svgHeight(svg) };
}

/* ====================================================================== */
/* 7. Public renderer: assets on the main thread, rendering in a worker      */
/* ====================================================================== */

let fontsPromise = null;
function flyerFonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([loadFont("Cairo-Bold.ttf"), loadFont("Cairo-Regular.ttf")]).then(([bold, regular]) => [
      { name: "Cairo", data: regular, weight: 400, style: "normal" },
      { name: "Cairo", data: bold, weight: 700, style: "normal" }
    ]);
  }
  return fontsPromise;
}

/** Downloads photos and the logo (network I/O; stays on the main thread). */
async function fetchFlyerAssets({ images = [], logoUrl = null }) {
  const urls = (images || []).filter(Boolean).slice(0, MAX_PHOTOS);
  const [fetched, logoBuf] = await Promise.all([Promise.all(urls.map((u) => fetchBuf(u))), logoUrl ? fetchBuf(logoUrl) : null]);
  return { bufs: fetched.filter(Boolean), logoBuf: logoBuf || null };
}

/**
 * CPU-only render of a prepared model + image buffers to a JPEG (runs inside the worker).
 * @param {Object} p - { model, theme, primary, secondary, bufs: Buffer[], logoBuf: Buffer|null, format }
 */
async function renderFlyerImage({ model, theme = "dark", primary, secondary, bufs = [], logoBuf = null, format = "jpeg" }) {
  const fonts = await flyerFonts();
  const T = makeTheme(theme, primary, secondary);
  const photoBufs = bufs.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)));
  const logo = logoBuf && !model.unbranded ? await prepareLogo(Buffer.isBuffer(logoBuf) ? logoBuf : Buffer.from(logoBuf)) : null;

  let opts = PASS_LEVELS[0];
  let res = await renderPass(model, T, photoBufs, logo, opts, fonts);
  if (res.height > 0 && res.height < MIN_H) {
    const deficit = MIN_H - res.height;
    const grow = photoBufs.length ? Math.min(deficit, 520) : 0;
    opts = { ...opts, heroExtra: grow, extraPad: deficit - grow };
    res = await renderPass(model, T, photoBufs, logo, opts, fonts);
  } else {
    for (let i = 1; i < PASS_LEVELS.length && res.height > MAX_H; i++) {
      opts = PASS_LEVELS[i];
      res = await renderPass(model, T, photoBufs, logo, opts, fonts);
    }
  }
  const img = sharp(Buffer.from(res.svg));
  return format === "png" ? img.png().toBuffer() : img.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

/* ---- worker pool (one worker, bounded queue) ---- */
let worker = null;
let jobSeq = 0;
const jobs = new Map();
const renderLimiter = U.createLimiter(1, { maxQueue: getConfig().flyer.maxQueue });

function failAll(err) {
  for (const { reject, timer } of jobs.values()) {
    clearTimeout(timer);
    reject(err);
  }
  jobs.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, "flyerWorker.js"));
  worker.on("message", ({ id, ok, data, error, rss }) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    clearTimeout(job.timer);
    if (ok) job.resolve({ buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength), rss });
    else job.reject(new Error(error || "flyer worker failed"));
  });
  worker.on("error", (err) => {
    failAll(err);
    worker = null;
  });
  worker.on("exit", () => {
    failAll(new Error("flyer worker exited"));
    worker = null;
  });
  worker.unref();
  return worker;
}

/** Renders in the worker thread, one job at a time; QUEUE_FULL when too many wait. */
function renderOffThread(payload) {
  const { timeoutMs } = getConfig().flyer;
  return renderLimiter(
    () =>
      new Promise((resolve, reject) => {
        const id = ++jobSeq;
        const timer = setTimeout(() => {
          jobs.delete(id);
          reject(new Error("flyer render timeout"));
          if (worker) worker.terminate().catch(() => {});
        }, timeoutMs);
        jobs.set(id, { resolve, reject, timer });
        getWorker().postMessage({ id, payload });
      })
  );
}

/** Stops the render worker (graceful shutdown, tests). */
async function stopFlyerWorker() {
  if (worker) await worker.terminate().catch(() => {});
  worker = null;
}

/**
 * Listing → JPEG buffer. Photos are fetched here; rendering runs in the worker unless disabled
 * (config.flyer.worker, off under tests) or { inline: true }.
 */
async function generateFlyerBuffer({ listing, agency = {}, broker = {}, images = [], theme = "dark", unbranded = false, inline = null, format = "jpeg" }) {
  const model = buildFlyerModel({ listing, agency, broker, theme, unbranded });
  const { bufs, logoBuf } = await fetchFlyerAssets({ images, logoUrl: model.brand.logoUrl && !model.unbranded ? model.brand.logoUrl : null });
  const payload = { model, theme, primary: agency.primary_color, secondary: agency.secondary_color, bufs, logoBuf, format };
  const useWorker = inline === null ? getConfig().flyer.worker : !inline;
  if (!useWorker) return renderFlyerImage(payload);
  return (await renderOffThread(payload)).buffer;
}

/* ====================================================================== */
/* 8. End-to-end orchestrator (cache -> lazy vision -> render -> send)      */
/* ====================================================================== */
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

/** The cache key changes whenever the flyer would look different (theme, brand, contact, listing data). */
function flyerCacheKey({ theme, listing, agency, broker, unbranded }) {
  const sig = JSON.stringify([
    FLYER_VERSION,
    theme,
    Boolean(unbranded),
    broker.id,
    broker.name,
    broker.contact_phone,
    broker.phone_normalized,
    broker.phone_number,
    agency.name,
    agency.logo_url,
    agency.primary_color,
    agency.secondary_color,
    agency.phone,
    listing.code,
    listing.price_value,
    listing.total_price,
    listing.property_type,
    listing.listing_type,
    listing.bedrooms,
    listing.area_value,
    listing.compound,
    listing.compound_en,
    listing.district,
    listing.location,
    listing.payment_terms,
    listing.delivery_date,
    listing.details
  ]);
  return `${theme}_${FLYER_VERSION}_${sha1(sig).slice(0, 12)}`;
}

/**
 * DEL-01: the one flyer pipeline (text command and button). One message: the image with its caption.
 * Cache → lazy vision curation → render (worker) → upload → send. Failures reply with an error.
 */
async function renderFlyerOnDemand(broker, code, _flyerLang = "en", theme = "dark", ctx = {}) {
  require("./dispatcher").setTurnAction("flyer");
  const { pool, lang } = ctx;
  const t0 = Date.now();
  const listing = await Store.findByCode(pool, broker.agency_id, code);
  if (!listing) {
    await reply(broker, lang === "en" ? `🔍 Unit #${code} was not found.` : `🔍 الوحدة #${code} غير موجودة.`);
    return "done";
  }
  const { rows: agencyRows } = await pool.query("SELECT * FROM agencies WHERE id = $1", [broker.agency_id]);
  const agency = agencyRows[0] || {};
  const unbranded = Boolean(ctx.unbranded || listing.is_unbranded);
  theme = theme === "light" ? "light" : "dark";

  const model = buildFlyerModel({ listing, agency, broker, theme, unbranded });
  const caption = [model.title, `Ref ${listing.code}`, model.brand.name].filter(Boolean).join("\n");

  const cacheKey = flyerCacheKey({ theme, listing, agency, broker, unbranded });
  const cachedFlyerUrl = listing.flyer_cache?.[cacheKey];
  if (cachedFlyerUrl && (await replyImage(broker, cachedFlyerUrl, caption))) return "done";

  // Curation and rendering take a while: a "designing" line first on Telegram (lib/dispatcher.js withProgress).
  return require("./dispatcher").withProgress(broker, t("flyer_working", lang), () =>
    renderAndSend(broker, ctx, { listing, agency, theme, unbranded, model, caption, cacheKey, t0 })
  );
}

/** Curates the photos, renders the flyer and sends it (cached by cacheKey). */
async function renderAndSend(broker, ctx, { listing, agency, theme, unbranded, model, caption, cacheKey, t0 }) {
  const { pool, lang } = ctx;
  // Lazy vision curation (roles + best-first order); screenshots/documents never go on a flyer.
  let list = [];
  try {
    const curated = await ensureListingImagesCurated(listing.id, { ...ctx, broker });
    list = Array.isArray(curated) ? curated : [];
  } catch (err) {
    console.warn("[FLYER] Vision curation skipped:", err.message);
    const { rows } = await pool.query("SELECT id, url, role FROM listing_images WHERE listing_id = $1 ORDER BY position", [listing.id]);
    list = rows;
  }
  const photosOnly = list.filter((i) => i && i.role !== "document");
  const imageUrls = (photosOnly.length ? photosOnly : list).map((i) => i && i.url).filter(Boolean);

  let jpegBuffer = null;
  const r0 = Date.now();
  try {
    jpegBuffer = await generateFlyerBuffer({ listing, agency, broker, images: imageUrls, theme, unbranded });
  } catch (err) {
    console.error("[FLYER] Rendering failed:", err.message);
    await reply(
      broker,
      err.code === "QUEUE_FULL"
        ? lang === "en"
          ? "⏳ Many flyers are being prepared right now. Please try again in a minute."
          : "⏳ في كتالوجات كتير بتتجهز دلوقتي. حاول تاني بعد دقيقة."
        : lang === "en"
        ? "❌ Could not render the flyer right now. Please try again later."
        : "❌ تعذر تصميم الكتالوج حالياً. يرجى المحاولة لاحقاً."
    );
    return "done";
  }
  const renderMs = Date.now() - r0;

  let publicUrl = "";
  try {
    publicUrl = await Supabase.uploadFlyerImage(broker.agency_id, `flyers/${broker.agency_id}/${listing.code}_${theme}_${Date.now()}.jpg`, jpegBuffer);
  } catch (uploadErr) {
    console.error("[FLYER] Flyer upload failure:", uploadErr.message);
  }
  if (publicUrl) {
    // Keep the newest few flyers only.
    const prev = Object.entries(listing.flyer_cache || {}).filter(([k, v]) => typeof v === "string" && k !== "updated_at");
    const updatedCache = { ...Object.fromEntries(prev.slice(-5)), [cacheKey]: publicUrl, updated_at: new Date().toISOString() };
    await pool.query("UPDATE listings SET flyer_cache = $1 WHERE id = $2", [updatedCache, listing.id]);
  }

  // Prefer the stored URL; fall back to a direct WhatsApp upload when storage failed.
  const media = publicUrl || (await WA.uploadWhatsAppMedia(jpegBuffer, { mimeType: "image/jpeg" }));
  const sent = media ? await replyImage(broker, media, caption) : null;
  if (!sent) {
    await reply(broker, lang === "en" ? "❌ Failed to deliver the flyer to WhatsApp." : "❌ تعذر إرسال الكتالوج عبر واتساب.");
  }
  pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, total_duration_ms, flyer_render_ms, metadata, created_at)
       VALUES ($1, $2, $3, 'flyer_render', $4, $5, $6, $7::jsonb, NOW())`,
      [broker.agency_id, broker.id, listing.code, sent ? "success" : "failed", Date.now() - t0, renderMs,
        JSON.stringify({ theme, unbranded, photos: imageUrls.length, rss_mb: Math.round(process.memoryUsage().rss / 1048576) })]
    )
    .catch(() => {});
  return "done";
}

module.exports = {
  generateFlyerBuffer,
  renderFlyerImage,
  fetchFlyerAssets,
  renderOffThread,
  stopFlyerWorker,
  renderFlyerOnDemand,
  loadFont,
  buildFlyerModel,
  makeTheme,
  photoLayout,
  flyerCacheKey,
  __test: {
    en,
    hasArabic,
    formatPhone,
    formatFloor,
    abbr,
    titleCase,
    truncate,
    ensureContrast,
    contrast,
    logoSlot,
    fitInto,
    buildTree,
    svgHeight,
    ROWS_FOR
  }
};
