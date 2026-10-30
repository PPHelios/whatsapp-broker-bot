// services/leadRules.js — Lead response rules and the team's availability (Release A, R3). Managers switch the rule on
// per agency with the waiting minutes and working hours (domain/leadRules.js). A lead someone else gave a broker
// carries a deadline (leads.response_due_at); a scheduler job moves a lead still uncontacted at its deadline to the
// next available broker (round robin: active, not away, longest without a lead first, never one who already let it
// pass), tells the new broker, the old one and the managers, and stops after max_jumps (the managers decide then).
// Also: a broker's "away until" date, the managers' per-broker notification switches, and speed-to-lead per broker.
"use strict";

const Rules = require("../domain/leadRules");
const Card = require("../domain/leadCard");
const Notifications = require("../lib/notifications");
const { MANAGER_ROLES } = require("../lib/authz");
const { withTransaction } = require("../lib/db");
const Vis = require("../lib/visibility");

const BATCH = 100;
const DAY = 24 * 3600 * 1000;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, away_until";
const SWITCHABLE = [...Notifications.KINDS, ...Notifications.DAILY_KINDS];

const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());
const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const leadUrl = (lead) => `/app/leads/${Card.refLabel(lead.ref)}`;

async function getRules(db, agencyId) {
  const { rows } = await db.query("SELECT lead_rules FROM agencies WHERE id = $1", [agencyId]);
  return Rules.rulesOf(rows[0]?.lead_rules);
}

/** Saves the managers' form: { ok, rules } | { error, field }. */
async function saveRules(pool, manager, input) {
  if (!isManager(manager)) return { error: "forbidden" };
  const r = Rules.rulesFields(input);
  if (r.error) return r;
  await pool.query("UPDATE agencies SET lead_rules = $2::jsonb WHERE id = $1", [manager.agency_id, JSON.stringify(r.fields)]);
  // Switching off drops the open deadlines, so nothing jumps later from an old setting.
  if (!r.fields.enabled) await pool.query("UPDATE leads SET response_due_at = NULL WHERE agency_id = $1 AND response_due_at IS NOT NULL", [manager.agency_id]);
  return { ok: true, rules: Rules.rulesOf(r.fields) };
}

/** The deadline for a lead assigned now, or null when the agency's rule is off. */
async function deadlineFor(db, agencyId, now = new Date()) {
  const rules = await getRules(db, agencyId);
  return rules.enabled ? Rules.dueAt(rules, now) : null;
}

/** Cairo midnight at the start of "YYYY-MM-DD" (Egypt has summer time, so the offset is read for that day). */
function cairoMidnight(day) {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const offset = Rules.cairo(new Date(utc)).hour; // 2 or 3
  return new Date(utc - offset * 3600 * 1000);
}

/** A manager marks one of their brokers away until a day (back that day), or clears it with an empty day. */
async function setAway(pool, manager, brokerId, day, { now = new Date() } = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  let until = null;
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return { error: "away_date" };
    until = cairoMidnight(String(day));
    if (until.getTime() <= now.getTime() || until.getTime() > now.getTime() + 366 * DAY) return { error: "away_date" };
  }
  const { rows } = await pool.query("UPDATE brokers SET away_until = $3 WHERE id = $1 AND agency_id = $2 AND is_active RETURNING id, name, away_until", [
    brokerId,
    manager.agency_id,
    until ? until.toISOString() : null
  ]);
  return rows[0] ? { ok: true, broker: rows[0] } : { error: "not_found" };
}

