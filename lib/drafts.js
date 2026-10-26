// lib/drafts.js — Distributed Draft State Machine, Ingress Staging & Atomic Commits
"use strict";

const L = require("./listing");
const Supabase = require("./supabase");
const Store = require("./listingStore");
const Links = require("./links");
const Rules = require("../domain/fieldRules");
const Describe = require("../domain/describe");
const { t } = require("./copy");

const MAX_IMAGES = 15;
const DRAFT_TTL_MS = 15 * 60 * 1000; // 15-minute sliding TTL

/**
 * Retrieves the broker's current active draft from PostgreSQL broker_sessions.
 * Complies strictly with SCHEMA_REFERENCE.sql (table: broker_sessions).
 */
async function getDraft(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return null;

  const res = await pool.query(
    `SELECT session_data, expires_at
     FROM broker_sessions
     WHERE broker_id = $1::uuid AND session_type = $2::text`,
    [brokerId, sessionType]
  );

  const session = res.rows[0];
  if (!session) return null;

  // Lazy TTL Eviction: automatically purge sessions older than 15 minutes
  if (new Date(session.expires_at) <= new Date()) {
    await clearDraft(pool, brokerId, sessionType);
    return null;
  }

  return session.session_data;
}

/**
 * Creates or resets an active session in broker_sessions atomically.
 */
async function createDraft(
  pool,
  brokerId,
  agencyId,
  brokerPhoneNormalized = "",
  sessionType = "draft"
) {
  if (!pool || !brokerId) return null;

  const initialData = {
    broker_id: brokerId,
    agency_id: agencyId,
    broker_phone: brokerPhoneNormalized,
    media_items: [],
    voice_buffers: [],
    text_notes: [],
    custom_code: null,
    staged_review: null,
    created_at: Date.now()
  };

  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, $3::jsonb, NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = EXCLUDED.session_data,
       expires_at = NOW() + INTERVAL '15 minutes'`,
    [brokerId, sessionType, JSON.stringify(initialData)]
  );

  return initialData;
}

/**
 * Permanently removes a draft session from broker_sessions.
 */
async function clearDraft(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return;
  await pool.query(
    `DELETE FROM broker_sessions
     WHERE broker_id = $1::uuid AND session_type = $2::text`,
    [brokerId, sessionType]
  );
}

/**
 * Appends a written specification note atomically using SQL JSONB operators.
 */
async function appendText(pool, brokerId, text, sessionType = "draft") {
  const clean = String(text || "").trim();
  if (!pool || !brokerId || !clean) return null;

  const res = await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, jsonb_build_object('broker_id', $1::text, 'text_notes', jsonb_build_array($3::text), 'media_items', '[]'::jsonb, 'voice_buffers', '[]'::jsonb, 'created_at', extract(epoch from now()) * 1000), NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = jsonb_set(
         broker_sessions.session_data - 'staged_review',
         '{text_notes}',
         COALESCE(broker_sessions.session_data->'text_notes', '[]'::jsonb) || jsonb_build_array($3::text),
         true
       ),
       expires_at = NOW() + INTERVAL '15 minutes'
     RETURNING session_data`,
    [brokerId, sessionType, clean]
  );

  return res.rows[0]?.session_data || null;
}

/**
 * Appends a voice note buffer atomically using SQL JSONB operators.
 */
