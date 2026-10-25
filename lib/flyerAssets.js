// lib/flyerAssets.js — Flyer fonts, the SSRF guard, photo/logo download and image preparation (split out of lib/flyer.js).
"use strict";

const sharp = require("sharp");
const fs = require("fs").promises;
const path = require("path");
const { URL } = require("url");
const dns = require("dns").promises;


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

module.exports = {
  loadFont,
  isPrivateIp,
  validateSafeUrl,
  fetchBuf,
  cover,
  prepareLogo,
  logoSlot,
  fitInto
};
