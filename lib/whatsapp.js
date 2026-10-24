// lib/whatsapp.js — Resilient Meta Graph API Client with Grapheme-Safe Guardrails
"use strict";

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_TEXT = 3900; // WhatsApp hard ceiling is 4096
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

const messagesUrl = () =>
  `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const authHeaders = (json = true) => ({
  Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  ...(json ? { "Content-Type": "application/json" } : {})
});

/**
 * Grapheme-safe Unicode string truncation.
 * Prevents slicing through multi-byte surrogate pairs, emojis, and directional marks.
 */
function safeTruncate(str, maxChars = 20) {
  if (!str) return "";
  const cleaned = String(str)
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u0640]/g, "")
    .trim();
  const chars = Array.from(cleaned);
  return chars.slice(0, maxChars).join("").trim();
}

/* ====================================================================== */
/* 1. Resilient HTTP Gateway with Exponential Backoff                     */
/* ====================================================================== */

async function graphJson(
  url,
  opts = {},
  {
    retries = 3,
    timeoutMs = 15000,
    label = "WA",
    // A timed-out or reset POST may already have been delivered; resending duplicates it.
    retryNetworkErrors = true
  } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, data };

      const errorCode = data?.error?.code;
      // Invariant: Non-retryable Meta client errors (e.g. 131047: 24h window closed)
      if (errorCode === 131047) {
        return { ok: false, status: res.status, data, nonRetryable: true };
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        return { ok: false, status: res.status, data };
      }

      const ra = Number(res.headers.get("retry-after"));
      const delay =
        ra > 0
          ? ra * 1000
          : Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300;

      await sleep(delay);
    } catch (err) {
      if (attempt >= retries || !retryNetworkErrors) {
        return {
          ok: false,
          status: 0,
          data: { error: { message: err.message } }
        };
      }
      await sleep(Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300);
    }
  }
}

async function postWhatsAppApi(payload, label = "WA API") {
  const r = await graphJson(
    messagesUrl(),
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(payload)
    },
    { label, retryNetworkErrors: false }
  );

  if (!r.ok) {
    const errorData = r.data?.error || {};
    const errCode = errorData.code;

    // Invariant: Intercept 24-Hour Customer Window Expiration (Error 131047)
    if (errCode === 131047 || r.nonRetryable) {
      console.warn(
        JSON.stringify({
          t: new Date().toISOString(),
          level: "warn",
          msg: "META_24H_WINDOW_EXPIRED: Outbound message dropped to prevent retry loops",
          recipient: payload.to,
          errCode
        })
      );
      return null;
    }

    const err = new Error(
      errorData.message || `WhatsApp API error ${r.status}`
    );
    err.status = r.status;
    err.response = { data: r.data };
    err.code = errCode;
    err.subcode = errorData.error_subcode;
    throw err;
  }

  return r.data;
}

function chunkText(text, max = MAX_TEXT) {
  const s = String(text || "");
  if (s.length <= max) return [s];
  const out = [];
  let buf = "";
  for (const line of s.split("\n")) {
    if ((buf + "\n" + line).length > max && buf) {
      out.push(buf);
      buf = "";
    }
    if (line.length > max) {
      for (let i = 0; i < line.length; i += max) {
        out.push(line.slice(i, i + max));
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/* ====================================================================== */
/* 2. Text, Image, Document & Reaction Messaging                          */
/* ====================================================================== */

async function sendWhatsAppText(recipient, text, opts = {}) {
  if (!recipient || !text) return null;
  let last = null;
  const cleanTo = String(recipient).replace(/\+/g, "").trim();

  for (const part of chunkText(text)) {
    last = await postWhatsAppApi(
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: cleanTo,
        type: "text",
        text: { preview_url: opts.preview_url ?? false, body: part }
      },
      "WA TEXT"
    );
  }
  return last;
}

async function sendWhatsAppImage(recipient, mediaIdOrUrl, caption = "") {
  if (!recipient || !mediaIdOrUrl) {
    throw new Error(
      "sendWhatsAppImage: recipient and mediaIdOrUrl are required"
    );
  }

  const mediaStr =
    typeof mediaIdOrUrl === "object" && mediaIdOrUrl.id
      ? String(mediaIdOrUrl.id)
      : String(mediaIdOrUrl).trim();

  const isUrl = /^https?:\/\//i.test(mediaStr);
  const imageObj = isUrl ? { link: mediaStr } : { id: mediaStr };

  if (caption) {
    imageObj.caption = String(caption).slice(0, 1024);
  }

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(recipient).replace(/\+/g, "").trim(),
      type: "image",
      image: imageObj
    },
    "WA IMAGE"
  );
}

/**
 * Sends a silent emoji reaction to an inbound message bubble.
 * Used for non-intrusive photo acknowledgment during batch ingress.
 */
async function sendWhatsAppReaction(recipient, messageId, emoji = "📸") {
  if (!recipient || !messageId) return null;
  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(recipient).replace(/\+/g, "").trim(),
      type: "reaction",
      reaction: {
        message_id: messageId,
        emoji
      }
    },
    "WA REACTION"
  );
}

function detectMimeType(filename) {
  if (/\.xlsx$/i.test(filename))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.pdf$/i.test(filename)) return "application/pdf";
  if (/\.csv$/i.test(filename)) return "text/csv";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.png$/i.test(filename)) return "image/png";
  return "application/octet-stream";
}

async function uploadWhatsAppMedia(buffer, opts = {}) {
  if (!buffer) return null;
  const filename = opts.filename || "file.dat";
  const resolvedMime = opts.mimeType || detectMimeType(filename);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", resolvedMime);
  form.append("file", new Blob([buffer], { type: resolvedMime }), filename);

  const r = await graphJson(
    `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
    { method: "POST", headers: authHeaders(false), body: form },
    { label: "WA MEDIA UPLOAD", timeoutMs: 25000 }
  );
  return r.ok && r.data.id ? r.data.id : null;
}

