// services/planReading.js — A developer's payment plans file read by AI into a preview on the project (F21). Managers
// upload a PDF (pages picked), photos, or an Excel/CSV sheet on the project's Payment plans section; it uses the same
// owner switch, monthly page allowance and shared page cache as price lists (services/priceReading.js; a sheet counts
// as one page). The file is kept under Materials (internal). The plans wait in projects.plans_draft until the manager
// ticks, edits and saves them as ordinary plans (services/catalogue.js savePlan), or discards them.
"use strict";

const crypto = require("crypto");
const P = require("../domain/planReading");
const PriceReading = require("./priceReading");
const Catalogue = require("./catalogue");
const Sheets = require("../lib/sheets");
const { isManager } = require("../lib/authz");

const SHEET_RE = /\.(xlsx|csv)$/i;
const MAX_SHEET_CHARS = 30000;

async function projectOf(db, actor, projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId || ""))) return null;
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [projectId, actor.agency_id]);
  return rows[0] || null;
}

/** An Excel or CSV sheet as one text page (tab-separated rows). */
async function sheetPage(file) {
  let rows;
  try {
    if (/\.csv$/i.test(file.originalname || "") || /csv|text\/plain/.test(file.mimetype || "")) rows = Sheets.parseCsv(Sheets.decodeText(file.buffer)).map((r) => r.values);
    else rows = (await Sheets.xlsxRows(file.buffer)).map((r) => r.values);
  } catch (e) {
    return { error: e.code || "NOT_XLSX" };
  }
  const text = rows
    .map((v) => (v || []).slice(1).map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c ?? "")).join("\t").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_SHEET_CHARS);
  if (!text) return { error: "NO_PLANS" };
  const fingerprint = `${P.VERSION}:sheet:${crypto.createHash("sha256").update(text).digest("hex")}`;
  return { list: [{ label: 1, mime: "text/plain", data: Buffer.from(text, "utf8"), fingerprint }], pdf: null };
}

/**
 * Reads the file into a preview of plans (kept on the project) and keeps the file under Materials.
 * @returns {Promise<{ ok, plans, read, reused, failed } | { error, left?, needed? }>}
 */
async function read(pool, actor, projectId, { files = [], pages = "" } = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  if (!(await PriceReading.settingOf(pool, actor.agency_id)).enabled) return { error: "OFF" };
  if (!files.length) return { error: "NO_FILE" };
  const sheet = files.find((f) => SHEET_RE.test(f.originalname || ""));
  if (sheet && files.length > 1) return { error: "ONE_PDF" };
  const got = sheet ? await sheetPage(sheet) : await PriceReading.pagesOf(files, pages, { version: P.VERSION, maxPages: P.MAX_PAGES });
  if (got.error) return got;
  const r = await PriceReading.readPages(pool, actor, project.id, got.list, { prompt: P.PROMPT, parse: P.plansFromAnswer, operationType: "plans_read", now });
  if (r.error) return r;
  if (r.failed.length === got.list.length) return { error: "AI_FAILED" };
  const plans = P.mergePlans(got.list.map((p) => r.results.get(p.fingerprint) || []));
  if (!plans.length) return { error: "NO_PLANS", failed: r.failed };

  // The file stays with the project's materials (internal). A sheet is kept as is; a PDF or photos as uploaded.
  const fileName = String((sheet || got.pdf || files[0]).originalname || "plans").slice(0, 200);
  for (const f of sheet ? [] : files.slice(0, P.MAX_PAGES)) await Catalogue.uploadMaterial(pool, actor, project.id, f, { label: `💳 ${String(f.originalname || "plans").slice(0, 70)}`, kind: "other" });
  if (sheet) await Catalogue.uploadMaterial(pool, actor, project.id, sheet, { label: `💳 ${fileName.slice(0, 70)}`, kind: "other" });

  const draft = { plans, file_name: fileName, pages: got.list.map((p) => p.label), failed: r.failed, read_at: now.toISOString() };
  await pool.query("UPDATE projects SET plans_draft = $3::jsonb WHERE id = $1 AND agency_id = $2", [project.id, actor.agency_id, JSON.stringify(draft)]);
  return { ok: true, plans, read: r.read, reused: r.reused, failed: r.failed };
}

/**
 * Saves the ticked plans (body: pick = indexes; name_<i>, down_<i>, years_<i>, frequency_<i>, discount_<i>,
 * maintenance_<i> edits) as the project's plans and clears the preview.
 * @returns {Promise<{ ok, saved, failed: [name] } | { error }>}
 */
async function apply(pool, actor, projectId, body = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const plans = project.plans_draft?.plans || [];
  if (!plans.length) return { error: "NO_PLANS" };
  const picked = new Set([].concat(body.pick ?? []).map(Number));
  let saved = 0;
  const failed = [];
  for (const [i, p] of plans.entries()) {
    if (!picked.has(i)) continue;
    const input = P.formInput(p);
    const edit = (k, field) => {
      if (body[`${k}_${i}`] !== undefined) input[field] = body[`${k}_${i}`];
    };
    edit("name", "name");
    edit("down", "down_payment_pct");
    edit("years", "years");
    edit("frequency", "frequency");
    edit("discount", "discount_pct");
    edit("maintenance", "maintenance_pct");
    const r = await Catalogue.savePlan(pool, actor, project.id, input);
    if (r.ok) saved++;
    else failed.push(String(input.name || p.name));
  }
  if (!failed.length) await pool.query("UPDATE projects SET plans_draft = NULL WHERE id = $1", [project.id]);
  return { ok: true, saved, failed };
}

async function discard(pool, actor, projectId) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  await pool.query("UPDATE projects SET plans_draft = NULL WHERE id = $1", [project.id]);
  return { ok: true };
}

module.exports = { read, apply, discard };
