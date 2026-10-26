// services/sheetSync.js — Google Sheet live sync (Release B, C9). A manager links a project to the developer's shared
// Google Sheet (domain/sheetSync.js). Once a day, or on "Check now", the tab is read as CSV; a sheet that did not
// change since the last check (same content hash) does nothing. Otherwise the rows become the usual price preview
// (services/priceSheets.js): with auto-apply on it is applied at once (new units and price changes; units missing
// from the sheet are never marked sold), otherwise the managers are told to review it. Managers hear about a link
// that stopped working once, not every day.
"use strict";

const crypto = require("crypto");
const S = require("../domain/sheetSync");
const Sheet = require("../domain/priceSheet");
const Sheets = require("../lib/sheets");
const PriceSheets = require("./priceSheets");
const Notifications = require("../lib/notifications");
const { isManager } = require("../lib/authz");

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const BATCH = 20;

const L = (b, ar, en) => (b?.preferred_lang === "en" ? en : ar);

async function projectOf(db, agencyId, projectId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId || ""))) return null;
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [projectId, agencyId]);
  return rows[0] || null;
}

async function saveSync(db, projectId, sync) {
  await db.query("UPDATE projects SET sheet_sync = $2::jsonb WHERE id = $1", [projectId, JSON.stringify(sync)]);
}

/** A manager links (or relinks) a project to a shared sheet; empty url removes the link. */
async function setLink(pool, actor, projectId, { url, autoApply = false } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor.agency_id, projectId);
  if (!project) return { error: "not_found" };
  if (!String(url || "").trim()) {
    await saveSync(pool, project.id, {});
    return { ok: true, sync: {} };
  }
  const link = S.parseLink(url);
  if (link.error) return link;
  const sync = { id: link.id, gid: link.gid, url: String(url).trim().slice(0, 500), auto_apply: Boolean(autoApply), by: actor.id };
  await saveSync(pool, project.id, sync);
  return { ok: true, sync };
}

/** Reads the sheet's CSV → Buffer | throws { code: sheet_not_shared | sheet_fetch | TOO_LARGE }. */
async function fetchCsv(sync, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(S.exportUrl(sync), { redirect: "follow", signal: controller.signal });
    const type = String(res.headers?.get?.("content-type") || "");
    if (!res.ok || /text\/html/i.test(type)) throw Object.assign(new Error(`sheet ${res.status}`), { code: res.status === 404 ? "sheet_link" : "sheet_not_shared" });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
    if (/^\s*<!doctype html|^\s*<html/i.test(buf.subarray(0, 200).toString("utf8"))) throw Object.assign(new Error("html"), { code: "sheet_not_shared" });
    return buf;
  } catch (err) {
    if (err.code) throw err;
    throw Object.assign(err, { code: "sheet_fetch" });
  } finally {
    clearTimeout(timer);
  }
}

async function tellManagers(pool, project, { dedupeKey, title, body, url, now }) {
  for (const m of await Notifications.managersOf(pool, project.agency_id)) {
    await Notifications.notifyBroker(pool, m, { kind: "manager_alert", dedupeKey, title: title(m), body: body(m), url, now });
  }
}

/**
 * Checks one project's sheet now.
 * @returns {Promise<{ status: "same"|"no_changes"|"preview"|"applied"|"error", sheet?, applied?, error? }>}
 */
