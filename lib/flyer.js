// lib/flyer.js — Property flyer generator (100% English, LTR, auto height, dark + light themes)
//
// Inputs   : listing (+details), agency (name, logo_url, primary_color, secondary_color, phone),
//            broker (name, contact_phone / phone_normalized), 1-9 photos, theme "dark" | "light".
// Deal kinds (detected from the data, see detectDeal): primary | resale | cash | rent.
// Rules    : never invent data (hide what is missing) and never print Arabic text.
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;

const TextLib = require("./text");
const toEnglishSpec = TextLib.toEnglishSpec || ((v) => (v ? String(v) : null));
const cleanFeaturesList =
  TextLib.cleanFeaturesList || ((a) => (Array.isArray(a) ? a : []));
const { ensureListingImagesCurated } = require("./vision");
const WA = require("./whatsapp");
const Supabase = require("./supabase");
const { reply, replyImage } = require("./dispatcher");

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
const TAG_TYPES = [
  [/studio/i, "STUDIO"],
  [/penthouse/i, "PENTHOUSE"],
  [/duplex/i, "DUPLEX"],
  [/chalet/i, "CHALET"],
  [/town ?house/i, "TOWNHOUSE"],
  [/twin ?house/i, "TWINHOUSE"],
  [/villa/i, "VILLA"],
  [/apartment|flat/i, "APARTMENT"],
  [/land|plot/i, "LAND"],
  [/office/i, "OFFICE"],
  [/shop|retail/i, "SHOP"],
  [/clinic/i, "CLINIC"],
  [/commercial/i, "COMMERCIAL"]
];

function normalizePlans(raw) {
  const plans =
    raw && Array.isArray(raw.plans) ? raw.plans : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const p of plans) {
    if (!p || typeof p !== "object") continue;
    const name = en(p.name || p.label);
    const years = firstNum(p.years, p.duration_years, p.installment_years);
    const down = firstNumOrZero(
      p.down_payment_pct,
      p.down_payment_percent,
      p.down_pct,
      p.down
    );
    const parts = [];
    if (years) parts.push(`${trimNum(years, 1)} yrs`);
    else if (name) parts.push(truncate(name, 18));
    if (down !== null && down <= 100) parts.push(`${trimNum(down, 1)}% down`);
    if (parts.length) out.push(parts.join(" • "));
  }
  return out.slice(0, 3);
}

