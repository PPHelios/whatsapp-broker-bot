// lib/flyer.js — Luxury Property Editorial Flyer Generator (100% English LTR)
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;

const { toEnglishSpec } = require("./text");
const { ensureListingImagesCurated } = require("./vision");
const WA = require("./whatsapp");
const Supabase = require("./supabase");
const { reply } = require("./dispatcher");

const W = 1080;
const PAD = 32;
const INNER = W - PAD * 2; // 1016px net content width
const GAP = 10;

/* ====================================================================== */
/* 1. Font Pre-Warming & Loading                                          */
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
/* 2. Color Science & WCAG 2.1 Contrast Calibration                       */
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

function makeTheme(mode, P, S) {
  const isLight = mode === "light";
  const primary = normHex(P, isLight ? "#132A3C" : "#0F172A");
  const accent = normHex(S, isLight ? "#8E6110" : "#D9A43A");
  const goldTextDark = "#7A4F08";

  if (isLight) {
    const bg = "#F5F1EA";
    const fg = "#111827";
    const muted = "#475569";
    const card = "#FFFFFF";
    const line = "#E5E7EB";
    const chip = "#F8FAFC";
    return {
      isDark: false,
      bg,
      fg,
      muted,
      card,
      chip,
      cardElevated: "#F8FAFC",
      line,
      headerBg: primary,
      onHeader: readableOn(primary),
      accent: contrast(accent, "#FFFFFF") >= 4.5 ? accent : goldTextDark,
      onAccent: "#111827",
      priceBg: accent,
      priceNum: "#111827",
      priceFg: "#111827",
      priceSub: "#374151",
      tagText: "#111827",
      footerBg: card,
      softBg: "#F8FAFC"
    };
  }

  const bg = "#0A0F1A";
  const fg = "#F9FAFB";
  const muted = "#B7C0CC";
  const card = "#111827";
  const line = "#243041";
  const chip = "#111827";
  return {
    isDark: true,
    bg,
    fg,
    muted,
    card,
    chip,
    cardElevated: "#1F2937",
    line,
    headerBg: primary,
    onHeader: readableOn(primary),
    accent,
    onAccent: "#111827",
    priceBg: accent,
    priceNum: "#111827",
    priceFg: "#111827",
    priceSub: muted,
    tagText: "#111827",
    footerBg: card,
    softBg: "#111827"
  };
}

/* ====================================================================== */
/* 3. SSRF Guard & Image Normalization                                    */
/* ====================================================================== */
function isPrivateIp(ip) {
  let cleanIp = String(ip || "")
    .trim()
    .toLowerCase();
  if (cleanIp.startsWith("::ffff:")) cleanIp = cleanIp.slice(7);
  return (
    /^127\./.test(cleanIp) ||
    /^10\./.test(cleanIp) ||
    /^192\.168\./.test(cleanIp) ||
    /^169\.254\./.test(cleanIp) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp) ||
    cleanIp === "0.0.0.0" ||
    cleanIp === "::1" ||
    /^fe80:/i.test(cleanIp) ||
    /^fc00:/i.test(cleanIp) ||
    /^fd00:/i.test(cleanIp)
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
  ) {
    return false;
  }
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
    const [head, body = ""] = [
      src.slice(0, src.indexOf(",")),
      src.slice(src.indexOf(",") + 1)
    ];
    return head.includes(";base64")
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body));
  }

  const isSafe = await validateSafeUrl(src);
  if (!isSafe) return null;

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

async function prepareLogo(src, bgColor, maxW = 200, maxH = 46) {
  try {
    const buf = await fetchBuf(src);
    if (!buf) return null;
    let base = sharp(buf).rotate();
    try {
      base = sharp(await base.clone().trim({ threshold: 12 }).toBuffer());
    } catch (_) {}
    const png = await base
      .flatten({ background: bgColor })
      .resize({
        width: maxW * 2,
        height: maxH * 2,
        fit: "inside",
        withoutEnlargement: true
      })
      .png()
      .toBuffer();
    const m = await sharp(png).metadata();
    const ratio = m.width / m.height;
    const w = Math.round(Math.min(maxW, maxH * ratio));
    return {
      uri: `data:image/png;base64,${png.toString("base64")}`,
      w,
      h: Math.round(w / ratio),
      ratio
    };
  } catch {
    return null;
  }
}

