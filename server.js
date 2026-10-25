// server.js — Webhook Ingress, Routing Dispatcher & Render Lifecycle Supervisor
"use strict";

const express = require("express");
const crypto = require("crypto");

const { getConfig } = require("./config");
const Db = require("./lib/db");
const { runMigrations } = require("./lib/migrate");

const WA = require("./lib/whatsapp");
const TG = require("./lib/telegram");
const TgLink = require("./lib/tgLink");
const TgIngress = require("./lib/tgIngress");
const U = require("./lib/util");
const S = require("./lib/search");
const AI = require("./lib/ai");
const Flyer = require("./lib/flyer");
const Drafts = require("./lib/drafts");
const Edits = require("./lib/edits");
const { executeGuardedTurn, reply, replyButtons, setTurnNote } = require("./lib/dispatcher");

/** A photo, or a photo sent as a document (routed into the draft like one). */
function isPhotoMessage(message) {
  if (message.type === "image") return true;
  const doc = message.type === "document" ? message.document : null;
  return Boolean(doc) && ((doc.mime_type && doc.mime_type.startsWith("image/")) || /\.(jpe?g|png|webp|heic)$/i.test(doc.filename || ""));
}

// Modular Route Controllers
const { handleCommand } = require("./routes/commands");
const { handleImage, handleAudio, waitForPhotos } = require("./routes/media");
const { handleDocument } = require("./routes/documents");
const { handleInteractive } = require("./routes/interactive");
const LeadIntake = require("./lib/leadIntake");
const DealsWA = require("./lib/deals");
const { mountWeb } = require("./web");
const { createScheduler } = require("./lib/scheduler");
const { buildJobs } = require("./lib/jobs");

/**
 * Builds the Express app and message pipeline around an injected pg-compatible pool.
 * Tests pass an in-process Postgres; production passes the lib/db.js pool (see bootstrap below).
 */
