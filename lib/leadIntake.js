// lib/leadIntake.js — Leads on WhatsApp (Release 3 step 4): contact cards and bare numbers ("who is calling?"),
// «ليد»/lead intake through one lead_extraction AI call shown as "I understood" before saving, forwarded client
// texts, the lead card with [📞 Called] [📅 Follow-up] [🔄 Stage], undo, and the CRM commands.
// Buttons carry the lead reference (or a server-side nonce), never client data, and every tap reloads the lead
// and checks rights, so an old button still works or says why it can't. One message per turn.
"use strict";

const crypto = require("crypto");
const Intake = require("../domain/leadIntake");
const Card = require("../domain/leadCard");
const Stages = require("../domain/leadStages");
const Phone = require("../domain/phone");
const Leads = require("../services/leads");
const Links = require("./links");
const { isManager } = require("./authz");
const { t } = require("./copy");
const { reply, replyButtons, replyList, setTurnAction } = require("./dispatcher");

const SESSION_MINUTES = 30;
const LIST_MAX = 5;
const LOST_REASONS = {
  price: ["السعر", "Price"],
  elsewhere: ["اشترى من مكان تاني", "Bought elsewhere"],
  not_serious: ["مش جاد", "Not serious"],
  no_answer: ["مش بيرد", "Not answering"],
  other: ["سبب تاني", "Other"]
};
const FOLLOW_UP_CHOICES = { "1d": [1, "بكرة", "Tomorrow"], "2d": [2, "بعد يومين", "In 2 days"], "3d": [3, "بعد 3 أيام", "In 3 days"], "7d": [7, "الأسبوع الجاي", "Next week"] };
const CANCEL = /^(cancel|إلغاء|الغاء|خروج|abort|exit|قفل)$/i;
const HELP = /^(مساعدة|help|اوامر|الأوامر|menu|قائمة)$/i;

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (ctx) => (ctx.lang === "en" ? "en" : "ar");
const when = (d, lang) =>
  new Date(d).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/* ---------------------------------------------------------------------- */
/* Sessions: lead_draft (collects the next message) and pending_lead       */
/* ---------------------------------------------------------------------- */