/* ====================================================================== */
/* 4. English Typography & Presentation Dictionaries                      */
/* ====================================================================== */
const LABELS = {
  forSale: "FOR SALE",
  forRent: "FOR RENT",
  area: "BUA",
  land: "Land Plot",
  bedrooms: "Bedrooms",
  bathrooms: "Bathrooms",
  floor: "Floor",
  finishing: "Finishing",
  garden: "Garden",
  parking: "Parking",
  askingPrice: "Asking Price",
  askingRent: "Asking Rent",
  priceOnRequest: "Price on Request",
  cash: "Cash Required",
  consultant: "Luxury Property Consultant",
  inquiries: "Direct Listing Agent • Inquiries & Viewings",
  sqm: "sqm",
  beds: "Beds",
  baths: "Baths"
};

function formatAbbr(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num >= 1e6) return `${+(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${+(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString("en-US");
}

function formatPhone(raw) {
  const digits = String(raw || "")
    .replace(/\D/g, "")
    .replace(/^0+/, "");
  if (!digits) return "";
  if (digits.length >= 12) {
    const country = digits.slice(0, 2);
    const rest = digits.slice(2);
    const groups = [country, rest.slice(0, Math.min(2, rest.length))];
    if (rest.length > 2) groups.push(rest.slice(2, 6));
    if (rest.length > 6) groups.push(rest.slice(6));
    return `+${groups.filter(Boolean).join(" ")}`;
  }
  return digits.length > 6
    ? digits.replace(/(\d{3})(\d{3})(\d+)$/, "$1 $2 $3")
    : digits;
}

function resolveEnglishFloor(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/أرضي|ارضي|ground/i.test(s)) return "Ground Floor";
  if (/أول|اول|first|1|\b1st\b/i.test(s)) return "1st Floor";
  if (/ثاني|تاني|second|2|\b2nd\b/i.test(s)) return "2nd Floor";
  if (/ثالث|تالت|third|3|\b3rd\b/i.test(s)) return "3rd Floor";
  if (/رابع|4|\b4th\b/i.test(s)) return "4th Floor";
  if (/خامس|5|\b5th\b/i.test(s)) return "5th Floor";
  if (/أخير|اخير|بنتهاوس|roof|last|penthouse/i.test(s)) return "Penthouse";
  if (/\d+/.test(s)) return `${s.match(/\d+/)[0]}th Floor`;
  return null;
}

function resolveEnglishFinishing(raw) {
  if (!raw) return null;
  const value = toEnglishSpec(raw, "finishing");
  return value && value !== "Unknown" ? value : null;
}

/* JSX-like element builders */
const h = (type, style = {}, children) => ({
  type,
  props: {
    style: { display: "flex", ...style },
    children: Array.isArray(children) ? children.filter(Boolean) : children
  }
});

const img = (src, w, ht, style = {}) => ({
  type: "img",
  props: {
    src,
    width: Math.round(w),
    height: Math.round(ht),
    style: { width: Math.round(w), height: Math.round(ht), ...style }
  }
});

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
  tel: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  wa: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
};

const icon = (key, color, size = 20) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
    ICONS[key] || ICONS.pin
  }</svg>`;
  return img(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    size,
    size
  );
};

