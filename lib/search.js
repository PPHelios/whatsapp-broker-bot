// lib/search.js — Bilingual Trigram Search Engine, Query Parser & Geographic Expansion
"use strict";

const T = require("./text");
const U = require("./util");
const { reply, replyButtons } = require("./dispatcher");

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
    "compound": "SINGLE canonical compound name (e.g. هايد بارك, Hyde Park, سوديك, SODIC, نول, NOLL, ميفيدا, Mivida), else null. Do NOT concatenate multiple names or languages with commas in this single field.",
    "features": [ amenity keywords requested, e.g. "حمام سباحة", "نادي", "كلوب هاوس", "جيم", "حديقة", "روف", "أسانسير", "فيو", "جراج" ],
    "code": "unit code if the broker asked for a specific code (e.g. N4-105, HAS101), else null"
  },
  "locations": [ every specific place the broker mentioned, exactly as said ],
  "location_terms": [ up to ${MAX_TERMS} search terms in BOTH Arabic and English ]
}

CRITICAL RULES:
1. BILINGUAL TRANSLITERATION:
   - In location_terms, provide BOTH English and Egyptian Arabic forms.
   - For compound, provide ONLY ONE canonical name string (e.g. "هايد بارك" or "Hyde Park"). Put the alternate language names into location_terms.
   - Example: "Hyde Park" -> compound: "هايد بارك", location_terms: ["hyde park", "هايد بارك", "هايدبارك", "hydepark"]
   - Example: "NOLL" -> compound: "نول", location_terms: ["noll", "نول", "كليك", "kleek"]

2. FINANCIAL BOUNDS:
   - "معايا مقدم 500 ألف": set down_payment_max: 500000.
   - "قسط مش أكتر من 150 ألف": set installment_max: 150000.
   - "شقة بحدود 6 مليون": set price_max: 6000000.

3. STRICT BEDROOM & BATHROOM MATCHING:
   - "استوديو" or "studio": set property_types: ["studio"], bedrooms_min: 0, bedrooms_max: 0.
   - "غرفتين" or "2 نوم": set BOTH bedrooms_min: 2 AND bedrooms_max: 2.
   - "3 غرف": set BOTH bedrooms_min: 3 AND bedrooms_max: 3.
   - "2 حمام": set bathrooms_min: 2.

