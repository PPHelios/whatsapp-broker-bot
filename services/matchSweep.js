// services/matchSweep.js — Match alerts (Release 3 step 7). A scheduler job reads the units changed since its
// watermark (listings.updated_at, which every write path moves: a trigger on UPDATE, the default on INSERT), runs
// each alerting request through the same SQL as search restricted to those units, records each new fit once in
// lead_matches and tells each broker once per sweep, grouped, at most 10 times a Cairo day on WhatsApp or the website
// (Telegram is free: up to 50, a safety ceiling only). A unit is a new match for a request once ever: a price that drops
// into range alerts, a rollback doesn't; sold units never do. A unit already matched whose price then drops 2% or more
// below the price the broker last heard (lead_matches.alerted_price) alerts again as a price drop (6.5), unless the
// broker dismissed it for that client.
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
const TELEGRAM_DAILY_CAP = 50;
const DROP_MIN_PCT = 2;
const LINES = 5;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, telegram_chat_id, quiet_line";
const QUIET_DAYS = 60; // N3: "60 days since you spoke" on a client that fits

/** The broker's daily ceiling: match alerts that go to Telegram cost nothing, so only a safety ceiling applies. */
function capFor(broker, dailyCap) {
  const linked = Boolean(broker.telegram_chat_id);
  const channel = Notifications.prefsOf(broker, { telegramLinked: linked }).channels.match;
  return linked && channel === "telegram" ? Math.max(dailyCap, TELEGRAM_DAILY_CAP) : dailyCap;
}

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

const money = (n, lang) => Describe.money(n, lang);

/** N3: days since the broker last spoke to the client (or since the lead came in), when 60 or more; else null. */
function quietDays(lead, now) {
  const since = lead.last_contact_at || lead.created_at;
  if (!since) return null;
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / (24 * 3600 * 1000));
  return days >= QUIET_DAYS ? days : null;
}

/** One hit's line: a new unit, or "📉 9 مليون ← 8.5 مليون" for a price drop; with N3's line when the client is quiet. */
function hitLine(x, lang, { now = new Date(), quietLine = true } = {}) {
  const who = `${Card.refLabel(x.lead.ref)} ${Card.displayName(x.lead, lang)}`;
  const main = x.drop ? `• 📉 ${who} ← ${x.listing.code}: ${money(x.drop.from, lang)} → ${money(x.drop.to, lang)}` : `• ${who} ← ${Describe.searchResult(x.listing, lang)}`;
  const days = quietLine ? quietDays(x.lead, now) : null;
  if (!days) return main;
  const never = !x.lead.last_contact_at;
  const line = lang === "en" ? `   ⏳ ${never ? `No call logged in ${days} days` : `${days} days since you spoke`}: a good reason to call.` : `   ⏳ ${never ? `مفيش مكالمة متسجلة من ${days} يوم` : `بقالك ${days} يوم مكلمتوش`}: فرصة تكلمه.`;
  return `${main}\n${line}`;
}