/* ====================================================================== */
/* 5. Production Flyer Buffer Generator                                   */
/* ====================================================================== */
async function generateFlyerBuffer({
  listing = {},
  agency = {},
  broker = {},
  images = [],
  theme = "dark",
  unbranded = false
}) {
  const L = LABELS;

  const [boldFont, regularFont] = await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]);

  const details = listing.details || {};
  const C = makeTheme(theme, agency.primary_color, agency.secondary_color);

  const txt = (rawText, o = {}) => {
    const {
      size = 20,
      weight = 400,
      color = C.fg,
      lh = 1.3,
      align = "left",
      width = "auto",
      nowrap = false,
      maxWidth = null
    } = o;

    return h(
      "div",
      {
        width,
        maxWidth,
        justifyContent:
          align === "center"
            ? "center"
            : align === "right"
            ? "flex-end"
            : "flex-start",
        textAlign: align,
        fontSize: size,
        fontWeight: weight,
        color,
        lineHeight: lh,
        whiteSpace: nowrap ? "nowrap" : "normal",
        overflow: "hidden",
        textOverflow: "ellipsis"
      },
      String(rawText || "")
    );
  };

  /* ------------------------------------------------------------------ */
  /* Image Ingestion & Multi-Count Adaptive Bento Setup (N = 1 to 9)    */
  /* ------------------------------------------------------------------ */
  let rawList = Array.isArray(images) && images.length ? images : [];

  if (!rawList.length && listing.images && typeof listing.images === "object") {
    rawList = [
      listing.images.hero,
      listing.images.layout,
      ...(Array.isArray(listing.images.gallery) ? listing.images.gallery : [])
    ].filter(Boolean);
  }

  const fetchedItems = await Promise.all(
    rawList.slice(0, 9).map(async (src) => {
      const buf = await fetchBuf(typeof src === "object" ? src.url : src).catch(
        () => null
      );
      return buf ? { buf } : null;
    })
  );
  const validImages = fetchedItems.filter(Boolean);
  const N = Math.min(validImages.length, 9);

  let heroHeight = 440;
  let secondaryRowsDef = [];

  switch (N) {
    case 1:
      heroHeight = 580;
      secondaryRowsDef = [];
      break;
    case 2:
      heroHeight = 440;
      secondaryRowsDef = [{ cols: 1, count: 1, h: 220, w: INNER }];
      break;
    case 3:
      heroHeight = 430;
      secondaryRowsDef = [
        { cols: 2, count: 2, h: 220, w: Math.floor((INNER - GAP) / 2) }
      ];
      break;
    case 4:
      heroHeight = 410;
      secondaryRowsDef = [
        { cols: 3, count: 3, h: 180, w: Math.floor((INNER - GAP * 2) / 3) }
      ];
      break;
    case 5:
      heroHeight = 390;
      secondaryRowsDef = [
        { cols: 2, count: 2, h: 200, w: Math.floor((INNER - GAP) / 2) },
        { cols: 2, count: 2, h: 200, w: Math.floor((INNER - GAP) / 2) }
      ];
      break;
    case 6:
      heroHeight = 380;
      secondaryRowsDef = [
        { cols: 3, count: 3, h: 175, w: Math.floor((INNER - GAP * 2) / 3) },
        { cols: 2, count: 2, h: 210, w: Math.floor((INNER - GAP) / 2) }
      ];
      break;
    case 7:
      heroHeight = 370;
      secondaryRowsDef = [
        { cols: 3, count: 3, h: 175, w: Math.floor((INNER - GAP * 2) / 3) },
        { cols: 3, count: 3, h: 175, w: Math.floor((INNER - GAP * 2) / 3) }
      ];
      break;
    case 8:
      heroHeight = 360;
      secondaryRowsDef = [
        { cols: 3, count: 3, h: 170, w: Math.floor((INNER - GAP * 2) / 3) },
        { cols: 2, count: 2, h: 200, w: Math.floor((INNER - GAP) / 2) },
        { cols: 2, count: 2, h: 200, w: Math.floor((INNER - GAP) / 2) }
      ];
      break;
    case 9:
    default:
      heroHeight = 360;
      secondaryRowsDef = [
        { cols: 3, count: 3, h: 170, w: Math.floor((INNER - GAP * 2) / 3) },
        { cols: 2, count: 2, h: 215, w: Math.floor((INNER - GAP) / 2) },
        { cols: 3, count: 3, h: 170, w: Math.floor((INNER - GAP * 2) / 3) }
      ];
      break;
  }

  const heroUri = validImages[0]
    ? await cover(validImages[0].buf, INNER, heroHeight)
    : null;

  let currentImgIndex = 1;
  const processedRows = [];

  for (const rDef of secondaryRowsDef) {
    const rowImages = [];
    for (let i = 0; i < rDef.count; i++) {
      if (currentImgIndex < validImages.length) {
        const cUri = await cover(
          validImages[currentImgIndex].buf,
          rDef.w,
          rDef.h
        );
        rowImages.push({ uri: cUri, w: rDef.w, h: rDef.h });
        currentImgIndex++;
      }
    }
    if (rowImages.length) {
      processedRows.push(rowImages);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Financials, Specs & Identity Resolution                            */
  /* ------------------------------------------------------------------ */
  const code = String(listing.code || "").toUpperCase();
  const isRent = String(listing.listing_type || "").toLowerCase() === "rent";
  const basePrice = Number(listing.price_value || listing.total_price || 0);
  const currency = details.currency || "EGP";
  const priceDisplay = basePrice
    ? `${formatAbbr(basePrice)} ${currency}`
    : L.priceOnRequest;

  let primaryBadge = isRent
    ? details.rent_period === "yearly"
      ? "Yearly Rent"
      : "Monthly Rent"
    : L.cash;
  let secondaryBadge = null;

  if (listing.payment_terms?.plans?.length) {
    const bestPlan = listing.payment_terms.plans[0];
    primaryBadge = `${bestPlan.years}-Yr Plan`;
    if (bestPlan.down_payment_pct) {
      secondaryBadge = `Down: ${bestPlan.down_payment_pct}%`;
    }
  } else {
    const upfront =
      details.total_upfront_cash ||
      details.down_payment_value ||
      listing.down_payment_value;
    const rem = details.remaining_balance || details.remaining_debt;

    if (upfront) {
      primaryBadge = `Cash: ${formatAbbr(upfront)} ${currency}`;
    }
    if (rem) {
      secondaryBadge = `Rem: ${formatAbbr(rem)} ${currency}`;
    } else if (details.installment_years || listing.installment_years) {
      secondaryBadge = `${
        details.installment_years || listing.installment_years
      } Yrs Installments`;
    }
  }

  // Typology-Aware Metric Cards
  const propType = String(listing.property_type || "").toLowerCase();
  const isVillaType = [
    "villa",
    "townhouse",
    "twinhouse",
    "standalone"
  ].includes(propType);
  const isStudio = propType === "studio";
  const bedCount = Number(listing.bedrooms);

  let bedStr = "-";
  if (isStudio) {
    bedStr = "Studio";
  } else if (Number.isFinite(bedCount)) {
    bedStr = details.has_master_bedroom
      ? `${bedCount} Beds (Master)`
      : `${bedCount} Beds`;
  }

  // Omit floor for villas entirely; elevate Land vs BUA
  const floorVal = isVillaType
    ? null
    : resolveEnglishFloor(details.floor_en || details.floor);

  const finishingVal = resolveEnglishFinishing(
    details.finishing_en || details.finishing
  );

  const facts = [
    // BUA
    (listing.area_value || details.bua) && {
      icon: "area",
      label: isVillaType ? "BUA" : L.area,
      value: `${details.bua || listing.area_value} sqm`
    },
    // Land Area (For Villas)
    isVillaType &&
      details.land_area && {
        icon: "land",
        label: L.land,
        value: `${details.land_area} sqm`
      },
    !isStudio && { icon: "bed", label: L.bedrooms, value: bedStr },
    details.bathrooms && {
      icon: "bath",
      label: L.bathrooms,
      value: `${details.bathrooms} Baths`
    },
    details.garden_area && {
      icon: "garden",
      label: L.garden,
      value: `${details.garden_area} sqm`
    },
    floorVal && { icon: "floor", label: L.floor, value: floorVal },
    finishingVal && {
      icon: "finishing",
      label: L.finishing,
      value: finishingVal
    }
  ]
    .filter(Boolean)
    .slice(0, 5); // Clean 5-column maximum

  // High-Value Curated Badges
  const luxuryBadges = [];
  const orientation =
    details.orientation_en || toEnglishSpec(details.orientation, "orientation");
  if (orientation) luxuryBadges.push(orientation);
  if (details.has_private_pool || details.private_pool)
    luxuryBadges.push("Private Pool");
  if (details.has_master_bedroom) luxuryBadges.push("Master Suite");
  if (details.has_nanny_room || details.nanny_room)
    luxuryBadges.push("Nanny Room");
  if (details.has_dressing_room) luxuryBadges.push("Dressing Room");

  // Delivery / Handover Status
  if (details.ready_to_move) {
    luxuryBadges.push("Ready to Move");
  } else if (listing.delivery_date) {
    luxuryBadges.push(`Delivery: ${listing.delivery_date}`);
  }

  if (details.club_access) luxuryBadges.push("Club Access");

  const rawFeatures =
    Array.isArray(details.features_en) && details.features_en.length
      ? details.features_en
      : Array.isArray(details.features)
      ? details.features.map((f) => toEnglishSpec(f, "feature") || f)
      : [];

  for (const f of rawFeatures) {
    if (luxuryBadges.length >= 6) break;
    if (f && !luxuryBadges.includes(f)) luxuryBadges.push(f);
  }

  // Schema Invariant: phone_normalized and phone_number
  const isCoBroke = Boolean(unbranded || listing.is_unbranded);
  const brokerPhone = !isCoBroke
    ? (
        broker.contact_phone ||
        broker.phone_normalized ||
        broker.phone_number ||
        agency.phone ||
        ""
      ).trim()
    : "";
  const brokerName = !isCoBroke
    ? (broker.name || agency.name || L.consultant).trim()
    : "";

  /* ------------------------------------------------------------------ */
  /* UI Layout Construction                                             */
  /* ------------------------------------------------------------------ */

  // 1. Header Bar
  const logo =
    !isCoBroke && agency.logo_url
      ? await prepareLogo(agency.logo_url, "#FFFFFF")
      : null;
  const agencyName = !isCoBroke ? agency.name || "Prime Real Estate" : "";

  const refBadge = code
    ? h(
        "div",
        {
          border: `1px solid ${C.accent}`,
          borderRadius: 999,
          padding: "8px 18px",
          backgroundColor: "transparent",
          alignItems: "center",
          justifyContent: "center"
        },
        txt(`Ref ${code}`, {
          size: 28,
          weight: 700,
          color: C.accent,
          nowrap: true
        })
      )
    : null;

  const header = h(
    "div",
    {
      width: W,
      height: 140,
      backgroundColor: C.headerBg,
      padding: `16px ${PAD}px`,
      alignItems: "center",
      justifyContent: "space-between",
      flexDirection: "row"
    },
    [
      logo
        ? h(
            "div",
            {
              width: 96,
              height: 96,
              borderRadius: 20,
              backgroundColor: "#FFFFFF",
              alignItems: "center",
              justifyContent: "center",
              padding: 14,
              overflow: "hidden"
            },
            img(logo.uri, logo.w, logo.h, { objectFit: "contain" })
          )
        : txt(agencyName, {
            size: 34,
            weight: 700,
            color: C.onHeader,
            width: "auto",
            nowrap: true
          }),
      refBadge
    ]
  );

  // 2. Adaptive Visual Media Grid (Hero + Rows of 2 or 3)
  const imageGrid = heroUri
    ? h("div", { flexDirection: "column", gap: GAP, width: INNER }, [
        img(heroUri, INNER, heroHeight, { borderRadius: 8 }),
        ...processedRows.map((row) =>
          h(
            "div",
            { flexDirection: "row", gap: GAP, width: INNER },
            row.map((it) => img(it.uri, it.w, it.h, { borderRadius: 8 }))
          )
        )
      ])
    : null;

  // 3. Editorial Headline & Price Masthead
  const compoundEn =
    details.compound_en ||
    listing.compound_en ||
    toEnglishSpec(listing.compound, "compound");

  const propTypeEn = listing.property_type
    ? toEnglishSpec(listing.property_type, "type")
    : "Property";

  const titleText =
    (details.title_en || listing.title_en || "")
      .replace(/\s+for\s+(Sale|Rent)$/i, "")
      .replace(/\s+for\s+Sale\s*$/i, "")
      .replace(/\s+for\s+Rent\s*$/i, "") ||
    `${propTypeEn} in ${compoundEn || "Property"}`;

  const locationBits = [
    compoundEn,
    listing.district || listing.location || details.district || details.location
  ].filter(Boolean);
  const locationText = locationBits.length
    ? locationBits.length > 1
      ? locationBits.join(", ")
      : locationBits[0]
    : "";

  const priceLabel = isRent ? "Rent" : "Asking Price";
  const fullPriceText = basePrice
    ? `${basePrice.toLocaleString("en-US")} ${currency}`
    : "Price on request";
  const paymentPill = (() => {
    if (listing.payment_terms?.plans?.length) {
      const bestPlan = listing.payment_terms.plans[0];
      return `${bestPlan.years}-yr installments`;
    }
    if (details.down_payment_value || listing.down_payment_value) {
      const down = details.down_payment_value || listing.down_payment_value;
      return `Down payment ${formatAbbr(down)} ${currency}`;
    }
    if (details.ready_to_move) return "Ready to move";
    if (listing.delivery_date) return `Delivery ${listing.delivery_date}`;
    return isRent ? "Per month" : "Cash payment";
  })();

  const mastheadBlock = h(
    "div",
    {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      width: INNER,
      marginTop: 20,
      gap: 16
    },
    [
      h("div", { flexDirection: "column", width: 640, gap: 8 }, [
        txt(titleText, {
          size: 56,
          weight: 700,
          lh: 1.2,
          color: C.fg,
          maxWidth: 620
        }),
        locationText
          ? h("div", { flexDirection: "row", alignItems: "center", gap: 8 }, [
              icon("pin", C.accent, 30),
              txt(locationText, {
                size: 34,
                color: C.muted,
                width: 500,
                nowrap: true
              })
            ])
          : null
      ]),
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: "flex-end",
          justifyContent: "center",
          backgroundColor: C.priceBg,
          padding: "22px 24px",
          borderRadius: 24,
          border: `1px solid ${C.line}`,
          minWidth: 260
        },
        [
          txt(priceLabel, {
            size: 28,
            weight: 600,
            color: C.priceFg,
            nowrap: true
          }),
          txt(
            basePrice
              ? `${formatAbbr(basePrice)} ${currency}`
              : "Price on request",
            {
              size: 84,
              weight: 700,
              color: C.priceNum,
              nowrap: true
            }
          ),
          txt(fullPriceText, {
            size: 28,
            weight: 600,
            color: C.priceFg,
            nowrap: true
          }),
          h(
            "div",
            {
              backgroundColor: C.card,
              borderRadius: 999,
              padding: "8px 16px",
              marginTop: 12,
              border: `1px solid ${C.line}`
            },
            txt(paymentPill, {
              size: 22,
              weight: 600,
              color: C.fg,
              nowrap: true
            })
          )
        ]
      )
    ]
  );

  // 4. Quick-Scan Spec Matrix
  const factsCard = h(
    "div",
    {
      flexDirection: "row",
      width: INNER,
      marginTop: 24,
      padding: "18px 0",
      backgroundColor: C.card,
      border: `1px solid ${C.line}`,
      borderRadius: 24,
      overflow: "hidden"
    },
    facts.map((f, i) =>
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flexGrow: 1,
          flexBasis: 0,
          gap: 6,
          padding: "0 12px",
          ...(i ? { borderLeft: `1px solid ${C.line}` } : {})
        },
        [
          icon(f.icon, C.accent, 36),
          txt(f.value, {
            size: 36,
            weight: 700,
            align: "center",
            nowrap: true,
            width: "auto"
          }),
          txt(f.label, {
            size: 26,
            color: C.muted,
            align: "center",
            nowrap: true,
            width: "auto"
          })
        ]
      )
    )
  );

  // 5. Curated Feature Badges
  const featureBlock = luxuryBadges.length
    ? h(
        "div",
        {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 12,
          width: INNER,
          marginTop: 20
        },
        luxuryBadges.slice(0, 5).map((badgeText) =>
          h(
            "div",
            {
              backgroundColor: C.chip,
              border: `1px solid ${C.line}`,
              borderRadius: 999,
              padding: "10px 18px",
              alignItems: "center",
              justifyContent: "center"
            },
            txt(badgeText, {
              size: 28,
              weight: 600,
              color: C.fg,
              nowrap: true,
              width: "auto"
            })
          )
        )
      )
    : null;

  // 6. Active Broker Signature Card (Call & WhatsApp Affordances)
  const formattedPhone = formatPhone(brokerPhone || "");
  const footer = brokerPhone
    ? h(
        "div",
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          width: INNER,
          marginTop: 24,
          padding: "22px 26px",
          backgroundColor: C.footerBg,
          border: `1px solid ${C.line}`,
          borderRadius: 24,
          borderTop: `2px solid ${C.accent}`
        },
        [
          h("div", { flexDirection: "column", gap: 4 }, [
            txt(brokerName || agencyName || "Property Consultant", {
              size: 42,
              weight: 700,
              color: C.fg,
              width: "auto",
              nowrap: true
            }),
            txt("Property Consultant", {
              size: 28,
              color: C.muted,
              width: "auto"
            })
          ]),
          h("div", { flexDirection: "row", alignItems: "center", gap: 14 }, [
            h(
              "div",
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                backgroundColor: C.priceBg,
                padding: "12px 18px",
                borderRadius: 999,
                border: `1px solid ${C.line}`
              },
              [
                icon("tel", C.onAccent, 28),
                txt(formattedPhone || brokerPhone, {
                  size: 50,
                  weight: 700,
                  color: C.onAccent,
                  nowrap: true
                })
              ]
            )
          ])
        ]
      )
    : null;

  // Root Content Container
  const root = h(
    "div",
    {
      width: W,
      height: 1920,
      flexDirection: "column",
      backgroundColor: C.bg,
      color: C.fg,
      fontFamily: "Cairo"
    },
    [
      header,
      h(
        "div",
        {
          flexDirection: "column",
          padding: `32px ${PAD}px 32px`,
          width: W,
          gap: 18
        },
        [
          h("div", { position: "relative", width: INNER }, [
            imageGrid,
            h(
              "div",
              {
                position: "absolute",
                top: 18,
                left: 18,
                backgroundColor: C.accent,
                padding: "10px 22px",
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center"
              },
              txt(isRent ? "VILLA FOR RENT" : "VILLA FOR SALE", {
                size: 30,
                weight: 700,
                color: C.tagText,
                nowrap: true
              })
            )
          ]),
          mastheadBlock,
          factsCard,
          featureBlock,
          footer
        ]
      )
    ]
  );

  const fonts = [
    { name: "Cairo", data: boldFont, weight: 700, style: "normal" },
    {
      name: "Cairo",
      data: regularFont || boldFont,
      weight: 400,
      style: "normal"
    }
  ];

  const svg = await satori(root, { width: W, fonts });
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

