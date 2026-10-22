// lib/search.js — Bilingual Trigram Search Engine, Query Parser & Geographic Expansion
"use strict";

const T = require("./text");
const U = require("./util");

const PROPERTY_TYPES = [
  "apartment",
  "villa",
  "townhouse",
  "twinhouse",
  "duplex",
  "penthouse",
  "studio",
  "chalet",
  "office",
  "commercial"
];

const TYPE_AR = {
  apartment: "شقة",
  villa: "فيلا مستقلة",
  townhouse: "تاون هاوس",
  twinhouse: "توين هاوس",
  duplex: "دوبلكس",
  penthouse: "بنتهاوس",
  studio: "استوديو",
  chalet: "شاليه",
  office: "مكتب إداري",
  commercial: "تجاري"
};

const MAX_TERMS = 14;
const MAX_KEYWORDS = 16;

const BANNED_GENERIC_LOCATION_TERMS = new Set([
  "القاهره",
  "القاهرة",
  "cairo",
  "مصر",
  "egypt",
  "الجيزه",
  "الجيزة",
  "giza"
]);

/* ====================================================================== */
/* 1. Bilingual Compound & Project Mapping Dictionary                     */
/* ====================================================================== */
const BILINGUAL_COMPOUND_MAP = {
  // Hyde Park (Space-insensitive variations)
  "hyde park": ["هايد بارك", "هايدبارك", "هايد", "hyde park", "hydepark"],
  "هايد بارك": ["هايد بارك", "هايدبارك", "هايد", "hyde park", "hydepark"],
  هايدبارك: ["هايد بارك", "هايدبارك", "هايد", "hyde park", "hydepark"],

  // NOLL & Kleek
  noll: ["نول", "noll", "كليك", "kleek", "نول التجمع"],
  نول: ["نول", "noll", "كليك", "kleek", "نول التجمع"],
  kleek: ["كليك", "kleek", "نول", "noll"],

  // Mountain View
  "mountain view": [
    "ماونتن فيو",
    "ماونتن",
    "mountain view",
    "mv",
    "i-city",
    "اي سيتي",
    "ايسيتي"
  ],
  "ماونتن فيو": [
    "ماونتن فيو",
    "ماونتن",
    "mountain view",
    "mv",
    "i-city",
    "اي سيتي"
  ],

  // Sodic
  sodic: [
    "سوديك",
    "sodic",
    "villette",
    "فيليت",
    "westown",
    "ويست تاون",
    "eastown",
    "ايست تاون"
  ],
  سوديك: ["سوديك", "sodic", "villette", "فيليت", "westown", "ويست تاون"],

  // Mivida
  mivida: ["ميفيدا", "mivida", "اعمار", "emaar"],
  ميفيدا: ["ميفيدا", "mivida", "اعمار", "emaar"],

  // Palm Hills & Badya
  "palm hills": ["بالم هيلز", "بالم", "palm hills", "badya", "بادية", "بالمز"],
  "بالم هيلز": ["بالم هيلز", "بالم", "palm hills", "badya", "بادية"],
  badya: ["بادية", "badya", "بالم هيلز", "palm hills"],
  بادية: ["بادية", "badya", "بالم هيلز", "palm hills"],

  // Marassi
  marassi: ["مراسي", "marassi", "اعمار"],
  مراسي: ["مراسي", "marassi", "اعمار"],

  // Zed
  zed: ["زد", "ابراج زد", "zed", "zed towers", "اوراسكوم", "sawiris"],
  زد: ["زد", "ابراج زد", "zed", "zed towers"],

  // Madinaty & Rehab
  madinaty: ["مدينتي", "madinaty", "طلعت مصطفى", "tmg"],
  مدينتي: ["مدينتي", "madinaty", "طلعت مصطفى"],
  rehab: ["الرحاب", "رحاب", "rehab"],
  الرحاب: ["الرحاب", "رحاب", "rehab"],

  // Swan Lake
  swanlake: ["سوان ليك", "سوانليك", "swanlake", "swan lake", "حسن علام"],
  "سوان ليك": ["سوان ليك", "سوانليك", "swanlake", "swan lake", "حسن علام"]
};

