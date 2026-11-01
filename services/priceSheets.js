// services/priceSheets.js — Catalogue inventory and prices (Release A, C2): a developer's price sheet per project,
// previewed before anything is saved, then applied (new units and models, price changes, units no longer listed
// marked sold when the manager ticks them); price history per unit; announced increases applied on their date;
// "prices from the sheet of …" freshness and a reminder after 30 days without a new sheet. Managers only.
// Catalogue units belong to the agency (broker_id NULL), so any broker can search, share and sell them.
"use strict";

const { isManager } = require("../lib/authz");
const Sheets = require("../lib/sheets");
const Store = require("../lib/listingStore");
const T = require("../lib/text");
const Sheet = require("../domain/priceSheet");
const Stages = require("../domain/leadStages");
const Catalogue = require("./catalogue");
const Vis = require("../lib/visibility");

const STALE_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => UUID_RE.test(String(v || ""));
const round1000 = (n) => Math.round(n / 1000) * 1000;

async function projectOf(db, actor, projectId) {
  if (!isId(projectId)) return null;
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [projectId, actor.agency_id]);
  return rows[0] || null;
}

/** The project's catalogue units and models (and any other unit linked to it), for the preview. */
async function projectUnits(db, projectId) {
  const { rows } = await db.query(
    `SELECT id, code, developer_unit_code, inventory_type, status, price_value, property_type, bedrooms, area_value, details, phase_id
     FROM listings WHERE ${Vis.units("listings")} AND project_id = $1`,
    [projectId]
  );
  return rows;
}

/**
 * Reads and previews an uploaded sheet; stores the preview (status "preview").
 * @returns {{ ok, sheet } | { error: forbidden | not_found | NOT_XLSX | TOO_LARGE | NO_HEADER | TOO_MANY_ROWS | NOT_TEXT }}
 */
async function upload(pool, actor, projectId, buffer, { fileName = null } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  let table;
  try {
    table = await Sheets.readTable(buffer, { matcher: Sheet.columnFor, minColumns: 2, noHeader: "No header row with known columns (unit code, type, area, price, …)" });
  } catch (e) {
    if (e.code) return { error: e.code };
    throw e;
  }
  if (!table.mapped.includes("price") && !table.mapped.includes("price_from")) return { error: "NO_PRICE" };
  return storePreview(pool, actor, project, table.rows, { fileName, unmapped: table.unmapped });
}

/**
 * Previews rows ([{ rowNumber, cells }]) against the project's units and stores the preview, replacing earlier ones.
 * Shared by the sheet upload and the AI price-list reader (services/priceReading.js, source "ai").
 */
async function storePreview(pool, actor, project, tableRows, { fileName = null, unmapped = [], source = "file", extra = {} } = {}) {
  const { entries, summary } = Sheet.preview(tableRows, await projectUnits(pool, project.id));
  Object.assign(summary, { unmapped: unmapped.slice(0, 10) }, extra);
  await pool.query("UPDATE price_sheets SET status = 'discarded' WHERE project_id = $1 AND status = 'preview'", [project.id]);
  const { rows } = await pool.query(
    `INSERT INTO price_sheets (agency_id, project_id, uploaded_by, file_name, entries, summary, source) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING *`,
    [actor.agency_id, project.id, actor.id, fileName ? String(fileName).slice(0, 200) : null, JSON.stringify(entries), JSON.stringify(summary), source]
  );
  return { ok: true, sheet: rows[0] };
}

async function getSheet(db, actor, projectId, sheetId) {
  if (!isManager(actor) || !isId(sheetId) || !isId(projectId)) return null;
  const { rows } = await db.query("SELECT * FROM price_sheets WHERE id = $1 AND project_id = $2 AND agency_id = $3", [sheetId, projectId, actor.agency_id]);
  return rows[0] || null;
}

/** The project's sheets, newest first (the dated price lists). */
async function listSheets(db, actor, projectId, { limit = 10 } = {}) {
  const { rows } = await db.query(
    `SELECT s.id, s.file_name, s.status, s.summary, s.created_at, s.applied_at, b.name AS uploaded_by_name
     FROM price_sheets s LEFT JOIN brokers b ON b.id = s.uploaded_by
     WHERE s.project_id = $1 AND s.agency_id = $2 AND s.status <> 'discarded' ORDER BY s.created_at DESC LIMIT $3`,
    [projectId, actor.agency_id, limit]
  );
  return rows;
}

