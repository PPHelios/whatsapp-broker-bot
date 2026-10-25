// lib/errorReports.js — Production errors and broker bug reports: stored in error_events, the owner alerted on Telegram
"use strict";

const crypto = require("crypto");
const path = require("path");
const { getConfig } = require("../config");

const ROOT = path.join(__dirname, "..");
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const RECENT_OPS = 8;

/**
 * Masks phone numbers (10+ digits, Latin or Arabic-Indic, with spaces, dashes or a +) down to their last 3 digits,
 * so client numbers in an error text or a report never reach the table or the alert in full.
 */
function maskPhones(text) {
  return String(text ?? "").replace(/\+?[0-9٠-٩](?:[\s\-.]?[0-9٠-٩]){9,}/g, (m) => `•••${m.replace(/[^0-9٠-٩]/g, "").slice(-3)}`);
}

/** Absolute paths become repo-relative; node_modules frames are kept but short. */
function cleanStack(stack) {
  if (!stack) return null;
  return maskPhones(String(stack).split(ROOT + path.sep).join("")).slice(0, MAX_STACK);
}

/** The first stack frame in our own code ("lib/search.js:123"), the place an alert points at. */
function topFrame(stack) {
  for (const line of String(stack || "").split("\n").slice(1)) {
    if (line.includes("node_modules") || line.includes("node:")) continue;
    const m = line.match(/((?:lib|routes|services|web|domain|scripts)\/[\w./-]+\.js|server\.js|config\.js):(\d+)/);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
}

/** Same error, same place → same fingerprint (numbers, ids and quoted values don't count). */
function fingerprint(source, name, message, frame) {
  const shape = String(message || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/"[^"]*"|'[^']*'/g, "<v>")
    .replace(/[0-9٠-٩]+/g, "<n>")
    .slice(0, 200);
  return crypto.createHash("sha1").update(`${source}|${name}|${shape}|${frame || ""}`).digest("hex").slice(0, 16);
}

/** Any thrown value → { name, message, stack }. */
function normalize(err) {
  if (err instanceof Error) return { name: err.name || "Error", message: err.message || String(err), stack: err.stack || null };
  if (err && typeof err === "object" && err.message) return { name: err.name || "Error", message: String(err.message), stack: err.stack || null };
  return { name: "Error", message: typeof err === "string" ? err : JSON.stringify(err ?? null), stack: null };
}

/** Sends one plain-text Telegram message to the owner; false when alerts aren't configured or the send failed. */
async function alertOwner(text, { config = getConfig(), fetchImpl = globalThis.fetch } = {}) {
  const { telegramToken, telegramChatId } = config.alerts || {};
  if (!telegramToken || !telegramChatId || !fetchImpl) return false;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000)
    });
    return Boolean(res && res.ok);
  } catch (e) {
    console.warn("Owner alert failed:", e.message);
    return false;
  }
}

/** "Broker One (broker, telegram) · agency a0000000" for an alert. */
function who(broker, agencyId, channel = null) {
  if (!broker && !agencyId) return null;
  const parts = [];
  const tags = [broker?.role, channel].filter(Boolean).join(", ");
  if (broker) parts.push(`${broker.name || broker.id}${tags ? ` (${tags})` : ""}`);
  const agency = broker?.agency_id || agencyId;
  if (agency) parts.push(`agency ${String(agency).slice(0, 8)}`);
  return parts.join(" · ");
}

/**
 * Records one caught error and alerts the owner when its fingerprint hasn't alerted in the last ALERT_EVERY_MIN
 * minutes. Never throws (it runs inside catch blocks) and never blocks on Telegram for long.
 * @param {*} err - anything thrown
 * @param {Object} ctx - { pool, source: turn | webhook | web | job | process | client, broker?, agencyId?, brokerId?,
 *   msgId?, path?, metadata? }
 * @returns {Promise<number|null>} the error_events id (shown to the broker as "#E<id>"), or null when not stored
 */
async function capture(err, { pool, source = "app", broker = null, agencyId = null, brokerId = null, msgId = null, path: where = null, metadata = {}, config = getConfig(), fetchImpl } = {}) {
  const e = normalize(err);
  const frame = metadata.frame || topFrame(e.stack);
  const fp = fingerprint(source, e.name, e.message, frame);
  const message = maskPhones(`${e.name}: ${e.message}`).slice(0, MAX_MESSAGE);
  console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "ERROR_CAPTURED", source, fingerprint: fp, error: message, frame, msgId, brokerId: broker?.id || brokerId }));
  if (!pool) return null;

  const agency = broker?.agency_id || agencyId || null;
  const brokerRef = broker?.id || brokerId || null;
  let id = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO error_events (kind, source, fingerprint, message, stack, agency_id, broker_id, msg_id, path, metadata)
       VALUES ('error', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [source, fp, message, cleanStack(e.stack), agency, brokerRef, msgId, where ? maskPhones(where).slice(0, 300) : null, JSON.stringify({ ...metadata, frame })]
    );
    id = Number(rows[0].id);

    // One alert per fingerprint per window, across instances: claim the alert on this row only if none is recent.
    const everyMin = config.alerts?.everyMin || 30;
    const { rows: claimed } = await pool.query(
      `UPDATE error_events SET alerted_at = NOW()
        WHERE id = $1 AND NOT EXISTS (
          SELECT 1 FROM error_events WHERE fingerprint = $2 AND id <> $1 AND alerted_at > NOW() - make_interval(mins => $3::int))
        RETURNING id`,
      [id, fp, everyMin]
    );
    if (claimed.length) {
      const { rows: seen } = await pool.query(
        "SELECT count(*)::int AS n FROM error_events WHERE fingerprint = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [fp]
      );
      const n = seen[0]?.n || 1;
      const lines = [
        `🚨 WehdatHub error #E${id} (${source})`,
        message.slice(0, 500),
        frame ? `at ${frame}` : null,
        where ? `path: ${maskPhones(where).slice(0, 120)}` : null,
        who(broker, agency, metadata.channel || (source === "web" || source === "client" ? "web" : null)),
        msgId ? `message: ${msgId}` : null,
        n > 1 ? `${n} times in the last 24 hours (next alert for this one in ${everyMin} min at the earliest)` : null
      ];
      // Not awaited by callers' replies: a slow Telegram never delays the broker's error message.
      alertOwner(lines.filter(Boolean).join("\n"), { config, fetchImpl }).catch(() => {});
    }
  } catch (dbErr) {
    console.warn("Error capture could not be stored:", dbErr.message);
  }
  return id;
}