async function sendWhatsAppDocument(
  recipient,
  buffer,
  filename = "document.xlsx",
  caption = ""
) {
  if (!recipient || !buffer) return null;
  const resolvedMime = detectMimeType(filename);
  const id = await uploadWhatsAppMedia(buffer, {
    mimeType: resolvedMime,
    filename
  });
  if (!id) return null;

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(recipient).replace(/\+/g, "").trim(),
      type: "document",
      document: {
        id,
        filename,
        ...(caption ? { caption: String(caption).slice(0, 1024) } : {})
      }
    },
    "WA DOCUMENT"
  );
}

/* ====================================================================== */
/* 3. Interactive Component Primitives (Buttons & Modal List Menus)       */
/* ====================================================================== */

async function sendWhatsAppButtons(recipient, body, buttons = []) {
  if (!buttons || !buttons.length) {
    return sendWhatsAppText(recipient, body);
  }

  // Enforce Meta limits: strictly <= 3 buttons, grapheme-safe <= 20 char titles
  const formattedButtons = buttons.slice(0, 3).map((btn, idx) => {
    const rawTitle = String(btn.title || `Option ${idx + 1}`).trim();
    const title = safeTruncate(rawTitle, 20);
    const id = String(btn.id || `btn_${idx}`).slice(0, 128);

    return {
      type: "reply",
      reply: { id, title }
    };
  });

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(recipient).replace(/\+/g, "").trim(),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(body).slice(0, 1024) },
        action: { buttons: formattedButtons }
      }
    },
    "WA BUTTONS"
  );
}

async function sendWhatsAppList(recipient, body, buttonText, sections = []) {
  let totalRows = 0;
  const formattedSections = (sections || []).slice(0, 10).map((sec, secIdx) => {
    const secTitle = safeTruncate(sec.title || `Section ${secIdx + 1}`, 24);
    const availableSlots = Math.max(0, 10 - totalRows);
    const rawRows = (sec.rows || []).slice(0, availableSlots);

    const rows = rawRows.map((r, rIdx) => {
      const title = safeTruncate(r.title || `Item ${rIdx + 1}`, 24);
      const id = String(r.id || `row_${secIdx}_${rIdx}`).slice(0, 200);
      const rowObj = { id, title };

      if (r.description) {
        rowObj.description = String(r.description).trim().slice(0, 72);
      }
      return rowObj;
    });

    totalRows += rows.length;
    return { title: secTitle, rows };
  });

  const btnLabel = safeTruncate(buttonText || "Options 📋", 20);

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(recipient).replace(/\+/g, "").trim(),
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: String(body).slice(0, 1024) },
        action: {
          button: btnLabel,
          sections: formattedSections
        }
      }
    },
    "WA LIST"
  );
}

/* ====================================================================== */
/* 4. Utility Handlers (Read Receipts & Media Ingress)                    */
/* ====================================================================== */

async function markAsRead(msgId, opts = {}) {
  if (!msgId) return null;
  const r = await graphJson(
    messagesUrl(),
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: msgId,
        ...(opts.typing ? { typing_indicator: { type: "text" } } : {})
      })
    },
    { label: "WA READ", retries: 0, timeoutMs: 8000 }
  );
  return r.ok;
}

async function downloadWhatsAppMedia(mediaId) {
  if (!mediaId || !process.env.WHATSAPP_ACCESS_TOKEN) return null;
  try {
    const meta = await graphJson(
      `${GRAPH}/${mediaId}`,
      { method: "GET", headers: authHeaders(false) },
      { label: "WA MEDIA META" }
    );
    if (!meta.ok || !meta.data.url) return null;
    if (Number(meta.data.file_size) > MAX_MEDIA_BYTES) {
      return null;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(meta.data.url, {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            "User-Agent": "curl/7.64.1"
          },
          signal: AbortSignal.timeout(25000)
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) continue;
          return null;
        }
        if (Number(res.headers.get("content-length")) > MAX_MEDIA_BYTES) {
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_MEDIA_BYTES) return null;
        return { buffer: buf, mimeType: meta.data.mime_type || "image/jpeg" };
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  sendWhatsAppText,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendWhatsAppImage,
  sendWhatsAppReaction,
  sendWhatsAppDocument,
  downloadWhatsAppMedia,
  uploadWhatsAppMedia,
  markAsRead,
  safeTruncate
};