/* ====================================================================== */
/* 6. End-to-End Orchestrator (Cache -> Lazy Vision -> Render -> Send)    */
/* ====================================================================== */
async function renderFlyerOnDemand(
  broker,
  code,
  flyerLang = "en",
  theme = "dark",
  ctx = {}
) {
  const { pool, lang } = ctx;

  // 1. Fetch listing and agency records
  const { rows: listingRows } = await pool.query(
    "SELECT * FROM listings WHERE agency_id = $1 AND UPPER(code) = $2",
    [broker.agency_id, code.toUpperCase()]
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

  // 2. Check Database Flyer Cache
  const cacheKey = `${theme}_v1`;
  const cachedFlyerUrl = listing.flyer_cache?.[cacheKey];

  const flyerCaption = `#${listing.code} - ${listing.compound || ""}\n${
    agency.name || ""
  }`;

  if (cachedFlyerUrl) {
    await WA.sendWhatsAppImage(
      broker.phone_normalized,
      cachedFlyerUrl,
      flyerCaption
    );
    return "done";
  }

  // 3. Lazy Vision Photo Curation (Sorts Hero Cover, Reception, etc.)
  const curatedImages = await ensureListingImagesCurated(listing.id, ctx);
  const imageUrls =
    curatedImages && curatedImages.length > 0
      ? curatedImages.map((img) => img.url)
      : [];

  // 4. Render Flyer JPEG
  let jpegBuffer = null;
  try {
    jpegBuffer = await generateFlyerBuffer({
      listing,
      agency,
      broker,
      images: imageUrls,
      theme,
      unbranded: false
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

  // 5. Upload Rendered Flyer to Cloud Storage
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

  // 6. Update Cache in Database
  if (publicUrl) {
    const updatedCache = {
      ...(listing.flyer_cache || {}),
      [cacheKey]: publicUrl,
      updated_at: new Date().toISOString()
    };

    await pool.query(
      "UPDATE listings SET flyer_cache = $1, updated_at = NOW() WHERE id = $2",
      [updatedCache, listing.id]
    );
  }

  // 7. Deliver to WhatsApp
  if (publicUrl) {
    await WA.sendWhatsAppImage(
      broker.phone_normalized,
      publicUrl,
      flyerCaption
    );
  } else {
    const mediaId = await WA.uploadWhatsAppMedia(jpegBuffer, {
      mimeType: "image/jpeg"
    });
    if (mediaId) {
      await WA.sendWhatsAppImage(
        broker.phone_normalized,
        mediaId,
        flyerCaption
      );
    } else {
      await reply(
        broker,
        lang === "en"
          ? "❌ Failed to deliver brochure to WhatsApp."
          : "❌ تعذر إرسال الكتالوج عبر واتساب."
      );
    }
  }

  return "done";
}

module.exports = {
  generateFlyerBuffer,
  renderFlyerOnDemand,
  loadFont
};
