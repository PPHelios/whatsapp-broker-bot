// services/matchSweep.js — Match alerts (Release 3 step 7). A scheduler job reads the units changed since its
// watermark (listings.updated_at, which every write path moves: a trigger on UPDATE, the default on INSERT), runs
// each alerting request through the same SQL as search restricted to those units, records each new fit once in
// lead_matches and tells each broker once per sweep, grouped, at most 10 times a Cairo day. A unit is alerted to a
// request once ever: a price that drops into range alerts, a rollback and a second drop don't; sold units never do.
"use strict";

const Search = require("./search");
const Notifications = require("../lib/notifications");
const Card = require("../domain/leadCard");
const Describe = require("../domain/describe");
const Stages = require("../domain/leadStages");
const SearchLink = require("../domain/searchLink");

const OVERLAP_MS = 2 * 60 * 1000; // a write committed just after the last sweep is still read
const FIRST_LOOKBACK_MS = 10 * 60 * 1000; // the first sweep never alerts on old inventory
const BATCH = 2000;
const DAILY_CAP = 10;
const LINES = 5;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs";

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);

/** Match alerts already sent to a broker since the start of the Cairo day. */
async function sentToday(pool, brokerId, now) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE broker_id = $1 AND kind = 'match' AND created_at >= $2", [
    brokerId,
    Stages.cairoDayAt(now, 0, 0).toISOString()
  ]);
  return rows[0].n;
}

/** One grouped alert: "🏠 3 new units for your clients" with a line per lead and unit. */
async function alertBroker(pool, broker, hits, { now, sweepKey }) {
  const lang = en(broker) ? "en" : "ar";
  const leads = new Set(hits.map((x) => x.lead.id));
  const lines = hits.slice(0, LINES).map((x) => `• ${Card.refLabel(x.lead.ref)} ${Card.displayName(x.lead, lang)} ← ${Describe.searchResult(x.listing, lang)}`);
  if (hits.length > LINES) lines.push(L(broker, `…و${hits.length - LINES} كمان`, `…and ${hits.length - LINES} more`));
  const single = leads.size === 1 ? hits[0].lead : null;
  return Notifications.notifyBroker(pool, broker, {
    kind: "match",
    dedupeKey: `match:${sweepKey}`,
    title:
      hits.length === 1
        ? L(broker, `🏠 وحدة جديدة تناسب ${Card.displayName(single, "ar")} (${Card.refLabel(single.ref)})`, `🏠 A new unit fits ${Card.displayName(single, "en")} (${Card.refLabel(single.ref)})`)
        : L(broker, `🏠 ${hits.length} وحدة جديدة تناسب ${leads.size} من عملائك`, `🏠 ${hits.length} new units fit ${leads.size} of your clients`),
    body: lines.join("\n"),
    url: single ? `/app/leads/${Card.refLabel(single.ref)}#requests` : "/app/leads",
    leadId: single?.id || null,
    listingId: hits.length === 1 ? hits[0].listing.id : null,
    buttons: hits.length === 1 ? [{ id: `ld:send:${Card.refLabel(single.ref)}:${hits[0].listing.code}`, title: L(broker, "💬 ابعت للعميل", "💬 Send to client") }] : null,
    now
  });
}

/**
 * One sweep.
 * @param {Object} watermark - { at } the last updated_at read
 * @returns {Promise<{ watermark, counts: { units, requests, matches, alerts, capped } }>}
 */
async function sweep(pool, { now = new Date(), watermark = {}, dailyCap = DAILY_CAP } = {}) {
  const since = watermark.at ? new Date(new Date(watermark.at).getTime() - OVERLAP_MS) : new Date(now.getTime() - FIRST_LOOKBACK_MS);
  const { rows: changed } = await pool.query(
    `SELECT id, agency_id, updated_at FROM listings
      WHERE status = 'active' AND updated_at > $1 AND updated_at <= $2
      ORDER BY updated_at, id LIMIT $3`,
    [since.toISOString(), now.toISOString(), BATCH]
  );
  const counts = { units: changed.length, requests: 0, matches: 0, alerts: 0, capped: 0 };
  const last = changed.length ? new Date(changed[changed.length - 1].updated_at) : null;
  const next = { at: (last && (!watermark.at || last > new Date(watermark.at)) ? last : new Date(watermark.at || now)).toISOString() };
  if (!changed.length) return { watermark: next, counts };

  const byAgency = new Map();
  for (const u of changed) {
    if (!byAgency.has(u.agency_id)) byAgency.set(u.agency_id, []);
    byAgency.get(u.agency_id).push(u.id);
  }

  const perBroker = new Map(); // broker id → [{ lead, listing }]
  for (const [agencyId, ids] of byAgency) {
    const { rows: requests } = await pool.query(
      `SELECT s.id, s.filters, s.broker_id, l.id AS lead_id, l.ref, l.name, l.phone_e164, l.assigned_broker_id, l.stage
         FROM saved_searches s JOIN leads l ON l.id = s.lead_id AND l.agency_id = s.agency_id
        WHERE s.agency_id = $1 AND s.alerts_enabled AND l.stage NOT IN ('won', 'lost')`,
      [agencyId]
    );
    counts.requests += requests.length;
    for (const r of requests) {
      const filters = SearchLink.sanitizeFilters(r.filters);
      const { sql, params } = Search.buildSearchQuery(agencyId, { filters }, { onlyIds: ids, limit: BATCH });
      const { rows: fits } = await pool.query(sql, params);
      if (!fits.length) continue;
      const { rows: fresh } = await pool.query(
        `INSERT INTO lead_matches (agency_id, lead_id, search_id, listing_id, status, created_at, alerted_at)
         SELECT $1, $2, $3, unnest($4::uuid[]), 'alerted', $5, $5
         ON CONFLICT (search_id, listing_id) DO NOTHING RETURNING listing_id`,
        [agencyId, r.lead_id, r.id, fits.map((f) => f.id), now.toISOString()]
      );
      if (!fresh.length) continue;
      counts.matches += fresh.length;
      const freshIds = new Set(fresh.map((f) => f.listing_id));
      // Only the lead's current broker: an unassigned lead is the managers' (they see its matches on the lead page),
      // never the broker who saved the request before it was taken away.
      const to = r.assigned_broker_id;
      if (!to) continue;
      if (!perBroker.has(to)) perBroker.set(to, { agencyId, hits: [] });
      const lead = { id: r.lead_id, ref: r.ref, name: r.name, phone_e164: r.phone_e164 };
      for (const f of fits) if (freshIds.has(f.id)) perBroker.get(to).hits.push({ lead, listing: f });
    }
  }

  const sweepKey = now.toISOString();
  for (const [brokerId, { agencyId, hits }] of perBroker) {
    const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [brokerId, agencyId]);
    const broker = rows[0];
    if (!broker || !broker.is_active) continue;
    // The cap: the matches stay on the lead page; only the message is skipped.
    if ((await sentToday(pool, broker.id, now)) >= dailyCap) {
      counts.capped++;
      continue;
    }
    await alertBroker(pool, broker, hits, { now, sweepKey });
    counts.alerts++;
  }
  return { watermark: next, counts };
}

/** The scheduler job entry (lib/jobs.js). */
const sweepJob = () => ({
  name: "match_sweep",
  everyMs: 5 * 60 * 1000,
  run: ({ pool, now, watermark }) => sweep(pool, { now, watermark })
});

module.exports = { DAILY_CAP, sweep, sweepJob };
