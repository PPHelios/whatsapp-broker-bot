// tests/harness/fake-telegram.js — Recording stand-in for lib/telegram.js (same exports)
"use strict";

const outbox = []; // every Bot API call, in order: { method, chatId, text, keyboard, ... }
const files = new Map(); // file_id -> { buffer, mimeType }
let seq = 0;

function record(method, chatId, payload = {}) {
  const entry = { method, chatId: chatId == null ? null : String(chatId), ...payload };
  outbox.push(entry);
  return { message_id: ++seq, chat: { id: chatId } };
}

module.exports = {
  MAX_TEXT: 4000,
  configured: () => true,
  call: async (method, params = {}) => record(method, params.chat_id, { params, text: params.text }),
  sendMessage: async (chatId, html, { keyboard = null } = {}) => record("sendMessage", chatId, { text: html, keyboard }),
  editMessage: async (chatId, messageId, html, { keyboard = null } = {}) => record("editMessageText", chatId, { messageId, text: html, keyboard }),
  sendPhoto: async (chatId, photo, caption = "") => record("sendPhoto", chatId, { photo: Buffer.isBuffer(photo) ? "buffer" : photo, caption }),
  sendMediaGroup: async (chatId, urls, caption = "") => record("sendMediaGroup", chatId, { urls, caption }),
  sendDocument: async (chatId, buffer, filename, caption = "") => record("sendDocument", chatId, { filename, caption, buffer }),
  answerCallback: async (id, text = "") => record("answerCallbackQuery", null, { id, text }),
  sendTyping: async (chatId) => record("sendChatAction", chatId, {}),
  downloadFile: async (fileId) => files.get(fileId) || null,
  setWebhook: async (url, secret) => record("setWebhook", null, { url, secret }),
  setCommands: async (commands) => record("setMyCommands", null, { commands }),

  // --- test controls ---
  outbox,
  files,
  reset() {
    outbox.length = 0;
    files.clear();
    seq = 0;
  }
};
