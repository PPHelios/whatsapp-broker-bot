// web/routes/search.js — Web search on services/search.js (same filters, same SQL, same order as WhatsApp),
// "refine and see all" (?f=<filters token> from WhatsApp links) and saved searches.
"use strict";

const Search = require("../../services/search");
const AI = require("../../lib/ai");
const RateLimit = require("../../lib/rateLimit");
const { logOperation } = require("../../lib/db");
const { formatInterpretation } = require("../../lib/search");
const Q = require("../../domain/searchQuery");
const SearchLink = require("../../domain/searchLink");
const { html } = require("../html");
const { resultItem } = require("../views/units");
const { refineForm } = require("../views/searchForm");

const WEB_PAGE_SIZE = 20;
const MAX_SAVED = 50;
const FORM_KEYS = ["code", "listing_type", "market", "type", "place", "price_min", "price_max", "area_min", "area_max", "bedrooms_min", "bedrooms_max", "bathrooms_min", "floor_min", "floor_max", "finishing", "furnishing", "ready", "by_year", "cash", "installments", "max_down_payment", "max_installment", "feature", "other"];

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const stripStars = (s) => String(s || "").replace(/\*/g, "");

/** Runs canonical filters for the agency: strict, then relaxed; the page comes from the id snapshot. */
async function runFilters(pool, agencyId, filters, page) {
  const res = await Search.runSearch(pool, agencyId, { filters }, { pageSize: WEB_PAGE_SIZE });
  const offset = (page - 1) * WEB_PAGE_SIZE;
  const rows = offset === 0 ? res.rows : await Search.pageByIds(pool, agencyId, res.ids, offset, WEB_PAGE_SIZE);
  return { ...res, rows, offset };
}

function searchBox(q, lang) {
  return html`<form method="get" action="/app/search" class="card stack" role="search">
  <label>${L(lang, "اكتب طلبك زي ما بتكتبه على واتساب", "Type your request as you would on WhatsApp")}
    <input name="q" value="${q}" placeholder="${L(lang, "شقة 3 غرف في التجمع تحت 9 مليون", "3-bedroom apartment in New Cairo under 9M")}" autocomplete="off"></label>
  <div class="row"><button type="submit">🔍 ${L(lang, "بحث", "Search")}</button><a href="/app/searches">${L(lang, "⭐ البحث المحفوظ", "⭐ Saved searches")}</a></div>
</form>`;
}

function pager(token, page, total, lang) {
  const pages = Math.ceil(Math.min(total, Search.SNAPSHOT_MAX) / WEB_PAGE_SIZE);
  if (pages <= 1) return "";
  const link = (p) => `/app/search?f=${token}&page=${p}`;
  return html`<nav class="row" aria-label="pages">
  ${page > 1 ? html`<a class="btn secondary" href="${link(page - 1)}">${L(lang, "→ السابق", "← Previous")}</a>` : ""}
  <span class="muted">${page} / ${pages}</span>
  ${page < pages ? html`<a class="btn secondary" href="${link(page + 1)}">${L(lang, "التالي ←", "Next →")}</a>` : ""}
</nav>`;
}

function resultsSection({ res, filters, token, page, lang, savedId = null }) {
  const interp = stripStars(formatInterpretation({ filters }, lang));
  const total = Math.min(res.total, Search.SNAPSHOT_MAX);
  if (!res.rows.length) {
    return html`<div class="card notice"><p>🔍 ${L(lang, "مفيش وحدات مطابقة لـ", "No units match")} <strong>${interp}</strong>. ${L(lang, "جرب ميزانية أوسع أو منطقة قريبة.", "Try a wider budget or a nearby area.")}</p></div>`;
  }
  return html`<section id="results">
  ${res.relaxed ? html`<p class="card notice warn">⚠️ ${L(lang, "مفيش تطابق تام — أقرب النتائج لـ", "No exact match — closest units for")} <strong>${interp}</strong></p>` : html`<h2>🔍 ${interp}</h2>`}
  <p class="muted">${L(lang, `${res.total} وحدة مطابقة`, `${res.total} matching unit(s)`)}${res.total > total ? L(lang, ` (أول ${total})`, ` (first ${total})`) : ""}</p>
  <ol class="results" start="${res.offset + 1}">${res.rows.map((r) => resultItem(r, lang))}</ol>
  ${pager(token, page, res.total, lang)}
  ${savedId
    ? ""
    : html`<form method="post" action="/app/searches" class="row card">
    <input type="hidden" name="f" value="${token}">
    <label>${L(lang, "اسم البحث", "Name")}<input name="name" required maxlength="80" value="${interp.slice(0, 80)}"></label>
    <button type="submit" class="secondary">⭐ ${L(lang, "احفظ البحث", "Save search")}</button>
  </form>`}
</section>`;
}

