// web/views/leads.js — Lead pages: the list row, the add form (fill from a message or a voice note),
// the lead card with real Call and WhatsApp buttons, and the timeline. Every value goes through html``.
"use strict";

const Card = require("../../domain/leadCard");
const Stages = require("../../domain/leadStages");
const Phone = require("../../domain/phone");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const sel = (on) => (on ? raw(" selected") : "");
const chk = (on) => (on ? raw(" checked") : "");
const when = (d, lang) =>
  d ? new Date(d).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const leadPath = (lead, sub = "") => `/app/leads/${Card.refLabel(lead.ref)}${sub}`;

function leadRow(lead, lang, { manager = false, now = new Date() } = {}) {
  const overdue = lead.follow_up_status === "open" && new Date(lead.next_follow_up_at) < now;
  return html`<li class="card result" data-lead="${Card.refLabel(lead.ref)}">
  <a class="line" href="${leadPath(lead)}">${Card.refLabel(lead.ref)} · ${Card.displayName(lead, lang)}</a>
  <div class="muted">${Stages.stageLabel(lead.stage, lang)} · ${Stages.kindLabel(lead.kind, lang)}${lead.source ? ` · ${Stages.sourceLabel(lead.source, lang)}` : ""}${lead.hot_at ? " · 🔥" : ""}</div>
  <div class="${overdue ? "bad-text" : "muted"}">${lead.follow_up_status === "open"
    ? `⏰ ${when(lead.next_follow_up_at, lang)}${overdue ? L(lang, " (متأخرة)", " (overdue)") : ""}`
    : Stages.isClosed(lead.stage) ? "" : L(lang, "⏰ مفيش خطوة جاية", "⏰ No next step")}${manager ? ` · 🧑‍💼 ${lead.assignee_name || L(lang, "مش متسلم", "Unassigned")}` : ""}</div>
</li>`;
}

/** The add form. values: { message, name, phone1..3, kind, source, source_other, lawful_basis, notes, assign_to, request (a search token saved as the client's request) } */
function leadForm({ values: v = {}, lang = "ar", csrf = "", brokers = null, notice = null, error = null, duplicate = null, erased = false, extraSources = [] }) {
  const known = Stages.SOURCES.some(([en]) => en === v.source) || extraSources.includes(v.source);
  return html`<form id="lead-form" method="post" action="/app/leads/new" class="stack">
  <input type="hidden" name="_csrf" value="${csrf}">
  ${v.request ? html`<input type="hidden" name="request" value="${v.request}">` : ""}
  ${notice ? html`<p class="card notice">${notice}</p>` : ""}
  ${error ? html`<p class="card notice bad" role="alert">${error}</p>` : ""}
  <section class="card stack">
    <h2>✨ ${L(lang, "املأ من الرسالة", "Fill from the message")}</h2>
    <label>${L(lang, "رسالة العميل (الصقها هنا)", "The client's message (paste it here)")}<textarea name="message" rows="4">${v.message || ""}</textarea></label>
    <div class="row">
      <button type="button" class="secondary" hx-post="/app/leads/extract" hx-encoding="multipart/form-data" hx-include="#lead-form" hx-target="#lead-form" hx-swap="outerHTML">✨ ${L(lang, "املأ من الرسالة", "Fill from message")}</button>
      <button type="button" class="secondary" data-voice-target="#lead-form" data-voice-url="/app/leads/extract" data-stop="■ ${L(lang, "إيقاف وإرسال", "Stop and send")}" data-unsupported="${L(lang, "المتصفح ده مش بيدعم التسجيل", "Recording is not supported here")}">🎙️ ${L(lang, "سجّل فويس", "Record voice")}</button>
      <span class="spinner" aria-hidden="true"></span>
    </div>
    <p class="muted">${L(lang, "اللي الذكاء الاصطناعي يفهمه بيتملى في الخانات تحت؛ راجعه قبل الحفظ.", "What the AI understands fills the fields below; check it before saving.")}</p>
  </section>
  <section class="card"><h2>👤 ${L(lang, "العميل", "Client")}</h2><div class="grid">
    <label>${L(lang, "الاسم", "Name")}<input name="name" value="${v.name || ""}" maxlength="120"></label>
    <label>${L(lang, "الموبايل *", "Phone *")}<input name="phone1" value="${v.phone1 || ""}" dir="ltr" inputmode="tel" required hx-post="/app/leads/check" hx-trigger="change" hx-target="#dup" hx-include="#lead-form"></label>
    <label>${L(lang, "رقم تاني", "Second phone")}<input name="phone2" value="${v.phone2 || ""}" dir="ltr" inputmode="tel" hx-post="/app/leads/check" hx-trigger="change" hx-target="#dup" hx-include="#lead-form"></label>
    <label>${L(lang, "رقم تالت", "Third phone")}<input name="phone3" value="${v.phone3 || ""}" dir="ltr" inputmode="tel"></label>
    <label>${L(lang, "النوع", "Type")}<select name="kind">${Stages.KINDS.map((k) => html`<option value="${k}"${sel((v.kind || "buyer") === k)}>${Stages.kindLabel(k, lang)}</option>`)}</select></label>
    <label>${L(lang, "المصدر", "Source")}<select name="source"><option value="">—</option>${Stages.SOURCES.map(([en, ar]) => html`<option value="${en}"${sel(v.source === en)}>${lang === "en" ? en : ar}</option>`)}${extraSources.map((x) => html`<option value="${x}"${sel(v.source === x)}>${x}</option>`)}<option value="other"${sel(v.source && !known)}>${L(lang, "أخرى", "Other")}</option></select></label>
    <label>${L(lang, "مصدر تاني (اكتبه)", "Other source (type it)")}<input name="source_other" value="${v.source && !known ? v.source : v.source_other || ""}" maxlength="60"></label>
    ${brokers
      ? html`<label>${L(lang, "يتسلم لـ", "Assign to")}<select name="assign_to"><option value="">${L(lang, "مش متسلم لحد", "Unassigned")}</option>${brokers.map((b) => html`<option value="${b.id}"${sel(v.assign_to === b.id)}>${b.name}</option>`)}</select></label>`
      : ""}
  </div>
  <div id="dup">${duplicate || ""}</div>
  <label>${L(lang, "ملاحظات (داخلية)", "Notes (internal)")}<textarea name="notes" rows="2" maxlength="4000">${v.notes || ""}</textarea></label>
  </section>
  <fieldset class="card stack"><legend>${L(lang, "الأساس القانوني *", "Lawful basis *")}</legend>
    ${Stages.LAWFUL_BASES.map((b) => html`<label class="check"><input type="radio" name="lawful_basis" value="${b}"${chk((v.lawful_basis || "client_request") === b)} required> ${Stages.basisLabel(b, lang)}</label>`)}
    ${erased ? html`<label class="check"><input type="checkbox" name="allow_erased" value="1"> ${L(lang, "العميل طلب يتمسح قبل كده، وهو اللي كلمنا تاني", "The client asked to be deleted before, and contacted us again")}</label>` : ""}
  </fieldset>
  <button type="submit">💾 ${L(lang, "حفظ العميل", "Save the client")}</button>
</form>`;
}