function createApp({ pool, config = getConfig(), jobs }) {
  const APP_SECRET = config.whatsapp.appSecret;
  const VERIFY_TOKEN = config.whatsapp.verifyToken;

  // Drain Protocol State (Distributed Multi-Pod Invariant)
  const state = { inFlight: 0, isDraining: false };

  const app = express();

  // Capture raw body for cryptographic HMAC verification
  app.use(
    express.json({
      limit: config.bodyLimit,
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
    // Fail closed: without a secret nothing is accepted, unless explicitly allowed in local dev.
    if (!APP_SECRET) return config.whatsapp.allowUnsigned;
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
    if (!config.whatsapp.enabled) return res.sendStatus(404);
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  /**
   * Central Inbound Message Dispatcher
   */
  async function dispatchMessage(broker, message, ctx) {
    const { lang, pool: poolInstance } = ctx;

    // P11: photos get no message of their own; the next reply in the draft counts them.
    if (!isPhotoMessage(message)) {
      await waitForPhotos(broker.id);
      const note = await Drafts.photoNote(poolInstance, broker, lang).catch(() => null);
      if (note) setTurnNote(note.text, note.onDelivered);
    }

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

        // 0. An open lead draft takes the next message (the client's text, number or a correction).
        if (await LeadIntake.collect(broker, text, ctx)) return "done";

        // 0a. A deal waiting for its commission takes the next message.
        if (await DealsWA.collect(broker, text, ctx)) return "done";

        // 0b. Wow 3: "كلمت أحمد، عايز يعاين VIL-08 الجمعة الساعة ٥" about one of the broker's clients → Confirm.
        if (await LeadIntake.offerUpdate(broker, text, ctx)) return "done";

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
              id: "DRAFT_SAVE",
              title: lang === "en" ? "Review ✅" : "مراجعة ✅"
            },
            {
              id: "draft_cancel",
              title: lang === "en" ? "Cancel ❌" : "إلغاء ❌"
            }
          ]);
          return "done";
        }

        // 3. A4: inside an edit session, text is part of the edit (never a search).
        if (await Edits.appendToEdit(broker, ctx, { text })) return "done";

        // 4. A client's message (a phone, no unit): "Is this a client?" [Save as client] [Search].
        if (await LeadIntake.offerForward(broker, text, ctx)) return "done";

        // 5. Delegate to search & natural language engine
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
        // Release 3: a contact card is a lead lookup ("who is calling?") or a save offer (no AI).
        return await LeadIntake.handleContacts(broker, message, ctx);

      case "unsupported": {
        // WhatsApp couldn't pass the item on (e.g. code 131051: a view-once or some forwarded media).
        logServerOp(poolInstance, {
          agency_id: broker.agency_id,
          broker_id: broker.id,
          operation_type: "ingress_unsupported_type",
          metadata: { errors: (message.errors || []).map((e) => e?.code).filter(Boolean) }
        });
        const inDraft = Boolean(await Drafts.getDraft(poolInstance, broker.id, "draft"));
        const body = inDraft
          ? lang === "en"
            ? "⚠️ WhatsApp couldn't pass one item to the bot (often a forwarded or view-once photo). It was not added to the draft; please send it again as a normal photo."
            : "⚠️ واتساب لم يرسل أحد العناصر للبوت (غالباً صورة محوّلة أو صورة عرض مرة واحدة). لم تتم إضافتها للمسودة، أرسلها مرة أخرى كصورة عادية."
          : lang === "en"
            ? "⚠️ This message type isn't supported. Type *help* to see what the bot can do."
            : "⚠️ نوع الرسالة غير مدعوم. اكتب *«مساعدة»* لعرض ما يمكن للبوت فعله.";
        await reply(broker, body);
        return "done";
      }

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

    // WhatsApp switched off (WHATSAPP_ENABLED=false): acknowledge so Meta doesn't retry, and do nothing.
    if (!config.whatsapp.enabled) return res.status(200).send("WHATSAPP_DISABLED");

    // 1. Authenticate Meta Signature (SEC-01)
    if (!verifyWebhookSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    // Fast acknowledgment to prevent Meta HTTP timeout retries
    res.status(200).send("EVENT_RECEIVED");

    await handleWebhookBody(req.body);
  });

  // "📤 Send on WhatsApp" from Telegram when the wa.me link is too long for a button: a redirect to the stored link.
  app.get("/go/wa/:token", async (req, res) => {
    const url = await TgLink.waLinkOf(pool, req.params.token);
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
    return url ? res.redirect(302, url) : res.status(404).send("Not found");
  });

  /**
   * Telegram webhook (Release 3T): only Telegram knows the secret_token we gave setWebhook, so a request without the
   * matching header is refused (fail closed: without a configured secret nothing is accepted).
   */
  app.post("/telegram/webhook", async (req, res) => {
    if (state.isDraining) return res.status(503).send("SERVICE_DRAINING");
    const secret = config.telegram.webhookSecret;
    const sent = String(req.get("X-Telegram-Bot-Api-Secret-Token") || "");
    const ok =
      Boolean(secret) &&
      sent.length === secret.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret));
    if (!ok) return res.sendStatus(401);
    res.status(200).send("OK");
    await handleTelegramUpdate(req.body).catch((err) => console.error("Telegram update failed:", err.message));
  });

  const TG_COPY = {
    linkAsk:
      "👋 أهلاً! عشان نوصّل حسابك اضغط «📱 ابعت رقمي» تحت (لازم يكون نفس الرقم المسجل في وكالتك)، أو افتح رابط البداية اللي وصلك من مديرك.\n" +
      "👋 Hi! To link your account, tap \"📱 Share my number\" below (the number your agency registered), or open the start link your manager sent you.",
    shareButton: "📱 ابعت رقمي / Share my number",
    invalid: "⚠️ الرابط ده مش صالح أو اتستخدم قبل كده. اطلب رابط جديد من مديرك، أو اضغط «📱 ابعت رقمي».\n⚠️ This link is invalid or already used. Ask your manager for a new one, or tap \"📱 Share my number\".",
    notOwn: "⚠️ ابعت رقمك إنت من زرار «📱 ابعت رقمي».\n⚠️ Please share your own number with the \"📱 Share my number\" button.",
    unknown: "⚠️ الرقم ده مش متسجل كوسيط في WehdatHub. كلم مدير وكالتك.\n⚠️ This number isn't registered as an WehdatHub broker. Ask your agency admin.",
    linked: (b) => (b.preferred_lang === "en" ? `✅ Linked. Welcome, ${b.name}!` : `✅ تم ربط حسابك. أهلاً يا ${b.name}!`)
  };

  async function tgAskToLink(chatId, text = TG_COPY.linkAsk) {
    await TG.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: { keyboard: [[{ text: TG_COPY.shareButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    }).catch((e) => console.warn("Telegram link prompt failed:", e.message));
  }

  /** Links an unknown Telegram user (start token or own contact); true when the update was about linking. */
  async function tgLink(norm) {
    let res = null;
    if (norm.start) res = await TgLink.linkByToken(pool, norm.start, norm.ids);
    else if (norm.contact) res = await TgLink.linkByContact(pool, norm.contact, norm.ids);
    else {
      await tgAskToLink(norm.ids.chatId);
      return null;
    }
    if (res.broker) {
      await TG.call("sendMessage", { chat_id: norm.ids.chatId, text: TG_COPY.linked(res.broker), reply_markup: { remove_keyboard: true } }).catch(() => {});
      return res.broker;
    }
    await tgAskToLink(norm.ids.chatId, res.error === "not_own" ? TG_COPY.notOwn : res.error === "unknown" ? TG_COPY.unknown : TG_COPY.invalid);
    return null;
  }

  /** One Telegram update: link if needed, then the same guarded turn as WhatsApp, answered on Telegram. */
  async function handleTelegramUpdate(update) {
    const norm = TgIngress.normalize(update);
    if (!norm) return;
    if (norm.callbackId) TG.answerCallback(norm.callbackId).catch(() => {});

    let broker = await TgLink.findBroker(pool, norm.ids.userId);
    let message = norm.message || null;
    if (!broker) {
      broker = await tgLink(norm);
      if (!broker) return;
      message = { id: `tg:${norm.ids.chatId}:start:${Date.now()}`, from: `tg:${norm.ids.userId}`, type: "text", text: { body: broker.preferred_lang === "en" ? "help" : "مساعدة" } };
    } else if (norm.start !== undefined) {
      // /start from a linked broker: the command list.
      message = { id: `tg:${norm.ids.chatId}:start:${Date.now()}`, from: `tg:${norm.ids.userId}`, type: "text", text: { body: broker.preferred_lang === "en" ? "help" : "مساعدة" } };
    } else if (norm.callbackId) {
      const id = await TgLink.decodeCallback(pool, norm.data);
      if (!id) return;
      message = TgIngress.buttonMessage(norm, id);
      // "More" is used once: its button leaves the earlier results (the next page comes as a new message).
      if (norm.messageId && (id === "MORE_SEARCH" || id.startsWith("search_more:"))) {
        TG.call("editMessageReplyMarkup", { chat_id: norm.ids.chatId, message_id: norm.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
    }
    if (!message) return;
    if (String(broker.telegram_chat_id) !== String(norm.ids.chatId)) {
      await pool.query("UPDATE brokers SET telegram_chat_id = $2 WHERE id = $1", [broker.id, norm.ids.chatId]);
    }
    broker = { ...broker, channel: "telegram", telegram_chat_id: norm.ids.chatId };
    TG.sendTyping(norm.ids.chatId).catch(() => {});
    await runTurn(broker, message, `tg:${norm.ids.userId}`);
  }

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
      console.error("Critical turn processing error:", err);
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
              "⚠️ This number is not registered as an WehdatHub broker. Please ask your agency admin to activate your account."
          );
        }
        return;
      }

      const broker = brokers[0];
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

  // Release 2: the broker web app (/app/) and the public pages, after /webhook and /health.
  mountWeb(app, { pool, config });

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

  // Background jobs (follow-ups, match sweeps, retention…): one tick a minute, each job on one instance.
  const scheduler = createScheduler({
    pool,
    jobs: jobs || buildJobs({ pool, config }),
    tickMs: config.scheduler.tickMs,
    enabled: config.scheduler.enabled
  });

  return {
    app,
    state,
    scheduler,
    handleWebhookBody,
    handleTelegramUpdate,
    handleInboundMessage,
    dispatchMessage,
    bootRecovery,
    preWarmAssets
  };
}

/* ====================================================================== */
/* Production bootstrap (skipped when required by tests)                  */
/* ====================================================================== */
async function start() {
  // Fails fast in production when required configuration is missing.
  const config = getConfig();
  const pool = Db.getPool();

  if (config.db.migrateOnBoot) {
    const applied = await runMigrations(pool, { log: (m) => console.log(`[MIGRATE] ${m}`) });
    if (applied.length) console.log(`[MIGRATE] ${applied.length} migration(s) applied`);
  }

  const { app, state, scheduler, bootRecovery, preWarmAssets } = createApp({ pool, config });

  // Start Server & Bind Port Immediately for Render Health Probes
  const server = app.listen(config.port, () => {
    console.log(
      `🚀 WehdatHub Engine live on port ${config.port} (Node.js ${process.version})`
    );
    preWarmAssets();
    bootRecovery();
    require("./lib/tgSetup").setup().catch(() => {});
    // After the port binds, so health probes never wait on it.
    if (scheduler.start()) console.log(`⏱️ Scheduler on (${scheduler.jobs.length} jobs)`);
  });

  /**
   * Render Graceful Termination & Drain Protocol (25-second window)
   */
  async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Initiating Render drain protocol...`);
    state.isDraining = true;
    // The scheduler stops first: no new job starts while the instance drains.
    scheduler.stop().catch(() => {});

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
        await Flyer.stopFlyerWorker().catch(() => {});
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
  start().catch((err) => {
    console.error("Startup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
