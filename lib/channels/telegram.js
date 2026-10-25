// lib/channels/telegram.js — Notification channel: a Telegram message to the broker's linked chat (Release 3T).
// Free: no credits and no 24-hour window. Refuses when the broker isn't linked or the Telegram bot is off.
"use strict";

const { notifyTelegram } = require("../dispatcher");
const { textOf } = require("./whatsapp");

const name = "telegram";

/**
 * @param {Object} broker
 * @param {Object} message - { kind, title, body, url, buttons }
 * @param {Object} deps - { pool }
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function send(broker, message, { pool }) {
  const r = await notifyTelegram(broker, textOf(message), { pool, kind: `notify_${message.kind}`, buttons: message.buttons || null });
  return r ? { ok: true, id: String(r.message_id || "") } : { ok: false, error: "not_linked" };
}

module.exports = { name, send };
