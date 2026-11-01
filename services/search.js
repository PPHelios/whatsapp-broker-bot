// services/search.js — The one search service (WhatsApp text, voice, and later the web). Returns data.
// Same input → same filters → same SQL → same ids in the same order.
"use strict";

const Q = require("../domain/searchQuery");
const Vis = require("../lib/visibility");

const PAGE_SIZE = 5;
// Telegram messages are free, so a Telegram search shows twice as many units per message.
const TG_PAGE_SIZE = 10;
const SNAPSHOT_MAX = 100; // ids remembered for "more" (B1)
const STEP_MONTHS_SQL = `CASE p->>'frequency' WHEN 'monthly' THEN 1 WHEN 'semi_annual' THEN 6 WHEN 'annual' THEN 12 ELSE 3 END`;

const SEARCH_PROMPT = (featureList) => `You are the search-understanding layer of a WhatsApp real-estate inventory bot used by Egyptian brokers.
Read the broker's request (Arabic, English or mixed; typed or transcribed) and return ONE JSON object.
Never invent a filter that was not asked for.

{
  "intent": "search" | "listing" | "other",   // "other" for greetings, thanks, small talk; "listing" when the broker is describing a unit to add
  "transcript": "the request as written or heard",
  "language": "ar" | "en",
  "filters": {
    "code": "a unit code if asked for one (e.g. N4-105), else null",
    "listing_type": "sale" | "rent" | null,
    "market": "primary" | "resale" | null,
    "property_types": [ any of: apartment, duplex, penthouse, chalet, studio, villa, townhouse, twinhouse, office, shop, clinic, commercial, land ],
    "compound": "ONE compound / project name as said, else null",
    "locations": [ other place names as said (areas, districts, cities) ],
    "currency": "EGP" | "USD" | "EUR" | null,
    "price_min": number or null, "price_max": number or null,
    "area_min": number or null, "area_max": number or null,
    "bedrooms_min": integer or null, "bedrooms_max": integer or null,
    "bathrooms_min": integer or null,
    "floor_min": integer or null, "floor_max": integer or null,   // ground floor = 0
    "finishing": [ any of: core_and_shell, semi_finished, fully_finished, super_lux, ultra_super_lux ],
    "furnishing": "furnished" | "semi_furnished" | "unfurnished" | null,
    "delivery": { "ready": true or null, "by_year": integer or null },
    "payment": { "cash": true or null, "installments": true or null, "years": integer or null, "down_pct": number or null, "max_down_payment": number or null, "max_installment": number or null },
    "features": [ keys from this list only: ${featureList} ],
    "other_features": [ other requested extras, as said ]
  }
}

RULES:
- Numbers are plain EGP numbers: "8 مليون ونص" = 8500000, "مقدم 500 ألف" → payment.max_down_payment 500000, "قسط مش أكتر من 150 ألف" → payment.max_installment 150000, "في حدود 6 مليون" → price_max 6000000.
- "3 غرف" or "3 bedrooms" → bedrooms_min 3 and bedrooms_max null (3 or more). Same for bathrooms ("3 حمامات" → bathrooms_min 3) and area ("150 متر" → area_min 150, area_max null). A range ("من 120 لـ 150 متر") sets both ends. "استوديو" → property_types ["studio"].
- "budget" / "حدود" / "تحت" / "لحد" with a price → price_max only.
- "استلام فوري" / "ready to move" → delivery.ready true. "تسليم 2027" → delivery.by_year 2027.
- "على 8 سنين" / "8 years" / "٨ سنين" → payment.years 8 (the plan's length, not a place). Never put the word "سنين" in locations.
- "مقدم 10%" / "10% down" / "مقدم ١٠٪" → payment.down_pct 10 (a percent of the price, not an amount).
- بحري / north facing → "north_facing"; ناصية / corner → "corner"; غرفة مربية / nanny room → "nanny_room".`;

function featureListForPrompt() {
  const Features = require("../domain/features");
  return Features.FEATURES.map((f) => `${f.key} (${f.ar} / ${f.en})`).join(", ");
}

/**
 * Parses a request through the AI gateway, falling back to the local parser on any failure.
 * @returns {Promise<{ parsed, source: "ai"|"fallback", modelUsed, usage, ms }>}
 */
