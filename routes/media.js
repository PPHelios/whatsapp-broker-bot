// routes/media.js — Photo Ingress (15-Ceiling) & Audio Note Context Routing
"use strict";

const WA = require("../lib/whatsapp");
const Media = require("../lib/media");
const U = require("../lib/util");
const Drafts = require("../lib/drafts");
const Supabase = require("../lib/supabase");
const Edits = require("../lib/edits");
const Registry = require("../lib/registry");
const LeadIntake = require("../lib/leadIntake");
const { reply, replyButtons, allowSilentDrop, setTurnAction } = require("../lib/dispatcher");

// Photo normalization (sharp, in memory) is shared with the web uploads.
const { normalizeImageBuffer } = require("../lib/images");

// Photos being downloaded/uploaded right now, per broker (see waitForPhotos).
const photosInFlight = new Map();

/**
 * Handles incoming WhatsApp photos (ING-01).
 * Adopts silent reaction acknowledgment (Solution 2) to eliminate chat flooding.
 */
async function handleImage(broker, message, ctx) {
  photosInFlight.set(broker.id, (photosInFlight.get(broker.id) || 0) + 1);
  try {
    return await ingestImage(broker, message, ctx);
  } finally {
    const left = (photosInFlight.get(broker.id) || 1) - 1;
    if (left > 0) photosInFlight.set(broker.id, left);
    else photosInFlight.delete(broker.id);
  }
}

/**
 * Waits (up to maxMs) for the broker's photos still downloading or uploading, so a reply that
 * counts the draft's photos counts the whole burst (single instance: an in-memory count is enough).
 */
async function waitForPhotos(brokerId, maxMs = 8000) {
  const until = Date.now() + maxMs;
  while (photosInFlight.get(brokerId) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** One limit warning per draft; the photos dropped after it get no message of their own. */
async function limitReached(broker, ctx) {
  const { pool, lang } = ctx;
  if (!(await Drafts.claimLimitWarning(pool, broker.id, "draft"))) {
    allowSilentDrop("photo_over_limit");
    return "done";
  }
  const warningBody =
    lang === "en"
      ? "⚠️ 15 photos saved (the maximum per listing). Extra photos were not added. Tap below to review or cancel:"
      : "⚠️ تم حفظ 15 صورة (الحد الأقصى للوحدة). الصور الزيادة لم تُضف. اضغط أدناه للمراجعة أو الإلغاء:";

  await replyButtons(broker, warningBody, [
    {
      id: "DRAFT_SAVE",
      title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
    },
    { id: "DRAFT_CANCEL", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
  ]);
  return "done";
}

async function ingestImage(broker, message, ctx) {
  setTurnAction("add_unit");
  const { pool, lang } = ctx;
  const imageObj = message.image;

  if (!imageObj || !imageObj.id) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Image could not be retrieved. Please resend."
        : "⚠️ تعذر استلام الصورة. يرجى إعادة إرسالها."
    );
    return "done";
  }

  // 1. Ensure active draft session exists, creating one if needed atomically
  let draft = await Drafts.getDraft(pool, broker.id, "draft");
  if (!draft) {
    draft = await Drafts.createDraft(
      pool,
      broker.id,
      broker.agency_id,
      broker.phone_normalized || broker.phone_number,
      "draft"
    );
  }

  const currentMediaCount = (draft.media_items || []).length;

  // 2. Enforce 15-photo ceiling (ING-01) with conversational action buttons (Anti-Dead-End)
  if (currentMediaCount >= 15) return await limitReached(broker, ctx);

  // 3. Download from WhatsApp Meta Graph API
  let rawMedia;
  try {
    rawMedia = await Media.download(imageObj.id, imageObj.mime_type || "image/jpeg");
  } catch (err) {
    console.error("Failed to download WhatsApp media:", err);
  }

  if (!rawMedia || !rawMedia.buffer) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Could not download photo from WhatsApp servers. Please try again."
        : "⚠️ تعذر تحميل الصورة من خوادم واتساب. يرجى المحاولة مرة أخرى."
    );
    return "done";
  }

  // 4. In-memory Sharp compression
  let compressedBuffer;
  try {
    compressedBuffer = await normalizeImageBuffer(rawMedia.buffer);
  } catch (err) {
    console.error("Sharp normalization failure:", err);
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Image format error. Please upload standard JPEG or PNG photos."
        : "⚠️ صيغة الصورة غير صالحة. يرجى رفع صور قياسية بصيغة JPG أو PNG."
    );
    return "done";
  }

  // 5. Upload to storage at ingest (the draft keeps only the URL), then append atomically.
  let storedUrl = null;
  try {
    const safeId = String(imageObj.id).replace(/[^A-Za-z0-9_.-]/g, "_");
    storedUrl = await Supabase.uploadListingImage(
      broker.agency_id,
      `drafts/${broker.agency_id}/${broker.id}/${Date.now()}_${safeId}.jpg`,
      compressedBuffer
    );
  } catch (err) {
    console.warn("Photo upload at ingest failed; kept in the draft:", err.message);
  }

  const mediaResult = await Drafts.appendMedia(
    pool,
    broker.id,
    {
      mediaId: imageObj.id,
      buffer: compressedBuffer,
      url: storedUrl,
      mimeType: "image/jpeg"
    },
    "draft"
  );

  // A concurrent burst can pass the pre-check above while the atomic SQL cap drops the photo;
  // the photo was stored only if its mediaId is in the returned draft.
  const stored = (mediaResult.draft?.media_items || []).some(
    (item) => item.mediaId === imageObj.id
  );
  if (!mediaResult.ok || !stored) return await limitReached(broker, ctx);

  // If the broker attached a text caption to the image, preserve it atomically in text_notes
  if (imageObj.caption && typeof imageObj.caption === "string") {
    const cleanCaption = imageObj.caption.trim();
    if (cleanCaption) {
      await Drafts.appendText(pool, broker.id, cleanCaption, "draft");
    }
  }

  // 6. No message per photo (P11: a reaction is billed like a message). The read tick already shows it
  // arrived; the broker's next reply in this draft starts with "📸 N photos received" (Drafts.photoNote).
  allowSilentDrop("photo_received");

  return "done";
}

