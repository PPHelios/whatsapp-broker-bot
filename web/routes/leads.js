// web/routes/leads.js — The CRM on the web (Release 3 step 5): the leads list (tabs, search, filters,
// managers' pipeline), adding a lead (fill from a message or a voice note, the duplicate notice before saving),
// the lead page (real Call and WhatsApp, stage, follow-up, note, assign, timeline) and the web share target.
// Every write goes through services/leads.js with the version the page was opened at: a change made meanwhile
// (on WhatsApp or another tab) is a 409, never an overwrite.
"use strict";

const Leads = require("../../services/leads");
const FollowUpDrafts = require("../../services/followUpDrafts");
const LeadMerge = require("../../services/leadMerge");
const LeadRequests = require("../../services/leadRequests");
const Privacy = require("../../services/privacy");
const Viewings = require("../../services/viewings");
const AI = require("../../lib/ai");
const RateLimit = require("../../lib/rateLimit");
const Store = require("../../lib/listingStore");
const Card = require("../../domain/leadCard");
const Stages = require("../../domain/leadStages");
const Intake = require("../../domain/leadIntake");
const Phone = require("../../domain/phone");
const SearchLink = require("../../domain/searchLink");
const Q = require("../../domain/searchQuery");
const { isManager } = require("../../lib/authz");
const { logOperation } = require("../../lib/db");
const Session = require("../session");
const { uploads, VOICE } = require("../uploads");
const { html } = require("../html");
const V = require("../views/leads");
const { refineForm } = require("../views/searchForm");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const PAGE = 20;
const TABS = ["all", ...Stages.STAGES, "due_today", "overdue", "no_next_step"];
const upload = uploads([VOICE]);

Session.allowMultipart(/^\/leads\/extract$/);

const VIEWING_STATUS = {
  proposed: ["⏳ اتبعتت للعميل، مستنية تأكيده", "⏳ Sent to the client, waiting for confirmation"],
  confirmed: ["✅ العميل أكّد", "✅ The client confirmed"],
  reschedule: ["🔁 العميل عايز ميعاد تاني", "🔁 The client asks for another time"],
  cancelled: ["اتلغت (اتعمل ميعاد أحدث)", "Replaced by a newer viewing"]
};

/** The lead's viewing: its status and the client's answer, calendar links, and the form that sends a (new) one. */
function viewingSection({ lead, viewing: v, unit, path, hidden, lang }) {
  const open = v && Viewings.OPEN.includes(v.status);
  const entry = open ? Viewings.calendarEntry(v, { lang, forBroker: true, leadLabel: `${Card.refLabel(lead.ref)} · ${Card.displayName(lead, lang)}` }) : null;
  const at = open && v.status === "reschedule" && v.client_proposed_at ? v.client_proposed_at : open ? v.starts_at : lead.follow_up_kind === "viewing" && lead.follow_up_status === "open" ? lead.next_follow_up_at : null;
  return html`<section class="card stack" id="viewing"><h2>🏠 ${L(lang, "المعاينة", "Viewing")}</h2>
  ${v
    ? html`<div data-viewing-status="${v.status}">
    <p><strong>${Viewings.whenLabel(v.starts_at, lang)}</strong>${v.place ? ` · 📍 ${v.place}` : ""}${v.code ? ` · ${v.code}` : ""}</p>
    <p>${VIEWING_STATUS[v.status][lang === "en" ? 1 : 0]}</p>
    ${v.status === "reschedule" && v.client_proposed_at ? html`<p>${L(lang, "الميعاد اللي اقترحه", "Suggested time")}: <strong>${Viewings.whenLabel(v.client_proposed_at, lang)}</strong></p>` : ""}
    ${v.status === "reschedule" && v.client_note ? html`<p>💬 ${v.client_note}</p>` : ""}
    ${open ? html`<div class="row"><a class="btn secondary" href="${path}/viewing.ics">📆 ${L(lang, "أضف لتقويمي", "Add to my calendar")}</a><a class="btn secondary" href="${Viewings.googleCalendarUrl(entry)}" target="_blank" rel="noopener">Google Calendar</a></div>` : ""}
  </div>`
    : html`<p class="muted">${L(lang, "حدد ميعاد ووحدة ومكان، وهيتفتح واتساب على شات العميل برسالة فيها لينك يأكد منه أو يختار ميعاد تاني.", "Set a time, unit and place; WhatsApp opens on the client's chat with a link to confirm or pick another time.")}</p>`}
  <form method="post" action="${path}/viewing" class="grid">${hidden}
    <label>${L(lang, "إمتى (بتوقيت القاهرة)", "When (Cairo time)")}<input type="datetime-local" name="at" required value="${at ? Stages.toCairoLocal(at) : ""}"></label>
    <label>${L(lang, "كود الوحدة", "Unit code")}<input name="unit" dir="ltr" value="${(open && v.code) || unit?.code || ""}"></label>
    <label>${L(lang, "المكان", "Place")}<input name="place" maxlength="200" value="${(open && v.place) || ""}" placeholder="${L(lang, "مثلاً: بوابة 3، هايد بارك", "e.g. Gate 3, Hyde Park")}"></label>
    <button type="submit">📲 ${v ? L(lang, "ابعت ميعاد جديد للعميل", "Send a new time to the client") : L(lang, "ابعت الميعاد للعميل على واتساب", "Send the time to the client on WhatsApp")}</button>
  </form>
</section>`;
}

async function activeBrokers(pool, agencyId) {
  const { rows } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [agencyId]);
  return rows;
}

