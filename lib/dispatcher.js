// lib/dispatcher.js — Thread-Local Symmetrical Turn Supervisors & Reply Handlers
"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const WA = require("./whatsapp");
const Credits = require("./credits");
const Links = require("./links");
const { t } = require("./copy");
const { getConfig } = require("../config");

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
 *
 * Message credits (lib/credits.js) are checked first: past the ceiling a broker gets one notice a day
 * and then nothing (read ticks only); notifications need credits below 100%; sign-in links have their
 * own ceiling. Text-bearing replies may carry the turn note (e.g. "📸 8 photos received") and, once
 * per level a month, the 50/80/100% credits hint, in the same message (no extra credit).
 *
 * @param {Function} sendFn - (recipient, body) → result; body is the decorated text (null for media)
 */
async function deliver(broker, kind, sendFn, text = null) {
  const store = turnStore.getStore();
  const recipient = broker.phone_normalized || broker.phone_number;
  const gate = await creditGate(broker, kind, store);
  if (gate.block) return null;
  if (gate.replaceWith) {
    return sendCounted(broker, "reply", () => WA.sendWhatsAppText(recipient, gate.replaceWith), store);
  }
  let body = text;
  let note = null;
  if (text !== null && text !== undefined) {
    note = store?.note || null;
    if (note) store.note = null;
    const hint = gate.hint || "";
    body = `${note ? `${note.text}\n\n` : ""}${text}${hint ? `\n\n${hint}` : ""}`;
  }
  const result = await sendCounted(broker, kind, () => sendFn(recipient, body), store);
  if (note) {
    if (result) await Promise.resolve(note.onDelivered?.()).catch(() => {});
    else store.note = note; // the next reply carries it
  }
  return result;
}

async function sendCounted(broker, kind, send, store) {
  const recipient = broker.phone_normalized || broker.phone_number;
  try {
    const result = await send();
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
        recipient: maskRecipient(recipient),
        agencyId: broker.agency_id || null,
        brokerId: store?.brokerId || broker.id || null,
        err: err?.message
      })
    );
    return null;
  }
}

const maskRecipient = (r) => (r ? `••${String(r).slice(-4)}` : null);

/** Inserts a once-only inbox row; true when this call created it (the first time for that key). */
async function claimOnce(pool, broker, { kind, key, title, body = "", url = null }) {
  const { rows } = await pool.query(
    `INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, body, url, channel, status, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'inbox', 'sent', NOW())
     ON CONFLICT (broker_id, dedupe_key) DO NOTHING RETURNING id`,
    [broker.agency_id, broker.id, kind, key, title, body, url]
  );
  return rows.length > 0;
}

/** Credit check before a send: { block } | { replaceWith } (the daily ceiling notice) | { hint } | {}. */
async function creditGate(broker, kind, store) {
  const pool = store?.pool;
  if (!pool || !broker?.agency_id || !broker.id) return {};
  let state;
  try {
    state = await Credits.check(pool, broker);
  } catch (err) {
    console.warn("Credit check failed (sending anyway):", err.message);
    return {};
  }
  store.credits = state;
  const en = broker.preferred_lang === "en";
  if (!Credits.allowsSend(state, kind)) {
    if (Credits.LOGIN_KINDS.includes(kind) || String(kind).startsWith("notify")) return { block: true };
    // Past the ceiling: one notice a day, then read ticks only (the inbox explains why).
    const text = t("credits_ceiling", en ? "en" : "ar", { url: Links.appUrl("/") });
    const first = await claimOnce(pool, broker, {
      kind: "credits",
      key: `credits_ceiling:${Credits.dayKey()}`,
      title: en ? "Monthly WhatsApp limit reached" : "خلص رصيد واتساب الشهري",
      body: text,
      url: "/app/usage"
    }).catch(() => false);
    if (first) return { replaceWith: text };
    allowSilentDrop("credits_ceiling");
    return { block: true };
  }
  if (Credits.LOGIN_KINDS.includes(kind) || String(kind).startsWith("notify")) return {};
  const level = Credits.hintLevel(state);
  if (!level) return {};
  const text = t(`credits_hint_${level}`, en ? "en" : "ar", { url: Links.appUrl(level === 100 ? "/settings" : "/usage") });
  const first = await claimOnce(pool, broker, {
    kind: "credits",
    key: `credits_hint:${Credits.monthKey()}:${level}`,
    title: en ? `WhatsApp credits: ${level}% used` : `رصيد واتساب: اتصرف ${level}%`,
    body: text,
    url: "/app/usage"
  }).catch(() => false);
  if (!first) return {};
  if (level >= 80) {
    // Managers hear about it once a month per level (inbox or push; never doubled).
    require("./notifications")
      .creditWarning(pool, broker.agency_id, { level, state })
      .catch((e) => console.warn("Credit warning failed:", e.message));
  }
  return { hint: text };
}