async function appendVoice(
  pool,
  brokerId,
  { buffer, mimeType = "audio/ogg" },
  sessionType = "draft"
) {
  if (!pool || !brokerId || !buffer) return null;

  const voiceObj = {
    mimeType,
    base64: buffer.toString("base64")
  };

  const res = await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, jsonb_build_object('broker_id', $1::text, 'voice_buffers', jsonb_build_array($3::jsonb), 'media_items', '[]'::jsonb, 'text_notes', '[]'::jsonb, 'created_at', extract(epoch from now()) * 1000), NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = jsonb_set(
         broker_sessions.session_data - 'staged_review',
         '{voice_buffers}',
         COALESCE(broker_sessions.session_data->'voice_buffers', '[]'::jsonb) || jsonb_build_array($3::jsonb),
         true
       ),
       expires_at = NOW() + INTERVAL '15 minutes'
     RETURNING session_data`,
    [brokerId, sessionType, JSON.stringify(voiceObj)]
  );

  return res.rows[0]?.session_data || null;
}

/**
 * The line a broker's next reply in a draft starts with, for photos no reply has mentioned yet (P11:
 * no message per photo). Returns { text, onDelivered } or null; onDelivered marks them mentioned.
 */
async function photoNote(pool, broker, lang = "ar") {
  const draft = await getDraft(pool, broker.id, "draft");
  if (!draft) return null;
  const total = (draft.media_items || []).length;
  const fresh = total - Number(draft.photos_acked || 0);
  if (fresh <= 0) return null;
  return {
    text: t(fresh === 1 ? "photo_received" : "photos_received", lang, { n: fresh }),
    onDelivered: () =>
      pool.query(
        `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{photos_acked}', to_jsonb($2::int), true)
          WHERE broker_id = $1 AND session_type = 'draft'`,
        [broker.id, total]
      )
  };
}

/**
 * True for the first caller only once a draft is at the photo ceiling, so a burst of extra photos
 * gets one limit warning instead of one per dropped photo.
 */
async function claimLimitWarning(pool, brokerId, sessionType = "draft") {
  if (!pool || !brokerId) return false;
  const res = await pool.query(
    `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{limit_warned}', 'true'::jsonb, true)
      WHERE broker_id = $1::uuid AND session_type = $2::text
        AND COALESCE((session_data->>'limit_warned')::boolean, false) = false
      RETURNING broker_id`,
    [brokerId, sessionType]
  );
  return res.rows.length > 0;
}

/**
 * Appends an image atomically, enforcing the 15-photo ceiling (ING-01) with deduplication check.
 */
async function appendMedia(
  pool,
  brokerId,
  { mediaId, buffer, url = null, mimeType = "image/jpeg" },
  sessionType = "draft"
) {
  if (!pool || !brokerId || (!buffer && !url)) {
    return { ok: false, limitReached: false, count: 0 };
  }

  const currentDraft = await getDraft(pool, brokerId, sessionType);
  const mediaItems = currentDraft?.media_items || [];

  if (mediaItems.length >= MAX_IMAGES) {
    return { ok: false, limitReached: true, count: mediaItems.length };
  }

  const exists = mediaItems.some((item) => item.mediaId === mediaId);
  if (exists) {
    return {
      ok: true,
      limitReached: mediaItems.length >= MAX_IMAGES,
      count: mediaItems.length,
      draft: currentDraft
    };
  }

  // Photos are uploaded to storage at ingest; base64 is kept only when that upload failed.
  const mediaObj = url
    ? { mediaId, mimeType, url }
    : { mediaId, mimeType, base64: buffer.toString("base64") };

  const res = await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2::text, jsonb_build_object('broker_id', $1::text, 'media_items', jsonb_build_array($3::jsonb), 'voice_buffers', '[]'::jsonb, 'text_notes', '[]'::jsonb, 'created_at', extract(epoch from now()) * 1000), NOW() + INTERVAL '15 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = CASE
         WHEN jsonb_array_length(COALESCE(broker_sessions.session_data->'media_items', '[]'::jsonb)) >= 15
         THEN broker_sessions.session_data
         ELSE jsonb_set(
           broker_sessions.session_data,
           '{media_items}',
           COALESCE(broker_sessions.session_data->'media_items', '[]'::jsonb) || jsonb_build_array($3::jsonb),
           true
         )
       END,
       expires_at = NOW() + INTERVAL '15 minutes'
     RETURNING session_data`,
    [brokerId, sessionType, JSON.stringify(mediaObj)]
  );

  const updatedDraft = res.rows[0]?.session_data || currentDraft;
  const updatedCount = (updatedDraft.media_items || []).length;

  return {
    ok: true,
    limitReached: updatedCount >= MAX_IMAGES,
    count: updatedCount,
    draft: updatedDraft
  };
}

