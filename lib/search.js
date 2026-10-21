// AI-assisted inventory search for the WhatsApp broker bot with strict criteria enforcement.
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

// ---------------------------------------------------------------------------
// Amenity Synonyms
// ---------------------------------------------------------------------------
const AMENITY_SYNONYMS = {
  pool: ["حمام سباحة", "حمام سباحه", "بول", "pool", "swimming"],
  "حمام سباحة": ["حمام سباحة", "حمام سباحه", "بول", "pool", "swimming"],
  club: ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  clubhouse: ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  نادي: ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  "كلوب هاوس": ["نادي", "نادى", "كلوب هاوس", "كلوبهاوس", "club", "clubhouse"],
  gym: ["جيم", "gym", "fitness", "لياقة"],
  جيم: ["جيم", "gym", "fitness", "لياقة"],
  garden: ["حديقة", "حديقه", "جاردن", "garden", "ارضي بحديقة", "أرضي بحديقة"],
  حديقة: ["حديقة", "حديقه", "جاردن", "garden", "ارضي بحديقة", "أرضي بحديقة"],
  elevator: ["مصعد", "اسانسير", "أسانسير", "elevator", "lift"],
  مصعد: ["مصعد", "اسانسير", "أسانسير", "elevator", "lift"],
  أسانسير: ["مصعد", "اسانسير", "أسانسير", "elevator", "lift"],
  parking: ["جراج", "موقف", "parking", "garage", "باكية"],
  جراج: ["جراج", "موقف", "parking", "garage", "باكية"],
  view: [
    "فيو",
    "إطلالة",
    "اطلالة",
    "view",
    "open view",
    "sea view",
    "lake view",
    "بحيرات"
  ],
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

// ---------------------------------------------------------------------------
// Strict Search Prompt
// ---------------------------------------------------------------------------
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
    "compound": "compound name if specified (e.g. ميفيدا, هايد بارك, بادية, سوديك, مراسي), else null",
    "features": [ amenity keywords requested, e.g. "حمام سباحة", "نادي", "كلوب هاوس", "جيم", "حديقة", "روف", "أسانسير", "فيو", "جراج" ],
    "code": "unit code if the broker asked for a specific code, else null"
  },
  "locations": [ every specific place the broker mentioned, exactly as said ],
  "location_terms": [ up to ${MAX_TERMS} search terms, strictly adhering to the location rules ]
}

CRITICAL RULES FOR EXACT CRITERIA:
1. STRICT BEDROOM MATCHING:
   - If the broker mentions an exact number of bedrooms (e.g., "2 غرف", "غرفتين", "2 نوم", "2 bedrooms", "3 غرف"):
     Set BOTH "bedrooms_min" AND "bedrooms_max" to that exact integer (e.g. min: 2, max: 2).
   - ONLY leave a bound null if the broker explicitly says "على الأقل / 2+" (min only) or "بالكتير / أقصى حد" (max only).

2. ROOF / PENTHOUSE / GROUND STRICTNESS:
   - If "روف" or "roof" is requested: add "روف" to "features" AND set "floor": "roof".
   - If "أرضي" or "ground" is requested: set "floor": "ground". If "أرضي بحديقة" also add "حديقة" to "features".
   - If "بنتهاوس" or "penthouse": add "penthouse" to "property_types" AND add "روف" to "features".

3. STRICT ELEVATED SPECS:
   - "ماستر" / "غرفة ماستر": set "has_master_bedroom": true.
   - "دريسنج" / "غرفة ملابس": set "has_dressing_room": true.
   - "ناني" / "غرفة ناني" / "مربية": set "nanny_room": true. (NEVER use "خادمة").

