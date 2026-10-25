// lib/channels/webpush.js — Notification channel: web push to every browser the broker turned it on in
"use strict";

const webpush = require("web-push");
const { getConfig } = require("../../config");

const name = "webpush";
let sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);

/** Test hook: replace the push sender ((subscription, payload, opts) → Promise). */
function setSenderForTests(fn) {
  sender = fn || ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
}

const configured = (cfg = getConfig().webPush) => Boolean(cfg.publicKey && cfg.privateKey);

// Push payloads leave our servers (browser vendors' push services): no phone numbers, ever (P3).
const scrub = (s, max) =>
  String(s || "")
    .replace(/[+\d٠-٩][\d٠-٩\s\-().]{6,}[\d٠-٩]/g, "••")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** The exact JSON a browser receives: a title, a short body and an /app/ URL. */
function payloadOf(message) {
  const p = message.push || {};
  const url = typeof message.url === "string" && message.url.startsWith("/app/") ? message.url : "/app/notifications";
  return JSON.stringify({ title: scrub(p.title || message.title, 80), body: scrub(p.body ?? "", 140), url });
}

/**
 * @param {Object} broker
 * @param {Object} message - { title, body, url, push: { title, body } }
 * @param {Object} deps - { pool }
 * @returns {Promise<{ ok: boolean, sent?: number, error?: string }>}
 */
async function send(broker, message, { pool }) {
  const cfg = getConfig().webPush;
  if (!configured(cfg)) return { ok: false, error: "not_configured" };
  const { rows } = await pool.query(
    "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE broker_id = $1 AND agency_id = $2 ORDER BY id",
    [broker.id, broker.agency_id]
  );
  if (!rows.length) return { ok: false, error: "no_subscription" };
  const payload = payloadOf(message);
  const opts = { TTL: 6 * 3600, urgency: "normal", vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey } };
  let sent = 0;
  for (const s of rows) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, opts);
      sent++;
      await pool.query("UPDATE push_subscriptions SET last_ok_at = NOW(), failed_count = 0 WHERE id = $1", [s.id]);
    } catch (err) {
      // 404/410: the browser dropped the subscription; anything else counts as a failure.
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await pool.query("DELETE FROM push_subscriptions WHERE id = $1", [s.id]);
      } else {
        await pool.query("UPDATE push_subscriptions SET failed_count = failed_count + 1 WHERE id = $1", [s.id]);
      }
    }
  }
  return sent ? { ok: true, sent } : { ok: false, error: "push_failed" };
}

module.exports = { name, send, payloadOf, configured, setSenderForTests };
