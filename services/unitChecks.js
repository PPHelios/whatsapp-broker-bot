// services/unitChecks.js — "Still available?" (6.3). Units nobody has vouched for in 21 days (confirmed_at, set by every
// insert, edit and quick update) get one question to their broker: one unit carries [✅ Still available] [💰 Sold]
// [🗄️ Archive] (the quick-update buttons), several get a grouped message with [🔎 Review] that lists them, each opening
// the quick menu. At 30 days a unit still unconfirmed is archived (hidden from searches, client links and alerts) and
// the broker is told once; "Still available" brings it back. Asking happens 10:00–19:59 Cairo; claims use FOR UPDATE
// SKIP LOCKED so two instances never ask twice. Developer models (price lists) are not checked.
"use strict";

const crypto = require("crypto");
const Notifications = require("../lib/notifications");
const Describe = require("../domain/describe");
const { withTransaction } = require("../lib/db");

const ASK_AFTER_DAYS = 21;
const HIDE_AFTER_DAYS = 30;
const ASK_HOURS = [10, 20];
const BATCH = 300;
const LINES = 5;
const DAY = 24 * 3600 * 1000;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs";

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const VOUCHED = "COALESCE(confirmed_at, updated_at, created_at)";
const cairoHour = (now) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hourCycle: "h23" }).format(now)) % 24;
const dedupe = (prefix, units, now) =>
  `${prefix}:${crypto.createHash("sha1").update(`${now.toISOString().slice(0, 10)}|${units.map((u) => u.id).sort().join(",")}`).digest("hex").slice(0, 20)}`;

/** One unit's line: "• NH-V12 · شقة 150م · Mivida". */
const unitLine = (u, b) => `• ${u.code} · ${Describe.compactLine(u, en(b) ? "en" : "ar")}`;

function askMessage(broker, units) {
  if (units.length === 1) {
    const u = units[0];
    return {
      title: L(broker, `🤔 ${u.code} لسه متاحة؟`, `🤔 Is ${u.code} still available?`),
      body: [Describe.compactLine(u, en(broker) ? "en" : "ar"), L(broker, `محدش أكدها من ${ASK_AFTER_DAYS} يوم. لو مفيش رد هتتخفى من البحث بعد ${HIDE_AFTER_DAYS} يوم.`, `Nobody has confirmed it in ${ASK_AFTER_DAYS} days. With no answer it is hidden from searches at ${HIDE_AFTER_DAYS} days.`)].join("\n"),
      url: `/app/units/${encodeURIComponent(u.code)}`,
      listingId: u.id,
      buttons: [
        { id: `qu:available:${u.code}`, title: L(broker, "✅ لسه متاحة", "✅ Still available") },
        { id: `qu:sold:${u.code}`, title: L(broker, "💰 اتباعت", "💰 Sold") },
        { id: `qu:archive:${u.code}`, title: L(broker, "🗄️ أرشفة", "🗄️ Archive") }
      ]
    };
  }
  const lines = units.slice(0, LINES).map((u) => unitLine(u, broker));
  if (units.length > LINES) lines.push(L(broker, `…و${units.length - LINES} كمان`, `…and ${units.length - LINES} more`));
  return {
    title: L(broker, `🤔 ${units.length} وحدات محدش أكدها من ${ASK_AFTER_DAYS} يوم، لسه متاحة؟`, `🤔 ${units.length} units unconfirmed for ${ASK_AFTER_DAYS} days: still available?`),
    body: lines.join("\n"),
    url: "/app/units",
    buttons: [{ id: "uc:review", title: L(broker, "🔎 راجعهم", "🔎 Review") }]
  };
}

function hiddenMessage(broker, units) {
  const lines = units.slice(0, LINES).map((u) => unitLine(u, broker));
  if (units.length > LINES) lines.push(L(broker, `…و${units.length - LINES} كمان`, `…and ${units.length - LINES} more`));
  const one = units.length === 1;
  return {
    title: one
      ? L(broker, `🗄️ ${units[0].code} اتخفت من البحث (${HIDE_AFTER_DAYS} يوم من غير تأكيد)`, `🗄️ ${units[0].code} is hidden from searches (${HIDE_AFTER_DAYS} days unconfirmed)`)
      : L(broker, `🗄️ ${units.length} وحدات اتخفت من البحث (${HIDE_AFTER_DAYS} يوم من غير تأكيد)`, `🗄️ ${units.length} units hidden from searches (${HIDE_AFTER_DAYS} days unconfirmed)`),
    body: [...(one ? [] : lines), L(broker, "لو لسه متاحة دوس «لسه متاحة» وترجع.", "If it's still available, tap “Still available” to bring it back.")].join("\n"),
    url: "/app/units",
    listingId: one ? units[0].id : null,
    buttons: one ? [{ id: `qu:available:${units[0].code}`, title: L(broker, "✅ لسه متاحة", "✅ Still available") }] : [{ id: "uc:review", title: L(broker, "🔎 راجعهم", "🔎 Review") }]
  };
}