/* ====================================================================== */
/* 2. Amenity Synonyms                                                    */
/* ====================================================================== */
const AMENITY_SYNONYMS = {
  pool: ["حمام سباحة", "حمام سباحه", "بول", "pool", "swimming"],
  "حمام سباحة": ["حمام سباحة", "حمام سباحه", "بول", "pool", "swimming"],
  club: ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  clubhouse: ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  نادي: ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  gym: ["جيم", "gym", "fitness", "لياقة"],
  جيم: ["جيم", "gym", "fitness", "لياقة"],
  garden: ["حديقة", "حديقه", "جاردن", "garden", "ارضي بحديقة", "أرضي بحديقة"],
  حديقة: ["حديقة", "حديقه", "جاردن", "garden", "ارضي بحديقة", "أرضي بحديقة"],
  elevator: ["مصعد", "اسانسير", "أسانسير", "elevator", "lift"],
  مصعد: ["مصعد", "اسانسير", "أسانسير", "elevator", "lift"],
  parking: ["جراج", "موقف", "parking", "garage", "باكية"],
  جراج: ["جراج", "موقف", "parking", "garage", "باكية"],
  view: ["فيو", "إطلالة", "اطلالة", "view", "open view", "بحيرات"],
  فيو: ["فيو", "إطلالة", "اطلالة", "view", "open view", "بحيرات"],
  terrace: ["تراس", "بلكونة", "بلكونه", "terrace", "balcony"],
  تراس: ["تراس", "بلكونة", "بلكونه", "terrace", "balcony"],
  roof: [
    "روف",
    "سطح",
    "roof",
    "rooftop",
    "بنتهاوس",
    "penthouse",
    "أخير بروف",
    "اخير بروف"
  ],
  روف: [
    "روف",
    "سطح",
    "roof",
    "rooftop",
    "بنتهاوس",
    "penthouse",
    "أخير بروف",
    "اخير بروف"
  ]
};

function expandAmenitySynonyms(term) {
  const norm = String(term || "")
    .trim()
    .toLowerCase();
  for (const [key, synonyms] of Object.entries(AMENITY_SYNONYMS)) {
    if (norm === key || synonyms.includes(norm)) {
      return synonyms;
    }
  }
  return [norm];
}

