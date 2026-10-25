// lib/listingText.js — Listing typology helpers, text signals (unit codes, language, metadata) and the code generator.
// Pure; split out of lib/listing.js.
"use strict";

const crypto = require("crypto");

/* --------------------------------------------------------------------------- */
/* 1. Typology Identification Helpers                                         */
/* --------------------------------------------------------------------------- */

function isVillaTypology(propertyType) {
  const norm = String(propertyType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return [
    "villa",
    "townhouse",
    "twinhouse",
    "standalone",
    "mansion",
    "land"
  ].includes(norm);
}

function isStudioTypology(propertyType, bedrooms) {
  const norm = String(propertyType || "")
    .toLowerCase()
    .replace(/[\s_-]/g, "");
  return (
    norm === "studio" ||
    (Number(bedrooms) === 0 && !isVillaTypology(propertyType))
  );
}

/* --------------------------------------------------------------------------- */
/* 2. Text Signals & Regex Parsing                                             */
/* --------------------------------------------------------------------------- */

function normalizeArabicDigits(str) {
  return String(str || "")
    .replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)])
    .replace(/[۰-۹]/g, (d) => "0123456789"[d.charCodeAt(0) - 0x06f0]);
}

function parseExplicitUnitCode(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return { hasCode: false, code: null };
  }

  const clean = normalizeArabicDigits(
    text.replace(/[\u200E\u200F\u202A-\u202E]/g, "")
  ).trim();

  // Pattern 1: Explicit keyword prefix: (كود|code|unit|ref) optionally followed by wrappers
  const prefixRegex =
    /(?:كود(?:\s*(?:الوحدة|الداخلي))?|code|unit(?:\s*[\/\-]\s*(?:ref|code))?|ref)\s*[:\/\-\s#]*([A-Za-z0-9_\-\.\/]{2,30})/i;
  let match = clean.match(prefixRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "").trim();
    if (
      candidate.length >= 2 &&
      !/^(?:REF|UNIT|CODE|كود)$/i.test(candidate) &&
      !/[\u0600-\u06FF]/.test(candidate)
    ) {
      return { hasCode: true, code: candidate.toUpperCase() };
    }
  }

  // Pattern 2: Explicit Markdown/Wrapper tokens: `CODE`, [CODE], #CODE
  const wrapperRegex = /[`\[#]([A-Za-z0-9_\-\.\/]{2,30})[`\]]?/;
  match = clean.match(wrapperRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "").trim();
    if (
      candidate.length >= 2 &&
      /[A-Za-z0-9]/.test(candidate) &&
      !/[\u0600-\u06FF]/.test(candidate)
    ) {
      return { hasCode: true, code: candidate.toUpperCase() };
    }
  }

  // Pattern 3: Standalone alphanumeric identifier with both letters and numbers
  const standaloneRegex =
    /\b([A-Za-z]+[0-9_\-\.\/][A-Za-z0-9_\-\.\/]*|[0-9]+[A-Za-z_\-\.\/][A-Za-z0-9_\-\.\/]*)\b/;
  match = clean.match(standaloneRegex);
  if (match && match[1]) {
    const candidate = match[1].replace(/[`\[\]#]/g, "").trim();
    if (candidate.length >= 2 && !/[\u0600-\u06FF]/.test(candidate)) {
      return { hasCode: true, code: candidate.toUpperCase() };
    }
  }

  return { hasCode: false, code: null };
}

function extractExplicitUnitCode(text) {
  const res = parseExplicitUnitCode(text);
  return res.hasCode && res.code ? res.code : null;
}

function isLikelyListingMetadata(text) {
  if (!text) return false;
  if (
    /(?:^|\s)(عايز|عاوز|محتاج|ابحث|دورلي|عندك|عندنا|search|find|looking for)(?=$|\s)/i.test(
      text
    )
  ) {
    return false;
  }
  return /(?:^|\s)(كود|code|للبيع|مطلوب|مساحة|دور|تشطيب|كمبوند|شقة|فيلا|غرف|حمام|حمامات|مقدم|تقسيط|ref|ناني|روف|ارضي|أرضي|متكرر|بنتهاوس|استلام|فوري|بحري|over|اوفر|تنازل|وديعة)(?=$|\s)/i.test(
    text
  );
}

function detectLang(text, fallback = "ar") {
  if (/(?:^|\s)(en|english|انجليزي|إنجليزي)(?=$|\s)/i.test(text)) return "en";
  if (/(?:^|\s)(ar|arabic|عربي)(?=$|\s)/i.test(text)) return "ar";
  return fallback;
}

const isReplaceMode = (text) => /(?:^|\s)(استبدال|replace)(?=$|\s)/i.test(text);

/* --------------------------------------------------------------------------- */
/* 3. Code Generator                                                          */
/* --------------------------------------------------------------------------- */

function generateListingCode(customCode, propertyType) {
  if (customCode && typeof customCode === "string") {
    const cleaned = normalizeArabicDigits(customCode)
      .trim()
      .replace(/^(?:كود|code|ref|#)\s*/i, "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .toUpperCase();
    if (cleaned.length >= 2) return { code: cleaned, explicit: true };
  }
  const prefix =
    {
      apartment: "APT",
      villa: "VIL",
      townhouse: "TWN",
      twinhouse: "TWN",
      duplex: "DUP",
      penthouse: "PNT",
      chalet: "CHL",
      studio: "STU",
      office: "OFF",
      commercial: "COM",
      land: "LND"
    }[String(propertyType || "").toLowerCase()] || "UNT";
  return {
    code: `RK-${prefix}-${crypto.randomInt(10000, 100000)}`,
    explicit: false
  };
}

module.exports = {
  isVillaTypology,
  isStudioTypology,
  normalizeArabicDigits,
  parseExplicitUnitCode,
  extractExplicitUnitCode,
  isLikelyListingMetadata,
  detectLang,
  isReplaceMode,
  generateListingCode
};
