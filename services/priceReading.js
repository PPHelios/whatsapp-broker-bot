// services/priceReading.js — A developer's PDF or photographed price list read by AI into a price-sheet preview
// (Release B, C5). Managers only, and only for an agency the app owner switched on (agencies.price_reading). The
// manager picks the pages; each page is fingerprinted (lib/pdfPages.js) and a page any agency had read before is
// reused silently: no AI call and not counted. New pages are counted against the agency's monthly page allowance,
// checked before any call. The rows go to services/priceSheets.js storePreview, so nothing is saved before the
// manager checks the usual preview and applies it.
"use strict";

const AI = require("../lib/ai");
const Pdf = require("../lib/pdfPages");
const R = require("../domain/priceReading");
const PriceSheets = require("./priceSheets");
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

/** Pages the agency used this Cairo month (reused pages are free) and what is left. */
async function usage(db, agencyId, { now = new Date() } = {}) {
  const setting = await settingOf(db, agencyId);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM price_read_log WHERE agency_id = $1 AND NOT reused AND created_at >= $2", [agencyId, R.monthStart(now).toISOString()]);
  return { ...setting, used: rows[0].n, left: Math.max(0, setting.pages_month - rows[0].n) };
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

/** One page to the model → rows | { error }. */
async function readPage(pool, actor, page) {
  try {
    const res = await AI.generateWithCascade({
      contents: [{ role: "user", parts: [{ text: R.PROMPT }, { inlineData: { mimeType: page.mime, data: page.data.toString("base64") } }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
      operationType: "price_list_read",
      ctx: { pool, broker: actor }
    });
    const parsed = R.rowsFromAnswer(res.text);
    return parsed.error ? { error: parsed.error } : { rows: parsed.rows, model: res.modelUsed };
  } catch (err) {
    console.warn("Price list read failed:", err.message);
    return { error: "AI_FAILED" };
  }
}

/**
 * Reads a PDF (pages picked by the manager) or up to 10 photos into a price-sheet preview.
 * @param {Object} input - { files: [{ buffer, mimetype, originalname }], pages: "1-3, 5" }
 * @returns {Promise<{ ok, sheet, read, reused } | { error, left?, needed? }>}
 */
async function read(pool, actor, projectId, { files = [], pages = "" } = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await PriceSheets.projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const setting = await settingOf(pool, actor.agency_id);
  if (!setting.enabled) return { error: "OFF" };
  if (!files.length) return { error: "NO_FILE" };

  // The pages to read: [{ label, mime, data, fingerprint }].
  let list = [];
  const pdf = files.find((f) => f.mimetype === "application/pdf" || /\.pdf$/i.test(f.originalname || ""));
  if (pdf) {
    if (files.length > 1) return { error: "ONE_PDF" };
    let total;
    try {
      total = await Pdf.pageCount(pdf.buffer);
    } catch (e) {
      return { error: e.code || "NOT_PDF" };
    }
    const picked = R.parsePages(pages, total);
    if (picked.error) return { error: picked.error, total };
    list = (await Pdf.extract(pdf.buffer, picked)).map((p) => ({ label: p.page, mime: "application/pdf", data: p.pdf, fingerprint: `${R.PROMPT_VERSION}:${p.fingerprint}` }));
  } else {
    if (files.some((f) => !IMAGE_TYPES.test(f.mimetype || ""))) return { error: "NOT_SUPPORTED" };
    if (files.length > R.MAX_PAGES) return { error: "too_many_pages" };
    list = files.map((f, i) => ({ label: i + 1, mime: f.mimetype, data: f.buffer, fingerprint: `${R.PROMPT_VERSION}:${Pdf.imageFingerprint(f.buffer)}` }));
  }

  const { rows: known } = await pool.query("SELECT fingerprint, rows FROM price_page_reads WHERE fingerprint = ANY($1::text[])", [list.map((p) => p.fingerprint)]);
  const cached = new Map(known.map((k) => [k.fingerprint, k.rows]));
  const fresh = list.filter((p) => !cached.has(p.fingerprint));
  const use = await usage(pool, actor.agency_id, { now });
  if (fresh.length > use.left) return { error: "ALLOWANCE", left: use.left, needed: fresh.length };

  const results = await inBatches(fresh, (p) => readPage(pool, actor, p));
  const failed = fresh.filter((_, i) => results[i].error).map((p) => p.label);
  for (const [i, p] of fresh.entries()) {
    const r = results[i];
    if (r.error) continue;
    await pool.query("INSERT INTO price_page_reads (fingerprint, rows, model) VALUES ($1, $2::jsonb, $3) ON CONFLICT (fingerprint) DO NOTHING", [p.fingerprint, JSON.stringify(r.rows), r.model]);
    cached.set(p.fingerprint, r.rows);
  }
  // Every page that was read is logged; only new reads count against the allowance.
  const freshSet = new Set(fresh.map((p) => p.fingerprint));
  for (const p of list) {
    if (!cached.has(p.fingerprint)) continue;
    await pool.query("INSERT INTO price_read_log (agency_id, project_id, broker_id, fingerprint, reused, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      actor.agency_id,
      project.id,
      actor.id,
      p.fingerprint,
      !freshSet.has(p.fingerprint),
      now.toISOString()
    ]);
  }
  if (failed.length === list.length) return { error: "AI_FAILED" };

  // Row numbers run on across pages ("page 2 row 3" becomes 2003) so the preview can point at the page.
  const tableRows = [];
  for (const p of list) (cached.get(p.fingerprint) || []).forEach((r, i) => tableRows.push({ rowNumber: Number(p.label) * 1000 + i + 1, cells: r.cells }));
  if (!tableRows.length) return { error: "NO_ROWS", failed };
  const name = pdf ? `${pdf.originalname || "price-list.pdf"} (${list.map((p) => p.label).join(", ")})` : `${files.length} photo(s)`;
  const r = await PriceSheets.storePreview(pool, actor, project, tableRows, {
    fileName: name,
    source: "ai",
    extra: { ai: { pages: list.map((p) => p.label), failed, read: fresh.length - failed.length, reused: list.length - fresh.length } }
  });
  return { ...r, read: fresh.length - failed.length, reused: list.length - fresh.length, failed };
}

module.exports = { settingOf, setForAgency, usage, overview, read };
