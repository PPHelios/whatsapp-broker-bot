// services/onboarding.js — A new broker's first week: the welcome card (closed once), the bot's one-time hints after
// the first unit, search and lead, the day 1/3/7 nudges (the first step still missing, Telegram or the website only,
// never WhatsApp), a "talk to a person" link to the owner, and the owner's list of brokers who are stuck.
"use strict";

const O = require("../domain/onboarding");
const TgLink = require("../lib/tgLink");
const Notifications = require("../lib/notifications");
const { MANAGER_ROLES } = require("../lib/authz");
const { getConfig } = require("../config");

const DAY = 86400000;
const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());
const langOf = (b) => (b?.preferred_lang === "en" ? "en" : "ar");

async function stateOf(db, brokerId) {
  const { rows } = await db.query("SELECT onboarding, telegram_chat_id FROM brokers WHERE id = $1", [brokerId]);
  return rows[0] ? { ...(rows[0].onboarding || {}), telegram: Boolean(rows[0].telegram_chat_id) } : null;
}

/** The welcome card for this broker, or null once they closed it. */
async function welcomeFor(db, broker) {
  const s = await stateOf(db, broker.id);
  if (!s || s.welcome) return null;
  return O.welcome({ manager: isManager(broker), telegram: s.telegram }, langOf(broker));
}

async function closeWelcome(pool, broker, now = new Date()) {
  await pool.query("UPDATE brokers SET onboarding = onboarding || jsonb_build_object('welcome', $2::text) WHERE id = $1", [broker.id, now.toISOString()]);
}

/** The hint after a broker's first unit, search or lead: its text the first time (and remembered), else null. */
async function firstHint(db, broker, kind, now = new Date()) {
  if (!O.HINTS[kind] || !broker?.id) return null;
  const { rows } = await db.query(
    `UPDATE brokers SET onboarding = jsonb_set(onboarding, '{hints}', COALESCE(onboarding->'hints', '{}'::jsonb) || jsonb_build_object($2::text, $3::text))
      WHERE id = $1 AND NOT COALESCE(onboarding->'hints', '{}'::jsonb) ? $2 RETURNING id`,
    [broker.id, kind, now.toISOString()]
  );
  return rows[0] ? O.hint(kind, langOf(broker)) : null;
}

/** A Telegram start link for the signed-in broker (links their own account), or null without a bot. */
async function telegramLink(pool, broker) {
  const username = getConfig().telegram.botUsername;
  if (!TgLink.startLink(username, "x")) return null;
  return TgLink.startLink(username, await TgLink.issueLinkToken(pool, broker));
}

/** "Talk to a person": the owner's Telegram username, or null when it isn't set. */
function supportUrl() {
  const { telegram } = getConfig().support || {};
  if (telegram && telegram.length >= 5) return `https://t.me/${telegram}`;
  return null;
}

/** What a broker has done so far: { telegram, units, leads, searches }. */
async function progressOf(db, broker) {
  const { rows } = await db.query(
    `SELECT (b.telegram_chat_id IS NOT NULL) AS telegram,
            (SELECT count(*)::int FROM listings l WHERE l.broker_id = b.id) AS units,
            (SELECT count(*)::int FROM leads d WHERE d.created_by_broker_id = b.id OR d.assigned_broker_id = b.id) AS leads,
            (SELECT count(*)::int FROM operation_logs o WHERE o.broker_id = b.id AND o.operation_type LIKE '%search%') AS searches
       FROM brokers b WHERE b.id = $1`,
    [broker.id]
  );
  return rows[0] || { telegram: false, units: 0, leads: 0, searches: 0 };
}

/** Scheduler step: day 1, 3 and 7 after joining, one nudge about the first step still missing. */
async function nudgeDue(pool, { now = new Date() } = {}) {
  let sent = 0;
  for (const day of O.NUDGE_DAYS) {
    const key = `d${day}`;
    const { rows } = await pool.query(
      `SELECT * FROM brokers WHERE is_active AND created_at <= $1 AND created_at > $2
          AND NOT COALESCE(onboarding->'nudges', '{}'::jsonb) ? $3`,
      [new Date(now.getTime() - day * DAY).toISOString(), new Date(now.getTime() - (day + 2) * DAY).toISOString(), key]
    );
    for (const b of rows) {
      await pool.query(
        "UPDATE brokers SET onboarding = jsonb_set(onboarding, '{nudges}', COALESCE(onboarding->'nudges', '{}'::jsonb) || jsonb_build_object($2::text, $3::text)) WHERE id = $1",
        [b.id, key, now.toISOString()]
      );
      const n = O.nudge(day, await progressOf(pool, b), langOf(b));
      if (!n) continue;
      await Notifications.notifyBroker(pool, b, { kind: "onboarding", dedupeKey: `onboarding:${key}`, title: n.title, body: n.body, url: n.url, now });
      sent++;
    }
  }
  return { counts: { nudges: sent } };
}

const nudgeJob = () => ({ name: "onboarding_nudges", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => nudgeDue(pool, { now }) });

/**
 * The owner's stuck list: active brokers who joined 2+ days ago and have no unit and no lead, never linked Telegram,
 * or went quiet for 7+ days. [{ id, name, phone_number, role, agency_name, created_at, last_active_at, reasons }]
 */
async function stuckList(db, { now = new Date(), limit = 100 } = {}) {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.phone_number, b.role, b.created_at, b.last_active_at, b.telegram_chat_id IS NOT NULL AS telegram, a.name AS agency_name,
            (SELECT count(*)::int FROM listings l WHERE l.broker_id = b.id) AS units,
            (SELECT count(*)::int FROM leads d WHERE d.created_by_broker_id = b.id OR d.assigned_broker_id = b.id) AS leads
       FROM brokers b JOIN agencies a ON a.id = b.agency_id
      WHERE b.is_active AND b.created_at <= $1
      ORDER BY b.created_at DESC LIMIT 500`,
    [new Date(now.getTime() - 2 * DAY).toISOString()]
  );
  const out = [];
  for (const r of rows) {
    const reasons = [];
    if (!r.units && !r.leads) reasons.push("nothing_added");
    if (!r.telegram) reasons.push("no_telegram");
    if (r.last_active_at && now.getTime() - new Date(r.last_active_at).getTime() > 7 * DAY) reasons.push("quiet");
    if (reasons.length) out.push({ ...r, reasons });
  }
  return out.slice(0, limit);
}

module.exports = { welcomeFor, closeWelcome, firstHint, telegramLink, supportUrl, progressOf, nudgeDue, nudgeJob, stuckList };