/** Form fields → captureLead input. */
function inputOf(body, manager) {
  const source = body.source === "other" ? String(body.source_other || "").trim() : String(body.source || "").trim();
  return {
    phones: [body.phone1, body.phone2, body.phone3].map((p) => String(p || "").trim()).filter(Boolean),
    name: body.name,
    kind: body.kind || "buyer",
    source: source || "Web",
    lawfulBasis: body.lawful_basis,
    notes: body.notes,
    assignTo: manager ? body.assign_to || null : null,
    allowErased: body.allow_erased === "1"
  };
}

/** The duplicate notice for the phones on the form (before saving). */
async function duplicateNotice(pool, broker, body, lang) {
  for (const raw of [body.phone1, body.phone2].filter(Boolean)) {
    const e164 = Phone.toE164(raw);
    if (!e164) return html`<p class="notice bad">⚠️ ${L(lang, `الرقم «${raw}» مش مظبوط.`, `"${raw}" isn't a valid number.`)}</p>`;
    const found = await Leads.findByPhone(pool, broker, e164);
    if (found.lead) {
      return html`<p class="notice">📇 ${L(lang, "الرقم ده متسجل بالفعل:", "This number is already saved:")} <a href="${V.leadPath(found.lead)}">${Card.refLabel(found.lead.ref)} · ${Card.displayName(found.lead, lang)}</a>. ${L(lang, "الحفظ هيضيف للعميل ده.", "Saving adds to that lead.")}</p>`;
    }
    if (found.elsewhere) return html`<p class="notice bad">👥 ${L(lang, "الرقم ده عميل مع زميل. لو حفظت، مديرك هيتبلّغ.", "This number is a colleague's client. If you save, your manager is told.")}</p>`;
    if (await Leads.wasErased(pool, broker, e164)) return html`<p class="notice bad">🔒 ${L(lang, "العميل ده طلب قبل كده إن بياناته تتمسح.", "This client asked earlier for their data to be deleted.")}</p>`;
  }
  return "";
}

