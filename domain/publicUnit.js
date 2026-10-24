// domain/publicUnit.js — The allowlist serializer for public unit pages (pure).
// Only the fields named in PUBLIC_FIELDS leave the server; every text comes from describe.js client-safe
// pieces (factLines, never internalLines), so owner, notes, commission, co-broker, ids and raw text cannot
// appear, whatever the row holds.
"use strict";

const Describe = require("./describe");

const PUBLIC_FIELDS = ["code", "lang", "status", "headline", "price", "facts", "features", "summary", "images", "agency", "contact", "og"];
const MAX_IMAGES = 15;

const strip = (s) => String(s || "").replace(/[*`_]/g, "").trim();
const httpsOnly = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
const phoneOf = (b) => {
  const p = String(b?.contact_phone || b?.phone_normalized || b?.phone_number || "").replace(/[^\d+]/g, "");
  return p ? (p.startsWith("+") ? p : `+${p}`) : null;
};

/**
 * @param {Object} listing - the stored row (anything may be in it)
 * @param {Object} opts - { agency, broker (who shared), images: [{ url }], lang }
 * @returns {Object} exactly PUBLIC_FIELDS
 */
function toPublicUnit(listing, { agency = {}, broker = null, images = [], lang = "ar" } = {}) {
  const en = lang === "en";
  const [headline, ...facts] = Describe.factLines(listing, lang).map(strip);
  const summaryRaw = Describe.cleanSummary(en ? listing.details?.summary_en : listing.details?.clean_summary);
  const summary = summaryRaw && (!en || !/[؀-ۿ]/.test(summaryRaw)) ? summaryRaw.slice(0, 600) : null;
  const price = Describe.priceLabel(listing, lang);
  const imgs = images.map((i) => httpsOnly(i.url)).filter(Boolean).slice(0, MAX_IMAGES);
  const compact = strip(Describe.compactLine({ ...listing, confirmed_at: null }, lang).replace(/^`[^`]*`\s*·\s*/, ""));
  const out = {
    code: String(listing.code),
    lang: en ? "en" : "ar",
    status: listing.status === "active" ? "active" : "unavailable",
    headline: headline.replace(/^🏠\s*/, ""),
    price,
    facts,
    features: Describe.featureLabels(listing, lang),
    summary,
    images: imgs,
    agency: { name: agency.name || null, logo_url: httpsOnly(agency.logo_url), phone: agency.phone || null },
    contact: broker ? { name: broker.name || null, phone: phoneOf(broker) } : null,
    og: {
      title: [headline.replace(/^🏠\s*/, ""), price].filter(Boolean).join(" · "),
      description: compact,
      image: imgs[0] || null
    }
  };
  return out;
}

/** What a page for an unavailable (sold, archived) unit may say: nothing but that. */
function unavailable(listing, { agency = {}, lang = "ar" } = {}) {
  return toPublicUnit({ code: listing.code, status: "sold", property_type: listing.property_type, listing_type: listing.listing_type }, { agency, lang });
}

module.exports = { PUBLIC_FIELDS, MAX_IMAGES, toPublicUnit, unavailable };