/** The managers' switches: kinds a broker gets in the inbox only (never sent). */
async function setSwitches(pool, manager, brokerId, off) {
  if (!isManager(manager)) return { error: "forbidden" };
  const clean = [...new Set([].concat(off ?? []).filter((k) => SWITCHABLE.includes(k)))];
  const { rows } = await pool.query(
    "UPDATE brokers SET notify_prefs = notify_prefs || jsonb_build_object('off', $3::jsonb) WHERE id = $1 AND agency_id = $2 RETURNING id, name",
    [brokerId, manager.agency_id, JSON.stringify(clean)]
  );
  return rows[0] ? { ok: true, broker: rows[0], off: clean } : { error: "not_found" };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** P2: the agency's lead routing: { round_robin, order: [broker ids], last }. */
async function routingOf(db, agencyId) {
  const { rows } = await db.query("SELECT lead_routing FROM agencies WHERE id = $1", [agencyId]);
  const r = rows[0]?.lead_routing || {};
  return { round_robin: r.round_robin !== false, order: Array.isArray(r.order) ? r.order.filter((id) => UUID_RE.test(id)) : [], last: UUID_RE.test(r.last || "") ? r.last : null };
}

/** The managers' switch and order (broker ids, first gets the next lead). */
async function saveRouting(pool, manager, { roundRobin, order }) {
  if (!isManager(manager)) return { error: "forbidden" };
  const { rows } = await pool.query("SELECT id FROM brokers WHERE agency_id = $1 AND is_active", [manager.agency_id]);
  const known = new Set(rows.map((r) => r.id));
  const clean = [...new Set([].concat(order ?? []).filter((id) => known.has(id)))];
  const now = await routingOf(pool, manager.agency_id);
  const routing = { round_robin: Boolean(roundRobin), order: clean, last: now.last };
  await pool.query("UPDATE agencies SET lead_routing = $2::jsonb WHERE id = $1", [manager.agency_id, JSON.stringify(routing)]);
  return { ok: true, routing };
}

/** Active brokers in routing order with their open leads (stage not won or lost): the managers' list. */
async function routingList(db, agencyId) {
  const routing = await routingOf(db, agencyId);
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.role, b.away_until,
            (SELECT count(*)::int FROM leads l WHERE ${Vis.leads("l")} AND l.assigned_broker_id = b.id AND l.agency_id = b.agency_id AND l.stage NOT IN ('won', 'lost')) AS open_leads
       FROM brokers b WHERE b.agency_id = $1 AND b.is_active
      ORDER BY (lower(b.role) = 'broker') DESC, b.name, b.id`,
    [agencyId]
  );
  const pos = new Map(routing.order.map((id, i) => [id, i]));
  rows.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e6) - (pos.has(b.id) ? pos.get(b.id) : 1e6));
  return { routing, brokers: rows };
}

/**
 * The next broker for a lead: active, not away, not excluded. P2: none when the agency switched round robin off; with
 * a set order, the next one in that order after the last broker who got a lead (brokers not in the order come after,
 * brokers before managers); without an order, brokers before managers, the one who has gone longest without a lead
 * first. advance: remember who got it, so the next lead goes to the one after.
 */
async function nextBroker(db, agencyId, { exclude = [], now = new Date(), advance = false } = {}) {
  const routing = await routingOf(db, agencyId);
  if (!routing.round_robin) return null;
  const { rows } = await db.query(
    `SELECT ${BROKER_COLS} FROM brokers
      WHERE agency_id = $1 AND is_active AND NOT (id = ANY($2::uuid[])) AND (away_until IS NULL OR away_until <= $3)
      ORDER BY (lower(role) = 'broker') DESC, last_lead_at NULLS FIRST, name, id`,
    [agencyId, exclude, now.toISOString()]
  );
  let pick = rows[0] || null;
  if (routing.order.length && rows.length) {
    const pos = new Map(routing.order.map((id, i) => [id, i]));
    const ordered = [...rows].sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e6 + rows.indexOf(a)) - (pos.has(b.id) ? pos.get(b.id) : 1e6 + rows.indexOf(b)));
    const all = [...routing.order, ...ordered.filter((b) => !pos.has(b.id)).map((b) => b.id)];
    const start = routing.last ? all.indexOf(routing.last) + 1 : 0;
    const eligible = new Set(ordered.map((b) => b.id));
    for (let i = 0; i < all.length; i++) {
      const id = all[(start + i) % all.length];
      if (eligible.has(id)) {
        pick = ordered.find((b) => b.id === id);
        break;
      }
    }
  }
  if (pick && advance) await db.query("UPDATE agencies SET lead_routing = lead_routing || jsonb_build_object('last', $2::text) WHERE id = $1", [agencyId, pick.id]);
  return pick;
}

/** Scheduler step: moves every lead past its deadline. → { moved, stopped } */
async function moveOverdue(pool, { now = new Date(), limit = BATCH } = {}) {
  const out = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM leads
        WHERE ${Vis.leads("leads")} AND response_due_at IS NOT NULL AND response_due_at <= $1
        ORDER BY response_due_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit]
    );
    const moved = [];
    const stopped = [];
    const rulesBy = new Map();
    for (const lead of rows) {
      const clear = () => client.query("UPDATE leads SET response_due_at = NULL WHERE id = $1", [lead.id]);
      // Contacted, moved on, or unassigned since: nothing to do.
      if (lead.stage !== "new" || lead.last_contact_at || !lead.assigned_broker_id) {
        await clear();
        continue;
      }
      if (!rulesBy.has(lead.agency_id)) rulesBy.set(lead.agency_id, await getRules(client, lead.agency_id));
      const rules = rulesBy.get(lead.agency_id);
      if (!rules.enabled) {
        await clear();
        continue;
      }
      const { rows: past } = await client.query(
        "SELECT DISTINCT data->>'from' AS id FROM lead_events WHERE lead_id = $1 AND agency_id = $2 AND kind = 'assigned' AND data->>'reason' = 'no_response'",
        [lead.id, lead.agency_id]
      );
      const exclude = [lead.assigned_broker_id, ...past.map((r) => r.id).filter(Boolean)];
      const next = lead.response_jumps < rules.max_jumps ? await nextBroker(client, lead.agency_id, { exclude, now, advance: true }) : null;
      if (!next) {
        await clear();
        stopped.push({ lead, reason: lead.response_jumps < rules.max_jumps ? "nobody" : "max" });
        continue;
      }
      const due = Rules.dueAt(rules, now);
      const { rows: upd } = await client.query(
        `UPDATE leads SET assigned_broker_id = $2, assigned_at = $3, response_due_at = $4, response_jumps = response_jumps + 1,
                follow_up_reminded_at = NULL, updated_at = $3, version = version + 1
          WHERE id = $1 RETURNING *`,
        [lead.id, next.id, now.toISOString(), due.toISOString()]
      );
      await client.query("UPDATE brokers SET last_lead_at = $2 WHERE id = $1", [next.id, now.toISOString()]);
      await client.query(
        `INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at)
         VALUES ($1, $2, NULL, 'assigned', $3, $4)`,
        [lead.agency_id, lead.id, JSON.stringify({ from: lead.assigned_broker_id, to: next.id, to_name: next.name, reason: "no_response", wait_minutes: rules.wait_minutes }), now.toISOString()]
      );
      moved.push({ lead: upd[0], from: lead.assigned_broker_id, to: next, rules });
    }
    return { moved, stopped };
  });
  for (const m of out.moved) await tellMove(pool, m, now);
  for (const s of out.stopped) await tellStop(pool, s, now);
  return { moved: out.moved.length, stopped: out.stopped.length };
}

async function brokerOf(pool, agencyId, id) {
  const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [id, agencyId]);
  return rows[0] || null;
}

async function tellMove(pool, { lead, from, to, rules }, now) {
  const ref = Card.refLabel(lead.ref);
  const old = await brokerOf(pool, lead.agency_id, from);
  const mins = rules.wait_minutes;
  await Notifications.notifyBroker(pool, to, {
    kind: "assignment",
    dedupeKey: `lead_assigned:${lead.id}:${to.id}:${lead.version}`,
    title: L(to, `🧑‍💼 عميل جديد ليك: ${Card.displayName(lead, "ar")} · ${ref}`, `🧑‍💼 New lead for you: ${Card.displayName(lead, "en")} · ${ref}`),
    body: [Card.card(lead, { lang: en(to) ? "en" : "ar" }), L(to, `⏱️ كلّمه في خلال ${mins} دقيقة شغل، وإلا هيتحول لزميل.`, `⏱️ Contact them within ${mins} working minutes, or they move to a colleague.`)].join("\n"),
    url: leadUrl(lead),
    leadId: lead.id,
    now
  });
  if (old) {
    await Notifications.notifyBroker(pool, old, {
      kind: "assignment",
      dedupeKey: `lead_moved:${lead.id}:${old.id}:${lead.version}`,
      title: L(old, `↪️ ${ref} اتحول لـ ${to.name}`, `↪️ ${ref} moved to ${to.name}`),
      body: L(old, `محدش كلّمه في ${mins} دقيقة.`, `Nobody contacted them within ${mins} minutes.`),
      url: "/app/leads",
      now
    });
  }
  for (const m of await Notifications.managersOf(pool, lead.agency_id)) {
    await Notifications.notifyBroker(pool, m, {
      kind: "manager_alert",
      dedupeKey: `lead_jump:${lead.id}:${lead.version}`,
      title: L(m, `↪️ ${ref} اتحول من ${old?.name || "—"} لـ ${to.name}`, `↪️ ${ref} moved from ${old?.name || "—"} to ${to.name}`),
      body: L(m, `مكلّمهوش في ${mins} دقيقة شغل.`, `Not contacted within ${mins} working minutes.`),
      url: leadUrl(lead),
      leadId: lead.id,
      now
    });
  }
}

async function tellStop(pool, { lead, reason }, now) {
  const ref = Card.refLabel(lead.ref);
  const holder = await brokerOf(pool, lead.agency_id, lead.assigned_broker_id);
  for (const m of await Notifications.managersOf(pool, lead.agency_id)) {
    await Notifications.notifyBroker(pool, m, {
      kind: "manager_alert",
      dedupeKey: `lead_jump_stop:${lead.id}:${lead.version}`,
      title: L(m, `⚠️ ${ref} لسه محدش كلّمه`, `⚠️ Nobody has contacted ${ref} yet`),
      body:
        reason === "max"
          ? L(m, `اتحول ${lead.response_jumps} مرات ولسه مع ${holder?.name || "—"}. حوّله بنفسك أو كلّمه.`, `It moved ${lead.response_jumps} times and is still with ${holder?.name || "—"}. Reassign or call them yourself.`)
          : L(m, `مفيش زميل متاح ياخده (الكل في إجازة أو اتجرب). لسه مع ${holder?.name || "—"}.`, `No colleague is available to take it (everyone is away or has tried). Still with ${holder?.name || "—"}.`),
      url: leadUrl(lead),
      leadId: lead.id,
      now
    });
  }
}

/** The scheduler job entry (lib/jobs.js). */
const responseJob = () => ({
  name: "lead_response",
  everyMs: 60 * 1000,
  run: async ({ pool, now }) => ({ counts: await moveOverdue(pool, { now: new Date(now) }) })
});

/**
 * Speed-to-lead per broker over the last `days`: leads contacted after someone gave them one (count, median minutes,
 * how many within the waiting minutes) and leads that moved away unanswered. → Map(broker_id → stats)
 */
async function speedToLead(pool, agencyId, { days = 30, now = new Date(), waitMinutes = null } = {}) {
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const wait = waitMinutes ?? (await getRules(pool, agencyId)).wait_minutes;
  const { rows } = await pool.query(
    `SELECT broker_id, count(*)::int AS n,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY (data->>'response_min')::numeric) AS median,
            count(*) FILTER (WHERE (data->>'response_min')::numeric <= $3)::int AS on_time
       FROM lead_events
      WHERE agency_id = $1 AND kind = 'contacted' AND undone_at IS NULL AND created_at >= $2 AND data ? 'response_min' AND broker_id IS NOT NULL
      GROUP BY broker_id`,
    [agencyId, since, wait]
  );
  const { rows: missed } = await pool.query(
    `SELECT data->>'from' AS broker_id, count(*)::int AS n FROM lead_events
      WHERE agency_id = $1 AND kind = 'assigned' AND data->>'reason' = 'no_response' AND created_at >= $2 GROUP BY 1`,
    [agencyId, since]
  );
  const out = new Map();
  const get = (id) => {
    if (!out.has(id)) out.set(id, { responded: 0, median: null, on_time: 0, missed: 0 });
    return out.get(id);
  };
  for (const r of rows) Object.assign(get(r.broker_id), { responded: r.n, median: r.median === null ? null : Math.round(Number(r.median)), on_time: r.on_time });
  for (const r of missed) if (r.broker_id) get(r.broker_id).missed = r.n;
  return out;
}

module.exports = { SWITCHABLE, getRules, saveRules, deadlineFor, setAway, setSwitches, nextBroker,
  routingOf,
  saveRouting,
  routingList, moveOverdue, responseJob, speedToLead, cairoMidnight };
