// lib/search.js
// AI-assisted inventory search for the WhatsApp broker bot.
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
  villa: "فيلا",
  townhouse: "تاون هاوس",
  twinhouse: "توين هاوس",
  duplex: "دوبلكس",
  penthouse: "بنتهاوس",
  studio: "استوديو",
  chalet: "شاليه",
  office: "مكتب",
  commercial: "تجاري"
};

const ACRONYMS = {
  mv: ["ماونتن فيو", "mountain view"],
  icity: ["اي سيتي", "i-city"],
  ph: ["بالم هيلز", "palm hills"],
  sodic: ["سوديك"],
  zed: ["زد", "sawiris"],
  marassi: ["مراسي", "سيدي عبد الرحمن"]
};

const MAX_TERMS = 14;
const MAX_KEYWORDS = 16;

// Generic tokens that must NEVER be used alone as location terms
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

const cleanJson = (t) =>
  String(t || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const SEARCH_PROMPT = `You are the search-understanding layer of a WhatsApp real-estate inventory bot used by Egyptian brokers.
The broker writes or records a voice note (Egyptian Arabic, Franco-Arab such as "3ayez sha2a fel tagamo3", or English). Transcribe any audio first.

Return ONE JSON object:
{
  "intent": "search" | "listing" | "other",
  "transcript": "text of the voice note, or the message as written",
  "language": "ar" | "en",
  "filters": {
    "listing_type": "sale" | "rent" | null,
    "property_types": [ any of: ${PROPERTY_TYPES.join(", ")} ],
    "price_min": number in EGP or null,
    "price_max": number in EGP or null,
    "area_min": number in square meters or null,
    "area_max": number in square meters or null,
    "bedrooms_min": integer or null,
    "bedrooms_max": integer or null,
    "bathrooms_min": integer or null,
    "floor": "ground" | "typical" | "last" | "penthouse" | string or null,
    "features": [ short feature words requested, e.g. "حمام سباحة", "حديقة", "روف", "ناني روم", "أسانسير", "فيو" ],
    "code": "unit code if the broker asked for a specific code, else null"
  },
  "locations": [ every specific place the broker mentioned, exactly as said ],
  "location_terms": [ up to ${MAX_TERMS} search terms, strictly adhering to the location rules ]
}

Intent rules:
- "search": the broker is asking for / looking for / inquiring about units in inventory ("عايز", "محتاج", "فيه", "عندنا", "وريني", "دورلي", "show me", "looking for", "do we have").
- "listing": the broker is clearly describing ONE specific unit they want to ADD/REGISTER (stating its price, area, finishing as facts, offering it for sale).
- "other": greetings, thanks, or general conversation. If unsure between search and listing, choose "search".

CRITICAL Geographic & Disambiguation Rules:
- NEVER output generic parent words like "القاهرة", "cairo", "الجيزة", or "giza" in location_terms.
- STRICT DISTINCTION: "القاهرة الجديدة" / "New Cairo" / "التجمع" is completely distinct from "أبتاون كايرو" / "Uptown Cairo" (Mokattam).
  - If the broker asks for "القاهرة الجديدة" or "التجمع": location_terms MUST include ["القاهرة الجديدة", "new cairo", "التجمع", "التجمع الخامس", "5th settlement", "المربع الذهبي", "golden square"] and famous compounds inside New Cairo (e.g. "ميفيدا", "mivida"). NEVER include "ابتاون" or bare "كايرو".
  - If the broker asks for "أبتاون كايرو" / "Uptown Cairo": location_terms MUST be ["ابتاون كايرو", "أبتاون كايرو", "uptown cairo", "uptown", "المقطم"]. NEVER add "القاهرة الجديدة" or "التجمع".
- For a specific compound (e.g. "ميفيدا", "بادية", "زد"): return only its variations and spellings, not unrelated projects.
- Sub-markets (e.g. "المربع الذهبي", "بيت الوطن", "المستثمرين"): preserve them as explicit search terms.

Number rules:
- "تحت 7 مليون", "لحد 7 مليون", "ميزانيتي 7 مليون" -> price_max 7000000.
- "من 5 لـ 7 مليون" -> price_min 5000000, price_max 7000000.
- "حوالي 150 متر" -> area_min 135, area_max 165. "150 متر" -> area_min 150, area_max 150.
- "3 غرف" -> bedrooms_min 3, bedrooms_max 3. "3 غرف فأكتر" -> bedrooms_min 3, bedrooms_max null.
- "حمامين" -> bathrooms_min 2.
- Never invent a filter the broker did not say; use null or [].`;

const ENRICH_PROMPT = `You enrich the geographic metadata of an Egyptian real-estate listing so buyers can find it accurately.
Input is the listing's stated location, title, and text description. Return ONE JSON object:
{
  "compound": "compound / project name in Arabic, or null",
  "district": "district in Arabic (e.g. التجمع الخامس, المربع الذهبي, الشيخ زايد, مدينة نصر), or null",
  "city": "city / region in Arabic (e.g. القاهرة الجديدة, 6 أكتوبر, الساحل الشمالي, المقطم), or null",
  "location_keywords": [ up to ${MAX_KEYWORDS} targeted names someone might type to find this unit: compound, sub-district (like المربع الذهبي), district, and city in Arabic AND English/Franco spellings, common misspellings, developer name if famous ],
  "basis": "stated" | "inferred"
}

Rules:
- Never add bare "القاهرة" or "cairo" alone into location_keywords. Always use the full city name (e.g. "القاهرة الجديدة", "new cairo").
- If the project is Uptown Cairo, city is "المقطم" or "أبتاون كايرو", NEVER "القاهرة الجديدة".
- Fill parent areas ONLY when 100% confident based on official Egyptian geography. If unsure, use null. Never guess.`;

// ---------------------------------------------------------------------------
// Normalization helpers (pure)
// ---------------------------------------------------------------------------
const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

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
    features: normalizeKeywords(f.features, 6),
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

  const terms = normalizeKeywords(
    [
      ...rawLocations,
      ...(Array.isArray(r.location_terms) ? r.location_terms : [])
    ],
    MAX_TERMS
  ).filter((term) => !BANNED_GENERIC_LOCATION_TERMS.has(term));

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
      (p.location_terms && p.location_terms.length) ||
      (f.features && f.features.length) ||
      f.listing_type ||
      (f.property_types && f.property_types.length) ||
      f.price_min != null ||
      f.price_max != null ||
      f.area_min != null ||
      f.area_max != null ||
      f.bedrooms_min != null ||
      f.bedrooms_max != null ||
      f.bathrooms_min != null ||
      f.floor != null
  );
}

