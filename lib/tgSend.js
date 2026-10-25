// lib/tgSend.js — One reply on Telegram (Release 3T): the dispatcher's ops (text, buttons, list, image, document,
// react, album) as Bot API calls to the broker's linked chat. Text is converted from WhatsApp formatting to HTML.
"use strict";

const TG = require("./telegram");
const Fmt = require("../domain/tgFormat");
const TgLink = require("./tgLink");
const Phone = require("../domain/phone");
const Links = require("./links");

// Telegram refuses very long button URLs; a longer wa.me link goes through our own short redirect.
const MAX_BUTTON_URL = 2000;

/** wa.me link carrying the client text (to the client's number when known), short enough for a URL button. */
async function waButtonUrl(pool, text, phone = null, ready = null) {
  const direct = ready || (phone && Phone.waMeUrl(phone, text)) || `https://wa.me/?text=${encodeURIComponent(text)}`;
  if (direct.length <= MAX_BUTTON_URL || !pool) return direct;
  const token = await TgLink.storeWaLink(pool, direct);
  return Links.waRedirectUrl(token);
}

const SEND_ON_WA = { ar: "📤 ابعت على واتساب", en: "📤 Send on WhatsApp" };

/** "tg:<chat>:<message>" (the inbound id) → { chatId, messageId } or null. */
function parseMessageRef(id) {
  const m = String(id || "").match(/^tg:(-?\d+):(\d+)$/);
  return m ? { chatId: m[1], messageId: Number(m[2]) } : null;
}

/**
 * @param {Object} broker - with telegram_chat_id
 * @param {Object} op - { type: text | buttons | list | image | document | react, ... }
 * @param {string|null} body - the text (with the turn note), null for media
 * @returns {Promise<Object|null>} Telegram's message, or null when there is nothing to send to
 */
async function send(broker, op, body, { pool } = {}) {
  const chatId = broker.telegram_chat_id;
  if (!chatId) return null;
  const encode = (id) => (pool ? TgLink.encodeCallback(pool, id) : Promise.resolve(Buffer.byteLength(id) <= 64 ? id : "noop"));
  switch (op.type) {
    case "buttons":
      return TG.sendMessage(chatId, Fmt.toHtml(body), { keyboard: await Fmt.keyboard(op.buttons, encode) });
    case "list":
      return TG.sendMessage(chatId, Fmt.toHtml(body), { keyboard: await Fmt.listKeyboard(op.sections, encode) });
    case "client": {
      // A message meant for a client: one tap opens WhatsApp with the text (no Telegram timestamps when copying).
      const url = await waButtonUrl(pool, op.clientText || body, op.phone || null, op.url || null);
      const rows = [Fmt.urlButton(SEND_ON_WA[op.lang === "en" ? "en" : "ar"], url)];
      return TG.sendMessage(chatId, Fmt.toHtml(body), { keyboard: rows });
    }
    case "image":
      return TG.sendPhoto(chatId, op.media, op.caption ? Fmt.toHtml(op.caption) : "");
    case "album": {
      // Unit photos (6.4): one photo is a photo, 2–10 an album; captions are plain text from our own data.
      const items = (op.items || []).filter((i) => i && i.url).slice(0, 10).map((i) => ({ url: i.url, caption: i.caption ? Fmt.toHtml(i.caption) : "" }));
      if (!items.length) return null;
      if (items.length === 1) return TG.sendPhoto(chatId, items[0].url, items[0].caption);
      const sent = await TG.sendMediaGroup(chatId, items);
      return Array.isArray(sent) ? sent[0] || null : sent;
    }
    case "document":
      return TG.sendDocument(chatId, op.buffer, op.filename, op.caption ? Fmt.toHtml(op.caption) : "");
    case "react": {
      const ref = parseMessageRef(op.messageId);
      if (!ref) return null;
      return TG.call("setMessageReaction", { chat_id: ref.chatId, message_id: ref.messageId, reaction: [{ type: "emoji", emoji: op.emoji || "👍" }] });
    }
    default:
      return TG.sendMessage(chatId, Fmt.toHtml(body));
  }
}

module.exports = { send, parseMessageRef, waButtonUrl, MAX_BUTTON_URL };
