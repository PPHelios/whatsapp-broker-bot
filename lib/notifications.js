// lib/notifications.js — The notification centre (Q15): one inbox row per event, one channel per delivery
"use strict";

const Credits = require("./credits");
const { MANAGER_ROLES } = require("./authz");
const WhatsAppChannel = require("./channels/whatsapp");
const WebPushChannel = require("./channels/webpush");
const TelegramChannel = require("./channels/telegram");
const { telegramChatOf } = require("./dispatcher");

// Kinds a broker can route (settings page); "credits" and "system" always follow the WhatsApp-first rule.
const KINDS = ["assignment", "follow_up", "match", "share_opened", "hot_client", "manager_alert"];
const KIND_LABELS = {
  assignment: ["عميل جديد اتسلملك", "Lead assigned to you"],
  follow_up: ["المتابعات والمعاينات", "Follow-ups and viewings"],
  match: ["وحدات مناسبة لعملائك", "Matches for your clients"],
  share_opened: ["العميل فتح الرابط", "Client opened a link"],
  hot_client: ["عميل مهتم جداً 🔥", "Hot client 🔥"],
  manager_alert: ["تنبيهات المدير", "Manager alerts"]
};
// The morning brief and evening digest (services/dailyDigest.js): Telegram first, then push or the inbox; never
// WhatsApp, because a daily message to every broker would spend the agency's credits.
// The "still available?" questions (services/unitChecks.js) follow the same rule.
const DAILY_KINDS = ["daily_brief", "daily_digest", "unit_check"];
const DAILY_LABELS = {
  daily_brief: ["☀️ ملخص يومك", "☀️ Your day"],
  daily_digest: ["🌙 ملخص اليوم", "🌙 Today's digest"],
  unit_check: ["🤔 وحدات محتاجة تأكيد", "🤔 Units to confirm"]
};
const DEFAULT_QUIET = { start: 22, end: 8 };
const MERGE_WINDOW_MS = 2 * 60 * 1000;
// Meta closes the free-form window 24 hours after the broker's last message; keep a margin.
const WINDOW_MS = 24 * 3600 * 1000 - 10 * 60 * 1000;
const GROUP_LINES = 5;

const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());

const CHANNELS = ["telegram", "web", "whatsapp"];

/**
 * { channels: { kind: "telegram"|"web"|"whatsapp" }, quiet: { start, end, enabled } } with defaults: a kind not
 * chosen yet goes to Telegram when the broker has linked it (free), else WhatsApp.
 */
function prefsOf(broker, { telegramLinked = Boolean(broker?.telegram_chat_id) } = {}) {
  const p = broker?.notify_prefs || {};
  const channels = {};
  for (const k of KINDS) channels[k] = CHANNELS.includes(p.channels?.[k]) ? p.channels[k] : telegramLinked ? "telegram" : "whatsapp";
  const q = p.quiet || {};
  const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
  return { channels, quiet: { enabled: q.enabled !== false, start: hour(q.start, DEFAULT_QUIET.start), end: hour(q.end, DEFAULT_QUIET.end) } };
}

/** Cairo wall-clock parts of a moment. */
function cairoParts(now) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const o = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
}