const cleanJson = (t) =>
  String(t || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

/* ====================================================================== */
/* 3. AI Search Extraction Prompt                                         */
/* ====================================================================== */
const SEARCH_PROMPT = `You are the search-understanding layer of a WhatsApp real-estate inventory bot used by Egyptian brokers.
Transcribe any voice notes first, then extract the search filters into strictly valid JSON.

Return ONE JSON object:
{
  "intent": "search" | "listing" | "other",
  "transcript": "text of the voice note, or the message as written",
  "language": "ar" | "en",
  "filters": {
    "listing_type": "sale" | "rent" | null,
    "property_types": [ any of: ${PROPERTY_TYPES.join(", ")} ],
    "currency": "EGP" | "USD" | "EUR" | null,
    "price_min": number or null,
    "price_max": number or null,
    "down_payment_max": number or null,
    "installment_max": number or null,
    "area_min": number in square meters or null,
    "area_max": number in square meters or null,
    "bedrooms_min": integer or null,
    "bedrooms_max": integer or null,
    "bathrooms_min": integer or null,
    "floor": "ground" | "typical" | "last" | "roof" | "penthouse" | string or null,
    "finishing": "core_and_shell" | "semi_finished" | "fully_finished" | "ultra_super_lux" | string or null,
    "has_master_bedroom": boolean or null,
    "has_dressing_room": boolean or null,
    "nanny_room": boolean or null,
    "compound": "compound name in Arabic and/or English if specified (e.g. هايد بارك, hyde park, سوديك, sodic, نول, noll), else null",
    "features": [ amenity keywords requested, e.g. "حمام سباحة", "نادي", "كلوب هاوس", "جيم", "حديقة", "روف", "أسانسير", "فيو", "جراج" ],
    "code": "unit code if the broker asked for a specific code (e.g. N4-105, HAS101), else null"
  },
  "locations": [ every specific place the broker mentioned, exactly as said ],
  "location_terms": [ up to ${MAX_TERMS} search terms in BOTH Arabic and English ]
}

CRITICAL RULES:
1. BILINGUAL TRANSLITERATION:
   - Provide BOTH English and Egyptian Arabic forms in location_terms and compound.
   - Example: "Hyde Park" -> compound: "هايد بارك", location_terms: ["hyde park", "هايد بارك", "هايدبارك", "hydepark"]
   - Example: "NOLL" -> compound: "نول", location_terms: ["noll", "نول", "كليك", "kleek"]

2. FINANCIAL BOUNDS:
   - "معايا مقدم 500 ألف": set down_payment_max: 500000.
   - "قسط مش أكتر من 150 ألف": set installment_max: 150000.
   - "شقة بحدود 6 مليون": set price_max: 6000000.

3. STRICT BEDROOM MATCHING:
   - "غرفتين" or "2 نوم": set BOTH bedrooms_min: 2 AND bedrooms_max: 2.
   - "3 غرف": set BOTH bedrooms_min: 3 AND bedrooms_max: 3.

4. COMPOUND VS CITY BOUNDARY:
   - When a specific compound is named (e.g. "هايد بارك", "نول", "ميفيدا"), DO NOT add broad city terms ("new cairo", "القاهرة الجديدة") into location_terms.`;

const ENRICH_PROMPT = `You enrich the geographic metadata of an Egyptian real-estate listing so buyers can find it accurately.
Input is the listing's stated location, title, and text description. Return ONE JSON object:
{
  "compound": "compound / project name in Arabic, or null",
  "district": "district in Arabic (e.g. التجمع الخامس, المربع الذهبي, الشيخ زايد), or null",
  "city": "city / region in Arabic (e.g. القاهرة الجديدة, 6 أكتوبر), or null",
  "location_keywords": [ up to ${MAX_KEYWORDS} targeted names someone might type to find this unit ],
  "basis": "stated" | "inferred"
}`;

/* ====================================================================== */
/* 4. Normalization Helpers                                               */
/* ====================================================================== */
function normalizeTerm(t) {
  return T.normalizeAr(String(t ?? ""))
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKeywords(list, max = MAX_KEYWORDS) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTerm(raw);
    if (
      t.length >= 2 &&
      t.length <= 40 &&
      !BANNED_GENERIC_LOCATION_TERMS.has(t) &&
      !out.includes(t)
    ) {
      out.push(t);
    }
    if (out.length >= max) break;
  }
  return out;
}

const posNum = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const money = (v) => {
  if (typeof v === "number") return posNum(v);
  return T.parsePrice(String(v ?? ""), { implicitUnits: true }) ?? posNum(v);
};

