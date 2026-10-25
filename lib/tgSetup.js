// lib/tgSetup.js — Points Telegram at us on boot (Release 3T), so the bot token never leaves Render: the webhook
// (with our secret), the "WehdatHub" menu button that opens the website as a Mini App, and the "/" command menu.
// Runs only with a token, a webhook secret and an https site; a failure is logged and never stops the server.
"use strict";

const TG = require("./telegram");
const Links = require("./links");
const { getConfig } = require("../config");

const COMMANDS = {
  ar: [
    { command: "help", description: "الأوامر والمساعدة" },
    { command: "login", description: "رابط دخول الموقع" }
  ],
  en: [
    { command: "help", description: "Commands and help" },
    { command: "login", description: "Website sign-in link" }
  ]
};

/** @returns {Promise<{ ok: boolean, skipped?: string, error?: string }>} */
async function setup({ log = console.log } = {}) {
  const cfg = getConfig();
  if (!cfg.telegram.enabled) return { ok: false, skipped: "no_token" };
  if (!cfg.telegram.webhookSecret) return { ok: false, skipped: "no_secret" };
  const hook = Links.telegramWebhookUrl();
  if (!hook.startsWith("https://")) return { ok: false, skipped: "not_https" };
  try {
    await TG.setWebhook(hook, cfg.telegram.webhookSecret);
    await TG.call("setChatMenuButton", { menu_button: { type: "web_app", text: "WehdatHub", web_app: { url: Links.appUrl("tg") } } });
    await TG.setCommands(COMMANDS.ar);
    await TG.setCommands(COMMANDS.en, "en");
    log(`[TELEGRAM] webhook and menu set (${hook})`);
    return { ok: true };
  } catch (err) {
    log(`[TELEGRAM] setup failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { setup, COMMANDS };
