// services/dashboards.js — Numbers for the agency dashboard and leaderboard (7.2, managers) and the owner's tracking
// dashboard (5.4, the product owner only). Read-only aggregate queries; the agency view never leaves its agency, and
// neither view returns a client's name or phone. Both share brokerActivity(), the per-broker figures for a period.
"use strict";

const Stages = require("../domain/leadStages");
const { MANAGER_ROLES } = require("../lib/authz");
const { getConfig } = require("../config");

const PERIODS = [7, 30, 90];
const DAY = 24 * 3600 * 1000;

const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());

/** The product owner: a broker whose id is listed in OWNER_BROKER_IDS. Nobody else, managers included. */
function isOwner(broker, config = getConfig()) {
  return Boolean(broker?.id) && config.owner.brokerIds.includes(String(broker.id).toLowerCase());
}

const periodOf = (days) => (PERIODS.includes(Number(days)) ? Number(days) : 30);

/**
 * Per-broker figures for one agency over [since, until): leads assigned, contacted, moved forward, viewings, deals,
 * commission share (deal_splits), units added, and the median minutes from a new lead to its first contact.
 * The agency's filter is on every query.
 */
async function brokerActivity(pool, agencyId, { since, until = new Date() }) {
  const args = [agencyId, since.toISOString(), until.toISOString()];
  const { rows: brokers } = await pool.query("SELECT id, name, role, is_active FROM brokers WHERE agency_id = $1 ORDER BY name", [agencyId]);
  const per = new Map(
    brokers.map((b) => [b.id, { id: b.id, name: b.name, role: b.role, active: b.is_active, leads: 0, contacted: 0, forward: 0, viewings: 0, deals: 0, commission: 0, units: 0, responseMin: null, open: 0 }])
  );
  const put = (rows, field, key = "n") => {
    for (const r of rows) if (per.has(r.broker_id)) per.get(r.broker_id)[field] = Number(r[key]) || 0;
  };
  put(
    (await pool.query(`SELECT assigned_broker_id AS broker_id, count(*)::int AS n FROM leads WHERE agency_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`, args)).rows,
    "leads"
  );
  put(
    (await pool.query(`SELECT assigned_broker_id AS broker_id, count(*)::int AS n FROM leads WHERE agency_id = $1 AND stage NOT IN ('won', 'lost') GROUP BY 1`, [agencyId])).rows,
    "open"
  );
  const { rows: events } = await pool.query(
    `SELECT broker_id, kind, data->>'to' AS to_stage, count(*)::int AS n FROM lead_events
      WHERE agency_id = $1 AND created_at >= $2 AND created_at < $3 AND undone_at IS NULL AND kind IN ('contacted', 'stage')
      GROUP BY 1, 2, 3`,
    args
  );
  const forward = new Set(["contacted", "interested", "viewing", "negotiation", "won"]);
  for (const e of events) {
    const b = per.get(e.broker_id);
    if (!b) continue;
    if (e.kind === "contacted") b.contacted += e.n;
    else if (forward.has(e.to_stage)) {
      b.forward += e.n;
      if (e.to_stage === "viewing") b.viewings += e.n;
    }
  }
  put(
    (
      await pool.query(
        `SELECT s.broker_id, count(DISTINCT d.id)::int AS n, coalesce(sum(s.amount), 0)::bigint AS commission
           FROM deals d JOIN deal_splits s ON s.deal_id = d.id AND s.agency_id = d.agency_id
          WHERE d.agency_id = $1 AND d.closed_at >= $2 AND d.closed_at < $3 AND d.status <> 'cancelled' GROUP BY 1`,
        args
      )
    ).rows,
    "deals"
  );
  put(
    (
      await pool.query(
        `SELECT s.broker_id, coalesce(sum(s.amount), 0)::bigint AS commission
           FROM deals d JOIN deal_splits s ON s.deal_id = d.id AND s.agency_id = d.agency_id
          WHERE d.agency_id = $1 AND d.closed_at >= $2 AND d.closed_at < $3 AND d.status <> 'cancelled' GROUP BY 1`,
        args
      )
    ).rows,
    "commission",
    "commission"
  );
  put(
    (await pool.query(`SELECT broker_id, count(*)::int AS n FROM listings WHERE agency_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`, args)).rows,
    "units"
  );
  // Response time: a lead's first "contacted" event (or its last_contact_at) after it arrived, per assigned broker.
  const { rows: resp } = await pool.query(
    `SELECT l.assigned_broker_id AS broker_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (coalesce(fc.at, l.last_contact_at) - l.created_at)) / 60) AS m
       FROM leads l
       LEFT JOIN LATERAL (SELECT min(e.created_at) AS at FROM lead_events e
                           WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.kind = 'contacted' AND e.undone_at IS NULL) fc ON true
      WHERE l.agency_id = $1 AND l.created_at >= $2 AND l.created_at < $3 AND coalesce(fc.at, l.last_contact_at) >= l.created_at
      GROUP BY 1`,
    args
  );
  for (const r of resp) if (per.has(r.broker_id) && r.m !== null) per.get(r.broker_id).responseMin = Math.round(Number(r.m));
  return [...per.values()];
}

