// lib/telegram.js — Telegram Bot API client (Release 3T): the broker bot's second channel, next to lib/whatsapp.js.
// Messages are sent as HTML (domain/tgFormat.js converts WhatsApp-style *bold*); buttons are inline keyboards whose
// callback_data must fit 64 bytes (longer ids are kept server-side by lib/tgCallbacks.js).
"use strict";

const API = "https://api.telegram.org";
const MAX_TEXT = 4000; // Telegram's ceiling is 4096 characters
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // getFile serves files up to 20 MB

const token = () => process.env.TELEGRAM_BOT_TOKEN || "";
const configured = () => Boolean(token());

/** One Bot API call; resolves to `result`, throws with Telegram's description on failure. */
async function call(method, params = {}, { timeoutMs = 15000 } = {}) {
  if (!configured()) throw Object.assign(new Error("TELEGRAM_BOT_TOKEN is not set"), { code: "TG_NOT_CONFIGURED" });
  const isForm = params instanceof FormData;
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST",
    headers: isForm ? {} : { "Content-Type": "application/json" },
    body: isForm ? params : JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const err = new Error(`Telegram ${method} failed: ${json.description || res.status}`);
    err.code = json.error_code || res.status;
    err.retryAfter = json.parameters?.retry_after || null;
    throw err;
  }
  return json.result;
}

const cut = (text) => (String(text).length > MAX_TEXT ? `${String(text).slice(0, MAX_TEXT - 1)}…` : String(text));

/** Text (HTML) with an optional inline keyboard. */
async function sendMessage(chatId, html, { keyboard = null, previews = false } = {}) {
  return call("sendMessage", {
    chat_id: chatId,
    text: cut(html),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: !previews },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

/** Replaces a message's text and keyboard (e.g. "More" results in place). */
async function editMessage(chatId, messageId, html, { keyboard = null } = {}) {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: cut(html),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

function fileForm(chatId, field, data, filename, mime, captionHtml, keyboard) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (Buffer.isBuffer(data)) form.append(field, new Blob([data], { type: mime }), filename);
  else form.append(field, String(data)); // a URL or a Telegram file_id
  if (captionHtml) {
    form.append("caption", String(captionHtml).slice(0, 1000));
    form.append("parse_mode", "HTML");
  }
  if (keyboard) form.append("reply_markup", JSON.stringify({ inline_keyboard: keyboard }));
  return form;
}

/** Photo from a public URL or a JPEG buffer. */
async function sendPhoto(chatId, photo, captionHtml = "", { keyboard = null } = {}) {
  return call("sendPhoto", fileForm(chatId, "photo", photo, "photo.jpg", "image/jpeg", captionHtml, keyboard), { timeoutMs: 60000 });
}

/** Up to 10 photos as one album: URLs (the caption goes on the first) or { url, caption } items (a caption each). */
async function sendMediaGroup(chatId, urls, captionHtml = "") {
  const cap = (c) => (c ? { caption: String(c).slice(0, 1000), parse_mode: "HTML" } : {});
  const media = urls.slice(0, 10).map((u, i) => (typeof u === "string" ? { type: "photo", media: u, ...cap(i === 0 ? captionHtml : "") } : { type: "photo", media: u.url, ...cap(u.caption) }));
  return call("sendMediaGroup", { chat_id: chatId, media }, { timeoutMs: 60000 });
}

/** Document from a buffer (Excel exports, rejection reports). */
async function sendDocument(chatId, buffer, filename, captionHtml = "") {
  const mime = /\.xlsx$/i.test(filename) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/octet-stream";
  return call("sendDocument", fileForm(chatId, "document", buffer, filename, mime, captionHtml, null), { timeoutMs: 60000 });
}

/** Stops the button's loading spinner (optionally with a short toast). */
async function answerCallback(callbackQueryId, text = "") {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text: text.slice(0, 190) } : {}) });
}

/** "typing…" while a turn is processed. */
async function sendTyping(chatId) {
  return call("sendChatAction", { chat_id: chatId, action: "typing" });
}

/** Downloads a file by file_id: { buffer, mimeType } or null (missing, or over 20 MB). */
async function downloadFile(fileId, mimeHint = "") {
  const file = await call("getFile", { file_id: fileId });
  if (!file?.file_path || (file.file_size && file.file_size > MAX_DOWNLOAD_BYTES)) return null;
  const res = await fetch(`${API}/file/bot${token()}/${file.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: mimeHint || res.headers.get("content-type") || "application/octet-stream" };
}

/** Points Telegram at our webhook (runbook): only the update kinds the bot handles. */
async function setWebhook(url, secret) {
  return call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
}

/** The command menu shown by the "/" button. */
async function setCommands(commands, languageCode = "") {
  return call("setMyCommands", { commands, ...(languageCode ? { language_code: languageCode } : {}) });
}

module.exports = {
  MAX_TEXT,
  configured,
  call,
  sendMessage,
  editMessage,
  sendPhoto,
  sendMediaGroup,
  sendDocument,
  answerCallback,
  sendTyping,
  downloadFile,
  setWebhook,
  setCommands
};