/** One price change; the first change of a unit also keeps the price it had before (previous). */
async function recordPrice(db, { agencyId, listingId, price, source, sheetId = null, by = null, at = new Date(), previous = null }) {
  if (previous && Number(previous) > 0) {
    const { rows } = await db.query("SELECT 1 FROM listing_prices WHERE listing_id = $1 LIMIT 1", [listingId]);
    if (!rows.length) await db.query("INSERT INTO listing_prices (agency_id, listing_id, price, source, changed_at) VALUES ($1, $2, $3, 'edit', $4)", [agencyId, listingId, Math.round(previous), new Date(at.getTime() - 1000).toISOString()]);
  }
  await db.query(
    "INSERT INTO listing_prices (agency_id, listing_id, price, source, sheet_id, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [agencyId, listingId, Math.round(price), source, sheetId, by, at.toISOString()]
  );
}

/** Listing fields of a new catalogue unit or model from a sheet entry and its project (and phase). */
function fieldsFor(entry, project, phase) {
  const year = phase?.delivery_year || project.delivery_year || null;
  const quarter = phase?.delivery_year ? phase.delivery_quarter : project.delivery_quarter;
  const floor = entry.floor && /^-?\d+$/.test(String(entry.floor)) ? Number(entry.floor) : null;
  return {
    property_type: entry.property_type || "apartment",
    listing_type: "sale",
    market: "primary",
    price_value: entry.price,
    area_value: entry.area,
    bedrooms: entry.bedrooms,
    compound: project.name,
    compound_en: project.name_en ? String(project.name_en).slice(0, 120) : null,
    district: project.district,
    city: project.city,
    floor_level: floor,
    delivery_year: year,
    delivery_quarter: year ? quarter || null : null,
    maintenance_pct: project.maintenance_pct,
    inventory_type: entry.kind === "model" ? "developer_model" : "primary_unit",
    payment_terms: {},
    location_keywords: [],
    feature_keys: [],
    features_other: [],
    details: {
      ...(entry.building ? { building: entry.building } : {}),
      ...(entry.floor && floor === null ? { floor: entry.floor } : {}),
      ...(entry.area_to ? { area_to: entry.area_to } : {}),
      ...(entry.garden ? { garden_area: entry.garden } : {}),
      ...(entry.roof ? { roof_area: entry.roof } : {}),
      ...(entry.price_from ? { price_from: true } : {}),
      catalogue: true
    }
  };
}

/** The phase a row's building/phase column names (by name, any case), or null. */
const phaseFor = (phases, entry) => (entry.building ? phases.find((p) => p.name.trim().toLowerCase() === entry.building.trim().toLowerCase()) || null : null);

/**
 * Applies a previewed sheet in one transaction: new units and models, price and status changes (with history),
 * units no longer listed marked sold when ticked (markSold: listing ids). The project's plans follow the new units.
 * @returns {{ ok, created, updated, sold } | { error }}
 */
async function apply(pool, actor, projectId, sheetId, { markSold = [], now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query(
      "UPDATE price_sheets SET status = 'applied', applied_at = $3 WHERE id = $1 AND project_id = $2 AND status = 'preview' RETURNING *",
      [sheetId, project.id, now.toISOString()]
    );
    const sheet = claimed[0];
    if (!sheet) {
      await client.query("ROLLBACK");
      return { error: "stale" };
    }
    const { rows: phases } = await client.query("SELECT * FROM project_phases WHERE project_id = $1", [project.id]);
    const owner = { agency_id: actor.agency_id, id: null };
    let created = 0;
    let updated = 0;
    let sold = 0;
    for (const e of sheet.entries) {
      if (e.action === "new") {
        const phase = phaseFor(phases, e);
        const res = await Store.createListing(client, owner, { fields: fieldsFor(e, project, phase), lang: "ar" });
        if (res.limit) {
          await client.query("ROLLBACK"); // the sheet stays a preview; nothing is half applied
          return { error: "unit_limit", limit: res.limit };
        }
        if (res.owner_required) {
          await client.query("ROLLBACK");
          return { error: "owner_required", code: e.code || null };
        }
        await client.query("UPDATE listings SET project_id = $2, phase_id = $3, developer_unit_code = $4 WHERE id = $1", [res.listing.id, project.id, phase?.id || null, e.dev_code]);
        await recordPrice(client, { agencyId: actor.agency_id, listingId: res.listing.id, price: e.price, source: "sheet", sheetId: sheet.id, by: actor.id, at: now });
        created++;
      } else if (e.action === "changed") {
        const { rows } = await client.query(
          `UPDATE listings SET price_value = $3, price_display = $4, status = CASE WHEN $5 THEN 'sold' WHEN status = 'sold' THEN 'active' ELSE status END,
                  version = version + 1, updated_at = $6
           WHERE id = $1 AND project_id = $2 RETURNING id, price_value`,
          [e.listing_id, project.id, e.price, T.formatAbbreviatedPrice(e.price, "EGP", "ar", "sale"), Boolean(e.sold), now.toISOString()]
        );
        if (!rows[0]) continue;
        if (e.old_price !== e.price) await recordPrice(client, { agencyId: actor.agency_id, listingId: e.listing_id, price: e.price, source: "sheet", sheetId: sheet.id, by: actor.id, at: now, previous: e.old_price });
        updated++;
      }
    }
    const removable = new Set(sheet.entries.filter((e) => e.action === "removed").map((e) => e.listing_id));
    const toSell = [].concat(markSold).filter((id) => removable.has(id));
    if (toSell.length) {
      const { rowCount } = await client.query(
        "UPDATE listings SET status = 'sold', version = version + 1, updated_at = $3 WHERE project_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'",
        [project.id, toSell, now.toISOString()]
      );
      sold = rowCount;
    }
    await client.query("UPDATE projects SET prices_updated_at = $2, stale_reminded_at = NULL, updated_at = $2 WHERE id = $1", [project.id, now.toISOString()]);
    await Catalogue.syncUnits(client, project.id);
    await client.query("COMMIT");
    return { ok: true, created, updated, sold };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function discard(pool, actor, projectId, sheetId) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!isId(sheetId) || !isId(projectId)) return { error: "not_found" };
  const { rowCount } = await pool.query("UPDATE price_sheets SET status = 'discarded' WHERE id = $1 AND project_id = $2 AND agency_id = $3 AND status = 'preview'", [sheetId, projectId, actor.agency_id]);
  return rowCount ? { ok: true } : { error: "not_found" };
}

