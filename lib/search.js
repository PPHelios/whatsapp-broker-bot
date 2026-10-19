// lib/search.js
// AI-assisted inventory search for the WhatsApp broker bot.
//
// Idea: Gemini UNDERSTANDS the request (text or voice, Egyptian Arabic / Franco / English) and
// returns structured filters + place-name variants. Matching itself is deterministic SQL against
// location keywords that were stored when the listing was created, so results are fast, cheap and
// explainable. Gemini never reads the whole inventory.

const T = require('./text');

const PROPERTY_TYPES = [
  'apartment', 'villa', 'townhouse', 'twinhouse', 'duplex', 'penthouse', 'studio', 'chalet', 'office', 'commercial',
];
const TYPE_AR = {
  apartment: 'شقة', villa: 'فيلا', townhouse: 'تاون هاوس', twinhouse: 'توين هاوس', duplex: 'دوبلكس',
  penthouse: 'بنتهاوس', studio: 'استوديو', chalet: 'شاليه', office: 'مكتب', commercial: 'تجاري',
};
const MAX_TERMS = 14;
const MAX_KEYWORDS = 16;

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
    "property_types": [ any of: ${PROPERTY_TYPES.join(', ')} ],
    "price_min": number in EGP or null,
    "price_max": number in EGP or null,
    "area_min": number in square meters or null,
    "area_max": number in square meters or null,
    "bedrooms_min": integer or null,
    "bedrooms_max": integer or null,
    "features": [ short feature words the broker asked for, e.g. "حمام سباحة", "جاردن", "فيو" ],
    "code": "unit code if the broker asked for a specific code, else null"
  },
  "locations": [ every place the broker mentioned, as said ],
  "location_terms": [ up to ${MAX_TERMS} search terms, see rules ]
}

Intent rules:
- "search": the broker is asking for / looking for / asking about units we have ("عايز", "محتاج", "فيه", "عندنا", "ورّيني", "دورلي", "show me", "do we have").
- "listing": the broker is clearly describing ONE specific unit they want to ADD (stating its price, area, finishing as facts, offering it for sale).
- "other": greetings, thanks, or anything else. If unsure between search and listing, choose "search".

Location rules (very important):
- location_terms must contain ONLY names for the SAME place the broker asked about: its Arabic spellings, common misspellings, English and Franco spellings, official and popular names, plus the well-known compounds/projects located INSIDE that place (at most 8).
- Do NOT add a larger parent area. Example: for "التجمع الخامس" return ["التجمع الخامس", "5th settlement", "fifth settlement", "tagamoa khames", "ميفيدا", "mivida", ...compounds located in it]. Do NOT add "القاهرة الجديدة" unless the broker asked for it, and never add generic words like "التجمع" alone.
- For a compound such as "ميفيدا" return its spellings (ميفيدا, ميفدا, mivida), not the district.
- Only include compounds you are highly confident are inside that place. If unsure, leave them out.

