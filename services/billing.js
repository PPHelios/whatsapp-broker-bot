// services/billing.js — Plans, allowances and manual payments (phase 2 step 4).
// The plan in force (effectivePlan): a pilot agency is on Office for free until the POC ends; a paid period runs to
// paid_until; a self sign-up gets the 14-day Office trial; after that the small Free plan. Nothing is ever deleted:
// past an allowance the AI features stop for the month (lib/ai.js checks before every call) and past the seats no one
// new can be added, while everything already there stays readable and editable by hand.
// Payments are manual (InstaPay or bank transfer): a manager announces one and gets an amount and a reference, the
// owner confirms it on /app/owner and the plan period is extended (a voice pack adds 100 voice notes to that month).
"use strict";

const crypto = require("crypto");
const Plans = require("../domain/plans");
const { withTransaction } = require("../lib/db");
const { MANAGER_ROLES } = require("../lib/authz");

const DAY = 24 * 3600 * 1000;
const MONTHS = [1, 3, 6, 12];
const MAX_PENDING = 3;
const MONTH_START = "(date_trunc('month', $2::timestamptz AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')";
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());

/** The plan in force for an agency row: { plan, source: pilot|paid|trial|free, until }. */
function effectivePlan(agency, now = new Date()) {
  if (!agency) return { plan: Plans.FREE, source: "free", until: null };
  if (agency.pilot) return { plan: Plans.planById("office"), source: "pilot", until: null };
  if (agency.paid_until && new Date(agency.paid_until) > now) return { plan: Plans.planById(agency.plan) || Plans.FREE, source: "paid", until: new Date(agency.paid_until) };
  if (agency.trial_ends_at && new Date(agency.trial_ends_at) > now) return { plan: Plans.planById(Plans.TRIAL.plan), source: "trial", until: new Date(agency.trial_ends_at) };
  return { plan: Plans.FREE, source: "free", until: null };
}

async function agencyRow(db, agencyId) {
  const { rows } = await db.query("SELECT id, name, plan, paid_until, trial_ends_at, pilot, approval FROM agencies WHERE id = $1", [agencyId]);
  return rows[0] || null;
}

