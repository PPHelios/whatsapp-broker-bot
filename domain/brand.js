// domain/brand.js — WehdatHub's own brand in one place (phase 2 step 3): colours, logo and names. The website, the Mini
// App, the landing page (CSS tokens through web/assets.js brand.css), the PWA manifest and the default colours of a
// new agency's flyers all read it, so a new logo or palette drops in here only.
"use strict";

const BRAND = Object.freeze({
  name: "WehdatHub",
  // Brand v2 (2026-10-27): azure for actions and links, copper for "very interested" and featured, charcoal text.
  colors: Object.freeze({ brand: "#1d70b8", accent: "#c45a30", ink: "#0e1521", bg: "#f4f6f9" }),
  // Under web/static/ (served at /app/static/).
  logo: "icons/icon.svg"
});

/** The CSS custom properties every page starts from (web/static/app.css uses them; it never names a brand colour). */
function cssTokens(brand = BRAND) {
  const c = brand.colors;
  return `/* Generated from domain/brand.js */\n:root { --brand: ${c.brand}; --accent: ${c.accent}; --ink: ${c.ink}; --bg: ${c.bg}; }\n`;
}

module.exports = { BRAND, cssTokens };
