// domain/projectContext.js — A project's stored context for the assistant (Release B, C10), pure and with no AI: a
// short summary and structured facts (developer, location, status, delivery, phases, payment plans, prices by unit
// type with the date of the price sheet, client materials, highlights, brochure facts with their date). Every value
// comes from the agency's own records; nothing is filled in. sourceKey() changes whenever any of those records change,
// so a stale context is rebuilt before it is used.
"use strict";

const crypto = require("crypto");
const Describe = require("./describe");

const MAX_FACTS = 80;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const stamp = (d) => (d ? new Date(d).toISOString() : "-");
const typeLabel = (t) => (Describe.TYPE_LABELS?.[t] ? Describe.TYPE_LABELS[t][1] : t || "unit");

/** The key that changes when anything the context is built from changes. */
function sourceKey({ project, unitsKey = "", plansKey = "", phasesKey = "", materialsKey = "", priceSheet = null }) {
  const parts = [stamp(project.updated_at), stamp(project.prices_updated_at), stamp(project.highlights_at), stamp(project.brochure?.read_at), unitsKey, plansKey, phasesKey, materialsKey, stamp(priceSheet?.applied_at), stamp(project.plans_draft?.applied?.applied_at)];
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

/** Prices by unit type: { type, units, min, max, area_min, area_max } (available units and models only). */
function priceRanges(units) {
  const by = new Map();
  for (const u of units) {
    if (u.status !== "active" || !Number(u.price_value)) continue;
    const k = u.property_type || "unit";
    if (!by.has(k)) by.set(k, { type: k, units: 0, min: Infinity, max: 0, area_min: Infinity, area_max: 0, bedrooms: new Set() });
    const r = by.get(k);
    r.units++;
    r.min = Math.min(r.min, Number(u.price_value));
    r.max = Math.max(r.max, Number(u.price_value));
    if (Number(u.area_value)) {
      r.area_min = Math.min(r.area_min, Number(u.area_value));
      r.area_max = Math.max(r.area_max, Number(u.details?.area_to || u.area_value));
    }
    if (u.bedrooms !== null && u.bedrooms !== undefined) r.bedrooms.add(u.bedrooms);
  }
  return [...by.values()].map((r) => ({
    type: r.type,
    units: r.units,
    min: Math.round(r.min),
    max: Math.round(r.max),
    area_min: Number.isFinite(r.area_min) ? Math.round(r.area_min) : null,
    area_max: r.area_max ? Math.round(r.area_max) : null,
    bedrooms: [...r.bedrooms].sort((a, b) => a - b)
  }));
}

const planLine = (p) =>
  `${p.name}: ${Number(p.down_payment_pct)}% down${Number(p.years) ? `, ${Number(p.years)} years ${p.frequency || ""}`.trimEnd() : ", cash"}${Number(p.discount_pct) ? `, ${Number(p.discount_pct)}% discount` : ""}${p.maintenance_pct !== null && p.maintenance_pct !== undefined ? `, maintenance ${Number(p.maintenance_pct)}%` : ""}`;

/**
 * The context: { summary, facts } where facts = { name, name_en, developer, location, status, delivery, phases,
 * plans, prices: { as_of, ranges }, materials, highlights, brochure: { as_of, facts } }.
 */
function build({ project: p, developer = null, phases = [], plans = [], units = [], materials = [], priceSheet = null }) {
  const delivery = p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : p.delivery_raw || null;
  const ranges = priceRanges(units);
  const facts = {
    name: p.name,
    name_en: p.name_en || null,
    developer: developer?.name || p.developer_name || null,
    location: [p.district, p.city].filter(Boolean).join(", ") || null,
    status: p.status || null,
    delivery,
    maintenance_pct: p.maintenance_pct !== null && p.maintenance_pct !== undefined ? Number(p.maintenance_pct) : null,
    phases: phases.map((ph) => ({ name: ph.name, status: ph.status, delivery: ph.delivery_year ? `${ph.delivery_quarter ? `Q${ph.delivery_quarter} ` : ""}${ph.delivery_year}` : null })),
    plans: plans.map(planLine),
    prices: { as_of: day(p.prices_updated_at), ranges },
    materials: materials.filter((m) => m.client_visible && m.check_status !== "broken").map((m) => ({ label: m.label, kind: m.kind, url: m.url })),
    // Information managers added to answer questions the data could not (services/assistant.js addInfo).
    agency_notes: p.notes ? String(p.notes).slice(0, 1500) : null,
    highlights: Array.isArray(p.highlights?.en) && p.highlights.en.length ? p.highlights.en : Array.isArray(p.highlights?.ar) ? p.highlights.ar : [],
    brochure: { as_of: day(p.brochure?.read_at), facts: (p.brochure?.facts || []).slice(0, MAX_FACTS).map((f) => f.text) },
    // F22: what came from uploaded files, each with its date.
    sources: {
      prices: priceSheet?.applied_at ? { file: priceSheet.file_name || null, read_by_ai: priceSheet.source === "ai", as_of: day(priceSheet.applied_at) } : null,
      plans: p.plans_draft?.applied ? { file: p.plans_draft.applied.file_name || null, as_of: day(p.plans_draft.applied.read_at) } : null,
      brochure: p.brochure?.read_at ? { file: p.brochure.file_name || null, as_of: day(p.brochure.read_at) } : null,
      files: materials.filter((m) => m.storage_path).map((m) => ({ label: m.label, kind: m.kind, as_of: day(m.created_at) }))
    }
  };
  const src = facts.sources;
  const lines = [
    `${facts.name}${facts.name_en && facts.name_en !== facts.name ? ` (${facts.name_en})` : ""}${facts.developer ? ` by ${facts.developer}` : ""}${facts.location ? `, ${facts.location}` : ""}.`,
    facts.status ? `Status: ${facts.status}.` : null,
    facts.delivery ? `Delivery: ${facts.delivery}.` : null,
    facts.maintenance_pct !== null ? `Maintenance: ${facts.maintenance_pct}%.` : null,
    facts.phases.length ? `Phases: ${facts.phases.map((x) => `${x.name}${x.delivery ? ` (delivery ${x.delivery})` : ""}`).join("; ")}.` : null,
    facts.plans.length ? `Payment plans: ${facts.plans.join("; ")}.` : null,
    ranges.length
      ? `Prices${facts.prices.as_of ? ` (price sheet of ${facts.prices.as_of})` : ""}: ${ranges
          .map((r) => `${typeLabel(r.type)} ${r.min === r.max ? r.min : `${r.min} to ${r.max}`} EGP${r.area_min ? `, ${r.area_min}${r.area_max && r.area_max !== r.area_min ? `-${r.area_max}` : ""} m²` : ""}${r.bedrooms.length ? `, ${r.bedrooms.join("/")} bedrooms` : ""} (${r.units} available)`)
          .join("; ")}.`
      : "No prices recorded.",
    facts.highlights.length ? `Highlights: ${facts.highlights.join("; ")}.` : null,
    facts.agency_notes ? `Agency notes: ${facts.agency_notes}` : null,
    facts.materials.length ? `Client materials: ${facts.materials.map((m) => m.label).join(", ")}.` : null,
    src.prices ? `Prices come from ${src.prices.file ? `the file ${src.prices.file}` : "a price sheet"}${src.prices.read_by_ai ? " (read by AI)" : ""}, applied ${src.prices.as_of}.` : null,
    src.plans ? `Payment plans were read from ${src.plans.file ? `the file ${src.plans.file}` : "a developer file"} on ${src.plans.as_of}.` : null,
    src.brochure ? `Brochure facts were read from ${src.brochure.file ? `the file ${src.brochure.file}` : "the brochure"} on ${src.brochure.as_of}.` : null,
    src.files.length ? `Uploaded files: ${src.files.map((f) => `${f.label} (${f.kind}, ${f.as_of})`).join("; ")}.` : null
  ].filter(Boolean);
  return { summary: lines.join("\n"), facts };
}

module.exports = { MAX_FACTS, sourceKey, priceRanges, build };
