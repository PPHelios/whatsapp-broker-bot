// lib/whatsapp.js
"use strict";

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_TEXT = 3900; // WhatsApp hard limit is 4096
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const messagesUrl = () =>
  `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const authHeaders = (json = true) => ({
  Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  ...(json ? { "Content-Type": "application/json" } : {})
});

/**
 * fetch + JSON with retry on 429 / 5xx / network errors (honours Retry-After).
 * Never throws. -> { ok, status, data }
 */
async function graphJson(
  url,
  opts = {},
  { retries = 3, timeoutMs = 15000, label = "WA" } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, data };
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        console.error(
          `❌ [${label} ${res.status}]:`,
          JSON.stringify(data).slice(0, 400)
        );
        return { ok: false, status: res.status, data };
      }
      const ra = Number(res.headers.get("retry-after"));
      await sleep(
        ra > 0
          ? ra * 1000
          : Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300
      );
    } catch (err) {
      if (attempt >= retries) {
        console.error(`❌ [${label} EXCEPTION]:`, err.message);
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

/**
 * Core HTTP dispatcher for WhatsApp messages.
 * Throws on failure so callers (server.js) can detect 131047 / 80007 error codes.
 */
async function postWhatsAppApi(payload, label = "WA API") {
  const r = await graphJson(
    messagesUrl(),
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(payload)
    },
    { label }
  );

  if (!r.ok) {
    const errorData = r.data?.error || {};
    const err = new Error(
      errorData.message || `WhatsApp API error ${r.status}`
    );
    err.status = r.status;
    err.response = { data: r.data };
    err.code = errorData.code;
    throw err;
  }

  return r.data;
}

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
      for (let i = 0; i < line.length; i += max)
        out.push(line.slice(i, i + max));
    } else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out;
}

/** Returns the last API response. */
async function sendWhatsAppText(to, body) {
  if (!to || !body) return null;
  let last = null;
  for (const part of chunkText(body)) {
    last = await postWhatsAppApi(
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace(/\+/g, ""),
        type: "text",
        text: { preview_url: false, body: part }
      },
      "WA TEXT"
    );
  }
  return last;
}

/** `image` is a public URL string or { id } of an uploaded WhatsApp media. */
async function sendWhatsAppImage(to, image, caption = "") {
  if (!to || !image) return null;
  const media = typeof image === "string" ? { link: image } : { id: image.id };
  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\+/g, ""),
      type: "image",
      image: {
        ...media,
        ...(caption ? { caption: String(caption).slice(0, 1024) } : {})
      }
    },
    "WA IMAGE"
  );
}

/** Upload once, send many times by id (ids stay valid ~30 days). -> id | null */
async function uploadWhatsAppMedia(
  buffer,
  { mimeType = "image/jpeg", filename = "file.jpg" } = {}
) {
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

async function sendWhatsAppDocument(
  to,
  buffer,
  filename = "export.csv",
  caption = "",
  mimeType = "text/csv"
) {
  if (!to || !buffer) return null;
  const id = await uploadWhatsAppMedia(buffer, { mimeType, filename });
  if (!id) return null;
  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\+/g, ""),
      type: "document",
      document: { id, filename, ...(caption ? { caption } : {}) }
    },
    "WA DOCUMENT"
  );
}

/**
 * Sends WhatsApp interactive button message with strict Meta API guardrails:
 * - Max 3 buttons
 * - Max 20 chars per button title
 * - Max 128 chars per button ID
 */
async function sendWhatsAppButtons(toPhone, bodyText, rawButtons = []) {
  if (!rawButtons.length) {
    return sendWhatsAppText(toPhone, bodyText);
  }

  const buttons = rawButtons.slice(0, 3).map((btn, idx) => {
    const rawTitle = String(btn.title || `Option ${idx + 1}`).trim();
    const title = rawTitle.length > 20 ? rawTitle.slice(0, 20) : rawTitle;
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
      to: toPhone.replace(/\+/g, ""),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText).slice(0, 1024) },
        action: { buttons }
      }
    },
    "WA BUTTONS"
  );
}

/**
 * Sends WhatsApp interactive list message with strict Meta API guardrails:
 * - Header text max 60 chars
 * - Body text max 1024 chars
 * - Button text max 20 chars
 * - Max 10 sections
 * - Section title max 24 chars
 * - Max 10 rows across all sections
 * - Row title max 24 chars
 * - Row description max 72 chars
 * - Row ID max 200 chars
 */
async function sendWhatsAppList(
  to,
  headerText,
  bodyText,
  buttonText,
  rawSections = []
) {
  let totalRows = 0;
  const sections = (rawSections || []).slice(0, 10).map((sec, secIdx) => {
    const secTitle = String(sec.title || `Section ${secIdx + 1}`)
      .trim()
      .slice(0, 24);
    const availableRowSlots = Math.max(0, 10 - totalRows);
    const rawRows = (sec.rows || []).slice(0, availableRowSlots);

    const rows = rawRows.map((r, rIdx) => {
      const rawTitle = String(r.title || `Item ${rIdx + 1}`).trim();
      const title = rawTitle.slice(0, 24);
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

  const btnLabel = String(buttonText || "Options")
    .trim()
    .slice(0, 20);

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\+/g, ""),
      type: "interactive",
      interactive: {
        type: "list",
        ...(headerText
          ? { header: { type: "text", text: String(headerText).slice(0, 60) } }
          : {}),
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          button: btnLabel,
          sections
        }
      }
    },
    "WA LIST"
  );
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

/** -> { buffer, mimeType } | null */
async function downloadWhatsAppMedia(
  mediaId,
  { maxBytes = MAX_MEDIA_BYTES } = {}
) {
  if (!mediaId || !process.env.WHATSAPP_ACCESS_TOKEN) return null;
  try {
    const meta = await graphJson(
      `${GRAPH}/${mediaId}`,
      { method: "GET", headers: authHeaders(false) },
      { label: "WA MEDIA META" }
    );
    if (!meta.ok || !meta.data.url) return null;
    if (Number(meta.data.file_size) > maxBytes) {
      console.warn(`[WA MEDIA] ${mediaId} too large (${meta.data.file_size})`);
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
  postWhatsAppApi,
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  sendWhatsAppButtons,
  uploadWhatsAppMedia,
  markAsRead,
  downloadWhatsAppMedia,
  sendWhatsAppList
};
