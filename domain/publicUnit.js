// domain/publicUnit.js — The allowlist serializer for public unit pages (pure).
// Only the fields named in PUBLIC_FIELDS leave the server; every text comes from describe.js client-safe
// pieces (factLines, never internalLines), so owner, notes, commission, co-broker, ids and raw text cannot
// appear, whatever the row holds.
"use strict";

const Describe = require("./describe");
const ClientPlans = require("./clientPlans");

const PUBLIC_FIELDS = ["code", "lang", "status", "headline", "price", "facts", "features", "summary", "images", "agency", "contact", "plans", "project", "og"];
const MAX_IMAGES = 15;

const strip = (s) => String(s || "").replace(/[*`_]/g, "").trim();
const httpsOnly = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
const phoneOf = (b) => {
  const p = String(b?.contact_phone || b?.phone_normalized || b?.phone_number || "").replace(/[^\d+]/g, "");
  return p ? (p.startsWith("+") ? p : `+${p}`) : null;
};

/** The broker a client may call: name and phone only. */
const contactOf = (broker) => (broker ? { name: broker.name || null, phone: phoneOf(broker) } : null);

/**
 * @param {Object} listing - the stored row (anything may be in it)
 * @param {Object} opts - { agency, broker (who shared), images: [{ url }], lang, project ({ name, name_en, delivery_year,
 *   delivery_quarter }: the catalogue project, C7), materials (the project's client-visible links only) }
 * @returns {Object} exactly PUBLIC_FIELDS
 */
function toPublicUnit(listing, { agency = {}, broker = null, images = [], lang = "ar", project = null, materials = [] } = {}) {
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
    contact: contactOf(broker),
    // C7: the plans with their numbers (no source, ids or notes) and the project's name, delivery and client links.
    plans: listing.status === "active" ? ClientPlans.clientPlans(listing, lang) : [],
    project: project ? publicProject(project, materials, lang) : null,
    og: {
      title: [headline.replace(/^🏠\s*/, ""), price].filter(Boolean).join(" · "),
      description: compact,
      image: imgs[0] || null
    }
  };
  return out;
}

/** A catalogue project as a client sees it: never the developer's contacts, notes or internal links. */
function publicProject(p, materials, lang) {
  const delivery = p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : null;
  return {
    name: (lang === "en" ? p.name_en || p.name : p.name) || null,
    delivery,
    links: materials.map((m) => ({ label: String(m.label || "").slice(0, 80), url: httpsOnly(m.url), kind: m.kind || "other" })).filter((m) => m.url && m.label).slice(0, 8)
  };
}

/** What a page for an unavailable (sold, archived) unit may say: nothing but that. */
function unavailable(listing, { agency = {}, lang = "ar" } = {}) {
  return toPublicUnit({ code: listing.code, status: "sold", property_type: listing.property_type, listing_type: listing.listing_type }, { agency, lang });
}

module.exports = { PUBLIC_FIELDS, MAX_IMAGES, toPublicUnit, unavailable, contactOf };
