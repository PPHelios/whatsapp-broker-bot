// lib/dispatcher.js — Thread-Local Symmetrical Turn Supervisors & Reply Handlers
"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const WA = require("./whatsapp");

// Thread-local store tracking turn delivery state per message execution
const turnStore = new AsyncLocalStorage();

/**
 * Explicitly marks the current execution turn as replied.
 * Prefer the reply* helpers below, which mark only after WhatsApp accepts the message.
 */
function markReplied() {
  const store = turnStore.getStore();
  if (store) {
    store.replied = true;
  }
}

/**
 * Single outbound path for every turn reply.
 * The turn counts as answered only when WhatsApp accepts the message (non-null result);
 * a failed or dropped send leaves it unanswered so the safety net can still respond.
 */
async function deliver(broker, kind, sendFn) {
  const recipient = broker.phone_normalized || broker.phone_number;
  try {
    const result = await sendFn(recipient);
    if (result) markReplied();
    await countOutbound(broker, kind, result ? "success" : "dropped");
    return result || null;
  } catch (err) {
    await countOutbound(broker, kind, "failed");
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        msg: `${kind} dispatch failed`,
        recipient,
        err: err?.message
      })
    );
    return null;
  }
}

/**
 * Outbound message counter: one operation_logs row (operation_type 'wa_outbound') per send
 * attempt, so per-agency volume can be sized against the WhatsApp pricing tiers.
 * Uses the pool of the current turn; sends outside a turn are not counted.
 */
async function countOutbound(broker, kind, status) {
  const pool = turnStore.getStore()?.pool;
  if (!pool || !broker?.agency_id) return;
  try {
    await pool.query(
      `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, metadata, created_at)
       VALUES ($1, $2, 'wa_outbound', $3, $4::jsonb, NOW())`,
      [broker.agency_id, broker.id || null, status, JSON.stringify({ kind })]
    );
  } catch (e) {
    console.warn("Outbound counter write failed:", e.message);
  }
}

/** Text reply. */
async function reply(broker, text, opts = {}) {
  if (!text) return null;
  return deliver(broker, "reply", (to) => WA.sendWhatsAppText(to, text, opts));
}

/** Quick-reply buttons (max 3, titles <= 20 chars). */
async function replyButtons(broker, bodyText, buttons = []) {
  if (!bodyText) return null;
  return deliver(broker, "replyButtons", (to) =>
    WA.sendWhatsAppButtons(to, bodyText, buttons)
  );
}

/** Interactive list menu (max 10 rows). */
async function replyList(broker, bodyText, buttonText, sections = []) {
  if (!bodyText) return null;
  return deliver(broker, "replyList", (to) =>
    WA.sendWhatsAppList(to, bodyText, buttonText, sections)
  );
}

/** Image by media id or public URL. */
async function replyImage(broker, mediaIdOrUrl, caption = "") {
  if (!mediaIdOrUrl) return null;
  return deliver(broker, "replyImage", (to) =>
    WA.sendWhatsAppImage(to, mediaIdOrUrl, caption)
  );
}

/** Document upload + send; null when the upload or send fails. */
async function replyDocument(broker, buffer, filename, caption = "") {
  if (!buffer) return null;
  return deliver(broker, "replyDocument", (to) =>
    WA.sendWhatsAppDocument(to, buffer, filename, caption)
  );
}

/** Emoji reaction on an inbound message; a delivered reaction acknowledges the turn. */
async function react(broker, messageId, emoji) {
  if (!messageId) return null;
  return deliver(broker, "react", (to) =>
    WA.sendWhatsAppReaction(to, messageId, emoji)
  );
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
 * @param {Object} [opts] - { pool } used by the outbound message counter
 * @returns {Promise<string>}
 */
async function executeGuardedTurn(broker, message, handlerFn, { pool = null } = {}) {
  const store = {
    pool,
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
  countOutbound,
  reply,
  replyButtons,
  replyList,
  replyImage,
  replyDocument,
  react,
  markReplied,
  allowSilentDrop,
  executeGuardedTurn
};
