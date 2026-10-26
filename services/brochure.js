// services/brochure.js — A project's brochure and highlights (Release B, C6). Managers upload the brochure as a PDF
// (picked pages, up to 8) or photos; it uses the same owner switch, monthly pages and shared page cache as price
// lists (services/priceReading.js). The facts each page states are kept on the project (projects.brochure) for the
// project assistant, and 3 to 5 highlight lines are suggested from them only; nothing shows to clients until the
// manager edits and saves the lines (or types their own, which needs no AI).
"use strict";

const AI = require("../lib/ai");
const B = require("../domain/brochure");
const PriceReading = require("./priceReading");
const { isManager } = require("../lib/authz");

async function projectOf(db, actor, projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId || ""))) return null;
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [projectId, actor.agency_id]);
  return rows[0] || null;
}

const parseFacts = (text) => B.factsFromAnswer(text);

/** Suggests the lines from the stored facts (one text call) → { ar, en } | null. */
async function suggestLines(pool, actor, project, facts) {
  if (!facts.length) return null;
  try {
    const res = await AI.generateWithCascade({
      contents: B.highlightsPrompt(project, facts),
      config: { responseMimeType: "application/json", temperature: 0.2 },
      operationType: "brochure_highlights",
      ctx: { pool, broker: actor }
    });
    const lines = B.linesFromAnswer(res.text);
    return lines.error ? null : lines;
  } catch (err) {
    console.warn("Brochure highlights failed:", err.message);
    return null;
  }
}

/**
 * Reads the brochure pages into the project's facts and a suggestion for the highlights.
 * @returns {Promise<{ ok, facts, suggested, read, reused, failed } | { error, left?, needed? }>}
 */
async function read(pool, actor, projectId, { files = [], pages = "" } = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  if (!(await PriceReading.settingOf(pool, actor.agency_id)).enabled) return { error: "OFF" };
  const got = await PriceReading.pagesOf(files, pages, { version: B.FACTS_VERSION, maxPages: B.MAX_PAGES });
  if (got.error) return got;
  const r = await PriceReading.readPages(pool, actor, project.id, got.list, { prompt: B.FACTS_PROMPT, parse: parseFacts, operationType: "brochure_read", now });
  if (r.error) return r;
  if (r.failed.length === got.list.length) return { error: "AI_FAILED" };
  const facts = B.mergeFacts(got.list.map((p) => r.results.get(p.fingerprint) || []));
  if (!facts.length) return { error: "NO_FACTS", failed: r.failed };
  const suggested = await suggestLines(pool, actor, project, facts);
  const brochure = {
    facts,
    pages: got.list.map((p) => p.label),
    failed: r.failed,
    file_name: got.pdf ? String(got.pdf.originalname || "brochure.pdf").slice(0, 200) : `${files.length} photo(s)`,
    read_at: now.toISOString(),
    suggested
  };
  await pool.query("UPDATE projects SET brochure = $3::jsonb, updated_at = $4 WHERE id = $1 AND agency_id = $2", [project.id, actor.agency_id, JSON.stringify(brochure), now.toISOString()]);
  return { ok: true, facts, suggested, read: r.read, reused: r.reused, failed: r.failed };
}

/** Saves the manager's lines (Arabic and English textareas, one line each, up to 5). Empty clears. */
async function saveHighlights(pool, actor, projectId, input = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const ar = B.linesFromText(input.ar);
  const en = B.linesFromText(input.en);
  for (const x of [ar, en]) if (x.error) return { error: x.error };
  const highlights = ar.length || en.length ? { ar, en } : {};
  await pool.query("UPDATE projects SET highlights = $3::jsonb, highlights_at = $4, updated_at = $4 WHERE id = $1 AND agency_id = $2", [
    project.id,
    actor.agency_id,
    JSON.stringify(highlights),
    now.toISOString()
  ]);
  return { ok: true, highlights };
}

module.exports = { read, saveHighlights };
