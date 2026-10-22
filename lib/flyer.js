// lib/flyer.js
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;

const { formatArabicForSatori, cleanArabicText } = require("./text");

const W = 1080;
const PAD = 40;
const INNER = W - PAD * 2; // 1000px
const GAP = 12;

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
/* 2. Color Science & WCAG Contrast                                       */
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
    const accent = normHex(S, "#8C6212"); // Deep bronze default
    return {
      isDark: false,
      bg,
      fg,
      muted: "#64748B",
      card: "#FFFFFF",
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

  // Dark Mode (Default)
  const bg = "#0D1117";
  const fg = "#F0F6FC";
  const accent = normHex(S, "#E5B94C"); // Luminous gold default
  return {
    isDark: true,
    bg,
    fg,
    muted: "#8B949E",
    card: "#161B22",
    line: "#30363D",
    headerBg: normHex(P, "#161B22"),
    onHeader: "#F0F6FC",
    accent,
    onAccent: "#0D1117",
    priceBg: "#1F242C",
    priceNum: accent,
    priceFg: "#F0F6FC",
    priceSub: "#8B949E"
  };
}

/* ====================================================================== */
/* 3. SSRF Guard & Sharp Image Normalization                              */
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
    .rotate() // EXIF auto-orientation
    .resize({ width: w, height: h, fit: "cover", position: "centre" })
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function prepareLogo(src, bgColor, maxW = 220, maxH = 56) {
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
/* 4. Multi-Language Dictionaries & Helpers                               */
/* ====================================================================== */
const LABELS = {
  ar: {
    forSale: "وحدة للبيع",
    forRent: "وحدة للإيجار",
    area: "المساحة",
    bedrooms: "الغرف",
    bathrooms: "الحمامات",
    floor: "الدور",
    finishing: "التشطيب",
    askingPrice: "السعر الإجمالي",
    askingRent: "الإيجار الشهري",
    priceOnRequest: "السعر عند الطلب",
    cash: "كاش",
    downPayment: "المقدم",
    consultant: "المستشار العقاري",
    inquiries: "للتواصل والمعاينة المباشرة",
    sqm: "م²",
    beds: "غرف",
    baths: "حمام",
    master: "ماستر",
    nannyRoom: "غرفة ناني",
    dressingRoom: "دريسنج"
  },
  en: {
    forSale: "FOR SALE",
    forRent: "FOR RENT",
    area: "Area",
    bedrooms: "Bedrooms",
    bathrooms: "Bathrooms",
    floor: "Floor",
    finishing: "Finishing",
    askingPrice: "Asking Price",
    askingRent: "Asking Rent",
    priceOnRequest: "Price on Request",
    cash: "Cash",
    downPayment: "Down",
    consultant: "Property Consultant",
    inquiries: "Direct Agent Contact",
    sqm: "sqm",
    beds: "Beds",
    baths: "Baths",
    master: "Master",
    nannyRoom: "Nanny Room",
    dressingRoom: "Dressing Room"
  }
};

function formatAbbr(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return "";
  if (num >= 1e6) return `${+(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${+(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString("en-US");
}

function mapFloor(raw, isAr) {
  if (!raw) return isAr ? "متكرر" : "Typical Floor";
  const s = String(raw).toLowerCase();
  if (/أرضي|ارضي|ground/i.test(s)) return isAr ? "أرضي" : "Ground Floor";
  if (/أول|اول|first|1/i.test(s)) return isAr ? "أول" : "1st Floor";
  if (/ثاني|تاني|second|2/i.test(s)) return isAr ? "ثاني" : "2nd Floor";
  if (/ثالث|تالت|third|3/i.test(s)) return isAr ? "ثالث" : "3rd Floor";
  if (/أخير|اخير|بنتهاوس|roof|last/i.test(s))
    return isAr ? "بنتهاوس" : "Penthouse";
  return isAr ? String(raw) : "Standard Floor";
}

function mapFinishing(raw, isAr) {
  if (!raw) return isAr ? "نصف تشطيب" : "Semi-Finished";
  const s = String(raw).toLowerCase();
  if (/الترا|ألترا|ultra/i.test(s))
    return isAr ? "ألترا سوبر لوكس" : "Ultra Super Lux";
  if (/سوبر|super/i.test(s)) return isAr ? "سوبر لوكس" : "Super Lux";
  if (/كامل|متشطب|fully|lux/i.test(s))
    return isAr ? "تشطيب كامل" : "Fully Finished";
  if (/طوب|محارة|بدون|core|shell/i.test(s))
    return isAr ? "بدون تشطيب" : "Core & Shell";
  return isAr ? "تشطيب كامل" : "Finished";
}

/* JSX Helpers */
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
    width: w,
    height: ht,
    style: { width: w, height: ht, ...style }
  }
});

const ICONS = {
  area: '<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/>',
  bath: '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/>',
  floor: '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  finishing:
    '<path d="M18.37 2.63L14 7l-1.5-1.5 4.37-4.37a2.12 2.12 0 1 1 3 3zM12.5 5.5l-8 8a2.12 2.12 0 0 0-.62 1.5V19a1 1 0 0 0 1 1h3.5a2.12 2.12 0 0 0 1.5-.62l8-8L12.5 5.5z"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  tel: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'
};

const icon = (key, color, size = 26) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
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
  images = [],
  theme = "dark",
  unbranded = false,
  lang = "ar"
}) {
  const isAr = lang === "ar";
  const L = isAr ? LABELS.ar : LABELS.en;

  const [boldFont, regularFont] = await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]);

  const details = listing.details || {};
  const C = makeTheme(theme, agency.primary_color, agency.secondary_color);

  // Text formatter applying Satori Arabic Reshaper & BiDi reordering when Arabic
  const txt = (rawText, o = {}) => {
    const {
      size = 24,
      weight = 400,
      color = C.fg,
      lh = 1.35,
      align = isAr ? "right" : "left",
      width = "100%",
      nowrap = false
    } = o;

    const formatted = isAr
      ? formatArabicForSatori(String(rawText || ""))
      : String(rawText || "");

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
      formatted
    );
  };

  /* ------------------------------------------------------------------ */
  /* Image Extraction & Curation Pipeline                               */
  /* ------------------------------------------------------------------ */
  let rawList = Array.isArray(images) && images.length ? images : [];

  // Polymorphic fallback for structured project listing objects
  if (!rawList.length && listing.images && typeof listing.images === "object") {
    rawList = [
      listing.images.hero,
      listing.images.layout,
      ...(Array.isArray(listing.images.gallery) ? listing.images.gallery : [])
    ].filter(Boolean);
  }

  const fetchedItems = await Promise.all(
    rawList.slice(0, 6).map(async (src) => {
      const buf = await fetchBuf(typeof src === "object" ? src.url : src).catch(
        () => null
      );
      return buf ? { buf } : null;
    })
  );
  const validImages = fetchedItems.filter(Boolean);

  // Enforce 1-Row Thumbnail Ceiling: Hero (450px) + exactly 1 row of up to 4 thumbnails (160px)
  const hasThumbnails = validImages.length > 1;
  const heroH = hasThumbnails ? 450 : 540;
  const thumbnails = validImages.slice(1, 5); // Max 4 thumbnails in single row
  const rowH = 160;

  const [heroUri, thumbUris] = await Promise.all([
    validImages[0] ? cover(validImages[0].buf, INNER, heroH) : null,
    Promise.all(
      thumbnails.map((t) => {
        const tw = Math.floor(
          (INNER - GAP * (thumbnails.length - 1)) / thumbnails.length
        );
        return cover(t.buf, tw, rowH).then((uri) => ({ uri, w: tw }));
      })
    )
  ]);

  /* ------------------------------------------------------------------ */
  /* Specs, Price & Payment Calculations                                */
  /* ------------------------------------------------------------------ */
  const code = String(listing.code || "").toUpperCase();
  const isRent = String(listing.listing_type || "").toLowerCase() === "rent";
  const basePrice = Number(listing.price_value || listing.total_price || 0);
  const currency = details.currency || "EGP";
  const priceDisplay = basePrice
    ? `${formatAbbr(basePrice)} ${currency}`
    : L.priceOnRequest;

  // Primary payment plan highlights (e.g. NOLL staged matrices)
  let termBadge = isRent
    ? details.rent_period === "yearly"
      ? "/ yr"
      : "/ mo"
    : L.cash;
  let downBadge = null;

  if (listing.payment_terms?.plans?.length) {
    const bestPlan = listing.payment_terms.plans[0];
    termBadge = isAr
      ? `${bestPlan.years} سنوات تقسيط`
      : `${bestPlan.years}-Yr Plan`;
    if (bestPlan.down_payment_pct) {
      downBadge = isAr
        ? `مقدم ${bestPlan.down_payment_pct}%`
        : `Down: ${bestPlan.down_payment_pct}%`;
    }
  } else if (listing.installment_years || details.installment_years) {
    const yrs = listing.installment_years || details.installment_years;
    termBadge = isAr ? `${yrs} سنوات تقسيط` : `${yrs}-Yr Plan`;
    const dp = listing.down_payment_value || details.down_payment_value;
    if (dp) {
      downBadge = isAr ? `مقدم: ${formatAbbr(dp)}` : `Down: ${formatAbbr(dp)}`;
    }
  }

  // 5 Core Structural Metrics
  const floorVal = mapFloor(details.floor, isAr);
  const finishingVal = mapFinishing(
    details.finishing || listing.finishing_type,
    isAr
  );
  const bedCount = Number(listing.bedrooms || 1);
  const bedStr = details.has_master_bedroom
    ? `${bedCount} ${L.beds} (${L.master})`
    : `${bedCount} ${L.beds}`;

  const facts = [
    listing.area_value && {
      icon: "area",
      label: L.area,
      value: `${listing.area_value} ${L.sqm}`
    },
    { icon: "bed", label: L.bedrooms, value: bedStr },
    details.bathrooms && {
      icon: "bath",
      label: L.bathrooms,
      value: `${details.bathrooms} ${L.baths}`
    },
    { icon: "floor", label: L.floor, value: floorVal },
    { icon: "finishing", label: L.finishing, value: finishingVal }
  ].filter(Boolean);

  /* ------------------------------------------------------------------ */
  /* UI Components & Layout Construction                                */
  /* ------------------------------------------------------------------ */
  const chip = (label, style = {}, o = {}) =>
    h(
      "div",
      {
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 30,
        padding: "6px 16px",
        ...style
      },
      txt(label, { nowrap: true, width: "auto", ...o })
    );

  // 1. Header (Logo & Unit Code Badge)
  const isCoBroke = Boolean(unbranded || listing.is_unbranded);
  const logo =
    !isCoBroke && agency.logo_url
      ? await prepareLogo(agency.logo_url, "#FFFFFF")
      : null;
  const agencyName = !isCoBroke ? agency.name || "" : "";

  const header = h(
    "div",
    {
      width: W,
      backgroundColor: C.headerBg,
      padding: `18px ${PAD}px`,
      alignItems: "center",
      justifyContent: "space-between",
      flexDirection: isAr ? "row-reverse" : "row"
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
      code &&
        h(
          "div",
          {
            border: `2px solid ${C.accent}`,
            borderRadius: 30,
            padding: "6px 20px"
          },
          h(
            "div",
            { color: C.accent, fontSize: 22, fontWeight: 700 },
            `#${code}`
          )
        )
    ]
  );

  // 2. Photo Gallery (Hero 16:9 + Exactly 1 Row of Thumbnails)
  const gallery = heroUri
    ? h("div", { flexDirection: "column", gap: GAP, width: INNER }, [
        h("div", { position: "relative", width: INNER, height: heroH }, [
          img(heroUri, INNER, heroH, { borderRadius: 16 }),
          h(
            "div",
            {
              position: "absolute",
              top: 16,
              [isAr ? "right" : "left"]: 16,
              flexDirection: "row"
            },
            [
              chip(
                isRent ? L.forRent : L.forSale,
                { backgroundColor: C.accent, borderRadius: 8 },
                { size: 20, weight: 700, color: C.onAccent }
              )
            ]
          )
        ]),
        thumbUris.length
          ? h(
              "div",
              {
                flexDirection: isAr ? "row-reverse" : "row",
                gap: GAP,
                width: INNER
              },
              thumbUris.map((t) => img(t.uri, t.w, rowH, { borderRadius: 12 }))
            )
          : null
      ])
    : null;

  // 3. Property Title & Location
  const titleText =
    listing.title ||
    `${listing.compound || "Prime Compound"} - ${listing.area_value || 105}m²`;
  const locationText = listing.district
    ? `${listing.district} • ${listing.city || (isAr ? "القاهرة" : "Cairo")}`
    : listing.location || (isAr ? "موقع متميز" : "Prime Location");

  const titleBlock = h(
    "div",
    { flexDirection: "column", width: INNER, marginTop: 20, gap: 6 },
    [
      txt(titleText, { size: 34, weight: 700, lh: 1.3 }),
      h(
        "div",
        {
          flexDirection: isAr ? "row-reverse" : "row",
          alignItems: "center",
          gap: 8,
          width: INNER
        },
        [
          icon("pin", C.accent, 24),
          h(
            "div",
            { flexGrow: 1 },
            txt(locationText, { size: 24, color: C.muted })
          )
        ]
      )
    ]
  );

  // 4. Structural Facts Bar (Area, Beds, Baths, Floor, Finishing)
  const factsCard = h(
    "div",
    {
      flexDirection: isAr ? "row-reverse" : "row",
      width: INNER,
      marginTop: 16,
      padding: "16px 0",
      backgroundColor: C.card,
      border: `1px solid ${C.line}`,
      borderRadius: 16
    },
    facts.map((f, i) =>
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: "center",
          flexGrow: 1,
          flexBasis: 0,
          gap: 4,
          padding: "0 4px",
          ...(i && !isAr ? { borderLeft: `1px solid ${C.line}` } : {}),
          ...(i && isAr ? { borderRight: `1px solid ${C.line}` } : {})
        },
        [
          icon(f.icon, C.accent, 24),
          txt(f.value, {
            size: 20,
            weight: 700,
            align: "center",
            nowrap: true,
            width: "auto"
          }),
          txt(f.label, {
            size: 15,
            color: C.muted,
            align: "center",
            nowrap: true,
            width: "auto"
          })
        ]
      )
    )
  );

  // 5. Price & Payment Terms Card (Positioned strictly <= 1050px cumulative height)
  const priceBlock = h(
    "div",
    {
      flexDirection: isAr ? "row-reverse" : "row",
      alignItems: "center",
      justifyContent: "space-between",
      width: INNER,
      marginTop: 18,
      backgroundColor: C.priceBg,
      borderRadius: 16,
      padding: "18px 28px"
    },
    [
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: isAr ? "flex-end" : "flex-start",
          gap: 2
        },
        [
          txt(isRent ? L.askingRent : L.askingPrice, {
            size: 18,
            color: C.priceSub,
            nowrap: true,
            width: "auto"
          }),
          h(
            "div",
            {
              fontSize: 44,
              fontWeight: 700,
              color: C.priceNum,
              lineHeight: 1.1
            },
            priceDisplay
          )
        ]
      ),
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: isAr ? "flex-start" : "flex-end",
          gap: 6
        },
        [
          chip(
            termBadge,
            {
              border: `2px solid ${C.priceFg}`,
              backgroundColor: "transparent"
            },
            { size: 20, weight: 700, color: C.priceFg }
          ),
          downBadge &&
            txt(downBadge, {
              size: 18,
              color: C.priceSub,
              nowrap: true,
              width: "auto"
            })
        ]
      )
    ]
  );

  // 6. Features Badges & Clean Summary (Below the fold)
  const rawFeatures = Array.isArray(details.features) ? details.features : [];
  const featureBadges = rawFeatures.slice(0, 5);

  const featureBlock = featureBadges.length
    ? h(
        "div",
        {
          flexDirection: isAr ? "row-reverse" : "row",
          flexWrap: "wrap",
          gap: 8,
          width: INNER,
          marginTop: 18
        },
        featureBadges.map((f) =>
          chip(
            f,
            { backgroundColor: C.card, border: `1px solid ${C.line}` },
            { size: 18, color: C.fg }
          )
        )
      )
    : null;

  // 7. Broker Contact Footer
  const brokerPhone = !isCoBroke
    ? listing.contact_phone || agency.phone || ""
    : "";
  const brokerName = !isCoBroke
    ? listing.agent_name || agency.name || L.consultant
    : "";

  const footer = brokerPhone
    ? h(
        "div",
        {
          flexDirection: isAr ? "row-reverse" : "row",
          alignItems: "center",
          justifyContent: "space-between",
          width: INNER,
          marginTop: 22,
          paddingTop: 18,
          borderTop: `1px solid ${C.line}`
        },
        [
          h(
            "div",
            {
              flexDirection: "column",
              alignItems: isAr ? "flex-end" : "flex-start",
              gap: 2
            },
            [
              txt(brokerName, {
                size: 24,
                weight: 700,
                color: C.fg,
                width: "auto"
              }),
              txt(L.inquiries, { size: 17, color: C.muted, width: "auto" })
            ]
          ),
          h(
            "div",
            {
              flexDirection: isAr ? "row-reverse" : "row",
              alignItems: "center",
              gap: 10
            },
            [
              icon("tel", C.accent, 26),
              h(
                "div",
                { fontSize: 26, fontWeight: 700, color: C.fg },
                brokerPhone
              )
            ]
          )
        ]
      )
    : null;

  // Root Container
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
          flexGrow: 1,
          padding: `22px ${PAD}px ${PAD}px`,
          width: W
        },
        [gallery, titleBlock, factsCard, priceBlock, featureBlock, footer]
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

module.exports = {
  generateFlyerBuffer,
  renderFlyerOnDemand: generateFlyerBuffer,
  loadFont
};
