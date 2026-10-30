// services/catalogue.js — The developer catalogue (Release A, C1), per agency: developers, projects with phases,
// payment plans (with extra fees) and materials (links, client-visible or internal, checked weekly).
// Managers edit; every broker reads. A developer's sales contact and internal links are for the agency only.
// A project's units stay ordinary listings: their payment_terms.plans are kept in step with the project's plans
// (a unit that has its own plans, payment_terms.plans_own, keeps them).
"use strict";

const { isManager, canEdit } = require("../lib/authz");
const { normalizeArabicDigits } = require("../lib/listingText");
const crypto = require("crypto");
const Storage = require("../lib/supabase");
const Vis = require("../lib/visibility");

const STATUSES = ["launching", "selling", "sold_out"];
const KINDS = ["master_plan", "brochure", "layout", "video", "location", "website", "price_sheet", "other"];
const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"];
const MAINTENANCE_DUE = ["delivery", "installments", "contract"];
const MAX_MILESTONES = 4;
const MAX_FEES = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILE_TYPES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "text/csv": "csv" };
// Browsers often send a sheet as octet-stream; its extension decides then.
const typeOf = (file) => FILE_TYPES[file?.mimetype] || { xlsx: "xlsx", csv: "csv" }[String(file?.originalname || "").split(".").pop().toLowerCase()];
const MAX_FILE_MB = 25;
const isId = (v) => UUID_RE.test(String(v || ""));
const text = (v, max) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
/** A number typed in a form (Arabic digits and thousands commas allowed); null when empty; NaN when not a number. */
function num(v) {
  const s = normalizeArabicDigits(String(v ?? "")).replace(/[,،\s]/g, "").replace(/٫/g, ".").replace(/%$/, "");
  if (s === "") return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
const bad = (field) => ({ error: "invalid", field });

/* ---------------------------------------------------------------------- */
/* Developers                                                              */
/* ---------------------------------------------------------------------- */

async function listDevelopers(db, actor) {
  const { rows } = await db.query(
    `SELECT d.*, (SELECT count(*)::int FROM projects p WHERE p.developer_id = d.id AND p.archived_at IS NULL) AS projects
     FROM developers d WHERE d.agency_id = $1 ORDER BY lower(d.name)`,
    [actor.agency_id]
  );
  return rows.map((d) => (isManager(actor) ? d : publicDeveloper(d)));
}

/** What a broker (not a manager) may see of a developer: no sales contact, no notes. */
const publicDeveloper = (d) => d && { id: d.id, agency_id: d.agency_id, name: d.name, name_en: d.name_en, projects: d.projects };

async function getDeveloper(db, actor, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query("SELECT * FROM developers WHERE id = $1 AND agency_id = $2", [id, actor.agency_id]);
  if (!rows[0]) return null;
  return isManager(actor) ? rows[0] : publicDeveloper(rows[0]);
}

function developerFields(input) {
  const name = text(input.name, 120);
  if (!name) return bad("name");
  const phone = text(input.contact_phone, 30);
  if (phone && !/^[+\d\s()-]{6,30}$/.test(normalizeArabicDigits(phone))) return bad("contact_phone");
  return {
    fields: {
      name,
      name_en: text(input.name_en, 120),
      contact_name: text(input.contact_name, 120),
      contact_phone: phone ? normalizeArabicDigits(phone) : null,
      notes: text(input.notes, 1000)
    }
  };
}

/** Creates (no id) or updates a developer. { ok, developer } | { error: forbidden | invalid | duplicate | not_found } */
async function saveDeveloper(db, actor, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const v = developerFields(input);
  if (v.error) return v;
  const f = v.fields;
  try {
    if (input.id) {
      if (!isId(input.id)) return { error: "not_found" };
      const { rows } = await db.query(
        `UPDATE developers SET name = $3, name_en = $4, contact_name = $5, contact_phone = $6, notes = $7, updated_at = now()
         WHERE id = $1 AND agency_id = $2 RETURNING *`,
        [input.id, actor.agency_id, f.name, f.name_en, f.contact_name, f.contact_phone, f.notes]
      );
      return rows[0] ? { ok: true, developer: rows[0] } : { error: "not_found" };
    }
    const { rows } = await db.query(
      `INSERT INTO developers (agency_id, name, name_en, contact_name, contact_phone, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [actor.agency_id, f.name, f.name_en, f.contact_name, f.contact_phone, f.notes]
    );
    return { ok: true, developer: rows[0] };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate", field: "name" };
    throw e;
  }
}

/** The agency's developer with that name (any case), created when missing (managers only). */
async function developerByName(db, actor, name) {
  const n = text(name, 120);
  if (!n) return null;
  const { rows } = await db.query("SELECT * FROM developers WHERE agency_id = $1 AND lower(btrim(name)) = lower($2)", [actor.agency_id, n]);
  if (rows[0]) return rows[0];
  const r = await saveDeveloper(db, actor, { name: n });
  return r.developer || null;
}

/* ---------------------------------------------------------------------- */
/* Projects and phases                                                     */
/* ---------------------------------------------------------------------- */

async function listProjects(db, actor, { archived = false, developerId = null } = {}) {
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.name_en, p.status, p.district, p.city, p.delivery_year, p.delivery_quarter, p.prices_updated_at,
            p.archived_at, p.developer_id, d.name AS developer_name_ar, d.name_en AS developer_name_en,
            (SELECT count(*)::int FROM listings l WHERE ${Vis.units("l")} AND l.project_id = p.id AND l.status = 'active') AS units,
            (SELECT count(*)::int FROM project_plans pl WHERE pl.project_id = p.id) AS plans
     FROM projects p LEFT JOIN developers d ON d.id = p.developer_id
     WHERE p.agency_id = $1 AND (p.archived_at IS NOT NULL) = $2 AND ($3::uuid IS NULL OR p.developer_id = $3)
     ORDER BY lower(p.name)`,
    [actor.agency_id, Boolean(archived), isId(developerId) ? developerId : null]
  );
  return rows;
}

function projectFields(input) {
  const name = text(input.name, 120);
  if (!name) return bad("name");
  const status = input.status || "selling";
  if (!STATUSES.includes(status)) return bad("status");
  const year = num(input.delivery_year);
  if (Number.isNaN(year) || (year !== null && (year < 2000 || year > 2100 || !Number.isInteger(year)))) return bad("delivery_year");
  const quarter = num(input.delivery_quarter);
  if (Number.isNaN(quarter) || (quarter !== null && ![1, 2, 3, 4].includes(quarter))) return bad("delivery_quarter");
  const maint = num(input.maintenance_pct);
  if (Number.isNaN(maint) || (maint !== null && maint > 30)) return bad("maintenance_pct");
  return {
    fields: {
      name,
      name_en: text(input.name_en, 120),
      status,
      district: text(input.district, 80),
      city: text(input.city, 80),
      delivery_year: year,
      delivery_quarter: year ? quarter : null,
      maintenance_pct: maint,
      notes: text(input.notes, 1000)
    }
  };
}

/** The developer a project form names: an id from the list, or a new name (created). */
async function resolveDeveloper(db, actor, input) {
  if (isId(input.developer_id)) {
    const d = await getDeveloper(db, actor, input.developer_id);
    return d ? { developer: d } : { error: "invalid", field: "developer_id" };
  }
  if (text(input.developer_name, 120)) return { developer: await developerByName(db, actor, input.developer_name) };
  return { developer: null };
}

/** Creates (no id) or updates a project. { ok, project } | { error: forbidden | invalid | duplicate | not_found } */
async function saveProject(db, actor, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const v = projectFields(input);
  if (v.error) return v;
  // The project's agency-only map pin (its units inherit it); empty clears, a field left out keeps it.
  const pinGiven = input.pin !== undefined;
  const pin = pinGiven && String(input.pin).trim() ? require("./unitPrivacy").parsePin(input.pin) : null;
  if (pinGiven && String(input.pin).trim() && !pin) return { error: "invalid", field: "pin" };
  const dev = await resolveDeveloper(db, actor, input);
  if (dev.error) return dev;
  const f = v.fields;
  const savePin = async (row) => {
    if (!pinGiven) return row;
    const { rows } = await db.query("UPDATE projects SET lat = $3, lng = $4 WHERE id = $1 AND agency_id = $2 RETURNING *", [row.id, actor.agency_id, pin?.lat ?? null, pin?.lng ?? null]);
    return rows[0] || row;
  };
  const devName = dev.developer ? dev.developer.name : null;
  const params = [f.name, f.name_en, f.status, f.district, f.city, f.delivery_year, f.delivery_quarter, f.maintenance_pct, f.notes, dev.developer?.id || null, devName];
  try {
    if (input.id) {
      if (!isId(input.id)) return { error: "not_found" };
      const { rows } = await db.query(
        `UPDATE projects SET name = $3, name_en = $4, status = $5, district = $6, city = $7, delivery_year = $8, delivery_quarter = $9,
                maintenance_pct = $10, notes = $11, developer_id = $12, developer_name = $13, updated_at = now()
         WHERE id = $1 AND agency_id = $2 RETURNING *`,
        [input.id, actor.agency_id, ...params]
      );
      if (!rows[0]) return { error: "not_found" };
      await syncUnits(db, rows[0].id);
      return { ok: true, project: await savePin(rows[0]) };
    }
    const { rows } = await db.query(
      `INSERT INTO projects (agency_id, name, name_en, status, district, city, delivery_year, delivery_quarter, maintenance_pct, notes, developer_id, developer_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [actor.agency_id, ...params]
    );
    return { ok: true, project: await savePin(rows[0]) };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate", field: "name" };
    throw e;
  }
}

/** Archive (hidden from the list, units untouched) or restore. */
async function archiveProject(db, actor, id, archived = true) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!isId(id)) return { error: "not_found" };
  const { rowCount } = await db.query(
    "UPDATE projects SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END, updated_at = now() WHERE id = $1 AND agency_id = $2",
    [id, actor.agency_id, Boolean(archived)]
  );
  return rowCount ? { ok: true } : { error: "not_found" };
}

async function projectRow(db, actor, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [id, actor.agency_id]);
  return rows[0] || null;
}

/**
 * One project with its developer, phases, plans, materials and units. Brokers get no developer contact and no notes;
 * they see internal links too (marked), which clients never do.
 */
async function getProject(db, actor, id) {
  const project = await projectRow(db, actor, id);
  if (!project) return null;
  const [developer, phases, plans, materials, units] = await Promise.all([
    project.developer_id ? getDeveloper(db, actor, project.developer_id) : null,
    db.query("SELECT * FROM project_phases WHERE project_id = $1 ORDER BY created_at", [id]).then((r) => r.rows),
    db.query("SELECT * FROM project_plans WHERE project_id = $1 ORDER BY position, created_at", [id]).then((r) => r.rows),
    db.query("SELECT * FROM project_materials WHERE project_id = $1 ORDER BY created_at", [id]).then((r) => r.rows),
    db
      .query(
        `SELECT id, code, property_type, area_value, bedrooms, price_value, status, phase_id, developer_unit_code, inventory_type, details
         FROM listings WHERE ${Vis.units("listings")} AND project_id = $1 AND agency_id = $2 ORDER BY status, code LIMIT 200`,
        [id, actor.agency_id]
      )
      .then((r) => r.rows)
  ]);
  return { project: isManager(actor) ? project : { ...project, notes: null }, developer, phases, plans, materials, units };
}

async function savePhase(db, actor, projectId, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project) return { error: "not_found" };
  const name = text(input.name, 80);
  if (!name) return bad("phase_name");
  const status = input.status || "selling";
  if (!STATUSES.includes(status)) return bad("phase_status");
  const year = num(input.delivery_year);
  if (Number.isNaN(year) || (year !== null && (year < 2000 || year > 2100 || !Number.isInteger(year)))) return bad("phase_delivery_year");
  const quarter = num(input.delivery_quarter);
  if (Number.isNaN(quarter) || (quarter !== null && ![1, 2, 3, 4].includes(quarter))) return bad("phase_delivery_quarter");
  try {
    if (input.id) {
      if (!isId(input.id)) return { error: "not_found" };
      const { rows } = await db.query(
        `UPDATE project_phases SET name = $3, status = $4, delivery_year = $5, delivery_quarter = $6
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [input.id, project.id, name, status, year, year ? quarter : null]
      );
      return rows[0] ? { ok: true, phase: rows[0] } : { error: "not_found" };
    }
    const { rows } = await db.query(
      `INSERT INTO project_phases (agency_id, project_id, name, status, delivery_year, delivery_quarter) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [actor.agency_id, project.id, name, status, year, year ? quarter : null]
    );
    return { ok: true, phase: rows[0] };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate", field: "phase_name" };
    throw e;
  }
}

/** Deletes a phase: its own plans go with it, its units stay in the project. */
async function deletePhase(db, actor, projectId, phaseId) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project || !isId(phaseId)) return { error: "not_found" };
  const { rowCount } = await db.query("DELETE FROM project_phases WHERE id = $1 AND project_id = $2", [phaseId, project.id]);
  if (rowCount) await syncUnits(db, project.id);
  return rowCount ? { ok: true } : { error: "not_found" };
}

/* ---------------------------------------------------------------------- */
/* Payment plans                                                           */
/* ---------------------------------------------------------------------- */

/**
 * Validates a plan form. Milestones and fees come as parallel arrays (milestone_pct[], milestone_months[],
 * milestone_label[]; fee_label[], fee_amount[]); empty rows are skipped. Anything not stated stays blank.
 */
function planFields(input) {
  const name = text(input.name, 80);
  if (!name) return bad("plan_name");
  const dp = num(input.down_payment_pct);
  if (dp === null || Number.isNaN(dp) || dp > 100) return bad("down_payment_pct");
  const years = num(input.years) ?? 0;
  if (Number.isNaN(years) || years > 20) return bad("years");
  const frequency = input.frequency || "quarterly";
  if (!FREQUENCIES.includes(frequency)) return bad("frequency");
  const discount = num(input.discount_pct) ?? 0;
  if (Number.isNaN(discount) || discount > 100) return bad("discount_pct");
  const maint = num(input.maintenance_pct);
  if (Number.isNaN(maint) || (maint !== null && maint > 30)) return bad("maintenance_pct");
  const maintDue = maint === null ? null : input.maintenance_due || "delivery";
  if (maintDue && !MAINTENANCE_DUE.includes(maintDue)) return bad("maintenance_due");
  const splits = num(input.maintenance_splits);
  if (Number.isNaN(splits) || (splits !== null && (splits < 1 || splits > 12 || !Number.isInteger(splits)))) return bad("maintenance_splits");

  const list = (k) => [].concat(input[k] ?? []);
  const milestones = [];
  const mp = list("milestone_pct");
  const mm = list("milestone_months");
  const ml = list("milestone_label");
  for (let i = 0; i < mp.length; i++) {
    const pct = num(mp[i]);
    if (pct === null) continue;
    const months = num(mm[i]) ?? 0;
    if (Number.isNaN(pct) || pct <= 0 || pct > 100 || Number.isNaN(months) || months > 240) return bad("milestones");
    milestones.push({ pct, due_after_months: Math.round(months), label: text(ml[i], 60) });
  }
  if (milestones.length > MAX_MILESTONES) return bad("milestones");
  if (dp + milestones.reduce((s, m) => s + m.pct, 0) > 100) return bad("milestones");

  const fees = [];
  const fl = list("fee_label");
  const fa = list("fee_amount");
  for (let i = 0; i < Math.max(fl.length, fa.length); i++) {
    const label = text(fl[i], 60);
    const amount = num(fa[i]);
    if (!label && amount === null) continue;
    if (!label || amount === null || Number.isNaN(amount) || amount <= 0 || amount > 1e9) return bad("extra_fees");
    fees.push({ label, amount: Math.round(amount) });
  }
  if (fees.length > MAX_FEES) return bad("extra_fees");

  return {
    fields: {
      name,
      down_payment_pct: dp,
      years,
      frequency,
      discount_pct: discount,
      milestones,
      maintenance_pct: maint,
      maintenance_due: maintDue,
      maintenance_splits: maint === null ? null : splits,
      extra_fees: fees
    }
  };
}

async function savePlan(db, actor, projectId, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project) return { error: "not_found" };
  const v = planFields(input);
  if (v.error) return v;
  let phaseId = null;
  if (input.phase_id) {
    const { rows } = isId(input.phase_id) ? await db.query("SELECT id FROM project_phases WHERE id = $1 AND project_id = $2", [input.phase_id, project.id]) : { rows: [] };
    if (!rows[0]) return bad("phase_id");
    phaseId = rows[0].id;
  }
  const f = v.fields;
  const params = [phaseId, f.name, f.down_payment_pct, f.years, f.frequency, f.discount_pct, JSON.stringify(f.milestones), f.maintenance_pct, f.maintenance_due, f.maintenance_splits, JSON.stringify(f.extra_fees)];
  let plan;
  if (input.id) {
    if (!isId(input.id)) return { error: "not_found" };
    const { rows } = await db.query(
      `UPDATE project_plans SET phase_id = $3, name = $4, down_payment_pct = $5, years = $6, frequency = $7, discount_pct = $8,
              milestones = $9::jsonb, maintenance_pct = $10, maintenance_due = $11, maintenance_splits = $12, extra_fees = $13::jsonb, updated_at = now()
       WHERE id = $1 AND project_id = $2 RETURNING *`,
      [input.id, project.id, ...params]
    );
    plan = rows[0];
    if (!plan) return { error: "not_found" };
  } else {
    const { rows } = await db.query(
      `INSERT INTO project_plans (agency_id, project_id, phase_id, name, down_payment_pct, years, frequency, discount_pct, milestones,
                                  maintenance_pct, maintenance_due, maintenance_splits, extra_fees, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb,
               (SELECT COALESCE(max(position), -1) + 1 FROM project_plans WHERE project_id = $2)) RETURNING *`,
      [actor.agency_id, project.id, ...params]
    );
    plan = rows[0];
  }
  await syncUnits(db, project.id);
  return { ok: true, plan };
}

async function deletePlan(db, actor, projectId, planId) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project || !isId(planId)) return { error: "not_found" };
  const { rowCount } = await db.query("DELETE FROM project_plans WHERE id = $1 AND project_id = $2", [planId, project.id]);
  if (rowCount) await syncUnits(db, project.id);
  return rowCount ? { ok: true } : { error: "not_found" };
}

/** A project plan as a unit's payment_terms plan (the shape lib/financials.js and the bot read). */
function unitPlan(p, project) {
  const maint = p.maintenance_pct ?? project.maintenance_pct;
  return {
    plan_id: `project:${p.id}`,
    source: "project",
    name: p.name,
    down_payment_pct: Number(p.down_payment_pct),
    years: Number(p.years),
    frequency: p.frequency,
    discount_pct: Number(p.discount_pct),
    milestones: p.milestones || [],
    maintenance_pct: maint === null || maint === undefined ? null : Number(maint),
    ...(p.maintenance_due ? { maintenance_due: p.maintenance_due } : {}),
    ...(p.maintenance_splits ? { maintenance_splits: Number(p.maintenance_splits) } : {}),
    extra_fees: p.extra_fees || []
  };
}

/**
 * Keeps the project's units in step with its plans: a unit gets the project-wide plans plus its phase's plans.
 * Units with their own plans (payment_terms.plans_own) are left alone. Returns the number of units updated.
 */
async function syncUnits(db, projectId) {
  const { rows: pr } = await db.query("SELECT * FROM projects WHERE id = $1", [projectId]);
  const project = pr[0];
  if (!project) return 0;
  const { rows: plans } = await db.query("SELECT * FROM project_plans WHERE project_id = $1 ORDER BY position, created_at", [projectId]);
  const { rows: units } = await db.query(
    "SELECT id, phase_id, payment_terms FROM listings WHERE " + Vis.units("listings") + " AND project_id = $1 AND NOT COALESCE((payment_terms->>'plans_own')::boolean, false)",
    [projectId]
  );
  let n = 0;
  for (const u of units) {
    const mine = plans.filter((p) => !p.phase_id || p.phase_id === u.phase_id).map((p) => unitPlan(p, project));
    const current = (u.payment_terms?.plans || []).filter((p) => p.source !== "project");
    const next = [...mine, ...current];
    if (JSON.stringify(next) === JSON.stringify(u.payment_terms?.plans || [])) continue;
    await db.query(
      "UPDATE listings SET payment_terms = jsonb_set(COALESCE(payment_terms, '{}'::jsonb), '{plans}', $2::jsonb), version = version + 1, updated_at = now() WHERE id = $1",
      [u.id, JSON.stringify(next)]
    );
    n++;
  }
  return n;
}

/**
 * Links units (by code) to a project, or a phase of it; the project's plans follow (C1).
 * { ok, linked, missing: [codes] } | { error }
 */
async function linkUnits(db, actor, projectId, { codes = [], phaseId = null } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project) return { error: "not_found" };
  let phase = null;
  if (phaseId) {
    const { rows } = isId(phaseId) ? await db.query("SELECT id FROM project_phases WHERE id = $1 AND project_id = $2", [phaseId, project.id]) : { rows: [] };
    if (!rows[0]) return bad("phase_id");
    phase = rows[0].id;
  }
  const wanted = [...new Set([].concat(codes).flatMap((c) => String(c || "").split(/[\s,،]+/)).map((c) => normalizeArabicDigits(c).replace(/^#/, "").toUpperCase()).filter(Boolean))].slice(0, 200);
  if (!wanted.length) return bad("codes");
  let rows;
  try {
    ({ rows } = await db.query(
      `UPDATE listings SET project_id = $3, phase_id = $4, version = version + 1, updated_at = now()
       WHERE agency_id = $1 AND code_norm = ANY($2::text[]) RETURNING code_norm`,
      [actor.agency_id, wanted, project.id, phase]
    ));
  } catch (e) {
    // Two units with one developer unit code can't share a project (C3: the developer's code decides).
    if (e.code === "23505") return bad("duplicate_code");
    throw e;
  }
  await syncUnits(db, project.id);
  const found = new Set(rows.map((r) => r.code_norm));
  return { ok: true, linked: rows.length, missing: wanted.filter((c) => !found.has(c)) };
}

/** Takes a unit out of its project; the project's plans are removed from it (its own plans stay). */
async function unlinkUnit(db, actor, projectId, listingId) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project || !isId(listingId)) return { error: "not_found" };
  const { rows } = await db.query(
    `UPDATE listings SET project_id = NULL, phase_id = NULL, version = version + 1, updated_at = now(),
            payment_terms = jsonb_set(COALESCE(payment_terms, '{}'::jsonb), '{plans}',
              COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements(COALESCE(payment_terms->'plans', '[]'::jsonb)) p WHERE p->>'source' IS DISTINCT FROM 'project'), '[]'::jsonb))
     WHERE id = $1 AND agency_id = $2 AND project_id = $3 RETURNING id`,
    [listingId, actor.agency_id, project.id]
  );
  return rows[0] ? { ok: true } : { error: "not_found" };
}

/**
 * C3: a broker links their own resale unit (a resale contract) to a catalogue project, or clears it. The unit keeps
 * its own payment terms (plans_own), so the project's plans never overwrite the contract. Catalogue units are linked
 * by managers on the project page instead. { ok, project_id } | { error }
 */
async function linkResale(db, actor, listing, projectId) {
  if (!listing || !canEdit(actor, listing)) return { error: "forbidden" };
  if (listing.details?.catalogue) return { error: "catalogue_unit" };
  let project = null;
  if (projectId) {
    project = await projectRow(db, actor, projectId);
    if (!project || project.archived_at) return { error: "not_found" };
  }
  const { rows } = await db.query(
    `UPDATE listings SET project_id = $3, phase_id = NULL, version = version + 1, updated_at = now(),
            payment_terms = jsonb_set(jsonb_set(COALESCE(payment_terms, '{}'::jsonb), '{plans}',
              COALESCE((SELECT jsonb_agg(p) FROM jsonb_array_elements(COALESCE(payment_terms->'plans', '[]'::jsonb)) p WHERE p->>'source' IS DISTINCT FROM 'project'), '[]'::jsonb)),
              '{plans_own}', to_jsonb($4::boolean))
     WHERE id = $1 AND agency_id = $2 RETURNING id`,
    [listing.id, actor.agency_id, project?.id || null, Boolean(project)]
  );
  return rows[0] ? { ok: true, project_id: project?.id || null } : { error: "not_found" };
}

/* ---------------------------------------------------------------------- */
/* Materials                                                               */
/* ---------------------------------------------------------------------- */

function materialFields(input) {
  const label = text(input.label, 80);
  if (!label) return bad("label");
  const kind = input.kind || "other";
  if (!KINDS.includes(kind)) return bad("kind");
  const raw = String(input.url || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return bad("url");
  }
  if (!["http:", "https:"].includes(url.protocol) || raw.length > 1000) return bad("url");
  // A price sheet is never shown to clients.
  const clientVisible = kind === "price_sheet" ? false : input.client_visible === true || input.client_visible === "1" || input.client_visible === "on";
  return { fields: { label, kind, url: url.toString(), unit_type: text(input.unit_type, 60), client_visible: clientVisible } };
}

async function saveMaterial(db, actor, projectId, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project) return { error: "not_found" };
  const v = materialFields(input);
  if (v.error) return v;
  const f = v.fields;
  if (input.id) {
    if (!isId(input.id)) return { error: "not_found" };
    const { rows } = await db.query(
      `UPDATE project_materials SET label = $3, kind = $4, url = $5, unit_type = $6, client_visible = $7,
              checked_at = CASE WHEN url = $5 THEN checked_at END, check_status = CASE WHEN url = $5 THEN check_status END,
              broken_since = CASE WHEN url = $5 THEN broken_since END
       WHERE id = $1 AND project_id = $2 RETURNING *`,
      [input.id, project.id, f.label, f.kind, f.url, f.unit_type, f.client_visible]
    );
    return rows[0] ? { ok: true, material: rows[0] } : { error: "not_found" };
  }
  const { rows } = await db.query(
    `INSERT INTO project_materials (agency_id, project_id, label, kind, url, unit_type, client_visible) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [actor.agency_id, project.id, f.label, f.kind, f.url, f.unit_type, f.client_visible]
  );
  return { ok: true, material: rows[0] };
}