function register(web, { pool, page }) {
  const writeGate = async (req, res) => {
    const gate = await RateLimit.hit(pool, `crm_write:broker:${req.session.broker.id}`, RateLimit.LIMITS.crmWriteBroker);
    if (gate.allowed) return true;
    res.set("Retry-After", String(gate.retryAfterSec || 60)).status(429).send("Too many changes; try again in a minute.");
    return false;
  };

  /* ------------------------------------------------------------------ */
  /* The list                                                            */
  /* ------------------------------------------------------------------ */

  web.get("/leads", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const tab = TABS.includes(req.query.tab) ? req.query.tab : req.query.overdue === "1" ? "overdue" : "all";
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const f = {
      q: String(req.query.q || "").slice(0, 80),
      kind: req.query.kind,
      source: req.query.source ? String(req.query.source).slice(0, 60) : null,
      brokerId: manager ? req.query.broker : null,
      stage: Stages.STAGES.includes(tab) ? tab : null,
      dueToday: tab === "due_today",
      overdue: tab === "overdue",
      noNextStep: tab === "no_next_step",
      limit: PAGE,
      offset: n * PAGE
    };
    const { rows, more } = await Leads.listLeads(pool, broker, f);
    const pipe = manager ? await Leads.pipeline(pool, broker) : null;
    const brokers = manager ? await activeBrokers(pool, broker.agency_id) : [];
    const qs = (over) => {
      const p = new URLSearchParams();
      const all = { tab, q: f.q, kind: req.query.kind || "", source: f.source || "", broker: manager ? req.query.broker || "" : "", ...over };
      for (const [k, v] of Object.entries(all)) if (v !== "" && v !== null && v !== undefined && !(k === "tab" && v === "all")) p.set(k, v);
      const s = p.toString();
      return `/app/leads${s ? `?${s}` : ""}`;
    };
    const tabLabel = (t) =>
      t === "all" ? L(lang, "الكل", "All") : t === "due_today" ? L(lang, "النهارده", "Due today") : t === "overdue" ? L(lang, "متأخرة", "Overdue") : t === "no_next_step" ? L(lang, "من غير خطوة", "No next step") : Stages.stageLabel(t, lang);
    return page(req, res, {
      title: L(lang, "العملاء", "Leads"),
      nav: "leads",
      body: html`<h1>👤 ${L(lang, "العملاء", "Leads")}</h1>
${/^L-\d{4,6}$/.test(String(req.query.erased || "")) ? html`<p class="card notice" role="status">🔒 ${L(lang, `العميل ${req.query.erased} اتمسح نهائياً.`, `Client ${req.query.erased} was erased for good.`)}</p>` : ""}
<div class="row"><a class="btn" href="/app/leads/new">➕ ${L(lang, "عميل جديد", "New lead")}</a> <a class="btn secondary" href="/app/leads/import">📥 ${L(lang, "استيراد من ملف", "Import a file")}</a></div>
${pipe
  ? html`<section class="card" id="pipeline"><h2>📊 ${L(lang, "المراحل", "Pipeline")}</h2>
  <ul class="tags">${Stages.STAGES.map((s) => html`<li data-stage="${s}"><a href="${qs({ tab: s, page: "" })}">${Stages.stageLabel(s, lang)}: ${pipe.stages[s]}</a></li>`)}</ul>
  ${pipe.overdue.length
    ? html`<p><strong>${L(lang, "متابعات متأخرة لكل وسيط:", "Overdue follow-ups per broker:")}</strong></p><ul>${pipe.overdue.map(
        (o) => html`<li data-overdue-broker="${o.broker_id || "none"}"><a href="${qs({ tab: "overdue", broker: o.broker_id || "none" })}">${o.name || L(lang, "مش متسلم", "Unassigned")}: ${o.n}</a></li>`
      )}</ul>`
    : ""}
</section>`
  : ""}
<nav class="row card tabs">${TABS.map((t) => html`<a href="${qs({ tab: t, page: "" })}"${t === tab ? html` aria-current="page"` : ""}>${tabLabel(t)}</a>`)}</nav>
<form method="get" action="/app/leads" class="card row">
  <input type="hidden" name="tab" value="${tab}">
  <input name="q" value="${f.q}" placeholder="${L(lang, "اسم، رقم أو L-0042", "Name, phone or L-0042")}">
  <select name="kind"><option value="">${L(lang, "كل الأنواع", "All types")}</option>${Stages.KINDS.map((k) => html`<option value="${k}"${req.query.kind === k ? html` selected` : ""}>${Stages.kindLabel(k, lang)}</option>`)}</select>
  <select name="source"><option value="">${L(lang, "كل المصادر", "All sources")}</option>${Stages.SOURCES.map(([en, ar]) => html`<option value="${en}"${f.source === en ? html` selected` : ""}>${lang === "en" ? en : ar}</option>`)}</select>
  ${manager
    ? html`<select name="broker"><option value="">${L(lang, "كل الوسطاء", "All brokers")}</option><option value="none"${req.query.broker === "none" ? html` selected` : ""}>${L(lang, "مش متسلم", "Unassigned")}</option>${brokers.map((b) => html`<option value="${b.id}"${req.query.broker === b.id ? html` selected` : ""}>${b.name}</option>`)}</select>`
    : ""}
  <button type="submit" class="secondary">🔍 ${L(lang, "بحث", "Search")}</button>
</form>
${rows.length
  ? html`<ol class="results">${rows.map((r) => V.leadRow(r, lang, { manager }))}</ol>
<p class="row">${n > 0 ? html`<a href="${qs({ page: n - 1 })}">${L(lang, "→ السابق", "← Previous")}</a>` : ""} ${more ? html`<a href="${qs({ page: n + 1 })}">${L(lang, "التالي ←", "Next →")}</a>` : ""}</p>`
  : html`<p class="card">${f.q || tab !== "all"
      ? L(lang, "مفيش عملاء بالشروط دي.", "No leads match.")
      : L(lang, "مفيش عملاء لسه: حوّل رسالة عميل للبوت، أو ضيف واحد من هنا.", "No leads yet: forward a client's message to the bot, or add one here.")} <a href="/app/leads/new">➕ ${L(lang, "عميل جديد", "New lead")}</a></p>`}`
    });
  });

  /* ------------------------------------------------------------------ */
  /* Add                                                                 */
  /* ------------------------------------------------------------------ */

  const formPage = async (req, res, opts = {}, status = 200) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const brokers = isManager(broker) ? await activeBrokers(pool, broker.agency_id) : null;
    return page(req, res, { title: L(lang, "عميل جديد", "New lead"), nav: "leads", body: html`<h1>➕ ${L(lang, "عميل جديد", "New lead")}</h1>${V.leadForm({ lang, csrf: req.session.csrf, brokers, ...opts })}` }, status);
  };

  /** Prefill from shared or pasted text: the numbers written in it, no AI. */
  const prefill = (text) => {
    const phones = Intake.findPhones(text);
    return { message: text, phone1: phones[0] ? Phone.displayPhone(phones[0]) : "", phone2: phones[1] ? Phone.displayPhone(phones[1]) : "" };
  };

  web.get("/leads/new", (req, res) => {
    // Wow 2: "🔔 Save as client request" from a search with no results carries the search here.
    const filters = req.query.request ? SearchLink.decodeFilters(String(req.query.request)) : null;
    if (filters && Q.hasAnyFilter({ filters })) {
      const lang = langOf(req);
      return formPage(req, res, {
        values: { request: String(req.query.request), kind: filters.listing_type === "rent" ? "tenant" : "buyer" },
        notice: `🔔 ${L(lang, "الطلب اللي هيتحفظ للعميل:", "The request saved for this client:")} ${Card.requestSummary(filters, lang)}`
      });
    }
    return formPage(req, res, { values: req.query.text ? prefill(String(req.query.text).slice(0, 4000)) : {} });
  });

  // Web share target (Android: "Share to WehdatHub"): the shared text opens the add form, nothing is saved yet.
  web.get("/share", (req, res) => {
    const text = [req.query.title, req.query.text, req.query.url].filter(Boolean).join("\n").slice(0, 4000);
    return formPage(req, res, { values: prefill(text), notice: L(langOf(req), "📥 الرسالة اللي شاركتها. راجع البيانات واحفظ.", "📥 The message you shared. Check the details and save.") });
  });

  web.post("/leads/check", async (req, res) => res.type("html").send(String(await duplicateNotice(pool, req.session.broker, req.body, langOf(req)))));

  // ✨ Fill from the message or a voice note: one lead_extraction call; the form keeps what the AI left empty.
  web.post("/leads/extract", upload, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const brokers = isManager(broker) ? await activeBrokers(pool, broker.agency_id) : null;
    const values = { ...req.body };
    const send = (opts) => res.type("html").send(String(V.leadForm({ lang, csrf: req.session.csrf, brokers, values, ...opts })));
    const text = String(req.body.message || "").trim();
    const voice = ((req.files && req.files.voice) || []).map((f) => ({ base64: f.buffer.toString("base64"), mimeType: f.mimetype.split(";")[0] }))[0] || null;
    if (!text && !voice) return send({ error: L(lang, "الصق رسالة العميل أو سجّل فويس الأول.", "Paste the client's message or record a voice note first.") });
    const gate = await RateLimit.hit(pool, `lead_extract:broker:${broker.id}`, RateLimit.LIMITS.extractBroker);
    if (!gate.allowed) return send({ error: L(lang, "⏳ استخدمت الملء التلقائي كتير. حاول بعد شوية.", "⏳ Too many fills; try again in a few minutes.") });
    try {
      const LeadIntake = require("../../lib/leadIntake");
      const ex = await LeadIntake.extractLead(AI, { text, voice, lang, ctx: { pool, broker } });
      const phones = ex.phones.map((p) => Phone.toE164(p)).filter(Boolean);
      const fallback = phones.length ? phones : Intake.findPhones(text);
      if (ex.name && !values.name) values.name = ex.name;
      fallback.slice(0, 3).forEach((p, i) => {
        if (!values[`phone${i + 1}`]) values[`phone${i + 1}`] = Phone.displayPhone(p);
      });
      if (ex.kind) values.kind = ex.kind;
      if (ex.source && !values.source) {
        const known = Stages.SOURCES.find(([en, ar]) => [en.toLowerCase(), ar].includes(ex.source.toLowerCase()));
        values.source = known ? known[0] : ex.source;
      }
      if (ex.note && !values.notes) values.notes = [ex.note, ex.request ? `🔎 ${Card.requestSummary(ex.request, lang)}` : ""].filter(Boolean).join("\n");
      else if (ex.request && !values.notes) values.notes = `🔎 ${Card.requestSummary(ex.request, lang)}`;
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_lead_extract", metadata: { voice: Boolean(voice), text: Boolean(text) } });
      return send({ notice: L(lang, "✨ اتملت من الرسالة. راجعها قبل الحفظ.", "✨ Filled from the message. Check before saving."), duplicate: await duplicateNotice(pool, broker, values, lang) });
    } catch (err) {
      console.warn("Web lead extraction failed:", err.message);
      return send({ error: L(lang, "⚠️ مش قادر أقرا الرسالة دلوقتي. املأ الخانات بإيدك.", "⚠️ Couldn't read the message right now. Fill the fields in yourself.") });
    }
  });

  web.post("/leads/new", async (req, res) => {
    if (!(await writeGate(req, res))) return;
    const lang = langOf(req);
    const { broker } = req.session;
    const values = { ...req.body };
    const r = await Leads.captureLead(pool, broker, inputOf(req.body, isManager(broker)));
    if ((r.outcome === "created" || r.outcome === "merged") && req.body.request) {
      const filters = SearchLink.decodeFilters(String(req.body.request));
      if (filters) await LeadRequests.saveRequest(pool, broker, r.lead.id, filters);
    }
    if (r.outcome === "created") return res.redirect(303, `${V.leadPath(r.lead)}?saved=1`);
    if (r.outcome === "merged") return res.redirect(303, `${V.leadPath(r.lead)}?known=1`);
    if (r.outcome === "colleague") {
      return formPage(req, res, { values: {}, notice: L(lang, "👥 العميل ده متسجل مع زميل. مديرك اتبلّغ وهو هيقرر.", "👥 This client is already registered with a colleague. Your manager has been told and will decide.") }, 409);
    }
    if (r.outcome === "erased_before") {
      return formPage(req, res, { values, erased: true, error: L(lang, "🔒 العميل ده طلب قبل كده إن بياناته تتمسح. احفظه بس لو هو اللي كلمك تاني (علّم تحت).", "🔒 This client asked earlier for their data to be deleted. Save only if they contacted you again (tick below).") }, 409);
    }
    const why = {
      phone_required: L(lang, "الموبايل مطلوب.", "A phone number is required."),
      phone_invalid: L(lang, "رقم مش مظبوط.", "A phone number isn't valid."),
      too_many_phones: L(lang, "3 أرقام بالكتير.", "At most 3 numbers."),
      lawful_basis: L(lang, "اختار الأساس القانوني.", "Choose the lawful basis."),
      assignee: L(lang, "الوسيط مش موجود.", "Unknown broker."),
      assignee_away: L(lang, "الوسيط ده في إجازة ومش بياخد عملاء جداد.", "This broker is away and takes no new leads."),
      kind: L(lang, "النوع مش معروف.", "Unknown type.")
    }[r.error] || r.error;
    return formPage(req, res, { values, error: `⚠️ ${why}` }, 422);
  });

  /* ------------------------------------------------------------------ */
  /* The lead page                                                       */
  /* ------------------------------------------------------------------ */

  async function leadPage(req, res, lead, { notice = null, status = 200, undoEvent = null, draft = null } = {}) {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const beforeId = /^\d+$/.test(String(req.query.before || "")) ? req.query.before : null;
    const tl = await Leads.timeline(pool, broker, lead.id, { beforeId });
    const requests = await LeadRequests.listRequests(pool, broker, lead);
    for (const r of requests) r.matches = await LeadRequests.currentMatches(pool, broker.agency_id, r.filters, { limit: 3 });
    const brokers = manager ? await activeBrokers(pool, broker.agency_id) : [];
    const viewing = await Viewings.latestFor(pool, broker.agency_id, lead.id);
    const unit = lead.follow_up_listing_id ? (await pool.query("SELECT code FROM listings WHERE id = $1 AND agency_id = $2", [lead.follow_up_listing_id, broker.agency_id])).rows[0] : null;
    const path = V.leadPath(lead);
    const hidden = html`<input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="version" value="${lead.version}">`;
    return page(
      req,
      res,
      {
        title: `${Card.refLabel(lead.ref)} · ${Card.displayName(lead, lang)}`,
        nav: "leads",
        body: html`${notice ? html`<div class="card notice${status >= 400 ? " bad" : ""}" role="status">${notice}${undoEvent
          ? html` <form method="post" action="${path}/undo" class="inline"><input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="event" value="${undoEvent}"><button type="submit" class="link">↩️ ${L(lang, "تراجع", "Undo")}</button></form>`
          : ""}</div>` : ""}
${V.leadHeader(lead, lang)}
<div class="card row"><form method="post" action="${path}/contacted" class="inline">${hidden}<button type="submit">📞 ${L(lang, "كلمته", "I called")}</button></form>
  <a class="btn secondary" href="/app/deals/new?lead=${Card.refLabel(lead.ref)}">🤝 ${L(lang, "سجل صفقة", "Record deal")}</a>
  <form method="post" action="${path}/draft" class="inline">${hidden}<button type="submit" class="secondary">✍️ ${L(lang, "اكتبلي رسالة متابعة", "Draft a follow-up message")}</button></form></div>
${draft
  ? html`<section class="card notice ok" id="draft" data-follow-up-draft>
  <h2>✍️ ${L(lang, "رسالة المتابعة (راجعها قبل ما تبعت)", "Follow-up message (check it before sending)")}</h2>
  <p style="white-space:pre-line" data-draft-text>${draft.text}</p>
  ${draft.wa ? html`<p><a class="btn" href="${draft.wa}" target="_blank" rel="noopener noreferrer" data-draft-send>📤 ${L(lang, "ابعتها على واتساب", "Send on WhatsApp")}</a></p>` : html`<p class="muted">${L(lang, "الرقم ده أرضي؛ انسخ الرسالة وابعتها بنفسك.", "This number is a landline; copy the message and send it yourself.")}</p>`}
  <p class="muted">${L(lang, "اتكتبت من بيانات العميل بس. عشان تبقى بأسلوبك، حط مثال من رسايلك في الإعدادات.", "Written from this client's record only. To make it sound like you, add a sample of your messages in Settings.")}</p>
</section>`
  : ""}
<section class="card" id="stage"><h2>🔄 ${L(lang, "المرحلة", "Stage")}</h2>
  <form method="post" action="${path}/stage" class="row">${hidden}
    <select name="stage">${Stages.STAGES.map((s) => html`<option value="${s}"${s === lead.stage ? html` selected` : ""}>${Stages.stageLabel(s, lang)}</option>`)}</select>
    <input name="lost_reason" maxlength="200" placeholder="${L(lang, "سبب الضياع (لو ضاع)", "Why lost (if lost)")}" value="${lead.lost_reason || ""}">
    <button type="submit">${L(lang, "حفظ", "Save")}</button>
  </form>
</section>
<section class="card" id="follow-up"><h2>📅 ${L(lang, "المتابعة", "Follow-up")}</h2>
  <form method="post" action="${path}/follow-up" class="grid">${hidden}
    <label>${L(lang, "إمتى (بتوقيت القاهرة)", "When (Cairo time)")}<input type="datetime-local" name="at" required value="${lead.follow_up_status === "open" ? Stages.toCairoLocal(lead.next_follow_up_at) : ""}"></label>
    <label>${L(lang, "النوع", "Type")}<select name="kind"><option value="call">${L(lang, "مكالمة", "Call")}</option><option value="viewing"${lead.follow_up_kind === "viewing" ? html` selected` : ""}>${L(lang, "معاينة", "Viewing")}</option></select></label>
    <label>${L(lang, "كود الوحدة (للمعاينة)", "Unit code (viewing)")}<input name="unit" dir="ltr" value="${unit?.code || ""}"></label>
    <label>${L(lang, "ملاحظة", "Note")}<input name="note" maxlength="300" value="${lead.follow_up_status === "open" ? lead.follow_up_note || "" : ""}"></label>
    <button type="submit">${L(lang, "حفظ المتابعة", "Save follow-up")}</button>
  </form>
  ${lead.follow_up_status === "open" ? html`<form method="post" action="${path}/follow-up/done">${hidden}<button type="submit" class="secondary">✔️ ${L(lang, "المتابعة خلصت", "Follow-up done")}</button></form>
  <form method="post" action="${path}/follow-up/postpone">${hidden}<button type="submit" class="secondary">📅 ${L(lang, "أجّل يوم", "Postpone a day")}</button></form>` : ""}
</section>
${viewingSection({ lead, viewing, unit, path, hidden, lang })}
${manager
  ? html`<section class="card" id="merge"><h2>🔗 ${L(lang, "دمج عميل مكرر", "Merge a duplicate")}</h2>
  <p class="muted">${L(lang, "لو العميل ده متسجل مرتين برقمين مختلفين: اكتب رقم السجل التاني (L-…) مرتين، وكل حاجة فيه (أرقامه، تاريخه، طلباته، معايناته، صفقاته) هتتنقل هنا، والسجل التاني هيتمسح. مينفعش يترجع.", "If this client is saved twice under two numbers: type the other record's reference (L-…) twice; everything on it (numbers, history, requests, viewings, deals) moves here and the other record is deleted. This can't be undone.")}</p>
  <form method="post" action="${path}/merge" class="row">${hidden}
    <label>${L(lang, "السجل التاني", "The other record")}<input name="other" required dir="ltr" placeholder="L-0042" size="8"></label>
    <label>${L(lang, "اكتبه تاني للتأكيد", "Type it again to confirm")}<input name="confirm" required dir="ltr" size="8"></label>
    <button type="submit" class="danger">🔗 ${L(lang, "ادمج هنا", "Merge into this one")}</button>
  </form>
</section>
<section class="card" id="privacy"><h2>🔒 ${L(lang, "بيانات العميل (للمدير)", "Client data (managers)")}</h2>
  <p><a class="btn secondary" href="${path}/export">📦 ${L(lang, "تصدير بياناته (zip)", "Export their data (zip)")}</a></p>
  <form method="post" action="${path}/erase" class="row">${hidden}
    <label>${L(lang, "للمسح النهائي اكتب آخر 4 أرقام من رقمه", "To erase for good, type the last 4 digits of their number")}<input name="confirm" inputmode="numeric" maxlength="4" pattern="[0-9٠-٩]{4}" required dir="ltr"></label>
    <button type="submit" class="danger">🗑️ ${L(lang, "امسح العميل", "Erase the client")}</button>
  </form>
  <p class="muted">${L(lang, "المسح نهائي: العميل وتاريخه وطلباته بيتمسحوا، والصفقات بتفضل من غير اسمه ورقمه.", "Erasing is final: the client, their history and requests are deleted; deals stay without their name and number.")}</p>
</section>`
  : ""}
<section class="card" id="note"><h2>📝 ${L(lang, "ملاحظة", "Note")}</h2>
  <form method="post" action="${path}/note" class="stack">${hidden}<textarea name="text" rows="2" maxlength="1000" required></textarea><button type="submit" class="secondary">${L(lang, "إضافة", "Add")}</button></form>
</section>
${manager
  ? html`<section class="card" id="assign"><h2>🧑‍💼 ${L(lang, "تسليم لوسيط", "Assign")}</h2>
  <form method="post" action="${path}/assign" class="row">${hidden}
    <select name="broker"><option value="">${L(lang, "مش متسلم لحد", "Unassigned")}</option>${brokers.map((b) => html`<option value="${b.id}"${b.id === lead.assigned_broker_id ? html` selected` : ""}>${b.name}</option>`)}</select>
    <button type="submit">${L(lang, "تسليم", "Assign")}</button>
  </form>
</section>`
  : ""}
${Stages.WANTS_UNIT.includes(lead.kind) || requests.length
  ? html`<section class="card" id="requests"><h2>🔎 ${L(lang, "طلبات العميل", "Requests")} (${requests.length}/${LeadRequests.MAX_REQUESTS})</h2>
  ${requests.length
    ? html`<ul>${requests.map(
        (r) => html`<li data-request="${r.id}">${Card.requestSummary(r.filters, lang)} · <a href="/app/search?f=${SearchLink.encodeFilters(r.filters)}">🏠 ${r.matches.total} ${L(lang, "وحدة مناسبة", "fit now")}</a>${r.alerts_enabled ? ` · 🔔` : ""}
  <form method="post" action="${path}/requests/delete" class="inline">${hidden}<input type="hidden" name="request" value="${r.id}"><button type="submit" class="link">🗑️ ${L(lang, "امسح", "Remove")}</button></form>
  ${r.matches.rows.length
    ? html`<ul>${r.matches.rows.slice(0, 3).map(
        (u) => html`<li data-match="${u.code}"><a href="/app/units/${encodeURIComponent(u.code)}">${u.code}</a> <form method="post" action="${path}/send" class="inline" target="_blank">${hidden}<input type="hidden" name="code" value="${u.code}"><button type="submit" class="link">💬 ${L(lang, "ابعت للعميل", "Send to client")}</button></form></li>`
      )}</ul>`
    : ""}</li>`
      )}</ul>`
    : html`<p class="muted">${L(lang, "مفيش طلب لسه. ضيف طلب وهبلغك أول ما تنزل وحدة تناسبه.", "No request yet. Add one and you'll hear when a unit that fits comes in.")}</p>`}
  ${requests.length < LeadRequests.MAX_REQUESTS
    ? refineForm(null, lang, { action: `${path}/requests`, method: "post", hidden, summary: `➕ ${L(lang, "طلب جديد", "Add a request")}`, submit: L(lang, "حفظ الطلب", "Save the request"), clear: null })
    : ""}
</section>`
  : ""}
${tl ? V.timelineList(tl.rows, lang, { more: tl.more, lead }) : ""}
${V.bottomBar(lead, lang, broker.name)}`
      },
      status
    );
  }

  const loadOr404 = async (req, next) => {
    const lead = await Leads.getLead(pool, req.session.broker, req.params.ref);
    if (!lead) next();
    return lead;
  };

  web.get("/leads/:ref", async (req, res, next) => {
    const lead = await loadOr404(req, next);
    if (!lead) return;
    const lang = langOf(req);
    const done = {
      saved: L(lang, "✅ اتسجل.", "✅ Saved."),
      known: L(lang, "📇 العميل ده كان متسجل؛ اتضاف عليه.", "📇 This client was already saved; added to that lead."),
      stage: L(lang, "✅ المرحلة اتحفظت.", "✅ Stage saved."),
      follow_up: L(lang, "✅ المتابعة اتحفظت.", "✅ Follow-up saved."),
      follow_up_done: L(lang, "✅ المتابعة خلصت.", "✅ Follow-up done."),
      note: L(lang, "✅ الملاحظة اتضافت.", "✅ Note added."),
      contacted: L(lang, "📞 اتسجل إنك كلمته.", "📞 Marked as contacted."),
      assigned: L(lang, "✅ اتسلم.", "✅ Assigned."),
      undone: L(lang, "↩️ اتلغى.", "↩️ Undone."),
      merged: L(lang, "🔗 السجلين اتدمجوا في سجل واحد.", "🔗 The two records are now one."),
      request: L(lang, "🔎 الطلب اتحفظ؛ هتتبلغ بالوحدات الجديدة اللي تناسبه.", "🔎 Request saved; you'll hear about new units that fit."),
      request_removed: L(lang, "🗑️ الطلب اتمسح.", "🗑️ Request removed."),
      viewing: L(lang, "✅ المعاينة اتحفظت. الرقم ده أرضي، ابعت اللينك بنفسك.", "✅ Viewing saved. This number is a landline; send the link yourself.")
    };
    const key = req.query.saved ? "saved" : req.query.known ? "known" : req.query.done;
    return leadPage(req, res, lead, { notice: done[key] || null, undoEvent: /^\d+$/.test(String(req.query.undo || "")) ? req.query.undo : null });
  });

  /** One write: the service result → redirect with Undo, or the page again with a 409/422/403. */
  function write(path, run, doneKey) {
    web.post(`/leads/:ref/${path}`, async (req, res, next) => {
      if (!(await writeGate(req, res))) return;
      const lang = langOf(req);
      const lead = await loadOr404(req, next);
      if (!lead) return;
      const version = req.body.version === undefined || req.body.version === "" ? null : Number(req.body.version);
      const r = await run(req, lead, version);
      if (r.ok && r.redirect) return res.redirect(303, r.redirect);
      if (r.ok || r.unchanged) return res.redirect(303, `${V.leadPath(r.lead || lead)}?done=${doneKey}${r.eventId ? `&undo=${r.eventId}` : ""}`);
      const fresh = (await Leads.getLead(pool, req.session.broker, lead.id)) || lead;
      if (r.conflict) {
        return leadPage(req, res, fresh, { status: 409, notice: L(lang, "⚠️ العميل اتعدل من مكان تاني (واتساب أو صفحة تانية) بعد ما فتحت الصفحة. دي آخر نسخة؛ عيد التعديل.", "⚠️ This lead was changed elsewhere (WhatsApp or another tab) after you opened the page. This is the latest version; make your change again.") });
      }
      if (r.error === "forbidden") return res.status(403).send(L(lang, "مش مسموح.", "Not allowed."));
      const why = {
        lost_reason_required: L(lang, "اكتب سبب الضياع.", "Type why it was lost."),
        follow_up_time: L(lang, "اختار تاريخ ووقت.", "Choose a date and time."),
        past: L(lang, "الميعاد ده عدّى؛ اختار ميعاد جاي.", "That time has passed; choose a future one."),
        unit_not_found: L(lang, "كود الوحدة مش موجود.", "Unit code not found."),
        note_empty: L(lang, "الملاحظة فاضية.", "The note is empty."),
        no_open_follow_up: L(lang, "مفيش متابعة مفتوحة.", "No open follow-up."),
        assignee: L(lang, "الوسيط مش موجود.", "Unknown broker."),
      assignee_away: L(lang, "الوسيط ده في إجازة ومش بياخد عملاء جداد.", "This broker is away and takes no new leads."),
        assignee_away: L(lang, "الوسيط ده في إجازة ومش بياخد عملاء جداد.", "This broker is away and takes no new leads."),
        undo_expired: L(lang, "التراجع متاح 10 دقايق بس.", "Undo is only available for 10 minutes."),
        undo_blocked: L(lang, "مش ممكن التراجع: العميل اتعدل بعدها.", "Can't undo: the lead changed since."),
        already_undone: L(lang, "اتلغى قبل كده.", "Already undone."),
        not_undoable: L(lang, "ده مينفعش يتلغي.", "This can't be undone."),
        not_found: L(lang, "مش موجود.", "Not found."),
        request_empty: L(lang, "اختار فلتر واحد على الأقل (النوع، المكان أو السعر).", "Choose at least one filter (type, place or price)."),
        too_many_requests: L(lang, `الحد الأقصى ${LeadRequests.MAX_REQUESTS} طلبات للعميل؛ امسح واحد الأول.`, `At most ${LeadRequests.MAX_REQUESTS} requests per client; remove one first.`)
      }[r.error] || r.error;
      return leadPage(req, res, fresh, { status: 422, notice: `⚠️ ${why}` });
    });
  }

  const actor = (req) => req.session.broker;
  write("stage", (req, lead, version) => Leads.setStage(pool, actor(req), lead.id, { stage: req.body.stage, lostReason: req.body.lost_reason, version }), "stage");
  write(
    "follow-up",
    async (req, lead, version) => {
      let listingId = null;
      const code = String(req.body.unit || "").trim();
      if (code) {
        const unit = await Store.findByCode(pool, actor(req).agency_id, code);
        if (!unit) return { error: "unit_not_found" };
        listingId = unit.id;
      }
      const at = Stages.fromCairoLocal(req.body.at);
      return Leads.setFollowUp(pool, actor(req), lead.id, { at, kind: req.body.kind === "viewing" ? "viewing" : "call", listingId, note: req.body.note, version });
    },
    "follow_up"
  );
  write(
    "viewing",
    async (req, lead, version) => {
      const code = String(req.body.unit || "").trim();
      const listing = code ? await Store.findByCode(pool, actor(req).agency_id, code) : null;
      if (code && !listing) return { error: "unit_not_found" };
      const r = await Viewings.schedule(pool, actor(req), lead.id, { at: Stages.fromCairoLocal(req.body.at), listing, place: req.body.place, version, lang: langOf(req) });
      // WhatsApp opens on the client's chat with the message and the confirm link ready.
      return r.ok ? { ...r, redirect: r.wa || `${V.leadPath(r.lead || lead)}?done=viewing#viewing` } : r;
    },
    "viewing"
  );
  web.get("/leads/:ref/viewing.ics", async (req, res, next) => {
    const lead = await loadOr404(req, next);
    if (!lead) return;
    const v = await Viewings.latestFor(pool, req.session.broker.agency_id, lead.id);
    if (!v || !Viewings.OPEN.includes(v.status)) return next();
    const entry = Viewings.calendarEntry(v, { lang: langOf(req), forBroker: true, leadLabel: `${Card.refLabel(lead.ref)} · ${Card.displayName(lead, langOf(req))}` });
    res.type("text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="viewing.ics"');
    return res.send(Viewings.ics(v, entry));
  });
  write("follow-up/done", (req, lead, version) => Leads.completeFollowUp(pool, actor(req), lead.id, { version }), "follow_up_done");
  write("follow-up/postpone", (req, lead, version) => Leads.postponeFollowUp(pool, actor(req), lead.id, { days: 1, version }), "follow_up");
  write("note", (req, lead, version) => Leads.addNote(pool, actor(req), lead.id, req.body.text, { version }), "note");
  write("contacted", (req, lead, version) => Leads.markContacted(pool, actor(req), lead.id, { version }), "contacted");
  write("assign", (req, lead, version) => Leads.assignLead(pool, actor(req), lead.id, req.body.broker || null, { version }), "assigned");
  // PDPL (Q9): managers export a client's data (zip, 10 an hour) and erase a client (the last 4 digits).
  web.get("/leads/:ref/export", async (req, res, next) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send(L(langOf(req), "للمديرين بس.", "Managers only."));
    const gate = await RateLimit.hit(pool, `lead_export:broker:${broker.id}`, RateLimit.LIMITS.leadExportBroker);
    if (!gate.allowed) return res.set("Retry-After", String(gate.retryAfterSec || 3600)).status(429).send("Too many exports; try again later.");
    const r = await Privacy.exportLead(pool, broker, req.params.ref);
    if (r.error === "not_found") return next();
    if (r.error) return res.status(403).send("Not allowed.");
    res.set("Cache-Control", "no-store").set("Content-Disposition", `attachment; filename="${r.filename}"`);
    return res.type("application/zip").send(r.zip);
  });

  web.post("/leads/:ref/erase", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).send(L(lang, "للمديرين بس.", "Managers only."));
    const r = await Privacy.eraseLead(pool, broker, req.params.ref, { confirm: req.body.confirm });
    if (r.error === "not_found") return next();
    if (r.error === "confirm") {
      const lead = await Leads.getLead(pool, broker, req.params.ref);
      return leadPage(req, res, lead, { status: 422, notice: L(lang, "⚠️ الأرقام مش مطابقة لآخر 4 أرقام من رقم العميل. محدش اتمسح.", "⚠️ Those aren't the last 4 digits of the client's number. Nothing was erased.") });
    }
    if (r.error) return res.status(403).send("Not allowed.");
    return res.redirect(303, `/app/leads?erased=${Card.refLabel(r.ref)}`);
  });

  // "Send to client": a share link with the lead, then WhatsApp opens on the client's chat with the message ready.
  // N8: managers merge a duplicate record into this one (services/leadMerge.js).
  web.post("/leads/:ref/merge", async (req, res, next) => {
    const lead = await loadOr404(req, next);
    if (!lead) return;
    const lang = langOf(req);
    const out = await LeadMerge.merge(pool, actor(req), lead.id, String(req.body.other || "").trim(), { confirm: String(req.body.confirm || "").trim() });
    if (out.error === "forbidden") return res.status(403).send(L(lang, "للمديرين بس.", "Managers only."));
    if (out.error) {
      const why = { not_found: L(lang, "مش لاقيين السجل التاني.", "The other record wasn't found."), same: L(lang, "ده نفس السجل.", "That's this same record."), confirm: L(lang, "التأكيد مش مطابق لرقم السجل التاني.", "The confirmation doesn't match the other record's reference.") }[out.error];
      return leadPage(req, res, lead, { status: 422, notice: `⚠️ ${why}` });
    }
    return res.redirect(303, `${V.leadPath(out.lead)}?done=merged`);
  });

  // N2: the next message to the client, drafted from the lead's record (services/followUpDrafts.js).
  web.post("/leads/:ref/draft", async (req, res, next) => {
    const lead = await loadOr404(req, next);
    if (!lead) return;
    const lang = langOf(req);
    const out = await FollowUpDrafts.draft(pool, actor(req), lead.id, { lang });
    if (out.error) return leadPage(req, res, lead, { status: out.error === "quota" ? 429 : 503, notice: `⚠️ ${L(lang, "مقدرتش أكتب الرسالة دلوقتي، جرب كمان شوية.", "Couldn't draft the message right now; try again shortly.")}` });
    return leadPage(req, res, out.lead, { draft: out });
  });

  web.post("/leads/:ref/send", async (req, res, next) => {
    if (!(await writeGate(req, res))) return;
    const lead = await loadOr404(req, next);
    if (!lead) return;
    const unit = await Store.findByCode(pool, actor(req).agency_id, String(req.body.code || ""));
    const r = await LeadRequests.sendToClient(pool, actor(req), lead.id, unit, { lang: langOf(req) });
    if (r.ok) return res.redirect(303, r.url);
    if (r.error === "forbidden") return res.status(403).send(L(langOf(req), "مش مسموح.", "Not allowed."));
    return leadPage(req, res, lead, { status: 422, notice: `⚠️ ${L(langOf(req), "الوحدة دي مش متاحة.", "This unit isn't available.")}` });
  });
  write("requests", (req, lead) => LeadRequests.saveRequest(pool, actor(req), lead.id, SearchLink.filtersFromForm(req.body)), "request");
  write("requests/delete", (req, lead) => LeadRequests.removeRequest(pool, actor(req), lead.id, req.body.request), "request_removed");
  write(
    "undo",
    async (req) => {
      const r = await Leads.undo(pool, actor(req), req.body.event);
      return r.ok ? { ok: true, lead: r.lead } : r.conflict ? { error: "undo_blocked" } : r;
    },
    "undone"
  );
}

module.exports = { register, inputOf };
