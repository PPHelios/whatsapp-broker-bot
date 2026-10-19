// lib/search.js

const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

/**
 * Builds a parameterized SQL query for listings search.
 *
 * @param {string} agencyId - Tenant UUID scoped to the broker's agency
 * @param {object} p - Normalized parsed filters from normalizeParsed()
 * @param {object} options - Search options { relaxed: boolean, limit: number }
 * @returns {object} { sql: string, params: Array }
 */
function buildSearchQuery(agencyId, p, { relaxed = false, limit = 8 } = {}) {
  const f = p.filters || {};
  const params = [agencyId];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  const where = ["l.agency_id = $1", `l.status = 'active'`];
  let score = "0";

  // 1. Direct unit code search takes absolute priority
  if (f.code) {
    where.push(`lower(l.code) = lower(${add(f.code)})`);
  } else {
    // 2. Listing Type Filter (sale vs. rent)
    if (f.listing_type) {
      where.push(`l.listing_type = ${add(f.listing_type)}`);
    }

    // 3. Property Types Filter (with aliasing support e.g. twinhouse / twin_house)
    if (Array.isArray(f.property_types) && f.property_types.length > 0) {
      const types = new Set(f.property_types);
      if (types.has("twinhouse")) types.add("twin_house");
      where.push(`l.property_type = ANY(${add([...types])}::text[])`);
    }

    // 4. Numerical Range Filters (Price, Area, Bedrooms) with relaxation factor
    const widen = (v, factor) =>
      relaxed && v != null ? Math.round(v * factor) : v;

    const pMin = widen(f.price_min, 0.85); // -15% if relaxed
    const pMax = widen(f.price_max, 1.15); // +15% if relaxed
    const aMin = widen(f.area_min, 0.85); // -15% if relaxed
    const aMax = widen(f.area_max, 1.15); // +15% if relaxed

    if (pMin != null) where.push(`l.price_value >= ${add(pMin)}`);
    if (pMax != null) where.push(`l.price_value <= ${add(pMax)}`);
    if (aMin != null) where.push(`l.area_value >= ${add(aMin)}`);
    if (aMax != null) where.push(`l.area_value <= ${add(aMax)}`);

    const bMin =
      relaxed && f.bedrooms_min != null
        ? Math.max(1, f.bedrooms_min - 1)
        : f.bedrooms_min;
    const bMax =
      relaxed && f.bedrooms_max != null ? f.bedrooms_max + 1 : f.bedrooms_max;

    if (bMin != null) where.push(`l.bedrooms >= ${add(bMin)}`);
    if (bMax != null) where.push(`l.bedrooms <= ${add(bMax)}`);

    // 5. Location Matching via GIN index on location_keywords array and search_text ILIKE
    if (Array.isArray(p.location_terms) && p.location_terms.length > 0) {
      const kw = add(p.location_terms);
      const pats = add(p.location_terms.map((t) => `%${escapeLike(t)}%`));

      where.push(
        `(l.location_keywords && ${kw}::text[] OR l.search_text ILIKE ANY(${pats}::text[]))`
      );

      // Boost relevance when matching official keywords array over generic search text
      score = `(CASE WHEN l.location_keywords && ${kw}::text[] THEN 2 ELSE 1 END)`;
    }

    // 6. Features Soft Match (boosts ranking without excluding valid properties)
    if (Array.isArray(f.features) && f.features.length > 0) {
      const fp = add(f.features.map((t) => `%${escapeLike(t)}%`));
      score += ` + (CASE WHEN l.search_text ILIKE ANY(${fp}::text[]) THEN 1 ELSE 0 END)`;
    }
  }

  const queryLimit = Math.max(1, Math.min(20, Number(limit) || 8));

  // Select all display fields plus details JSONB for clean_summary
  const sql = `SELECT
    l.code,
    l.title,
    l.price_display,
    l.price_value,
    l.area_value,
    l.bedrooms,
    l.location,
    l.property_type,
    l.listing_type,
    l.details,
    l.details->>'clean_summary' AS clean_summary
  FROM listings l
  WHERE ${where.join("\n    AND ")}
  ORDER BY (${score}) DESC, l.created_at DESC
  LIMIT ${queryLimit}`;

  return { sql, params };
}

module.exports = {
  // ... other exports from lib/search.js
  buildSearchQuery
};
