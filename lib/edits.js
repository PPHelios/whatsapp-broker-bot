// lib/edits.js — Quick updates (sold, archive, available, price) and staged edits of a saved unit
// Every change goes through applyListingPatch (optimistic lock) and sets confirmed_at.
"use strict";

const L = require("./listing");
const T = require("./text");
const Store = require("./listingStore");
const Authz = require("./authz");
const { t } = require("./copy");
const { BUTTONS, cardButtons } = require("./buttons");
const Rules = require("../domain/fieldRules");
const Describe = require("../domain/describe");
const { normalizeCode } = require("../domain/searchQuery");

const STATUS_FOR = { sold: "sold", archive: "archived", available: "active" };
const STATUS_COPY = { sold: "status_sold", archived: "status_archived", active: "status_active" };
const EDIT_TTL = "30 minutes";

function dispatcher() {
  return require("./dispatcher");
}

function logOp(pool, broker, operation_type, listing_code, metadata = {}) {
  pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, metadata, created_at)
       VALUES ($1, $2, $3, $4, 'success', $5::jsonb, NOW())`,
      [broker.agency_id, broker.id, listing_code || null, operation_type, JSON.stringify(metadata)]
    )
    .catch((e) => console.warn("Edit telemetry log warning:", e.message));
}

async function rememberListing(pool, brokerId, code) {
  await pool
    .query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1, 'session_context', jsonb_build_object('recent_code', $2::text), NOW() + INTERVAL '1 hour')
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         session_data = jsonb_build_object('recent_code', $2::text),
         expires_at = NOW() + INTERVAL '1 hour'`,
      [brokerId, code]
    )
    .catch(() => {});
}

async function recentCode(pool, brokerId) {
  const { rows } = await pool.query(
    `SELECT session_data->>'recent_code' AS code FROM broker_sessions
     WHERE broker_id = $1 AND session_type = 'session_context' AND expires_at > NOW()`,
    [brokerId]
  );
  return rows[0]?.code || null;
}