Number rules:
- "تحت 7 مليون", "لحد 7 مليون", "ميزانيتي 7 مليون" -> price_max 7000000.
- "من 5 لـ 7 مليون" -> price_min 5000000, price_max 7000000.
- "حوالي 150 متر" -> area_min 135, area_max 165. "150 متر" -> area_min 150, area_max 150.
- "3 غرف" -> bedrooms_min 3, bedrooms_max 3. "3 غرف فأكتر" -> bedrooms_min 3, bedrooms_max null.
- Never invent a filter the broker did not say; use null or [].`;

const ENRICH_PROMPT = `You enrich the location of an Egyptian real-estate listing so buyers can find it by any common name.
Input is the listing's stated location and text. Return ONE JSON object:
{
  "compound": "compound / project name in Arabic, or null",
  "district": "district in Arabic (e.g. التجمع الخامس, الشيخ زايد, مدينة نصر), or null",
  "city": "city / region in Arabic (e.g. القاهرة الجديدة, 6 أكتوبر, الساحل الشمالي), or null",
  "location_keywords": [ up to ${MAX_KEYWORDS} names someone might type to find this unit: compound, district and city in Arabic AND English/Franco spellings, common misspellings, developer name if known ],
  "basis": "stated" | "inferred"
}
Rules: use what the text states. Fill a parent (district/city) from your own knowledge ONLY when you are highly confident (for example a famous compound's district) and then set basis "inferred". If unsure, use null. Never guess.`;

// ---------------------------------------------------------------------------
// Normalization helpers (pure)
// ---------------------------------------------------------------------------
const escapeLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

function normalizeTerm(t) {
  return T.normalizeAr(String(t ?? ''))
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Used both for listing keywords at creation time and for search terms
function normalizeKeywords(list, max = MAX_KEYWORDS) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTerm(raw);
    if (t.length >= 3 && t.length <= 40 && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

const posNum = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const money = (v) => {
  if (typeof v === 'number') return posNum(v);
  return T.parsePrice(String(v ?? ''), { implicitUnits: true }) ?? posNum(v);
};

function normalizeParsed(raw) {
  const r = (Array.isArray(raw) ? raw[0] : raw) || {};
  const f = r.filters || {};
  const types = new Set();
  for (const t of Array.isArray(f.property_types) ? f.property_types : []) {
    const k = String(t).toLowerCase().replace(/[\s_-]/g, '');
    if (PROPERTY_TYPES.includes(k)) types.add(k);
  }
  const filters = {
    listing_type: ['sale', 'rent'].includes(f.listing_type) ? f.listing_type : null,
    property_types: [...types],
    price_min: money(f.price_min),
    price_max: money(f.price_max),
    area_min: posNum(f.area_min),
    area_max: posNum(f.area_max),
    bedrooms_min: posNum(f.bedrooms_min) ? Math.round(posNum(f.bedrooms_min)) : null,
    bedrooms_max: posNum(f.bedrooms_max) ? Math.round(posNum(f.bedrooms_max)) : null,
    features: normalizeKeywords(f.features, 6),
    code: f.code ? String(f.code).trim().replace(/^#/, '').slice(0, 30) || null : null,
  };
  for (const [lo, hi] of [['price_min', 'price_max'], ['area_min', 'area_max'], ['bedrooms_min', 'bedrooms_max']]) {
    if (filters[lo] != null && filters[hi] != null && filters[lo] > filters[hi]) {
      [filters[lo], filters[hi]] = [filters[hi], filters[lo]];
    }
  }
  const locations = (Array.isArray(r.locations) ? r.locations : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 4);
  // The places as said are always searched, even if the model forgot to repeat them in location_terms
  const terms = normalizeKeywords([...locations, ...(Array.isArray(r.location_terms) ? r.location_terms : [])], MAX_TERMS);
  return {
    intent: ['search', 'listing', 'other'].includes(r.intent) ? r.intent : 'search',
    transcript: String(r.transcript ?? '').slice(0, 500),
    language: r.language === 'en' ? 'en' : 'ar',
    filters,
    locations,
    location_terms: terms,
  };
}

function hasAnyFilter(p) {
  const f = p.filters;
  return Boolean(
    f.code || p.location_terms.length || f.listing_type || f.property_types.length ||
    f.price_min != null || f.price_max != null || f.area_min != null || f.area_max != null ||
    f.bedrooms_min != null || f.bedrooms_max != null
  );
}

// ---------------------------------------------------------------------------
// SQL builder (pure, parameterized: nothing from the model is concatenated into SQL)
// ---------------------------------------------------------------------------
function buildSearchQuery(agencyId, p, { relaxed = false, limit = 8 } = {}) {
  const f = p.filters;
  const params = [agencyId];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['l.agency_id = $1', `l.status = 'active'`];
  let score = '0';

  if (f.code) {
    where.push(`lower(l.code) = lower(${add(f.code)})`);
  } else {
    if (f.listing_type) where.push(`l.listing_type = ${add(f.listing_type)}`);

    if (f.property_types.length) {
      const types = new Set(f.property_types);
      if (types.has('twinhouse')) types.add('twin_house');
      where.push(`l.property_type = ANY(${add([...types])}::text[])`);
    }

    const widen = (v, factor) => (relaxed && v != null ? Math.round(v * factor) : v);
    const pMin = widen(f.price_min, 0.85);
    const pMax = widen(f.price_max, 1.15);
    const aMin = widen(f.area_min, 0.85);
    const aMax = widen(f.area_max, 1.15);
    if (pMin != null) where.push(`l.price_value >= ${add(pMin)}`);
    if (pMax != null) where.push(`l.price_value <= ${add(pMax)}`);
    if (aMin != null) where.push(`l.area_value >= ${add(aMin)}`);
    if (aMax != null) where.push(`l.area_value <= ${add(aMax)}`);

    const bMin = relaxed && f.bedrooms_min != null ? Math.max(1, f.bedrooms_min - 1) : f.bedrooms_min;
    const bMax = relaxed && f.bedrooms_max != null ? f.bedrooms_max + 1 : f.bedrooms_max;
    if (bMin != null) where.push(`l.bedrooms >= ${add(bMin)}`);
    if (bMax != null) where.push(`l.bedrooms <= ${add(bMax)}`);

    if (p.location_terms.length) {
      const kw = add(p.location_terms);
      const pats = add(p.location_terms.map((t) => `%${escapeLike(t)}%`));
      where.push(`(l.location_keywords && ${kw}::text[] OR l.search_text ILIKE ANY(${pats}::text[]))`);
      score = `(CASE WHEN l.location_keywords && ${kw}::text[] THEN 2 ELSE 1 END)`;
    }
    if (f.features.length) {
      const fp = add(f.features.map((t) => `%${escapeLike(t)}%`));
      score += ` + (CASE WHEN l.search_text ILIKE ANY(${fp}::text[]) THEN 1 ELSE 0 END)`; // soft boost, never a hard filter
    }
  }

  const sql = `SELECT l.code, l.title, l.price_display, l.price_value, l.area_value, l.bedrooms,
       l.location, l.property_type, l.listing_type
  FROM listings l
 WHERE ${where.join('\n   AND ')}
 ORDER BY (${score}) DESC, l.created_at DESC
 LIMIT ${Math.max(1, Math.min(20, Number(limit) || 8))}`;
  return { sql, params };
}

// ---------------------------------------------------------------------------
// Fallback when Gemini is unavailable: plain keyword search, stop words removed, OR semantics
// ---------------------------------------------------------------------------
const STOP = new Set(
  ['في', 'فى', 'من', 'الى', 'إلى', 'علي', 'على', 'عن', 'و', 'عايز', 'عاوز', 'عايزه', 'محتاج', 'دورلي', 'ورني', 'وريني',
    'فيه', 'عندنا', 'عندك', 'بحث', 'ابحث', 'لي', 'لو', 'سمحت', 'the', 'a', 'in', 'for', 'show', 'me', 'find', 'search', 'i', 'want', 'need']
    .map(normalizeTerm)
);
const TYPE_WORDS = {
  شقه: 'apartment', شقق: 'apartment', apartment: 'apartment', فيلا: 'villa', فيلات: 'villa', villa: 'villa',
  دوبلكس: 'duplex', duplex: 'duplex', بنتهاوس: 'penthouse', penthouse: 'penthouse', استوديو: 'studio', studio: 'studio',
  شاليه: 'chalet', chalet: 'chalet', مكتب: 'office', office: 'office', تاون: 'townhouse', توين: 'twinhouse',
};

function fallbackParse(text) {
  const tokens = normalizeTerm(text).split(' ').filter(Boolean);
  const types = new Set();
  const terms = [];
  for (const t of tokens) {
    if (TYPE_WORDS[t]) types.add(TYPE_WORDS[t]);
    else if (!STOP.has(t) && !/^\d+$/.test(t) && t.length >= 3) terms.push(t);
  }
  const phrase = terms.join(' ');
  return normalizeParsed({
    intent: 'search',
    transcript: String(text || ''),
    filters: { property_types: [...types] },
    locations: phrase ? [phrase] : [],
    location_terms: [phrase, ...terms].filter(Boolean),
  });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------
const range = (min, max, unit) => {
  if (min != null && max != null) return min === max ? `${min} ${unit}` : `${min}-${max} ${unit}`;
  if (min != null) return `${min}+ ${unit}`;
  if (max != null) return `حتى ${max} ${unit}`;
  return '';
};

function formatInterpretation(p) {
  const f = p.filters;
  const bits = [];
  if (f.property_types.length) bits.push(f.property_types.map((t) => TYPE_AR[t] || t).join(' / '));
  if (f.listing_type) bits.push(f.listing_type === 'rent' ? 'للإيجار' : 'للبيع');
  if (p.locations.length) bits.push(p.locations.join('، '));
  bits.push(range(f.bedrooms_min, f.bedrooms_max, 'غرف'));
  if (f.price_min != null && f.price_max != null) bits.push(`${T.formatPrice(f.price_min)} - ${T.formatPrice(f.price_max)}`);
  else if (f.price_max != null) bits.push(`حتى ${T.formatPrice(f.price_max)}`);
  else if (f.price_min != null) bits.push(`من ${T.formatPrice(f.price_min)}`);
  bits.push(range(f.area_min, f.area_max, 'م²'));
  if (f.features.length) bits.push(f.features.join('، '));
  if (f.code) bits.push(`كود ${f.code}`);
  return bits.filter(Boolean).join(' • ');
}

function estimateCostUsd(usage, { inPerM = 0, outPerM = 0 } = {}) {
  return Number((((usage.input || 0) * inPerM + (usage.output || 0) * outPerM) / 1e6).toFixed(6));
}

// ---------------------------------------------------------------------------
// Gemini calls
// ---------------------------------------------------------------------------
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms))]);

const cleanMime = (m) => String(m || 'audio/ogg').split(';')[0].trim() || 'audio/ogg';

async function parseSearchRequest(ai, { text = '', audio = [], model, timeoutMs = 20000 }) {
  const parts = [
    { text: SEARCH_PROMPT + (text.trim() ? `\n\nMessage: "${text.trim()}"` : '') },
    ...audio.map((a) => ({ inlineData: { data: a.buffer.toString('base64'), mimeType: cleanMime(a.mimeType) } })),
  ];
  const response = await withTimeout(
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0 },
    }),
    timeoutMs,
    'gemini-search'
  );
  const usage = {
    input: response.usageMetadata?.promptTokenCount || 0,
    output: response.usageMetadata?.candidatesTokenCount || 0,
  };
  return { parsed: normalizeParsed(JSON.parse(response.text)), usage };
}

