// lib/channels/whatsapp.js — Notification channel: a WhatsApp message through the dispatcher (counted, credit-checked)
"use strict";

const { notify } = require("../dispatcher");
const Links = require("../links");

const name = "whatsapp";

/** The WhatsApp text of a notification: title, body, and the website link when there is one. */
function textOf(message) {
  const lines = [message.title];
  if (message.body) lines.push(message.body);
  if (message.url) lines.push(`🌐 ${Links.appUrl(message.url.replace(/^\/app\/?/, "/"))}`);
  return lines.join("\n");
}

/**
 * @param {Object} broker
 * @param {Object} message - { kind, title, body, url, buttons }
 * @param {Object} deps - { pool }
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
async function send(broker, message, { pool }) {
  const r = await notify(broker, textOf(message), { pool, kind: `notify_${message.kind}`, buttons: message.buttons || null });
  return r ? { ok: true, id: r?.messages?.[0]?.id || null } : { ok: false, error: "not_accepted" };
}

module.exports = { name, textOf, send };