// ---------------------------------------------------------------------------
// SQL builder: matches the hardened schema & active status
// ---------------------------------------------------------------------------
function buildSearchQuery(
  agencyId,
  parsed,
  { relaxed = false, limit = 10, offset = 0 } = {}
) {
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
    if (f.listing_type) where.push(`l.listing_type = ${add(f.listing_type)}`);
    if (f.property_types && f.property_types.length) {
      where.push(`l.property_type = ANY(${add(f.property_types)}::text[])`);
    }

    if (f.bedrooms_min != null)
      where.push(`l.bedrooms >= ${add(f.bedrooms_min)}`);
    if (f.bedrooms_max != null)
      where.push(`l.bedrooms <= ${add(f.bedrooms_max)}`);

    if (f.bathrooms_min != null) {
      where.push(
        `coalesce((l.details->>'bathrooms')::numeric, 0) >= ${add(
          f.bathrooms_min
        )}`
      );
    }

    if (f.floor && !relaxed) {
      where.push(
        `normalize_arabic(coalesce(l.details->>'floor', '')) LIKE '%' || normalize_arabic(${add(
          f.floor
        )}) || '%'`
      );
    }

    const lo = (v, k) => Math.round(v * (relaxed ? k : 1));
    if (f.price_min != null)
      where.push(`l.price_value >= ${add(lo(f.price_min, 0.85))}`);
    if (f.price_max != null)
      where.push(`l.price_value <= ${add(lo(f.price_max, 1.15))}`);
    if (f.area_min != null)
      where.push(`l.area_value >= ${add(lo(f.area_min, 0.9))}`);
    if (f.area_max != null)
      where.push(`l.area_value <= ${add(lo(f.area_max, 1.1))}`);

    if (!relaxed && f.features && f.features.length) {
      for (const feat of f.features) {
        where.push(
          `normalize_arabic(coalesce(l.title,'') || ' ' || coalesce(l.details::text,'')) LIKE '%' || normalize_arabic(${add(
            feat
          )}) || '%'`
        );
      }
    }
  }

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
    SELECT l.id, l.code, l.title, l.property_type, l.listing_type, l.price_value, l.price_display,
           l.area_value, l.bedrooms, l.location, l.compound, l.details, COUNT(*) OVER() AS total_count
    FROM listings l
    WHERE ${where.join(" AND ")}
    ORDER BY ${score} l.created_at DESC, l.id DESC
    LIMIT ${limitP} OFFSET ${offsetP}`;

  return { sql, params };
}

// ---------------------------------------------------------------------------
// Fallback when Gemini is unavailable
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
// Presentation & Cost
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
  if (Array.isArray(p.locations) && p.locations.length)
    bits.push(p.locations.join("، "));

  bits.push(range(f.bedrooms_min, f.bedrooms_max, "غرف"));
  if (f.bathrooms_min != null) bits.push(`${f.bathrooms_min}+ حمام`);

  if (f.price_min != null && f.price_max != null) {
    bits.push(`${T.formatPrice(f.price_min)} - ${T.formatPrice(f.price_max)}`);
  } else if (f.price_max != null) {
    bits.push(`حتى ${T.formatPrice(f.price_max)}`);
  } else if (f.price_min != null) {
    bits.push(`من ${T.formatPrice(f.price_min)}`);
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
  normalizeKeywords,
  normalizeParsed,
  hasAnyFilter,
  buildSearchQuery,
  fallbackParse,
  formatInterpretation,
  estimateCostUsd,
  parseSearchRequest,
  enrichLocation
};