/**
 * Outbound message counter: one operation_logs row (operation_type 'wa_outbound') per send
 * attempt, so per-agency volume can be sized against the WhatsApp pricing tiers.
 * metadata: { kind, action (search, add_unit, flyer, client_copy, crm, notification, …), egp }.
 * Uses the pool of the current turn; sends outside a turn are not counted.
 */
async function countOutbound(broker, kind, status) {
  const store = turnStore.getStore();
  const pool = store?.pool;
  if (!pool || !broker?.agency_id) return;
  const meta = { kind, action: store.action || "other" };
  if (status === "success") meta.egp = getConfig().credits.priceEgp;
  try {
    await pool.query(
      `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, metadata, created_at)
       VALUES ($1, $2, 'wa_outbound', $3, $4::jsonb, NOW())`,
      [broker.agency_id, broker.id || null, status, JSON.stringify(meta)]
    );
  } catch (e) {
    console.warn("Outbound counter write failed:", e.message);
  }
}

/** Names what the current turn is doing, for the usage page ("search", "add_unit", "flyer", …). */
function setTurnAction(action) {
  const store = turnStore.getStore();
  if (store && action) store.action = action;
}

/** A line the next text reply of this turn starts with; onDelivered runs once WhatsApp accepts it. */
function setTurnNote(text, onDelivered) {
  const store = turnStore.getStore();
  if (store && text) store.note = { text, onDelivered };
}

/** Credit state checked by the last send of this turn (or null). */
const turnCredits = () => turnStore.getStore()?.credits || null;

/** Text reply. opts.kind names a send with its own rules (e.g. "web_login_link"). */
async function reply(broker, text, opts = {}) {
  if (!text) return null;
  const { kind = "reply", ...waOpts } = opts;
  return deliver(broker, kind, (to, body) => WA.sendWhatsAppText(to, body, waOpts), text);
}

/** Quick-reply buttons (max 3, titles <= 20 chars). */
async function replyButtons(broker, bodyText, buttons = []) {
  if (!bodyText) return null;
  return deliver(broker, "replyButtons", (to, body) => WA.sendWhatsAppButtons(to, body, buttons), bodyText);
}

/** Interactive list menu (max 10 rows). */
async function replyList(broker, bodyText, buttonText, sections = []) {
  if (!bodyText) return null;
  return deliver(broker, "replyList", (to, body) => WA.sendWhatsAppList(to, body, buttonText, sections), bodyText);
}

/** Image by media id or public URL. */
async function replyImage(broker, mediaIdOrUrl, caption = "") {
  if (!mediaIdOrUrl) return null;
  return deliver(broker, "replyImage", (to) => WA.sendWhatsAppImage(to, mediaIdOrUrl, caption));
}

/** Document upload + send; null when the upload or send fails. */
async function replyDocument(broker, buffer, filename, caption = "") {
  if (!buffer) return null;
  return deliver(broker, "replyDocument", (to) => WA.sendWhatsAppDocument(to, buffer, filename, caption));
}

/** Emoji reaction on an inbound message; a delivered reaction acknowledges the turn. */
async function react(broker, messageId, emoji) {
  if (!messageId) return null;
  return deliver(broker, "react", (to) => WA.sendWhatsAppReaction(to, messageId, emoji));
}

/**
 * Text sent outside a WhatsApp turn (web sign-in links, notifications). Goes through the same
 * deliver() path, so it is counted per agency with the given pool and checked against the credits.
 * Returns null when WhatsApp does not accept it (e.g. the broker's 24-hour window is closed).
 */
async function notify(broker, text, { pool = null, kind = "notify", action = "notification", buttons = null } = {}) {
  if (!text) return null;
  return turnStore.run({ pool, replied: false, silentDropAllowed: true, action, brokerId: broker.id }, () =>
    buttons && buttons.length
      ? deliver(broker, kind, (to, body) => WA.sendWhatsAppButtons(to, body, buttons), text)
      : deliver(broker, kind, (to, body) => WA.sendWhatsAppText(to, body), text)
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
  setTurnAction,
  setTurnNote,
  turnCredits,
  claimOnce,
  reply,
  replyButtons,
  replyList,
  replyImage,
  replyDocument,
  react,
  notify,
  markReplied,
  allowSilentDrop,
  executeGuardedTurn
};
