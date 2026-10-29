// services/credits.js — The AI credit pool (053): plans, extra bundles and credits per action, read from the database
// so the owner page can change them without a deploy. Nothing here hard-codes a price or a credit count.
"use strict";

const Plans = require("../domain/plans");
const { MANAGER_ROLES } = require("../lib/authz");
const ErrorReports = require("../lib/errorReports");

const FX_KEY = "planning_fx_egp_per_usd";
const FX_DEFAULT = 60;

/** The owner's planning rate (EGP per USD) used for margin checks; the default is the safe 60. */
async function planningRate(db) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [FX_KEY]);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) && n > 0 ? n : FX_DEFAULT;
}

/** Every plan row, cheapest first (inactive plans are kept for old agencies but not offered). */
async function plans(db, { onlyActive = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, name_ar, name_en, price_egp, seats, units, credits, sort, active FROM credit_plans
     ${onlyActive ? "WHERE active" : ""} ORDER BY sort, price_egp`
  );
  return rows;
}

async function planById(db, id) {
  const { rows } = await db.query("SELECT id, name_ar, name_en, price_egp, seats, units, credits, sort, active FROM credit_plans WHERE id = $1", [id]);
  return rows[0] || null;
}

/** The extra bundles offered for buying (active only). */
async function bundles(db) {
  const { rows } = await db.query("SELECT id, name_ar, name_en, price_egp, credits, sort FROM credit_bundles WHERE active ORDER BY sort, price_egp");
  return rows;
}

/** The credits each action uses: { text: 1, voice: 3, ... } plus the labels for the "What uses credits" table. */
async function actions(db) {
  const { rows } = await db.query("SELECT action, label_ar, label_en, credits FROM credit_actions ORDER BY sort, action");
  return rows;
}

/** Credits one action uses (0 when unknown, so a new action without a row is free until it is priced on the owner page). */
async function creditsFor(db, action) {
  const { rows } = await db.query("SELECT credits FROM credit_actions WHERE action = $1", [action]);
  return rows[0] ? rows[0].credits : 0;
}

const MONTH_START = "(date_trunc('month', $2::timestamptz AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')";
const PAGE_OPS = ["price_list_read", "brochure_read", "gallery_read", "plans_read"];

/** { text, voice, flyer, page, chat_post, assistant } → credits, from credit_actions (a missing row reads as 0). */
async function actionMap(db) {
  const map = {};
  for (const a of await actions(db)) map[a.action] = a.credits;
  return map;
}

/**
 * Credits an agency used this Cairo month, charged once per user action: a voice note costs the voice credits (not a
 * text request on top), a search is one text request (its second telemetry row is free), flyer photo ordering is the
 * flyer credits, and each fresh document page is the page credits (the AI call behind a page is not charged twice;
 * a page another agency already read is free).
 */
async function usedThisMonth(db, agencyId, { now = new Date() } = {}) {
  const c = await actionMap(db);
  const { rows } = await db.query(
    `SELECT
       (SELECT COALESCE(sum(CASE
            WHEN operation_type = 'search_query' THEN 0
            WHEN operation_type = ANY($7::text[]) THEN 0
            WHEN metadata->>'media' = 'audio' THEN $3
            WHEN operation_type = 'vision_curation' THEN $5
            WHEN operation_type = 'assistant' THEN $6
            ELSE $4 END), 0)::int
          FROM operation_logs
         WHERE agency_id = $1 AND status = 'success' AND model_used IS NOT NULL AND created_at >= ${MONTH_START}) AS ai,
       (SELECT count(*)::int FROM price_read_log
         WHERE agency_id = $1 AND NOT reused AND created_at >= ${MONTH_START}) AS pages`,
    [agencyId, now.toISOString(), c.voice ?? 0, c.text ?? 0, c.flyer ?? 0, c.assistant ?? 0, PAGE_OPS]
  );
  return rows[0].ai + rows[0].pages * (c.page ?? 0);
}

/** The month's pool for an agency: its plan's credits, bundles bought and confirmed this month, and owner grants. */
async function poolFor(db, agencyId, planId, { now = new Date() } = {}) {
  const plan = (await planById(db, planId)) || (await planById(db, "free"));
  const { rows } = await db.query(
    `SELECT
       (SELECT COALESCE(sum(b.credits), 0)::int FROM payments p JOIN credit_bundles b ON b.id = p.bundle_id
         WHERE p.agency_id = $1 AND p.kind = 'credit_bundle' AND p.status = 'confirmed' AND p.confirmed_at >= ${MONTH_START}) AS bundles,
       (SELECT COALESCE(sum(credits), 0)::int FROM credit_grants WHERE agency_id = $1 AND month = to_char($2::timestamptz AT TIME ZONE 'Africa/Cairo', 'YYYY-MM')) AS grants`,
    [agencyId, now.toISOString()]
  );
  const base = plan ? plan.credits : 0;
  return { plan: base, bundles: rows[0].bundles, grants: rows[0].grants, total: base + rows[0].bundles + rows[0].grants };
}

const monthKey = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(now).slice(0, 7);

/** A manager asks the app owner for more credits: { ok, request } | { error }. The owner is told on Telegram. */
async function requestMore(db, manager, { credits, note = "" } = {}) {
  if (!MANAGER_ROLES.includes(String(manager.role || "").toLowerCase())) return { error: "forbidden" };
  const n = Math.round(Number(credits));
  if (!Number.isFinite(n) || n < 1 || n > 100000) return { error: "credits" };
  const { rows: open } = await db.query("SELECT count(*)::int AS n FROM credit_requests WHERE agency_id = $1 AND status = 'pending'", [manager.agency_id]);
  if (open[0].n >= 3) return { error: "too_many" };
  const { rows } = await db.query(
    "INSERT INTO credit_requests (agency_id, broker_id, credits, note) VALUES ($1, $2, $3, $4) RETURNING *",
    [manager.agency_id, manager.id, n, String(note || "").slice(0, 300) || null]
  );
  const { rows: ag } = await db.query("SELECT name FROM agencies WHERE id = $1", [manager.agency_id]);
  ErrorReports.alertOwner([`🔔 Credit request: ${ag[0]?.name || ""}`, `${manager.name || ""} asks for ${n} credits`, note ? String(note).slice(0, 300) : "", "Answer on /app/owner"].filter(Boolean).join("\n")).catch(() => {});
  return { ok: true, request: rows[0] };
}

/** The agency's own requests, newest first (the manager sees pending, approved or declined). */
async function requestsOf(db, agencyId, { limit = 10 } = {}) {
  const { rows } = await db.query("SELECT id, credits, note, status, created_at, decided_at FROM credit_requests WHERE agency_id = $1 ORDER BY created_at DESC LIMIT $2", [agencyId, limit]);
  return rows;
}

/** Open requests with agency names (the owner page). */
async function pendingRequests(db) {
  const { rows } = await db.query(
    `SELECT r.id, r.credits, r.note, r.created_at, a.id AS agency_id, a.name AS agency_name, b.name AS broker_name
       FROM credit_requests r JOIN agencies a ON a.id = r.agency_id LEFT JOIN brokers b ON b.id = r.broker_id
      WHERE r.status = 'pending' ORDER BY r.created_at`
  );
  return rows;
}

/** The owner gives an agency extra credits for this Cairo month. */
async function grant(db, agencyId, credits, { note = null, now = new Date() } = {}) {
  const n = Math.round(Number(credits));
  if (!Number.isFinite(n) || n < 1 || n > 1000000) return { error: "credits" };
  await db.query("INSERT INTO credit_grants (agency_id, month, credits, note) VALUES ($1, $2, $3, $4)", [agencyId, monthKey(now), n, note]);
  return { ok: true };
}

/** The owner answers a request: approve (optionally a different amount) grants the credits for this month. */
async function decideRequest(db, id, { approve, credits = null, now = new Date() } = {}) {
  const { rows } = await db.query("SELECT * FROM credit_requests WHERE id = $1 AND status = 'pending'", [id]);
  const r = rows[0];
  if (!r) return { error: "not_pending" };
  if (approve) {
    const g = await grant(db, r.agency_id, credits || r.credits, { note: `request #${id}`, now });
    if (g.error) return g;
  }
  await db.query("UPDATE credit_requests SET status = $2, decided_at = $3 WHERE id = $1", [id, approve ? "approved" : "declined", now.toISOString()]);
  return { ok: true, request: { ...r, status: approve ? "approved" : "declined" } };
}