4. COMPOUND VS CITY BOUNDARY:
   - When a specific compound is named (e.g. "هايد بارك", "نول", "الاندلس", "ميفيدا"), DO NOT add broad city terms ("new cairo", "القاهرة الجديدة") into location_terms.`;

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

// Non-negative integer helper: allows 0 bedrooms for open-concept studios
const nonNegInt = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
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

  // Detect compound name and expand bilingual synonyms with delimiter resilience
  let compoundName = null;
  const extraTerms = [];

  if (f.compound) {
    const rawCompoundStr = String(f.compound).trim().slice(0, 120);
    // Split on commas, slashes, pipes, or words ("or", "و")
    const compoundParts = rawCompoundStr
      .split(/[,/|]|\s+(?:or|و)\s+/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (const part of compoundParts) {
      const cleanComp = part.toLowerCase().replace(/\s+/g, " ");
      let matched = false;
      for (const [key, syns] of Object.entries(BILINGUAL_COMPOUND_MAP)) {
        if (
          cleanComp === key ||
          cleanComp.replace(/\s+/g, "") === key.replace(/\s+/g, "") ||
          syns.includes(cleanComp) ||
          syns.some((s) => cleanComp === s.replace(/\s+/g, ""))
        ) {
          if (!compoundName) compoundName = syns[0];
          extraTerms.push(...syns);
          matched = true;
          break;
        }
      }
      if (!matched && !compoundName) {
        compoundName = part;
      }
    }
  }

  const cleanUnitCode = f.code ? T.extractCleanCode(f.code) : null;

  let bedroomsMin = nonNegInt(f.bedrooms_min);
  let bedroomsMax = nonNegInt(f.bedrooms_max);

  if (types.has("studio") && bedroomsMin === null && bedroomsMax === null) {
    bedroomsMin = 0;
    bedroomsMax = 0;
  } else if (bedroomsMin === 0 && bedroomsMax === 0) {
    types.add("studio");
  }

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
    bedrooms_min: bedroomsMin,
    bedrooms_max: bedroomsMax,
    bathrooms_min: nonNegInt(f.bathrooms_min),
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
      f.bedrooms_max != null ||
      f.bathrooms_min != null
  );
}

/* ====================================================================== */
/* 5. SQL Query Builder with Hard Bathrooms & Strict Compound Boundary    */
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

  // 1. Direct Code Lookup (Resale code or developer model code)
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

    // 2b. Strict Currency Segregation (EGP vs USD vs EUR)
    if (f.currency) {
      where.push(
        `coalesce(l.details->>'currency', 'EGP') = ${add(f.currency)}`
      );
    }

    // 3. Property Types
    if (f.property_types && f.property_types.length) {
      where.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);
    }

    // 4. Compound Matching (Bound strictly even in relaxed mode if explicitly named)
    if (f.compound) {
      const rawCompoundParts = String(f.compound)
        .split(/[,/|]|\s+(?:or|و)\s+/)
        .map((p) => p.trim())
        .filter(Boolean);

      const candidateTokens = rawCompoundParts.length
        ? rawCompoundParts
        : [f.compound];

      const synonymsSet = new Set(candidateTokens);
      for (const token of candidateTokens) {
        const cleanTok = token.toLowerCase().replace(/\s+/g, " ");
        for (const [key, syns] of Object.entries(BILINGUAL_COMPOUND_MAP)) {
          if (
            cleanTok === key ||
            cleanTok.replace(/\s+/g, "") === key.replace(/\s+/g, "") ||
            syns.includes(cleanTok) ||
            syns.some((s) => cleanTok === s.replace(/\s+/g, ""))
          ) {
            syns.forEach((s) => synonymsSet.add(s));
            break;
          }
        }
      }

      const synonyms = Array.from(synonymsSet);

      const compoundConditions = synonyms.map((syn) => {
        const pExact = add(syn);
        const pSpaceless = add(syn.replace(/\s+/g, ""));
        return `(
          public.clean_arabic_text(coalesce(l.compound, '')) LIKE '%' || public.clean_arabic_text(${pExact}) || '%' OR
          replace(public.clean_arabic_text(coalesce(l.compound, '')), ' ', '') LIKE '%' || public.clean_arabic_text(${pSpaceless}) || '%' OR
          public.clean_arabic_text(coalesce(l.search_text_normalized, l.search_text, '')) LIKE '%' || public.clean_arabic_text(${pExact}) || '%' OR
          replace(public.clean_arabic_text(coalesce(l.search_text_normalized, '')), ' ', '') LIKE '%' || public.clean_arabic_text(${pSpaceless}) || '%' OR
          coalesce(l.compound, '') ILIKE '%' || ${pExact} || '%' OR
          coalesce(l.compound_en, '') ILIKE '%' || ${pExact} || '%' OR
          coalesce(l.title, '') ILIKE '%' || ${pExact} || '%'
        )`;
      });

      where.push(`(${compoundConditions.join(" OR ")})`);
    }

    // 5. Price Bounds (Strict vs Relaxed)
    let priceMin = f.price_min;
    let priceMax = f.price_max;

    if (relaxed) {
      if (priceMin != null) priceMin = Math.round(priceMin * 0.85);
      if (priceMax != null) priceMax = Math.round(priceMax * 1.15);
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

    // 8. Bedrooms Matching (Strict vs Relaxed, with Studio 0-Bedroom Handling)
    if (
      f.bedrooms_min != null &&
      f.bedrooms_max != null &&
      f.bedrooms_min === f.bedrooms_max
    ) {
      if (f.bedrooms_min === 0) {
        where.push(`(l.bedrooms = 0 OR l.property_type = 'studio')`);
      } else if (relaxed) {
        const minB = Math.max(1, f.bedrooms_min - 1);
        const maxB = f.bedrooms_max + 1;
        where.push(`l.bedrooms BETWEEN ${add(minB)} AND ${add(maxB)}`);
      } else {
        where.push(`l.bedrooms = ${add(f.bedrooms_min)}`);
      }
    } else {
      if (f.bedrooms_min != null) {
        where.push(`l.bedrooms >= ${add(f.bedrooms_min)}`);
      }
      if (f.bedrooms_max != null) {
        where.push(`l.bedrooms <= ${add(f.bedrooms_max)}`);
      }
    }

    // 9. Hard Bathrooms Filter (Physical DB column with details JSONB fallback)
    if (f.bathrooms_min != null) {
      where.push(
        `coalesce(l.bathrooms, (l.details->>'bathrooms')::integer, 0) >= ${add(
          f.bathrooms_min
        )}`
      );
    }

    // 10. Elevated Specs (Strict only in unrelaxed mode)
    if (!relaxed) {
      if (f.has_master_bedroom) {
        where.push(
          `coalesce((l.details->>'has_master_bedroom')::boolean, false) = true`
        );
      }
      if (f.has_dressing_room) {
        where.push(
          `coalesce((l.details->>'has_dressing_room')::boolean, false) = true`
        );
      }
      if (f.nanny_room) {
        where.push(
          `coalesce((l.details->>'nanny_room')::boolean, false) = true`
        );
      }
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
                l.compound_en ILIKE '%' || ${i} || '%' OR
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
           l.bathrooms, l.location, l.compound, l.compound_en, l.district, l.payment_terms, l.collateral, l.details,
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

  let bedsMin = null;
  let bedsMax = null;
  let bathsMin = null;

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

  if (types.has("studio") || /استوديو|studio/i.test(lowerText)) {
    types.add("studio");
    bedsMin = 0;
    bedsMax = 0;
  } else if (/غرفتين|2\s*نوم/i.test(lowerText)) {
    bedsMin = 2;
    bedsMax = 2;
  } else {
    const bedMatch = lowerText.match(
      /(\d+)\s*(?:غرف|غرفه|غرفة|نوم|beds?|bedroom)/i
    );
    if (bedMatch && bedMatch[1]) {
      const b = parseInt(bedMatch[1], 10);
      bedsMin = b;
      bedsMax = b;
    }
  }

  if (/حمامين|2\s*حمام/i.test(lowerText)) {
    bathsMin = 2;
  } else {
    const bathMatch = lowerText.match(
      /(\d+)\s*(?:حمام|حمامات|baths?|bathroom)/i
    );
    if (bathMatch && bathMatch[1]) {
      bathsMin = parseInt(bathMatch[1], 10);
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
      compound: detectedCompound,
      bedrooms_min: bedsMin,
      bedrooms_max: bedsMax,
      bathrooms_min: bathsMin
    },
    locations: phrase ? [phrase] : [],
    location_terms: combinedTerms
  });
}

/* ====================================================================== */
/* 7. Presentation & Interpretation Helpers                               */
/* ====================================================================== */
const range = (min, max, unit) => {
  if (min != null && max != null) {
    return min === max ? `${min} ${unit}` : `${min}-${max} ${unit}`;
  }
  if (min != null) return `${min}+ ${unit}`;
  if (max != null) return `حتى ${max} ${unit}`;
  return "";
};

function formatInterpretation(p) {
  const f = p?.filters || {};
  const bits = [];

  const isStudio =
    (Array.isArray(f.property_types) && f.property_types.includes("studio")) ||
    (f.bedrooms_min === 0 && f.bedrooms_max === 0);

  if (Array.isArray(f.property_types) && f.property_types.length) {
    bits.push(f.property_types.map((t) => TYPE_AR[t] || t).join(" / "));
  }
  if (f.listing_type) {
    bits.push(f.listing_type === "rent" ? "للإيجار" : "للبيع");
  }
  if (f.compound) {
    bits.push(`كمبوند ${f.compound}`);
  } else if (Array.isArray(p.locations) && p.locations.length) {
    bits.push(p.locations.join("، "));
  }

  // Bedroom representation: Studio open-concept vs numbered bedrooms
  if (isStudio) {
    if (
      !Array.isArray(f.property_types) ||
      !f.property_types.includes("studio")
    ) {
      bits.push("استوديو (مفتوح)");
    }
  } else if (f.bedrooms_min != null || f.bedrooms_max != null) {
    bits.push(range(f.bedrooms_min, f.bedrooms_max, "غرف"));
  }

  if (f.bathrooms_min != null) {
    bits.push(`${f.bathrooms_min}+ حمام`);
  }

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

  if (f.area_min != null || f.area_max != null) {
    bits.push(range(f.area_min, f.area_max, "م²"));
  }

  if (Array.isArray(f.features) && f.features.length) {
    bits.push(f.features.join("، "));
  }
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
/* 8. AI Gateway Invocations                                               */
/* ====================================================================== */

/**
 * Parses a search query through the shared AI gateway (lib/ai.js generateWithCascade):
 * hedged model tiers, an 8s route deadline, fast thinking and per-call telemetry.
 *
 * @param {Object} aiShim - the lib/ai.js module (or a stand-in exposing generateWithCascade)
 * @param {Object} params - { text, audio: [{ buffer, mimeType }], ctx: { pool, broker } }
 */
async function parseSearchRequest(aiShim, { text = "", audio = [], ctx = {} } = {}) {
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

  const res = await aiShim.generateWithCascade({
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", temperature: 0 },
    operationType: "search_parse",
    ctx
  });

  return {
    parsed: normalizeParsed(JSON.parse(cleanJson(res.text))),
    usage: {
      input: res.usage?.promptTokenCount || 0,
      output: res.usage?.candidatesTokenCount || 0
    },
    modelUsed: res.modelUsed
  };
}

async function enrichLocation(
  aiShim,
  {
    location = "",
    title = "",
    rawText = "",
    model = "gemini-3.8-flash",
    timeoutMs = 20000
  } = {}
) {
  const response = await U.withTimeout(
    aiShim.models.generateContent({
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

/**
 * Operational Telemetry helper for search queries targeting public.operation_logs.
 */
async function logSearchOp(
  pool,
  {
    agency_id,
    broker_id,
    operation_type = "search_query",
    status = "success",
    error_code = null,
    total_duration_ms = 0,
    gemini_ms = 0,
    db_ms = 0,
    tokens_input = 0,
    tokens_output = 0,
    model_used = "gemini-3.8-flash",
    estimated_cost_usd = 0,
    metadata = {}
  }
) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO operation_logs (
        agency_id, broker_id, operation_type, status, error_code,
        total_duration_ms, gemini_ms, db_ms, tokens_input, tokens_output,
        model_used, estimated_cost_usd, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [
        agency_id || null,
        broker_id || null,
        operation_type,
        status,
        error_code,
        Math.round(total_duration_ms),
        Math.round(gemini_ms),
        Math.round(db_ms),
        tokens_input,
        tokens_output,
        model_used,
        estimated_cost_usd,
        JSON.stringify(metadata)
      ]
    );
  } catch (e) {
    console.warn("Search telemetry log warning:", e.message);
  }
}

/**
 * Handles incoming search messages (SCH-01), executing AI parse cascade or fallback regex,
 * executing database queries with relaxed fallback, persisting pagination state (SCH-02),
 * and formatting symmetrical results.
 */
async function handleSearchMessage(broker, text, ctx) {
  const startTime = Date.now();
  const { pool, lang, AI } = ctx;

  let parsed;
  let geminiDuration = 0;
  let usage = { input: 0, output: 0 };
  let modelUsed = "fallback_regex";

  const aiStartTime = Date.now();
  try {
    // Any AI failure (including the client failing to load) falls back to the regex parser.
    const res = await parseSearchRequest(AI, { text, ctx: { ...ctx, broker } });
    parsed = res.parsed;
    usage = res.usage || usage;
    modelUsed = res.modelUsed;
    geminiDuration = Date.now() - aiStartTime;
  } catch (err) {
    geminiDuration = Date.now() - aiStartTime;
    console.warn(
      "AI search parsing failed across all tiers, falling back to regex parser:",
      err.message
    );
    parsed = fallbackParse(text);
  }

  const agencyId = broker.agency_id;
  const dbStartTime = Date.now();

  // Pass 1: Strict Query
  const { sql, params } = buildSearchQuery(agencyId, parsed, {
    limit: 5,
    offset: 0
  });
  const { rows } = await pool.query(sql, params);
  let dbDuration = Date.now() - dbStartTime;

  let activeRows = rows;
  let isRelaxed = false;

  // Pass 2: Relaxed Fallback (Price/Area ±15%, Bedrooms ±1, Compound strictly locked)
  if (rows.length === 0) {
    const dbRelaxedStartTime = Date.now();
    const { sql: sqlRelaxed, params: paramsRelaxed } = buildSearchQuery(
      agencyId,
      parsed,
      { limit: 5, offset: 0, relaxed: true }
    );
    const { rows: rowsRelaxed } = await pool.query(sqlRelaxed, paramsRelaxed);
    dbDuration += Date.now() - dbRelaxedStartTime;

    if (rowsRelaxed.length === 0) {
      const targetCompound = parsed.filters?.compound;
      const noMatchMsg = targetCompound
        ? lang === "en"
          ? `🔍 No units found in *${targetCompound}* matching your criteria.`
          : `🔍 لم نجد أي وحدات مطابقة داخل *${targetCompound}* بالمواصفات المطلوبة.`
        : lang === "en"
        ? "🔍 No matching units found for your search criteria. Try broadening your price range or location."
        : "🔍 لم نجد وحدات مطابقة تماماً لبحثك. جرب توسيع نطاق السعر أو البحث في منطقة قريبة.";

      await reply(broker, noMatchMsg);

      logSearchOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "search_query",
        status: "zero_matches",
        total_duration_ms: Date.now() - startTime,
        gemini_ms: geminiDuration,
        db_ms: dbDuration,
        tokens_input: usage.input,
        tokens_output: usage.output,
        model_used: modelUsed,
        estimated_cost_usd: estimateCostUsd(usage),
        metadata: { filters: parsed.filters, zero_match: true }
      });
      return "done";
    }

    activeRows = rowsRelaxed;
    isRelaxed = true;
  }

  const totalCount = Number(activeRows[0]?.total_count) || activeRows.length;

  // SCH-02: Persist Search State to PostgreSQL broker_sessions for pagination
  try {
    await pool.query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1::uuid, 'search_state', $2::jsonb, NOW() + INTERVAL '15 minutes')
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         session_data = EXCLUDED.session_data,
         expires_at = NOW() + INTERVAL '15 minutes'`,
      [
        broker.id,
        JSON.stringify({
          parsed,
          offset: activeRows.length,
          total_count: totalCount,
          relaxed: isRelaxed,
          created_at: Date.now()
        })
      ]
    );
  } catch (sessErr) {
    console.warn(
      "Failed to persist search pagination session:",
      sessErr.message
    );
  }

  const interp = formatInterpretation(parsed);
  const header = isRelaxed
    ? lang === "en"
      ? `⚠️ No exact matches found. Showing close alternatives for: *${interp}*\n\n`
      : `⚠️ لم نجد تطابقاً تاماً. إليك أقرب النتائج البديلة بناءً على: *${interp}*\n\n`
    : lang === "en"
    ? `🔍 Search results for: *${interp}*\n\n`
    : `🔍 نتائج البحث عن: *${interp}*\n\n`;

  const resultsText = T.formatSearchResults(activeRows, {
    total: totalCount,
    offset: 0,
    lang,
    agencyId,
    relaxed: isRelaxed
  });

  const fullMsg = header + resultsText;

  // SCH-02: Present quick-reply pagination button if more results exist
  if (activeRows.length < totalCount) {
    await replyButtons(broker, fullMsg, [
      {
        id: "MORE_SEARCH",
        title: lang === "en" ? "More Results ➡️" : "المزيد ➡️"
      }
    ]);
  } else {
    await reply(broker, fullMsg);
  }

  logSearchOp(pool, {
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "search_query",
    status: "success",
    total_duration_ms: Date.now() - startTime,
    gemini_ms: geminiDuration,
    db_ms: dbDuration,
    tokens_input: usage.input,
    tokens_output: usage.output,
    model_used: modelUsed,
    estimated_cost_usd: estimateCostUsd(usage),
    metadata: {
      result_count: activeRows.length,
      total_count: totalCount,
      relaxed: isRelaxed,
      filters: parsed.filters
    }
  });

  return "done";
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
  normalizeTerm,
  handleSearchMessage
};
