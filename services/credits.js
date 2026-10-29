// services/credits.js — The AI credit pool (053): plans, extra bundles and credits per action, read from the database
// so the owner page can change them without a deploy. Nothing here hard-codes a price or a credit count.
"use strict";

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

/** Margin in whole percent: the share of the price left after AI cost (cost in EGP at the planning rate). */
function marginOf({ priceEgp, cost }) {
  return priceEgp > 0 ? Math.round((1 - cost / priceEgp) * 100) : null;
}

module.exports = { FX_DEFAULT, FX_KEY, planningRate, plans, planById, bundles, actions, creditsFor, marginOf };
