// lib/whatsapp.js
"use strict";

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_TEXT = 3900; // WhatsApp hard limit is 4096
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const messagesUrl = () => `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
const authHeaders = (json = true) => ({
  Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  ...(json ? { "Content-Type": "application/json" } : {})
});

/**
 * fetch + JSON with retry on 429 / 5xx / network errors (honours Retry-After).
 * Never throws. -> { ok, status, data }
 */
async function graphJson(url, opts = {}, { retries = 3, timeoutMs = 15000, label = "WA" } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, data };
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        console.error(`❌ [${label} ${res.status}]:`, JSON.stringify(data).slice(0, 400));
        return { ok: false, status: res.status, data };
      }
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300);
    } catch (err) {
      if (attempt >= retries) {
        console.error(`❌ [${label} EXCEPTION]:`, err.message);
        return { ok: false, status: 0, data: { error: { message: err.message } } };
      }
      await sleep(Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300);
    }
  }
}

const post = (payload, label) =>
  graphJson(messagesUrl(), { method: "POST", headers: authHeaders(true), body: JSON.stringify(payload) }, { label });

// Split on line breaks so long messages never hit the 4096 limit.
function chunkText(text, max = MAX_TEXT) {
  const s = String(text);
  if (s.length <= max) return [s];
  const out = [];
  let buf = "";
  for (const line of s.split("\n")) {
    if ((buf + "\n" + line).length > max && buf) {
      out.push(buf);
      buf = "";
    }
    if (line.length > max) {
      for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
    } else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out;
}

/** Returns the last API response, or null if any part failed. */
async function sendWhatsAppText(to, body) {
  if (!to || !body) return null;
  let last = null;
  for (const part of chunkText(body)) {
    const r = await post(
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: part }
      },
      "WA TEXT"
    );
    if (!r.ok) return null;
    last = r.data;
  }
  return last;
}

/** `image` is a public URL string or { id } of an uploaded WhatsApp media. */
async function sendWhatsAppImage(to, image, caption = "") {
  if (!to || !image) return null;
  const media = typeof image === "string" ? { link: image } : { id: image.id };
  const r = await post(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { ...media, ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) }
    },
    "WA IMAGE"
  );
  return r.ok ? r.data : null;
}

/** Upload once, send many times by id (ids stay valid ~30 days). -> id | null */
async function uploadWhatsAppMedia(buffer, { mimeType = "image/jpeg", filename = "file.jpg" } = {}) {
  if (!buffer) return null;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  const r = await graphJson(
    `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
    { method: "POST", headers: authHeaders(false), body: form },
    { label: "WA MEDIA UPLOAD", timeoutMs: 25000 }
  );
  return r.ok && r.data.id ? r.data.id : null;
}

async function sendWhatsAppDocument(to, buffer, filename = "export.csv", caption = "", mimeType = "text/csv") {
  if (!to || !buffer) return null;
  const id = await uploadWhatsAppMedia(buffer, { mimeType, filename });
  if (!id) return null;
  const r = await post(
    {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id, filename, ...(caption ? { caption } : {}) }
    },
    "WA DOCUMENT"
  );
  return r.ok ? r.data : null;
}

/** Up to 3 quick-reply buttons: [{ id, title }] (title max 20 chars). */
async function sendWhatsAppButtons(to, body, buttons) {
  if (!to || !body || !Array.isArray(buttons) || !buttons.length) return null;
  const r = await post(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(body).slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) }
          }))
        }
      }
    },
    "WA BUTTONS"
  );
  return r.ok ? r.data : null;
}

/** Blue ticks (+ optional typing indicator). Best effort, never throws. */
async function markAsRead(messageId, { typing = false } = {}) {
  if (!messageId) return null;
  const r = await graphJson(
    messagesUrl(),
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(typing ? { typing_indicator: { type: "text" } } : {})
      })
    },
    { label: "WA READ", retries: 0, timeoutMs: 8000 }
  );
  return r.ok;
}

/** -> { buffer, mimeType } | null. Rejects files above maxBytes before buffering them. */
async function downloadWhatsAppMedia(mediaId, { maxBytes = MAX_MEDIA_BYTES } = {}) {
  if (!mediaId || !process.env.WHATSAPP_ACCESS_TOKEN) return null;
  try {
    const meta = await graphJson(`${GRAPH}/${mediaId}`, { method: "GET", headers: authHeaders(false) }, { label: "WA MEDIA META" });
    if (!meta.ok || !meta.data.url) return null;
    if (Number(meta.data.file_size) > maxBytes) {
      console.warn(`[WA MEDIA] ${mediaId} too large (${meta.data.file_size})`);
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(meta.data.url, {
          headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, "User-Agent": "curl/7.64.1" },
          signal: AbortSignal.timeout(25000)
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) continue;
          return null;
        }
        if (Number(res.headers.get("content-length")) > maxBytes) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) return null;
        return { buffer: buf, mimeType: meta.data.mime_type || "image/jpeg" };
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    return null;
  } catch (err) {
    console.error("❌ [WA MEDIA EXCEPTION]:", err.message);
    return null;
  }
}

module.exports = {
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  sendWhatsAppButtons,
  uploadWhatsAppMedia,
  markAsRead,
  downloadWhatsAppMedia
};
