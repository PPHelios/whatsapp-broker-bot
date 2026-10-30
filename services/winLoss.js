// services/winLoss.js — The win and loss report (Release B, N7, managers): leads closed in the period (won by a deal
// or the stage, lost with a reason), counted when they closed (the latest won/lost event that wasn't undone), with
// lost reasons grouped (domain/winLoss.js), and win rate and top loss reason per broker and per source.
"use strict";

const W = require("../domain/winLoss");
const { isManager } = require("../lib/authz");
const Vis = require("../lib/visibility");

const PERIODS = [30, 90, 365];
const NONE = "__none__";

async function report(db, manager, { days = 90, now = new Date() } = {}) {
  if (!isManager(manager)) return null;
  const d = PERIODS.includes(Number(days)) ? Number(days) : 90;
  const since = new Date(now.getTime() - d * 24 * 3600 * 1000);
  const { rows } = await db.query(
    `SELECT l.id, l.stage, l.lost_reason, l.source, b.id AS broker_id, b.name AS broker_name, c.closed_at
       FROM leads l
       JOIN LATERAL (SELECT max(e.created_at) AS closed_at FROM lead_events e
                      WHERE e.lead_id = l.id AND e.agency_id = l.agency_id AND e.undone_at IS NULL
                        AND (e.kind = 'deal' OR (e.kind = 'stage' AND e.data->>'to' = l.stage))) c ON true
       LEFT JOIN brokers b ON b.id = l.assigned_broker_id
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.stage IN ('won', 'lost') AND c.closed_at >= $2 AND c.closed_at <= $3`,
    [manager.agency_id, since.toISOString(), now.toISOString()]
  );
  const reasons = {};
  const group = (map, key, name, r) => {
    if (!map.has(key)) map.set(key, { key, name, won: 0, lost: 0, reasons: {} });
    const g = map.get(key);
    if (r.stage === "won") g.won++;
    else {
      g.lost++;
      g.reasons[r.reason] = (g.reasons[r.reason] || 0) + 1;
    }
  };
  const byBroker = new Map();
  const bySource = new Map();
  let won = 0;
  let lost = 0;
  const examples = {};
  for (const r of rows) {
    if (r.stage === "won") won++;
    else {
      lost++;
      r.reason = W.classify(r.lost_reason);
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      if (r.lost_reason && (examples[r.reason] || []).length < 3 && !(examples[r.reason] || []).includes(r.lost_reason)) (examples[r.reason] ||= []).push(r.lost_reason);
    }
    group(byBroker, r.broker_id || NONE, r.broker_name || null, r);
    group(bySource, r.source || NONE, r.source || null, r);
  }
  const finish = (map) =>
    [...map.values()]
      .map((g) => ({ ...g, rate: W.winRate(g.won, g.lost), top: Object.entries(g.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null }))
      .sort((a, b) => b.won + b.lost - (a.won + a.lost));
  return {
    days: d,
    won,
    lost,
    rate: W.winRate(won, lost),
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n, pct: Math.round((n / lost) * 100), examples: examples[key] || [] })),
    brokers: finish(byBroker),
    sources: finish(bySource)
  };
}

module.exports = { PERIODS, NONE, report };