/** A unit's price history, newest first. */
async function history(db, listing, { limit = 12 } = {}) {
  const { rows } = await db.query(
    "SELECT price, source, changed_at FROM listing_prices WHERE listing_id = $1 AND agency_id = $2 ORDER BY changed_at DESC, id DESC LIMIT $3",
    [listing.id, listing.agency_id, limit]
  );
  return rows.map((r) => ({ ...r, price: Number(r.price) }));
}

/** Records a price change made elsewhere (the unit form, a quick update) so the history stays complete. */
async function noteEdit(db, listing, price, { by = null, source = "edit", now = new Date() } = {}) {
  if (!listing?.id || !price) return;
  await recordPrice(db, { agencyId: listing.agency_id, listingId: listing.id, price, source, by, at: now });
}

/* ---------------------------------------------------------------------- */
/* Announced increases                                                     */
/* ---------------------------------------------------------------------- */

/**
 * "+7% from 1 November" for a project or one phase. A date today or earlier applies right away.
 * @returns {{ ok, increase, applied } | { error }}
 */
async function scheduleIncrease(pool, actor, projectId, { pct, effectiveOn, phaseId = null, now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  const raw = String(pct ?? "").trim().replace(/\s+/g, "");
  const negative = /^[-−]/.test(raw);
  const p = Catalogue.num(raw.replace(/^[+\-−]/, ""));
  const value = p === null || Number.isNaN(p) ? NaN : negative ? -p : p;
  if (!Number.isFinite(value) || value === 0 || value > 100 || value < -50) return { error: "invalid", field: "pct" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveOn || "")) || Number.isNaN(Date.parse(effectiveOn))) return { error: "invalid", field: "effective_on" };
  let phase = null;
  if (phaseId) {
    const { rows } = isId(phaseId) ? await pool.query("SELECT id FROM project_phases WHERE id = $1 AND project_id = $2", [phaseId, project.id]) : { rows: [] };
    if (!rows[0]) return { error: "invalid", field: "phase_id" };
    phase = rows[0].id;
  }
  const { rows } = await pool.query(
    "INSERT INTO price_increases (agency_id, project_id, phase_id, pct, effective_on, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
    [actor.agency_id, project.id, phase, value, effectiveOn, actor.id]
  );
  let applied = null;
  if (effectiveOn <= cairoDay(now)) applied = await applyIncrease(pool, rows[0], { now });
  return { ok: true, increase: rows[0], applied };
}

const cairoDay = (now) => Stages.toCairoLocal(now).slice(0, 10);

async function cancelIncrease(pool, actor, projectId, increaseId) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!isId(increaseId) || !isId(projectId)) return { error: "not_found" };
  const { rowCount } = await pool.query("UPDATE price_increases SET status = 'cancelled' WHERE id = $1 AND project_id = $2 AND agency_id = $3 AND status = 'scheduled'", [increaseId, projectId, actor.agency_id]);
  return rowCount ? { ok: true } : { error: "not_found" };
}

async function listIncreases(db, actor, projectId) {
  const { rows } = await db.query(
    `SELECT i.*, ph.name AS phase_name FROM price_increases i LEFT JOIN project_phases ph ON ph.id = i.phase_id
     WHERE i.project_id = $1 AND i.agency_id = $2 AND i.status <> 'cancelled' ORDER BY i.effective_on DESC LIMIT 20`,
    [projectId, actor.agency_id]
  );
  return rows;
}

