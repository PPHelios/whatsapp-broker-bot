// lib/leadIntake.js — Leads on WhatsApp (Release 3 step 4): contact cards and bare numbers ("who is calling?"),
// «ليد»/lead intake through one lead_extraction AI call shown as "I understood" before saving, forwarded client
// texts, the lead card with [📞 Called] [📅 Follow-up] [🔄 Stage], undo, and the CRM commands.
// Buttons carry the lead reference (or a server-side nonce), never client data, and every tap reloads the lead
// and checks rights, so an old button still works or says why it can't. One message per turn.
"use strict";

const crypto = require("crypto");
const Intake = require("../domain/leadIntake");
const Update = require("../domain/leadUpdate");
const Card = require("../domain/leadCard");
const Stages = require("../domain/leadStages");
const Phone = require("../domain/phone");
const Leads = require("../services/leads");
const LeadRequests = require("../services/leadRequests");
const Store = require("./listingStore");
const Search = require("../services/search");
const Describe = require("../domain/describe");
const SearchLink = require("../domain/searchLink");
const Links = require("./links");
const { isManager, canEditLead } = require("./authz");
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

/** The units that fit a request now (up to 5) and a link to all of them, under the card (one message). */
function matchLines(filters, matches, lang) {
  if (!matches) return "";
  if (!matches.total) return `\n\n${t("request_none", lang)}`;
  const lines = [t("request_matches", lang, { n: matches.total }), ...matches.rows.map((r, i) => `${i + 1}. ${Describe.searchResult(r, lang)}`)];
  if (matches.total > matches.rows.length) lines.push(t("request_all", lang, { url: Links.searchUrl(SearchLink.encodeFilters(filters)) }));
  return `\n\n${lines.join("\n")}`;
}

/** Shows a lead's card; the lead becomes the open one for «طلب …» (30 minutes). */
async function showCard(broker, lead, ctx, opts = {}) {
  const lang = langOf(ctx);
  await setSession(ctx.pool, broker, "lead_focus", { lead_id: lead.id });
  const body = cardText(lead, lang, { ...opts, broker }) + (opts.matches ? matchLines(opts.requestFilters, opts.matches, lang) : "");
  return replyButtons(broker, body, cardButtons(lead, lang, opts));
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
  let matches = null;
  if (candidate.request) {
    const r = await LeadRequests.saveRequest(ctx.pool, broker, lead.id, candidate.request);
    if (r.ok) ({ lead, matches } = r);
  }
  lead = (await Leads.getLead(ctx.pool, broker, lead.id)) || lead;
  const ref = Card.refLabel(lead.ref);
  const head = res.outcome === "created" ? t("lead_saved", lang, { ref }) : res.claimed ? t("lead_claimed", lang, { ref }) : t("lead_known", lang, { ref });
  const request = candidate.request ? Card.requestSummary(candidate.request, lang) : null;
  return showCard(broker, lead, ctx, { head, request, first: res.outcome === "created", matches, requestFilters: candidate.request });
}

