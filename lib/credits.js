// lib/credits.js — Message credits (Q15): 1 credit = 1 WhatsApp message the bot sends
"use strict";

const { getConfig } = require("../config");

// Sends with their own ceiling, never counted in the credits.
const LOGIN_KINDS = ["web_login_link"];
const HINT_LEVELS = [50, 80, 100];

/**
 * Cairo calendar boundaries for a moment: month, ISO week (Saturday start, like the Egyptian work
 * week) and day, as SQL expressions over the parameter $now.
 */
const MONTH_START = "(date_trunc('month', $NOW AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')";
const DAY_START = "(date_trunc('day', $NOW AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')";
// Saturday-based week: shift by 2 days so date_trunc('week') (Monday) lands on Saturday.
const WEEK_START = "((date_trunc('week', ($NOW AT TIME ZONE 'Africa/Cairo') + INTERVAL '2 days') - INTERVAL '2 days') AT TIME ZONE 'Africa/Cairo')";

const sql = (s, nowParam) => s.replaceAll("$NOW", `${nowParam}::timestamptz`);

/** "2026-11" in Cairo time. */
function monthKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(now).slice(0, 7);
}
/** "2026-11-05" in Cairo time. */
function dayKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Credit state for a broker's agency now.
 * @returns {Promise<{ used, limit, remaining, pct, level: "ok"|"warn"|"limit"|"ceiling", global: { used, limit },
 *   broker: { day, week, dailyCap, weeklyCap, capped }, login: { used, limit, reached } }>}
 */
async function check(pool, broker, { now = new Date() } = {}) {
  const cfg = getConfig().credits;
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const { rows } = await pool.query(
    sql(
      `SELECT
         a.wa_credits_monthly, a.wa_broker_daily_cap, a.wa_broker_weekly_cap,
         (SELECT count(*) FROM operation_logs o
           WHERE o.operation_type = 'wa_outbound' AND o.status = 'success'
             AND o.created_at >= ${MONTH_START} AND o.created_at <= $NOW
             AND COALESCE(o.metadata->>'kind', '') <> ALL($3::text[]))::int AS global_used,
         c.agency_used, c.login_used, c.broker_day, c.broker_week
       FROM agencies a
       CROSS JOIN LATERAL (
         SELECT
           count(*) FILTER (WHERE NOT o.login)::int AS agency_used,
           count(*) FILTER (WHERE o.login)::int AS login_used,
           count(*) FILTER (WHERE NOT o.login AND o.broker_id = $2 AND o.created_at >= ${DAY_START})::int AS broker_day,
           count(*) FILTER (WHERE NOT o.login AND o.broker_id = $2 AND o.created_at >= ${WEEK_START})::int AS broker_week
         FROM (SELECT broker_id, created_at, COALESCE(metadata->>'kind', '') = ANY($3::text[]) AS login
                 FROM operation_logs
                WHERE operation_type = 'wa_outbound' AND status = 'success' AND agency_id = a.id
                  AND created_at >= ${MONTH_START} AND created_at <= $NOW) o
       ) c
       WHERE a.id = $1`,
      "$4"
    ),
    [broker.agency_id, broker.id || null, LOGIN_KINDS, at]
  );
  const r = rows[0] || {};
  const limit = r.wa_credits_monthly ?? cfg.monthly;
  const used = r.agency_used || 0;
  const pct = limit > 0 ? Math.floor((used * 100) / limit) : 100;
  const globalUsed = r.global_used || 0;
  const dailyCap = r.wa_broker_daily_cap || null;
  const weeklyCap = r.wa_broker_weekly_cap || null;
  const capped = Boolean((dailyCap && r.broker_day >= dailyCap) || (weeklyCap && r.broker_week >= weeklyCap));

  let level = "ok";
  if (pct >= cfg.warnPct) level = "warn";
  if (pct >= 100) level = "limit";
  if (pct >= cfg.ceilingPct || globalUsed >= cfg.globalMonthly || capped) level = "ceiling";

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    pct,
    level,
    global: { used: globalUsed, limit: cfg.globalMonthly },
    broker: { day: r.broker_day || 0, week: r.broker_week || 0, dailyCap, weeklyCap, capped },
    login: { used: r.login_used || 0, limit: cfg.loginMonthly, reached: (r.login_used || 0) >= cfg.loginMonthly }
  };
}

/** Notifications go on WhatsApp only below 100%. */
const canNotify = (state) => state.level === "ok" || state.level === "warn";

/** Replies continue until the ceiling; sign-in links have their own ceiling. */
function allowsSend(state, kind) {
  if (LOGIN_KINDS.includes(kind)) return !state.login.reached;
  if (String(kind).startsWith("notify")) return canNotify(state);
  return state.level !== "ceiling";
}

/** The highest hint threshold reached (50, 80, 100), or null. */
function hintLevel(state) {
  let out = null;
  for (const l of HINT_LEVELS) if (state.pct >= l) out = l;
  return out;
}

/**
 * Usage for the website page: this month by action, today, and (managers) per broker.
 * Only accepted sends count; sign-in links are listed apart.
 */
async function usage(pool, agencyId, { brokerId = null, now = new Date() } = {}) {
  const at = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const base = sql(
    `FROM operation_logs WHERE operation_type = 'wa_outbound' AND status = 'success' AND agency_id = $1
       AND created_at >= ${MONTH_START} AND created_at <= $NOW`,
    "$2"
  );
  const byAction = await pool.query(
    `SELECT COALESCE(metadata->>'action', 'other') AS action, count(*)::int AS n,
            count(*) FILTER (WHERE created_at >= ${sql(DAY_START, "$2")})::int AS today
       ${base} AND ($3::uuid IS NULL OR broker_id = $3) AND COALESCE(metadata->>'kind', '') <> ALL($4::text[])
      GROUP BY 1 ORDER BY 2 DESC`,
    [agencyId, at, brokerId, LOGIN_KINDS]
  );
  const byBroker = await pool.query(
    `SELECT b.id, b.name, count(o.id)::int AS n,
            count(o.id) FILTER (WHERE o.created_at >= ${sql(DAY_START, "$2")})::int AS today
       FROM brokers b
       LEFT JOIN operation_logs o ON o.broker_id = b.id AND o.agency_id = b.agency_id
        AND o.operation_type = 'wa_outbound' AND o.status = 'success'
        AND o.created_at >= ${sql(MONTH_START, "$2")} AND o.created_at <= $2::timestamptz
        AND COALESCE(o.metadata->>'kind', '') <> ALL($3::text[])
      WHERE b.agency_id = $1
      GROUP BY b.id, b.name ORDER BY 3 DESC, b.name`,
    [agencyId, at, LOGIN_KINDS]
  );
  const login = await pool.query(`SELECT count(*)::int AS n ${base} AND metadata->>'kind' = ANY($3::text[])`, [agencyId, at, LOGIN_KINDS]);
  const actions = byAction.rows;
  return {
    actions,
    total: actions.reduce((s, r) => s + r.n, 0),
    today: actions.reduce((s, r) => s + r.today, 0),
    brokers: byBroker.rows,
    login: login.rows[0].n
  };
}

module.exports = { LOGIN_KINDS, HINT_LEVELS, monthKey, dayKey, check, canNotify, allowsSend, hintLevel, usage };