/** Moves every active priced catalogue unit of the project (or phase; resale units linked by brokers keep their price) by the %, rounded to the nearest 1,000; once. */
async function applyIncrease(pool, inc, { now = new Date() } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: claimed } = await client.query("UPDATE price_increases SET status = 'applied', applied_at = $2 WHERE id = $1 AND status = 'scheduled' RETURNING *", [inc.id, now.toISOString()]);
    if (!claimed[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows: units } = await client.query(
      "SELECT id, agency_id, price_value FROM listings WHERE " + Vis.units("listings") + " AND project_id = $1 AND status = 'active' AND price_value > 0 AND details->>'catalogue' = 'true' AND ($2::uuid IS NULL OR phase_id = $2) FOR UPDATE",
      [inc.project_id, inc.phase_id]
    );
    for (const u of units) {
      const price = round1000(Number(u.price_value) * (1 + Number(inc.pct) / 100));
      await client.query("UPDATE listings SET price_value = $2, price_display = $3, version = version + 1, updated_at = $4 WHERE id = $1", [u.id, price, T.formatAbbreviatedPrice(price, "EGP", "ar", "sale"), now.toISOString()]);
      await recordPrice(client, { agencyId: u.agency_id, listingId: u.id, price, source: "increase", by: inc.created_by, at: now, previous: u.price_value });
    }
    await client.query("UPDATE price_increases SET units = $2 WHERE id = $1", [inc.id, units.length]);
    await client.query("UPDATE projects SET prices_updated_at = $2, stale_reminded_at = NULL WHERE id = $1", [inc.project_id, now.toISOString()]);
    await client.query("COMMIT");
    return { units: units.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Scheduler: applies the increases due today (Cairo) or earlier. */
async function applyDueIncreases(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query("SELECT * FROM price_increases WHERE status = 'scheduled' AND effective_on <= $1::date ORDER BY effective_on LIMIT 20", [cairoDay(now)]);
  let units = 0;
  for (const inc of rows) units += (await applyIncrease(pool, inc, { now }))?.units || 0;
  return { applied: rows.length, units };
}

/* ---------------------------------------------------------------------- */
/* Freshness                                                               */
/* ---------------------------------------------------------------------- */

/** "fresh" | "stale" (30+ days since the last sheet or increase) | "never" (catalogue units, no sheet yet) | null. */
function freshness(project, { now = new Date() } = {}) {
  if (!project.prices_updated_at) return null;
  return now.getTime() - new Date(project.prices_updated_at).getTime() > STALE_DAYS * DAY ? "stale" : "fresh";
}

/** Scheduler: managers hear about selling projects without new prices for 30 days, once per 30 days per project. */
async function staleReminders(pool, { now = new Date(), notify = null } = {}) {
  const cutoff = new Date(now.getTime() - STALE_DAYS * DAY).toISOString();
  const { rows } = await pool.query(
    `SELECT id, agency_id, name, prices_updated_at FROM projects
     WHERE archived_at IS NULL AND status <> 'sold_out' AND prices_updated_at IS NOT NULL AND prices_updated_at < $1
       AND (stale_reminded_at IS NULL OR stale_reminded_at < $1)
     ORDER BY prices_updated_at LIMIT 50`,
    [cutoff]
  );
  const Notifications = require("../lib/notifications");
  for (const p of rows) {
    const days = Math.floor((now.getTime() - new Date(p.prices_updated_at).getTime()) / DAY);
    if (notify) await notify(p, days);
    else
      for (const m of await Notifications.managersOf(pool, p.agency_id)) {
        const en = m.preferred_lang === "en";
        await Notifications.notifyBroker(pool, m, {
          kind: "manager_alert",
          dedupeKey: `prices_stale:${p.id}:${cairoDay(now)}`,
          title: en ? `🏷️ ${p.name}: prices not updated for ${days} days` : `🏷️ ${p.name}: الأسعار متحدثتش من ${days} يوم`,
          body: en ? "Upload the developer's latest sheet so brokers quote the right prices." : "ارفع آخر شيت من المطور عشان الوسطاء يقولوا السعر الصح.",
          url: `/app/catalogue/projects/${p.id}#prices`,
          now
        });
      }
    await pool.query("UPDATE projects SET stale_reminded_at = $2 WHERE id = $1", [p.id, now.toISOString()]);
  }
  return { reminded: rows.length };
}

const pricesJob = () => ({
  name: "catalogue_prices",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool, now }) => ({ ...(await applyDueIncreases(pool, { now })), ...(await staleReminders(pool, { now })) })
});

module.exports = {
  storePreview,
  projectOf,
  STALE_DAYS,
  upload,
  getSheet,
  listSheets,
  apply,
  discard,
  history,
  noteEdit,
  scheduleIncrease,
  cancelIncrease,
  listIncreases,
  applyIncrease,
  applyDueIncreases,
  freshness,
  staleReminders,
  pricesJob,
  fieldsFor
};
