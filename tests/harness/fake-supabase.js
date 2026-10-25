// tests/harness/fake-supabase.js — In-memory stand-in for lib/supabase.js (same exports)
"use strict";

const fs = require("fs");

const objects = new Map(); // storage path -> Buffer
const chats = new Map(); // chat-imports path -> Buffer (tests put the zip here, as the browser would)
const BASE = "https://storage.test/listing-images/";

const pathOf = (urlOrPath) => String(urlOrPath || "").replace(BASE, "").replace(/^\/+/, "");

module.exports = {
  // --- lib/supabase.js API ---
  supabase: null,
  uploadListingImage: async (agencyId, storagePath, buffer) => {
    if (!buffer || !storagePath) return null;
    objects.set(pathOf(storagePath), buffer);
    return BASE + pathOf(storagePath);
  },
  uploadFlyerImage: async (agencyId, storagePath, buffer) => {
    objects.set(pathOf(storagePath), buffer);
    return BASE + pathOf(storagePath);
  },
  downloadListingImage: async (url) => {
    if (typeof url !== "string" || !url.startsWith(BASE)) return null;
    const buffer = objects.get(pathOf(url));
    return buffer ? { buffer, mimeType: "image/jpeg" } : null;
  },
  deleteStorageFiles: async (paths = []) => {
    for (const p of paths) objects.delete(pathOf(p));
    return true;
  },

  CHAT_ZIP_MAX_BYTES: 200 * 1024 * 1024,
  createChatUploadUrl: async (storagePath) => ({ url: `https://storage.test/upload/chat-imports/${storagePath}?token=t`, path: storagePath }),
  downloadChatExportToFile: async (storagePath, file) => {
    const buffer = chats.get(storagePath);
    if (!buffer) throw Object.assign(new Error("Chat export not found"), { code: "NOT_FOUND" });
    fs.writeFileSync(file, buffer);
    return { bytes: buffer.length };
  },
  deleteChatExport: async (storagePath) => {
    chats.delete(storagePath);
  },

  // --- test controls ---
  chats,
  objects,
  BASE,
  reset() {
    objects.clear();
    chats.clear();
  }
};
