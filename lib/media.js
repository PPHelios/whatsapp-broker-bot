// lib/media.js — Downloads an inbound file by its id: Telegram files ("tg:<file_id>", Release 3T) or WhatsApp media.
"use strict";

const WA = require("./whatsapp");
const TG = require("./telegram");

/** { buffer, mimeType } or null. */
async function download(id, mimeHint = "") {
  const s = String(id || "");
  if (s.startsWith("tg:")) return TG.downloadFile(s.slice(3), mimeHint);
  return WA.downloadWhatsAppMedia(s);
}

module.exports = { download };
