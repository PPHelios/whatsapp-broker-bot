// tests/harness/fake-whatsapp.js — Recording stand-in for lib/whatsapp.js (same exports)
"use strict";

const actual = jest.requireActual("../../lib/whatsapp");

const outbox = []; // every outbound call, in order
const receipts = []; // markAsRead calls: { msgId, typing }
const media = new Map(); // mediaId -> { buffer, mimeType }
const failures = new Map(); // method name -> Error to throw on next call
let uploadSeq = 0;

function record(type, to, payload) {
  const err = failures.get(type);
  if (err) {
    failures.delete(type);
    throw err;
  }
  const entry = { type, to: String(to || "").replace(/\+/g, ""), ...payload };
  outbox.push(entry);
  return { messages: [{ id: `wamid.out.${outbox.length}` }] };
}

module.exports = {
  // --- lib/whatsapp.js API ---
  safeTruncate: actual.safeTruncate,
  sendWhatsAppText: async (to, text) => (text ? record("text", to, { text }) : null),
  sendWhatsAppButtons: async (to, body, buttons = []) =>
    record("buttons", to, {
      text: body,
      buttons: buttons.slice(0, 3).map((b) => ({
        id: String(b.id).slice(0, 128),
        title: actual.safeTruncate(String(b.title), 20)
      }))
    }),
  sendWhatsAppList: async (to, body, buttonText, sections = []) =>
    record("list", to, { text: body, buttonText, sections }),
  sendWhatsAppImage: async (to, mediaIdOrUrl, caption = "") =>
    record("image", to, { media: mediaIdOrUrl, caption }),
  sendWhatsAppReaction: async (to, messageId, emoji) =>
    record("reaction", to, { messageId, emoji }),
  sendWhatsAppDocument: async (to, buffer, filename, caption = "") =>
    record("document", to, { filename, caption, size: buffer ? buffer.length : 0 }),
  uploadWhatsAppMedia: async () => `media.up.${++uploadSeq}`,
  markAsRead: async (msgId, opts = {}) => {
    receipts.push({ msgId, typing: Boolean(opts.typing) });
    return true;
  },
  downloadWhatsAppMedia: async (mediaId) => media.get(mediaId) || null,

  // --- test controls ---
  outbox,
  receipts,
  media,
  failNext(method, error = new Error(`fake ${method} failure`)) {
    failures.set(method, error);
  },
  reset() {
    outbox.length = 0;
    receipts.length = 0;
    media.clear();
    failures.clear();
    uploadSeq = 0;
  }
};
