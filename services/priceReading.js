// services/priceReading.js — A developer's PDF or photographed price list read by AI into a price-sheet preview
// (Release B, C5). Managers only, and only for an agency the app owner switched on (agencies.price_reading). The
// manager picks the pages; each page is fingerprinted (lib/pdfPages.js) and a page any agency had read before is
// reused: no AI call and no stored rows again, but the agency is charged the page credits as for a fresh read. Nothing in
// the agency's view says a page was reused; only the owner's page counts reuse. Pages are checked against the allowance
// before any call. The rows go to services/priceSheets.js storePreview, so nothing is saved before the
// manager checks the usual preview and applies it. pagesOf and readPages are shared with the brochure reader
// (services/brochure.js, C6), under the same switch, allowance and cache.
"use strict";

const AI = require("../lib/ai");
const Pdf = require("../lib/pdfPages");
const R = require("../domain/priceReading");
const PriceSheets = require("./priceSheets");
const Billing = require("./billing");
const Credits = require("./credits");
const { isManager } = require("../lib/authz");

const PARALLEL = 3;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;

async function settingOf(db, agencyId) {
  const { rows } = await db.query("SELECT price_reading FROM agencies WHERE id = $1", [agencyId]);
  return R.settingOf(rows[0]?.price_reading);
}

/** The owner switches one agency on or off with its monthly pages. */
async function setForAgency(db, agencyId, input) {
  const f = R.settingFields(input);
  if (f.error) return f;
  const { rows } = await db.query("UPDATE agencies SET price_reading = $2::jsonb WHERE id = $1 RETURNING id, name", [agencyId, JSON.stringify(f.fields)]);
  return rows[0] ? { ok: true, agency: rows[0], setting: f.fields } : { error: "not_found" };
}

/**
 * Pages the agency read this Cairo month (reused ones too: they are charged the same) and how many more its credits pay
 * for: each page costs the "page" credits (credit_actions), taken from the same monthly pool as every other AI action.
 */
async function usage(db, agencyId, { now = new Date() } = {}) {
  const setting = await settingOf(db, agencyId);
  const [{ rows }, a, per] = await Promise.all([
    db.query("SELECT count(*)::int AS n FROM price_read_log WHERE agency_id = $1 AND created_at >= $2", [agencyId, R.monthStart(now).toISOString()]),
    Billing.allowance(db, agencyId, { now }),
    Credits.creditsFor(db, "page")
  ]);
  const remaining = Math.max(0, a.credits.limit - a.credits.used);
  const left = per > 0 ? Math.floor(remaining / per) : R.MAX_PAGES_MONTH;
  return { ...setting, used: rows[0].n, left, pages_month: rows[0].n + left, credits_per_page: per, credits_left: remaining };
}