async function checkProject(pool, project, { now = new Date(), fetchImpl = fetch } = {}) {
  const sync = project.sheet_sync || {};
  if (!sync.id) return { status: "error", error: "no_link" };
  const base = { ...sync, checked_at: now.toISOString() };
  let csv;
  try {
    csv = await fetchCsv(sync, { fetchImpl });
  } catch (err) {
    await saveSync(pool, project.id, { ...base, status: "error", error: err.code });
    // Once per broken spell: only when the last check was fine.
    if (sync.status !== "error") {
      await tellManagers(pool, project, {
        dedupeKey: `sheet_sync_error:${project.id}:${now.toISOString().slice(0, 10)}`,
        title: (m) => L(m, `⚠️ شيت ${project.name} مبقاش بيتقري`, `⚠️ ${project.name}'s sheet can't be read`),
        body: (m) => L(m, "اتأكد إن اللينك متشارك «أي حد معاه اللينك».", "Check that the link is shared with \"anyone with the link\"."),
        url: `/app/catalogue/projects/${project.id}#prices`,
        now
      });
    }
    return { status: "error", error: err.code };
  }
  const hash = crypto.createHash("sha256").update(csv).digest("hex");
  if (hash === sync.hash) {
    await saveSync(pool, project.id, { ...base, status: "same" });
    return { status: "same" };
  }
  let table;
  try {
    table = await Sheets.readTable(csv, { matcher: Sheet.columnFor, minColumns: 2, noHeader: "No header row with known columns" });
  } catch (err) {
    await saveSync(pool, project.id, { ...base, hash, status: "error", error: err.code || "NO_HEADER" });
    return { status: "error", error: err.code || "NO_HEADER" };
  }
  const actor = { agency_id: project.agency_id, id: null, role: "admin" };
  const r = await PriceSheets.storePreview(pool, actor, project, table.rows, { fileName: "Google Sheet", unmapped: table.unmapped, source: "file", extra: { google_sheet: true } });
  const sum = r.sheet.summary || {};
  if (!S.hasChanges(sum) && !sum.invalid) {
    await pool.query("UPDATE price_sheets SET status = 'discarded' WHERE id = $1", [r.sheet.id]);
    await saveSync(pool, project.id, { ...base, hash, status: "no_changes" });
    return { status: "no_changes" };
  }
  if (sync.auto_apply && Number(sum.new || 0) + Number(sum.changed || 0) > 0) {
    const applied = await PriceSheets.apply(pool, actor, project.id, r.sheet.id, { now });
    await saveSync(pool, project.id, { ...base, hash, status: "applied", sheet_id: r.sheet.id });
    await tellManagers(pool, project, {
      dedupeKey: `sheet_sync:${r.sheet.id}`,
      title: (m) => L(m, `🏷️ أسعار ${project.name} اتحدثت من الشيت`, `🏷️ ${project.name} prices updated from the sheet`),
      body: (m) =>
        L(m, `${applied.created} جديد، ${applied.updated} اتغير.${sum.removed ? ` ${sum.removed} مش موجودين في الشيت (متعلموش مباع).` : ""}`, `${applied.created} new, ${applied.updated} changed.${sum.removed ? ` ${sum.removed} no longer listed (not marked sold).` : ""}`),
      url: `/app/catalogue/projects/${project.id}/sheets/${r.sheet.id}`,
      now
    });
    return { status: "applied", sheet: r.sheet, applied };
  }
  await saveSync(pool, project.id, { ...base, hash, status: "preview", sheet_id: r.sheet.id });
  await tellManagers(pool, project, {
    dedupeKey: `sheet_sync:${r.sheet.id}`,
    title: (m) => L(m, `🏷️ شيت ${project.name} اتغير: راجع وطبّق`, `🏷️ ${project.name}'s sheet changed: review and apply`),
    body: (m) => L(m, `${sum.new || 0} جديد، ${sum.changed || 0} اتغير، ${sum.removed || 0} مش موجود.`, `${sum.new || 0} new, ${sum.changed || 0} changed, ${sum.removed || 0} no longer listed.`),
    url: `/app/catalogue/projects/${project.id}/sheets/${r.sheet.id}`,
    now
  });
  return { status: "preview", sheet: r.sheet };
}

/** "Check now" from the project page (managers). */
async function checkNow(pool, actor, projectId, opts = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor.agency_id, projectId);
  if (!project) return { error: "not_found" };
  return checkProject(pool, project, opts);
}

/** Scheduler step: every linked project due for its daily check. */
async function checkDue(pool, { now = new Date(), fetchImpl = fetch } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM projects WHERE archived_at IS NULL AND sheet_sync ? 'id'
        AND (sheet_sync->>'checked_at' IS NULL OR (sheet_sync->>'checked_at')::timestamptz <= $1)
      ORDER BY (sheet_sync->>'checked_at') NULLS FIRST LIMIT $2`,
    [new Date(now.getTime() - S.CHECK_EVERY_MS).toISOString(), BATCH]
  );
  const counts = { checked: 0, changed: 0, errors: 0 };
  for (const p of rows) {
    const r = await checkProject(pool, p, { now, fetchImpl }).catch((err) => ({ status: "error", error: err.message }));
    counts.checked++;
    if (["preview", "applied"].includes(r.status)) counts.changed++;
    if (r.status === "error") counts.errors++;
  }
  return counts;
}

const syncJob = () => ({
  name: "sheet_sync",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool, now }) => ({ counts: await checkDue(pool, { now: new Date(now) }) })
});

module.exports = { setLink, checkProject, checkNow, checkDue, syncJob, fetchCsv };