async function setSession(pool, broker, type, data) {
  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2, $3::jsonb, NOW() + ($4 || ' minutes')::interval)
     ON CONFLICT (broker_id, session_type) DO UPDATE SET session_data = EXCLUDED.session_data, expires_at = EXCLUDED.expires_at`,
    [broker.id, type, JSON.stringify(data), String(SESSION_MINUTES)]
  );
}

async function getSession(pool, broker, type) {
  const { rows } = await pool.query("SELECT session_data FROM broker_sessions WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()", [broker.id, type]);
  return rows[0]?.session_data || null;
}

const clearSession = (pool, broker, type) => pool.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2", [broker.id, type]);

/** A pending lead waits server-side; buttons carry only its nonce. */
async function setPending(pool, broker, pending) {
  const nonce = crypto.randomBytes(4).toString("hex");
  await setSession(pool, broker, "pending_lead", { ...pending, nonce });
  return nonce;
}

async function takePending(pool, broker, nonce) {
  const p = await getSession(pool, broker, "pending_lead");
  return p && p.nonce === nonce ? p : null;
}

/* ---------------------------------------------------------------------- */
/* The card (Q14)                                                          */
/* ---------------------------------------------------------------------- */

function cardButtons(lead, lang, { first = false } = {}) {
  const ref = Card.refLabel(lead.ref);
  const third = first && (lead.kind === "seller" || lead.kind === "landlord")
    ? { id: `ld:unit:${ref}`, title: L(lang, "➕ أضف وحدته", "➕ Add their unit") }
    : { id: `ld:stage:${ref}`, title: L(lang, "🔄 المرحلة", "🔄 Stage") };
  return [{ id: `ld:called:${ref}`, title: L(lang, "📞 كلمته", "📞 Called") }, { id: `ld:fu:${ref}`, title: L(lang, "📅 متابعة", "📅 Follow-up") }, third];
}

/** The card body: details, then the tappable number and a wa.me link with a greeting (reply buttons can't dial). */
function cardText(lead, lang, { head = null, request = null, broker = null } = {}) {
  const lines = head ? [head, ""] : [];
  lines.push(Card.card(lead, { lang, assigneeName: lead.assignee_name && lead.assigned_broker_id !== broker?.id ? lead.assignee_name : null, request }));
  const tel = Phone.telUrl(lead.phone_e164);
  if (tel) lines.push(`☎️ ${tel.replace("tel:", "")}`);
  const greeting = L(lead.lang || lang, `أهلاً${lead.name ? ` ${lead.name}` : ""}، معاك ${broker?.name || ""}`, `Hello${lead.name ? ` ${lead.name}` : ""}, this is ${broker?.name || ""}`).trim();
  const wa = Phone.waMeUrl(lead.phone_e164, greeting);
  if (wa) lines.push(`💬 ${wa}`);
  return lines.join("\n");
}

async function showCard(broker, lead, ctx, opts = {}) {
  const lang = langOf(ctx);
  return replyButtons(broker, cardText(lead, lang, { ...opts, broker }), cardButtons(lead, lang, opts));
}

/* ---------------------------------------------------------------------- */
/* Lookups and offers (no AI)                                              */
/* ---------------------------------------------------------------------- */

/** An existing lead shows its card; a colleague's gets the Q2 copy; a new number gets the save offer. */
async function lookupOrOffer(broker, { name = null, phones }, ctx, via) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  for (const p of phones) {
    const found = await Leads.findByPhone(ctx.pool, broker, p);
    if (found.lead) return showCard(broker, found.lead, ctx);
    if (found.elsewhere) return reply(broker, t("lead_colleague_lookup", lang));
  }
  const nonce = await setPending(ctx.pool, broker, { candidate: { name, phones }, via });
  const who = name ? `${name} (${Phone.displayPhone(phones[0])})` : Phone.displayPhone(phones[0]);
  return replyButtons(broker, t("lead_offer_new", lang, { who }), [
    { id: `ld:save:${nonce}`, title: L(lang, "➕ حفظ كعميل", "➕ Save as client") },
    { id: `ld:no:${nonce}`, title: L(lang, "❌ لأ", "❌ No") }
  ]);
}

/** ING-06 (Release 3): a shared contact card. */
async function handleContacts(broker, message, ctx) {
  const lang = langOf(ctx);
  const [card] = Intake.parseContactCard(message.contacts);
  if (!card || !card.phones.length) {
    setTurnAction("crm");
    await reply(broker, t("lead_bad_phone", lang, { phone: L(lang, "في الكارت", "on the card") }));
    return "done";
  }
  await lookupOrOffer(broker, card, ctx, "contact");
  return "done";
}

/** "Who is calling?": a bare number typed or forwarded. */
async function lookupPhone(broker, text, ctx) {
  await lookupOrOffer(broker, { phones: Intake.findPhones(text) }, ctx, "phone");
  return "done";
}

/** A forwarded or pasted client text with a phone and no unit: "Is this a client?" (the text waits server-side). */
async function offerForward(broker, text, ctx) {
  if (!Intake.looksLikeLead(text)) return false;
  const lang = langOf(ctx);
  setTurnAction("crm");
  const phones = Intake.findPhones(text);
  const nonce = await setPending(ctx.pool, broker, { text, phones, via: "forward" });
  await replyButtons(broker, t("lead_offer_forward", lang, { phone: Phone.displayPhone(phones[0]) }), [
    { id: `ld:read:${nonce}`, title: L(lang, "➕ حفظ كعميل", "➕ Save as client") },
    { id: `ld:search:${nonce}`, title: L(lang, "🔍 بحث", "🔍 Search") }
  ]);
  return true;
}

/* ---------------------------------------------------------------------- */
/* AI intake: one lead_extraction call, then "I understood" → Confirm      */
/* ---------------------------------------------------------------------- */

async function extractLead(AI, { text = "", voice = null, lang = "ar", ctx = {} }) {
  const fence = crypto.randomBytes(4).toString("hex").toUpperCase();
  const parts = [{ text: Intake.buildLeadPrompt(lang, fence) }];
  if (text) parts.push({ text: `===${fence}===\n${text}\n===${fence}===` });
  if (voice) parts.push({ inlineData: { mimeType: voice.mimeType || "audio/ogg", data: voice.base64 } });
  const res = await AI.generateWithCascade({
    contents: [{ role: "user", parts }],
    config: { temperature: 0.1, responseMimeType: "application/json" },
    operationType: "lead_extraction",
    ctx
  });
  return Intake.normalizeLeadExtraction(JSON.parse(String(res.text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
}

function understoodLines(c, lang) {
  const lines = [`👤 ${c.name || L(lang, "(من غير اسم)", "(no name)")}`, `📱 ${c.phones.map((p) => Phone.displayPhone(p)).join(" · ")}`, `🏷️ ${Stages.kindLabel(c.kind || "buyer", lang)}`];
  if (c.request) lines.push(`🔎 ${Card.requestSummary(c.request, lang)}`);
  if (c.source) lines.push(`📍 ${c.source}`);
  if (c.note) lines.push(`📝 ${c.note}`);
  return lines.join("\n");
}

async function askConfirm(broker, candidate, ctx) {
  const lang = langOf(ctx);
  await clearSession(ctx.pool, broker, "lead_draft");
  const nonce = await setPending(ctx.pool, broker, { candidate, via: "ai" });
  return replyButtons(broker, t("lead_understood", lang, { lines: understoodLines(candidate, lang) }), [
    { id: `ld:ok:${nonce}`, title: L(lang, "✅ تأكيد", "✅ Confirm") },
    { id: `ld:edit:${nonce}`, title: L(lang, "✏️ تعديل", "✏️ Edit") },
    { id: `ld:no:${nonce}`, title: L(lang, "❌ إلغاء", "❌ Cancel") }
  ]);
}

/** Phones decide the next step: one → confirm; several → "which one?"; none → "send the number" (kept 30 minutes). */
async function routeCandidate(broker, candidate, ctx, { texts = [] } = {}) {
  const lang = langOf(ctx);
  if (candidate.phones.length > 1) {
    await clearSession(ctx.pool, broker, "lead_draft");
    const nonce = await setPending(ctx.pool, broker, { candidate, via: "ai", choices: candidate.phones });
    return replyList(broker, t("lead_pick_phone", lang, { n: candidate.phones.length }), L(lang, "اختار", "Choose"), [
      {
        title: L(lang, "رقم العميل", "Client's number"),
        rows: candidate.phones.slice(0, Intake.MAX_CHOICES).map((p, i) => ({ id: `ld:pick:${nonce}:${i}`, title: Phone.displayPhone(p).slice(0, 24) }))
      }
    ]);
  }
  if (!candidate.phones.length) {
    await setSession(ctx.pool, broker, "lead_draft", { candidate, texts });
    return reply(broker, t("lead_need_phone", lang, { name: candidate.name || L(lang, "العميل", "the client") }));
  }
  return askConfirm(broker, candidate, ctx);
}

/** Text and/or a voice note about a client → one AI call → the next step. */
async function intake(broker, { text = "", voice = null }, ctx) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  const local = Intake.findPhones(text);
  let ex;
  try {
    ex = await extractLead(ctx.AI, { text, voice, lang, ctx: { ...ctx, broker } });
  } catch (err) {
    console.warn("Lead extraction failed:", err.message);
    if (/QUOTA/.test(err.code || "") && !local.length) return reply(broker, t("lead_ai_quota", lang));
    if (!local.length) {
      await setSession(ctx.pool, broker, "lead_draft", { candidate: { name: null, phones: [] }, texts: [] });
      return reply(broker, t("lead_ai_down_no_phone", lang));
    }
    const nonce = await setPending(ctx.pool, broker, { candidate: { name: null, phones: [local[0]] }, via: "phone" });
    return replyButtons(broker, t("lead_ai_down", lang, { phone: Phone.displayPhone(local[0]) }), [
      { id: `ld:save:${nonce}`, title: L(lang, "💾 احفظ الرقم", "💾 Save the number") },
      { id: `ld:no:${nonce}`, title: L(lang, "❌ إلغاء", "❌ Cancel") }
    ]);
  }
  // Phones the AI read are checked by the one phone rule; numbers written in the text are the fallback.
  const read = ex.phones.map((p) => Phone.toE164(p)).filter(Boolean);
  const phones = [...new Set(read.length ? read : local)];
  if (!phones.length && ex.phones.length) {
    await setSession(ctx.pool, broker, "lead_draft", { candidate: { ...ex, phones: [] }, texts: [text].filter(Boolean) });
    return reply(broker, t("lead_bad_phone", lang, { phone: ex.phones[0] }));
  }
  return routeCandidate(broker, { ...ex, phones }, ctx, { texts: [text].filter(Boolean) });
}

/* ---------------------------------------------------------------------- */
/* Saving                                                                  */
/* ---------------------------------------------------------------------- */

const INVALID = {
  phone_required: ["مفيش رقم", "no number"],
  phone_invalid: ["الرقم مش مظبوط", "the number isn't valid"],
  too_many_phones: ["أكتر من 3 أرقام", "more than 3 numbers"],
  kind: ["نوع العميل مش معروف", "unknown lead type"],
  lawful_basis: ["الأساس القانوني ناقص", "missing lawful basis"],
  assignee: ["الوسيط مش موجود", "unknown broker"]
};

async function save(broker, candidate, ctx, { nonceForForce = null, allowErased = false } = {}) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  const res = await Leads.captureLead(ctx.pool, broker, {
    phones: candidate.phones,
    name: candidate.name,
    kind: candidate.kind || "buyer",
    source: candidate.source || "WhatsApp",
    notes: candidate.note,
    lawfulBasis: "client_request",
    allowErased
  });
  if (res.outcome === "erased_before") {
    return replyButtons(broker, t("lead_erased", lang), [
      { id: `ld:force:${nonceForForce}`, title: L(lang, "💾 احفظه", "💾 Save anyway") },
      { id: `ld:no:${nonceForForce}`, title: L(lang, "❌ إلغاء", "❌ Cancel") }
    ]);
  }
  await clearSession(ctx.pool, broker, "pending_lead");
  if (res.outcome === "colleague") return reply(broker, t("lead_colleague", lang));
  if (res.outcome === "invalid") return reply(broker, t("lead_invalid", lang, { why: (INVALID[res.error] || [res.error, res.error])[lang === "en" ? 1 : 0] }));
  let lead = res.lead;
  if (candidate.request) {
    const r = await Leads.noteRequest(ctx.pool, broker, lead.id, candidate.request);
    if (r.ok) lead = r.lead;
  }
  lead = (await Leads.getLead(ctx.pool, broker, lead.id)) || lead;
  const ref = Card.refLabel(lead.ref);
  const head = res.outcome === "created" ? t("lead_saved", lang, { ref }) : res.claimed ? t("lead_claimed", lang, { ref }) : t("lead_known", lang, { ref });
  const request = candidate.request ? Card.requestSummary(candidate.request, lang) : null;
  return showCard(broker, lead, ctx, { head, request, first: res.outcome === "created" });
}

/* ---------------------------------------------------------------------- */
/* Entry points from the router                                            */
/* ---------------------------------------------------------------------- */

/** «ليد»/lead alone opens a lead draft; with details it runs the intake. */
async function leadCommand(broker, { rest }, ctx) {
  if (!rest) {
    setTurnAction("crm");
    await clearSession(ctx.pool, broker, "pending_lead");
    await setSession(ctx.pool, broker, "lead_draft", { texts: [] });
    await reply(broker, t("lead_draft_open", langOf(ctx)));
    return "done";
  }
  await intake(broker, { text: rest }, ctx);
  return "done";
}

/**
 * The next text while a lead draft is open: the missing number, a correction, or the client's message.
 * Cancel, help and registered commands pass through.
 * @returns {Promise<boolean>} true when handled
 */
async function collect(broker, text, ctx) {
  const draft = await getSession(ctx.pool, broker, "lead_draft");
  if (!draft) return false;
  const clean = String(text || "").trim();
  if (!clean || CANCEL.test(clean) || HELP.test(clean)) return false;
  if (require("./registry").find(clean, { leadDraftOpen: true })) return false;
  if (draft.candidate) {
    const phones = Intake.findPhones(clean);
    if (phones.length) {
      setTurnAction("crm");
      await routeCandidate(broker, { ...draft.candidate, phones }, ctx);
      return true;
    }
    if (!draft.texts?.length) {
      setTurnAction("crm");
      await reply(broker, t("lead_need_phone", langOf(ctx), { name: draft.candidate.name || L(langOf(ctx), "العميل", "the client") }));
      return true;
    }
  }
  await intake(broker, { text: [...(draft.texts || []), clean].join("\n") }, ctx);
  return true;
}

/** A voice note: inside a lead draft, or starting with «ليد»/lead (the transcript). Equals the text intake. */
async function collectVoice(broker, transcript, ctx) {
  const m = Intake.matchLeadCommand(transcript);
  if (m) {
    await leadCommand(broker, m, ctx);
    return true;
  }
  return collect(broker, transcript, ctx);
}

/* ---------------------------------------------------------------------- */
/* Commands                                                                */
/* ---------------------------------------------------------------------- */

async function myLeads(broker, ctx) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  const { rows, more } = await Leads.listLeads(ctx.pool, broker, { limit: LIST_MAX });
  if (!rows.length) return reply(broker, t("lead_my_empty", lang));
  return reply(
    broker,
    t("lead_my_list", lang, {
      n: rows.length + (more ? "+" : ""),
      lines: rows.map((l) => `• ${Card.listLine(l, lang)}`).join("\n"),
      more: more ? L(lang, "\n…", "\n…") : "",
      url: Links.appUrl("leads")
    })
  );
}

async function followUps(broker, ctx) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  const { rows, total } = await Leads.dueFollowUps(ctx.pool, broker, { limit: LIST_MAX });
  const url = Links.appUrl("leads", { overdue: "1" });
  if (!rows.length) return reply(broker, t("lead_follow_ups_empty", lang, { url }));
  return reply(
    broker,
    t("lead_follow_ups_list", lang, {
      n: total,
      lines: rows.map((l) => `• ${when(l.next_follow_up_at, lang)} · ${Card.refLabel(l.ref)} · ${Card.displayName(l, lang)}${l.follow_up_kind === "viewing" ? L(lang, " · معاينة", " · viewing") : ""}`).join("\n"),
      more: total > rows.length ? t("lead_more", lang, { n: total - rows.length }) : "",
      url
    })
  );
}

/** "L-0042": the card. A colleague's lead says so; an unknown reference passes on (it may be a unit code). */
async function openRef(broker, ref, ctx) {
  const lead = await Leads.getLead(ctx.pool, broker, ref);
  if (lead) {
    setTurnAction("crm");
    await showCard(broker, lead, ctx);
    return "done";
  }
  if (!(await Leads.refExists(ctx.pool, broker, ref))) return "pass";
  setTurnAction("crm");
  await reply(broker, t("lead_gone", langOf(ctx), { ref: Card.refLabel(ref) }));
  return "done";
}

async function doAssign(broker, ref, target, ctx) {
  const lang = langOf(ctx);
  const r = await Leads.assignLead(ctx.pool, broker, ref, target.id);
  if (r.error === "forbidden") return reply(broker, t("lead_managers_only", lang));
  if (r.error) return reply(broker, t("lead_gone", lang, { ref: Card.refLabel(ref) }));
  return reply(broker, r.unchanged ? t("lead_unchanged", lang, { ref: Card.refLabel(ref) }) : t("lead_assigned", lang, { ref: Card.refLabel(ref), name: target.name }));
}

/** «حول L-0042 لـ سارة» / "assign L-0042 to Sara" (managers). The assignee hears through the notification centre. */
async function assignCommand(broker, { ref, name }, ctx) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  if (!isManager(broker)) {
    await reply(broker, t("lead_managers_only", lang));
    return "done";
  }
  const { rows } = await ctx.pool.query(
    "SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active AND name ILIKE '%' || $2 || '%' ORDER BY name LIMIT 10",
    [broker.agency_id, name.replace(/[%_\\]/g, (c) => `\\${c}`)]
  );
  if (!rows.length) await reply(broker, t("lead_no_broker", lang, { name }));
  else if (rows.length === 1) await doAssign(broker, ref, rows[0], ctx);
  else {
    await replyList(broker, t("lead_pick_broker", lang), L(lang, "اختار", "Choose"), [
      { title: Card.refLabel(ref), rows: rows.map((b) => ({ id: `ld:asg:${Card.refLabel(ref)}:${b.id}`, title: String(b.name).slice(0, 24) })) }
    ]);
  }
  return "done";
}

/* ---------------------------------------------------------------------- */
/* Buttons (ld:*)                                                          */
/* ---------------------------------------------------------------------- */

const undoButton = (eventId, lang) => ({ id: `ld:undo:${eventId}`, title: L(lang, "↩️ تراجع", "↩️ Undo") });

/** A change's outcome → one message (with Undo when it applied). */
async function changeReply(broker, ref, r, ctx, okText, extra = []) {
  const lang = langOf(ctx);
  if (r.error === "not_found" || r.error === "forbidden") return reply(broker, t("lead_gone", lang, { ref }));
  if (r.conflict) return reply(broker, t("lead_conflict", lang, { ref }));
  if (r.unchanged) return reply(broker, t("lead_unchanged", lang, { ref }));
  if (r.error) return reply(broker, t("lead_invalid", lang, { why: r.error }));
  return replyButtons(broker, okText, [...extra, undoButton(r.eventId, lang)]);
}

async function openUnitDraft(broker, lead, ctx) {
  const lang = langOf(ctx);
  const Drafts = require("./drafts");
  await Drafts.createDraft(ctx.pool, broker.id, broker.agency_id, broker.phone_normalized || broker.phone_number, "draft");
  await ctx.pool.query(
    "UPDATE broker_sessions SET session_data = session_data || jsonb_build_object('prefill', $2::jsonb) WHERE broker_id = $1 AND session_type = 'draft'",
    [broker.id, JSON.stringify({ lead_id: lead.id, details: { owner_name: lead.name || null, owner_phone: Phone.displayPhone(lead.phone_e164) } })]
  );
  return reply(broker, t("lead_unit_draft", lang, { name: Card.displayName(lead, lang) }));
}

/**
 * Every ld:* button. Returns false for other ids.
 */
async function handleButton(broker, id, ctx) {
  if (!String(id).startsWith("ld:")) return false;
  const lang = langOf(ctx);
  const { pool } = ctx;
  setTurnAction("crm");
  const [, action, a, b] = String(id).split(":");

  // Pending (nonce) buttons.
  if (["save", "ok", "no", "edit", "pick", "read", "search", "force"].includes(action)) {
    const p = await takePending(pool, broker, a);
    if (!p) {
      await reply(broker, t("lead_expired", lang));
      return true;
    }
    if (action === "no") {
      await clearSession(pool, broker, "pending_lead");
      await reply(broker, t("lead_cancelled", lang));
    } else if (action === "save" || action === "ok") await save(broker, p.candidate, ctx, { nonceForForce: a });
    else if (action === "force") await save(broker, p.candidate, ctx, { nonceForForce: a, allowErased: true });
    else if (action === "pick") {
      const phone = (p.choices || [])[Number(b)];
      if (!phone) await reply(broker, t("lead_expired", lang));
      else await askConfirm(broker, { ...p.candidate, phones: [phone] }, ctx);
    } else if (action === "edit") {
      await clearSession(pool, broker, "pending_lead");
      await setSession(pool, broker, "lead_draft", { texts: [p.text || understoodLines(p.candidate, "en")] });
      await reply(broker, t("lead_edit_prompt", lang));
    } else if (action === "read") {
      await clearSession(pool, broker, "pending_lead");
      await intake(broker, { text: p.text }, ctx);
    } else if (action === "search") {
      await clearSession(pool, broker, "pending_lead");
      setTurnAction("search");
      await ctx.S.handleSearchMessage(broker, p.text, ctx);
    }
    return true;
  }

  if (action === "undo") {
    const r = await Leads.undo(pool, broker, a);
    const ref = r.lead ? Card.refLabel(r.lead.ref) : "";
    if (r.ok) await reply(broker, t("lead_undone", lang, { ref }));
    else if (r.conflict) await reply(broker, t("lead_undo_blocked", lang));
    else if (r.error === "undo_expired") await reply(broker, t("lead_undo_expired", lang));
    else if (r.error === "already_undone") await reply(broker, t("lead_unchanged", lang, { ref: ref || "↩️" }));
    else await reply(broker, t("lead_gone", lang, { ref: ref || "" }));
    return true;
  }

  // Lead (reference) buttons: reload and check rights on every tap.
  const ref = Card.refLabel(Card.parseRef(a) || 0);
  const lead = await Leads.getLead(pool, broker, a);
  if (!lead && action !== "asg") {
    await reply(broker, t("lead_gone", lang, { ref }));
    return true;
  }

  if (action === "called") {
    const r = await Leads.markContacted(pool, broker, a);
    const suggest = r.ok && r.lead.follow_up_status !== "open";
    await changeReply(
      broker,
      ref,
      r,
      ctx,
      t(suggest ? "lead_contacted_suggest" : "lead_contacted", lang, { ref }),
      suggest ? [{ id: `ld:fuset:${ref}:2d`, title: L(lang, "📅 بعد يومين", "📅 In 2 days") }] : []
    );
  } else if (action === "fu") {
    await replyList(broker, t("lead_follow_up_menu", lang, { ref }), L(lang, "اختار", "Choose"), [
      { title: L(lang, "متابعة", "Follow-up"), rows: Object.entries(FOLLOW_UP_CHOICES).map(([k, v]) => ({ id: `ld:fuset:${ref}:${k}`, title: lang === "en" ? v[2] : v[1] })) }
    ]);
  } else if (action === "fuset") {
    const choice = FOLLOW_UP_CHOICES[b] || FOLLOW_UP_CHOICES["2d"];
    const at = Stages.cairoDayAt(new Date(), choice[0], 10);
    const r = await Leads.setFollowUp(pool, broker, a, { at, kind: "call" });
    await changeReply(broker, ref, r, ctx, t("lead_follow_up_set", lang, { ref, when: when(at, lang) }));
  } else if (action === "stage") {
    await replyList(broker, t("lead_stage_menu", lang, { ref, stage: Stages.stageLabel(lead.stage, lang) }), L(lang, "اختار", "Choose"), [
      { title: L(lang, "المرحلة", "Stage"), rows: Stages.STAGES.filter((s) => s !== lead.stage).map((s) => ({ id: `ld:st:${ref}:${s}`, title: Stages.stageLabel(s, lang) })) }
    ]);
  } else if (action === "st") {
    if (b === "lost") {
      await replyList(broker, t("lead_lost_menu", lang, { ref }), L(lang, "اختار", "Choose"), [
        { title: L(lang, "السبب", "Reason"), rows: Object.entries(LOST_REASONS).map(([k, v]) => ({ id: `ld:lost:${ref}:${k}`, title: v[lang === "en" ? 1 : 0] })) }
      ]);
    } else {
      const r = await Leads.setStage(pool, broker, a, { stage: b });
      await changeReply(broker, ref, r, ctx, t("lead_stage_set", lang, { ref, stage: Stages.stageLabel(b, lang) }));
    }
  } else if (action === "lost") {
    const reason = (LOST_REASONS[b] || LOST_REASONS.other)[lang === "en" ? 1 : 0];
    const r = await Leads.setStage(pool, broker, a, { stage: "lost", lostReason: reason });
    await changeReply(broker, ref, r, ctx, t("lead_stage_set", lang, { ref, stage: `${Stages.stageLabel("lost", lang)} (${reason})` }));
  } else if (action === "unit") {
    await openUnitDraft(broker, lead, ctx);
  } else if (action === "asg") {
    const target = (await pool.query("SELECT id, name FROM brokers WHERE id = $1 AND agency_id = $2", [b, broker.agency_id])).rows[0];
    if (!target) await reply(broker, t("lead_no_broker", lang, { name: "—" }));
    else await doAssign(broker, a, target, ctx);
  } else {
    await reply(broker, t("lead_expired", lang));
  }
  return true;
}

module.exports = {
  extractLead,
  cardButtons,
  cardText,
  handleContacts,
  lookupPhone,
  offerForward,
  leadCommand,
  collect,
  collectVoice,
  myLeads,
  followUps,
  openRef,
  assignCommand,
  handleButton
};
