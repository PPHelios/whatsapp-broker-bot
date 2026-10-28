// routes/dispatch.js — Central inbound message dispatcher: one broker message (WhatsApp or Telegram) to its handler
// (buttons, commands, photos, voice, documents, lead intake, edits, search). Split out of server.js.
"use strict";

const S = require("../lib/search");
const Drafts = require("../lib/drafts");
const Edits = require("../lib/edits");
const BugReports = require("../lib/bugReports");
const LeadIntake = require("../lib/leadIntake");
const DealsWA = require("../lib/deals");
const { reply, replyButtons, setTurnNote } = require("../lib/dispatcher");
const { handleCommand } = require("./commands");
const { canonicalCommand } = require("../domain/commandWords");
const { handleImage, handleAudio, waitForPhotos } = require("./media");
const { handleDocument } = require("./documents");
const { handleInteractive } = require("./interactive");

/** A photo, or a photo sent as a document (routed into the draft like one). */
function isPhotoMessage(message) {
  if (message.type === "image") return true;
  const doc = message.type === "document" ? message.document : null;
  return Boolean(doc) && ((doc.mime_type && doc.mime_type.startsWith("image/")) || /\.(jpe?g|png|webp|heic)$/i.test(doc.filename || ""));
}

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
      // F4: command words in any common spelling ("اضافه", "الغاء", "اسال …").
      const text = canonicalCommand(message.text?.body?.trim() || "");

      // -1. A bug report: *bug …* / *بلاغ …*, or the description after a bare *bug* (lib/bugReports.js).
      if (await BugReports.handle(broker, text, ctx)) return "done";

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

module.exports = { isPhotoMessage, logServerOp, dispatchMessage };