4. COMPOUND VS CITY RULES (PREVENTS RETURNING WRONG PROJECTS):
   - When a specific compound is named (e.g. "ميفيدا", "هايد بارك", "مراسي", "بادية"):
     1. Set "filters.compound" to the compound name.
     2. "location_terms" MUST ONLY contain variations of THIS compound (e.g. ["ميفيدا", "mivida"]).
     3. STRICTLY FORBIDDEN: NEVER include broad city names (like "القاهرة الجديدة", "new cairo", "التجمع الخامس", "6 أكتوبر") in location_terms when a compound is requested.`;

const ENRICH_PROMPT = `You enrich the geographic metadata of an Egyptian real-estate listing so buyers can find it accurately.
Input is the listing's stated location, title, and text description. Return ONE JSON object:
{
  "compound": "compound / project name in Arabic, or null",
  "district": "district in Arabic (e.g. التجمع الخامس, المربع الذهبي, الشيخ زايد, مدينة نصر), or null",
  "city": "city / region in Arabic (e.g. القاهرة الجديدة, 6 أكتوبر, الساحل الشمالي, المقطم), or null",
  "location_keywords": [ up to ${MAX_KEYWORDS} targeted names someone might type to find this unit ],
  "basis": "stated" | "inferred"
}`;

// ---------------------------------------------------------------------------
// Normalization Helpers
// ---------------------------------------------------------------------------
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

  const filters = {
    listing_type: ["sale", "rent"].includes(f.listing_type)
      ? f.listing_type
      : null,
    property_types: [...types],
    currency: ["USD", "EUR", "EGP"].includes(f.currency) ? f.currency : null,
    price_min: money(f.price_min),
    price_max: money(f.price_max),
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
    compound: f.compound ? String(f.compound).trim().slice(0, 80) : null,
    features: normalizeKeywords(f.features, 8),
    code: f.code
      ? String(f.code).trim().replace(/^#/, "").slice(0, 30) || null
      : null
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
      ...(Array.isArray(r.location_terms) ? r.location_terms : [])
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
      "الشيخ زايد"
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
      f.currency != null ||
      f.price_min != null ||
      f.price_max != null ||
      f.area_min != null ||
      f.area_max != null ||
      f.bedrooms_min != null ||
      f.bedrooms_max != null ||
      f.bathrooms_min != null ||
      f.floor != null ||
      f.finishing != null ||
      f.has_master_bedroom != null ||
      f.has_dressing_room != null ||
      f.nanny_room != null
  );
}

// ---------------------------------------------------------------------------
// Strict SQL Query Builder
// ---------------------------------------------------------------------------
function buildSearchQuery(agencyId, parsed, { limit = 5, offset = 0 } = {}) {
  const where = ["l.agency_id = $1", "l.status = 'active'"];
  const params = [agencyId];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const f = parsed.filters || {};

  if (f.code) {
    where.push(`l.code = ${add(String(f.code).toUpperCase())}`);
  } else {
    // 1. Sale vs Rent
    if (f.listing_type) {
      where.push(`l.listing_type = ${add(f.listing_type)}`);
    }

    // 2. Property Types
    if (f.property_types && f.property_types.length) {
      where.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);
    }

    // 3. Strict Compound Isolation
    if (f.compound) {
      const compP = add(f.compound);
      where.push(
        `(normalize_arabic(coalesce(l.compound, '')) LIKE '%' || normalize_arabic(${compP}) || '%' OR normalize_arabic(coalesce(l.title, '')) LIKE '%' || normalize_arabic(${compP}) || '%')`
      );
    }

    // 4. Currency
    if (f.currency) {
      where.push(
        `coalesce(l.details->>'currency', 'EGP') = ${add(f.currency)}`
      );
    }

    // 5. Strict Bedrooms (exact matching when min == max)
    if (
      f.bedrooms_min != null &&
      f.bedrooms_max != null &&
      f.bedrooms_min === f.bedrooms_max
    ) {
      where.push(`l.bedrooms = ${add(f.bedrooms_min)}`);
    } else {
      if (f.bedrooms_min != null)
        where.push(`l.bedrooms >= ${add(f.bedrooms_min)}`);
      if (f.bedrooms_max != null)
        where.push(`l.bedrooms <= ${add(f.bedrooms_max)}`);
    }

    // 6. Bathrooms
    if (f.bathrooms_min != null) {
      where.push(
        `coalesce((l.details->>'bathrooms')::numeric, 0) >= ${add(
          f.bathrooms_min
        )}`
      );
    }

    // 7. Strict Floor Handling (Roof, Ground, Penthouse)
    if (f.floor) {
      const isRoof = /روف|سطح|roof|penthouse|بنتهاوس/i.test(f.floor);
      const isGround = /أرضي|ارضي|ground/i.test(f.floor);

      if (isRoof) {
        where.push(
          `(l.property_type = 'penthouse' OR normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%روف%' OR normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%اخير%' OR normalize_arabic(coalesce(l.details->>'floor_en', '')) LIKE '%roof%' OR normalize_arabic(coalesce(l.details->>'floor_en', '')) LIKE '%penthouse%' OR normalize_arabic(coalesce(l.search_text_normalized, '')) LIKE '%روف%')`
        );
      } else if (isGround) {
        where.push(
          `(normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%ارضي%' OR normalize_arabic(coalesce(l.details->>'floor_en', '')) LIKE '%ground%')`
        );
      } else {
        const floorP = add(f.floor);
        where.push(
          `(normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%' || normalize_arabic(${floorP}) || '%' OR normalize_arabic(coalesce(l.details->>'floor_en', '')) LIKE '%' || normalize_arabic(${floorP}) || '%')`
        );
      }
    }

    // 8. Strict Elevated Specs: Master Bedroom, Dressing Room, Nanny Room
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
      where.push(`coalesce((l.details->>'nanny_room')::boolean, false) = true`);
    }

    // 9. Strict Finishing
    if (f.finishing) {
      const finP = add(f.finishing);
      where.push(
        `(normalize_arabic(coalesce(l.details->>'finishing', '')) LIKE '%' || normalize_arabic(${finP}) || '%' OR normalize_arabic(coalesce(l.details->>'finishing_en', '')) LIKE '%' || normalize_arabic(${finP}) || '%')`
      );
    }

    // 10. Strict Price & Area Bounds
    if (f.price_min != null) where.push(`l.price_value >= ${add(f.price_min)}`);
    if (f.price_max != null) where.push(`l.price_value <= ${add(f.price_max)}`);
    if (f.area_min != null) where.push(`l.area_value >= ${add(f.area_min)}`);
    if (f.area_max != null) where.push(`l.area_value <= ${add(f.area_max)}`);

    // 11. Strict Multi-Amenity Match (AND between all requested amenities)
    if (f.features && f.features.length) {
      for (const feat of f.features) {
        if (/روف|roof/i.test(feat)) {
          where.push(
            `(l.property_type = 'penthouse' OR normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%روف%' OR normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%اخير%' OR normalize_arabic(coalesce(l.details->>'floor_en', '')) LIKE '%roof%' OR normalize_arabic(coalesce(l.details->>'floor_en', '')) LIKE '%penthouse%' OR normalize_arabic(coalesce(l.search_text_normalized, '')) LIKE '%روف%')`
          );
        } else {
          const synonyms = expandAmenitySynonyms(feat);
          const subChecks = synonyms.map((syn) => {
            const pIdx = add(syn);
            return `(normalize_arabic(coalesce(l.title,'') || ' ' || coalesce(l.details::text,'') || ' ' || coalesce(l.search_text_normalized,'')) LIKE '%' || normalize_arabic(${pIdx}) || '%')`;
          });
          where.push(`(${subChecks.join(" OR ")})`);
        }
      }
    }
  }

  // 12. Geographic Ranking
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
              `(l.search_text_normalized LIKE '%' || normalize_arabic(${i}) || '%' OR normalize_arabic(${i}) <% l.search_text_normalized)`
          )
          .join(" OR ") +
        ")"
    );
    score = `GREATEST(${idx
      .map(
        (i) =>
          `word_similarity(normalize_arabic(${i}), l.search_text_normalized)`
      )
      .join(", ")}) DESC NULLS LAST,`;
  }

  const limitP = add(limit);
  const offsetP = add(offset);
  const sql = `
    SELECT l.id, l.code, l.title, l.property_type, l.listing_type, l.status, l.price_value, l.price_display,
           l.area_value, l.bedrooms, l.location, l.compound, l.details, COUNT(*) OVER() AS total_count
    FROM listings l
    WHERE ${where.join(" AND ")}
    ORDER BY ${score} l.created_at DESC, l.id DESC
    LIMIT ${limitP} OFFSET ${offsetP}`;

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Fallback Parser
// ---------------------------------------------------------------------------
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
  const tokens = normalizeTerm(text).split(" ").filter(Boolean);
  const types = new Set();
  const terms = [];

  for (const t of tokens) {
    if (TYPE_WORDS[t]) types.add(TYPE_WORDS[t]);
    else if (!STOP.has(t) && !/^\d+$/.test(t) && t.length >= 3) terms.push(t);
  }

  const phrase = terms.join(" ");
  return normalizeParsed({
    intent: "search",
    transcript: String(text || ""),
    filters: { property_types: [...types] },
    locations: phrase ? [phrase] : [],
    location_terms: [phrase, ...terms].filter(Boolean)
  });
}

// ---------------------------------------------------------------------------
// Presentation Helpers
// ---------------------------------------------------------------------------
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
  if (f.finishing) bits.push(`تشطيب: ${f.finishing}`);

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
  } else if (f.price_min != null) {
    bits.push(`من ${T.formatPrice(f.price_min, "ar", f.currency || "EGP")}`);
  }

  bits.push(range(f.area_min, f.area_max, "م²"));
  if (f.floor) bits.push(`الدور: ${f.floor}`);
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

// ---------------------------------------------------------------------------
// Gemini Invocations
// ---------------------------------------------------------------------------
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timeout`)), ms)
    )
  ]);

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

  const response = await aiShim.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", temperature: 0 }
  });

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
  const response = await withTimeout(
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
