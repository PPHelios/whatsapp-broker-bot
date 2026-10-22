// lib/flyer.js — Luxury Property Editorial Flyer Generator (100% English LTR)
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;

const { toEnglishSpec } = require("./text");

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

  if (isLight) {
    const bg = "#F8FAFC";
    const fg = "#0F172A";
    const accent = normHex(S, "#8C6212"); // Deep bronze
    return {
      isDark: false,
      bg,
      fg,
      muted: "#64748B",
      card: "#FFFFFF",
      cardElevated: "#F1F5F9",
      line: "#E2E8F0",
      headerBg: normHex(P, "#0F172A"),
      onHeader: "#FFFFFF",
      accent,
      onAccent: readableOn(accent),
      priceBg: "#0F172A",
      priceNum: "#F8FAFC",
      priceFg: "#FFFFFF",
      priceSub: "#94A3B8"
    };
  }

  // Dark Mode (Default Luxury Standard)
  const bg = "#080C14";
  const fg = "#F9FAFB";
  const accent = normHex(S, "#E5B94C"); // Luminous Gold
  return {
    isDark: true,
    bg,
    fg,
    muted: "#9CA3AF",
    card: "#111827",
    cardElevated: "#1F2937",
    line: "#1F2937",
    headerBg: normHex(P, "#0D111A"),
    onHeader: "#F9FAFB",
    accent,
    onAccent: "#080C14",
    priceBg: "#111827",
    priceNum: accent,
    priceFg: "#F9FAFB",
    priceSub: "#9CA3AF"
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
  area: "Total Area",
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

function resolveEnglishFloor(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/أرضي|ارضي|ground/i.test(s)) return "Ground Floor";
  if (/أول|اول|first|1/i.test(s)) return "1st Floor";
  if (/ثاني|تاني|second|2/i.test(s)) return "2nd Floor";
  if (/ثالث|تالت|third|3/i.test(s)) return "3rd Floor";
  if (/رابع|4/i.test(s)) return "4th Floor";
  if (/أخير|اخير|بنتهاوس|roof|last/i.test(s)) return "Penthouse";
  return "Typical Floor";
}

