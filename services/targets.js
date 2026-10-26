// services/targets.js — Monthly targets per broker (Release B, N6). Managers set a standing monthly target of deals
// and/or commission for each broker (brokers.target_deals, target_commission). Progress counts the current Cairo
// month's deals that aren't cancelled, by closed_at, with the broker's share from deal_splits (the same numbers as the
// dashboard's leaderboard). Shown in the broker's morning brief, on the agency dashboard and the Team page.
"use strict";

const Stages = require("../domain/leadStages");
const { isManager } = require("../lib/authz");

const MAX_DEALS = 1000;

/** The Cairo month containing `now`: { start, end, days, dayOf }. */
function monthOf(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
  const today = Stages.cairoDayAt(now, 0, 0);
  const start = new Date(today.getTime() - (d - 1) * 24 * 3600 * 1000);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = new Date(start.getTime() + days * 24 * 3600 * 1000 + 3 * 3600 * 1000); // DST-safe: next month's Cairo midnight ± 1 h
  return { start, end: Stages.cairoDayAt(end, 0, 0), days, dayOf: d };
}

function parseTarget(v, max) {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= max ? n : NaN;
}

/** A manager sets (or clears) a broker's monthly target. */
async function setTarget(db, manager, brokerId, { deals, commission }) {
  if (!isManager(manager)) return { error: "forbidden" };
  const d = parseTarget(deals, MAX_DEALS);
  const c = parseTarget(commission, 1e12);
  if (Number.isNaN(d)) return { error: "target_deals" };
  if (Number.isNaN(c)) return { error: "target_commission" };
  const { rows } = await db.query("UPDATE brokers SET target_deals = $3, target_commission = $4 WHERE id = $1 AND agency_id = $2 RETURNING id, name, target_deals, target_commission", [brokerId, manager.agency_id, d, c]);
  return rows[0] ? { ok: true, broker: rows[0] } : { error: "not_found" };
}

/** Progress for every active broker with a target (or one broker): Map id → { name, deals, commission, target_deals, target_commission }. */
async function progress(db, agencyId, { now = new Date(), brokerId = null } = {}) {
  const m = monthOf(now);
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.target_deals, b.target_commission,
            coalesce(x.n, 0)::int AS deals, coalesce(x.commission, 0)::bigint AS commission
       FROM brokers b
       LEFT JOIN (SELECT s.broker_id, count(DISTINCT d.id) AS n, sum(s.amount) AS commission
                    FROM deals d JOIN deal_splits s ON s.deal_id = d.id AND s.agency_id = d.agency_id
                   WHERE d.agency_id = $1 AND d.closed_at >= $2 AND d.closed_at < $3 AND d.status <> 'cancelled' GROUP BY 1) x ON x.broker_id = b.id
      WHERE b.agency_id = $1 AND b.is_active AND (b.target_deals IS NOT NULL OR b.target_commission IS NOT NULL) AND ($4::uuid IS NULL OR b.id = $4)
      ORDER BY b.name`,
    [agencyId, m.start.toISOString(), m.end.toISOString(), brokerId]
  );
  return new Map(rows.map((r) => [r.id, { ...r, commission: Number(r.commission), target_commission: r.target_commission === null ? null : Number(r.target_commission), month: m }]));
}

const pct = (n, of) => (of ? Math.min(999, Math.round((n / of) * 100)) : null);

/** "🎯 This month: 2/4 deals · 30,000/100,000 EGP (30%)" for the brief; null without a target. */
function briefLine(p, lang, money) {
  if (!p) return null;
  const en = lang === "en";
  const parts = [];
  if (p.target_deals) parts.push(en ? `${p.deals}/${p.target_deals} deals` : `${p.deals}/${p.target_deals} صفقات`);
  if (p.target_commission) parts.push(`${money(p.commission)}/${money(p.target_commission)} (${pct(p.commission, p.target_commission)}%)`);
  const left = p.month.days - p.month.dayOf + 1;
  return `🎯 ${en ? "This month" : "هدف الشهر"}: ${parts.join(" · ")} · ${en ? `${left} days left` : `فاضل ${left} يوم`}`;
}

module.exports = { monthOf, setTarget, progress, briefLine, pct };