/** This Cairo month's AI use: text requests, voice notes, and voice packs bought. */
async function monthUsage(db, agencyId, now = new Date()) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FILTER (WHERE COALESCE(metadata->>'media', '') <> 'audio')::int FROM operation_logs
         WHERE agency_id = $1 AND status = 'success' AND model_used IS NOT NULL AND created_at >= ${MONTH_START}) AS text,
       (SELECT count(*) FILTER (WHERE metadata->>'media' = 'audio')::int FROM operation_logs
         WHERE agency_id = $1 AND status = 'success' AND model_used IS NOT NULL AND created_at >= ${MONTH_START}) AS voice,
       (SELECT count(*)::int FROM payments
         WHERE agency_id = $1 AND kind = 'voice_pack' AND status = 'confirmed' AND confirmed_at >= ${MONTH_START}) AS packs,
       (SELECT count(*)::int FROM brokers WHERE agency_id = $1 AND is_active) AS seats`,
    [agencyId, now.toISOString()]
  );
  return rows[0];
}

/**
 * The agency's plan and how much of it is used this month.
 * @returns {Promise<{ plan, source, until, text: { used, limit }, voice: { used, limit, packs }, seats: { used, limit } }>}
 */
async function allowance(db, agencyId, { now = new Date() } = {}) {
  const agency = await agencyRow(db, agencyId);
  const { plan, source, until } = effectivePlan(agency, now);
  const u = await monthUsage(db, agencyId, now);
  return {
    agency,
    plan,
    source,
    until,
    text: { used: u.text, limit: plan.text },
    voice: { used: u.voice, limit: plan.voice + u.packs * Plans.VOICE_PACK.notes, packs: u.packs },
    seats: { used: u.seats, limit: plan.seats }
  };
}

/** Throws PLAN_QUOTA_EXCEEDED (handled like the daily AI caps) when this month's text or voice allowance is used up. */
async function checkAllowance(db, agencyId, { audio = false, now = new Date() } = {}) {
  const a = await allowance(db, agencyId, { now });
  const bucket = audio ? a.voice : a.text;
  if (bucket.used >= bucket.limit) {
    const err = new Error(`Plan ${audio ? "voice" : "text"} allowance used up for the month`);
    err.code = "PLAN_QUOTA_EXCEEDED";
    err.kind = audio ? "voice" : "text";
    err.limit = bucket.limit;
    err.used = bucket.used;
    throw err;
  }
  return a;
}

/** Whether one more active broker fits the plan. */
async function seatAvailable(db, agencyId, { now = new Date() } = {}) {
  const a = await allowance(db, agencyId, { now });
  return a.seats.used < a.seats.limit;
}

// --- owner settings -------------------------------------------------------------------------------------------------

async function getSetting(db, key, fallback) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(db, key, value) {
  await db.query(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    [key, JSON.stringify(value)]
  );
}

/** Where agencies pay: { instapay, bank } as the owner typed them (shown to managers with the amount and reference). */
async function payTo(db) {
  const v = await getSetting(db, "pay_to", {});
  return { instapay: String(v.instapay || ""), bank: String(v.bank || "") };
}

async function savePayTo(db, { instapay, bank }) {
  await setSetting(db, "pay_to", { instapay: String(instapay || "").trim().slice(0, 120), bank: String(bank || "").trim().slice(0, 300) });
}

// --- payments -------------------------------------------------------------------------------------------------------

function newReference() {
  const bytes = crypto.randomBytes(6);
  return `WH-${[...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("")}`;
}

/** The amount for a plan and months, or a voice pack. */
function priceOf({ kind, plan, months }) {
  if (kind === "voice_pack") return Plans.VOICE_PACK.priceEgp;
  const p = Plans.PLANS.find((x) => x.id === plan);
  return p && MONTHS.includes(months) ? p.priceEgp * months : null;
}

/**
 * A manager announces a payment: { ok, payment } with its amount and reference, or { error }.
 * @param {Object} input - { kind: plan|voice_pack, plan, months }
 */
async function requestPayment(db, manager, input = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  const kind = input.kind === "voice_pack" ? "voice_pack" : "plan";
  const months = kind === "plan" ? Number(input.months) : 1;
  const plan = kind === "plan" ? String(input.plan || "") : null;
  const amount = priceOf({ kind, plan, months });
  if (!amount) return { error: "plan" };
  const agency = await agencyRow(db, manager.agency_id);
  if (!agency || agency.approval !== "approved") return { error: "forbidden" };
  const { rows: open } = await db.query("SELECT count(*)::int AS n FROM payments WHERE agency_id = $1 AND status = 'pending'", [manager.agency_id]);
  if (open[0].n >= MAX_PENDING) return { error: "too_many" };
  for (let i = 0; i < 5; i++) {
    const { rows } = await db.query(
      `INSERT INTO payments (agency_id, kind, plan, months, amount_egp, reference, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (reference) DO NOTHING RETURNING *`,
      [manager.agency_id, kind, plan, months, amount, newReference(), manager.id]
    );
    if (rows[0]) return { ok: true, payment: rows[0], agency };
  }
  throw new Error("Could not allocate a payment reference");
}

async function paymentsOf(db, agencyId, { limit = 20 } = {}) {
  const { rows } = await db.query("SELECT * FROM payments WHERE agency_id = $1 ORDER BY created_at DESC LIMIT $2", [agencyId, limit]);
  return rows;
}

async function pendingPayments(db) {
  const { rows } = await db.query(
    `SELECT p.*, a.name AS agency_name FROM payments p JOIN agencies a ON a.id = p.agency_id
      WHERE p.status = 'pending' ORDER BY p.created_at`
  );
  return rows;
}

/**
 * The owner confirms a payment: a plan payment extends paid_until by its months from the later of now and the current
 * end (and the agency is no longer a free pilot); a voice pack counts for the month it is confirmed in.
 * @returns {Promise<{ ok, payment, agency } | { error }>}
 */
async function confirmPayment(pool, id, { now = new Date() } = {}) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [id]);
    const p = rows[0];
    if (!p) return { error: "not_found" };
    if (p.status !== "pending") return { error: "not_pending", payment: p };
    const { rows: done } = await client.query("UPDATE payments SET status = 'confirmed', confirmed_at = $2 WHERE id = $1 RETURNING *", [id, now.toISOString()]);
    let agency;
    if (p.kind === "plan") {
      const { rows: a } = await client.query(
        `UPDATE agencies SET plan = $2, pilot = false,
                paid_until = GREATEST(COALESCE(paid_until, $3::timestamptz), $3::timestamptz) + make_interval(months => $4),
                updated_at = NOW()
          WHERE id = $1 RETURNING id, name, plan, paid_until, trial_ends_at, pilot, approval`,
        [p.agency_id, p.plan, now.toISOString(), p.months]
      );
      agency = a[0];
    } else {
      agency = await agencyRow(client, p.agency_id);
    }
    return { ok: true, payment: done[0], agency };
  });
}

async function cancelPayment(db, id) {
  const { rows } = await db.query("UPDATE payments SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING *", [id]);
  return rows[0] ? { ok: true, payment: rows[0] } : { error: "not_pending" };
}

/** Agencies whose trial or paid period ends within `days` (for the reminder job). */
async function endingSoon(db, { now = new Date(), days = 3 } = {}) {
  const until = new Date(now.getTime() + days * DAY).toISOString();
  const { rows } = await db.query(
    `SELECT id, name, plan, paid_until, trial_ends_at, pilot, approval FROM agencies
      WHERE NOT pilot AND approval = 'approved'
        AND ((paid_until > $1 AND paid_until <= $2) OR ((paid_until IS NULL OR paid_until <= $1) AND trial_ends_at > $1 AND trial_ends_at <= $2))`,
    [now.toISOString(), until]
  );
  return rows;
}

module.exports = {
  MONTHS,
  MAX_PENDING,
  effectivePlan,
  allowance,
  checkAllowance,
  seatAvailable,
  getSetting,
  setSetting,
  payTo,
  savePayTo,
  priceOf,
  requestPayment,
  paymentsOf,
  pendingPayments,
  confirmPayment,
  cancelPayment,
  endingSoon
};