// Used by the backfill script for listings created before location keywords existed
async function enrichLocation(ai, { location = '', title = '', rawText = '', model, timeoutMs = 20000 }) {
  const response = await withTimeout(
    ai.models.generateContent({
      model,
      contents: [{
        role: 'user',
        parts: [{ text: `${ENRICH_PROMPT}\n\nLocation: ${location}\nTitle: ${title}\nText: ${String(rawText).slice(0, 600)}` }],
      }],
      config: { responseMimeType: 'application/json', temperature: 0 },
    }),
    timeoutMs,
    'gemini-enrich'
  );
  const r = JSON.parse(response.text) || {};
  const s = (v) => (v ? String(v).trim().slice(0, 80) : null);
  return {
    compound: s(r.compound),
    district: s(r.district),
    city: s(r.city),
    keywords: normalizeKeywords([r.compound, r.district, r.city, location, ...(r.location_keywords || [])]),
    basis: r.basis === 'inferred' ? 'inferred' : 'stated',
    usage: {
      input: response.usageMetadata?.promptTokenCount || 0,
      output: response.usageMetadata?.candidatesTokenCount || 0,
    },
  };
}

module.exports = {
  PROPERTY_TYPES, TYPE_AR, SEARCH_PROMPT, ENRICH_PROMPT,
  normalizeKeywords, normalizeParsed, hasAnyFilter, buildSearchQuery, fallbackParse,
  formatInterpretation, estimateCostUsd, parseSearchRequest, enrichLocation,
};
