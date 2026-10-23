// lib/dispatcher.js — Thread-Local Symmetrical Turn Supervisors & Reply Handlers
"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const WA = require("./whatsapp");

// Thread-local store tracking turn delivery state per message execution
const turnStore = new AsyncLocalStorage();

/**
 * Explicitly marks the current execution turn as replied.
 * Call this whenever sending non-text messages directly (buttons, media, documents).
 */
function markReplied() {
  const store = turnStore.getStore();
  if (store) {
    store.replied = true;
  }
}

/**
 * Standard Symmetrical Reply Wrapper
 * Intercepts outbound replies to mark the current turn as answered.
 *
 * @param {Object} broker - Broker record containing phone_normalized
 * @param {string} text - Message text to send
 * @param {Object} opts - Optional WhatsApp parameters
 * @returns {Promise<Object|null>}
 */
async function reply(broker, text, opts = {}) {
  if (!text) return null;
  markReplied();

  const recipient = broker.phone_normalized || broker.phone_number;
  try {
    return await WA.sendWhatsAppText(recipient, text, opts);
  } catch (err) {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        msg: "reply dispatch failed",
        recipient,
        err: err?.message
      })
    );
    return null;
  }
}

/**
 * Symmetrical Interactive Buttons Wrapper
 * Dispatches quick-reply buttons and marks the current turn as replied.
 *
 * @param {Object} broker - Broker record containing phone_normalized
 * @param {string} bodyText - Message body
 * @param {Array<Object>} buttons - Array of button objects (max 3, title <= 20 chars)
 * @returns {Promise<Object|null>}
 */
async function replyButtons(broker, bodyText, buttons = []) {
  if (!bodyText) return null;
  markReplied();

  const recipient = broker.phone_normalized || broker.phone_number;
  try {
    return await WA.sendWhatsAppButtons(recipient, bodyText, buttons);
  } catch (err) {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        msg: "replyButtons dispatch failed",
        recipient,
        err: err?.message
      })
    );
    return null;
  }
}

/**
 * Explicit flag for intentional silent drops
 * Used ONLY for 3-second button debouncing, rate limiting, or read receipts.
 *
 * @param {string} reason
 */
function allowSilentDrop(reason = "intentional") {
  const store = turnStore.getStore();
  if (store) {
    store.silentDropAllowed = true;
    store.dropReason = reason;
  }
}

/**
 * Executes an incoming message or webhook event inside an enforced
 * symmetrical response boundary.
 *
 * @param {Object} broker - Authenticated broker record
 * @param {Object} message - Raw WhatsApp message payload
 * @param {Function} handlerFn - Domain router handler returning 'done', 'batched', or 'failed'
 * @returns {Promise<string>}
 */
async function executeGuardedTurn(broker, message, handlerFn) {
  const store = {
    replied: false,
    silentDropAllowed: false,
    dropReason: null,
    msgId: message.id,
    brokerId: broker.id
  };

  return turnStore.run(store, async () => {
    const lang = broker.preferred_lang || "ar";

    try {
      const outcome = await handlerFn();

      // SAFETY NET: If the turn completed without a reply and was not an allowed silent drop
      if (!store.replied && !store.silentDropAllowed && outcome !== "batched") {
        console.warn(
          JSON.stringify({
            t: new Date().toISOString(),
            level: "warn",
            msg: "SILENT_DROP_PREVENTED: Unhandled turn routed to fallback",
            msgId: message.id,
            brokerId: broker.id
          })
        );

        const fallbackMsg =
          lang === "en"
            ? "⚠️ We received your message, but could not determine the requested action. Type *help* for available commands."
            : "⚠️ استلمنا رسالتك، ولكن تعذر تحديد الإجراء المطلوب بدقة. اكتب *«مساعدة»* لعرض الأوامر المتاحة.";

        await reply(broker, fallbackMsg);
      }

      return outcome || "done";
    } catch (err) {
      console.error(
        JSON.stringify({
          t: new Date().toISOString(),
          level: "error",
          msg: "UNHANDLED_TURN_CRASH: Execution failed inside guarded turn",
          msgId: message.id,
          brokerId: broker.id,
          err: err?.message,
          stack: err?.stack
        })
      );

      // Symmetrical error response so broker never faces silence
      const errorMsg =
        lang === "en"
          ? "❌ A temporary service error occurred. Your draft data is preserved; please retry in a moment."
          : "❌ حدث خطأ فني مؤقت أثناء المعالجة. بياناتك ومسودتك محفوظة بالكامل، يرجى إعادة المحاولة.";

      await reply(broker, errorMsg);
      return "failed";
    }
  });
}

module.exports = {
  reply,
  replyButtons,
  markReplied,
  allowSilentDrop,
  executeGuardedTurn
};