/**
 * Persists an AI-extracted review draft into staged_review in broker_sessions atomically.
 */
async function stageDraftReview(pool, brokerId, reviewPayload) {
  const res = await pool.query(
    `UPDATE broker_sessions
     SET session_data = jsonb_set(session_data, '{staged_review}', $1::jsonb, true),
         expires_at = NOW() + INTERVAL '15 minutes'
     WHERE broker_id = $2::uuid AND session_type = 'draft'
     RETURNING session_data`,
    [JSON.stringify(reviewPayload), brokerId]
  );

  return res.rows[0]?.session_data || null;
}

/**
 * Retrieves staged review object, verifying sliding TTL.
 */
async function getStagedReview(pool, brokerId) {
  const draft = await getDraft(pool, brokerId, "draft");
  return draft?.staged_review || null;
}

/** Clears a staged review after new input, so only a review of the current inputs can be committed. */
async function invalidateStagedReview(pool, brokerId) {
  await pool.query(
    `UPDATE broker_sessions SET session_data = session_data - 'staged_review'
     WHERE broker_id = $1::uuid AND session_type = 'draft' AND session_data ? 'staged_review'`,
    [brokerId]
  );
}

const draftButtons = (lang, { confirm = true, anyway = false } = {}) =>
  [
    confirm && { id: "draft_confirm", title: anyway ? (lang === "en" ? "Save anyway ✅" : "احفظ برضه ✅") : lang === "en" ? "Confirm & Save ✅" : "تأكيد وحفظ ✅" },
    confirm && { id: "draft_edit", title: lang === "en" ? "Edit ✏️" : "تعديل ✏️" },
    { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
  ].filter(Boolean);

/**
 * DRF-02: runs AI extraction over every input in the draft, applies the field table and stages
 * the result. Replies with the review card (warnings shown only here) or with what is still missing.
 */
async function reviewDraft(broker, ctx) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = require("./dispatcher");
  const draft = await getDraft(pool, broker.id, "draft");
  if (!draft) {
    await reply(
      broker,
      lang === "en"
        ? "⏳ Draft session expired. Send photos or details to start a new listing."
        : "⏳ انتهت صلاحية المسودة. أرسل الصور أو المواصفات لبدء وحدة جديدة."
    );
    return "done";
  }
  // The AI read can take ~20 s (model fallbacks): a "working on it" line first, so the broker doesn't re-tap.
  return require("./dispatcher").withProgress(broker, t("review_working", lang), () => extractAndReview(broker, ctx, draft));
}