function inQuietHours(prefs, now = new Date()) {
  const { enabled, start, end } = prefs.quiet;
  if (!enabled || start === end) return false;
  const h = cairoParts(now).h;
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** The next moment the quiet hours end (Cairo time). */
function quietEnd(prefs, now = new Date()) {
  const { end } = prefs.quiet;
  // Walk forward in 15-minute steps to the first instant outside quiet hours at the end hour.
  let t = new Date(Math.ceil(now.getTime() / 900000) * 900000);
  for (let i = 0; i < 4 * 26; i++) {
    const p = cairoParts(t);
    if (p.h === end && p.min === 0) return t;
    t = new Date(t.getTime() + 900000);
  }
  return new Date(now.getTime() + 8 * 3600 * 1000);
}

/** Is the broker's 24-hour WhatsApp window open (their last message is recent enough)? */
async function isWindowOpen(pool, broker, now = new Date()) {
  const key = broker.phone_normalized || String(broker.phone_number || "").replace(/\D/g, "");
  const { rows } = await pool.query("SELECT max(received_at) AS last FROM inbound_messages WHERE phone_key = $1", [key]);
  const last = rows[0]?.last ? new Date(rows[0].last).getTime() : 0;
  return now.getTime() - last < WINDOW_MS;
}

/** One message for a group of rows of the same kind (merged within the window, or released after quiet hours). */
function messageFor(rows, lang) {
  if (rows.length === 1) {
    const r = rows[0];
    // A push leaves our servers (browser vendors' push services): an alert about a client says only its kind (P3).
    // The daily messages name clients too: the push says only what it is.
    const label = (KIND_LABELS[r.kind] || DAILY_LABELS[r.kind] || ["تنبيه", "Notification"])[lang === "en" ? 1 : 0];
    const push = r.push || (r.lead_id || DAILY_KINDS.includes(r.kind) ? { title: DAILY_KINDS.includes(r.kind) ? label : `🔔 ${label}`, body: "" } : null);
    return { kind: r.kind, title: r.title, body: r.body, url: r.url, buttons: r.buttons || null, push };
  }
  const en = lang === "en";
  const lines = rows.slice(0, GROUP_LINES).map((r) => `• ${r.title}`);
  if (rows.length > GROUP_LINES) lines.push(en ? `…and ${rows.length - GROUP_LINES} more` : `…و${rows.length - GROUP_LINES} كمان`);
  return {
    kind: rows[0].kind,
    title: en ? `🔔 ${rows.length} notifications` : `🔔 ${rows.length} تنبيهات`,
    body: lines.join("\n"),
    url: "/app/notifications",
    push: { title: en ? `🔔 ${rows.length} notifications` : `🔔 ${rows.length} تنبيهات`, body: "" }
  };
}

/**
 * Delivers rows (one event, or a group) on exactly one channel and records how.
 * WhatsApp first when the broker chose it, the window is open and the agency has credits below 100%;
 * otherwise (or when WhatsApp refuses) web push; with no push either, the inbox alone holds it.
 */
async function deliverRows(pool, broker, rows, { now = new Date() } = {}) {
  const linked = Boolean(await telegramChatOf(pool, broker));
  const prefs = prefsOf(broker, { telegramLinked: linked });
  const kind = rows[0].kind;
  const message = messageFor(rows, broker.preferred_lang);
  const wants = DAILY_KINDS.includes(kind) ? "telegram" : prefs.channels[kind] || "whatsapp";
  const wantsWhatsApp = wants === "whatsapp";

  let channel = "inbox";
  let reason = "chosen";
  let status = "skipped";
  if (wants === "telegram") {
    const r = await TelegramChannel.send(broker, message, { pool });
    if (r.ok) [channel, status] = ["telegram", "sent"];
    else reason = linked ? "fallback" : "not_linked";
  }
  if (wantsWhatsApp) {
    if (!(await isWindowOpen(pool, broker, now))) reason = "window_closed";
    else if (!Credits.canNotify(await Credits.check(pool, broker, { now }))) reason = "no_credits";
    else {
      const r = await WhatsAppChannel.send(broker, message, { pool });
      if (r.ok) [channel, status] = ["whatsapp", "sent"];
      else reason = "fallback";
    }
  }
  if (channel === "inbox") {
    const r = await WebPushChannel.send(broker, message, { pool });
    if (r.ok) [channel, status] = ["webpush", "sent"];
    else if (wants === "web") reason = "no_push";
  }

  const ids = rows.map((r) => r.id);
  await pool.query(
    `UPDATE notifications SET channel = $2, reason = CASE WHEN id = $3 THEN $4 ELSE 'merged' END, status = $5,
            delivered_at = $6, deliver_after = NULL, merged_into = CASE WHEN id = $3 THEN NULL ELSE $3::bigint END
      WHERE id = ANY($1::bigint[]) AND broker_id = $7`,
    [ids, channel, ids[0], reason, status, now.toISOString(), broker.id]
  );
  return { channel, reason, status, ids };
}

/**
 * Notifies a broker about one event.
 * 1. The inbox row is inserted with ON CONFLICT (broker_id, dedupe_key) DO NOTHING: the same event
 *    never notifies twice (retries, two servers).
 * 2. Quiet hours hold it until they end; another alert of the same kind delivered in the last 2 minutes
 *    queues it, so a burst goes out as one message.
 * 3. Otherwise it is delivered now on one channel (deliverRows).
 *
 * @param {Object} opts - { kind, dedupeKey, title, body, url (/app/…), leadId, listingId, buttons, push, now, urgent }
 * @returns {Promise<{ duplicate?: boolean, held?: boolean, queued?: boolean, channel?, reason?, status?, id? }>}
 */
async function notifyBroker(pool, broker, opts) {
  const { kind, dedupeKey, title, body = "", url = null, leadId = null, listingId = null, buttons = null, push = null, now = new Date(), urgent = false } = opts;
  if (!broker?.id || !broker.agency_id || !kind || !dedupeKey || !title) throw new Error("notifyBroker: broker, kind, dedupeKey and title are required");
  if (url && !String(url).startsWith("/app/")) throw new Error("notifyBroker: url must be an /app/ path");
  const ins = await pool.query(
    `INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, body, url, lead_id, listing_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (broker_id, dedupe_key) DO NOTHING RETURNING *`,
    [broker.agency_id, broker.id, kind, dedupeKey, title, body, url, leadId, listingId, now.toISOString()]
  );
  const row = ins.rows[0];
  if (!row) return { duplicate: true };
  if (broker.is_active === false) {
    await pool.query("UPDATE notifications SET status = 'skipped', channel = 'inbox' WHERE id = $1", [row.id]);
    return { id: row.id, status: "skipped" };
  }

  const prefs = prefsOf(broker);
  if (!urgent && inQuietHours(prefs, now)) {
    await pool.query("UPDATE notifications SET status = 'held', reason = 'quiet_hours', deliver_after = $2 WHERE id = $1", [row.id, quietEnd(prefs, now).toISOString()]);
    return { id: row.id, held: true };
  }
  const recent = await pool.query(
    `SELECT max(delivered_at) AS last FROM notifications
      WHERE broker_id = $1 AND kind = $2 AND id <> $3 AND status = 'sent' AND delivered_at > $4`,
    [broker.id, kind, row.id, new Date(now.getTime() - MERGE_WINDOW_MS).toISOString()]
  );
  const pending = await pool.query(
    "SELECT min(deliver_after) AS at FROM notifications WHERE broker_id = $1 AND kind = $2 AND status = 'queued' AND id <> $3",
    [broker.id, kind, row.id]
  );
  if (recent.rows[0]?.last || pending.rows[0]?.at) {
    const at = pending.rows[0]?.at ? new Date(pending.rows[0].at) : new Date(new Date(recent.rows[0].last).getTime() + MERGE_WINDOW_MS);
    await pool.query("UPDATE notifications SET status = 'queued', reason = 'merged', deliver_after = $2 WHERE id = $1", [row.id, at.toISOString()]);
    return { id: row.id, queued: true };
  }
  const out = await deliverRows(pool, broker, [{ ...row, buttons, push }], { now });
  return { id: row.id, ...out };
}

const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs";

/** Scheduler job: releases held (quiet hours) and queued (merged) notifications that are due, one message per broker and kind. */
async function deliverDue(pool, { now = new Date(), limit = 500 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM notifications WHERE status IN ('held', 'queued') AND deliver_after <= $1
      ORDER BY broker_id, kind, created_at LIMIT $2`,
    [now.toISOString(), limit]
  );
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.broker_id}|${r.kind}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  let delivered = 0;
  for (const group of groups.values()) {
    const b = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [group[0].broker_id, group[0].agency_id]);
    const broker = b.rows[0];
    if (!broker || !broker.is_active) {
      await pool.query("UPDATE notifications SET status = 'skipped', channel = 'inbox' WHERE id = ANY($1::bigint[])", [group.map((r) => r.id)]);
      continue;
    }
    // Still quiet (the broker moved their hours)? Wait for the new end.
    const prefs = prefsOf(broker);
    if (inQuietHours(prefs, now)) {
      await pool.query("UPDATE notifications SET status = 'held', reason = 'quiet_hours', deliver_after = $2 WHERE id = ANY($1::bigint[])", [group.map((r) => r.id), quietEnd(prefs, now).toISOString()]);
      continue;
    }
    await deliverRows(pool, broker, group, { now });
    delivered += group.length;
  }
  return { delivered, groups: groups.size };
}

/** The scheduler job entry (lib/jobs.js). */
const deliverJob = () => ({
  name: "notifications",
  everyMs: 60 * 1000,
  run: async ({ pool, now }) => ({ counts: await deliverDue(pool, { now }) })
});

/** Every active manager of an agency. */
async function managersOf(pool, agencyId) {
  const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE agency_id = $1 AND is_active AND lower(role) = ANY($2::text[])`, [agencyId, MANAGER_ROLES]);
  return rows;
}

/** Managers hear once a month per level when the agency's credits reach 80% and 100%. */
async function creditWarning(pool, agencyId, { level, state, now = new Date() }) {
  const month = Credits.monthKey(now);
  for (const m of await managersOf(pool, agencyId)) {
    const en = m.preferred_lang === "en";
    await notifyBroker(pool, m, {
      kind: "manager_alert",
      dedupeKey: `credits_warn:${month}:${level}`,
      title: en ? `📊 WhatsApp credits: ${level}% used` : `📊 رصيد واتساب: اتصرف ${level}%`,
      body: en ? `${state.used} of ${state.limit} this month.` : `${state.used} من ${state.limit} الشهر ده.`,
      url: "/app/usage",
      now
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Inbox and log (website)                                                 */
/* ---------------------------------------------------------------------- */

async function listInbox(pool, broker, { limit = 20, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.title, n.body, n.url, n.created_at, n.read_at, n.channel, n.status,
            CASE WHEN n.dedupe_key LIKE 'fu:%' AND l.follow_up_status = 'open' AND l.assigned_broker_id = n.broker_id THEN l.ref END AS follow_up_ref
       FROM notifications n LEFT JOIN leads l ON l.id = n.lead_id AND l.agency_id = n.agency_id
      WHERE n.broker_id = $1 AND n.agency_id = $2 ORDER BY n.created_at DESC, n.id DESC LIMIT $3 OFFSET $4`,
    [broker.id, broker.agency_id, limit + 1, offset]
  );
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

async function unreadCount(pool, broker) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE broker_id = $1 AND agency_id = $2 AND read_at IS NULL", [broker.id, broker.agency_id]);
  return rows[0].n;
}

/** Marks one notification (id) or all ("all") as read; only the broker's own. */
async function markRead(pool, broker, id) {
  if (id === "all") {
    await pool.query("UPDATE notifications SET read_at = NOW() WHERE broker_id = $1 AND agency_id = $2 AND read_at IS NULL", [broker.id, broker.agency_id]);
    return true;
  }
  const r = await pool.query("UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND broker_id = $2 AND agency_id = $3 RETURNING url", [Number(id) || 0, broker.id, broker.agency_id]);
  return r.rows[0] || null;
}

/** The agency's notification log (managers): who got what, on which channel, why, and whether it went out. */
async function agencyLog(pool, manager, { limit = 50, offset = 0, brokerId = null } = {}) {
  if (!isManager(manager)) return null;
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.title, n.created_at, n.channel, n.reason, n.status, n.delivered_at, b.name AS broker_name
       FROM notifications n JOIN brokers b ON b.id = n.broker_id AND b.agency_id = n.agency_id
      WHERE n.agency_id = $1 AND ($2::uuid IS NULL OR n.broker_id = $2)
      ORDER BY n.created_at DESC, n.id DESC LIMIT $3 OFFSET $4`,
    [manager.agency_id, brokerId, limit + 1, offset]
  );
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** Saves a broker's notification preferences (validated). */
async function savePrefs(pool, broker, { channels = {}, quiet = {} }) {
  const clean = { channels: {}, quiet: {} };
  for (const k of KINDS) clean.channels[k] = CHANNELS.includes(channels[k]) ? channels[k] : "whatsapp";
  const hour = (v, d) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : d;
  };
  clean.quiet = { enabled: quiet.enabled !== false && quiet.enabled !== "off", start: hour(quiet.start, DEFAULT_QUIET.start), end: hour(quiet.end, DEFAULT_QUIET.end) };
  await pool.query("UPDATE brokers SET notify_prefs = $3::jsonb WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id, JSON.stringify(clean)]);
  return clean;
}

/** Push subscriptions (from the browser's PushManager). */
async function savePushSubscription(pool, broker, sub, userAgent = "") {
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || "");
  const auth = String(sub?.keys?.auth || "");
  if (!/^https:\/\/\S{10,2000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return false;
  // An endpoint belongs to one browser: re-subscribing moves it to whoever is signed in there now.
  await pool.query(
    `INSERT INTO push_subscriptions (broker_id, agency_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE SET broker_id = EXCLUDED.broker_id, agency_id = EXCLUDED.agency_id,
       p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, failed_count = 0`,
    [broker.id, broker.agency_id, endpoint, p256dh, auth, String(userAgent).slice(0, 200)]
  );
  return true;
}

async function removePushSubscription(pool, broker, endpoint) {
  await pool.query("DELETE FROM push_subscriptions WHERE broker_id = $1 AND agency_id = $2 AND endpoint = $3", [broker.id, broker.agency_id, String(endpoint || "")]);
}

async function pushCount(pool, broker) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE broker_id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
  return rows[0].n;
}

module.exports = {
  KINDS,
  KIND_LABELS,
  DAILY_KINDS,
  DEFAULT_QUIET,
  MERGE_WINDOW_MS,
  prefsOf,
  inQuietHours,
  quietEnd,
  isWindowOpen,
  messageFor,
  deliverRows,
  notifyBroker,
  deliverDue,
  deliverJob,
  managersOf,
  creditWarning,
  listInbox,
  unreadCount,
  markRead,
  agencyLog,
  savePrefs,
  savePushSubscription,
  removePushSubscription,
  pushCount
};