/** The agency dashboard: pipeline now, the period's totals, and the leaderboard (deals, then commission, then moves). */
async function agencyDashboard(pool, manager, { days = 30, now = new Date(), brokerId = null } = {}) {
  if (!isManager(manager)) return null;
  const period = periodOf(days);
  const since = new Date(now.getTime() - period * DAY);
  const agencyId = manager.agency_id;
  const team = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [agencyId]);
  const who = team.rows.some((b) => b.id === brokerId) ? brokerId : null; // an id from another agency is ignored
  const lf = who ? " AND assigned_broker_id = $2" : "";
  const a = who ? [agencyId, who] : [agencyId];
  const { rows: stageRows } = await pool.query(`SELECT stage, count(*)::int AS n FROM leads WHERE agency_id = $1${lf} GROUP BY stage`, a);
  const pipeline = Object.fromEntries(Stages.STAGES.map((s) => [s, 0]));
  for (const r of stageRows) pipeline[r.stage] = r.n;
  const { rows: un } = await pool.query(
    `SELECT count(*) FILTER (WHERE assigned_broker_id IS NULL AND stage NOT IN ('won', 'lost'))::int AS unassigned,
            count(*) FILTER (WHERE stage = 'new' AND last_contact_at IS NULL)::int AS uncontacted,
            count(*) FILTER (WHERE follow_up_status = 'open' AND next_follow_up_at < $2)::int AS overdue
       FROM leads WHERE agency_id = $1${who ? " AND assigned_broker_id = $3" : ""}`,
    who ? [agencyId, now.toISOString(), who] : [agencyId, now.toISOString()]
  );
  const { rows: units } = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'active' AND coalesce(confirmed_at, updated_at) < $2)::int AS stale
       FROM listings WHERE agency_id = $1${who ? " AND broker_id = $3" : ""}`,
    who ? [agencyId, new Date(now.getTime() - 21 * DAY).toISOString(), who] : [agencyId, new Date(now.getTime() - 21 * DAY).toISOString()]
  );
  const { rows: dealRows } = await pool.query(
    `SELECT count(*)::int AS n, coalesce(sum(commission_total), 0)::bigint AS commission, coalesce(sum(price), 0)::bigint AS value
       FROM deals WHERE agency_id = $1 AND closed_at >= $2 AND status <> 'cancelled'${who ? " AND closing_broker_id = $3" : ""}`,
    who ? [agencyId, since.toISOString(), who] : [agencyId, since.toISOString()]
  );
  const brokers = (await brokerActivity(pool, agencyId, { since, until: now })).filter((b) => !who || b.id === who);
  const board = brokers
    .filter((b) => b.active || b.deals || b.leads)
    .sort((a, b) => b.deals - a.deals || b.commission - a.commission || b.forward - a.forward || b.contacted - a.contacted || a.name.localeCompare(b.name));
  const leads = brokers.reduce((n, b) => n + b.leads, 0);
  return {
    days: period,
    team: team.rows,
    brokerId: who,
    pipeline,
    ...un[0],
    units: units[0],
    deals: { n: dealRows[0].n, commission: Number(dealRows[0].commission), value: Number(dealRows[0].value) },
    leads,
    board
  };
}

/** Monday 00:00 Cairo of the week containing `at`. */
function weekStart(at) {
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(at));
  return Stages.cairoDayAt(at, -dow, 0);
}

/**
 * The owner's dashboard: weekly active agencies and brokers (anyone who used the bot or the website), units, leads and
 * deals created per week; AI calls and cost per agency for the last 30 days; errors and bug reports. Owner only.
 */
async function ownerDashboard(pool, broker, { weeks = 8, now = new Date(), config = getConfig() } = {}) {
  if (!isOwner(broker, config)) return null;
  const first = new Date(weekStart(now).getTime() - (weeks - 1) * 7 * DAY);
  const bucket = (col) => `date_trunc('week', (${col}) AT TIME ZONE 'Africa/Cairo')`;
  const weekly = async (sql) => (await pool.query(sql, [first.toISOString()])).rows;
  const activity = await weekly(
    `SELECT ${bucket("created_at")} AS week, count(DISTINCT agency_id)::int AS agencies, count(DISTINCT broker_id)::int AS brokers
       FROM operation_logs WHERE created_at >= $1 AND broker_id IS NOT NULL GROUP BY 1`
  );
  const created = async (table, col = "created_at", extra = "") => weekly(`SELECT ${bucket(col)} AS week, count(*)::int AS n FROM ${table} WHERE ${col} >= $1 ${extra} GROUP BY 1`);
  const units = await created("listings");
  const leads = await created("leads");
  const deals = await created("deals", "created_at", "AND status <> 'cancelled'");
  const errors = await weekly(
    `SELECT ${bucket("created_at")} AS week, count(*) FILTER (WHERE kind = 'error')::int AS errors, count(*) FILTER (WHERE kind = 'report')::int AS reports
       FROM error_events WHERE created_at >= $1 GROUP BY 1`
  );
  const key = (d) => new Date(d).toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(first.getTime() + i * 7 * DAY);
    rows.push({ week: Stages.toCairoLocal(start).slice(0, 10), agencies: 0, brokers: 0, units: 0, leads: 0, deals: 0, errors: 0, reports: 0 });
  }
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  const fill = (list, fields) => {
    for (const r of list) {
      const row = byWeek.get(key(r.week));
      if (row) for (const [from, to] of fields) row[to] = Number(r[from]) || 0;
    }
  };
  fill(activity, [["agencies", "agencies"], ["brokers", "brokers"]]);
  fill(units, [["n", "units"]]);
  fill(leads, [["n", "leads"]]);
  fill(deals, [["n", "deals"]]);
  fill(errors, [["errors", "errors"], ["reports", "reports"]]);

  const since30 = new Date(now.getTime() - 30 * DAY).toISOString();
  const { rows: ai } = await pool.query(
    `SELECT a.id, a.name, count(o.*)::int AS calls, count(o.*) FILTER (WHERE o.status = 'failed')::int AS failed,
            coalesce(sum(o.estimated_cost_usd), 0)::float AS usd
       FROM agencies a LEFT JOIN operation_logs o ON o.agency_id = a.id AND o.created_at >= $1 AND o.model_used IS NOT NULL
      GROUP BY a.id, a.name ORDER BY usd DESC, a.name`,
    [since30]
  );
  const { rows: people } = await pool.query(
    `SELECT a.id, count(b.*) FILTER (WHERE b.is_active)::int AS brokers,
            count(b.*) FILTER (WHERE b.is_active AND b.telegram_chat_id IS NOT NULL)::int AS telegram,
            max(b.last_active_at) AS last_active
       FROM agencies a LEFT JOIN brokers b ON b.agency_id = a.id GROUP BY a.id`
  );
  const peopleBy = new Map(people.map((p) => [p.id, p]));
  const agencies = ai.map((a) => ({ ...a, usd: Number(a.usd), ...(peopleBy.get(a.id) ? { brokers: peopleBy.get(a.id).brokers, telegram: peopleBy.get(a.id).telegram, lastActive: peopleBy.get(a.id).last_active } : {}) }));
  const { rows: topErrors } = await pool.query(
    `SELECT fingerprint, kind, source, max(message) AS message, count(*)::int AS n, max(created_at) AS last, max(id) AS last_id
       FROM error_events WHERE created_at >= $1 AND resolved_at IS NULL GROUP BY fingerprint, kind, source ORDER BY n DESC, last DESC LIMIT 10`,
    [new Date(now.getTime() - 7 * DAY).toISOString()]
  );
  const { rows: jobs } = await pool.query("SELECT name, last_status, last_finished_at, last_error FROM crm_jobs ORDER BY name");
  const { rows: trials } = await pool.query("SELECT id, name, agency_name, phone_e164, team_size, created_at FROM demo_requests ORDER BY created_at DESC LIMIT 20");
  return { weeks: rows, agencies, topErrors, jobs, trials, totalUsd: agencies.reduce((s, a) => s + a.usd, 0) };
}

module.exports = { PERIODS, isOwner, isManager, brokerActivity, agencyDashboard, ownerDashboard, weekStart };
