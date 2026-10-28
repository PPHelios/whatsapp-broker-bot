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
  const phone = (lead.phones || [])[0];
  const digits = phone ? String(phone).replace(/\D/g, "") : "";
  return html`<li class="card leadcard" data-lead="${Card.refLabel(lead.ref)}">
  <a class="lc-main" href="${leadPath(lead)}">
    <span class="lc-top"><strong>${Card.displayName(lead, lang)}</strong><span class="muted small" dir="ltr">${Card.refLabel(lead.ref)}</span></span>
    <span class="tags"><span class="chip">${Stages.stageLabel(lead.stage, lang)}</span>${lead.hot_at ? html`<span class="chip hot">${L(lang, "مهتم جداً", "Very interested")}</span>` : ""}<span class="muted small">${Stages.kindLabel(lead.kind, lang)}${lead.source ? ` · ${Stages.sourceLabel(lead.source, lang)}` : ""}</span></span>
    <span class="${overdue ? "bad-text" : "muted"} small">${lead.follow_up_status === "open"
      ? `⏰ ${when(lead.next_follow_up_at, lang)}${overdue ? L(lang, " (متأخرة)", " (overdue)") : ""}`
      : Stages.isClosed(lead.stage) ? "" : L(lang, "⏰ مفيش خطوة جاية", "⏰ No next step")}${manager ? ` · ${lead.assignee_name || L(lang, "مش متسلم", "Unassigned")}` : ""}</span>
  </a>
  ${digits ? html`<a class="lc-call" href="tel:+${digits}" aria-label="${L(lang, "اتصال", "Call")} ${Card.displayName(lead, lang)}">${raw('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>')}</a>` : ""}
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
  <section class="card"><h2>👤 ${L(lang, "العميل", "Client")}</h2>
  <div class="pills" role="group" aria-label="${L(lang, "النوع", "Type")}">${Stages.KINDS.map((k) => html`<label class="pill"><input type="radio" name="kind" value="${k}"${chk((v.kind || "buyer") === k)}><span>${Stages.kindLabel(k, lang)}</span></label>`)}</div>
  <div class="grid">
    <label>${L(lang, "الاسم", "Name")}<input name="name" value="${v.name || ""}" maxlength="120"></label>
    <label>${L(lang, "الموبايل *", "Phone *")}<input name="phone1" value="${v.phone1 || ""}" dir="ltr" inputmode="tel" required hx-post="/app/leads/check" hx-trigger="change" hx-target="#dup" hx-include="#lead-form"></label>

    <label>${L(lang, "المصدر", "Source")}<select name="source"><option value="">—</option>${Stages.SOURCES.map(([en, ar]) => html`<option value="${en}"${sel(v.source === en)}>${lang === "en" ? en : ar}</option>`)}${extraSources.map((x) => html`<option value="${x}"${sel(v.source === x)}>${x}</option>`)}<option value="other"${sel(v.source && !known)}>${L(lang, "أخرى", "Other")}</option></select></label>
    ${brokers
      ? html`<label>${L(lang, "يتسلم لـ", "Assign to")}<select name="assign_to"><option value="">${L(lang, "مش متسلم لحد", "Unassigned")}</option>${brokers.map((b) => html`<option value="${b.id}"${sel(v.assign_to === b.id)}>${b.name}</option>`)}</select></label>`
      : ""}
  </div>
  <div id="dup">${duplicate || ""}</div>
  <details class="fgroup"${v.phone2 || v.phone3 || v.notes || (v.source && !known) || v.source_other ? raw(" open") : ""}><summary>${L(lang, "تفاصيل أكتر", "More details")}</summary><div class="fbody grid">
    <label>${L(lang, "رقم تاني", "Second phone")}<input name="phone2" value="${v.phone2 || ""}" dir="ltr" inputmode="tel" hx-post="/app/leads/check" hx-trigger="change" hx-target="#dup" hx-include="#lead-form"></label>
    <label>${L(lang, "رقم تالت", "Third phone")}<input name="phone3" value="${v.phone3 || ""}" dir="ltr" inputmode="tel"></label>
    <label>${L(lang, "مصدر تاني (اكتبه)", "Other source (type it)")}<input name="source_other" value="${v.source && !known ? v.source : v.source_other || ""}" maxlength="60"></label>
  </div>
  <label>${L(lang, "ملاحظات (داخلية)", "Notes (internal)")}<textarea name="notes" rows="2" maxlength="4000">${v.notes || ""}</textarea></label>
  </details>
  </section>
  <details class="card fgroup lawful"${erased || (v.lawful_basis && v.lawful_basis !== "client_request") ? raw(" open") : ""}><summary>${L(lang, "الأساس القانوني", "Lawful basis")}: <b>${Stages.basisLabel(v.lawful_basis || "client_request", lang)}</b></summary>
  <fieldset class="stack"><legend class="sr-only">${L(lang, "الأساس القانوني *", "Lawful basis *")}</legend>
    ${Stages.LAWFUL_BASES.map((b) => html`<label class="check"><input type="radio" name="lawful_basis" value="${b}"${chk((v.lawful_basis || "client_request") === b)} required> ${Stages.basisLabel(b, lang)}</label>`)}
    ${erased ? html`<label class="check"><input type="checkbox" name="allow_erased" value="1"> ${L(lang, "العميل طلب يتمسح قبل كده، وهو اللي كلمنا تاني", "The client asked to be deleted before, and contacted us again")}</label>` : ""}
  </fieldset>
  </details>
  <button type="submit" data-tg-main>💾 ${L(lang, "حفظ العميل", "Save the client")}</button>
</form>`;
}

/** The lead's header: every number with a real Call link, stage, kind, next step, assignee, notes. */
function leadHeader(lead, lang) {
  return html`<article class="card leadhead" data-lead="${Card.refLabel(lead.ref)}" data-version="${lead.version}">
  <div class="lc-top"><h1>${Card.displayName(lead, lang)}</h1><span class="chip" dir="ltr">${Card.refLabel(lead.ref)}</span></div>
  <p class="tags"><span class="chip new">${Stages.stageLabel(lead.stage, lang)}</span>${lead.hot_at ? html`<span class="chip hot">${L(lang, "مهتم جداً", "Very interested")}</span>` : ""}<span class="muted">${Stages.kindLabel(lead.kind, lang)}${lead.stage === "lost" && lead.lost_reason ? ` (${lead.lost_reason})` : ""}${lead.source ? ` · ${Stages.sourceLabel(lead.source, lang)}` : ""}</span></p>
  <ul class="tags">${(lead.phones || []).map((p) => html`<li><a href="${Phone.telUrl(p)}" dir="ltr">${Phone.displayPhone(p)}</a></li>`)}</ul>
  <p class="${lead.follow_up_status === "open" && new Date(lead.next_follow_up_at) < new Date() ? "bad-text" : ""}">${lead.follow_up_status === "open"
    ? `⏰ ${lead.follow_up_kind === "viewing" ? L(lang, "معاينة", "Viewing") : L(lang, "متابعة", "Follow-up")}: ${when(lead.next_follow_up_at, lang)}${lead.follow_up_note ? ` · ${lead.follow_up_note}` : ""}`
    : Stages.isClosed(lead.stage) ? "" : L(lang, "⏰ مفيش خطوة جاية", "⏰ No next step")}</p>
  <p class="muted small">${lead.assignee_name || L(lang, "مش متسلم لحد", "Unassigned")} · ${Stages.basisLabel(lead.lawful_basis, lang)}</p>
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