function normalizeParsed(raw) {
  const r = (Array.isArray(raw) ? raw[0] : raw) || {};
  const f = r.filters || {};
  const types = new Set();

  for (const t of Array.isArray(f.property_types) ? f.property_types : []) {
    const k = String(t)
      .toLowerCase()
      .replace(/[\s_-]/g, "");
    if (PROPERTY_TYPES.includes(k)) types.add(k);
  }

  // Detect compound name and expand bilingual synonyms
  let compoundName = f.compound ? String(f.compound).trim().slice(0, 80) : null;
  const extraTerms = [];

  if (compoundName) {
    const cleanComp = compoundName.toLowerCase().replace(/\s+/g, " ");
    for (const [key, syns] of Object.entries(BILINGUAL_COMPOUND_MAP)) {
      if (
        cleanComp === key ||
        cleanComp.replace(/\s+/g, "") === key.replace(/\s+/g, "") ||
        syns.includes(cleanComp)
      ) {
        compoundName = syns[0]; // Primary canonical name
        extraTerms.push(...syns);
        break;
      }
    }
  }

  const cleanUnitCode = f.code ? T.extractCleanCode(f.code) : null;

  const filters = {
    listing_type: ["sale", "rent"].includes(f.listing_type)
      ? f.listing_type
      : null,
    property_types: [...types],
    currency: ["USD", "EUR", "EGP"].includes(f.currency) ? f.currency : null,
    price_min: money(f.price_min),
    price_max: money(f.price_max),
    down_payment_max: money(f.down_payment_max),
    installment_max: money(f.installment_max),
    area_min: posNum(f.area_min),
    area_max: posNum(f.area_max),
    bedrooms_min: posNum(f.bedrooms_min)
      ? Math.round(posNum(f.bedrooms_min))
      : null,
    bedrooms_max: posNum(f.bedrooms_max)
      ? Math.round(posNum(f.bedrooms_max))
      : null,
    bathrooms_min: posNum(f.bathrooms_min)
      ? Math.round(posNum(f.bathrooms_min))
      : null,
    floor: f.floor ? String(f.floor).trim().slice(0, 40) : null,
    finishing: f.finishing ? String(f.finishing).trim().slice(0, 40) : null,
    has_master_bedroom: f.has_master_bedroom === true ? true : null,
    has_dressing_room: f.has_dressing_room === true ? true : null,
    nanny_room: f.nanny_room === true ? true : null,
    compound: compoundName,
    features: normalizeKeywords(f.features, 8),
    code: cleanUnitCode || null
  };

  for (const [lo, hi] of [
    ["price_min", "price_max"],
    ["area_min", "area_max"],
    ["bedrooms_min", "bedrooms_max"]
  ]) {
    if (
      filters[lo] != null &&
      filters[hi] != null &&
      filters[lo] > filters[hi]
    ) {
      [filters[lo], filters[hi]] = [filters[hi], filters[lo]];
    }
  }

  const rawLocations = (Array.isArray(r.locations) ? r.locations : [])
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 4);

  let terms = normalizeKeywords(
    [
      ...rawLocations,
      ...(Array.isArray(r.location_terms) ? r.location_terms : []),
      ...extraTerms
    ],
    MAX_TERMS
  ).filter((term) => !BANNED_GENERIC_LOCATION_TERMS.has(term));

  if (filters.compound) {
    const broadCityTerms = new Set([
      "القاهرة الجديدة",
      "new cairo",
      "التجمع",
      "التجمع الخامس",
      "5th settlement",
      "6 اكتوبر",
      "6 october",
      "الشيخ زايد",
      "sheikh zayed"
    ]);
    terms = terms.filter((t) => !broadCityTerms.has(t));
    const compNorm = normalizeTerm(filters.compound);
    if (!terms.some((t) => t.includes(compNorm))) {
      terms.unshift(compNorm);
    }
  }

  return {
    intent: ["search", "listing", "other"].includes(r.intent)
      ? r.intent
      : "search",
    transcript: String(r.transcript ?? "").slice(0, 500),
    language: r.language === "en" ? "en" : "ar",
    filters,
    locations: rawLocations,
    location_terms: terms
  };
}

function hasAnyFilter(p) {
  const f = p?.filters || {};
  return Boolean(
    f.code ||
      f.compound ||
      (p.location_terms && p.location_terms.length) ||
      (f.features && f.features.length) ||
      f.listing_type ||
      (f.property_types && f.property_types.length) ||
      f.price_min != null ||
      f.price_max != null ||
      f.down_payment_max != null ||
      f.installment_max != null ||
      f.area_min != null ||
      f.area_max != null ||
      f.bedrooms_min != null ||
      f.bedrooms_max != null
  );
}