/** Runs fn(client) inside a transaction holding the (agency, code) advisory lock. */
async function withCodeLock(pool, agencyId, code, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [String(agencyId), normalizeCode(code)]);
    const out = await fn(client);
    await client.query(out?.rollback ? "ROLLBACK" : "COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Quick update by text, voice or button: { action: sold|archive|available|price, code?, priceText? }.
 * Without a code, the unit the broker looked at last is used.
 */
async function quickUpdate(broker, { action, code = null, priceText = null }, ctx) {
  require("./dispatcher").setTurnAction("quick_update");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = dispatcher();
  const target = code ? normalizeCode(code) : await recentCode(pool, broker.id);
  if (!target) {
    const example = { sold: "بيع VIL-08", archive: "أرشيف VIL-08", available: "متاح VIL-08", price: "سعر VIL-08 9 مليون" }[action];
    await reply(broker, t("need_code", lang, { example: lang === "en" ? example.replace(/^\S+/, action) : example }));
    return "done";
  }

  let price = null;
  if (action === "price") {
    const parsed = T.parseEgyptianPrice(T.normalizeDigits(String(priceText || "")));
    price = parsed?.priceValue > 0 ? parsed : null;
    if (!price) {
      await reply(broker, t("price_invalid", lang, { code: target }));
      return "done";
    }
  }

  const out = await withCodeLock(pool, broker.agency_id, target, async (client) => {
    const listing = await Store.findByCode(client, broker.agency_id, target, { forUpdate: true });
    if (!listing) return { rollback: true, msg: t("not_found", lang, { code: target }) };
    if (!Authz.canEdit(broker, listing)) return { rollback: true, msg: t("not_authorized", lang) };
    if (action === "price" && (listing.is_primary_developer || listing.inventory_type === "developer_model")) {
      return { rollback: true, msg: t("price_developer", lang) };
    }
    const patch =
      action === "price"
        ? { price_value: price.priceValue, details: { ...(listing.details || {}), ...(price.currency !== "EGP" ? { currency: price.currency } : {}) } }
        : { status: STATUS_FOR[action] };
    const res = await Store.applyListingPatch(client, broker, { listing, patch });
    if (res.conflict) return { rollback: true, msg: t("edit_conflict", lang, { code: listing.code }) };
    return { listing: res.listing };
  });

  if (!out.listing) {
    await reply(broker, out.msg);
    return "done";
  }
  const l = out.listing;
  await rememberListing(pool, broker.id, l.code);
  logOp(pool, broker, action === "price" ? "listing_price_update" : `listing_status_${l.status}`, l.code);
  if (action === "price") {
    await replyButtons(broker, t("price_updated", lang, { code: l.code, price: Describe.priceLabel(l, lang) }), cardButtons(l, lang));
  } else {
    await reply(broker, t(STATUS_COPY[l.status], lang, { code: l.code }));
  }
  return "done";
}

/* ---------------------------------------------------------------------- */
/* Staged edits                                                             */
/* ---------------------------------------------------------------------- */

async function getEditSession(pool, brokerId) {
  const { rows } = await pool.query(
    "SELECT session_data FROM broker_sessions WHERE broker_id = $1 AND session_type = 'edit' AND expires_at > NOW()",
    [brokerId]
  );
  return rows[0]?.session_data || null;
}

async function saveEditSession(db, brokerId, data) {
  await db.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, 'edit', $2::jsonb, NOW() + INTERVAL '${EDIT_TTL}')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET
       session_data = EXCLUDED.session_data,
       expires_at = EXCLUDED.expires_at`,
    [brokerId, JSON.stringify(data)]
  );
}

/** EDT-01: opens an edit session; instructions given inline ("تعديل CODE السعر 9 مليون") are reviewed at once (A3). */
async function startEdit(broker, code, ctx, { instructions = null } = {}) {
  require("./dispatcher").setTurnAction("edit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = dispatcher();
  const target = code ? normalizeCode(code) : await recentCode(pool, broker.id);
  if (!target) {
    await reply(broker, t("need_code", lang, { example: lang === "en" ? "edit VIL-08" : "تعديل VIL-08" }));
    return "done";
  }
  const listing = await Store.findByCode(pool, broker.agency_id, target);
  if (!listing) {
    await reply(broker, t("not_found", lang, { code: target }));
    return "done";
  }
  if (!Authz.canEdit(broker, listing)) {
    await reply(broker, t("not_authorized", lang));
    return "done";
  }
  await saveEditSession(pool, broker.id, {
    listing_id: listing.id,
    code: listing.code,
    text_notes: instructions ? [instructions] : [],
    voice_buffers: []
  });
  await rememberListing(pool, broker.id, listing.code);
  if (instructions) return reviewEdit(broker, ctx);
  await replyButtons(broker, t("edit_open", lang, { code: listing.code }), [BUTTONS.editReview(lang), BUTTONS.editCancel(lang)]);
  return "done";
}

/** A4: text or voice sent during an edit belongs to the edit (never a search). */
async function appendToEdit(broker, ctx, { text = null, voice = null }) {
  const { pool, lang } = ctx;
  const { replyButtons } = dispatcher();
  const session = await getEditSession(pool, broker.id);
  if (!session) return false;
  if (text) session.text_notes = [...(session.text_notes || []), String(text).trim()];
  if (voice) session.voice_buffers = [...(session.voice_buffers || []), voice];
  delete session.staged;
  await saveEditSession(pool, broker.id, session);
  await replyButtons(broker, t("edit_added", lang), [BUTTONS.editReview(lang), BUTTONS.editCancel(lang)]);
  return true;
}

const LABEL = {
  price_value: ["السعر", "Price"],
  area_value: ["المساحة", "Area"],
  bedrooms: ["الغرف", "Bedrooms"],
  bathrooms: ["الحمامات", "Bathrooms"],
  delivery_year: ["التسليم", "Delivery"],
  is_ready: ["التسليم", "Delivery"],
  feature_keys: ["المميزات", "Features"],
  features_other: ["المميزات", "Features"],
  finishing: ["التشطيب", "Finishing"],
  furnishing: ["الفرش", "Furnishing"],
  floor_level: ["الدور", "Floor"],
  remaining_amount: ["المتبقي", "Remaining"],
  down_payment_value: ["المدفوع", "Paid"],
  installment_value: ["القسط", "Installment"],
  payment_frequency: ["دورية القسط", "Frequency"],
  installments_end: ["آخر قسط", "Last installment"],
  compound: ["الكمبوند", "Compound"],
  listing_type: ["بيع/إيجار", "Sale/rent"],
  property_type: ["النوع", "Type"],
  payment_terms: ["أنظمة السداد", "Payment plans"],
  details: ["التفاصيل", "Details"]
};

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const asDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

/** Changed columns between the stored row and the composed one. */
function diffPatch(listing, composed) {
  const patch = {};
  for (const col of Store.PATCH_COLUMNS) {
    if (!(col in composed)) continue;
    if (!same(asDate(listing[col]), asDate(composed[col]))) patch[col] = composed[col];
  }
  return patch;
}

/** Simple price instructions work even when the AI is down ("السعر بقى 9 مليون"). */
function localPatch(texts) {
  const joined = T.normalizeDigits(texts.join(" "));
  const m = joined.match(/(?:السعر|سعر|price)\s*(?:بقى|بقا|اصبح|أصبح|الى|إلى|to|=|:)?\s*([\d.,]+\s*(?:مليون|ألف|الف|k|m|million)?)/i);
  const p = m ? T.parseEgyptianPrice(m[1]) : null;
  return p?.priceValue > 0 ? { price_value: p.priceValue } : null;
}

/** Extracts the stated changes, composes the new row, applies the field table and stages the edit. */
async function reviewEdit(broker, ctx) {
  require("./dispatcher").setTurnAction("edit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = dispatcher();
  const session = await getEditSession(pool, broker.id);
  if (!session) {
    await reply(broker, t("edit_expired", lang));
    return "done";
  }
  const texts = session.text_notes || [];
  const voice = session.voice_buffers || [];
  if (!texts.length && !voice.length) {
    await replyButtons(broker, t("edit_nothing", lang), [BUTTONS.editCancel(lang)]);
    return "done";
  }
  const { rows } = await pool.query("SELECT * FROM listings WHERE id = $1 AND agency_id = $2", [session.listing_id, broker.agency_id]);
  const listing = rows[0];
  if (!listing) {
    await reply(broker, t("not_found", lang, { code: session.code }));
    return "done";
  }
  return dispatcher().withProgress(broker, t("edit_review_working", lang), () => extractAndReviewEdit(broker, ctx, session, listing));
}

/** The AI read of the edit (local parser as fallback), staged against the listing, then the review card. */
async function extractAndReviewEdit(broker, ctx, session, listing) {
  const { pool, lang } = ctx;
  const { replyButtons } = dispatcher();
  const texts = session.text_notes || [];
  const voice = session.voice_buffers || [];
  let stated;
  try {
    stated = (await L.extractPropertyDetails(ctx.AI, { texts, voice, lang, ctx: { ...ctx, broker } })).fields;
    delete stated.code; // the unit's code is not editable here
  } catch (err) {
    console.warn("Edit extraction failed, trying the local parser:", err.message);
    const local = localPatch(texts);
    if (!local) {
      await replyButtons(
        broker,
        lang === "en" ? "❌ Could not read the changes right now. Try again in a moment." : "❌ تعذر قراءة التعديلات حالياً. حاول تاني بعد قليل.",
        [BUTTONS.editReview(lang), BUTTONS.editCancel(lang)]
      );
      return "done";
    }
    stated = local;
  }

  const composed = L.composeFields({ existing: listing, draft: stated, lang });
  const { count } = (await pool.query("SELECT count(*)::int AS count FROM listing_images WHERE listing_id = $1", [listing.id])).rows[0];
  const ev = Rules.evaluate({ ...listing, ...composed }, { lang, photoCount: count });
  const patch = diffPatch(listing, ev.listing);

  session.staged = { patch, version: listing.version, ok: ev.ok && Object.keys(patch).length > 0 };
  await saveEditSession(pool, broker.id, session);

  const changed = [...new Set(Object.keys(patch).map((c) => (LABEL[c] ? LABEL[c][lang === "en" ? 1 : 0] : null)).filter(Boolean))];
  const head = changed.length
    ? `${lang === "en" ? "✏️ Changes" : "✏️ التعديلات"}: ${changed.join(lang === "en" ? ", " : "، ")}`
    : lang === "en"
    ? "ℹ️ No change found in what you sent."
    : "ℹ️ مفيش تغيير واضح في اللي اتبعت.";
  const card = Describe.reviewCard({ ...ev.listing, code: listing.code }, { warnings: ev.warnings, blockers: ev.blockers, lang });
  const buttons = session.staged.ok ? [BUTTONS.editConfirm(lang), BUTTONS.editCancel(lang)] : [BUTTONS.editCancel(lang)];
  await replyButtons(broker, `${head}\n\n${card}`, buttons);
  return "done";
}

/** Commits the staged edit with the version seen at review (conflict → review again). */
async function confirmEdit(broker, ctx) {
  require("./dispatcher").setTurnAction("edit");
  const { pool, lang } = ctx;
  const { reply, replyButtons } = dispatcher();
  const session = await getEditSession(pool, broker.id);
  if (!session) {
    await reply(broker, t("edit_expired", lang));
    return "done";
  }
  if (!session.staged?.ok) return reviewEdit(broker, ctx);

  const out = await withCodeLock(pool, broker.agency_id, session.code, async (client) => {
    const { rows } = await client.query("SELECT * FROM listings WHERE id = $1 AND agency_id = $2 FOR UPDATE", [session.listing_id, broker.agency_id]);
    if (!rows[0]) return { rollback: true, msg: t("not_found", lang, { code: session.code }) };
    const res = await Store.applyListingPatch(client, broker, {
      listing: rows[0],
      patch: session.staged.patch,
      expectedVersion: session.staged.version
    });
    if (res.forbidden) return { rollback: true, msg: t("not_authorized", lang) };
    if (res.conflict) return { rollback: true, conflict: true };
    await client.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = 'edit'", [broker.id]);
    return { listing: res.listing };
  });

  if (out.conflict) {
    delete session.staged;
    await saveEditSession(pool, broker.id, session);
    await replyButtons(broker, t("edit_conflict", lang, { code: session.code }), [BUTTONS.editReview(lang), BUTTONS.editCancel(lang)]);
    return "done";
  }
  if (!out.listing) {
    await reply(broker, out.msg);
    return "done";
  }
  logOp(pool, broker, "listing_edit", out.listing.code, { columns: Object.keys(session.staged.patch) });
  await replyButtons(broker, `${t("edit_saved", lang)}\n${Describe.brokerCard(out.listing, { lang })}`, cardButtons(out.listing, lang));
  return "done";
}

async function cancelEdit(broker, ctx) {
  await ctx.pool.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = 'edit'", [broker.id]);
  await dispatcher().reply(broker, t("edit_cancelled", ctx.lang));
  return "done";
}

module.exports = {
  quickUpdate,
  startEdit,
  appendToEdit,
  reviewEdit,
  confirmEdit,
  cancelEdit,
  getEditSession,
  diffPatch,
  localPatch,
  recentCode,
  rememberListing,
  withCodeLock,
  FIELD_LABELS: LABEL
};
