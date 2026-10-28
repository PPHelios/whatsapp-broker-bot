// lib/search.js — WhatsApp search adapter: one search service, one result template, id-snapshot paging
"use strict";

const U = require("./util");
const Config = require("../config");
const Q = require("../domain/searchQuery");
const Places = require("../domain/places");
const Features = require("../domain/features");
const Describe = require("../domain/describe");
const { normalizeSearch } = require("../domain/searchText");
const { PROPERTY_TYPES } = require("../domain/fieldRules");
const Search = require("../services/search");
const Links = require("./links");
const SearchLink = require("../domain/searchLink");
const { reply, replyButtons, replyAlbum } = require("./dispatcher");

const TYPE_AR = Object.fromEntries(Object.entries(Describe.TYPE_LABELS).map(([k, v]) => [k, v[0]]));
const MAX_KEYWORDS = 16;
const SEARCH_PROMPT = Search.SEARCH_PROMPT("(see services/search.js)");

const BANNED_GENERIC_LOCATION_TERMS = new Set(["القاهره", "القاهرة", "cairo", "مصر", "egypt", "الجيزه", "الجيزة", "giza"]);

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

const ENRICH_PROMPT = `You enrich the geographic metadata of an Egyptian real-estate listing so buyers can find it accurately.
Input is the listing's stated location, title, and text description. Return ONE JSON object:
{
  "compound": "compound / project name in Arabic, or null",
  "district": "district in Arabic (e.g. التجمع الخامس, المربع الذهبي, الشيخ زايد), or null",
  "city": "city / region in Arabic (e.g. القاهرة الجديدة, 6 أكتوبر), or null",
  "location_keywords": [ up to ${MAX_KEYWORDS} targeted names someone might type to find this unit ],
  "basis": "stated" | "inferred"
}`;


/** One normalizer for search text (domain/searchText.js). */
const normalizeTerm = (t) => normalizeSearch(t);