function resolveEnglishFinishing(raw) {
  if (!raw) return null;
  return toEnglishSpec(raw, "finishing") || "Fully Finished";
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
      width = "100%",
      nowrap = false
    } = o;

    return h(
      "div",
      {
        width,
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
        whiteSpace: nowrap ? "nowrap" : "normal"
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

  // Strictly ingest up to 9 curated images
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

  // Dynamic Grid Computation: Hero Height & Row Configurations
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
      // The Editorial Sandwich: Row of 3 + Feature Duo of 2 + Row of 3
      heroHeight = 360;
      secondaryRowsDef = [
        { cols: 3, count: 3, h: 170, w: Math.floor((INNER - GAP * 2) / 3) },
        { cols: 2, count: 2, h: 215, w: Math.floor((INNER - GAP) / 2) },
        { cols: 3, count: 3, h: 170, w: Math.floor((INNER - GAP * 2) / 3) }
      ];
      break;
  }

  // Pre-process Cover Buffers via Sharp
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
    const rem = details.remaining_balance;

    if (upfront) {
      primaryBadge = `Cash: ${formatAbbr(upfront)} ${currency}`;
    }
    if (rem) {
      secondaryBadge = `Rem: ${formatAbbr(rem)} ${currency}`;
    } else if (details.installment_years) {
      secondaryBadge = `${details.installment_years} Yrs Installments`;
    }
  }

  // Quick-Scan Metrics Matrix
  const isStudio = listing.property_type === "studio";
  const bedCount = Number(listing.bedrooms);
  let bedStr = "-";
  if (isStudio) {
    bedStr = "Studio";
  } else if (Number.isFinite(bedCount)) {
    bedStr = details.has_master_bedroom
      ? `${bedCount} Beds (Master)`
      : `${bedCount} Beds`;
  }

  const floorVal = resolveEnglishFloor(details.floor_en || details.floor);
  const finishingVal = resolveEnglishFinishing(
    details.finishing_en || details.finishing
  );

  const facts = [
    listing.area_value && {
      icon: "area",
      label: L.area,
      value: `${listing.area_value} sqm`
    },
    { icon: "bed", label: L.bedrooms, value: bedStr },
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
  if (details.has_master_bedroom) luxuryBadges.push("Master Bedroom Suite");
  if (details.has_nanny_room || details.nanny_room)
    luxuryBadges.push("Nanny Room");
  if (details.has_dressing_room) luxuryBadges.push("Dressing Room");
  if (details.ready_to_move) luxuryBadges.push("Ready to Move");
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

  // Broker Identity & Affordances
  const isCoBroke = Boolean(unbranded || listing.is_unbranded);
  const brokerPhone = !isCoBroke
    ? (broker.contact_phone || broker.phone || agency.phone || "").trim()
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
      ? await prepareLogo(agency.logo_url, "#000000")
      : null;
  const agencyName = !isCoBroke ? agency.name || "Prime Real Estate" : "";

  const header = h(
    "div",
    {
      width: W,
      backgroundColor: C.headerBg,
      padding: `16px ${PAD}px`,
      alignItems: "center",
      justifyContent: "space-between",
      flexDirection: "row"
    },
    [
      logo
        ? img(logo.uri, logo.w, logo.h)
        : txt(agencyName, {
            size: 24,
            weight: 700,
            color: C.onHeader,
            width: "auto"
          }),
      h("div", { flexDirection: "row", alignItems: "center", gap: 10 }, [
        h(
          "div",
          {
            backgroundColor: C.accent,
            borderRadius: 6,
            padding: "6px 14px"
          },
          txt(isRent ? L.forRent : L.forSale, {
            size: 14,
            weight: 700,
            color: C.onAccent,
            nowrap: true
          })
        ),
        code &&
          h(
            "div",
            {
              border: `1px solid ${C.accent}`,
              borderRadius: 6,
              padding: "5px 14px",
              backgroundColor: C.cardElevated
            },
            h(
              "div",
              { color: C.accent, fontSize: 16, fontWeight: 700 },
              `#${code}`
            )
          )
      ])
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
    toEnglishSpec(listing.compound, "compound") ||
    "Prime Compound";

  const propTypeEn = listing.property_type
    ? toEnglishSpec(listing.property_type, "type")
    : "Luxury Property";

  const titleText =
    details.title_en ||
    `${propTypeEn} for ${isRent ? "Rent" : "Sale"} in ${compoundEn}`;

  const locationText = listing.district
    ? `${compoundEn} • ${listing.district}`
    : listing.location || "Prime Location, Cairo";

  const mastheadBlock = h(
    "div",
    {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      width: INNER,
      marginTop: 20
    },
    [
      h("div", { flexDirection: "column", width: 620, gap: 4 }, [
        txt(titleText, { size: 30, weight: 700, lh: 1.25 }),
        h("div", { flexDirection: "row", alignItems: "center", gap: 6 }, [
          icon("pin", C.accent, 18),
          txt(locationText, { size: 18, color: C.muted })
        ])
      ]),
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: "flex-end",
          justifyContent: "center",
          backgroundColor: C.priceBg,
          padding: "12px 20px",
          borderRadius: 10,
          border: `1px solid ${C.line}`
        },
        [
          txt(priceDisplay, {
            size: 34,
            weight: 700,
            color: C.priceNum,
            nowrap: true
          }),
          txt(primaryBadge, {
            size: 15,
            weight: 600,
            color: C.priceFg,
            nowrap: true
          }),
          secondaryBadge &&
            txt(secondaryBadge, { size: 13, color: C.priceSub, nowrap: true })
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
      marginTop: 16,
      padding: "14px 0",
      backgroundColor: C.card,
      border: `1px solid ${C.line}`,
      borderRadius: 10
    },
    facts.map((f, i) =>
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: "center",
          flexGrow: 1,
          flexBasis: 0,
          gap: 2,
          padding: "0 6px",
          ...(i ? { borderLeft: `1px solid ${C.line}` } : {})
        },
        [
          icon(f.icon, C.accent, 20),
          txt(f.value, {
            size: 18,
            weight: 700,
            align: "center",
            nowrap: true,
            width: "auto"
          }),
          txt(f.label, {
            size: 12,
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
          gap: 8,
          width: INNER,
          marginTop: 14
        },
        luxuryBadges.slice(0, 6).map((badgeText) =>
          h(
            "div",
            {
              backgroundColor: C.cardElevated,
              border: `1px solid ${C.line}`,
              borderRadius: 20,
              padding: "6px 14px",
              alignItems: "center"
            },
            txt(badgeText, {
              size: 13,
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
  const footer = brokerPhone
    ? h(
        "div",
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          width: INNER,
          marginTop: 18,
          padding: "16px 20px",
          backgroundColor: C.card,
          border: `1px solid ${C.line}`,
          borderRadius: 10
        },
        [
          h("div", { flexDirection: "column", gap: 2 }, [
            txt(brokerName, {
              size: 20,
              weight: 700,
              color: C.fg,
              width: "auto"
            }),
            txt(L.inquiries, { size: 13, color: C.muted, width: "auto" })
          ]),
          h("div", { flexDirection: "row", alignItems: "center", gap: 10 }, [
            h(
              "div",
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: C.cardElevated,
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${C.line}`
              },
              [
                icon("tel", C.accent, 16),
                txt(brokerPhone, {
                  size: 16,
                  weight: 700,
                  color: C.fg,
                  nowrap: true
                })
              ]
            ),
            h(
              "div",
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: "#25D366",
                padding: "8px 14px",
                borderRadius: 8
              },
              [
                icon("wa", "#FFFFFF", 16),
                txt("WhatsApp", {
                  size: 15,
                  weight: 700,
                  color: "#FFFFFF",
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
          padding: `18px ${PAD}px 24px`,
          width: W
        },
        [imageGrid, mastheadBlock, factsCard, featureBlock, footer]
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

  // Satori compiles dynamic height directly based on root content
  const svg = await satori(root, { width: W, fonts });
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

module.exports = {
  generateFlyerBuffer,
  renderFlyerOnDemand: generateFlyerBuffer,
  loadFont
};
