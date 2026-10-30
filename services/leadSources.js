// services/leadSources.js — Lead sources and what they cost (phase 2 step 7). For one Cairo month: per source, the
// leads that arrived, the deals closed with a lead from it (not cancelled), their commission, the ad spend managers
// typed, and cost per lead and per deal. A lead without a source counts as "—". Managers only; one agency only;
// numbers only (no client's name or phone).
"use strict";

const Stages = require("../domain/leadStages");
const { MANAGER_ROLES } = require("../lib/authz");
const Vis = require("../lib/visibility");

const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());
const NONE = "—";

/** "2026-10" → "2026-10-01"; anything else → the current Cairo month. */
function monthOf(text, now = new Date()) {
  const m = String(text || "").match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  return m ? `${m[1]}-${m[2]}-01` : `${Stages.toCairoLocal(now).slice(0, 7)}-01`;
}

/** The instants a Cairo month starts and ends. */
function monthRange(month) {
  const [y, mo] = month.split("-").map(Number);
  const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  return { since: Stages.fromCairoLocal(`${month.slice(0, 7)}-01T00:00`), until: Stages.fromCairoLocal(`${next}-01T00:00`) };
}

/**
 * The source report for a month: { month, rows: [{ source, leads, deals, commission, spend, perLead, perDeal }], totals }
 * or null for a broker who isn't a manager.
 */
async function report(pool, actor, { month: monthText = null, now = new Date() } = {}) {
  if (!isManager(actor)) return null;
  const month = monthOf(monthText, now);
  const { since, until } = monthRange(month);
  const args = [actor.agency_id, since.toISOString(), until.toISOString()];
  const [{ rows: leads }, { rows: deals }, { rows: spend }] = await Promise.all([
    pool.query(`SELECT COALESCE(NULLIF(source, ''), '${NONE}') AS source, count(*)::int AS n FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`, args),
    pool.query(
      `SELECT COALESCE(NULLIF(l.source, ''), '${NONE}') AS source, count(*)::int AS n, COALESCE(sum(d.commission_total - d.external_share), 0)::bigint AS commission
         FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
        WHERE ${Vis.leads("l")} AND d.agency_id = $1 AND d.closed_at >= $2 AND d.closed_at < $3 AND d.status <> 'cancelled' GROUP BY 1`,
      args
    ),
    pool.query("SELECT source, amount_egp FROM ad_spend WHERE agency_id = $1 AND month = $2", [actor.agency_id, month])
  ]);
  const by = new Map();
  const row = (source) => {
    if (!by.has(source)) by.set(source, { source, leads: 0, deals: 0, commission: 0, spend: 0 });
    return by.get(source);
  };
  for (const r of leads) row(r.source).leads = r.n;
  for (const r of deals) Object.assign(row(r.source), { deals: r.n, commission: Number(r.commission) });
  for (const r of spend) row(r.source).spend = Number(r.amount_egp);
  // The common sources are always listed, so spend can be typed before the first lead arrives.
  for (const [en] of Stages.SOURCES) row(en);
  const per = (spent, n) => (spent > 0 && n > 0 ? Math.round(spent / n) : null);
  const rows = [...by.values()]
    .map((r) => ({ ...r, perLead: per(r.spend, r.leads), perDeal: per(r.spend, r.deals) }))
    .sort((a, b) => b.leads - a.leads || b.spend - a.spend || a.source.localeCompare(b.source));
  const totals = rows.reduce((t, r) => ({ leads: t.leads + r.leads, deals: t.deals + r.deals, commission: t.commission + r.commission, spend: t.spend + r.spend }), { leads: 0, deals: 0, commission: 0, spend: 0 });
  totals.perLead = per(totals.spend, totals.leads);
  totals.perDeal = per(totals.spend, totals.deals);
  return { month, rows, totals };
}

/**
 * Saves a month's spend: { source: amount } (an empty or 0 amount removes it). → { ok, saved } or { error }
 */
async function saveSpend(pool, actor, { month: monthText, spend = {} } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthText || ""))) return { error: "month" };
  const month = monthOf(monthText);
  let saved = 0;
  for (const [rawSource, rawAmount] of Object.entries(spend).slice(0, 100)) {
    const source = String(rawSource || "").trim().slice(0, 60);
    if (!source || source === NONE) continue;
    const text = String(rawAmount ?? "").replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660)).replace(/[,\s٬]/g, "");
    if (text !== "" && !/^\d{1,12}$/.test(text)) return { error: "amount", source };
    const amount = text === "" ? 0 : Number(text);
    if (amount === 0) {
      await pool.query("DELETE FROM ad_spend WHERE agency_id = $1 AND month = $2 AND source = $3", [actor.agency_id, month, source]);
    } else {
      await pool.query(
        `INSERT INTO ad_spend (agency_id, month, source, amount_egp, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agency_id, month, source) DO UPDATE SET amount_egp = EXCLUDED.amount_egp, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [actor.agency_id, month, source, amount, actor.id]
      );
      saved++;
    }
  }
  return { ok: true, saved };
}

module.exports = { NONE, monthOf, monthRange, report, saveSpend };
