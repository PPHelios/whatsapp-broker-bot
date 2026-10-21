// lib/flyer.js
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;

const MAX_FLYER_IMAGES = 9;
const W = 1080;
const PAD = 40;
const INNER = W - PAD * 2; // 1000
const GAP = 12;
const DEFAULT_PRIMARY = "#0B132B";
const DEFAULT_SECONDARY = "#D4AF37";

/* ------------------------------------------------------------------ fonts */
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

/* ----------------------------------------------------------------- colors */
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
const toHex = (a) =>
  "#" +
  a
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
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
  contrast(bg, "#FFFFFF") >= contrast(bg, "#0B1020") ? "#FFFFFF" : "#0B1020";

const legible = (c, bg, min = 3) => {
  let out = c;
  for (let i = 0; i < 4 && contrast(out, bg) < min; i++) {
    out = mix(out, lum(bg) < 0.5 ? "#FFFFFF" : "#000000", 0.25);
  }
  return out;
};

function makeTheme(mode, P, S) {
  const dark = mode !== "light";
  const bg = dark
    ? lum(P) < 0.2
      ? P
      : mix(P, "#000000", 0.6)
    : mix("#FFFFFF", S, 0.08);
  const fg = dark ? "#FFFFFF" : lum(P) < 0.3 ? P : mix(P, "#000000", 0.55);
  const priceBg = dark ? S : lum(P) < 0.5 ? P : fg;
  return {
    dark,
    bg,
    fg,
    muted: dark ? mix("#FFFFFF", bg, 0.35) : mix(fg, "#FFFFFF", 0.3),
    card: dark ? mix(bg, "#FFFFFF", 0.06) : "#FFFFFF",
    line: mix(bg, fg, 0.18),
    icon: dark ? legible(S, bg) : fg,
    headerBg: P,
    onHeader: readableOn(P),
    accent: S,
    onAccent: readableOn(S),
    accentText: legible(S, P),
    priceBg,
    priceFg: readableOn(priceBg),
    priceNum: dark ? readableOn(S) : legible(S, priceBg),
    priceSub: dark
      ? mix(readableOn(S), S, 0.15)
      : mix(readableOn(priceBg), priceBg, 0.2)
  };
}

