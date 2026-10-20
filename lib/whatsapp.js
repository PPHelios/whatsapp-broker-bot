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

async function sendWhatsAppText(to, body) {
  if (!to || !body) return null;
  try {
    const res = await fetch(getMessagesUrl(), {
      method: "POST",
      headers: getAuthHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: String(body) }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (!res.ok) console.error("❌ [WA TEXT ERROR]:", JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("❌ [WA TEXT EXCEPTION]:", err.message);
    return null;
  }
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  if (!to || !imageUrl) return null;
  try {
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
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    if (!res.ok) console.error("❌ [WA IMAGE ERROR]:", JSON.stringify(data));
    return data;
  } catch (err) {
    console.error("❌ [WA IMAGE EXCEPTION]:", err.message);
    return null;
  }
}

async function sendWhatsAppDocument(
  to,
  buffer,
  filename = "export.csv",
  caption = ""
) {
  if (!to || !buffer) return null;
  try {
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
      body: formData,
      signal: AbortSignal.timeout(20000)
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
        document: { id: uploadData.id, filename, caption: caption || undefined }
      }),
      signal: AbortSignal.timeout(15000)
    });
    return res.json();
  } catch (err) {
    console.error("❌ [WA DOCUMENT EXCEPTION]:", err.message);
    return null;
  }
}

async function downloadWhatsAppMedia(mediaId) {
  if (!mediaId) return null;
  try {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) return null;

    const metaRes = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000)
      }
    );
    const metaData = await metaRes.json();
    if (!metaRes.ok || !metaData.url) return null;

    const fileRes = await fetch(metaData.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "curl/7.64.1"
      },
      signal: AbortSignal.timeout(25000)
    });
    if (!fileRes.ok) return null;

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