async function parseRequest(AI, { text = "", ctx = {} } = {}) {
  const t0 = Date.now();
  try {
    const res = await AI.generateWithCascade({
      contents: [
        {
          role: "user",
          parts: [{ text: `${SEARCH_PROMPT(featureListForPrompt())}\n\n===USER_QUERY===\n${String(text).trim()}\n===USER_QUERY===` }]
        }
      ],
      config: { responseMimeType: "application/json", temperature: 0 },
      operationType: "search_parse",
      ctx
    });
    const raw = JSON.parse(String(res.text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    const parsed = Q.normalizeAiSearch(raw);
    if (!parsed.transcript) parsed.transcript = String(text).slice(0, 500);
    return { parsed, source: "ai", modelUsed: res.modelUsed, usage: res.usage || {}, ms: Date.now() - t0 };
  } catch (err) {
    console.warn("AI search parsing failed, using the local parser:", err.message);
    return { parsed: Q.fallbackParse(text), source: "fallback", modelUsed: "fallback_regex", usage: {}, ms: Date.now() - t0 };
  }
}

/**
 * Builds the search SQL. Every condition is agency-scoped and active-only.
 * relaxed widens price/area ±15%, bedrooms ±1 and drops finishing/furnishing/floor/bathrooms.
 */
function buildSearchQuery(agencyId, parsedOrFilters, { limit = SNAPSHOT_MAX, offset = 0, relaxed = false, onlyIds = null } = {}) {
  const f = Q.ensureFilters(parsedOrFilters?.filters ? parsedOrFilters : { filters: parsedOrFilters || {} });
  const where = ["l.agency_id = $1", "l.status = 'active'"];
  const params = [agencyId];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  // The match sweep: the same filters, restricted to the units that changed (step 7).
  if (onlyIds) where.push(`l.id = ANY(${add(onlyIds)}::uuid[])`);
  let rank = "";

  if (f.code) {
    // B6/B7: case-folded code through the unique (agency_id, code_norm) index.
    const c = add(Q.normalizeCode(f.code));
    where.push(`(l.code_norm = ${c} OR upper(l.developer_unit_code) = ${c})`);
  } else {
    if (f.listing_type) where.push(`l.listing_type = ${add(f.listing_type)}`);
    if (f.market) where.push(`l.market = ${add(f.market)}`);
    if (f.currency) where.push(`coalesce(l.details->>'currency', 'EGP') = ${add(f.currency)}`);
    if (f.property_types.length) where.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);

    // Places: resolved keys use the indexed key columns; free place words use the search document.
    if (f.places.length) {
      const ors = f.places.map((p) => {
        const col = { compound: "compound_key", developer: "developer_key", area: "area_key" }[p.kind];
        return `l.${col} = ${add(p.key)}`;
      });
      where.push(`(${ors.join(" OR ")})`);
    } else if (f.place_terms.length) {
      const ors = f.place_terms.map((t) => {
        const p = add(t);
        return `(l.search_text_normalized LIKE '%' || ${p} || '%' OR ${p} <% l.search_text_normalized)`;
      });
      where.push(`(${ors.join(" OR ")})`);
      rank = `GREATEST(${f.place_terms.map((t) => `word_similarity(${add(t)}, l.search_text_normalized)`).join(", ")}) DESC,`;
    }

    const widen = (v, k) => (v === null ? null : relaxed ? Math.round(v * k) : v);
    const pMin = widen(f.price_min, 0.85);
    const pMax = widen(f.price_max, 1.15);
    if (pMin !== null) where.push(`l.price_value >= ${add(pMin)}`);
    if (pMax !== null) where.push(`l.price_value <= ${add(pMax)}`);
    const aMin = widen(f.area_min, 0.85);
    const aMax = widen(f.area_max, 1.15);
    if (aMin !== null) where.push(`l.area_value >= ${add(aMin)}`);
    if (aMax !== null) where.push(`l.area_value <= ${add(aMax)}`);

    if (f.bedrooms_min !== null && f.bedrooms_min === f.bedrooms_max) {
      if (f.bedrooms_min === 0) where.push(`(l.bedrooms = 0 OR l.property_type = 'studio')`);
      else if (relaxed) where.push(`l.bedrooms BETWEEN ${add(Math.max(1, f.bedrooms_min - 1))} AND ${add(f.bedrooms_max + 1)}`);
      else where.push(`l.bedrooms = ${add(f.bedrooms_min)}`);
    } else {
      if (f.bedrooms_min !== null) where.push(`l.bedrooms >= ${add(relaxed ? Math.max(0, f.bedrooms_min - 1) : f.bedrooms_min)}`);
      if (f.bedrooms_max !== null) where.push(`l.bedrooms <= ${add(relaxed ? f.bedrooms_max + 1 : f.bedrooms_max)}`);
    }

    if (!relaxed) {
      if (f.bathrooms_min !== null) where.push(`l.bathrooms >= ${add(f.bathrooms_min)}`);
      if (f.floor_min !== null) where.push(`l.floor_level >= ${add(f.floor_min)}`);
      if (f.floor_max !== null) where.push(`l.floor_level <= ${add(f.floor_max)}`);
      if (f.finishing.length) where.push(`l.finishing = ANY(${add(f.finishing)}::text[])`);
      if (f.furnishing) where.push(`l.furnishing = ${add(f.furnishing)}`);
    }

    if (f.delivery_ready) where.push(`l.is_ready = true`);
    if (f.delivery_by_year !== null) where.push(`(l.is_ready = true OR l.delivery_year <= ${add(f.delivery_by_year)})`);

    if (f.payment_cash) {
      where.push(`(coalesce(l.remaining_amount, 0) = 0 AND (l.market = 'resale' OR (l.payment_terms ? 'cash_price' AND l.payment_terms->>'cash_price' IS NOT NULL)))`);
    }
    if (f.payment_installments) {
      where.push(`(coalesce(l.remaining_amount, 0) > 0 OR jsonb_array_length(coalesce(l.payment_terms->'plans', '[]'::jsonb)) > 0)`);
    }
    if (f.payment_down_pct !== null) {
      // "مقدم 10%": a plan that asks exactly that down payment (resale units have no plan percent, so they are not matched).
      const d = add(f.payment_down_pct);
      where.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'down_payment_pct')::numeric = ${d})`);
    }
    if (f.payment_years !== null) {
      // "على 8 سنين": a plan of that many years or more (or a resale with that many years left or more).
      const y = add(f.payment_years);
      where.push(`(l.installment_years >= ${y} OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'years')::numeric >= ${y}))`);
    }
    if (f.max_down_payment !== null) {
      const p = add(f.max_down_payment);
      where.push(`(
        (l.market = 'resale' AND coalesce(nullif(l.down_payment_value, 0), l.price_value) <= ${p}) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'down_payment_pct')::numeric * l.price_value / 100 <= ${p})
      )`);
    }
    if (f.max_installment !== null) {
      const p = add(f.max_installment);
      where.push(`(
        (l.installment_value IS NOT NULL AND l.installment_value <= ${p}) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(l.payment_terms->'plans', '[]'::jsonb)) p
                WHERE (p->>'years')::numeric > 0
                  AND l.price_value * (100 - coalesce((p->>'down_payment_pct')::numeric, 0)) / 100
                      / ((p->>'years')::numeric * 12 / ${STEP_MONTHS_SQL}) <= ${p})
      )`);
    }

    if (f.features.length) where.push(`l.feature_keys @> ${add(f.features)}::text[]`);
    for (const t of f.feature_terms) where.push(`l.search_text_normalized LIKE '%' || ${add(t)} || '%'`);
  }

  const sql = `
    SELECT l.*, COUNT(*) OVER() AS total_count
    FROM listings l
    WHERE ${Vis.units("l")} AND ${where.join("\n      AND ")}
    ORDER BY ${rank} l.confirmed_at DESC NULLS LAST, l.created_at DESC, l.id DESC
    LIMIT ${add(limit)} OFFSET ${add(offset)}`;
  return { sql, params };
}

/**
 * Runs a search: strict pass, then a relaxed pass when strict finds nothing.
 * @returns {Promise<{ rows, ids, total, relaxed, dbMs }>} rows = first page, ids = snapshot for "more"
 */
async function runSearch(pool, agencyId, parsed, { pageSize = PAGE_SIZE } = {}) {
  const t0 = Date.now();
  let relaxed = false;
  let { sql, params } = buildSearchQuery(agencyId, parsed);
  let { rows } = await pool.query(sql, params);
  if (!rows.length && !parsed.filters.code) {
    ({ sql, params } = buildSearchQuery(agencyId, parsed, { relaxed: true }));
    ({ rows } = await pool.query(sql, params));
    relaxed = rows.length > 0;
  }
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.slice(0, pageSize), ids: rows.map((r) => r.id), total, relaxed, dbMs: Date.now() - t0 };
}

/**
 * Next page from an id snapshot (B1): stable order and no repeats even if inventory changed.
 * Units sold or archived since are skipped.
 */
async function pageByIds(pool, agencyId, ids, offset, pageSize = PAGE_SIZE) {
  const slice = ids.slice(offset, offset + pageSize);
  if (!slice.length) return [];
  const { rows } = await pool.query(
    `SELECT l.* FROM listings l
     WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.status = 'active' AND l.id = ANY($2::uuid[])
     ORDER BY array_position($2::uuid[], l.id)`,
    [agencyId, slice]
  );
  return rows;
}

/**
 * The whole search for one request: parse → intent guard → run.
 * @returns {Promise<{ status: "results"|"none"|"small_talk"|"listing", parsed, source, rows, ids, total, relaxed, timings }>}
 */
async function search({ pool, AI, agencyId, text, ctx = {}, pageSize = PAGE_SIZE }) {
  const parse = await parseRequest(AI, { text, ctx });
  const intent = Q.classifyIntent(parse.parsed);
  const base = { parsed: parse.parsed, source: parse.source, modelUsed: parse.modelUsed, usage: parse.usage };
  if (intent !== "search") return { ...base, status: intent, rows: [], ids: [], total: 0, relaxed: false, timings: { parseMs: parse.ms, dbMs: 0 } };
  const res = await runSearch(pool, agencyId, parse.parsed, { pageSize });
  return { ...base, ...res, status: res.rows.length ? "results" : "none", timings: { parseMs: parse.ms, dbMs: res.dbMs } };
}

module.exports = {
  PAGE_SIZE,
  TG_PAGE_SIZE,
  SNAPSHOT_MAX,
  SEARCH_PROMPT,
  parseRequest,
  buildSearchQuery,
  runSearch,
  pageByIds,
  search
};
