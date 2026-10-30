// services/signup.js — Agency self sign-up (phase 2 step 4). The owner turns it on or off on /app/owner (off until
// switched on). While on, anyone can ask for an agency from /app/signup: the agency and its admin are created waiting
// (approval 'pending', the admin inactive, so nothing works yet) and the owner is alerted. Approving starts the 14-day
// Office trial, activates the admin and returns their one-time Telegram start link for the owner to send.
"use strict";

const Phone = require("../domain/phone");
const Plans = require("../domain/plans");
const TgLink = require("../lib/tgLink");
const Billing = require("./billing");
const Referrals = require("./referrals");
const { withTransaction } = require("../lib/db");
const { getConfig } = require("../config");

const DAY = 24 * 3600 * 1000;

async function isOpen(db) {
  return Boolean((await Billing.getSetting(db, "signup", { enabled: false })).enabled);
}

async function setOpen(db, enabled) {
  await Billing.setSetting(db, "signup", { enabled: Boolean(enabled) });
}

/**
 * A sign-up request: { ok, agency, broker, referrer } or { error: closed|agency|name|phone|referral|phone_taken }.
 * A referral code (optional) records the agency that invited this one (services/referrals.js).
 * @param {Object} input - { agency, name, phone, lang, referral }
 */
async function submit(pool, input = {}, { now = new Date() } = {}) {
  if (!(await isOpen(pool))) return { error: "closed" };
  const agencyName = String(input.agency || "").trim().slice(0, 120);
  const name = String(input.name || "").trim().slice(0, 80);
  const digits = Phone.normalizePhone(input.phone);
  const lang = input.lang === "en" ? "en" : "ar";
  if (!agencyName) return { error: "agency" };
  if (!name) return { error: "name" };
  if (!digits || !Phone.isEgyptMobile(digits)) return { error: "phone" };
  const referrer = input.referral ? await Referrals.agencyByCode(pool, input.referral) : null;
  if (input.referral && !referrer) return { error: "referral" };
  return withTransaction(pool, async (client) => {
    const { rows: taken } = await client.query("SELECT 1 FROM brokers WHERE phone_normalized = $1", [digits]);
    if (taken.length) return { error: "phone_taken" };
    const { rows: a } = await client.query(
      `INSERT INTO agencies (name, plan, pilot, approval, signed_up_at, referred_by) VALUES ($1, $2, false, 'pending', $3, $4) RETURNING id, name, slug`,
      [agencyName, Plans.TRIAL.plan, now.toISOString(), referrer ? referrer.id : null]
    );
    const { rows: b } = await client.query(
      `INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, $3, 'owner', $4, false)
       RETURNING id, agency_id, name, phone_number, preferred_lang`,
      [a[0].id, digits, name, lang]
    );
    return { ok: true, agency: a[0], broker: b[0], referrer };
  });
}

/** Sign-ups waiting for the owner, oldest first, with their admin. */
async function pending(db) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.signed_up_at, b.id AS broker_id, b.name AS broker_name, b.phone_number
       FROM agencies a LEFT JOIN LATERAL (SELECT id, name, phone_number FROM brokers WHERE agency_id = a.id ORDER BY created_at LIMIT 1) b ON true
      WHERE a.approval = 'pending' ORDER BY a.signed_up_at`
  );
  return rows;
}

/**
 * Approves a waiting sign-up: the trial starts now, the agency's brokers are activated, and the admin's start link
 * comes back ({ ok, agency, broker, url } — url is null while the bot username isn't set).
 */
async function approve(pool, agencyId, { now = new Date(), username = getConfig().telegram.botUsername } = {}) {
  const res = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE agencies SET approval = 'approved', plan = $2, trial_ends_at = $3, updated_at = NOW()
        WHERE id = $1 AND approval = 'pending' RETURNING id, name, trial_ends_at`,
      [agencyId, Plans.TRIAL.plan, new Date(now.getTime() + Plans.TRIAL.days * DAY).toISOString()]
    );
    if (!rows[0]) return { error: "not_pending" };
    const { rows: brokers } = await client.query(
      "UPDATE brokers SET is_active = true WHERE agency_id = $1 RETURNING id, agency_id, name, phone_number, preferred_lang, created_at",
      [agencyId]
    );
    brokers.sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
    return { ok: true, agency: rows[0], broker: brokers[0] || null };
  });
  if (!res.ok || !res.broker) return res;
  const url = TgLink.startLink(username, "x") ? TgLink.startLink(username, await TgLink.issueLinkToken(pool, res.broker)) : null;
  return { ...res, url };
}

async function reject(db, agencyId) {
  const { rows } = await db.query("UPDATE agencies SET approval = 'rejected', updated_at = NOW() WHERE id = $1 AND approval = 'pending' RETURNING id, name", [agencyId]);
  return rows[0] ? { ok: true, agency: rows[0] } : { error: "not_pending" };
}

module.exports = { isOpen, setOpen, submit, pending, approve, reject };
