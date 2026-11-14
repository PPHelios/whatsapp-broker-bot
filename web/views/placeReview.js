// web/views/placeReview.js — The owner's "Places waiting" panel: new compound names, areas and sub-zones, grouped when
// alike, each with the existing places it may duplicate. The owner approves, merges into an existing one, or rejects with a reason.
"use strict";

const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);

function approveCompoundForm(g, q, lang, csrf) {
  const lead = g.lead;
  const also = g.items.filter((i) => i.id !== lead.id).map((i) => html`<input type="hidden" name="also" value="${i.id}">`);
  return html`<form method="post" action="/app/owner/places/${lead.id}/approve" class="stack" data-approve-place>
  <input type="hidden" name="_csrf" value="${csrf}">${also}
  <div class="row"><input name="name_en" value="${lead.name_en || ""}" dir="ltr" aria-label="${L(lang, "الاسم بالإنجليزي", "English name")}"><input name="name_ar" value="${lead.name_ar || ""}" placeholder="${L(lang, "الاسم بالعربي (اختياري)", "Arabic name (optional)")}" aria-label="${L(lang, "الاسم بالعربي", "Arabic name")}"></div>
  ${lead.pin_link ? html`<p class="muted small" dir="ltr">📍 ${lead.pin_link}</p>` : ""}
  <div class="row"><select name="area_id" required aria-label="${L(lang, "المنطقة", "Area")}"><option value="">${L(lang, "المنطقة (مطلوبة)", "Area (required)")}</option>${q.topAreas.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select>
  <select name="subzone_id" aria-label="${L(lang, "المنطقة الفرعية", "Sub-zone")}"><option value="">${L(lang, "منطقة فرعية (اختياري)", "Sub-zone (optional)")}</option>${q.subzones.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></div>
  <input name="aliases" placeholder="${L(lang, "أسماء تانية (اختياري)", "Other names (optional)")}" aria-label="${L(lang, "أسماء تانية", "Other names")}">
  <div class="row"><input name="lat" inputmode="decimal" placeholder="lat" aria-label="lat"><input name="lng" inputmode="decimal" placeholder="lng" aria-label="lng"></div>
  <button type="submit">✅ ${L(lang, "اعتمد كمكان جديد", "Approve as a new place")}</button></form>`;
}

function approveAreaForm(g, q, lang, csrf) {
  const lead = g.lead;
  return html`<form method="post" action="/app/owner/areas/${lead.id}/approve" class="stack" data-approve-area>
  <input type="hidden" name="_csrf" value="${csrf}">
  <div class="row"><input name="name_en" value="${lead.name_en || ""}" dir="ltr" aria-label="${L(lang, "الاسم بالإنجليزي", "English name")}"><input name="name_ar" value="${lead.name_ar || ""}" aria-label="${L(lang, "الاسم بالعربي", "Arabic name")}"></div>
  <select name="parent_id" aria-label="${L(lang, "تابعة لمنطقة", "Under area")}"><option value="">${L(lang, "منطقة رئيسية", "Top-level area")}</option>${q.topAreas.map((a) => html`<option value="${a.id}"${lead.parent_id === a.id ? html` selected` : ""}>${a.name}</option>`)}</select>
  <button type="submit">✅ ${L(lang, "اعتمد", "Approve")}</button></form>`;
}

function rejectForm(g, lang, csrf) {
  const route = g.kind === "compound" ? "places" : "areas";
  const also = g.items.filter((i) => i.id !== g.lead.id).map((i) => html`<input type="hidden" name="also" value="${i.id}">`);
  return html`<form method="post" action="/app/owner/${route}/${g.lead.id}/reject" class="row" data-reject-place><input type="hidden" name="_csrf" value="${csrf}">${also}
  <input name="reason" required maxlength="200" placeholder="${L(lang, "سبب الرفض (بيوصل للسمسار)", "Reason (the broker is told)")}" aria-label="${L(lang, "سبب الرفض", "Reason")}"><button type="submit" class="secondary">✖ ${L(lang, "ارفض", "Reject")}</button></form>`;
}

function mergeForms(g, lang, csrf) {
  const route = g.kind === "compound" ? "places" : "areas";
  const also = g.items.filter((i) => i.id !== g.lead.id).map((i) => html`<input type="hidden" name="also" value="${i.id}">`);
  return g.matches.map((m) => html`<form method="post" action="/app/owner/${route}/${g.lead.id}/merge" class="row" data-merge-place>
  <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="into" value="${m.id}">${also}
  <span>${L(lang, "شبه", "Looks like")} <b dir="ltr">${m.name}</b>${m.path ? html` <span class="muted small" dir="ltr">(${m.path})</span>` : ""} <span class="chip">${Math.round(m.score * 100)}%</span></span>
  <button type="submit" class="secondary">🔗 ${L(lang, "هو نفسه", "Same place")}</button></form>`);
}

function placesSection(q, lang, csrf) {
  return html`<div id="places"><h2>${L(lang, "أماكن مستنية", "Places waiting")}</h2>
<p class="muted small">${L(lang, "كمبوندات ومناطق جديدة اقترحها البروكرز. الأسماء الشبه بعض متجمعة؛ اعتمد، أو اربط بمكان موجود، أو ارفض بسبب.", "New compounds and areas brokers suggested. Alike names are grouped; approve, link to an existing place, or reject with a reason.")}</p>
${q.groups.length
  ? html`<ul class="stack" data-places-waiting>${q.groups.map((g) => html`<li class="card" data-place-group="${g.lead.id}">
  <b dir="ltr">${g.lead.name_en || g.lead.name_ar}</b> <span class="chip">${g.kind === "compound" ? L(lang, "كمبوند", "Compound") : L(lang, "منطقة", "Area")}</span> <span class="chip">${g.times_seen} ${L(lang, "مرة", "×")}</span>
  ${g.items.length > 1 ? html`<p class="muted small" dir="ltr">${g.items.map((i) => i.name_en || i.name_ar).join(" · ")}</p>` : ""}
  ${mergeForms(g, lang, csrf)}
  ${g.kind === "compound" ? approveCompoundForm(g, q, lang, csrf) : approveAreaForm(g, q, lang, csrf)}
  ${rejectForm(g, lang, csrf)}</li>`)}</ul>`
  : html`<p class="muted">${L(lang, "مفيش حاجة مستنية.", "Nothing waiting.")}</p>`}</div>`;
}

module.exports = { placesSection };
