// lib/tgSend.js — One reply on Telegram (Release 3T): the dispatcher's ops (text, buttons, list, image, document,
// react) as Bot API calls to the broker's linked chat. Text is converted from WhatsApp formatting to HTML.
"use strict";

const TG = require("./telegram");
const Fmt = require("../domain/tgFormat");
const TgLink = require("./tgLink");

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
    case "image":
      return TG.sendPhoto(chatId, op.media, op.caption ? Fmt.toHtml(op.caption) : "");
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

module.exports = { send, parseMessageRef };
