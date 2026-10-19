const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";

function getMessagesUrl() {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

function getAuthHeaders(isJson = true) {
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`
  };
  if (isJson) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * Sends a standard text message via WhatsApp Cloud API.
 */
async function sendWhatsAppText(to, body) {
  if (!to || !body) return null;

  const res = await fetch(getMessagesUrl(), {
    method: "POST",
    headers: getAuthHeaders(true),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: String(body) }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ [WA TEXT ERROR]:", JSON.stringify(data));
  }
  return data;
}

/**
 * Sends an image message (e.g. Satori flyer) via public URL.
 */
async function sendWhatsAppImage(to, imageUrl, caption = "") {
  if (!to || !imageUrl) return null;

  const res = await fetch(getMessagesUrl(), {
    method: "POST",
    headers: getAuthHeaders(true),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: {
        link: imageUrl,
        caption: caption ? String(caption).slice(0, 1024) : undefined
      }
    })
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ [WA IMAGE ERROR]:", JSON.stringify(data));
  }
  return data;
}

/**
 * Uploads a Buffer (e.g. CSV export) to WhatsApp media endpoint and sends it as a document.
 */
async function sendWhatsAppDocument(
  to,
  buffer,
  filename = "export.csv",
  caption = ""
) {
  if (!to || !buffer) return null;

  const mediaUploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  formData.append(
    "file",
    new Blob([buffer], { type: "text/csv;charset=utf-8" }),
    filename
  );

  const uploadRes = await fetch(mediaUploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    body: formData
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || !uploadData.id) {
    console.error("❌ [WA MEDIA UPLOAD ERROR]:", JSON.stringify(uploadData));
    return null;
  }

  const res = await fetch(getMessagesUrl(), {
    method: "POST",
    headers: getAuthHeaders(true),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: {
        id: uploadData.id,
        filename,
        caption: caption || undefined
      }
    })
  });

  return res.json();
}

/**
 * Downloads binary media buffer from Meta Graph API given a mediaId.
 * @param {string} mediaId
 * @returns {Promise<{ buffer: Buffer, mimeType: string } | null>}
 */
// lib/whatsapp.js
async function downloadWhatsAppMedia(mediaId) {
  if (!mediaId) return null;

  try {
    const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!token) {
      console.error(
        "❌ [WA MEDIA ERROR]: WHATSAPP_ACCESS_TOKEN is missing in environment variables."
      );
      return null;
    }

    // Step 1: Query Graph API to get the temporary binary URL
    const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`;
    const metaRes = await fetch(metaUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const metaData = await metaRes.json();
    if (!metaRes.ok || !metaData.url) {
      console.error("❌ [WA MEDIA META ERROR]:", JSON.stringify(metaData));
      return null;
    }

    // Step 2: Download the binary file using the Authorization header + User-Agent
    const fileRes = await fetch(metaData.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "curl/7.64.1" // Required by Meta CDN to avoid generic stream blocks
      }
    });

    if (!fileRes.ok) {
      console.error("❌ [WA MEDIA DOWNLOAD FAILED]: HTTP", fileRes.status);
      return null;
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: metaData.mime_type || "image/jpeg"
    };
  } catch (err) {
    console.error("❌ [WA MEDIA EXCEPTION]:", err.message);
    return null;
  }
}
module.exports = {
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  downloadWhatsAppMedia
};