/** The AI read of a draft's inputs, then the review card (or the retry message when the AI fails). */
async function extractAndReview(broker, ctx, draft) {
  const { lang } = ctx;
  const { replyButtons } = require("./dispatcher");
  const texts = draft.text_notes || [];
  const voice = draft.voice_buffers || [];
  const t0 = Date.now();
  let extracted;
  try {
    extracted = await L.extractPropertyDetails(ctx.AI, { texts, voice, lang, ctx: { ...ctx, broker } });
  } catch (err) {
    console.error("Draft extraction failed:", err.message);
    await replyButtons(
      broker,
      err.code && /QUOTA/.test(err.code)
        ? lang === "en"
          ? "⛔ The AI limit was reached (today's limit or your plan's monthly allowance). Your draft is kept; try again later or ask a manager to upgrade on the Plan page."
          : "⛔ حد الذكاء الاصطناعي خلص (حد اليوم أو رصيد الباقة الشهري). المسودة محفوظة؛ حاول بعدين أو خلّي المدير يرقّي الباقة من صفحة الباقة."
        : lang === "en"
        ? "❌ Could not read the unit details right now. Your draft is kept; tap Review again in a moment."
        : "❌ تعذر قراءة مواصفات الوحدة حالياً. المسودة محفوظة؛ اضغط مراجعة مرة أخرى بعد قليل.",
      [
        { id: "DRAFT_SAVE", title: lang === "en" ? "Review again 🔄" : "مراجعة تاني 🔄" },
        { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    );
    return "done";
  }

  const composed = L.composeFields({ draft: extracted.fields, lang });
  // A seller lead's "➕ Add their unit": the owner's name and phone are internal details, unless the broker said otherwise.
  for (const [k, v] of Object.entries(draft.prefill?.details || {})) {
    if (v && !composed.details?.[k]) composed.details = { ...(composed.details || {}), [k]: v };
  }
  return await presentReview(broker, ctx, draft, {
    source: composed,
    code: extracted.fields.code || draft.custom_code || null,
    model: extracted.modelUsed,
    t0
  });
}

/**
 * Applies the field table to the composed fields, stages the result and sends the review card.
 * `source` (the composed fields before the rules) is staged too, so answering the installments
 * question re-evaluates without another AI call.
 */
async function presentReview(broker, ctx, draft, { source, code, model, t0 = Date.now() }) {
  const { pool, lang } = ctx;
  const { replyButtons } = require("./dispatcher");
  const texts = draft.text_notes || [];
  const voice = draft.voice_buffers || [];
  const photoCount = (draft.media_items || []).length;
  const answer = draft.installments_answer;
  const input = typeof answer === "boolean" ? { ...source, installments_confirmed: answer } : source;
  const evaluation = Rules.evaluate(input, { lang, photoCount, askInstallments: true });
  delete evaluation.listing.installments_confirmed;
  // P13: a unit that looks like one already listed is flagged on this card (no extra message); Confirm saves anyway.
  const duplicate = evaluation.ok ? await Store.findDuplicate(pool, broker.agency_id, evaluation.listing).catch(() => null) : null;
  // C3: a soft note when it looks like a unit or model of the agency's catalogue (never blocks).
  const catalogue = evaluation.ok && !duplicate ? await Store.findCatalogueMatch(pool, broker.agency_id, evaluation.listing).catch(() => null) : null;

  await stageDraftReview(pool, broker.id, {
    ok: evaluation.ok,
    duplicate,
    fields: evaluation.listing,
    source,
    code,
    warnings: evaluation.warnings,
    blockers: evaluation.blockers,
    inputs: { texts: texts.length, voice: voice.length, photos: photoCount },
    model,
    staged_at: Date.now()
  });

  logDraftOp(pool, broker, {
    operation_type: "draft_review",
    status: evaluation.ok ? "success" : "incomplete",
    total_duration_ms: Date.now() - t0,
    metadata: { blockers: evaluation.blockers.map((b) => b.field), warnings: evaluation.warnings.map((w) => w.field) }
  });

  const card = Describe.reviewCard(
    { ...evaluation.listing, code: code || (lang === "en" ? "(auto)" : "(تلقائي)") },
    { warnings: evaluation.warnings, blockers: evaluation.blockers, photoCount, lang }
  );
  const dupLine = duplicate
    ? `\n\n${t("draft_duplicate", lang, { code: duplicate, url: Links.unitAppUrl(duplicate) })}`
    : catalogue ? `\n\n${t("draft_catalogue", lang, catalogueVars(catalogue, lang))}` : "";
  const question = evaluation.blockers.find((b) => b.field === "installments_question");
  const buttons = question
    ? [
        { id: "draft_inst_yes", title: lang === "en" ? "Yes, installments" : "أيوه، أقساط" },
        { id: "draft_inst_no", title: lang === "en" ? `No, ${Rules.money(question.question.paid, lang)} cash` : `لا، ${Rules.money(question.question.paid, lang)} كاش` },
        { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    : draftButtons(lang, { confirm: evaluation.ok, anyway: Boolean(duplicate) });
  await replyButtons(broker, card + dupLine, buttons);
  return "done";
}

/**
 * The broker's answer to "is the rest paid in installments?" (draft_inst_yes / draft_inst_no): kept on the
 * draft (a later review keeps it) and applied to the staged fields without another AI call.
 */
async function answerInstallments(broker, ctx, yes) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool } = ctx;
  const { rows } = await pool.query(
    `UPDATE broker_sessions SET session_data = jsonb_set(session_data, '{installments_answer}', to_jsonb($2::boolean), true)
      WHERE broker_id = $1::uuid AND session_type = 'draft' AND expires_at > NOW()
      RETURNING session_data`,
    [broker.id, yes]
  );
  const draft = rows[0]?.session_data;
  const staged = draft?.staged_review;
  if (!staged?.source) return reviewDraft(broker, ctx);
  return presentReview(broker, ctx, draft, { source: staged.source, code: staged.code, model: staged.model });
}

/**
 * DRF-03: commits ONLY the staged review. Insert-only: an existing code is never overwritten
 * (23505 → "الكود مستخدم", draft kept). The draft is consumed in the same transaction.
 */
async function commitStagedReview(broker, ctx) {
  require("./dispatcher").setTurnAction("add_unit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = require("./dispatcher");
  const client = await pool.connect();
  let committed = null;
  let outcome = null;
  try {
    await client.query("BEGIN");
    // Atomic consumption: a double tap finds nothing on the second run.
    const { rows } = await client.query(
      `DELETE FROM broker_sessions WHERE broker_id = $1::uuid AND session_type = 'draft' AND expires_at > NOW()
       RETURNING session_data`,
      [broker.id]
    );
    const draft = rows[0]?.session_data;
    const staged = draft?.staged_review;
    if (!draft) outcome = "expired";
    else if (!staged || !staged.ok) outcome = "needs_review";
    if (outcome) {
      await client.query("ROLLBACK");
    } else {
      const res = await insertListing(client, broker, staged, draft, lang);
      if (res.conflict) {
        await client.query("ROLLBACK"); // draft restored
        outcome = "code_taken";
        committed = { code: res.code };
      } else {
        await client.query("COMMIT");
        committed = res.listing;
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (outcome === "expired") {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ This draft was already saved or has expired. Send new details to add a unit."
        : "⚠️ تم حفظ هذه المسودة مسبقاً أو انتهت صلاحيتها. أرسل تفاصيل جديدة لإضافة وحدة."
    );
    return "done";
  }
  if (outcome === "needs_review") return reviewDraft(broker, ctx);
  if (outcome === "code_taken") {
    await replyButtons(
      broker,
      lang === "en"
        ? `⚠️ Code #${committed.code} is already used by another unit in your agency. Send a different code (e.g. "code ${committed.code}-2") and tap Review.`
        : `⚠️ الكود #${committed.code} مستخدم لوحدة أخرى في الوكالة. أرسل كود مختلف (مثال: «كود ${committed.code}-2») ثم اضغط مراجعة.`,
      [
        { id: "DRAFT_SAVE", title: lang === "en" ? "Review 🔄" : "مراجعة 🔄" },
        { id: "draft_cancel", title: lang === "en" ? "Cancel ❌" : "إلغاء ❌" }
      ]
    );
    return "done";
  }

  logDraftOp(pool, broker, { operation_type: "draft_commit", listing_code: committed.code });
  // Wow 1: clients whose requests this unit fits, in the same reply (no extra message). Their button takes Edit's
  // place (Edit stays one message away: «تعديل CODE»).
  const wants = await require("../services/leadRequests").whoWants(pool, broker, committed).catch(() => ({ total: 0 }));
  const wanted = wants.total ? `\n\n${t("unit_wanted", lang, { n: wants.total })}` : "";
  await replyButtons(broker, Describe.savedCard(committed, { lang }) + wanted, [
    { id: `client:${committed.code}`, title: lang === "en" ? "Client Copy 📱" : "نص العميل 📱" },
    { id: `flyer:en:dark:${committed.code}`, title: lang === "en" ? "Flyer 📄" : "الكتالوج 📄" },
    wants.total
      ? { id: `ld:wants:${committed.code}`, title: lang === "en" ? `🔥 ${wants.total} clients` : `🔥 ${wants.total} عملاء` }
      : { id: `edit:${committed.code}`, title: lang === "en" ? "Edit ✏️" : "تعديل ✏️" }
  ]);
  return "done";
}

/**
 * Inserts the staged listing (lib/listingStore.js createListing: insert-only) and its photos.
 * A stated code that exists returns { conflict }; a generated code that collides is regenerated.
 */
async function insertListing(client, broker, staged, draft, lang) {
  const res = await Store.createListing(client, broker, { fields: staged.fields, code: staged.code || null, lang });
  if (res.listing) await attachDraftPhotos(client, broker, res.listing, draft.media_items || []);
  return res;
}

/** Links photos (uploaded to storage at ingest) to the new listing, in arrival order. */
async function attachDraftPhotos(client, broker, listing, mediaItems) {
  for (let i = 0; i < mediaItems.length; i++) {
    const item = mediaItems[i];
    let url = item.url || null;
    if (!url && item.base64) {
      // Fallback for photos whose upload failed at ingest.
      url = await Supabase.uploadListingImage(
        broker.agency_id,
        `listings/${broker.agency_id}/${listing.id}/${Date.now()}_${i}.jpg`,
        Buffer.from(item.base64, "base64")
      );
    }
    if (url) {
      await client.query(
        `INSERT INTO listing_images (listing_id, agency_id, position, url, role)
         VALUES ($1::uuid, $2::uuid, $3::integer, $4::text, NULL)`,
        [listing.id, broker.agency_id, i, url]
      );
    }
  }
}

function logDraftOp(pool, broker, row) {
  pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, total_duration_ms, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
      [
        broker.agency_id,
        broker.id,
        row.listing_code || null,
        row.operation_type,
        row.status || "success",
        Math.round(row.total_duration_ms || 0),
        JSON.stringify(row.metadata || {})
      ]
    )
    .catch((e) => console.warn("Draft telemetry log warning:", e.message));
}

/**
 * Legacy Adapter preserving backward compatibility with tests and older controllers.
 */
async function appendToDraft(pool, broker, { mediaId, buffer, text } = {}) {
  const phone = broker.phone_normalized || broker.phone_number;
  let draft = await getDraft(pool, broker.id, "draft");
  if (!draft) {
    draft = await createDraft(
      pool,
      broker.id,
      broker.agency_id,
      phone,
      "draft"
    );
  }

  if (text) await appendText(pool, broker.id, text, "draft");
  if (buffer) {
    await appendMedia(
      pool,
      broker.id,
      {
        mediaId: mediaId || `img_${Date.now()}`,
        buffer,
        mimeType: "image/jpeg"
      },
      "draft"
    );
  }

  const refreshed = await getDraft(pool, broker.id, "draft");
  return {
    draft: refreshed,
    isNew: false,
    mediaLimitReached: (refreshed?.media_items || []).length >= MAX_IMAGES
  };
}

/** Words for the catalogue soft note: "a model" or "unit <dev code>", the project, the agency code. */
function catalogueVars(c, lang) {
  const what = c.model ? (lang === "en" ? "a model" : "نموذج") : c.dev_code ? (lang === "en" ? `unit ${c.dev_code}` : `الوحدة ${c.dev_code}`) : lang === "en" ? "a unit" : "وحدة";
  return { what, project: c.project || "—", code: c.code };
}

module.exports = {
  getDraft,
  createDraft,
  clearDraft,
  appendText,
  photoNote,
  claimLimitWarning,
  appendVoice,
  appendMedia,
  stageDraftReview,
  getStagedReview,
  invalidateStagedReview,
  reviewDraft,
  answerInstallments,
  commitStagedReview,
  // Contract name kept: the only commit path is the staged review.
  commitDraftToDatabase: (broker, _draft, ctx) => commitStagedReview(broker, ctx),
  commitDraftToListing: (broker, _draft, ctx) => commitStagedReview(broker, ctx),
  appendToDraft,
  MAX_IMAGES,
  DRAFT_TTL_MS
};
