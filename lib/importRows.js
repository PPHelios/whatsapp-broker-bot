// lib/importRows.js — The rows of a unified unit import (migration 058). One row per unit in the plan: where it came
// from, its kind (new, changed, duplicate code, …), whether it is ticked, its fields, photos and reasons. A tab is a
// page of one kind; a tick or an edited row touches only that row.
"use strict";

const TABS = ["ready", "new", "changed", "unchanged", "duplicate_code", "duplicate_unit", "invalid", "forbidden", "photos_only"];
const KINDS = ["new", "changed", "unchanged", "invalid", "forbidden", "duplicate_code", "duplicate_unit", "photos_only"];
const PAGE = 50;

/** Replaces the rows of an import with these (used when a plan is made). Runs in its own transaction. */
async function replaceRows(pool, importId, agencyId, rows) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM import_rows WHERE import_id = $1 AND agency_id = $2", [importId, agencyId]);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const values = [];
      const marks = chunk.map((r, k) => {
        const b = k * 9;
        values.push(importId, agencyId, i + k + 1, r.source, r.code || null, r.kind, Boolean(r.ticked), JSON.stringify(r.data || {}), JSON.stringify(r.reasons || []));
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}::jsonb, $${b + 9}::jsonb)`;
      });
      await client.query(
        `INSERT INTO import_rows (import_id, agency_id, seq, source, code, kind, ticked, data, reasons) VALUES ${marks.join(", ")}`,
        values
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Counts per tab (ready = ticked rows of any kind except photos_only, unchanged, invalid and forbidden). */
async function counts(pool, importId, agencyId) {
  const { rows } = await pool.query(
    `SELECT kind, count(*)::int AS n, count(*) FILTER (WHERE ticked)::int AS ticked FROM import_rows WHERE import_id = $1 AND agency_id = $2 GROUP BY kind`,
    [importId, agencyId]
  );
  const out = Object.fromEntries(TABS.map((t) => [t, 0]));
  for (const r of rows) {
    out[r.kind] = r.n;
    out.ready += r.kind === "new" || r.kind === "changed" ? r.ticked : 0;
  }
  return out;
}

/** One page of a tab (seq order), with the total for paging. */
async function page(pool, importId, agencyId, tab, { offset = 0, limit = PAGE } = {}) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(PAGE, Math.max(1, Number(limit) || PAGE));
  if (tab === "ready") {
    const { rows } = await pool.query(
      `SELECT * FROM import_rows WHERE import_id = $1 AND agency_id = $2 AND kind IN ('new', 'changed') AND ticked ORDER BY seq LIMIT $3 OFFSET $4`,
      [importId, agencyId, lim, off]
    );
    const { rows: t } = await pool.query("SELECT count(*)::int AS n FROM import_rows WHERE import_id = $1 AND agency_id = $2 AND kind IN ('new', 'changed') AND ticked", [importId, agencyId]);
    return { rows, total: t[0].n };
  }
  if (!KINDS.includes(tab)) throw Object.assign(new Error("unknown tab"), { code: "BAD_TAB" });
  const { rows } = await pool.query("SELECT * FROM import_rows WHERE import_id = $1 AND agency_id = $2 AND kind = $3 ORDER BY seq LIMIT $4 OFFSET $5", [importId, agencyId, tab, lim, off]);
  const { rows: t } = await pool.query("SELECT count(*)::int AS n FROM import_rows WHERE import_id = $1 AND agency_id = $2 AND kind = $3", [importId, agencyId, tab]);
  return { rows, total: t[0].n };
}

/** Ticks or unticks rows by sequence number (only ones of this import). Returns how many changed. */
async function setTicked(pool, importId, agencyId, seqs, ticked) {
  const list = [...new Set(seqs.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return 0;
  const { rowCount } = await pool.query("UPDATE import_rows SET ticked = $4 WHERE import_id = $1 AND agency_id = $2 AND seq = ANY($3::int[])", [importId, agencyId, list, Boolean(ticked)]);
  return rowCount;
}

/** One row by sequence number, for the editor. */
async function getRow(pool, importId, agencyId, seq) {
  const { rows } = await pool.query("SELECT * FROM import_rows WHERE import_id = $1 AND agency_id = $2 AND seq = $3", [importId, agencyId, Number(seq)]);
  return rows[0] || null;
}

/** Every ticked row of the import, in order (what Apply works on). */
async function tickedRows(pool, importId, agencyId) {
  const { rows } = await pool.query("SELECT * FROM import_rows WHERE import_id = $1 AND agency_id = $2 AND ticked ORDER BY seq", [importId, agencyId]);
  return rows;
}

module.exports = { TABS, KINDS, PAGE, replaceRows, counts, page, setTicked, getRow, tickedRows };
