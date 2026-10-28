// lib/tgIngress.js — Telegram updates → the WhatsApp message shape the pipeline already handles (Release 3T).
// Media ids carry a "tg:" prefix so lib/media.js downloads them from Telegram; message ids are "tg:<chat>:<message>"
// (button taps "tg:cb:<id>"), which also dedupes Telegram's webhook retries in inbound_messages.
"use strict";

const START = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/;

/** Text of a /start command's payload (the link token), or undefined when the text isn't /start. */
function startPayload(text) {
  const m = String(text || "").trim().match(START);
  return m ? m[1] || null : undefined;
}

/**
 * @param {Object} update - a Telegram Update
 * @returns {null | { ids: { userId, chatId }, lang, callbackId?, data?, start?, contact?, message? }}
 *   message is in the WhatsApp shape ({ id, from, type, text|image|audio|document|contacts|interactive }),
 *   except `data` (button taps) which the caller decodes first.
 */
function normalize(update) {
  if (update?.callback_query) {
    const q = update.callback_query;
    const chatId = q.message?.chat?.id;
    if (!q.from?.id || !chatId) return null;
    return { ids: { userId: q.from.id, chatId }, lang: q.from.language_code || "", callbackId: q.id, data: q.data || "", messageId: q.message?.message_id || null };
  }
  const m = update?.message;
  // Private chats only: groups come later.
  if (!m || !m.from?.id || m.chat?.type !== "private" || m.from.is_bot) return null;
  const ids = { userId: m.from.id, chatId: m.chat.id };
  const base = { id: `tg:${m.chat.id}:${m.message_id}`, from: `tg:${m.from.id}`, timestamp: String(m.date || "") };
  const out = { ids, lang: m.from.language_code || "" };
  const caption = m.caption || "";

  if (typeof m.text === "string") {
    const start = startPayload(m.text);
    if (start !== undefined) return { ...out, start };
    // "/help" and "/login@Bot" from the command menu become the plain words the router knows.
    const cmd = m.text.trim().match(/^\/([a-z_]{1,32})(?:@\w+)?$/i);
    const body = cmd ? cmd[1].toLowerCase() : m.text;
    return { ...out, message: { ...base, type: "text", text: { body } } };
  }
  if (m.contact) {
    const c = m.contact;
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
    return {
      ...out,
      contact: c,
      message: { ...base, type: "contacts", contacts: [{ name: { formatted_name: name, first_name: c.first_name || "" }, phones: [{ phone: c.phone_number, type: "CELL" }] }] }
    };
  }
  if (m.voice || m.audio) {
    const a = m.voice || m.audio;
    return {
      ...out,
      message: { ...base, type: "audio", audio: { id: `tg:${a.file_id}`, mime_type: a.mime_type || "audio/ogg", voice: Boolean(m.voice), duration: a.duration || 0 } }
    };
  }
  if (Array.isArray(m.photo) && m.photo.length) {
    const best = m.photo[m.photo.length - 1]; // the largest size comes last
    return { ...out, message: { ...base, type: "image", image: { id: `tg:${best.file_id}`, mime_type: "image/jpeg", ...(caption ? { caption } : {}) } } };
  }
  if (m.location && !m.venue) {
    return { ...out, message: { ...base, type: "location", location: { latitude: m.location.latitude, longitude: m.location.longitude } } };
  }
  if (m.document) {
    const d = m.document;
    return {
      ...out,
      message: { ...base, type: "document", document: { id: `tg:${d.file_id}`, filename: d.file_name || "file", mime_type: d.mime_type || "", ...(caption ? { caption } : {}) } }
    };
  }
  return { ...out, message: { ...base, type: "unsupported" } };
}

/** The interactive message a button tap becomes, once its callback data is decoded to the button id. */
const buttonMessage = (norm, id) => ({
  id: `tg:cb:${norm.callbackId}`,
  from: `tg:${norm.ids.userId}`,
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id, title: id } }
});

module.exports = { normalize, startPayload, buttonMessage };
