"use strict";
/**
 * Property flyer renderer (Satori + sharp).
 *
 * generateFlyerBuffer({ listing, agency, images, lang, theme, unbranded })
 *   lang      : "en" (default) | "ar"
 *   theme     : "dark" (A · Prestige) | "light" (B · Editorial)   default "dark"
 *   unbranded : boolean (removes logo, agent name, and phone for B2B co-broking)
 */
const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const MAX_FLYER_IMAGES = 9;
const W = 1080;
const PAD = 40;
const INNER = W - PAD * 2; // 1000
const GAP = 12;
const DEFAULT_PRIMARY = "#0B132B";
const DEFAULT_SECONDARY = "#D4AF37";

/* ------------------------------------------------------------------ fonts */
const fontCache = {};
async function loadFont(file) {
  if (fontCache[file]) return fontCache[file];
  for (const p of [
    path.join(__dirname, "../fonts", file),
    path.join(process.cwd(), "fonts", file)
  ]) {
    try {
      if (fs.existsSync(p)) return (fontCache[file] = fs.readFileSync(p));
    } catch (_) {}
  }
  try {
    const res = await fetch(
      `https://cdn.jsdelivr.net/gh/google/fonts/ofl/cairo/${file}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) return (fontCache[file] = Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.warn(`[FONT CDN ${file} FAILED]:`, err.message);
  }
  return null;
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

/* ----------------------------------------------------------------- images */
const { URL } = require("url");
const dns = require("dns").promises;

function isPrivateIp(ip) {
  // IPv4 loopback, link-local, private networks
  if (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) || // Cloud metadata & link-local
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip === "0.0.0.0"
  ) {
    return true;
  }
  // IPv6 loopback, link-local, unique local
  if (
    ip === "::1" ||
    /^fe80:/i.test(ip) ||
    /^fc00:/i.test(ip) ||
    /^fd00:/i.test(ip)
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

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    hostname === "169.254.169.254"
  ) {
    return false;
  }

  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) {
      return false;
    }
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
  if (!isSafe) {
    console.warn(`[SSRF GUARD] Blocked unsafe URL: ${src}`);
    return null;
  }

  try {
    const res = await fetch(src, {
      signal: AbortSignal.timeout(7000),
      redirect: "error" // Disallow open redirects to bypass IP checks
    });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch (err) {
    console.warn(`[FETCH FAILED] ${src}:`, err.message);
    return null;
  }
}

async function cover(buf, w, h) {
  const out = await sharp(buf, { failOn: "none" }) // <-- ADD HERE
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
  } catch (err) {
    console.error("⚠️ [FLYER LOGO FAILED]:", err.message);
    return null;
  }
}

/* -------------------------------------------------------- text / bidi core */
const AR_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const hasAr = (s) => AR_RE.test(String(s || ""));
const cleanText = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const formatNum = (n) => String(n ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const meaningful = (s) => {
  const t = cleanText(s);
  if (t.length < 2 || !/\p{L}/u.test(t)) return false;
  return (t.match(/\d/g) || []).length / t.length < 0.5;
};

function chunkWords(s) {
  const out = [];
  let ltr = [];
  const flush = () => {
    if (ltr.length) out.push(ltr.join(" "));
    ltr = [];
  };
  for (const w of s.split(" ")) {
    if (hasAr(w)) {
      flush();
      out.push(w);
    } else ltr.push(w);
  }
  flush();
  return out;
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

/* ------------------------------------------------------------------ icons */
const ICONS = {
  area: '<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/>',
  bath: '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/>',
  floor: '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  fin: '<path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5"/>',
  home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  tel: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>'
};
const icon = (key, color, size = 34) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
  return img(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    size,
    size
  );
};

/* ----------------------------------------------------------------- labels */
const LABELS = {
  ar: {
    cur: "جنيه",
    sale: "للبيع",
    rent: "للإيجار",
    ready: "استلام فوري",
    area: "المساحة",
    areaUnit: "م²",
    beds: "الغرف",
    bedsUnit: "غرف",
    baths: "الحمامات",
    bathsUnit: "حمام",
    floor: "الدور",
    finish: "التشطيب",
    type: "النوع",
    price: "السعر المطلوب",
    onRequest: "السعر عند الطلب",
    cash: "كاش",
    inst: (y) => `تقسيط ${y} سنوات`,
    instGeneric: "تسهيلات سداد",
    down: "مقدم",
    cta: "للحجز والاستفسار",
    typeDefault: "وحدة معروضة",
    nanny: "غرفة خادمة",
    types: {
      apartment: "شقة",
      villa: "فيلا",
      townhouse: "تاون هاوس",
      twinhouse: "توين هاوس",
      duplex: "دوبلكس",
      penthouse: "بنتهاوس",
      studio: "استوديو",
      chalet: "شاليه",
      office: "مكتب",
      commercial: "تجاري",
      land: "أرض"
    }
  },
  en: {
    cur: "EGP",
    sale: "FOR SALE",
    rent: "FOR RENT",
    ready: "Ready to move",
    area: "Area",
    areaUnit: "sqm",
    beds: "Bedrooms",
    bedsUnit: "Beds",
    baths: "Bathrooms",
    bathsUnit: "Baths",
    floor: "Floor",
    finish: "Finishing",
    type: "Type",
    price: "Asking price",
    onRequest: "Price on request",
    cash: "Cash",
    inst: (y) => `${y}-year installments`,
    instGeneric: "Payment plans",
    down: "Down payment",
    cta: "Direct Agent Contact",
    typeDefault: "Property",
    nanny: "Maid's Room",
    types: {
      apartment: "Apartment",
      villa: "Villa",
      townhouse: "Townhouse",
      twinhouse: "Twin house",
      duplex: "Duplex",
      penthouse: "Penthouse",
      studio: "Studio",
      chalet: "Chalet",
      office: "Office",
      commercial: "Commercial",
      land: "Land"
    }
  }
};

/* --------------------------------------------------------------- the flyer */
async function generateFlyerBuffer({
  listing = {},
  agency = {},
  images = [],
  lang = "en",
  theme,
  unbranded = false
}) {
  const [bold, regular] = await Promise.all([
    loadFont("Cairo-Bold.ttf"),
    loadFont("Cairo-Regular.ttf")
  ]);
  if (!bold)
    throw new Error(
      "Critical: Cairo font buffer is missing for Satori rendering."
    );

  const details = listing.details || {};
  const P = normHex(agency.primary_color, DEFAULT_PRIMARY);
  const S = normHex(agency.secondary_color, DEFAULT_SECONDARY);
  const C = makeTheme(
    (theme || agency.flyer_theme) === "light" ? "light" : "dark",
    P,
    S
  );

  // Forced English default as requested
  const isAr = lang === "ar";
  const L = LABELS[isAr ? "ar" : "en"];
  const dirRow = isAr ? "row-reverse" : "row";

  /* ---- text primitive: RTL-safe ---- */
  const txt = (text, o = {}) => {
    const {
      size = 24,
      weight = 400,
      color = C.fg,
      lh = 1.4,
      align = "start",
      width = "100%",
      nowrap = false
    } = o;
    const s = cleanText(text);
    const base = { fontSize: size, fontWeight: weight, color, lineHeight: lh };
    if (!hasAr(s)) {
      const jc =
        align === "center" ? "center" : isAr ? "flex-end" : "flex-start";
      return h(
        "div",
        {
          width,
          justifyContent: jc,
          textAlign: align === "center" ? "center" : isAr ? "right" : "left",
          ...base
        },
        s
      );
    }
    const jc = align === "center" ? "center" : isAr ? "flex-start" : "flex-end";
    return h(
      "div",
      {
        width,
        flexDirection: "row-reverse",
        flexWrap: nowrap ? "nowrap" : "wrap",
        justifyContent: jc,
        ...base
      },
      chunkWords(s).map((wd, i, a) =>
        h(
          "div",
          { marginLeft: i === a.length - 1 ? 0 : Math.round(size * 0.26) },
          wd
        )
      )
    );
  };

  /* ---- images & hero curation ---- */
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

  // Hero Safeguard: Kitchen/Bathrooms must never be the hero if a better shot exists
  const UTILITY = /kitchen|bath|toilet|washroom|laundry|مطبخ|حمام/;
  const PREFERRED =
    /exterior|facade|building|view|garden|pool|golf|compound|living|reception|واجهة|إطلالة|حديقة|ريسبشن|معيشة/;
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

  /* ---- logo & branding (suppressed in unbranded mode) ---- */
  const isCoBroke = Boolean(unbranded || listing.is_unbranded);
  const logoBg = normHex(agency.logo_bg, "#FFFFFF");
  const logo =
    !isCoBroke && agency.logo_url
      ? await prepareLogo(agency.logo_url, logoBg)
      : null;
  const agencyName = !isCoBroke ? cleanText(agency.name) : "";
  const showName = agencyName && (!logo || logo.ratio < 1.8);

  /* ---- data normalization ---- */
  const code = cleanText(listing.code).toUpperCase();
  const isRent = /rent|ايجار|إيجار/i.test(
    String(listing.listing_type || listing.purpose || "")
  );
  const typeKey = String(listing.property_type || "").toLowerCase();
  const typeName =
    L.types[typeKey] || cleanText(listing.property_type) || L.typeDefault;
  const title =
    cleanText(listing.title) || `${typeName} ${isRent ? L.rent : L.sale}`;
  const location = cleanText(listing.location);
  const summaryRaw = details.clean_summary || details.short_summary || "";
  const summary = meaningful(summaryRaw)
    ? cleanText(summaryRaw).slice(0, 300)
    : "";

  // Features & Amenities
  const seenF = new Set([title.toLowerCase(), location.toLowerCase()]);
  const rawFeatures = Array.isArray(details.features)
    ? [...details.features]
    : [];
  if (details.nanny_room === true) rawFeatures.push(L.nanny);

  const features = rawFeatures
    .map(cleanText)
    .filter(
      (f) =>
        meaningful(f) &&
        f.length <= 40 &&
        !seenF.has(f.toLowerCase()) &&
        seenF.add(f.toLowerCase())
    )
    .slice(0, 6);

  // Structural Facts (Max 5 items for horizontal card alignment)
  const facts = [
    listing.area_value && {
      icon: "area",
      label: L.area,
      value: `${listing.area_value} ${L.areaUnit}`
    },
    listing.bedrooms && {
      icon: "bed",
      label: L.beds,
      value: `${listing.bedrooms} ${L.bedsUnit}`
    },
    details.bathrooms && {
      icon: "bath",
      label: L.baths,
      value: `${details.bathrooms} ${L.bathsUnit}`
    },
    cleanText(details.floor) && {
      icon: "floor",
      label: L.floor,
      value: cleanText(details.floor)
    },
    cleanText(details.finishing || listing.finishing) && {
      icon: "fin",
      label: L.finish,
      value: cleanText(details.finishing || listing.finishing)
    },
    { icon: "home", label: L.type, value: typeName }
  ]
    .filter(Boolean)
    .slice(0, 5);

  let priceNum = "";
  if (listing.price_value) priceNum = formatNum(listing.price_value);
  else if (listing.price_display)
    priceNum = String(listing.price_display).replace(/[^\d,.]/g, "");
  const hasInst = details.installment_years || details.down_payment_value;
  const term = !hasInst
    ? L.cash
    : details.installment_years
    ? L.inst(details.installment_years)
    : L.instGeneric;
  const down = details.down_payment_value
    ? `${L.down} ${formatNum(details.down_payment_value)}`
    : "";
  const currency = cleanText(listing.currency) || L.cur;

  // Agent-first phone priority
  const phone = !isCoBroke
    ? cleanText(
        listing.contact_phone ||
          listing.phone ||
          agency.phone ||
          agency.whatsapp ||
          agency.contact_phone
      )
    : "";
  const agentName = !isCoBroke
    ? cleanText(listing.agent_name || agency.name)
    : "";

  const ready =
    details.ready_to_move === true ||
    /immediate|ready|فوري/i.test(String(details.delivery || ""));

  /* ---- sections ---- */
  const chip = (text, style, o = {}) =>
    h(
      "div",
      {
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 40,
        padding: "6px 24px",
        ...style
      },
      txt(text, { nowrap: true, width: "auto", ...o })
    );

  const logoPill = h(
    "div",
    {
      flexDirection: dirRow,
      alignItems: "center",
      gap: 12,
      backgroundColor: logoBg,
      borderRadius: 40,
      padding: "8px 24px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.25)"
    },
    [
      logo && img(logo.uri, logo.w, logo.h),
      showName &&
        txt(agencyName, {
          size: 25,
          weight: 700,
          color: readableOn(logoBg),
          nowrap: true,
          width: "auto"
        })
    ]
  );

  const header = h(
    "div",
    {
      width: W,
      backgroundColor: C.headerBg,
      padding: `24px ${PAD}px`,
      alignItems: "center",
      justifyContent: "space-between",
      flexDirection: dirRow
    },
    [
      logo || showName ? logoPill : h("div", {}, ""),
      code &&
        h(
          "div",
          {
            border: `2px solid ${C.accentText}`,
            borderRadius: 40,
            padding: "8px 26px"
          },
          h(
            "div",
            {
              color: C.accentText,
              fontSize: 26,
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
              [isAr ? "right" : "left"]: 20,
              flexDirection: dirRow,
              gap: 10
            },
            [
              chip(
                isRent ? L.rent : L.sale,
                { backgroundColor: C.accent, borderRadius: 10 },
                { size: 28, weight: 700, color: C.onAccent }
              ),
              ready &&
                chip(
                  L.ready,
                  { backgroundColor: "#111827", borderRadius: 10 },
                  { size: 24, weight: 700, color: "#FFFFFF" }
                )
            ]
          )
        ]),
        ...rowUris.map((row) =>
          h(
            "div",
            { flexDirection: dirRow, gap: GAP, width: INNER },
            row.map((t) => img(t.uri, t.w, rowH, { borderRadius: 14 }))
          )
        )
      ])
    : null;

  const titleBlock = h(
    "div",
    { flexDirection: "column", width: INNER, marginTop: 28, gap: 6 },
    [
      txt(title, { size: 44, weight: 700, lh: 1.3 }),
      location &&
        h(
          "div",
          {
            flexDirection: dirRow,
            alignItems: "center",
            gap: 10,
            width: INNER
          },
          [
            icon("pin", C.icon, 30),
            h(
              "div",
              { flexGrow: 1, flexShrink: 1 },
              txt(location, { size: 26, color: C.muted })
            )
          ]
        )
    ]
  );

  const vSize = facts.length >= 5 ? 24 : 28;
  const factsCard = h(
    "div",
    {
      flexDirection: dirRow,
      width: INNER,
      marginTop: 24,
      padding: "22px 0",
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
          ...(i
            ? { [isAr ? "borderRight" : "borderLeft"]: `1px solid ${C.line}` }
            : {})
        },
        [
          icon(f.icon, C.icon),
          txt(f.value, {
            size: vSize,
            weight: 700,
            align: "center",
            nowrap: true,
            width: "auto"
          }),
          txt(f.label, {
            size: 20,
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
          marginTop: 24,
          padding: "18px 24px",
          backgroundColor: C.card,
          borderRadius: 14,
          border: `1px solid ${C.line}`,
          [isAr ? "borderRight" : "borderLeft"]: `5px solid ${C.accent}`
        },
        txt(summary, { size: 24, color: C.muted, lh: 1.6 })
      )
    : null;

  const featureBlock = features.length
    ? h(
        "div",
        {
          flexDirection: dirRow,
          flexWrap: "wrap",
          gap: 10,
          width: INNER,
          marginTop: 20
        },
        features.map((f) =>
          chip(
            f,
            { backgroundColor: C.card, border: `1px solid ${C.line}` },
            { size: 22, color: C.fg }
          )
        )
      )
    : null;

  const priceBlock = h(
    "div",
    {
      flexDirection: dirRow,
      alignItems: "center",
      justifyContent: "space-between",
      width: INNER,
      marginTop: 24,
      backgroundColor: C.priceBg,
      borderRadius: 20,
      padding: "26px 34px"
    },
    [
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: isAr ? "flex-end" : "flex-start"
        },
        [
          txt(priceNum ? L.price : "", {
            size: 23,
            color: C.priceSub,
            width: "auto",
            nowrap: true
          }),
          priceNum
            ? h(
                "div",
                { flexDirection: dirRow, alignItems: "baseline", gap: 12 },
                [
                  h(
                    "div",
                    {
                      fontSize: 62,
                      fontWeight: 700,
                      lineHeight: 1.2,
                      color: C.priceNum
                    },
                    priceNum
                  ),
                  txt(currency, {
                    size: 30,
                    weight: 700,
                    color: C.priceFg,
                    width: "auto",
                    nowrap: true
                  })
                ]
              )
            : txt(L.onRequest, {
                size: 44,
                weight: 700,
                color: C.priceNum,
                width: "auto",
                nowrap: true
              })
        ]
      ),
      h(
        "div",
        {
          flexDirection: "column",
          alignItems: isAr ? "flex-start" : "flex-end",
          gap: 8
        },
        [
          chip(
            term,
            { border: `2px solid ${C.priceFg}` },
            { size: 26, weight: 700, color: C.priceFg }
          ),
          down &&
            txt(down, {
              size: 22,
              color: C.priceSub,
              width: "auto",
              nowrap: true
            })
        ]
      )
    ]
  );

  // Personalized Agent Footer
  const footer = phone
    ? h(
        "div",
        {
          flexDirection: dirRow,
          alignItems: "center",
          justifyContent: "space-between",
          width: INNER,
          marginTop: 24,
          paddingTop: 20,
          borderTop: `1px solid ${C.line}`
        },
        [
          h("div", { flexDirection: "column", gap: 4 }, [
            agentName
              ? txt(agentName, {
                  size: 28,
                  weight: 700,
                  color: C.fg,
                  width: "auto",
                  nowrap: true
                })
              : null,
            txt(L.cta, {
              size: 21,
              color: C.muted,
              width: "auto",
              nowrap: true
            })
          ]),
          h("div", { flexDirection: dirRow, alignItems: "center", gap: 10 }, [
            icon("tel", C.icon, 30),
            h(
              "div",
              {
                fontSize: 30,
                fontWeight: 700,
                color: C.fg,
                letterSpacing: 0.5
              },
              phone
            )
          ])
        ]
      )
    : null;

  const body = (withSpacer) =>
    h(
      "div",
      {
        flexDirection: "column",
        flexGrow: 1,
        padding: `28px ${PAD}px ${PAD}px`,
        width: W
      },
      [
        gallery,
        titleBlock,
        factsCard,
        summaryBlock,
        featureBlock,
        priceBlock,
        withSpacer && h("div", { flexGrow: 1 }),
        footer
      ]
    );

  const root = (height) =>
    h(
      "div",
      {
        width: W,
        ...(height ? { height } : {}),
        flexDirection: "column",
        backgroundColor: C.bg,
        color: C.fg,
        fontFamily: "Cairo"
      },
      [header, body(!!height)]
    );

  const estimateHeight = () =>
    Math.round(
      112 +
        28 +
        (heroUri ? heroH + rows.length * (rowH + GAP) : 0) +
        150 +
        190 +
        (summary ? 70 + Math.ceil(summary.length / 50) * 38 : 0) +
        (features.length ? 80 : 0) +
        190 +
        (phone ? 100 : 0) +
        PAD +
        160
    );

  const fonts = [
    { name: "Cairo", data: bold, weight: 700, style: "normal" },
    { name: "Cairo", data: regular || bold, weight: 400, style: "normal" }
  ];

  let svg;
  try {
    svg = await satori(root(null), { width: W, fonts });
    const m = svg.match(/<svg[^>]*\sheight="([\d.]+)"/);
    if (!m || Number(m[1]) < 500) throw new Error("auto height unsupported");
  } catch (_) {
    svg = await satori(root(estimateHeight()), {
      width: W,
      height: estimateHeight(),
      fonts
    });
  }

  return sharp(Buffer.from(svg))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}

module.exports = {
  generateFlyerBuffer,
  loadFont,
  renderFlyerJpeg: generateFlyerBuffer,
  renderFlyerPng: generateFlyerBuffer,
  renderFlyerSatori: generateFlyerBuffer
};
