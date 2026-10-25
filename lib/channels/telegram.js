// lib/channels/telegram.js — Notification channel stub: the Telegram adapter slots in here later (same interface)
"use strict";

const name = "telegram";

/** Not configured yet: always refuses, so the notification centre falls back. */
async function send(_broker, _message, _deps) {
  return { ok: false, error: "not_configured" };
}

module.exports = { name, send };
