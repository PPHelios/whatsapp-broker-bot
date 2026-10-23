"use strict";

const sharp = require("sharp");
const WA = require("../lib/whatsapp");
const U = require("../lib/util");
const { reply } = require("../lib/dispatcher");

// Constrain Sharp concurrency and memory for Render containers
sharp.concurrency(1);
sharp.cache({ items: 20, memory: 64 });

/**
 * Normalizes an inbound photo buffer using Sharp before staging/storage.
 * Auto-rotates via EXIF, bounds inside 1600x1600, outputs JPEG Q82.
 */
async function normalizeImageBuffer(rawBuffer) {
  return await sharp(rawBuffer)
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();
}

/**
 * Handles incoming WhatsApp photos (ING-01).
 */
async function handleImage(broker, message, ctx) {
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

  // 1. Fetch active draft session from distributed broker_sessions
  const { rows: sessionRows } = await pool.query(
    "SELECT session_data, expires_at FROM broker_sessions WHERE broker_id = $1 AND session_type = 'draft'",
    [broker.id]
  );

  let draftData = { media_items: [], text_notes: [], voice_buffers: [] };
  const hasActiveSession =
    sessionRows.length > 0 && new Date(sessionRows[0].expires_at) > new Date();

  if (hasActiveSession) {
    draftData = sessionRows[0].session_data || draftData;
    if (!Array.isArray(draftData.media_items)) draftData.media_items = [];
  }

  // 2. Enforce 15-photo ceiling (ING-01) with conversational action buttons (Anti-Dead-End)
  if (draftData.media_items.length >= 15) {
    const warningBody =
      lang === "en"
        ? "⚠️ Maximum image limit reached (15 photos per listing). Additional photos were dropped. Tap below to review or cancel:"
        : "⚠️ تم الوصول للحد الأقصى المسموح به (15 صورة) للوحدة. تم تجاهل الصور الزائدة. اضغط أدناه للاعتماد أو الإلغاء:";

    await WA.sendWhatsAppButtons(broker.phone_normalized, warningBody, [
      {
        id: "DRAFT_SAVE",
        title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
      },
      { id: "DRAFT_CANCEL", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
    ]);
    return "done";
  }

  // 3. Download from WhatsApp Meta Graph API
  let rawMedia;
  try {
    rawMedia = await WA.downloadWhatsAppMedia(imageObj.id);
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

  // 5. Stage in draftData (base64 string in session JSONB)
  draftData.media_items.push({
    mimeType: "image/jpeg",
    base64: compressedBuffer.toString("base64")
  });

  const photoCount = draftData.media_items.length;

  // 6. Update session with 15-minute sliding TTL (Strict Schema Compliance: NO updated_at column)
  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1, 'draft', $2, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type)
     DO UPDATE SET
       session_data = EXCLUDED.session_data,
       expires_at = NOW() + INTERVAL '15 minutes'`,
    [broker.id, draftData]
  );

  const promptBody =
    lang === "en"
      ? `📸 Photo received (${photoCount}/15). Send remaining photos, voice notes, or text specs, then type *done* to review.`
      : `📸 تم استلام الصورة (${photoCount}/15). أرسل باقي الصور أو فويس نوت بالمواصفات، ثم اكتب *«تم»* للمراجعة.`;

  await WA.sendWhatsAppButtons(broker.phone_normalized, promptBody, [
    {
      id: "DRAFT_SAVE",
      title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
    },
    { id: "DRAFT_CANCEL", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
  ]);

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
    audioData = await WA.downloadWhatsAppMedia(audioObj.id);
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

  // 3. Scenario A: Append to active draft session (ING-02 / ING-03)
  if (activeDraft) {
    const draftData = activeDraft.session_data || { voice_buffers: [] };
    if (!Array.isArray(draftData.voice_buffers)) draftData.voice_buffers = [];

    draftData.voice_buffers.push({
      mimeType: U.cleanAudioMime(audioData.mimeType || "audio/ogg"),
      base64: audioData.buffer.toString("base64")
    });

    // Strict Schema Compliance: NO updated_at column
    await pool.query(
      `UPDATE broker_sessions
       SET session_data = $1, expires_at = NOW() + INTERVAL '15 minutes'
       WHERE broker_id = $2 AND session_type = 'draft'`,
      [draftData, broker.id]
    );

    await WA.sendWhatsAppButtons(
      broker.phone_normalized,
      lang === "en"
        ? `🎙️ Voice note added to draft (${draftData.voice_buffers.length} recordings). Tap below when finished:`
        : `🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة (${draftData.voice_buffers.length} تسجيلات). اضغط أدناه عند الانتهاء:`,
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

  // 4. Scenario B: Append to active edit session (EDT-02)
  if (activeEdit) {
    const editData = activeEdit.session_data || { voice_buffers: [] };
    if (!Array.isArray(editData.voice_buffers)) editData.voice_buffers = [];

    editData.voice_buffers.push({
      mimeType: U.cleanAudioMime(audioData.mimeType || "audio/ogg"),
      base64: audioData.buffer.toString("base64")
    });

    // Strict Schema Compliance: NO updated_at column
    await pool.query(
      `UPDATE broker_sessions
       SET session_data = $1, expires_at = NOW() + INTERVAL '15 minutes'
       WHERE broker_id = $2 AND session_type = 'edit'`,
      [editData, broker.id]
    );

    await reply(
      broker,
      lang === "en"
        ? "🎙️ Voice edit note received. Send more edits or type *done* to apply."
        : "🎙️ تم استلام ملاحظة التعديل الصوتية. أرسل المزيد أو اكتب *«تم»* للتنفيذ."
    );
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

  await reply(
    broker,
    lang === "en"
      ? "🎙️ Transcribing and searching inventory..."
      : "🎙️ جاري تفريغ الصوت والبحث في المخزون..."
  );

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

  // Delegate transcribed text to the 2-pass search engine
  return await S.handleSearchMessage(broker, transcribedText.trim(), ctx);
}

module.exports = {
  handleImage,
  handleAudio
};