/** Every agency with its setting and this month's pages (the owner's page). */
async function overview(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.price_reading,
            (SELECT count(*)::int FROM price_read_log l WHERE l.agency_id = a.id AND NOT l.reused AND l.created_at >= $1) AS used,
            (SELECT count(*)::int FROM price_read_log l WHERE l.agency_id = a.id AND l.reused AND l.created_at >= $1) AS reused
       FROM agencies a ORDER BY a.name`,
    [R.monthStart(now).toISOString()]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, ...R.settingOf(r.price_reading), used: r.used, reused: r.reused }));
}

/** Runs fn over items, a few at a time, in order. */
async function inBatches(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += PARALLEL) out.push(...(await Promise.all(items.slice(i, i + PARALLEL).map(fn))));
  return out;
}

/** One page to the model with a prompt → { result, model } | { error }. */
async function readPage(pool, actor, page, { prompt, parse, operationType = "price_list_read" }) {
  try {
    const res = await AI.generateWithCascade({
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: page.mime, data: page.data.toString("base64") } }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
      operationType,
      ctx: { pool, broker: actor }
    });
    const parsed = parse(res.text);
    return parsed.error ? { error: parsed.error } : { result: parsed.result, model: res.modelUsed };
  } catch (err) {
    console.warn("Document page read failed:", err.message);
    return { error: "AI_FAILED" };
  }
}

/**
 * The pages to read from an upload: one PDF with the picked pages, or up to 10 photos.
 * @returns {Promise<{ list: [{ label, mime, data, fingerprint }], pdf } | { error, total? }>}
 */
async function pagesOf(files, pages, { version, maxPages = R.MAX_PAGES }) {
  if (!files.length) return { error: "NO_FILE" };
  const pdf = files.find((f) => f.mimetype === "application/pdf" || /\.pdf$/i.test(f.originalname || ""));
  if (pdf) {
    if (files.length > 1) return { error: "ONE_PDF" };
    let total;
    try {
      total = await Pdf.pageCount(pdf.buffer);
    } catch (e) {
      return { error: e.code || "NOT_PDF" };
    }
    const picked = R.parsePages(pages, total, { max: maxPages });
    if (picked.error) return { error: picked.error, total };
    const list = (await Pdf.extract(pdf.buffer, picked)).map((p) => ({ label: p.page, mime: "application/pdf", data: p.pdf, fingerprint: `${version}:${p.fingerprint}` }));
    return { list, pdf };
  }
  if (files.some((f) => !IMAGE_TYPES.test(f.mimetype || ""))) return { error: "NOT_SUPPORTED" };
  if (files.length > maxPages) return { error: "too_many_pages" };
  return { list: files.map((f, i) => ({ label: i + 1, mime: f.mimetype, data: f.buffer, fingerprint: `${version}:${Pdf.imageFingerprint(f.buffer)}` })), pdf: null };
}

/**
 * Reads pages with the shared cache and the agency's monthly allowance: cached pages (any agency) are free; new pages
 * are checked against the allowance first, then read; every page read is logged (reused or not).
 * @returns {Promise<{ results: Map(fingerprint → result), fresh, failed: [label], reused } | { error: "ALLOWANCE", left, needed }>}
 */
async function readPages(pool, actor, projectId, list, { prompt, parse, operationType, now = new Date() }) {
  const { rows: known } = await pool.query("SELECT fingerprint, rows FROM price_page_reads WHERE fingerprint = ANY($1::text[])", [list.map((p) => p.fingerprint)]);
  const results = new Map(known.map((k) => [k.fingerprint, k.rows]));
  const fresh = list.filter((p) => !results.has(p.fingerprint));
  const use = await usage(pool, actor.agency_id, { now });
  if (list.length > use.left) return { error: "ALLOWANCE", left: use.left, needed: list.length };
  const out = await inBatches(fresh, (p) => readPage(pool, actor, p, { prompt, parse, operationType }));
  const failed = [];
  for (const [i, p] of fresh.entries()) {
    if (out[i].error) {
      failed.push(p.label);
      continue;
    }
    await pool.query("INSERT INTO price_page_reads (fingerprint, rows, model) VALUES ($1, $2::jsonb, $3) ON CONFLICT (fingerprint) DO NOTHING", [p.fingerprint, JSON.stringify(out[i].result), out[i].model]);
    results.set(p.fingerprint, out[i].result);
  }
  const freshSet = new Set(fresh.map((p) => p.fingerprint));
  for (const p of list) {
    if (!results.has(p.fingerprint)) continue;
    await pool.query("INSERT INTO price_read_log (agency_id, project_id, broker_id, fingerprint, reused, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      actor.agency_id,
      projectId,
      actor.id,
      p.fingerprint,
      !freshSet.has(p.fingerprint),
      now.toISOString()
    ]);
  }
  return { results, read: fresh.length - failed.length, failed, reused: list.length - fresh.length };
}

const parseRows = (text) => {
  const r = R.rowsFromAnswer(text);
  return r.error ? r : { result: r.rows };
};

/**
 * Reads a PDF (pages picked by the manager) or up to 10 photos into a price-sheet preview.
 * @param {Object} input - { files: [{ buffer, mimetype, originalname }], pages: "1-3, 5" }
 * @returns {Promise<{ ok, sheet, read, reused, failed } | { error, left?, needed? }>}
 */
async function read(pool, actor, projectId, { files = [], pages = "" } = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await PriceSheets.projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const setting = await settingOf(pool, actor.agency_id);
  if (!setting.enabled) return { error: "OFF" };
  const got = await pagesOf(files, pages, { version: R.PROMPT_VERSION });
  if (got.error) return got;
  const { list, pdf } = got;
  const r = await readPages(pool, actor, project.id, list, { prompt: R.PROMPT, parse: parseRows, operationType: "price_list_read", now });
  if (r.error) return r;
  if (r.failed.length === list.length) return { error: "AI_FAILED" };

  // Row numbers run on across pages ("page 2 row 3" becomes 2003) so the preview can point at the page.
  const tableRows = [];
  for (const p of list) (r.results.get(p.fingerprint) || []).forEach((row, i) => tableRows.push({ rowNumber: Number(p.label) * 1000 + i + 1, cells: row.cells }));
  if (!tableRows.length) return { error: "NO_ROWS", failed: r.failed };
  const name = pdf ? `${pdf.originalname || "price-list.pdf"} (${list.map((p) => p.label).join(", ")})` : `${files.length} photo(s)`;
  const stored = await PriceSheets.storePreview(pool, actor, project, tableRows, {
    fileName: name,
    source: "ai",
    extra: { ai: { pages: list.map((p) => p.label), failed: r.failed, read: r.read, reused: r.reused } }
  });
  return { ...stored, read: r.read, reused: r.reused, failed: r.failed };
}

// Any read that spends credits is confirmed with its page count and cost before it runs.
const CONFIRM_CREDITS = 1;

/**
 * What reading this upload would cost, before the manager presses the button: the pages picked, the credits they cost
 * (every page, reused or not) against what is left, and whether this agency has read any of them before (a warning
 * only: it is charged again). Makes no AI call and records nothing.
 * @returns {Promise<{ ok, pages, credits, left, enough, confirm, repeat } | { error, total? }>}
 */
async function estimate(pool, actor, projectId, { files = [], pages = "" } = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await PriceSheets.projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const setting = await settingOf(pool, actor.agency_id);
  if (!setting.enabled) return { error: "OFF" };
  const got = await pagesOf(files, pages, { version: R.PROMPT_VERSION });
  if (got.error) return got;
  const keys = got.list.map((p) => p.fingerprint);
  const { rows: own } = await pool.query("SELECT 1 FROM price_read_log WHERE agency_id = $1 AND fingerprint = ANY($2::text[]) LIMIT 1", [actor.agency_id, keys]);
  const use = await usage(pool, actor.agency_id, { now });
  const credits = got.list.length * use.credits_per_page;
  return { ok: true, pages: got.list.length, credits, left: use.credits_left, enough: credits <= use.credits_left, confirm: credits >= CONFIRM_CREDITS, repeat: own.length > 0 };
}

module.exports = { CONFIRM_CREDITS, estimate, settingOf, setForAgency, usage, overview, read, pagesOf, readPages };