/* ====================================================================== */
/* 5. SQL Query Builder with Relaxed Cascade & Space-Insensitive Match   */
/* ====================================================================== */
function buildSearchQuery(
  agencyId,
  parsed,
  { limit = 5, offset = 0, relaxed = false } = {}
) {
  const where = ["l.agency_id = $1", "l.status = 'active'"];
  const params = [agencyId];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  const f = parsed.filters || {};

  // 1. Direct Code Lookup (Checks resale code and developer model code)
  if (f.code) {
    const codeParam = add(T.extractCleanCode(f.code));
    where.push(
      `(l.code = ${codeParam} OR l.developer_unit_code = ${codeParam})`
    );
  } else {
    // 2. Listing Type (Sale vs Rent)
    if (f.listing_type) {
      where.push(`l.listing_type = ${add(f.listing_type)}`);
    }

    // 3. Property Types
    if (f.property_types && f.property_types.length) {
      where.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);
    }

    // 4. Compound Matching (Handles space variations e.g. هايد بارك vs هايدبارك)
    if (f.compound) {
      let synonyms = [f.compound];
      for (const [key, syns] of Object.entries(BILINGUAL_COMPOUND_MAP)) {
        if (
          syns.includes(f.compound) ||
          syns.some((s) => s.includes(f.compound))
        ) {
          synonyms = Array.from(new Set([...synonyms, ...syns]));
          break;
        }
      }

      const compoundConditions = synonyms.map((syn) => {
        const pExact = add(syn);
        const pSpaceless = add(syn.replace(/\s+/g, ""));
        return `(
          public.clean_arabic_text(coalesce(l.compound, '')) LIKE '%' || public.clean_arabic_text(${pExact}) || '%' OR
          replace(public.clean_arabic_text(coalesce(l.compound, '')), ' ', '') LIKE '%' || public.clean_arabic_text(${pSpaceless}) || '%' OR
          public.clean_arabic_text(coalesce(l.search_text_normalized, l.search_text, '')) LIKE '%' || public.clean_arabic_text(${pExact}) || '%' OR
          replace(public.clean_arabic_text(coalesce(l.search_text_normalized, '')), ' ', '') LIKE '%' || public.clean_arabic_text(${pSpaceless}) || '%' OR
          coalesce(l.compound, '') ILIKE '%' || ${pExact} || '%' OR
          coalesce(l.title, '') ILIKE '%' || ${pExact} || '%'
        )`;
      });

      where.push(`(${compoundConditions.join(" OR ")})`);
    }

    // 5. Price Bounds (Strict vs Relaxed)
    let priceMin = f.price_min;
    let priceMax = f.price_max;

    if (relaxed) {
      if (priceMin != null) priceMin = Math.round(priceMin * 0.85); // 15% lower floor
      if (priceMax != null) priceMax = Math.round(priceMax * 1.15); // 15% higher ceiling
    }

    if (priceMin != null) where.push(`l.price_value >= ${add(priceMin)}`);
    if (priceMax != null) where.push(`l.price_value <= ${add(priceMax)}`);

    // 6. Down Payment & Cash-Flow Filtering
    if (f.down_payment_max != null) {
      const dpParam = add(f.down_payment_max);
      where.push(`(
        coalesce(l.down_payment_value, (l.details->>'down_payment_value')::numeric, l.price_value) <= ${dpParam} OR
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(l.payment_terms->'plans') p
          WHERE (p->>'down_payment_pct')::numeric * l.price_value / 100 <= ${dpParam}
        )
      )`);
    }

    // 7. Area Bounds (Strict vs Relaxed)
    let areaMin = f.area_min;
    let areaMax = f.area_max;
    if (relaxed) {
      if (areaMin != null) areaMin = Math.round(areaMin * 0.85);
      if (areaMax != null) areaMax = Math.round(areaMax * 1.15);
    }
    if (areaMin != null) where.push(`l.area_value >= ${add(areaMin)}`);
    if (areaMax != null) where.push(`l.area_value <= ${add(areaMax)}`);

    // 8. Bedrooms Matching (Strict vs Relaxed)
    if (
      f.bedrooms_min != null &&
      f.bedrooms_max != null &&
      f.bedrooms_min === f.bedrooms_max
    ) {
      if (relaxed) {
        const minB = Math.max(1, f.bedrooms_min - 1);
        const maxB = f.bedrooms_max + 1;
        where.push(`l.bedrooms BETWEEN ${add(minB)} AND ${add(maxB)}`);
      } else {
        where.push(`l.bedrooms = ${add(f.bedrooms_min)}`);
      }
    } else {
      if (f.bedrooms_min != null)
        where.push(`l.bedrooms >= ${add(f.bedrooms_min)}`);
      if (f.bedrooms_max != null)
        where.push(`l.bedrooms <= ${add(f.bedrooms_max)}`);
    }

    // 9. Bathrooms
    if (f.bathrooms_min != null && !relaxed) {
      where.push(
        `coalesce((l.details->>'bathrooms')::numeric, 0) >= ${add(
          f.bathrooms_min
        )}`
      );
    }

    // 10. Elevated Specs (Strict only in unrelaxed mode)
    if (!relaxed) {
      if (f.has_master_bedroom)
        where.push(
          `coalesce((l.details->>'has_master_bedroom')::boolean, false) = true`
        );
      if (f.has_dressing_room)
        where.push(
          `coalesce((l.details->>'has_dressing_room')::boolean, false) = true`
        );
      if (f.nanny_room)
        where.push(
          `coalesce((l.details->>'nanny_room')::boolean, false) = true`
        );
    }

    // 11. Multi-Amenity Features
    if (f.features && f.features.length) {
      for (const feat of f.features) {
        if (/روف|roof/i.test(feat)) {
          where.push(`(
            l.property_type = 'penthouse' OR
            public.clean_arabic_text(coalesce(l.details->>'floor', '')) LIKE '%روف%' OR
            public.clean_arabic_text(coalesce(l.details->>'floor', '')) LIKE '%اخير%' OR
            public.clean_arabic_text(coalesce(l.search_text_normalized, '')) LIKE '%روف%'
          )`);
        } else {
          const synonyms = expandAmenitySynonyms(feat);
          const subChecks = synonyms.map((syn) => {
            const pIdx = add(syn);
            return `(public.clean_arabic_text(coalesce(l.title,'') || ' ' || coalesce(l.details::text,'') || ' ' || coalesce(l.search_text_normalized,'')) LIKE '%' || public.clean_arabic_text(${pIdx}) || '%')`;
          });
          where.push(`(${subChecks.join(" OR ")})`);
        }
      }
    }
  }

  // 12. Geographic Ranking via Functional Trigram Index
  let score = "";
  const terms = f.code
    ? []
    : (parsed.location_terms || []).filter(Boolean).slice(0, MAX_TERMS);

  if (terms.length) {
    const idx = terms.map(add);
    where.push(
      "(" +
        idx
          .map(
            (i) =>
              `(
                public.clean_arabic_text(coalesce(l.search_text_normalized, l.search_text, '')) LIKE '%' || public.clean_arabic_text(${i}) || '%' OR
                public.clean_arabic_text(${i}) <% public.clean_arabic_text(coalesce(l.search_text_normalized, l.search_text, '')) OR
                l.compound ILIKE '%' || ${i} || '%' OR
                l.location ILIKE '%' || ${i} || '%' OR
                l.title ILIKE '%' || ${i} || '%'
              )`
          )
          .join(" OR ") +
        ")"
    );

    score = `GREATEST(${idx
      .map(
        (i) =>
          `word_similarity(public.clean_arabic_text(${i}), public.clean_arabic_text(coalesce(l.search_text_normalized, l.search_text, '')))`
      )
      .join(", ")}) DESC NULLS LAST,`;
  }

  const limitP = add(limit);
  const offsetP = add(offset);

  const sql = `
    SELECT l.id, l.code, l.developer_unit_code, l.inventory_type, l.title, l.property_type,
           l.listing_type, l.status, l.price_value, l.price_display, l.area_value, l.bedrooms,
           l.location, l.compound, l.district, l.payment_terms, l.collateral, l.details,
           COUNT(*) OVER() AS total_count
    FROM listings l
    WHERE ${where.join(" AND ")}
    ORDER BY ${score} l.created_at DESC, l.id DESC
    LIMIT ${limitP} OFFSET ${offsetP}`;

  return { sql, params };
}