function register(web, { pool, page }) {
  const searchCtx = (req) => ({ pool, AI, broker: req.session.broker, agency: req.session.agency, lang: langOf(req) });

  web.get("/search", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const q = String(req.query.q || "").trim().slice(0, 500);
    const pageNo = Math.max(1, Math.min(50, parseInt(req.query.page, 10) || 1));
    let filters = null;
    let message = null;
    let source = "form";
    const t0 = Date.now();

    if (q) {
      const gate = await RateLimit.hit(pool, `search:broker:${broker.id}`, RateLimit.LIMITS.searchBroker);
      if (!gate.allowed) return page(req, res, { title: L(lang, "بحث", "Search"), nav: "search", body: html`${searchBox(q, lang)}<p class="card notice bad">⏳ ${L(lang, "بحث كتير في دقيقة. استنى شوية.", "Too many searches in a minute. Wait a moment.")}</p>` }, 429);
      const parsed = await Search.parseRequest(AI, { text: q, ctx: searchCtx(req) });
      source = parsed.source;
      const intent = Q.classifyIntent(parsed.parsed);
      if (intent === "search") filters = parsed.parsed.filters;
      else
        message =
          intent === "listing"
            ? L(lang, "📝 شكلها وحدة عايز تضيفها.", "📝 Looks like a unit to add.") + " "
            : L(lang, "👋 اكتب مواصفات اللي بتدور عليه (مثال: شقة 3 غرف في التجمع تحت 8 مليون).", "👋 Type what you are looking for (e.g. 3-bedroom apartment in New Cairo under 8M).");
    } else if (req.query.f) {
      filters = SearchLink.decodeFilters(String(req.query.f));
      if (!filters) message = L(lang, "⚠️ رابط البحث ده مش صحيح. ابحث من جديد.", "⚠️ This search link is not valid. Search again.");
    } else if (FORM_KEYS.some((k) => req.query[k] !== undefined && req.query[k] !== "")) {
      filters = SearchLink.filtersFromForm(req.query);
    }
    if (filters && !Q.hasAnyFilter({ filters })) {
      filters = null;
      message = L(lang, "اختار فلتر واحد على الأقل.", "Choose at least one filter.");
    }

    let results = "";
    if (filters) {
      const token = SearchLink.encodeFilters(filters);
      const out = await runFilters(pool, broker.agency_id, filters, pageNo);
      results = resultsSection({ res: out, filters, token, page: pageNo, lang });
      logOperation(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "search_query",
        status: out.rows.length ? "success" : "zero_matches",
        total_duration_ms: Date.now() - t0,
        db_ms: out.dbMs,
        metadata: { channel: "web", source, filters, total_count: out.total, relaxed: out.relaxed, page: pageNo }
      });
    }

    return page(req, res, {
      title: L(lang, "بحث", "Search"),
      nav: "search",
      body: html`${searchBox(q, lang)}
${message ? html`<p class="card notice">${message}${message.startsWith("📝") ? html` <a href="/app/units/new">${L(lang, "إضافة وحدة", "Add a unit")}</a>` : ""}</p>` : ""}
${results}
${refineForm(filters || {}, lang, { open: !filters && !q })}`
    });
  });

  /* Saved searches (per broker, agency-scoped). */

  web.post("/searches", async (req, res) => {
    const { broker } = req.session;
    const filters = SearchLink.decodeFilters(String(req.body.f || ""));
    const name = String(req.body.name || "").trim().slice(0, 80);
    if (!filters || !Q.hasAnyFilter({ filters }) || !name) return res.status(400).send("A name and a valid search are required");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM saved_searches WHERE agency_id = $1 AND broker_id = $2", [broker.agency_id, broker.id]);
    if (rows[0].n >= MAX_SAVED) return res.status(409).send(`At most ${MAX_SAVED} saved searches`);
    const out = await Search.runSearch(pool, broker.agency_id, { filters });
    await pool.query(
      `INSERT INTO saved_searches (agency_id, broker_id, name, filters, seen_ids, last_run_at) VALUES ($1, $2, $3, $4::jsonb, $5::uuid[], NOW())`,
      [broker.agency_id, broker.id, name, JSON.stringify(filters), out.ids]
    );
    return res.redirect(303, "/app/searches");
  });

  web.get("/searches", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const { rows } = await pool.query(
      "SELECT id, name, filters, seen_ids, last_run_at FROM saved_searches WHERE agency_id = $1 AND broker_id = $2 ORDER BY created_at DESC",
      [broker.agency_id, broker.id]
    );
    const items = [];
    for (const s of rows) {
      const filters = SearchLink.sanitizeFilters(s.filters);
      const out = await Search.runSearch(pool, broker.agency_id, { filters });
      const seen = new Set(s.seen_ids || []);
      const fresh = out.ids.filter((id) => !seen.has(id)).length;
      items.push({ s, filters, total: out.total, fresh });
    }
    return page(req, res, {
      title: L(lang, "البحث المحفوظ", "Saved searches"),
      nav: "search",
      body: html`<h1>⭐ ${L(lang, "البحث المحفوظ", "Saved searches")}</h1>
${items.length
  ? html`<ul class="results">${items.map(
      ({ s, filters, total, fresh }) => html`<li class="card row" data-saved="${s.id}">
  <a href="/app/searches/${s.id}"><strong>${s.name}</strong></a>
  <span class="muted">${stripStars(formatInterpretation({ filters }, lang))}</span>
  <span>${L(lang, `${total} وحدة`, `${total} unit(s)`)}</span>
  ${fresh ? html`<span class="ok" data-new="${fresh}">🆕 ${L(lang, `${fresh} جديد`, `${fresh} new`)}</span>` : ""}
  <form method="post" action="/app/searches/${s.id}/delete"><button class="link" type="submit">${L(lang, "حذف", "Delete")}</button></form>
</li>`
    )}</ul>`
  : html`<p class="card">${L(lang, "مفيش بحث محفوظ لسه. ابحث واضغط «احفظ البحث».", "No saved searches yet. Search, then tap Save search.")}</p>`}`
    });
  });

  web.get("/searches/:id", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return next();
    const { rows } = await pool.query("SELECT * FROM saved_searches WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [req.params.id, broker.agency_id, broker.id]);
    if (!rows[0]) return next();
    const filters = SearchLink.sanitizeFilters(rows[0].filters);
    const out = await runFilters(pool, broker.agency_id, filters, 1);
    await pool.query("UPDATE saved_searches SET seen_ids = $2::uuid[], last_run_at = NOW() WHERE id = $1", [rows[0].id, out.ids]);
    const token = SearchLink.encodeFilters(filters);
    return page(req, res, {
      title: rows[0].name,
      nav: "search",
      body: html`<h1>⭐ ${rows[0].name}</h1>${resultsSection({ res: out, filters, token, page: 1, lang, savedId: rows[0].id })}${refineForm(filters, lang)}`
    });
  });

  web.post("/searches/:id/delete", async (req, res) => {
    const { broker } = req.session;
    if (/^[0-9a-f-]{36}$/.test(req.params.id)) {
      await pool.query("DELETE FROM saved_searches WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [req.params.id, broker.agency_id, broker.id]);
    }
    return res.redirect(303, "/app/searches");
  });
}

module.exports = { WEB_PAGE_SIZE, MAX_SAVED, register };