// --- the owner's page ---------------------------------------------------------------------------------------------

const COST_KEY = "credit_cost_usd";
const COST_DEFAULT = 0.0026;
const ID_RE = /^[a-z][a-z0-9_]{1,19}$/;
const intIn = (v, min, max) => {
  const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const text = (v, max = 40) => String(v ?? "").trim().slice(0, max);

async function setting(db, key, fallback) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function putSetting(db, key, value) {
  await db.query("INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [key, JSON.stringify(value)]);
}

/** What the owner's Plans and credits section shows: every plan with its margin at full use, bundles, actions, rates. */
async function ownerOverview(db) {
  const [pl, bundleRows, acts, fx, costUsd, requests, agencies] = await Promise.all([
    plans(db),
    db.query("SELECT id, name_ar, name_en, price_egp, credits, sort, active FROM credit_bundles ORDER BY sort, price_egp").then((r) => r.rows),
    actions(db),
    planningRate(db),
    setting(db, COST_KEY, COST_DEFAULT),
    pendingRequests(db),
    db.query("SELECT id, name FROM agencies ORDER BY name").then((r) => r.rows)
  ]);
  const costOf = (credits) => credits * costUsd * fx;
  const withMargin = (x) => ({ ...x, cost_egp: Math.round(costOf(x.credits)), margin: marginOf({ priceEgp: x.price_egp, cost: costOf(x.credits) }) });
  return { plans: pl.map(withMargin), bundles: bundleRows.map(withMargin), actions: acts, fx, costUsd, requests, agencies };
}

/** Saves the plans form (p_<id>_<field>) and an optional new plan (new_*): { ok } | { error }. */
async function savePlans(db, body = {}) {
  for (const p of await plans(db)) {
    const k = (f) => body[`p_${p.id}_${f}`];
    const price = intIn(k("price"), 0, 1000000);
    const seats = intIn(k("seats"), 1, 1000);
    const units = intIn(k("units"), 1, 1000000);
    const credits = intIn(k("credits"), 0, 10000000);
    const name_ar = text(k("name_ar"));
    const name_en = text(k("name_en"));
    if ([price, seats, units, credits].includes(null) || !name_ar || !name_en) return { error: "plan", id: p.id };
    await db.query(
      "UPDATE credit_plans SET name_ar = $2, name_en = $3, price_egp = $4, seats = $5, units = $6, credits = $7, active = $8, updated_at = NOW() WHERE id = $1",
      [p.id, name_ar, name_en, price, seats, units, credits, p.id === "free" ? true : k("active") === "on"]
    );
  }
  if (text(body.new_id)) {
    const id = text(body.new_id, 20).toLowerCase();
    const price = intIn(body.new_price, 0, 1000000);
    const seats = intIn(body.new_seats, 1, 1000);
    const units = intIn(body.new_units, 1, 1000000);
    const credits = intIn(body.new_credits, 0, 10000000);
    const name_ar = text(body.new_name_ar);
    const name_en = text(body.new_name_en);
    if (!ID_RE.test(id) || [price, seats, units, credits].includes(null) || !name_ar || !name_en) return { error: "new_plan" };
    const { rows: taken } = await db.query("SELECT 1 FROM credit_plans WHERE id = $1", [id]);
    if (taken.length) return { error: "new_plan" };
    await db.query(
      "INSERT INTO credit_plans (id, name_ar, name_en, price_egp, seats, units, credits, sort) VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(max(sort), 0) + 1 FROM credit_plans))",
      [id, name_ar, name_en, price, seats, units, credits]
    );
  }
  await refresh(db);
  return { ok: true };
}

/** Saves the bundles form (b_<id>_<field>) and an optional new bundle. */
async function saveBundles(db, body = {}) {
  const { rows } = await db.query("SELECT id FROM credit_bundles");
  for (const { id } of rows) {
    const k = (f) => body[`b_${id}_${f}`];
    const price = intIn(k("price"), 1, 1000000);
    const credits = intIn(k("credits"), 1, 10000000);
    const name_ar = text(k("name_ar"));
    const name_en = text(k("name_en"));
    if ([price, credits].includes(null) || !name_ar || !name_en) return { error: "bundle", id };
    await db.query("UPDATE credit_bundles SET name_ar = $2, name_en = $3, price_egp = $4, credits = $5, active = $6, updated_at = NOW() WHERE id = $1", [id, name_ar, name_en, price, credits, k("active") === "on"]);
  }
  if (text(body.new_bundle_id)) {
    const id = text(body.new_bundle_id, 20).toLowerCase();
    const price = intIn(body.new_bundle_price, 1, 1000000);
    const credits = intIn(body.new_bundle_credits, 1, 10000000);
    const name_ar = text(body.new_bundle_name_ar);
    const name_en = text(body.new_bundle_name_en);
    if (!ID_RE.test(id) || [price, credits].includes(null) || !name_ar || !name_en) return { error: "new_bundle" };
    const { rows: taken } = await db.query("SELECT 1 FROM credit_bundles WHERE id = $1", [id]);
    if (taken.length) return { error: "new_bundle" };
    await db.query("INSERT INTO credit_bundles (id, name_ar, name_en, price_egp, credits, sort) VALUES ($1, $2, $3, $4, $5, (SELECT COALESCE(max(sort), 0) + 1 FROM credit_bundles))", [id, name_ar, name_en, price, credits]);
  }
  await refresh(db);
  return { ok: true };
}

/** Saves the credits each action uses (a_<action>) and the planning rates (fx, cost_usd). */
async function saveActionsAndRates(db, body = {}) {
  for (const a of await actions(db)) {
    const n = intIn(body[`a_${a.action}`], 0, 1000);
    if (n === null) return { error: "action", id: a.action };
    await db.query("UPDATE credit_actions SET credits = $2, updated_at = NOW() WHERE action = $1", [a.action, n]);
  }
  const fx = Number(body.fx);
  const cost = Number(body.cost_usd);
  if (!(fx >= 1 && fx <= 1000) || !(cost > 0 && cost <= 1)) return { error: "rates" };
  await putSetting(db, FX_KEY, fx);
  await putSetting(db, COST_KEY, cost);
  return { ok: true };
}

let loadedAt = 0;
const TTL_MS = 60 * 1000;

/** Loads plans and bundles from the database into domain/plans.js. A database that cannot be read keeps the last values. */
// Credits per action as last loaded, for screens that print them (button labels); the seed values until the first load.
let costs = { text: 1, voice: 3, flyer: 3, page: 10, chat_post: 1, assistant: 2 };
const costOf = (action) => costs[action] ?? 0;

async function refresh(db) {
  costs = { ...costs, ...(await actionMap(db)) };
  const [p, b] = await Promise.all([plans(db), db.query("SELECT id, name_ar, name_en, price_egp, credits, sort FROM credit_bundles WHERE active ORDER BY sort, price_egp")]);
  Plans.hydrate({ plans: p, bundles: b.rows });
  loadedAt = Date.now();
}

/** refresh, at most once a minute (the owner page forces one after each save); never throws. */
async function ensureFresh(db) {
  if (Date.now() - loadedAt < TTL_MS) return;
  loadedAt = Date.now();
  try {
    await refresh(db);
  } catch (err) {
    console.warn("Plans refresh failed, keeping the last values:", err.message);
  }
}

/** Margin in whole percent: the share of the price left after AI cost (cost in EGP at the planning rate). */
function marginOf({ priceEgp, cost }) {
  return priceEgp > 0 ? Math.round((1 - cost / priceEgp) * 100) : null;
}

module.exports = { costOf, ownerOverview, savePlans, saveBundles, saveActionsAndRates, COST_KEY, COST_DEFAULT, requestMore, requestsOf, pendingRequests, grant, decideRequest, monthKey, refresh, ensureFresh, FX_DEFAULT, FX_KEY, planningRate, plans, planById, bundles, actions, actionMap, creditsFor, usedThisMonth, poolFor, marginOf };