/* ====================================================================== */
/* 6. Fallback Parser (Local Regex & Keyword Matcher)                      */
/* ====================================================================== */
const STOP = new Set(
  [
    "في",
    "فى",
    "من",
    "الى",
    "إلى",
    "علي",
    "على",
    "عن",
    "و",
    "مع",
    "عايز",
    "عاوز",
    "عايزه",
    "محتاج",
    "دورلي",
    "ورني",
    "وريني",
    "فيه",
    "عندنا",
    "عندك",
    "بحث",
    "ابحث",
    "لي",
    "لو",
    "سمحت",
    "the",
    "a",
    "in",
    "for",
    "show",
    "me",
    "find",
    "search",
    "i",
    "want",
    "need",
    "القاهره",
    "القاهرة",
    "cairo",
    "مصر"
  ].map(normalizeTerm)
);

const TYPE_WORDS = {
  شقه: "apartment",
  شقق: "apartment",
  apartment: "apartment",
  فيلا: "villa",
  فيلات: "villa",
  villa: "villa",
  دوبلكس: "duplex",
  duplex: "duplex",
  بنتهاوس: "penthouse",
  penthouse: "penthouse",
  استوديو: "studio",
  studio: "studio",
  شاليه: "chalet",
  chalet: "chalet",
  مكتب: "office",
  office: "office",
  تاون: "townhouse",
  توين: "twinhouse"
};