function normalizeKeywords(list, max = MAX_KEYWORDS) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTerm(raw);
    if (t.length >= 2 && t.length <= 40 && !BANNED_GENERIC_LOCATION_TERMS.has(t) && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** AI search JSON → language-neutral filters (domain/searchQuery.js). */
const normalizeParsed = (raw) => Q.normalizeAiSearch(raw);
const hasAnyFilter = Q.hasAnyFilter;
const fallbackParse = Q.fallbackParse;
const buildSearchQuery = (agencyId, parsed, opts = {}) => Search.buildSearchQuery(agencyId, parsed, { limit: 5, ...opts });

/** Cost of a search parse from configured model prices (config.js). */
function estimateCostUsd(usage, model = "default") {
  const u = usage || {};
  return Config.estimateCostUsd(model, u.input || 0, u.output || 0);
}

/** Parses a request through the AI gateway (fallback parser on failure). */
async function parseSearchRequest(aiShim, { text = "", ctx = {} } = {}) {
  const r = await Search.parseRequest(aiShim, { text, ctx });
  return {
    parsed: r.parsed,
    usage: { input: r.usage?.promptTokenCount || 0, output: r.usage?.candidatesTokenCount || 0 },
    modelUsed: r.modelUsed
  };
}

/** Human summary of what was searched for ("شقة · ماونتن فيو · 3 غرف · بحري"). */
function formatInterpretation(parsed, lang = "ar") {
  const f = Q.ensureFilters(parsed?.filters ? parsed : { filters: parsed || {} });
  const en = lang === "en";
  const bits = [];
  if (f.code) bits.push(`#${f.code}`);
  if (f.property_types.length) bits.push(f.property_types.map((t) => Describe.typeLabel({ property_type: t }, lang)).join(" / "));
  if (f.listing_type) bits.push(f.listing_type === "rent" ? (en ? "rent" : "إيجار") : en ? "sale" : "بيع");
  if (f.market) bits.push(f.market === "primary" ? (en ? "primary" : "برايمري") : en ? "resale" : "ريسيل");
  for (const p of f.places) bits.push(Places.placeName(p.kind, p.key)?.[en ? "en" : "ar"] || p.key);
  bits.push(...f.place_terms);
  if (f.bedrooms_min !== null && f.bedrooms_min === f.bedrooms_max && f.bedrooms_min > 0) bits.push(en ? `${f.bedrooms_min} beds` : `${f.bedrooms_min} غرف`);
  else if (f.bedrooms_min) bits.push(en ? `${f.bedrooms_min}+ beds` : `${f.bedrooms_min}+ غرف`);
  if (f.bathrooms_min) bits.push(en ? `${f.bathrooms_min}+ baths` : `${f.bathrooms_min}+ حمام`);
  if (f.price_max) bits.push(`${en ? "up to" : "حتى"} ${Describe.money(f.price_max, lang, f.currency || "EGP")}`);
  if (f.price_min) bits.push(`${en ? "from" : "من"} ${Describe.money(f.price_min, lang, f.currency || "EGP")}`);
  if (f.area_min || f.area_max) bits.push(`${f.area_min || ""}${f.area_min && f.area_max ? "-" : ""}${f.area_max || ""}${en ? "m²" : "م"}`);
  if (f.delivery_ready) bits.push(en ? "ready to move" : "استلام فوري");
  if (f.delivery_by_year) bits.push(`${en ? "delivery by" : "تسليم قبل"} ${f.delivery_by_year}`);
  if (f.payment_cash) bits.push(en ? "cash" : "كاش");
  if (f.payment_installments) bits.push(en ? "installments" : "تقسيط");
  if (f.max_down_payment) bits.push(`${en ? "down ≤" : "مقدم حتى"} ${Describe.money(f.max_down_payment, lang)}`);
  if (f.max_installment) bits.push(`${en ? "installment ≤" : "قسط حتى"} ${Describe.money(f.max_installment, lang)}`);
  bits.push(...f.features.map((k) => Features.featureLabel(k, lang)));
  bits.push(...f.feature_terms);
  return bits.filter(Boolean).join(" · ");
}

async function enrichLocation(
  aiShim,
  {
    location = "",
    title = "",
    rawText = "",
    model = "gemini-3.5-flash-lite",
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
    model_used = "gemini-3.5-flash-lite",
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

/** "Refine and see all" on the web: the same filters, no second AI call. */
function webLine(filters, lang) {
  return `🌐 ${lang === "en" ? "Refine & see all" : "عدّل البحث وشوف كل النتائج"}: ${Links.searchUrl(SearchLink.encodeFilters(filters))}`;
}

const moreButton = (lang) => [{ id: "MORE_SEARCH", title: lang === "en" ? "More ➡️" : "المزيد ➡️" }];

async function saveSnapshot(pool, brokerId, state) {
  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, 'search_state', $2::jsonb, NOW() + INTERVAL '30 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = EXCLUDED.session_data,
       expires_at = EXCLUDED.expires_at`,
    [brokerId, JSON.stringify(state)]
  );
}

/**
 * F5: on Telegram, one button per result ("1. CODE") that opens the unit's album and card (photos only come with a
 * unit, not above the list). WhatsApp keeps text only (3 buttons at most there; the code can be sent instead).
 */
function resultButtons(broker, rows, offset = 0) {
  if (broker?.channel !== "telegram") return [];
  return rows.map((r, i) => ({ id: `open:${r.code}`, title: `${offset + i + 1}. ${r.code}` }));
}

/** The results message with its buttons (result buttons on Telegram, then More when there are more). */
async function sendResults(broker, body, rows, offset, more, lang) {
  const buttons = [...resultButtons(broker, rows, offset), ...(more ? moreButton(lang) : [])];
  if (buttons.length) await replyButtons(broker, body, buttons);
  else await reply(broker, body);
}

/** Units per results message: more on Telegram, where messages are free. */
const pageSizeFor = (broker) => (broker?.channel === "telegram" ? Search.TG_PAGE_SIZE : Search.PAGE_SIZE);

/**
 * SCH-01: one search for text and voice. Small talk never reaches the database (B2);
 * the full id list is kept for "more" (B1).
 */
async function handleSearchMessage(broker, text, ctx, { channel = "text" } = {}) {
  require("./dispatcher").setTurnAction("search");
  const startTime = Date.now();
  const { pool, lang, AI } = ctx;
  const res = await Search.search({ pool, AI, agencyId: broker.agency_id, text, ctx: { ...ctx, broker }, pageSize: pageSizeFor(broker) });
  const en = lang === "en";

  const log = (status, metadata = {}) =>
    logSearchOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "search_query",
      status,
      total_duration_ms: Date.now() - startTime,
      gemini_ms: res.timings.parseMs,
      db_ms: res.timings.dbMs,
      model_used: res.modelUsed,
      // Tokens and cost live on the AI gateway's search_parse row.
      metadata: { channel, source: res.source, filters: res.parsed.filters, ...metadata }
    });

  if (res.status === "small_talk") {
    await reply(
      broker,
      en
        ? "👋 Send what you are looking for (e.g. *3-bedroom apartment in New Cairo under 8M*), a unit code, or *help*."
        : "👋 ابعت مواصفات اللي بتدور عليه (مثال: *شقة 3 غرف في التجمع تحت 8 مليون*)، أو كود وحدة، أو اكتب *مساعدة*."
    );
    log("not_search");
    return "done";
  }
  if (res.status === "listing") {
    await reply(
      broker,
      en
        ? "📝 Looks like a unit to add. Type *add*, then send the details, photos or a voice note."
        : "📝 شكلها وحدة عايز تضيفها. اكتب *إضافة* وبعدها ابعت التفاصيل أو الصور أو فويس نوت."
    );
    log("not_search", { intent: "listing" });
    return "done";
  }

  const interp = formatInterpretation(res.parsed, lang);
  if (res.status === "none") {
    const body = en
      ? `🔍 No units match *${interp}*. Try a wider budget or a nearby area.\n\n${webLine(res.parsed.filters, lang)}`
      : `🔍 مفيش وحدات مطابقة لـ *${interp}*. جرب ميزانية أوسع أو منطقة قريبة.\n\n${webLine(res.parsed.filters, lang)}`;
    // Wow 2: a client asked for this? Save it as their request and hear when a unit fits.
    const canRequest = !res.parsed.filters.code;
    if (canRequest) await replyButtons(broker, body, [await require("./leadIntake").requestButton(pool, broker, res.parsed.filters, lang)]);
    else await reply(broker, body);
    log("zero_matches");
    return "done";
  }

  await saveSnapshot(pool, broker.id, {
    ids: res.ids,
    offset: res.rows.length,
    total: res.total,
    relaxed: res.relaxed,
    filters: res.parsed.filters,
    query: String(text).slice(0, 300),
    created_at: Date.now()
  }).catch((e) => console.warn("Failed to persist search snapshot:", e.message));

  const header = res.relaxed
    ? en
      ? `⚠️ No exact match — closest units for *${interp}*`
      : `⚠️ مفيش تطابق تام — أقرب النتائج لـ *${interp}*`
    : `🔍 *${interp}*`;
  const hint = await require("../services/onboarding").firstHint(pool, broker, "search").catch(() => null);
  const body = `${header}\n${Describe.searchResults(res.rows, { total: res.total, lang })}\n\n${webLine(res.parsed.filters, lang)}${hint ? `\n\n${hint}` : ""}`;
  await sendResults(broker, body, res.rows, 0, res.ids.length > res.rows.length, lang);

  log("success", { result_count: res.rows.length, total_count: res.total, relaxed: res.relaxed });
  return "done";
}

/** SCH-02: next page from the stored id snapshot (button or the word "more"). */
async function handleMore(broker, ctx) {
  require("./dispatcher").setTurnAction("search");
  const { pool, lang } = ctx;
  const en = lang === "en";
  const { rows: sessions } = await pool.query(
    `SELECT session_data FROM broker_sessions
     WHERE broker_id = $1 AND session_type = 'search_state' AND expires_at > NOW()`,
    [broker.id]
  );
  const state = sessions[0]?.session_data;
  if (!state || !Array.isArray(state.ids)) {
    await reply(broker, en ? "⏳ That search has expired. Send your search again." : "⏳ البحث السابق انتهت صلاحيته. ابعت طلب البحث تاني.");
    return "done";
  }
  const offset = Number(state.offset) || 0;
  const size = pageSizeFor(broker);
  const rows = await Search.pageByIds(pool, broker.agency_id, state.ids, offset, size);
  if (!rows.length) {
    await reply(broker, en ? "🏁 You have seen all matching units." : "🏁 دي كل الوحدات المطابقة.");
    return "done";
  }
  const nextOffset = Math.min(state.ids.length, offset + size);
  await saveSnapshot(pool, broker.id, { ...state, offset: nextOffset });
  const body = Describe.searchResults(rows, { offset, total: state.total, lang });
  await sendResults(broker, body, rows, offset, nextOffset < state.ids.length, lang);
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
  handleSearchMessage,
  handleMore
};