async function setMaterialVisibility(db, actor, projectId, materialId, visible) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project || !isId(materialId)) return { error: "not_found" };
  const { rows } = await db.query(
    "UPDATE project_materials SET client_visible = ($3 AND kind <> 'price_sheet') WHERE id = $1 AND project_id = $2 RETURNING *",
    [materialId, project.id, Boolean(visible)]
  );
  return rows[0] ? { ok: true, material: rows[0] } : { error: "not_found" };
}

/**
 * F20: keeps an uploaded PDF or image (brochure, layout, plans file...) in storage as a material. The path has a
 * random part, so only someone given the link can open it; internal files are never listed to clients.
 * @param {{ buffer, mimetype, originalname, size }} file
 */
async function uploadMaterial(db, actor, projectId, file, input = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project) return { error: "not_found" };
  const ext = typeOf(file);
  if (!file?.buffer?.length || !ext) return bad("file");
  if (file.buffer.length > MAX_FILE_MB * 1024 * 1024) return bad("file");
  const name = String(file.originalname || "").replace(/\.[^.]+$/, "");
  const label = text(input.label, 80) || text(name, 80) || "file";
  const kind = KINDS.includes(input.kind) && input.kind !== "price_sheet" ? input.kind : ext === "pdf" ? "brochure" : "other";
  const safe = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "file";
  const path = `${actor.agency_id}/projects/${project.id}/${crypto.randomBytes(12).toString("hex")}-${safe}.${ext}`;
  const mime = Object.keys(FILE_TYPES).find((k) => FILE_TYPES[k] === ext);
  const url = await Storage.uploadProjectFile(actor.agency_id, path, file.buffer, mime);
  if (!url) return { error: "upload_failed" };
  const clientVisible = input.client_visible === true || input.client_visible === "1" || input.client_visible === "on";
  const { rows } = await db.query(
    `INSERT INTO project_materials (agency_id, project_id, label, kind, url, unit_type, client_visible, storage_path, file_bytes, check_status, checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ok', now()) RETURNING *`,
    [actor.agency_id, project.id, label, kind, url, text(input.unit_type, 60), clientVisible, path, file.buffer.length]
  );
  return { ok: true, material: rows[0] };
}