function fallbackParse(text) {
  const rawText = String(text || "").trim();
  const lowerText = rawText.toLowerCase();
  const tokens = normalizeTerm(rawText).split(" ").filter(Boolean);
  const types = new Set();
  const terms = [];
  let detectedCompound = null;
  const extraCompoundTerms = [];

  for (const [key, syns] of Object.entries(BILINGUAL_COMPOUND_MAP)) {
    if (
      lowerText.includes(key) ||
      syns.some((s) => lowerText.includes(s.toLowerCase()))
    ) {
      detectedCompound = syns[0];
      extraCompoundTerms.push(...syns);
      break;
    }
  }

  for (const t of tokens) {
    if (TYPE_WORDS[t]) {
      types.add(TYPE_WORDS[t]);
    } else if (!STOP.has(t) && !/^\d+$/.test(t) && t.length >= 2) {
      terms.push(t);
    }
  }

  const phrase = terms.join(" ");
  const combinedTerms = Array.from(
    new Set([phrase, ...terms, ...extraCompoundTerms].filter(Boolean))
  );

  return normalizeParsed({
    intent: "search",
    transcript: rawText,
    filters: {
      property_types: [...types],
      compound: detectedCompound
    },
    locations: phrase ? [phrase] : [],
    location_terms: combinedTerms
  });
}

/* ====================================================================== */
/* 7. Presentation & Interpretation Helpers                               */
/* ====================================================================== */
const range = (min, max, unit) => {
  if (min != null && max != null)
    return min === max ? `${min} ${unit}` : `${min}-${max} ${unit}`;
  if (min != null) return `${min}+ ${unit}`;
  if (max != null) return `حتى ${max} ${unit}`;
  return "";
};

