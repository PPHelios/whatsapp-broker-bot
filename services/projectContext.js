// services/projectContext.js — Each project's stored context for the assistant (Release B, C10). contextFor() returns
// the stored context when its source key still matches (the project, its prices, plans, phases, units, materials and
// brochure are unchanged) and rebuilds and stores it otherwise, so answers are quick and never use stale data.
"use strict";

const C = require("../domain/projectContext");

async function load(db, agencyId, projectId) {
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [projectId, agencyId]);
  const project = rows[0];
  if (!project) return null;
  const [dev, phases, plans, units, materials] = await Promise.all([
    project.developer_id ? db.query("SELECT name FROM developers WHERE id = $1", [project.developer_id]) : { rows: [] },
    db.query("SELECT name, status, delivery_year, delivery_quarter, created_at FROM project_phases WHERE project_id = $1 ORDER BY created_at", [project.id]),
    db.query("SELECT name, down_payment_pct, years, frequency, discount_pct, maintenance_pct, updated_at FROM project_plans WHERE project_id = $1 ORDER BY position, created_at", [project.id]),
    db.query("SELECT property_type, price_value, area_value, bedrooms, status, details, updated_at FROM listings WHERE project_id = $1 AND agency_id = $2", [project.id, agencyId]),
    db.query("SELECT label, kind, url, client_visible, check_status, created_at FROM project_materials WHERE project_id = $1 ORDER BY created_at", [project.id])
  ]);
  const key = (rs, f) => `${rs.length}:${rs.reduce((m, r) => (r[f] && new Date(r[f]).getTime() > m ? new Date(r[f]).getTime() : m), 0)}`;
  return {
    project,
    developer: dev.rows[0] || null,
    phases: phases.rows,
    plans: plans.rows,
    units: units.rows,
    materials: materials.rows,
    unitsKey: key(units.rows, "updated_at"),
    plansKey: key(plans.rows, "updated_at"),
    phasesKey: key(phases.rows, "created_at"),
    materialsKey: `${key(materials.rows, "created_at")}:${materials.rows.map((m) => `${m.client_visible ? 1 : 0}${m.check_status || ""}`).join("")}`
  };
}

/** The project's context: { summary, facts, built_at, fresh } (fresh = rebuilt now) | null. */
async function contextFor(db, agencyId, projectId, { now = new Date() } = {}) {
  const data = await load(db, agencyId, projectId);
  if (!data) return null;
  const key = C.sourceKey(data);
  const { rows } = await db.query("SELECT summary, facts, built_at, source_key FROM project_contexts WHERE project_id = $1", [projectId]);
  if (rows[0] && rows[0].source_key === key) return { summary: rows[0].summary, facts: rows[0].facts, built_at: rows[0].built_at, fresh: false };
  const ctx = C.build(data);
  await db.query(
    `INSERT INTO project_contexts (project_id, agency_id, summary, facts, source_key, built_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (project_id) DO UPDATE SET summary = EXCLUDED.summary, facts = EXCLUDED.facts, source_key = EXCLUDED.source_key, built_at = EXCLUDED.built_at`,
    [projectId, agencyId, ctx.summary, JSON.stringify(ctx.facts), key, now.toISOString()]
  );
  return { ...ctx, built_at: now, fresh: true };
}

module.exports = { contextFor };