async function deleteMaterial(db, actor, projectId, materialId) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectRow(db, actor, projectId);
  if (!project || !isId(materialId)) return { error: "not_found" };
  const { rows } = await db.query("DELETE FROM project_materials WHERE id = $1 AND project_id = $2 RETURNING storage_path", [materialId, project.id]);
  if (!rows[0]) return { error: "not_found" };
  if (rows[0].storage_path) await Storage.deleteStorageFiles([rows[0].storage_path]);
  return { ok: true };
}

/** The materials a client may see for a unit's project (C7 builds on this): never internal links. */
async function clientMaterials(db, listing) {
  if (!listing?.project_id) return [];
  const { rows } = await db.query(
    "SELECT kind, label, url, unit_type FROM project_materials WHERE project_id = $1 AND agency_id = $2 AND client_visible AND kind <> 'price_sheet' AND check_status IS DISTINCT FROM 'broken' ORDER BY created_at",
    [listing.project_id, listing.agency_id]
  );
  return rows;
}

/** A unit's project with its developer name and every material (for the broker: internal ones marked). */
async function projectForUnit(db, listing) {
  if (!listing?.project_id) return null;
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.name_en, p.status, p.prices_updated_at, p.delivery_year, p.delivery_quarter, p.delivery_raw, p.highlights, d.name AS developer_name FROM projects p LEFT JOIN developers d ON d.id = p.developer_id
     WHERE p.id = $1 AND p.agency_id = $2`,
    [listing.project_id, listing.agency_id]
  );
  if (!rows[0]) return null;
  const { rows: materials } = await db.query("SELECT kind, label, url, client_visible, check_status FROM project_materials WHERE project_id = $1 ORDER BY created_at", [rows[0].id]);
  return { ...rows[0], materials };
}

/* ---------------------------------------------------------------------- */
/* Weekly link check                                                       */
/* ---------------------------------------------------------------------- */

const CHECK_EVERY_MS = 7 * 24 * 3600 * 1000;
const CHECK_BATCH = 25;
const CHECK_TIMEOUT_MS = 8000;

/** true when the link opens (HTTP status below 400; a server that refuses HEAD gets a GET). Never a private address. */
async function linkOpens(url, { fetchImpl = fetch, safe = require("../lib/flyerAssets").validateSafeUrl } = {}) {
  if (!(await safe(url))) return false;
  const attempt = async (method) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { method, redirect: "follow", signal: ctl.signal, headers: method === "GET" ? { Range: "bytes=0-0" } : {} });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 403 || status === 501) status = await attempt("GET");
    return status < 400;
  } catch {
    return false;
  }
}

/**
 * Checks the links not checked for a week (a batch per run). A link that just broke alerts the agency's managers once.
 * @returns {{ checked, broken }}
 */
async function checkLinks(pool, { now = new Date(), opens = linkOpens, notify = null } = {}) {
  const { rows } = await pool.query(
    `SELECT m.*, p.name AS project_name FROM project_materials m JOIN projects p ON p.id = m.project_id
     WHERE m.storage_path IS NULL AND (m.checked_at IS NULL OR m.checked_at < $1) ORDER BY m.checked_at NULLS FIRST LIMIT $2`,
    [new Date(now.getTime() - CHECK_EVERY_MS).toISOString(), CHECK_BATCH]
  );
  let broken = 0;
  const Notifications = require("../lib/notifications");
  const alert = notify || ((m) => alertBroken(pool, Notifications, m, now));
  for (const m of rows) {
    const ok = await opens(m.url);
    const { rows: upd } = await pool.query(
      `UPDATE project_materials SET checked_at = $2, check_status = $3,
              broken_since = CASE WHEN $3 = 'ok' THEN NULL ELSE COALESCE(broken_since, $2) END
       WHERE id = $1 RETURNING broken_since`,
      [m.id, now.toISOString(), ok ? "ok" : "broken"]
    );
    if (!ok) {
      broken++;
      if (m.check_status !== "broken" && upd[0]) await alert(m);
    }
  }
  return { checked: rows.length, broken };
}

async function alertBroken(pool, Notifications, m, now) {
  for (const b of await Notifications.managersOf(pool, m.agency_id)) {
    const en = b.preferred_lang === "en";
    await Notifications.notifyBroker(pool, b, {
      kind: "manager_alert",
      dedupeKey: `material_broken:${m.id}:${now.toISOString().slice(0, 10)}`,
      title: en ? `🔗 A project link stopped opening: ${m.project_name}` : `🔗 لينك في مشروع ${m.project_name} مبقاش بيفتح`,
      body: `${m.label}: ${m.url}`,
      url: `/app/catalogue/projects/${m.project_id}`,
      now
    });
  }
}

const linkCheckJob = () => ({
  name: "catalogue_links",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool, now }) => checkLinks(pool, { now })
});

module.exports = {
  STATUSES,
  KINDS,
  MAX_FILE_MB,
  FREQUENCIES,
  MAINTENANCE_DUE,
  num,
  listDevelopers,
  getDeveloper,
  saveDeveloper,
  developerByName,
  listProjects,
  saveProject,
  archiveProject,
  getProject,
  savePhase,
  deletePhase,
  planFields,
  savePlan,
  deletePlan,
  unitPlan,
  syncUnits,
  linkUnits,
  unlinkUnit,
  linkResale,
  saveMaterial,
  uploadMaterial,
  setMaterialVisibility,
  deleteMaterial,
  clientMaterials,
  projectForUnit,
  linkOpens,
  checkLinks,
  linkCheckJob
};