/* ------------------------------------------------- SSRF Guard & Media Fetch */
function isPrivateIp(ip) {
  let cleanIp = String(ip || "")
    .trim()
    .toLowerCase();
  if (cleanIp.startsWith("::ffff:")) cleanIp = cleanIp.slice(7);
  if (
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
  ) {
    return true;
  }
  return false;
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
    .resize({ width: w, height: h, fit: "cover", position: "centre" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function prepareLogo(src, bgColor, maxW = 210, maxH = 56) {
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

/* ------------------------------------------------------------- Text Helpers */
const cleanText = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

function formatAbbr(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return "";
  if (num >= 1e6) return `${+(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${+(num / 1e3).toFixed(1)}K`;
  return num.toLocaleString("en-US");
}

function mapFloorToEn(rawFloor) {
  if (!rawFloor) return null;
  const s = String(rawFloor).toLowerCase();
  if (/أرضي|ارضي|ground/i.test(s)) return "Ground Floor";
  if (/أول|اول|first|1/i.test(s)) return "1st Floor";
  if (/ثاني|تاني|second|2/i.test(s)) return "2nd Floor";
  if (/ثالث|تالت|third|3/i.test(s)) return "3rd Floor";
  if (/رابع|fourth|4/i.test(s)) return "4th Floor";
  if (/أخير|اخير|بنتهاوس|roof|last/i.test(s)) return "Penthouse";
  if (/متكرر|typical/i.test(s)) return "Typical Floor";
  return cleanText(rawFloor).replace(/[^a-zA-Z0-9 ]/g, "") || "Standard Floor";
}

function mapFinishingToEn(rawFinishing) {
  if (!rawFinishing) return "Semi-Finished";
  const s = String(rawFinishing).toLowerCase();
  if (/الترا|ألترا|ultra/i.test(s)) return "Ultra Super Lux";
  if (/سوبر|super/i.test(s)) return "Super Lux";
  if (/كامل|متشطب|fully|lux/i.test(s)) return "Fully Finished";
  if (/نصف|نص|semi/i.test(s)) return "Semi-Finished";
  if (/طوب|محارة|بدون|core|shell/i.test(s)) return "Core & Shell";
  return cleanText(rawFinishing).replace(/[^a-zA-Z0-9 ]/g, "") || "Finished";
}

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

const icon = (key, color, size = 30) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
  return img(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    size,
    size
  );
};

/* ------------------------------------------------------------- Flyer Render */
async function generateFlyerBuffer({
  listing = {},
  agency = {},
  images = [],
  theme,
  unbranded = false
}) {
  const [bold, regular] = await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]);
  if (!bold)
    throw new Error("Cairo font buffer is missing for flyer generation.");

  const details = listing.details || {};
  const P = normHex(agency.primary_color, DEFAULT_PRIMARY);
  const S = normHex(agency.secondary_color, DEFAULT_SECONDARY);
  const C = makeTheme(
    (theme || agency.flyer_theme) === "light" ? "light" : "dark",
    P,
    S
  );

  const txt = (text, o = {}) => {
    const {
      size = 24,
      weight = 400,
      color = C.fg,
      lh = 1.4,
      align = "left",
      width = "100%",
      nowrap = false
    } = o;
    const s = cleanText(text);
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
      s
    );
  };

  /* Image Curation */
  const roles = Array.isArray(details.image_roles) ? details.image_roles : [];
  let items = images.map((src, i) => ({
    src,
    role: String(roles[i] || "").toLowerCase()
  }));

  if (Array.isArray(details.image_order) && details.image_order.length) {
    const seen = new Set();
    const out = [];
    for (const idx of details.image_order) {
      if (items[idx] && !seen.has(idx)) {
        seen.add(idx);
        out.push(items[idx]);
      }
    }
    items.forEach((it, i) => !seen.has(i) && out.push(it));
    items = out;
  }

  items = items.slice(0, MAX_FLYER_IMAGES);
  const bufs = await Promise.all(
    items.map((it) => fetchBuf(it.src).catch(() => null))
  );
  items = items
    .map((it, i) => ({ ...it, buf: bufs[i] }))
    .filter((it) => it.buf);

  // Hero safety: avoid starting with kitchen or bathrooms
  const UTILITY = /kitchen|bath|toilet|washroom|laundry|مطبخ|حمام/;
  const PREFERRED =
    /exterior|facade|building|view|garden|pool|living|reception|واجهة|إطلالة|حديقة/;
  if (items.length > 1 && UTILITY.test(items[0].role)) {
    let k = items.findIndex((it) => PREFERRED.test(it.role));
    if (k < 1) k = items.findIndex((it) => !UTILITY.test(it.role));
    if (k > 0) items.unshift(items.splice(k, 1)[0]);
  }

  const subs = items.slice(1);
  const heroH = subs.length ? 500 : 580;
  const COLS = [0, 1, 2, 3, 4, 3, 3, 4, 4];
  const cols = subs.length ? COLS[Math.min(subs.length, 8)] : 1;
  const rowH = cols <= 2 ? 300 : cols === 3 ? 220 : 170;
  const rows = [];
  for (let i = 0; i < subs.length; i += cols)
    rows.push(subs.slice(i, i + cols));

  const [heroUri, rowUris] = await Promise.all([
    items[0] ? cover(items[0].buf, INNER, heroH) : null,
    Promise.all(
      rows.map((row) => {
        const tw = Math.floor((INNER - GAP * (row.length - 1)) / row.length);
        return Promise.all(
          row.map((it) =>
            cover(it.buf, tw, rowH).then((uri) => ({ uri, w: tw }))
          )
        );
      })
    )
  ]);

  /* Branding */
  const isCoBroke = Boolean(unbranded || listing.is_unbranded);
  const logoBg = normHex(agency.logo_bg, "#FFFFFF");
  const logo =
    !isCoBroke && agency.logo_url
      ? await prepareLogo(agency.logo_url, logoBg)
      : null;
  const agencyName = !isCoBroke ? cleanText(agency.name) : "";
  const showName = agencyName && (!logo || logo.ratio < 1.8);

  /* Clean Data (Strictly English) */
  const code = cleanText(listing.code).toUpperCase();
  const isRent = /rent|ايجار|إيجار/i.test(String(listing.listing_type || ""));
  const typeName = cleanText(
    listing.property_type || "Apartment"
  ).toUpperCase();

  const compound = cleanText(listing.compound);
  const locationRaw = cleanText(listing.location);
  const location = compound
    ? `${compound}, New Cairo`
    : locationRaw || "Prime Location, Cairo";

  const title =
    cleanText(details.title_en || listing.title_en) ||
    `${typeName.charAt(0) + typeName.slice(1).toLowerCase()} for ${
      isRent ? "Rent" : "Sale"
    } in ${compound || location}`;

  const summary = cleanText(details.summary_en || "");

  // Features (Strictly English, NO "Maid's Room", use "Nanny Room", include Dressing Room)
  const rawFeatures =
    Array.isArray(details.features_en) && details.features_en.length
      ? details.features_en
      : Array.isArray(details.features)
      ? details.features
      : [];

  const features = rawFeatures
    .map(cleanText)
    .filter((f) => f && f.length >= 2 && !/خادمة|maid/i.test(f));

  if (details.has_dressing_room && !features.includes("Dressing Room")) {
    features.unshift("Dressing Room");
  }
  if (details.nanny_room === true && !features.includes("Nanny Room")) {
    features.push("Nanny Room");
  }

  // Elevated 5 Core Structural Metrics: Area, Beds (with Master), Baths, Floor, Finishing
  const floorVal = details.floor_en || mapFloorToEn(details.floor);
  const finishingVal =
    details.finishing_en || mapFinishingToEn(details.finishing);
  const bedVal = details.has_master_bedroom
    ? `${listing.bedrooms || 1} Beds (Master)`
    : `${listing.bedrooms || 1} Beds`;

  const facts = [
    listing.area_value && {
      icon: "area",
      label: "Area",
      value: `${listing.area_value} sqm`
    },
    { icon: "bed", label: "Bedrooms", value: bedVal },
    details.bathrooms && {
      icon: "bath",
      label: "Bathrooms",
      value: `${details.bathrooms} Baths`
    },
    floorVal && { icon: "floor", label: "Floor", value: floorVal },
    finishingVal && {
      icon: "finishing",
      label: "Finishing",
      value: finishingVal
    }
  ]
    .filter(Boolean)
    .slice(0, 5);

  // Financial Metrics: Currency, Abbreviation, Rent vs. Installments
  const currency = ["USD", "EUR", "EGP"].includes(details.currency)
    ? details.currency
    : "EGP";
  const priceAbbr = listing.price_value ? formatAbbr(listing.price_value) : "";
  const isInstallment = Boolean(details.installment_years);
  const term = isRent
    ? details.rent_period === "yearly"
      ? "Per Year"
      : "Per Month"
    : isInstallment
    ? `${details.installment_years}-Yr Installments`
    : "Cash";

  const down = details.down_payment_value
    ? `Down: ${formatAbbr(details.down_payment_value)} ${currency}`
    : "";

  const phone = !isCoBroke
    ? cleanText(listing.contact_phone || agency.phone || agency.contact_phone)
    : "";
  const agentName = !isCoBroke
    ? cleanText(listing.agent_name || agency.name)
    : "";

  /* UI Components */
  const chip = (text, style, o = {}) =>
    h(
      "div",
      {
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 40,
        padding: "6px 20px",
        ...style
      },
      txt(text, { nowrap: true, width: "auto", ...o })
    );

  const header = h(
    "div",
    {
      width: W,
      backgroundColor: C.headerBg,
      padding: `24px ${PAD}px`,
      alignItems: "center",
      justifyContent: "space-between",
      flexDirection: "row"
    },
    [
      logo || showName
        ? h(
            "div",
            {
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              backgroundColor: logoBg,
              borderRadius: 40,
              padding: "8px 24px"
            },
            [
              logo && img(logo.uri, logo.w, logo.h),
              showName &&
                txt(agencyName, {
                  size: 24,
                  weight: 700,
                  color: readableOn(logoBg),
                  nowrap: true,
                  width: "auto"
                })
            ]
          )
        : h("div", {}, ""),
      code &&
        h(
          "div",
          {
            border: `2px solid ${C.accentText}`,
            borderRadius: 40,
            padding: "8px 24px"
          },
          h(
            "div",
            {
              color: C.accentText,
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: 1
            },
            `#${code}`
          )
        )
    ]
  );

  const gallery = heroUri
    ? h("div", { flexDirection: "column", gap: GAP, width: INNER }, [
        h("div", { position: "relative", width: INNER, height: heroH }, [
          img(heroUri, INNER, heroH, { borderRadius: 20 }),
          h(
            "div",
            {
              position: "absolute",
              top: 20,
              left: 20,
              flexDirection: "row",
              gap: 10
            },
            [
              chip(
                isRent ? `FOR RENT • ${typeName}` : `FOR SALE • ${typeName}`,
                { backgroundColor: C.accent, borderRadius: 10 },
                { size: 24, weight: 700, color: C.onAccent }
              )
            ]
          )
        ]),
        ...rowUris.map((row) =>
          h(
            "div",
            { flexDirection: "row", gap: GAP, width: INNER },
            row.map((t) => img(t.uri, t.w, rowH, { borderRadius: 14 }))
          )
        )
      ])
    : null;

  const titleBlock = h(
    "div",
    { flexDirection: "column", width: INNER, marginTop: 26, gap: 8 },
    [
      txt(title, { size: 40, weight: 700, lh: 1.3 }),
      location &&
        h(
          "div",
          { flexDirection: "row", alignItems: "center", gap: 10, width: INNER },
          [
            icon("pin", C.icon, 26),
            h(
              "div",
              { flexGrow: 1 },
              txt(location, { size: 26, color: C.muted })
            )
          ]
        )
    ]
  );

  const factsCard = h(
    "div",
    {
      flexDirection: "row",
      width: INNER,
      marginTop: 22,
      padding: "20px 0",
      backgroundColor: C.card,
      border: `1px solid ${C.line}`,
      borderRadius: 20
    },
    facts.map((f, i) =>
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: "center",
          flexGrow: 1,
          flexBasis: 0,
          gap: 6,
          padding: "0 6px",
          ...(i ? { borderLeft: `1px solid ${C.line}` } : {})
        },
        [
          icon(f.icon, C.icon),
          txt(f.value, {
            size: 22,
            weight: 700,
            align: "center",
            nowrap: true,
            width: "auto"
          }),
          txt(f.label, {
            size: 17,
            color: C.muted,
            align: "center",
            nowrap: true,
            width: "auto"
          })
        ]
      )
    )
  );

  const summaryBlock = summary
    ? h(
        "div",
        {
          width: INNER,
          marginTop: 20,
          padding: "18px 24px",
          backgroundColor: C.card,
          borderRadius: 14,
          border: `1px solid ${C.line}`,
          borderLeft: `5px solid ${C.accent}`
        },
        txt(summary, { size: 23, color: C.muted, lh: 1.5 })
      )
    : null;

  const featureBlock = features.length
    ? h(
        "div",
        {
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 10,
          width: INNER,
          marginTop: 20
        },
        features
          .slice(0, 6)
          .map((f) =>
            chip(
              f,
              { backgroundColor: C.card, border: `1px solid ${C.line}` },
              { size: 21, color: C.fg }
            )
          )
      )
    : null;

  const priceBlock = h(
    "div",
    {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      width: INNER,
      marginTop: 24,
      backgroundColor: C.priceBg,
      borderRadius: 20,
      padding: "22px 34px"
    },
    [
      h("div", { flexDirection: "column", alignItems: "flex-start" }, [
        txt(isRent ? "Asking Rent" : "Asking Price", {
          size: 22,
          color: C.priceSub,
          width: "auto",
          nowrap: true
        }),
        priceAbbr
          ? h(
              "div",
              { flexDirection: "row", alignItems: "baseline", gap: 10 },
              [
                h(
                  "div",
                  {
                    fontSize: 56,
                    fontWeight: 700,
                    lineHeight: 1.2,
                    color: C.priceNum
                  },
                  priceAbbr
                ),
                txt(currency, {
                  size: 28,
                  weight: 700,
                  color: C.priceFg,
                  width: "auto",
                  nowrap: true
                })
              ]
            )
          : txt("Price on Request", {
              size: 38,
              weight: 700,
              color: C.priceNum,
              width: "auto",
              nowrap: true
            })
      ]),
      h("div", { flexDirection: "column", alignItems: "flex-end", gap: 8 }, [
        chip(
          term,
          { border: `2px solid ${C.priceFg}` },
          { size: 22, weight: 700, color: C.priceFg }
        ),
        down &&
          txt(down, {
            size: 20,
            color: C.priceSub,
            width: "auto",
            nowrap: true
          })
      ])
    ]
  );

  const footer = phone
    ? h(
        "div",
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          width: INNER,
          marginTop: 24,
          paddingTop: 20,
          borderTop: `1px solid ${C.line}`
        },
        [
          h("div", { flexDirection: "column", gap: 4 }, [
            agentName &&
              txt(agentName, {
                size: 26,
                weight: 700,
                color: C.fg,
                width: "auto",
                nowrap: true
              }),
            txt("Direct Agent Contact", {
              size: 20,
              color: C.muted,
              width: "auto",
              nowrap: true
            })
          ]),
          h("div", { flexDirection: "row", alignItems: "center", gap: 10 }, [
            icon("tel", C.icon, 28),
            h("div", { fontSize: 28, fontWeight: 700, color: C.fg }, phone)
          ])
        ]
      )
    : null;

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
          padding: `26px ${PAD}px ${PAD}px`,
          width: W
        },
        [
          gallery,
          titleBlock,
          factsCard,
          summaryBlock,
          featureBlock,
          priceBlock,
          footer
        ]
      )
    ]
  );

  const fonts = [
    { name: "Cairo", data: bold, weight: 700, style: "normal" },
    { name: "Cairo", data: regular || bold, weight: 400, style: "normal" }
  ];

  const svg = await satori(root, { width: W, fonts });
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

module.exports = { generateFlyerBuffer, loadFont };
