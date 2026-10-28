// services/ownerAgencies.js — The app owner's control over agencies (OWNER_BROKER_IDS only; the route checks):
// every agency at a glance, one agency's page, changing its plan or paid-until date, pilot on/off, suspending and
// resuming it (its brokers stop working and come back as they were), an announcement to every manager, and a log of
// the owner's own actions. Prices stay in domain/plans.js.
"use strict";

const Plans = require("../domain/plans");
const Billing = require("./billing");
const Notifications = require("../lib/notifications");
const { withTransaction, logOperation } = require("../lib/db");

const DAY = 86400000;
const ACTIONS = ["owner_plan", "owner_suspend", "owner_resume", "owner_announcement"];

/** Every approved or pending agency with its plan in force and its size. */
async function list(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.plan, a.paid_until, a.trial_ends_at, a.pilot, a.approval, a.created_at,
            a.crm_settings->>'suspended_at' AS suspended_at,
            (SELECT count(*)::int FROM brokers b WHERE b.agency_id = a.id AND b.is_active) AS brokers,
            (SELECT count(*)::int FROM listings l WHERE l.agency_id = a.id AND l.status = 'active') AS units,
            (SELECT count(*)::int FROM leads x WHERE x.agency_id = a.id AND x.created_at > $1::timestamptz - interval '30 days') AS leads30,
            (SELECT max(o.created_at) FROM operation_logs o WHERE o.agency_id = a.id) AS last_seen
       FROM agencies a WHERE a.approval <> 'rejected' ORDER BY a.name`,
    [now.toISOString()]
  );
  return rows.map((a) => ({ ...a, effective: Billing.effectivePlan(a, now) }));
}

/** One agency with its brokers and recent payments. */
async function get(db, agencyId, { now = new Date() } = {}) {
  const all = await list(db, { now });
  const a = all.find((x) => x.id === agencyId);
  if (!a) return null;
  const { rows: brokers } = await db.query("SELECT id, name, role, is_active, preferred_lang, created_at FROM brokers WHERE agency_id = $1 ORDER BY role, name", [agencyId]);
  const payments = await Billing.paymentsOf(db, agencyId, { limit: 10 });
  return { ...a, team: brokers, payments };
}

/** Change an agency's plan: a paid plan until a date (or N months from today), or pilot on/off. */
async function setPlan(db, owner, agencyId, { plan, months = null, until = null, pilot = null, now = new Date() } = {}) {
  const p = Plans.planById(plan);
  if (!p || p.id === "free") return { error: "invalid", field: "plan" };
  let paidUntil = null;
  if (until) {
    const d = new Date(`${until}T23:59:59+02:00`);
    if (Number.isNaN(d.getTime())) return { error: "invalid", field: "until" };
    paidUntil = d;
  } else if (months !== null && months !== "") {
    const m = Number(months);
    if (!Number.isInteger(m) || m < 0 || m > 36) return { error: "invalid", field: "months" };
    paidUntil = m === 0 ? null : new Date(now.getTime() + m * 30 * DAY);
  }
  const { rows } = await db.query(
    `UPDATE agencies SET plan = $2, paid_until = $3, pilot = COALESCE($4, pilot), updated_at = now()
      WHERE id = $1 RETURNING id, name, plan, paid_until, pilot`,
    [agencyId, p.id, paidUntil ? paidUntil.toISOString() : null, pilot === null ? null : Boolean(pilot)]
  );
  if (!rows[0]) return { error: "not_found" };
  logOperation(db, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_plan", status: "success", metadata: { plan: p.id, paid_until: rows[0].paid_until, pilot: rows[0].pilot } });
  return { ok: true, agency: rows[0] };
}

/** Suspend: every active broker stops working (remembered so resume brings back the same people). */
async function suspend(pool, owner, agencyId, { now = new Date() } = {}) {
  const out = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT crm_settings FROM agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    if (!rows[0]) return { error: "not_found" };
    if (rows[0].crm_settings?.suspended_at) return { error: "already" };
    const { rows: off } = await client.query("UPDATE brokers SET is_active = false WHERE agency_id = $1 AND is_active RETURNING id", [agencyId]);
    await client.query(
      "UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('suspended_at', $2::text, 'suspended_brokers', $3::jsonb), updated_at = now() WHERE id = $1",
      [agencyId, now.toISOString(), JSON.stringify(off.map((b) => b.id))]
    );
    return { ok: true, brokers: off.length };
  });
  if (out.ok) logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_suspend", status: "success", metadata: { brokers: out.brokers } });
  return out;
}

async function resume(pool, owner, agencyId) {
  const out = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT crm_settings FROM agencies WHERE id = $1 FOR UPDATE", [agencyId]);
    if (!rows[0]) return { error: "not_found" };
    const ids = rows[0].crm_settings?.suspended_brokers || [];
    if (!rows[0].crm_settings?.suspended_at) return { error: "not_suspended" };
    const { rowCount } = await client.query("UPDATE brokers SET is_active = true WHERE agency_id = $1 AND id = ANY($2::uuid[])", [agencyId, ids]);
    await client.query("UPDATE agencies SET crm_settings = crm_settings - 'suspended_at' - 'suspended_brokers', updated_at = now() WHERE id = $1", [agencyId]);
    return { ok: true, brokers: rowCount };
  });
  if (out.ok) logOperation(pool, { agency_id: agencyId, broker_id: owner.id, operation_type: "owner_resume", status: "success", metadata: { brokers: out.brokers } });
  return out;
}

/** An announcement to every active manager (inbox, plus Telegram/WhatsApp by their settings). */
async function announce(pool, owner, { title, body = "", now = new Date() } = {}) {
  const t = String(title || "").trim().slice(0, 120);
  if (!t) return { error: "invalid", field: "title" };
  const b = String(body || "").trim().slice(0, 600);
  const { rows: agencies } = await pool.query("SELECT id FROM agencies WHERE approval = 'approved'");
  const key = `announce:${now.getTime()}`;
  let sent = 0;
  for (const a of agencies) {
    for (const m of await Notifications.managersOf(pool, a.id)) {
      await Notifications.notifyBroker(pool, m, { kind: "manager_alert", dedupeKey: key, title: `📢 ${t}`, body: b, url: "/app/notifications", now }).catch(() => {});
      sent += 1;
    }
  }
  logOperation(pool, { agency_id: null, broker_id: owner.id, operation_type: "owner_announcement", status: "success", metadata: { title: t, sent } });
  return { ok: true, sent };
}

/** The owner's own actions, newest first. */
async function auditLog(db, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT o.created_at, o.operation_type, o.metadata, a.name AS agency FROM operation_logs o LEFT JOIN agencies a ON a.id = o.agency_id
      WHERE o.operation_type = ANY($1::text[]) ORDER BY o.created_at DESC LIMIT $2`,
    [ACTIONS, limit]
  );
  return rows;
}

module.exports = { ACTIONS, list, get, setPlan, suspend, resume, announce, auditLog };
