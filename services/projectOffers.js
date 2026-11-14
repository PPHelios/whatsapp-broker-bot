// services/projectOffers.js — A project's offers (area, price, down payment, installment) as rows (project_offers), read from the
// project's notes whenever the notes change. Ask reads these rows, so every filter is exact and fast for 300+ projects.
// The notes stay the text a broker edits; nothing here writes to units.
"use strict";

const crypto = require("crypto");
const ProjectNotes = require("../domain/projectNotes");
const { withTransaction } = require("../lib/db");

const hashOf = (notes) => crypto.createHash("md5").update(String(notes || "")).digest("hex");
const n = (v) => (v == null ? null : Number(v));

/** Reads the notes of the agency's active projects whose rows are out of date (new notes, or never read) into project_offers. */
async function sync(pool, agencyId) {
  const { rows } = await pool.query("SELECT id, notes, offers_hash FROM projects WHERE agency_id = $1 AND archived_at IS NULL", [agencyId]);
  let changed = 0;
  for (const p of rows) {
    const hash = hashOf(p.notes);
    if (p.offers_hash === hash) continue;
    const units = ProjectNotes.parseUnits(p.notes);
    await withTransaction(pool, async (client) => {
      await client.query("DELETE FROM project_offers WHERE project_id = $1 AND agency_id = $2 AND source = 'notes'", [p.id, agencyId]);
      for (const u of units) {
        await client.query(
          `INSERT INTO project_offers (agency_id, project_id, area, floor, bedrooms, price, down, monthly, monthly_est, years, raw, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'notes')`,
          [agencyId, p.id, u.area, u.floor, u.bedrooms, u.price, u.down, u.monthly, u.monthly_est, u.years, u.raw]
        );
      }
      await client.query("UPDATE projects SET offers_hash = $3 WHERE id = $1 AND agency_id = $2", [p.id, agencyId, hash]);
    });
    changed++;
  }
  return changed;
}

/** The agency's active projects that have offers: [{ project, units: [{ area, floor, bedrooms, price, down, monthly, monthly_est, years, raw }] }]. */
async function projectsWithOffers(pool, agencyId) {
  await sync(pool, agencyId);
  const { rows: projects } = await pool.query(
    "SELECT id, name, name_en, developer_name, district, city, status, delivery_year, notes, updated_at FROM projects WHERE agency_id = $1 AND archived_at IS NULL",
    [agencyId]
  );
  const { rows: offers } = await pool.query("SELECT * FROM project_offers WHERE agency_id = $1 ORDER BY price, id", [agencyId]);
  const byProject = new Map();
  for (const o of offers) {
    if (!byProject.has(o.project_id)) byProject.set(o.project_id, []);
    byProject.get(o.project_id).push({
      area: n(o.area),
      floor: o.floor,
      bedrooms: n(o.bedrooms),
      price: n(o.price),
      down: n(o.down),
      monthly: n(o.monthly),
      monthly_est: n(o.monthly_est),
      years: n(o.years),
      raw: o.raw
    });
  }
  return projects.map((p) => ({ project: p, units: byProject.get(p.id) || [] })).filter((x) => x.units.length);
}

module.exports = { sync, projectsWithOffers, hashOf };