/** Wow 2: the "🔔 Save as client request" button under a search with no results (the filters wait server-side). */
async function requestButton(pool, broker, filters, lang) {
  const nonce = await setPending(pool, broker, { request: { ...filters, code: null }, via: "search" });
  return { id: `ld:reqsave:${nonce}`, title: L(lang, "🔔 احفظه طلب عميل", "🔔 Save as request") };
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
  const clean = String(text || "").trim();
  if (clean && !HELP.test(clean) && (await collectUpdateEdit(broker, clean, ctx))) return true;
  const draft = await getSession(ctx.pool, broker, "lead_draft");
  if (!draft) return false;
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
  const r = Intake.matchRequestCommand(transcript);
  if (r && !(await getSession(ctx.pool, broker, "lead_draft"))) {
    await requestCommand(broker, r, ctx);
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

/**
 * «طلب …» / "request …": a buyer's or tenant's request on the open lead (or «طلب L-0042 …»), parsed like a search
 * (the same AI parse and local fallback), saved (up to 3 per lead), answered with the summary and the units that
 * fit now in one message.
 */
async function requestCommand(broker, { ref = null, rest = "" }, ctx) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  let lead = null;
  if (ref) lead = await Leads.getLead(ctx.pool, broker, ref);
  else {
    const focus = await getSession(ctx.pool, broker, "lead_focus");
    if (focus?.lead_id) lead = await Leads.getLead(ctx.pool, broker, focus.lead_id);
  }
  if (!lead) {
    await reply(broker, ref ? t("lead_gone", lang, { ref: Card.refLabel(ref) }) : t("request_no_lead", lang));
    return "done";
  }
  if (!rest) {
    await reply(broker, t("request_need_text", lang));
    return "done";
  }
  const parsed = await Search.parseRequest(ctx.AI, { text: rest, ctx: { ...ctx, broker } });
  const filters = { ...parsed.parsed.filters, code: null };
  const r = await LeadRequests.saveRequest(ctx.pool, broker, lead.id, filters);
  const label = Card.refLabel(lead.ref);
  if (r.error === "request_empty") await reply(broker, t("request_unclear", lang));
  else if (r.error === "too_many_requests") await reply(broker, t("request_too_many", lang, { ref: label, url: Links.appUrl(`leads/${label}`) }));
  else if (r.error) await reply(broker, t("lead_gone", lang, { ref: label }));
  else {
    await reply(broker, t("request_saved", lang, { ref: label, summary: Card.requestSummary(r.request.filters, lang) }) + matchLines(r.request.filters, r.matches, lang));
    await setSession(ctx.pool, broker, "lead_focus", { lead_id: lead.id });
  }
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
/* The voice CRM update (step 9, wow 3): one lead_update call → Confirm    */
/* ---------------------------------------------------------------------- */

const UPDATE_LEADS = 500;

/** The open leads the broker may work (their own; a manager's: the agency's), most recent first. */
async function workableLeads(pool, broker) {
  const manager = isManager(broker);
  const { rows } = await pool.query(
    `SELECT id, ref, name, stage, agency_id, assigned_broker_id FROM leads
      WHERE agency_id = $1 ${manager ? "" : "AND assigned_broker_id = $2"} AND stage NOT IN ('won', 'lost')
      ORDER BY last_activity_at DESC LIMIT ${UPDATE_LEADS}`,
    manager ? [broker.agency_id] : [broker.agency_id, broker.id]
  );
  return rows;
}

async function focusLead(pool, broker) {
  const f = await getSession(pool, broker, "lead_focus");
  return f?.lead_id ? Leads.getLead(pool, broker, f.lead_id) : null;
}

async function extractUpdate(AI, { text, lang, focusName, ctx }) {
  const fence = crypto.randomBytes(4).toString("hex").toUpperCase();
  const res = await AI.generateWithCascade({
    contents: [{ role: "user", parts: [{ text: Update.buildUpdatePrompt(lang, fence, { now: new Date(), focusName }) }, { text: `===${fence}===\n${text}\n===${fence}===` }] }],
    config: { temperature: 0.1, responseMimeType: "application/json" },
    operationType: "lead_update",
    ctx
  });
  return Update.normalizeUpdate(JSON.parse(String(res.text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()));
}

/** "Which client?": a list of choices (the update waits server-side). */
async function askWhich(broker, choices, update, text, ctx, name = null) {
  const lang = langOf(ctx);
  const nonce = await setPending(ctx.pool, broker, { via: "update", update, text, choices: choices.map((l) => l.id) });
  return replyList(broker, name ? t("update_unknown_name", lang, { name }) : t("update_which", lang), L(lang, "اختار", "Choose"), [
    { title: L(lang, "عملاء", "Clients"), rows: choices.slice(0, Intake.MAX_CHOICES).map((l, i) => ({ id: `ld:upick:${nonce}:${i}`, title: `${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`.slice(0, 24) })) }
  ]);
}

/** Checks the update for this lead, then "I understood" with [✅ Confirm] [✏️ Edit] [❌ Cancel]. Nothing is written. */
async function confirmUpdate(broker, leadKey, update, text, ctx) {
  const lang = langOf(ctx);
  const { pool } = ctx;
  const lead = await Leads.getLead(pool, broker, leadKey);
  if (!lead || !canEditLead(broker, lead)) return reply(broker, t("lead_gone", lang, { ref: lead ? Card.refLabel(lead.ref) : "" }));
  const unit = update.followUp?.unitCode ? await Store.findByCode(pool, broker.agency_id, update.followUp.unitCode) : null;
  const err = Update.checkUpdate(update, { now: new Date(), unit });
  if (err === "nothing") return replyButtons(broker, t("update_nothing", lang, { name: `${Card.displayName(lead, lang)} (${Card.refLabel(lead.ref)})` }), cardButtons(lead, lang));
  if (err) {
    // Asks again: the next message (text or voice) is read together with this one, for the same lead.
    await clearSession(pool, broker, "pending_lead");
    await setSession(pool, broker, "lead_update_edit", { text, lead_id: lead.id });
    return reply(broker, err === "follow_up_past" ? t("update_past", lang, { when: when(Update.followUpAt(update.followUp) || new Date(), lang) }) : t("update_unit_unknown", lang, { code: update.followUp.unitCode }));
  }
  const nonce = await setPending(pool, broker, { via: "update", update, text, leadId: lead.id, listingId: unit?.id || null, unitCode: unit?.code || null });
  return replyButtons(broker, t("update_confirm", lang, { lines: Update.summaryLines(update, lead, lang, { unitCode: unit?.code }) }), [
    { id: `ld:uok:${nonce}`, title: L(lang, "✅ تأكيد", "✅ Confirm") },
    { id: `ld:uedit:${nonce}`, title: L(lang, "✏️ تعديل", "✏️ Edit") },
    { id: `ld:no:${nonce}`, title: L(lang, "❌ إلغاء", "❌ Cancel") }
  ]);
}

/** One lead_update call on the text, then the lead: the one pinned, the name the AI read, or the card opened last. */
async function runUpdate(broker, text, ctx, { pinned = null, named = [], leads = [], focus = null } = {}) {
  const lang = langOf(ctx);
  setTurnAction("crm");
  let u;
  try {
    u = await extractUpdate(ctx.AI, { text, lang, focusName: (pinned || focus)?.name || null, ctx: { ...ctx, broker } });
  } catch (err) {
    console.warn("Lead update extraction failed:", err.message);
    const lead = pinned || (named.length === 1 ? named[0] : null) || focus;
    if (lead) return replyButtons(broker, t("update_ai_down", lang), cardButtons(lead, lang));
    return reply(broker, t("update_ai_down_plain", lang));
  }
  if (pinned) return confirmUpdate(broker, pinned.id, u, text, ctx);
  const byName = u.leadName ? Update.matchName(u.leadName, leads) : named;
  if (byName.length === 1) return confirmUpdate(broker, byName[0].id, u, text, ctx);
  if (byName.length > 1) return askWhich(broker, byName, u, text, ctx);
  if (focus && (!u.leadName || Update.matchName(u.leadName, [focus]).length)) return confirmUpdate(broker, focus.id, u, text, ctx);
  if (!leads.length) return reply(broker, t("update_ai_down_plain", lang));
  return askWhich(broker, leads, u, text, ctx, u.leadName);
}

/**
 * A text or a voice transcript that describes an outcome with one of the broker's clients (a name, an L- reference,
 * or the card opened last) → the update flow. Returns false for anything else (no AI call is made).
 */
async function offerUpdate(broker, text, ctx) {
  const clean = String(text || "").trim();
  if (!Update.looksLikeUpdate(clean)) return false;
  const { pool } = ctx;
  const busy = await pool.query("SELECT 1 FROM broker_sessions WHERE broker_id = $1 AND session_type IN ('draft', 'edit') AND expires_at > NOW() LIMIT 1", [broker.id]);
  if (busy.rows.length) return false;
  const ref = Update.refIn(clean);
  if (ref) {
    const lead = await Leads.getLead(pool, broker, ref);
    if (!lead) {
      if (!(await Leads.refExists(pool, broker, ref))) return false;
      setTurnAction("crm");
      await reply(broker, t("update_not_yours", langOf(ctx), { ref: Card.refLabel(ref) }));
      return true;
    }
    await runUpdate(broker, clean, ctx, { pinned: lead });
    return true;
  }
  const leads = await workableLeads(pool, broker);
  const named = Update.namesIn(clean, leads);
  const focus = named.length ? null : await focusLead(pool, broker);
  if (!named.length && !focus) return false;
  await runUpdate(broker, clean, ctx, { named, leads, focus });
  return true;
}

/** The answer after "send it again" or Edit: read together with the first message, for the same lead. */
async function collectUpdateEdit(broker, clean, ctx) {
  const ed = await getSession(ctx.pool, broker, "lead_update_edit");
  if (!ed) return false;
  await clearSession(ctx.pool, broker, "lead_update_edit");
  if (CANCEL.test(clean) || require("./registry").find(clean, {})) return false;
  const lead = await Leads.getLead(ctx.pool, broker, ed.lead_id);
  if (!lead) {
    setTurnAction("crm");
    await reply(broker, t("lead_gone", langOf(ctx), { ref: "" }));
    return true;
  }
  await runUpdate(broker, `${ed.text}\n${clean}`, ctx, { pinned: lead });
  return true;
}

/** Confirm: applies the update as one set of events; Undo reverts them all. */
async function applyPendingUpdate(broker, p, ctx) {
  const lang = langOf(ctx);
  const { pool } = ctx;
  const u = p.update;
  const at = u.followUp ? Update.followUpAt(u.followUp) : null;
  if (at && at <= new Date()) {
    await setSession(pool, broker, "lead_update_edit", { text: p.text, lead_id: p.leadId });
    return reply(broker, t("update_past", lang, { when: when(at, lang) }));
  }
  const before = await Leads.getLead(pool, broker, p.leadId);
  const r = await Leads.applyUpdate(
    pool,
    broker,
    p.leadId,
    { contacted: u.contacted, stage: u.stage, lostReason: u.lostReason, followUp: at ? { at, kind: u.followUp.kind, listingId: p.listingId } : null, note: u.note, via: "update" },
    {}
  );
  const ref = before ? Card.refLabel(before.ref) : "";
  if (r.error === "not_found" || r.error === "forbidden") return reply(broker, t("lead_gone", lang, { ref }));
  if (r.unchanged) return reply(broker, t("lead_unchanged", lang, { ref }));
  if (r.error) return reply(broker, t("lead_invalid", lang, { why: r.error }));
  const lines = Update.summaryLines(u, before || r.lead, lang, { unitCode: p.unitCode });
  const suggest = r.lead.follow_up_status !== "open" && !Stages.isClosed(r.lead.stage);
  return replyButtons(broker, t(suggest ? "update_done_suggest" : "update_done", lang, { lines }), [
    ...(suggest ? [{ id: `ld:fuset:${ref}:2d`, title: L(lang, "📅 بعد يومين", "📅 In 2 days") }] : []),
    { id: `ld:undoset:${r.eventIds.join("-")}`, title: L(lang, "↩️ تراجع", "↩️ Undo") }
  ]);
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
  if (["save", "ok", "no", "edit", "pick", "read", "search", "force", "reqsave", "uok", "uedit", "upick"].includes(action)) {
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
    } else if (action === "uok") {
      await clearSession(pool, broker, "pending_lead");
      await applyPendingUpdate(broker, p, ctx);
    } else if (action === "uedit") {
      await clearSession(pool, broker, "pending_lead");
      await setSession(pool, broker, "lead_update_edit", { text: p.text, lead_id: p.leadId });
      await reply(broker, t("update_edit_prompt", lang));
    } else if (action === "upick") {
      const leadId = (p.choices || [])[Number(b)];
      await clearSession(pool, broker, "pending_lead");
      if (!leadId) await reply(broker, t("lead_expired", lang));
      else await confirmUpdate(broker, leadId, p.update, p.text, ctx);
    } else if (action === "reqsave") {
      // Wow 2: a search with no results becomes a client's request; the next number completes it.
      await clearSession(pool, broker, "pending_lead");
      const kind = p.request?.listing_type === "rent" ? "tenant" : "buyer";
      await setSession(pool, broker, "lead_draft", { candidate: { name: null, phones: [], kind, request: p.request, source: "WhatsApp" }, texts: [] });
      await reply(broker, t("request_need_phone", lang));
    }
    return true;
  }

  // "🔥 N clients want this unit" → the broker's clients whose requests fit, to send the unit to.
  if (action === "wants") {
    const unit = await Store.findByCode(pool, broker.agency_id, a);
    if (!unit) {
      await reply(broker, t("send_unit_gone", lang, { code: a }));
      return true;
    }
    const w = await LeadRequests.whoWants(pool, broker, unit);
    const others = w.others ? `\n${t("unit_wanted_others", lang, { n: w.others })}` : "";
    if (!w.leads.length) {
      await reply(broker, t("unit_wanted_none", lang, { code: unit.code }) + others);
      return true;
    }
    await replyList(broker, t("unit_wanted_list", lang, { n: w.leads.length, code: unit.code }) + others, L(lang, "اختار عميل", "Pick a client"), [
      {
        title: L(lang, "عملاء", "Clients"),
        rows: w.leads.slice(0, Intake.MAX_CHOICES).map((l) => ({ id: `ld:send:${Card.refLabel(l.ref)}:${unit.code}`, title: `${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`.slice(0, 24) }))
      }
    ]);
    return true;
  }

  if (action === "undoset") {
    const ids = String(a || "").split("-").filter((x) => /^\d+$/.test(x));
    const r = ids.length ? await Leads.undoMany(pool, broker, ids) : { error: "not_found" };
    const ref = r.lead ? Card.refLabel(r.lead.ref) : "";
    if (r.ok) await reply(broker, t("update_undone", lang, { ref }));
    else if (r.conflict) await reply(broker, t("lead_undo_blocked", lang));
    else if (r.error === "undo_expired") await reply(broker, t("lead_undo_expired", lang));
    else if (r.error === "already_undone") await reply(broker, t("lead_unchanged", lang, { ref: ref || "↩️" }));
    else await reply(broker, t("lead_gone", lang, { ref }));
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

  if (action === "send") {
    const unit = await Store.findByCode(pool, broker.agency_id, b);
    const r = unit ? await LeadRequests.sendToClient(pool, broker, lead.id, unit, { lang }) : { error: "unit" };
    if (r.ok) await reply(broker, t("send_to_client", lang, { code: unit.code, who: `${Card.displayName(lead, lang)} (${ref})`, url: r.url }));
    else if (r.error === "unit") await reply(broker, t("send_unit_gone", lang, { code: b || "" }));
    else await reply(broker, t("lead_gone", lang, { ref }));
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
  } else if (action === "fudone") {
    // From a reminder: the follow-up is done; offer the next step (wow 6) unless one was set meanwhile.
    const r = await Leads.completeFollowUp(pool, broker, a);
    if (r.error === "no_open_follow_up") await reply(broker, t("lead_no_follow_up", lang, { ref }));
    else await changeReply(broker, ref, r, ctx, t("lead_follow_up_done", lang, { ref }), r.ok ? [{ id: `ld:fuset:${ref}:2d`, title: L(lang, "📅 بعد يومين", "📅 In 2 days") }] : []);
  } else if (action === "fupost") {
    const r = await Leads.postponeFollowUp(pool, broker, a, { days: 1 });
    if (r.error === "no_open_follow_up") await reply(broker, t("lead_no_follow_up", lang, { ref }));
    else await changeReply(broker, ref, r, ctx, t("lead_follow_up_set", lang, { ref, when: r.lead ? when(r.lead.next_follow_up_at, lang) : "" }));
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
  offerUpdate,
  requestCommand,
  requestButton,
  assignCommand,
  handleButton
};