/** A broker's last operations (type, status, error code, time): what they were doing when they reported. */
async function recentActivity(pool, brokerId) {
  const { rows } = await pool.query(
    `SELECT operation_type, status, error_code, created_at FROM operation_logs
      WHERE broker_id = $1 AND created_at > NOW() - INTERVAL '2 hours'
      ORDER BY created_at DESC LIMIT ${RECENT_OPS}`,
    [brokerId]
  );
  const { rows: errors } = await pool.query(
    `SELECT id FROM error_events WHERE broker_id = $1 AND kind = 'error' AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY id DESC LIMIT 5`,
    [brokerId]
  );
  return {
    ops: rows.map((r) => ({ op: r.operation_type, status: r.status, code: r.error_code || undefined, at: new Date(r.created_at).toISOString() })),
    errors: errors.map((r) => Number(r.id))
  };
}

const REPORTS_PER_HOUR = 10;

/**
 * Stores a broker's bug report (from the bot or the website) and alerts the owner every time.
 * @param {Object} pool
 * @param {Object} broker - the signed-in or messaging broker
 * @param {Object} report - { text, channel: whatsapp | telegram | web, path?, userAgent? }
 * @returns {Promise<{ id: number }|{ limited: true }>}
 */
async function submitReport(pool, broker, { text, channel, path: where = null, userAgent = null }, { config = getConfig(), fetchImpl } = {}) {
  const { rows: count } = await pool.query(
    "SELECT count(*)::int AS n FROM error_events WHERE kind = 'report' AND broker_id = $1 AND created_at > NOW() - INTERVAL '1 hour'",
    [broker.id]
  );
  if ((count[0]?.n || 0) >= REPORTS_PER_HOUR) return { limited: true };

  const body = maskPhones(String(text || "").trim()).slice(0, MAX_MESSAGE);
  const activity = await recentActivity(pool, broker.id).catch(() => ({ ops: [], errors: [] }));
  const { rows } = await pool.query(
    `INSERT INTO error_events (kind, source, fingerprint, message, agency_id, broker_id, path, metadata, alerted_at)
     VALUES ('report', $1, $2, $3, $4, $5, $6, $7::jsonb, NOW()) RETURNING id`,
    [
      channel,
      `report:${broker.id}`,
      body,
      broker.agency_id,
      broker.id,
      where ? maskPhones(where).slice(0, 300) : null,
      JSON.stringify({ channel, lang: broker.preferred_lang || "ar", userAgent: userAgent ? String(userAgent).slice(0, 200) : undefined, ...activity })
    ]
  );
  const id = Number(rows[0].id);
  const lines = [
    `🐞 WehdatHub bug report #R${id} (${channel})`,
    who(broker, broker.agency_id),
    body,
    where ? `page: ${where}` : null,
    activity.errors.length ? `recent errors: ${activity.errors.map((e) => `#E${e}`).join(", ")}` : null,
    activity.ops.length ? `last actions: ${activity.ops.slice(0, 4).map((o) => `${o.op}${o.status !== "success" ? `(${o.status})` : ""}`).join(", ")}` : null
  ];
  alertOwner(lines.filter(Boolean).join("\n"), { config, fetchImpl }).catch(() => {});
  return { id };
}

/** Rows older than this are deleted by the privacy job (they may quote what a broker typed). */
const RETENTION_DAYS = 90;
async function purgeOld(pool, { now = new Date() } = {}) {
  const { rowCount } = await pool.query("DELETE FROM error_events WHERE created_at < $1", [new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString()]);
  return { errorEventsPurged: rowCount };
}

/** Process-level handlers (production bootstrap): unhandled rejections are recorded; an uncaught exception is recorded, then the process exits so Render restarts it. */
function installProcessHandlers(pool) {
  process.on("unhandledRejection", (reason) => {
    capture(reason, { pool, source: "process", metadata: { event: "unhandledRejection" } });
  });
  process.on("uncaughtException", (err) => {
    const exit = setTimeout(() => process.exit(1), 4000);
    exit.unref?.();
    capture(err, { pool, source: "process", metadata: { event: "uncaughtException" } }).finally(() => setTimeout(() => process.exit(1), 1500));
  });
}

module.exports = { capture, submitReport, alertOwner, maskPhones, fingerprint, topFrame, purgeOld, installProcessHandlers, RETENTION_DAYS, REPORTS_PER_HOUR };