/** The lead's header: every number with a real Call link, stage, kind, next step, assignee, notes. */
function leadHeader(lead, lang) {
  return html`<article class="card" data-lead="${Card.refLabel(lead.ref)}" data-version="${lead.version}">
  <h1>👤 ${Card.displayName(lead, lang)} · ${Card.refLabel(lead.ref)}${lead.hot_at ? " 🔥" : ""}</h1>
  <p>${Stages.kindLabel(lead.kind, lang)} · <strong>${Stages.stageLabel(lead.stage, lang)}</strong>${lead.stage === "lost" && lead.lost_reason ? ` (${lead.lost_reason})` : ""}${lead.source ? ` · ${Stages.sourceLabel(lead.source, lang)}` : ""}</p>
  <ul class="tags">${(lead.phones || []).map((p) => html`<li><a href="${Phone.telUrl(p)}" dir="ltr">${Phone.displayPhone(p)}</a></li>`)}</ul>
  <p>${lead.follow_up_status === "open"
    ? `⏰ ${lead.follow_up_kind === "viewing" ? L(lang, "معاينة", "Viewing") : L(lang, "متابعة", "Follow-up")}: ${when(lead.next_follow_up_at, lang)}${lead.follow_up_note ? ` · ${lead.follow_up_note}` : ""}`
    : Stages.isClosed(lead.stage) ? "" : L(lang, "⏰ مفيش خطوة جاية", "⏰ No next step")}</p>
  <p class="muted">🧑‍💼 ${lead.assignee_name || L(lang, "مش متسلم لحد", "Unassigned")} · ${Stages.basisLabel(lead.lawful_basis, lang)}</p>
  ${lead.notes ? html`<p class="pre">📝 ${lead.notes}</p>` : ""}
</article>`;
}

/** Fixed bottom bar (mobile first): Call · WhatsApp · Follow-up · Stage. */
function bottomBar(lead, lang, brokerName = "") {
  const wa = Phone.waMeUrl(lead.phone_e164, L(lead.lang || lang, `أهلاً${lead.name ? ` ${lead.name}` : ""}، معاك ${brokerName}`, `Hello${lead.name ? ` ${lead.name}` : ""}, this is ${brokerName}`));
  return html`<nav class="bottom-bar" aria-label="${L(lang, "إجراءات", "Actions")}">
  <a class="btn" href="${Phone.telUrl(lead.phone_e164)}">📞 ${L(lang, "اتصال", "Call")}</a>
  ${wa ? html`<a class="btn" href="${wa}" rel="noopener">💬 ${L(lang, "واتساب", "WhatsApp")}</a>` : ""}
  <a class="btn secondary" href="#follow-up">📅 ${L(lang, "متابعة", "Follow-up")}</a>
  <a class="btn secondary" href="#stage">🔄 ${L(lang, "المرحلة", "Stage")}</a>
</nav>`;
}

function timelineList(rows, lang, { more = false, lead }) {
  return html`<section class="card" id="timeline"><h2>🕓 ${L(lang, "السجل", "Timeline")}</h2>
  <ul class="timeline">${rows.map((e) => html`<li data-event="${e.kind}">${Card.timelineLine(e, lang)}</li>`)}</ul>
  ${more ? html`<a href="${leadPath(lead, `?before=${rows[rows.length - 1].id}#timeline`)}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}
</section>`;
}

module.exports = { leadRow, leadForm, leadHeader, bottomBar, timelineList, leadPath, when };