/** One grouped alert: "🏠 3 new units for your clients" with a line per lead and unit (price drops marked 📉). */
async function alertBroker(pool, broker, hits, { now, sweepKey }) {
  const lang = en(broker) ? "en" : "ar";
  const leads = new Set(hits.map((x) => x.lead.id));
  const lines = hits.slice(0, LINES).map((x) => hitLine(x, lang, { now, quietLine: broker.quiet_line !== false }));
  if (hits.length > LINES) lines.push(L(broker, `…و${hits.length - LINES} كمان`, `…and ${hits.length - LINES} more`));
  const single = leads.size === 1 ? hits[0].lead : null;
  const drops = hits.filter((x) => x.drop).length;
  let title;
  if (hits.length === 1 && drops) {
    title = L(broker, `📉 سعر ${hits[0].listing.code} نزل، وتناسب ${Card.displayName(single, "ar")} (${Card.refLabel(single.ref)})`, `📉 ${hits[0].listing.code} dropped its price and fits ${Card.displayName(single, "en")} (${Card.refLabel(single.ref)})`);
  } else if (hits.length === 1) {
    title = L(broker, `🏠 وحدة جديدة تناسب ${Card.displayName(single, "ar")} (${Card.refLabel(single.ref)})`, `🏠 A new unit fits ${Card.displayName(single, "en")} (${Card.refLabel(single.ref)})`);
  } else if (drops === hits.length) {
    title = L(broker, `📉 ${hits.length} وحدات سعرها نزل وتناسب ${leads.size} من عملائك`, `📉 ${hits.length} units dropped their price for ${leads.size} of your clients`);
  } else {
    title = L(broker, `🏠 ${hits.length} وحدة جديدة تناسب ${leads.size} من عملائك`, `🏠 ${hits.length} new units fit ${leads.size} of your clients`);
  }
  return Notifications.notifyBroker(pool, broker, {
    kind: "match",
    dedupeKey: `match:${sweepKey}`,
    title,
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
  const counts = { units: changed.length, requests: 0, matches: 0, drops: 0, alerts: 0, capped: 0 };
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
      `SELECT s.id, s.filters, s.broker_id, l.id AS lead_id, l.ref, l.name, l.phone_e164, l.assigned_broker_id, l.stage, l.last_contact_at, l.created_at AS lead_created_at
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
        `INSERT INTO lead_matches (agency_id, lead_id, search_id, listing_id, status, created_at, alerted_at, alerted_price)
         SELECT $1, $2, $3, f.id, 'alerted', $5, $5, f.price FROM unnest($4::uuid[], $6::numeric[]) AS f(id, price)
         ON CONFLICT (search_id, listing_id) DO NOTHING RETURNING listing_id`,
        [agencyId, r.lead_id, r.id, fits.map((f) => f.id), now.toISOString(), fits.map((f) => f.price_value ?? null)]
      );
      const freshIds = new Set(fresh.map((f) => f.listing_id));
      // Already matched: a price 2%+ below what the broker last heard is a price drop (once per drop).
      const known = fits.filter((f) => !freshIds.has(f.id) && Number(f.price_value) > 0);
      const drops = new Map();
      if (known.length) {
        const { rows: dropped } = await pool.query(
          `WITH prev AS (
             SELECT id, listing_id, alerted_price FROM lead_matches
              WHERE search_id = $1 AND listing_id = ANY($2::uuid[]) AND status <> 'dismissed' AND alerted_price > 0
              FOR UPDATE)
           UPDATE lead_matches m SET alerted_price = f.price, alerted_at = $4
             FROM prev, unnest($2::uuid[], $3::numeric[]) AS f(id, price)
            WHERE m.id = prev.id AND f.id = prev.listing_id AND f.price <= prev.alerted_price * (1 - $5::numeric / 100)
           RETURNING m.listing_id, prev.alerted_price AS was`,
          [r.id, known.map((f) => f.id), known.map((f) => f.price_value), now.toISOString(), DROP_MIN_PCT]
        );
        for (const d of dropped) drops.set(d.listing_id, Number(d.was));
      }
      if (!fresh.length && !drops.size) continue;
      counts.matches += fresh.length;
      counts.drops += drops.size;
      // Only the lead's current broker: an unassigned lead is the managers' (they see its matches on the lead page),
      // never the broker who saved the request before it was taken away.
      const to = r.assigned_broker_id;
      if (!to) continue;
      if (!perBroker.has(to)) perBroker.set(to, { agencyId, hits: [] });
      const lead = { id: r.lead_id, ref: r.ref, name: r.name, phone_e164: r.phone_e164, last_contact_at: r.last_contact_at, created_at: r.lead_created_at };
      for (const f of fits) {
        if (freshIds.has(f.id)) perBroker.get(to).hits.push({ lead, listing: f });
        else if (drops.has(f.id)) perBroker.get(to).hits.push({ lead, listing: f, drop: { from: drops.get(f.id), to: Number(f.price_value) } });
      }
    }
  }

  const sweepKey = now.toISOString();
  for (const [brokerId, { agencyId, hits }] of perBroker) {
    const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [brokerId, agencyId]);
    const broker = rows[0];
    if (!broker || !broker.is_active) continue;
    // The cap: the matches stay on the lead page; only the message is skipped.
    if ((await sentToday(pool, broker.id, now)) >= capFor(broker, dailyCap)) {
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

module.exports = { DAILY_CAP, TELEGRAM_DAILY_CAP, DROP_MIN_PCT, sweep, sweepJob };