/**
 * Handles incoming WhatsApp audio / voice notes (ING-02).
 */
async function handleAudio(broker, message, ctx) {
  const { pool, lang, S, AI } = ctx;
  const audioObj = message.audio || message.voice;

  if (!audioObj || !audioObj.id) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Voice note could not be retrieved."
        : "⚠️ تعذر استلام الرسالة الصوتية."
    );
    return "done";
  }

  // 1. Check for active draft or multi-turn edit session in broker_sessions
  const { rows: sessionRows } = await pool.query(
    "SELECT session_type, session_data, expires_at FROM broker_sessions WHERE broker_id = $1",
    [broker.id]
  );

  const activeDraft = sessionRows.find(
    (s) => s.session_type === "draft" && new Date(s.expires_at) > new Date()
  );
  const activeEdit = sessionRows.find(
    (s) => s.session_type === "edit" && new Date(s.expires_at) > new Date()
  );

  // 2. Download audio buffer from WhatsApp
  let audioData;
  try {
    audioData = await Media.download(audioObj.id, audioObj.mime_type || "audio/ogg");
  } catch (err) {
    console.error("Audio download error:", err);
  }

  if (!audioData || !audioData.buffer) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Could not download voice message. Please resend or type your request."
        : "⚠️ تعذر تحميل الرسالة الصوتية من خوادم واتساب. يرجى إعادة إرسالها أو كتابة طلبك."
    );
    return "done";
  }

  // 3. Scenario A: Append to active draft session (ING-02 / ING-03) atomically
  if (activeDraft) {
    const updatedDraft = await Drafts.appendVoice(
      pool,
      broker.id,
      {
        buffer: audioData.buffer,
        mimeType: U.cleanAudioMime(audioData.mimeType || "audio/ogg")
      },
      "draft"
    );

    const recordingCount = (updatedDraft?.voice_buffers || []).length;
    await replyButtons(
      broker,
      lang === "en"
        ? `🎙️ Voice note added to draft (${recordingCount} recordings). Tap below when finished:`
        : `🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة (${recordingCount} تسجيلات). اضغط أدناه عند الانتهاء:`,
      [
        {
          id: "DRAFT_SAVE",
          title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
        },
        { id: "DRAFT_CANCEL", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    );
    return "done";
  }

  // 4. Scenario B: Append to the active edit session (EDT-02, A4)
  if (activeEdit) {
    await Edits.appendToEdit(broker, ctx, {
      voice: {
        mimeType: U.cleanAudioMime(audioData.mimeType || "audio/ogg"),
        base64: audioData.buffer.toString("base64")
      }
    });
    return "done";
  }

  // 5. Scenario C: Voice Search Query (SCH-01)
  // Audio Duration Guard (45 seconds max for search)
  if (audioObj.duration && audioObj.duration > 45) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Search voice note is too long (45 seconds max). Please send a shorter summary or type your criteria."
        : "⚠️ التسجيل الصوتي طويل للبحث السريع (الحد الأقصى 45 ثانية). يرجى إرسال تسجيل مختصر بالمواصفات الأساسية أو كتابة طلبك."
    );
    return "done";
  }

  // One reply per task: the typing indicator covers transcription and search.
  let transcribedText = "";
  try {
    transcribedText = await AI.transcribeAudio(
      audioData.buffer,
      audioData.mimeType,
      ctx
    );
  } catch (err) {
    console.error("Gemini audio transcription error:", err);
  }

  if (!transcribedText || !transcribedText.trim()) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Could not understand the voice audio. Please record in a quiet room or type your query."
        : "⚠️ تعذر فهم التسجيل الصوتي بوضوح. يرجى إعادة التسجيل بصوت واضح أو كتابة طلبك نصياً."
    );
    return "done";
  }

  // «ليد …» spoken, or a lead draft waiting for the client: the same intake as text (lib/leadIntake.js).
  if (await LeadIntake.collectVoice(broker, transcribedText.trim(), ctx)) return "done";
  // Wow 3: a spoken outcome with one of the broker's clients updates the CRM after Confirm.
  if (await LeadIntake.offerUpdate(broker, transcribedText.trim(), ctx)) return "done";

  // Spoken quick updates ("اتباعت VIL-08", "سعر VIL-08 9 مليون") run as commands; the rest is a search.
  if (await Registry.dispatch(broker, transcribedText.trim(), ctx, { voice: true })) return "done";
  return await S.handleSearchMessage(broker, transcribedText.trim(), ctx, { channel: "voice" });
}

module.exports = {
  handleImage,
  handleAudio,
  waitForPhotos
};