function detectDeal(L, D) {
  if (L.listing_type === "rent") return "rent";
  const explicit = String(
    D.market ||
      L.market ||
      D.deal_type ||
      L.deal_type ||
      D.sale_type ||
      L.sale_type ||
      ""
  ).toLowerCase();
  if (/primary|developer/.test(explicit)) return "primary";
  if (/resale/.test(explicit)) return "resale";
  if (normalizePlans(L.payment_terms || D.payment_terms).length)
    return "primary";
  const resaleSignals = [
    D.down_payment_value,
    L.down_payment_value,
    D.over_price,
    D.remaining_balance,
    D.remaining_debt,
    D.total_upfront_cash,
    D.club_fee,
    D.transfer_fee,
    D.installment_years,
    L.installment_years,
    D.installment_amount
  ];
  return resaleSignals.some((v) => firstNum(v)) ? "resale" : "cash";
}

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
  const deal = detectDeal(L, D);
  const curr = (firstText(D.currency, L.currency) || "EGP")
    .toUpperCase()
    .slice(0, 4);

  /* ---- type / tag ---- */
  const typeRaw = L.property_type;
  const typeName = en(toEnglishSpec(typeRaw, "type"))
    ? titleCase(en(toEnglishSpec(typeRaw, "type")))
    : null;
  let tagType = "";
  for (const [re, label] of TAG_TYPES)
    if (typeName && re.test(typeName)) {
      tagType = label;
      break;
    }
  if (!tagType && typeName) tagType = typeName.toUpperCase();
  const tagText = `${tagType ? tagType + " " : ""}FOR ${
    rent ? "RENT" : "SALE"
  }`;
  const badge =
    deal === "primary" ? "PRIMARY" : deal === "resale" ? "RESALE" : null;

  /* ---- place / title / location ---- */
  const compound = firstText(
    D.compound_en,
    L.compound_en,
    toEnglishSpec(L.compound, "compound")
  );
  const district = firstText(D.district_en, L.district_en, L.district);
  const city = firstText(D.city_en, L.city_en, L.city, D.city);
  const locFallback = firstText(D.location_en, L.location_en, L.location);
  const place = compound || district || city || locFallback;

  let title = firstText(D.title_en, L.title_en);
  if (title)
    title = clean(title.replace(/\s+for\s+(sale|rent)\b/gi, "")).replace(
      /[\s\-–,]+$/,
      ""
    );
  if (!title || title.length < 6)
    title = typeName
      ? place
        ? `${typeName} in ${place}`
        : typeName
      : place || "Property";
  title = truncate(title, 64);
  const tl = title.toLowerCase();
  const seen = new Set();
  const locParts = [compound, district, city].filter(Boolean).filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k) || tl.includes(k)) return false;
    seen.add(k);
    return true;
  });
  if (
    !locParts.length &&
    locFallback &&
    !tl.includes(locFallback.toLowerCase())
  )
    locParts.push(locFallback);
  const locationLine = locParts.length
    ? truncate(locParts.join(", "), 52)
    : null;

  /* ---- numbers ---- */
  const price = firstNum(L.price_value, L.total_price);
  const bua = firstNum(D.bua, L.area_value, L.bua);
  const land = firstNum(D.land_area, L.land_area);
  const garden = firstNum(D.garden_area, L.garden_area);
  const beds = firstNum(L.bedrooms, D.bedrooms);
  const baths = firstNum(D.bathrooms, L.bathrooms);
  const typeLow = (typeName || "").toLowerCase();
  const isStudio = /studio/.test(typeLow);
  const isVilla = /villa|town ?house|twin ?house|standalone/.test(typeLow);
  const isLand = /land|plot/.test(typeLow);
  const isCommercial = /office|shop|retail|clinic|commercial/.test(typeLow);
  const floor = formatFloor(D.floor_en || D.floor || L.floor);
  const finishing = firstText(
    D.finishing_en,
    toEnglishSpec(D.finishing || L.finishing || L.finishing_type, "finishing")
  );

  /* ---- delivery ---- */
  let delivery = null;
  if (
    D.ready_to_move === true ||
    L.ready_to_move === true ||
    String(D.ready_to_move) === "true"
  )
    delivery = "Ready to Move";
  else {
    const raw = normDigits(clean(D.delivery_date || L.delivery_date));
    const year = raw.match(/(20\d{2})/);
    if (year) {
      const q = raw.match(/\bq([1-4])\b/i);
      delivery = `Delivery ${q ? "Q" + q[1] + " " : ""}${year[1]}`;
    } else if (en(raw)) {
      delivery = "Delivery " + truncate(en(raw), 18);
    }
  }

  /* ---- price card ---- */
  const period = rent
    ? String(D.rent_period || L.rent_period || "").toLowerCase() === "yearly"
      ? "year"
      : "month"
    : null;
  const card = {
    kind: deal,
    missing: !price,
    label: null,
    main: null,
    unit: null,
    full: null,
    perSqm: null,
    right: null,
    notes: []
  };
  const labelFor = {
    rent: "Rent",
    primary: "Price",
    resale: "Total price",
    cash: "Asking price"
  };
  card.label = labelFor[deal];
  if (!price) {
    card.main = "Price on request";
  } else if (rent) {
    card.main = money(price);
    card.unit = `${curr} / ${period}`;
  } else {
    card.main = abbr(price);
    card.unit = curr;
    if (price >= 1e4 && abbr(price) !== money(price))
      card.full = `${money(price)} ${curr}`;
    const area = bua || (isLand ? firstNum(land, L.area_value) : null);
    if (area && price / area >= 1)
      card.perSqm = `~${abbr(price / area)} ${curr} / sqm`;
  }

  const maintenance = firstNum(D.maintenance_fee, L.maintenance_fee);
  const maintLine = maintenance
    ? `Maintenance deposit ${abbr(maintenance)} (${
        D.maintenance_paid ? "paid" : "due on delivery"
      })`
    : null;

  if (deal === "primary") {
    const lines = normalizePlans(L.payment_terms || D.payment_terms);
    card.right = { type: "lines", lines, bold: delivery ? [delivery] : [] };
    if (maintLine) card.notes.push(maintLine);
  } else if (deal === "resale") {
    const dp = firstNum(D.down_payment_value, L.down_payment_value);
    const over = firstNum(D.over_price);
    const fees =
      (firstNum(D.club_fee) || 0) + (firstNum(D.transfer_fee) || 0) || null;
    const upfront =
      firstNum(D.total_upfront_cash) ||
      (dp || 0) + (over || 0) + (fees || 0) ||
      null;
    const rem = firstNum(
      D.remaining_balance,
      D.remaining_debt,
      L.remaining_balance
    );
    const years = firstNum(D.installment_years, L.installment_years);
    const freq = firstText(D.installment_frequency);
    const each = firstNum(D.installment_amount);
    if (upfront)
      card.right = {
        type: "figure",
        label: "Total upfront cash",
        value: abbr(upfront)
      };
    const l1 = [
      dp && `Paid to owner ${abbr(dp)}`,
      over && `Overprice ${abbr(over)}`,
      fees && `Fees ${abbr(fees)}`
    ].filter(Boolean);
    if (l1.length) card.notes.push(l1.join(" • "));
    const l2 = [
      rem && `Remaining ${abbr(rem)}`,
      years &&
        `${trimNum(years, 1)} yrs${freq ? " " + freq.toLowerCase() : ""}`,
      each && `${abbr(each)} each`
    ].filter(Boolean);
    if (l2.length) card.notes.push(l2.join(" • "));
    if (maintLine) card.notes.push(maintLine);
  } else if (deal === "cash" && price) {
    const cashFlag =
      D.cash_only === true ||
      D.cash_only === "true" ||
      /cash/i.test(
        String(D.payment_method || D.payment_type || L.payment_method || "")
      );
    if (cashFlag) card.right = { type: "pill", text: "Cash payment" };
  }

  /* ---- facts (typology based, only valid values) ---- */
  const f = {
    area: bua && {
      icon: "area",
      label: isLand ? "Land" : "BUA",
      value: `${money(bua)} sqm`
    },
    land: isVilla &&
      land && { icon: "land", label: "Land", value: `${money(land)} sqm` },
    landOnly: isLand &&
      !bua &&
      firstNum(land, L.area_value) && {
        icon: "land",
        label: "Land",
        value: `${money(firstNum(land, L.area_value))} sqm`
      },
    beds: !isStudio &&
      !isLand &&
      !isCommercial &&
      beds && {
        icon: "bed",
        label: "Bedrooms",
        value: `${beds} Bed${beds > 1 ? "s" : ""}`
      },
    baths: !isLand &&
      baths && {
        icon: "bath",
        label: "Bathrooms",
        value: `${baths} Bath${baths > 1 ? "s" : ""}`
      },
    floor: !isVilla &&
      !isLand &&
      floor && { icon: "floor", label: "Floor", value: floor },
    finishing: !isLand &&
      finishing && {
        icon: "finishing",
        label: "Finishing",
        value: truncate(finishing, 24)
      },
    garden: garden && {
      icon: "garden",
      label: "Garden",
      value: `${money(garden)} sqm`
    }
  };
  const order = isLand
    ? ["landOnly", "area"]
    : isCommercial
    ? ["area", "floor", "finishing", "baths"]
    : isStudio
    ? ["area", "baths", "floor", "finishing", "garden"]
    : isVilla
    ? ["area", "land", "beds", "baths", "finishing", "garden"]
    : ["area", "beds", "baths", "floor", "finishing", "garden"];
  let facts = order
    .map((k) => f[k])
    .filter(Boolean)
    .slice(0, 6);

  /* ---- chips (deduped, English only) ---- */
  const chipSrc = [];
  const orient = firstText(
    D.orientation_en,
    toEnglishSpec(D.orientation, "orientation")
  );
  if (delivery && deal !== "primary") chipSrc.push({ t: delivery, hi: true });
  if (orient) chipSrc.push({ t: orient });
  if (D.has_private_pool || D.private_pool) chipSrc.push({ t: "Private Pool" });
  if (D.has_master_bedroom) chipSrc.push({ t: "Master Suite" });
  if (D.has_nanny_room || D.nanny_room) chipSrc.push({ t: "Nanny Room" });
  if (D.has_dressing_room) chipSrc.push({ t: "Dressing Room" });
  if (D.club_access) chipSrc.push({ t: "Club Access" });
  const featRaw =
    Array.isArray(D.features_en) && D.features_en.length
      ? D.features_en
      : D.features;
  let feats = [];
  try {
    feats = cleanFeaturesList(Array.isArray(featRaw) ? featRaw : []);
  } catch {
    feats = Array.isArray(featRaw) ? featRaw : [];
  }
  for (const x of feats) chipSrc.push({ t: x });

  const key = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const factKeys = facts.map((x) => key(x.value));
  const used = new Set([key(tagText), key(title)]);
  let chips = [];
  for (const c of chipSrc) {
    const t = en(c.t);
    if (!t) continue;
    const k = key(t);
    if (
      !k ||
      used.has(k) ||
      factKeys.some((fk) => fk && (fk === k || k.includes(fk)))
    )
      continue;
    if ([...used].some((u) => u.length > 5 && (u.includes(k) || k.includes(u))))
      continue;
    used.add(k);
    chips.push({ text: truncate(t, 22), hi: Boolean(c.hi) });
  }
  if (facts.length === 1 && !isLand) {
    chips.unshift({ text: `${facts[0].value} ${facts[0].label}`, hi: false });
    facts = [];
  }

  /* ---- contact / brand ---- */
  const co = Boolean(unbranded || L.is_unbranded);
  const agencyName = co ? null : firstText(A.name_en, A.name);
  const agentName = co
    ? null
    : firstText(B.name_en, B.name, L.agent_name) || agencyName;
  const phone = co
    ? null
    : formatPhone(
        B.contact_phone ||
          B.phone_normalized ||
          B.phone_number ||
          B.phone ||
          A.contact_phone ||
          A.phone
      );
  const code = String(L.code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");

  return {
    deal,
    theme,
    tag: { text: tagText, badge },
    title,
    locationLine,
    typeName,
    place,
    card,
    facts,
    chips,
    ref: code || null,
    brand: { name: agencyName, logoUrl: co ? null : A.logo_url || null },
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
  garden:
    '<path d="M12 22v-9M9 13a4.5 4.5 0 0 1 6 0M4 17a4 4 0 0 1 5.5-3.7M20 17a4 4 0 0 0-5.5-3.7"/>',
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
  const titleBlock = h(
    "div",
    { flexDirection: "column", gap: 10, width: INNER },
    [
      txt(model.title, { size: 56, weight: 700, color: T.fg, lh: 1.2 }),
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
/* 7. Public renderer                                                       */
/* ====================================================================== */
async function generateFlyerBuffer({
  listing,
  agency = {},
  broker = {},
  images = [],
  theme = "dark",
  unbranded = false
}) {
  const [boldFont, regularFont] = await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]);
  const fonts = [
    { name: "Cairo", data: regularFont, weight: 400, style: "normal" },
    { name: "Cairo", data: boldFont, weight: 700, style: "normal" }
  ];
  const model = buildFlyerModel({ listing, agency, broker, theme, unbranded });
  const T = makeTheme(theme, agency.primary_color, agency.secondary_color);

  const urls = (images || []).filter(Boolean).slice(0, MAX_PHOTOS);
  const [fetched, logo] = await Promise.all([
    Promise.all(urls.map((u) => fetchBuf(u))),
    model.brand.logoUrl && !model.unbranded
      ? prepareLogo(model.brand.logoUrl)
      : null
  ]);
  const bufs = fetched.filter(Boolean);

  let opts = PASS_LEVELS[0];
  let res = await renderPass(model, T, bufs, logo, opts, fonts);
  if (res.height > 0 && res.height < MIN_H) {
    const deficit = MIN_H - res.height;
    const grow = bufs.length ? Math.min(deficit, 520) : 0;
    opts = { ...opts, heroExtra: grow, extraPad: deficit - grow };
    res = await renderPass(model, T, bufs, logo, opts, fonts);
  } else {
    for (let i = 1; i < PASS_LEVELS.length && res.height > MAX_H; i++) {
      opts = PASS_LEVELS[i];
      res = await renderPass(model, T, bufs, logo, opts, fonts);
    }
  }
  return sharp(Buffer.from(res.svg))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
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

async function renderFlyerOnDemand(
  broker,
  code,
  flyerLang = "en",
  theme = "dark",
  ctx = {}
) {
  const { pool, lang } = ctx;

  const { rows: listingRows } = await pool.query(
    "SELECT * FROM listings WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)",
    [broker.agency_id, String(code).toUpperCase()]
  );
  if (listingRows.length === 0) {
    await reply(
      broker,
      lang === "en" ? "🔍 Listing not found." : "🔍 الوحدة غير موجودة بالمخزون."
    );
    return "done";
  }
  const listing = listingRows[0];
  const { rows: agencyRows } = await pool.query(
    "SELECT * FROM agencies WHERE id = $1",
    [broker.agency_id]
  );
  const agency = agencyRows[0] || {};
  const unbranded = Boolean(ctx.unbranded || listing.is_unbranded);

  const model = buildFlyerModel({ listing, agency, broker, theme, unbranded });
  const caption = [
    `Ref ${listing.code} – ${model.title}`,
    unbranded ? null : en(agency.name_en || agency.name)
  ]
    .filter(Boolean)
    .join("\n");

  const cacheKey = flyerCacheKey({ theme, listing, agency, broker, unbranded });
  const cachedFlyerUrl = listing.flyer_cache?.[cacheKey];
  if (cachedFlyerUrl) {
    await replyImage(broker, cachedFlyerUrl, caption);
    return "done";
  }

  // Lazy vision curation (roles + best-first order); screenshots/documents never go on a flyer
  const curated = await ensureListingImagesCurated(listing.id, ctx);
  let list = Array.isArray(curated) ? curated : [];
  const photosOnly = list.filter((i) => i && i.role !== "document");
  if (photosOnly.length) list = photosOnly;
  const imageUrls = list.map((i) => i && i.url).filter(Boolean);

  let jpegBuffer = null;
  try {
    jpegBuffer = await generateFlyerBuffer({
      listing,
      agency,
      broker,
      images: imageUrls,
      theme,
      unbranded
    });
  } catch (err) {
    console.error("[FLYER] Rendering failed:", err);
    await reply(
      broker,
      lang === "en"
        ? "❌ Failed to render brochure layout."
        : "❌ تعذر تصميم الكتالوج حالياً. يرجى المحاولة لاحقاً."
    );
    return "done";
  }

  const storagePath = `flyers/${broker.agency_id}/${
    listing.code
  }_${theme}_${Date.now()}.jpg`;
  let publicUrl = "";
  try {
    publicUrl = await Supabase.uploadFlyerImage(
      broker.agency_id,
      storagePath,
      jpegBuffer
    );
  } catch (uploadErr) {
    console.error("[FLYER] Supabase flyer upload failure:", uploadErr);
  }

  if (publicUrl) {
    // keep the newest few flyers only; do not touch updated_at (it is used for optimistic locking)
    const prev = Object.entries(listing.flyer_cache || {}).filter(
      ([k, v]) => typeof v === "string" && k !== "updated_at"
    );
    const kept = Object.fromEntries(prev.slice(-5));
    const updatedCache = {
      ...kept,
      [cacheKey]: publicUrl,
      updated_at: new Date().toISOString()
    };
    await pool.query("UPDATE listings SET flyer_cache = $1 WHERE id = $2", [
      updatedCache,
      listing.id
    ]);
  }

  // Prefer the stored URL; fall back to a direct WhatsApp upload when storage failed.
  const media =
    publicUrl ||
    (await WA.uploadWhatsAppMedia(jpegBuffer, { mimeType: "image/jpeg" }));
  if (!media || !(await replyImage(broker, media, caption))) {
    await reply(
      broker,
      lang === "en"
        ? "❌ Failed to deliver brochure to WhatsApp."
        : "❌ تعذر إرسال الكتالوج عبر واتساب."
    );
  }
  return "done";
}

module.exports = {
  generateFlyerBuffer,
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
    detectDeal,
    normalizePlans,
    ensureContrast,
    contrast,
    logoSlot,
    fitInto,
    buildTree,
    svgHeight,
    ROWS_FOR
  }
};