function formatInterpretation(p) {
  const f = p?.filters || {};
  const bits = [];

  if (Array.isArray(f.property_types) && f.property_types.length) {
    bits.push(f.property_types.map((t) => TYPE_AR[t] || t).join(" / "));
  }
  if (f.listing_type)
    bits.push(f.listing_type === "rent" ? "للإيجار" : "للبيع");
  if (f.compound) bits.push(`كمبوند: ${f.compound}`);
  else if (Array.isArray(p.locations) && p.locations.length)
    bits.push(p.locations.join("، "));

  bits.push(range(f.bedrooms_min, f.bedrooms_max, "غرف"));
  if (f.bathrooms_min != null) bits.push(`${f.bathrooms_min}+ حمام`);
  if (f.has_master_bedroom) bits.push("غرفة ماستر");
  if (f.has_dressing_room) bits.push("دريسنج");
  if (f.nanny_room) bits.push("غرفة ناني");

  if (f.price_min != null && f.price_max != null) {
    bits.push(
      `${T.formatPrice(
        f.price_min,
        "ar",
        f.currency || "EGP"
      )} - ${T.formatPrice(f.price_max, "ar", f.currency || "EGP")}`
    );
  } else if (f.price_max != null) {
    bits.push(`حتى ${T.formatPrice(f.price_max, "ar", f.currency || "EGP")}`);
  }

  if (f.down_payment_max != null) {
    bits.push(`مقدم حتى ${T.formatPrice(f.down_payment_max, "ar", "EGP")}`);
  }

  bits.push(range(f.area_min, f.area_max, "م²"));
  if (Array.isArray(f.features) && f.features.length)
    bits.push(f.features.join("، "));
  if (f.code) bits.push(`كود #${f.code}`);

  return bits.filter(Boolean).join(" • ");
}

function estimateCostUsd(usage, { inPerM = 0.075, outPerM = 0.3 } = {}) {
  const u = usage || {};
  return Number(
    (((u.input || 0) * inPerM + (u.output || 0) * outPerM) / 1e6).toFixed(6)
  );
}

/* ====================================================================== */
/* 8. AI Gateway Invocations                                              */
/* ====================================================================== */
async function parseSearchRequest(
  aiShim,
  { text = "", audio = [], model, timeoutMs = 35000 }
) {
  const parts = [
    {
      text:
        SEARCH_PROMPT +
        (text.trim()
          ? `\n\n===USER_QUERY===\n${text.trim()}\n===USER_QUERY===`
          : "")
    },
    ...audio.map((a) => ({
      inlineData: {
        data: a.buffer.toString("base64"),
        mimeType: U.cleanAudioMime(a.mimeType)
      }
    }))
  ];

  const response = await U.withTimeout(
    aiShim.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", temperature: 0 }
    }),
    timeoutMs,
    "gemini-search-parse"
  );

  return {
    parsed: normalizeParsed(JSON.parse(cleanJson(response.text))),
    usage: {
      input: response.usageMetadata?.promptTokenCount || 0,
      output: response.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

async function enrichLocation(
  ai,
  { location = "", title = "", rawText = "", model, timeoutMs = 20000 }
) {
  const response = await U.withTimeout(
    ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${ENRICH_PROMPT}\n\nLocation: ${location}\nTitle: ${title}\nText: ${String(
                rawText
              ).slice(0, 600)}`
            }
          ]
        }
      ],
      config: { responseMimeType: "application/json", temperature: 0 }
    }),
    timeoutMs,
    "gemini-enrich"
  );

  const r = JSON.parse(cleanJson(response.text)) || {};
  const s = (v) => (v ? String(v).trim().slice(0, 80) : null);

  return {
    compound: s(r.compound),
    district: s(r.district),
    city: s(r.city),
    keywords: normalizeKeywords([
      r.compound,
      r.district,
      r.city,
      location,
      ...(r.location_keywords || [])
    ]),
    basis: r.basis === "inferred" ? "inferred" : "stated",
    usage: {
      input: response.usageMetadata?.promptTokenCount || 0,
      output: response.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

module.exports = {
  PROPERTY_TYPES,
  TYPE_AR,
  SEARCH_PROMPT,
  ENRICH_PROMPT,
  normalizeParsed,
  hasAnyFilter,
  buildSearchQuery,
  fallbackParse,
  formatInterpretation,
  estimateCostUsd,
  parseSearchRequest,
  enrichLocation,
  expandAmenitySynonyms,
  normalizeKeywords,
  normalizeTerm
};
