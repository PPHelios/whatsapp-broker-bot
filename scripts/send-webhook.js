// scripts/send-webhook.js
"use strict";
require("dotenv").config();
const crypto = require("crypto");

const SECRET = process.env.WHATSAPP_APP_SECRET;
const PORT = process.env.PORT || 3000;
const URL = `http://localhost:${PORT}/webhook`;

if (!SECRET) {
  console.error(
    "❌ Error: WHATSAPP_APP_SECRET is missing from your .env file."
  );
  process.exit(1);
}

/**
 * Sends a simulated WhatsApp webhook payload signed with HMAC-SHA256
 */
async function sendEvent({ from = "201055881114", text, buttonId, mediaId }) {
  const msgObj = {
    from,
    id: `wamid.test_${Date.now()}`,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    type: text ? "text" : buttonId ? "interactive" : mediaId ? "image" : "text"
  };

  if (text) {
    msgObj.text = { body: text };
  } else if (buttonId) {
    msgObj.interactive = {
      type: "button_reply",
      button_reply: { id: buttonId }
    };
  } else if (mediaId) {
    msgObj.image = { id: mediaId, caption: "" };
  }

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_SIMULATOR",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "201000000000" },
              contacts: [{ profile: { name: "Agent Test" }, wa_id: from }],
              messages: [msgObj]
            },
            field: "messages"
          }
        ]
      }
    ]
  };

  const rawBody = JSON.stringify(payload);
  const signature =
    "sha256=" +
    crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");

  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": signature
      },
      body: rawBody
    });

    console.log(
      `📡 [${res.status} ${res.statusText}] Sent:`,
      text || buttonId || `Image(${mediaId})`
    );
  } catch (err) {
    console.error(
      `❌ Connection failed to ${URL}. Is your server running?`,
      err.message
    );
  }
}

// CLI Execution Router
const [, , actionType, ...rest] = process.argv;
const value = rest.join(" ").trim();

if (!actionType || !value) {
  console.log(`
Usage:
  node scripts/send-webhook.js text <message>
  node scripts/send-webhook.js button <button_id>
  node scripts/send-webhook.js image <media_id>

Examples:
  node scripts/send-webhook.js text "كود HAS101"
  node scripts/send-webhook.js text "عايز شقة 3 غرف في ميفيدا"
  node scripts/send-webhook.js button "edit_btn:HAS101"
  node scripts/send-webhook.js button "DRAFT_SAVE"
  `);
  process.exit(0);
}

if (actionType === "text") {
  sendEvent({ text: value });
} else if (actionType === "button" || actionType === "btn") {
  sendEvent({ buttonId: value });
} else if (actionType === "image" || actionType === "img") {
  sendEvent({ mediaId: value });
} else {
  console.error("Unknown action type. Use: text, button, or image.");
}