async function tell(pool, units, kind, build, prefix, now) {
  const byBroker = new Map();
  for (const u of units) {
    if (!u.broker_id) continue;
    if (!byBroker.has(u.broker_id)) byBroker.set(u.broker_id, []);
    byBroker.get(u.broker_id).push(u);
  }
  let told = 0;
  for (const [brokerId, list] of byBroker) {
    const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [brokerId, list[0].agency_id]);
    const broker = rows[0];
    if (!broker || !broker.is_active) continue;
    await Notifications.notifyBroker(pool, broker, { kind, dedupeKey: dedupe(prefix, list, now), ...build(broker, list), now });
    told++;
  }
  return told;
}

/** Asks about units unconfirmed for 21 days (once per confirmation). → { asked, brokers } */
async function askStale(pool, { now = new Date(), limit = BATCH } = {}) {
  if (cairoHour(now) < ASK_HOURS[0] || cairoHour(now) >= ASK_HOURS[1]) return { asked: 0, brokers: 0, skipped: true };
  const units = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM listings
        WHERE status = 'active' AND inventory_type IS DISTINCT FROM 'developer_model' AND broker_id IS NOT NULL
          AND ${VOUCHED} < $1 AND (stale_asked_at IS NULL OR stale_asked_at < ${VOUCHED})
        ORDER BY ${VOUCHED}, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - ASK_AFTER_DAYS * DAY).toISOString(), limit]
    );
    if (!rows.length) return [];
    // A stamp, not an edit: version and confirmed_at stay.
    const upd = await client.query("UPDATE listings SET stale_asked_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  });
  if (!units.length) return { asked: 0, brokers: 0 };
  return { asked: units.length, brokers: await tell(pool, units, "unit_check", askMessage, "uc_ask", now) };
}

/** Archives units still unconfirmed at 30 days that were asked about at least 2 days ago. → { hidden, brokers } */
async function hideStale(pool, { now = new Date(), limit = BATCH } = {}) {
  const units = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM listings
        WHERE status = 'active' AND inventory_type IS DISTINCT FROM 'developer_model'
          AND ${VOUCHED} < $1 AND stale_asked_at IS NOT NULL AND stale_asked_at >= ${VOUCHED} AND stale_asked_at < $2
        ORDER BY ${VOUCHED}, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - HIDE_AFTER_DAYS * DAY).toISOString(), new Date(now.getTime() - 2 * DAY).toISOString(), limit]
    );
    if (!rows.length) return [];
    // Not a broker's edit: confirmed_at stays (the unit is still unconfirmed); version moves so open forms reload.
    const upd = await client.query(
      `UPDATE listings SET status = 'archived', stale_hidden_at = $2, version = version + 1, updated_at = $2
        WHERE id = ANY($1::uuid[]) RETURNING *`,
      [rows.map((r) => r.id), now.toISOString()]
    );
    return upd.rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  });
  if (!units.length) return { hidden: 0, brokers: 0 };
  return { hidden: units.length, brokers: await tell(pool, units, "unit_check", hiddenMessage, "uc_hide", now) };
}

/** [🔎 Review]: the broker's units waiting for an answer (asked or auto-archived), newest question first. */
async function pendingFor(pool, broker, { limit = 10 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM listings
      WHERE agency_id = $1 AND broker_id = $2 AND stale_asked_at IS NOT NULL AND stale_asked_at >= ${VOUCHED}
        AND (status = 'active' OR (status = 'archived' AND stale_hidden_at IS NOT NULL))
      ORDER BY stale_asked_at DESC, code LIMIT $3`,
    [broker.agency_id, broker.id, limit]
  );
  return rows;
}

/** The scheduler job entry (lib/jobs.js): hourly. */
const unitCheckJob = () => ({
  name: "unit_checks",
  everyMs: 60 * 60 * 1000,
  run: async ({ pool, now }) => {
    const h = await hideStale(pool, { now });
    const a = await askStale(pool, { now });
    return { counts: { asked: a.asked, hidden: h.hidden, brokers: a.brokers + h.brokers } };
  }
});

module.exports = { ASK_AFTER_DAYS, HIDE_AFTER_DAYS, askStale, hideStale, pendingFor, askMessage, hiddenMessage, unitCheckJob };
