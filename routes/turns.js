// routes/turns.js — The turn pipeline shared by WhatsApp and Telegram: dedupe on the message id (inbound_messages),
// broker lookup, the per-turn context, the guarded dispatch and its status, plus the boot recovery sweep.
// Split out of server.js.
"use strict";

const WA = require("../lib/whatsapp");
const TgLink = require("../lib/tgLink");
const TapGuard = require("../lib/tapGuard");
const U = require("../lib/util");
const S = require("../lib/search");
const AI = require("../lib/ai");
const ErrorReports = require("../lib/errorReports");
const { executeGuardedTurn } = require("../lib/dispatcher");
const { dispatchMessage } = require("./dispatch");
const WaOwnerOnly = require("../lib/waOwnerOnly");

/** Builds the pipeline around the pool, config, tap guard and the drain state (state.inFlight counts turns). */
function createTurnPipeline({ pool, config, tapGuard, state }) {
  /** Dedupe on the message id, then the guarded turn and its status (shared by WhatsApp and Telegram). */
  async function runTurn(broker, message, phoneKey) {
    state.inFlight++;
    try {
      const { rows: inserted } = await pool.query(
        `INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'processing', NOW(), NOW())
         ON CONFLICT (msg_id) DO NOTHING RETURNING msg_id`,
        [message.id, phoneKey, JSON.stringify(message)]
      );
      if (!inserted.length) return;
      const ctx = await buildTurnContext(broker);
      await executeGuardedTurn(broker, message, () => dispatchMessage(broker, message, ctx), { pool });
      await pool.query("UPDATE inbound_messages SET status = 'completed', updated_at = NOW() WHERE msg_id = $1", [message.id]).catch(() => {});
    } catch (err) {
      await ErrorReports.capture(err, { pool, source: "webhook", broker, msgId: message.id, metadata: { type: message.type, channel: "telegram" } });
      await pool.query("UPDATE inbound_messages SET status = 'failed', updated_at = NOW() WHERE msg_id = $1", [message.id]).catch(() => {});
    } finally {
      state.inFlight--;
    }
  }

  /**
   * Processes one verified webhook body: dedupe, broker auth, guarded dispatch, status update.
   */
  async function handleWebhookBody(body) {
    // Meta may batch several entries/changes/messages into one POST; process every message in order.
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          // WhatsApp serves the CRM owner's number only, and only login and help (lib/waOwnerOnly.js). Others get nothing.
          if (!WaOwnerOnly.inboundAllowed(message)) continue;
          await handleInboundMessage(message);
        }
      }
    }
  }

  /** Active broker for a normalized phone (with the agency_id every query is scoped to). */
  async function findActiveBroker(normalizedPhone) {
    const { rows } = await pool.query(
      `SELECT id, agency_id, name, phone_number, phone_normalized, contact_phone, role, preferred_lang, is_active
       FROM brokers
       WHERE phone_normalized = $1 AND is_active = true
       LIMIT 1`,
      [normalizedPhone]
    );
    return rows;
  }

  /**
   * Per-turn execution context. broker and agency travel with every call, so telemetry
   * (AI gateway, search, commands) always records agency_id and broker_id.
   */
  async function buildTurnContext(broker) {
    const { rows } = await pool.query("SELECT * FROM agencies WHERE id = $1", [broker.agency_id]);
    return {
      pool,
      config,
      lang: broker.preferred_lang || "ar",
      broker,
      agency: rows[0] || { id: broker.agency_id },
      S,
      AI
    };
  }

  /**
   * Processes one inbound message: dedupe, broker auth, guarded dispatch, status update.
   */
  async function handleInboundMessage(message) {
    if (!message || !message.from) return;

    const rawPhone = message.from;
    const normalizedPhone = U.normalizePhone(rawPhone);

    // Mark message as read on WhatsApp
    // Read receipt + typing indicator: the broker sees "typing…" while the turn is processed.
    WA.markAsRead(message.id, { typing: true }).catch(() => {});

    state.inFlight++;
    let tap = null;
    try {
      // 2. Webhook Deduplication via inbound_messages (SEC-03)
      if (message.id) {
        const { rows: inserted } = await pool.query(
          `INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at, updated_at)
         VALUES ($1, $2, $3::jsonb, 'processing', NOW(), NOW())
         ON CONFLICT (msg_id) DO NOTHING
         RETURNING msg_id`,
          [message.id, normalizedPhone, JSON.stringify(message)]
        );

        if (inserted.length === 0) {
          // Duplicate delivery from Meta; drop safely to avoid duplicate turns
          return;
        }
      }

      // 3. Authenticate Broker against PostgreSQL (Strict Schema Invariant)
      const brokers = await findActiveBroker(normalizedPhone);

      if (brokers.length === 0) {
        // Reply to an unknown number at most once per 24h (its messages are all recorded above).
        const { rows: recent } = await pool.query(
          `SELECT count(*)::int AS n FROM inbound_messages
           WHERE phone_key = $1 AND received_at > NOW() - INTERVAL '24 hours'`,
          [normalizedPhone]
        );
        if ((recent[0]?.n || 0) <= 1 && config.whatsapp.enabled) {
          await WA.sendWhatsAppText(
            normalizedPhone,
            "⚠️ هذا الرقم غير مسجل كوكيل عقاري معتمد في منصة WehdatHub. يرجى التواصل مع إدارة وكالتك لتفعيل حسابك.\n" +
              "⚠️ This number is not registered as a WehdatHub broker. Please ask your agency admin to activate your account."
          );
        }
        return;
      }

      const broker = brokers[0];
      // A repeated button tap is recorded and dropped (WhatsApp has no toast to show).
      const tapId = TapGuard.tapId(message);
      if (tapId) {
        tap = tapGuard.claim(broker.id, tapId);
        if (!tap.ok) {
          tap = null;
          if (message.id) await pool.query("UPDATE inbound_messages SET status = 'ignored', updated_at = NOW() WHERE msg_id = $1", [message.id]).catch(() => {});
          return;
        }
      }
      const ctx = await buildTurnContext(broker);

      // 5. Execute turn inside the Symmetrical Zero-Silent-Drop boundary
      await executeGuardedTurn(
        broker,
        message,
        () => dispatchMessage(broker, message, ctx),
        { pool }
      );

      if (message.id) {
        await pool
          .query(
            "UPDATE inbound_messages SET status = 'completed', updated_at = NOW() WHERE msg_id = $1",
            [message.id]
          )
          .catch(() => {});
      }
    } catch (err) {
      await ErrorReports.capture(err, { pool, source: "webhook", msgId: message.id || null, metadata: { type: message.type } });
      if (message.id) {
        await pool
          .query(
            "UPDATE inbound_messages SET status = 'failed', updated_at = NOW() WHERE msg_id = $1",
            [message.id]
          )
          .catch(() => {});
      }
    } finally {
      tap?.release();
      state.inFlight--;
    }
  }

  /**
   * SEC-03: Startup Crash Recovery Sweep
   */
  async function bootRecovery() {
    try {
      // Claimed in one statement (new → batched), so two instances booting together never replay the same row.
      // Only `new` rows of the last 15 minutes: `batched` ones belong to a live turn, older ones are stale.
      const { rows: pending } = await pool.query(
        `WITH claimed AS (
           UPDATE inbound_messages SET status = 'batched', attempts = attempts + 1, updated_at = NOW()
           WHERE status = 'new' AND received_at >= NOW() - INTERVAL '15 minutes'
           RETURNING msg_id, phone_key, payload, received_at
         )
         SELECT msg_id, phone_key, payload FROM claimed ORDER BY received_at`
      );

      if (pending.length > 0) {
        console.log(
          `[BOOT] Recovering and processing ${pending.length} unhandled messages from crash window...`
        );

        for (const item of pending) {
          const messagePayload = item.payload;
          if (messagePayload && messagePayload.from) {
            // Telegram turns ("tg:<user>") replay to the linked broker's chat.
            const tgUser = String(messagePayload.from).match(/^tg:(\d+)$/)?.[1];
            const tgBroker = tgUser ? await TgLink.findBroker(pool, tgUser) : null;
            const brokers = tgUser
              ? tgBroker ? [{ ...tgBroker, channel: "telegram" }] : []
              : await findActiveBroker(U.normalizePhone(messagePayload.from));

            if (brokers.length > 0) {
              const broker = brokers[0];
              const ctx = await buildTurnContext(broker);

              executeGuardedTurn(
                broker,
                messagePayload,
                () => dispatchMessage(broker, messagePayload, ctx),
                { pool }
              ).catch((e) => ErrorReports.capture(e, { pool, source: "recovery", broker, msgId: item.msg_id }));
            }
          }
        }
      }
    } catch (err) {
      console.warn("[BOOT] Inbound message recovery skipped:", err.message);
    }
  }

  return { runTurn, handleWebhookBody, findActiveBroker, buildTurnContext, handleInboundMessage, bootRecovery };
}

module.exports = { createTurnPipeline };
