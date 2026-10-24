// server.js — Webhook Ingress, Routing Dispatcher & Render Lifecycle Supervisor
"use strict";

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const WA = require("./lib/whatsapp");
const U = require("./lib/util");
const S = require("./lib/search");
const AI = require("./lib/ai");
const Flyer = require("./lib/flyer");
const Drafts = require("./lib/drafts");
const { executeGuardedTurn, reply, replyButtons } = require("./lib/dispatcher");

// Modular Route Controllers
const { handleCommand } = require("./routes/commands");
const { handleImage, handleAudio } = require("./routes/media");
const { handleDocument } = require("./routes/documents");
const { handleInteractive } = require("./routes/interactive");

// Runtime Configuration
const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";

/**
 * Builds the Express app and message pipeline around an injected pg-compatible pool.
 * Tests pass an in-process Postgres; production passes a real pg.Pool (see bootstrap below).
 */
function createApp({ pool }) {
  // Drain Protocol State (Distributed Multi-Pod Invariant)
  const state = { inFlight: 0, isDraining: false };

  const app = express();

  // Capture raw body for cryptographic HMAC verification
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );

  /**
   * Non-blocking operational telemetry logging helper.
   */
  async function logServerOp(
    poolInstance,
    {
      agency_id = null,
      broker_id = null,
      listing_code = null,
      operation_type,
      status = "success",
      error_code = null,
      total_duration_ms = 0,
      metadata = {}
    }
  ) {
    if (!poolInstance) return;
    try {
      await poolInstance.query(
        `INSERT INTO operation_logs (
        agency_id, broker_id, listing_code, operation_type,
        status, error_code, total_duration_ms, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          agency_id,
          broker_id,
          listing_code,
          operation_type,
          status,
          error_code,
          Math.round(total_duration_ms),
          JSON.stringify(metadata)
        ]
      );
    } catch (e) {
      console.warn("Server telemetry log warning:", e.message);
    }
  }

  /**
   * SEC-01: Cryptographic Webhook HMAC-SHA256 Verification
   */
  function verifyWebhookSignature(req) {
    if (!APP_SECRET) return true; // Bypass in local dev if secret unset
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) return false;

    const expected =
      "sha256=" +
      crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, "utf8"),
        Buffer.from(expected, "utf8")
      );
    } catch {
      return false;
    }
  }

  /**
   * Meta Webhook Verification Endpoint (GET)
   */
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  /**
   * Central Inbound Message Dispatcher
   */
  async function dispatchMessage(broker, message, ctx) {
    const { lang, pool: poolInstance } = ctx;

    switch (message.type) {
      case "interactive":
        return await handleInteractive(broker, message, ctx);

      case "image":
        return await handleImage(broker, message, ctx);

      case "audio":
      case "voice":
        return await handleAudio(broker, message, ctx);

      case "document": {
        const doc = message.document;
        const isImageDoc =
          Boolean(doc) &&
          ((doc.mime_type && doc.mime_type.startsWith("image/")) ||
            /\.(jpe?g|png|webp|heic)$/i.test(doc.filename || ""));

        // ING-01 Adapter: If broker sent an uncompressed photo as a WhatsApp Document,
        // route seamlessly into the image draft ingestion pipeline.
        if (isImageDoc) {
          const adaptedImageMessage = {
            ...message,
            type: "image",
            image: {
              id: doc.id,
              mime_type: doc.mime_type || "image/jpeg",
              caption: doc.caption || message.caption || ""
            }
          };
          return await handleImage(broker, adaptedImageMessage, ctx);
        }

        return await handleDocument(broker, message, ctx);
      }

      case "text": {
        const text = message.text?.body?.trim() || "";

        // 1. Try structured text commands (help, stats, export, sold, delete, price, flyer, plans)
        const handledCommand = await handleCommand(broker, text, ctx);
        if (handledCommand) return "done";

        // 2. COL-01: Check for active draft session collision before invoking search
        const activeDraft = await Drafts.getDraft(
          poolInstance,
          broker.id,
          "draft"
        );

        if (activeDraft) {
          const lower = text.toLowerCase();
          // Strict explicit search intent check (excluding property types so specs aren't mistaken for search queries)
          const hasExplicitSearchIntent =
            /(?:^|\s)(عايز|عاوز|محتاج|ابحث|دورلي|عندك|search|find|looking for|مطلوب)(?=$|\s)/i.test(
              lower
            );

          if (hasExplicitSearchIntent) {
            // Button ids are capped at 128 chars, so the query is kept server-side, not in the id.
            await poolInstance.query(
              `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
               VALUES ($1::uuid, 'pending_search', jsonb_build_object('query', $2::text), NOW() + INTERVAL '15 minutes')
               ON CONFLICT (broker_id, session_type) DO UPDATE SET
                 session_data = EXCLUDED.session_data,
                 expires_at = EXCLUDED.expires_at`,
              [broker.id, text]
            );
            const promptBody =
              lang === "en"
                ? "⚠️ You have an active listing draft in progress. Would you like to discard it and perform your search?"
                : "⚠️ لديك مسودة وحدة قيد الإضافة حالياً. هل تريد إلغاء المسودة والبحث في المخزون بدلاً من ذلك؟";

            await replyButtons(broker, promptBody, [
              {
                id: "cancel_and_search",
                title: lang === "en" ? "Search 🔍" : "إلغاء والبحث 🔍"
              },
              {
                id: "draft_edit",
                title: lang === "en" ? "Keep Draft 📝" : "إكمال المسودة 📝"
              }
            ]);
            return "done";
          }

          // Invariant: Non-search text sent while a draft is active represents unit specifications
          await Drafts.appendText(poolInstance, broker.id, text, "draft");
          const promptBody =
            lang === "en"
              ? "📝 Specifications added to draft. Send remaining details, voice notes, or photos, then type *done* to review."
              : "📝 تم إضافة المواصفات إلى المسودة. أرسل باقي التفاصيل أو الصور أو الفويس نوت، ثم اكتب *«تم»* للمراجعة.";

          await replyButtons(broker, promptBody, [
            {
              id: "draft_confirm",
              title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
            },
            {
              id: "draft_cancel",
              title: lang === "en" ? "Cancel ❌" : "إلغاء ❌"
            }
          ]);
          return "done";
        }

        // 3. Delegate to search & natural language engine
        return await S.handleSearchMessage(broker, text, ctx);
      }

      case "location":
        logServerOp(poolInstance, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "ingress_unsupported_location"
        });
        await reply(
          broker,
          lang === "en"
            ? "⚠️ Location pins are not processed by the bot. Please manually type the compound name, district, or landmark in your draft text or voice note."
            : "⚠️ إرسال اللوكيشن غير مدعوم ولا يتم تسجيله تلقائياً. يرجى كتابة اسم الكمبوند، الحي، أو المنطقة يدوياً في رسالة أو تسجيل صوتي داخل المسودة."
        );
        return "done";

      case "video":
        logServerOp(poolInstance, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "ingress_unsupported_video"
        });
        await reply(
          broker,
          lang === "en"
            ? "🎥 Video uploads are not currently supported. Please send up to 15 photos or an Excel inventory file."
            : "🎥 عذراً، لا ندعم معالجة الفيديو حالياً. يرجى إرسال الصور (بحد أقصى 15 صورة للوحدة) أو ملف إكسيل بالمخزون."
        );
        return "done";

      case "contacts":
        logServerOp(poolInstance, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "ingress_unsupported_contacts"
        });
        await reply(
          broker,
          lang === "en"
            ? "⚠️ Shared contact cards are not processed by the bot. Please manually type the owner's name and contact number into the listing notes."
            : "⚠️ جهات الاتصال المرسلة (Contact Cards) غير مدعومة ولا يتم سحبها تلقائياً. يرجى كتابة اسم ورقم المالك يدوياً نصاً داخل ملاحظات الوحدة."
        );
        return "done";

      default:
        logServerOp(poolInstance, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "ingress_unsupported_default",
          metadata: { messageType: message.type }
        });
        await reply(
          broker,
          lang === "en"
            ? "👋 Welcome! Type *help* to see available commands, or send photos/voice notes to search or add inventory."
            : "👋 أهلاً بك! اكتب *«مساعدة»* لعرض الأوامر، أو أرسل مواصفات طلبك أو صور العقار للبدء فوراً."
        );
        return "done";
    }
  }

  /**
   * Inbound Webhook Ingress (POST)
   */
  app.post("/webhook", async (req, res) => {
    // Graceful Drain: Stop accepting webhooks during pod shutdown (Render multi-pod rollout)
    if (state.isDraining) {
      return res.status(503).send("SERVICE_DRAINING");
    }

    // 1. Authenticate Meta Signature (SEC-01)
    if (!verifyWebhookSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    // Fast acknowledgment to prevent Meta HTTP timeout retries
    res.status(200).send("EVENT_RECEIVED");

    await handleWebhookBody(req.body);
  });

  /**
   * Processes one verified webhook body: dedupe, broker auth, guarded dispatch, status update.
   */
  async function handleWebhookBody(body) {
    // Meta may batch several entries/changes/messages into one POST; process every message in order.
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        for (const message of change?.value?.messages || []) {
          await handleInboundMessage(message);
        }
      }
    }
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
      const { rows: brokers } = await pool.query(
        `SELECT id, agency_id, name, phone_number, phone_normalized, role, preferred_lang, is_active
       FROM brokers
       WHERE phone_normalized = $1 AND is_active = true
       LIMIT 1`,
        [normalizedPhone]
      );

      if (brokers.length === 0) {
        // Reply to an unknown number at most once per 24h (its messages are all recorded above).
        const { rows: recent } = await pool.query(
          `SELECT count(*)::int AS n FROM inbound_messages
           WHERE phone_key = $1 AND received_at > NOW() - INTERVAL '24 hours'`,
          [normalizedPhone]
        );
        if ((recent[0]?.n || 0) <= 1) {
          await WA.sendWhatsAppText(
            normalizedPhone,
            "⚠️ هذا الرقم غير مسجل كوكيل عقاري معتمد في منصة AqarChat. يرجى التواصل مع إدارة وكالتك لتفعيل حسابك.\n" +
              "⚠️ This number is not registered as an AqarChat broker. Please ask your agency admin to activate your account."
          );
        }
        return;
      }

      const broker = brokers[0];
      const lang = broker.preferred_lang || "ar";

      // 4. Assemble Distributed Execution Context (Zero in-memory Maps)
      const ctx = {
        pool,
        lang,
        S,
        AI
      };

      // 5. Execute turn inside the Symmetrical Zero-Silent-Drop boundary
      await executeGuardedTurn(broker, message, () =>
        dispatchMessage(broker, message, ctx)
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
      console.error("Critical webhook processing error:", err);
      if (message.id) {
        await pool
          .query(
            "UPDATE inbound_messages SET status = 'failed', updated_at = NOW() WHERE msg_id = $1",
            [message.id]
          )
          .catch(() => {});
      }
    } finally {
      state.inFlight--;
    }
  }

  /**
   * Render Health Check Probe
   */
  app.get("/health", async (_req, res) => {
    if (state.isDraining) {
      return res.status(503).json({ status: "draining" });
    }

    try {
      await pool.query("SELECT 1");
      res
        .status(200)
        .json({ status: "healthy", timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: "degraded", error: err.message });
    }
  });

  /**
   * SEC-03: Startup Crash Recovery Sweep
   */
  async function bootRecovery() {
    try {
      const { rows: pending } = await pool.query(
        `SELECT msg_id, phone_key, payload
       FROM inbound_messages
       WHERE status = 'new' AND received_at >= NOW() - INTERVAL '15 minutes'
       FOR UPDATE SKIP LOCKED`
      );

      if (pending.length > 0) {
        console.log(
          `[BOOT] Recovering and processing ${pending.length} unhandled messages from crash window...`
        );

        for (const item of pending) {
          await pool.query(
            "UPDATE inbound_messages SET status = 'batched', attempts = attempts + 1, updated_at = NOW() WHERE msg_id = $1",
            [item.msg_id]
          );

          const messagePayload = item.payload;
          if (messagePayload && messagePayload.from) {
            const normPhone = U.normalizePhone(messagePayload.from);
            const { rows: brokers } = await pool.query(
              "SELECT * FROM brokers WHERE phone_normalized = $1 AND is_active = true LIMIT 1",
              [normPhone]
            );

            if (brokers.length > 0) {
              const broker = brokers[0];
              const ctx = {
                pool,
                lang: broker.preferred_lang || "ar",
                S,
                AI
              };

              executeGuardedTurn(broker, messagePayload, () =>
                dispatchMessage(broker, messagePayload, ctx)
              ).catch((e) =>
                console.warn(
                  `[BOOT] Recovery execution failed for ${item.msg_id}:`,
                  e.message
                )
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn("[BOOT] Inbound message recovery skipped:", err.message);
    }
  }

  /**
   * Pre-warms Cairo fonts into process memory
   */
  async function preWarmAssets() {
    try {
      await Promise.all([
        Flyer.loadFont("Cairo-Bold.ttf"),
        Flyer.loadFont("Cairo-Regular.ttf")
      ]);
      console.log("🎨 Cairo typography assets pre-warmed successfully.");
    } catch (err) {
      console.warn("⚠️ Typography pre-warming warning:", err.message);
    }
  }

  return {
    app,
    state,
    handleWebhookBody,
    handleInboundMessage,
    dispatchMessage,
    bootRecovery,
    preWarmAssets
  };
}

/* ====================================================================== */
/* Production bootstrap (skipped when required by tests)                  */
/* ====================================================================== */
function start() {
  // Database Pool (Supabase Transaction & Session Pool)
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  const { app, state, bootRecovery, preWarmAssets } = createApp({ pool });

  // Start Server & Bind Port Immediately for Render Health Probes
  const server = app.listen(PORT, () => {
    console.log(
      `🚀 AqarChat Engine live on port ${PORT} (Node.js ${process.version})`
    );
    preWarmAssets();
    bootRecovery();
  });

  /**
   * Render Graceful Termination & Drain Protocol (25-second window)
   */
  async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Initiating Render drain protocol...`);
    state.isDraining = true;

    server.close(() => {
      console.log("HTTP server closed to new connections.");
    });

    const drainTimeout = setTimeout(async () => {
      console.warn(
        `Drain window elapsed with ${state.inFlight} tasks remaining. Forcing pool shutdown...`
      );
      await pool.end().catch(() => {});
      process.exit(1);
    }, 25000);

    const checkDrain = setInterval(async () => {
      if (state.inFlight === 0) {
        clearInterval(checkDrain);
        clearTimeout(drainTimeout);
        console.log(
          "All in-flight turns completed. Closing PostgreSQL pool..."
        );
        await pool.end().catch(() => {});
        console.log("Graceful shutdown complete.");
        process.exit(0);
      }
    }, 250);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

if (require.main === module) {
  start();
}

module.exports = { createApp };
