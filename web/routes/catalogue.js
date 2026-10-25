// web/routes/catalogue.js — The developer catalogue (Release A, C1): /app/catalogue lists the agency's projects and
// developers; /app/catalogue/projects/:id holds a project's details, phases, payment plans, materials and units.
// Managers edit, brokers read (no developer contact, no internal notes). services/catalogue.js does the work.
"use strict";

const Catalogue = require("../../services/catalogue");
const Commission = require("../../domain/commission");
const { isManager } = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const sel = (on) => (on ? html` selected` : "");
const val = (v) => (v === null || v === undefined ? "" : String(Number.isFinite(Number(v)) && typeof v !== "string" ? Number(v) : v));
const pctText = (v) => (v === null || v === undefined ? "—" : `${Number(v)}%`);

const STATUS = {
  launching: ["🚀 إطلاق", "🚀 Launching"],
  selling: ["🟢 متاح للبيع", "🟢 Selling"],
  sold_out: ["⚪ اتباع بالكامل", "⚪ Sold out"]
};
const KIND = {
  master_plan: ["المخطط العام", "Master plan"],
  brochure: ["البروشور", "Brochure"],
  layout: ["مخطط وحدة", "Unit layout"],
  video: ["فيديو", "Video"],
  location: ["اللوكيشن", "Location pin"],
  website: ["موقع المطور", "Developer website"],
  price_sheet: ["شيت الأسعار (داخلي)", "Price sheet (internal)"],
  other: ["تاني", "Other"]
};
const FREQ = {
  monthly: ["شهري", "Monthly"],
  quarterly: ["ربع سنوي", "Quarterly"],
  semi_annual: ["كل 6 شهور", "Every 6 months"],
  annual: ["سنوي", "Yearly"]
};
const DUE = { delivery: ["عند الاستلام", "At delivery"], installments: ["مقسمة على الأقساط", "Split over installments"], contract: ["عند التعاقد", "At contract"] };
const FIELD = {
  name: ["اكتب الاسم.", "Type the name."],
  status: ["اختار الحالة.", "Pick a status."],
  delivery_year: ["سنة الاستلام لازم تكون رقم زي 2028.", "The delivery year must be like 2028."],
  delivery_quarter: ["الربع من 1 لـ 4.", "The quarter is 1 to 4."],
  maintenance_pct: ["الصيانة نسبة من 0 لـ 30.", "Maintenance is a % from 0 to 30."],
  developer_id: ["المطور ده مش موجود.", "That developer was not found."],
  contact_phone: ["رقم التليفون مش مظبوط.", "The phone number looks wrong."],
  phase_name: ["اكتب اسم المرحلة (ومايتكررش).", "Type the phase name (not used already)."],
  phase_status: ["اختار حالة المرحلة.", "Pick the phase status."],
  phase_delivery_year: ["سنة الاستلام لازم تكون رقم زي 2028.", "The delivery year must be like 2028."],
  phase_delivery_quarter: ["الربع من 1 لـ 4.", "The quarter is 1 to 4."],
  phase_id: ["المرحلة دي مش موجودة.", "That phase was not found."],
  plan_name: ["اكتب اسم النظام.", "Type the plan name."],
  down_payment_pct: ["المقدم نسبة من 0 لـ 100.", "The down payment is a % from 0 to 100."],
  years: ["عدد السنين من 0 لـ 20.", "Years are 0 to 20."],
  frequency: ["اختار كل قد إيه القسط.", "Pick how often installments are paid."],
  discount_pct: ["الخصم نسبة من 0 لـ 100.", "The discount is a % from 0 to 100."],
  maintenance_due: ["اختار ميعاد الصيانة.", "Pick when maintenance is due."],
  maintenance_splits: ["عدد دفعات الصيانة من 1 لـ 12.", "Maintenance splits are 1 to 12."],
  milestones: ["الدفعات: نسبة وشهر لكل دفعة، والمقدم والدفعات مايزيدوش عن 100%.", "Milestones: a % and a month each; down payment plus milestones must not exceed 100%."],
  extra_fees: ["المصاريف الإضافية: اسم ومبلغ لكل واحدة.", "Extra fees: a label and an amount each."],
  label: ["اكتب اسم اللينك.", "Type the link's label."],
  kind: ["اختار نوع اللينك.", "Pick the link type."],
  url: ["اللينك لازم يبدأ بـ https://", "The link must start with https://"],
  codes: ["اكتب كود وحدة واحد على الأقل.", "Type at least one unit code."]
};
const errorText = (r, lang) => {
  if (r.error === "duplicate") return L(lang, "الاسم ده موجود قبل كده.", "That name is already used.");
  const f = FIELD[r.field];
  return f ? f[lang === "en" ? 1 : 0] : L(lang, "في حاجة مش مظبوطة.", "Something is not right.");
};
const noticeBad = (text) => html`<p class="card notice bad" role="alert">❌ ${text}</p>`;
const noticeOk = (text) => html`<p class="card notice ok" role="status">✅ ${text}</p>`;
const label2 = (map, k, lang) => (map[k] || [k, k])[lang === "en" ? 1 : 0];
const deliveryText = (p, lang) => (p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : L(lang, "مش محدد", "Not stated"));
const devName = (p, lang) => (lang === "en" ? p.developer_name_en || p.developer_name_ar : p.developer_name_ar || p.developer_name_en) || "—";

function statusSelect(name, value, lang) {
  return html`<select name="${name}">${Catalogue.STATUSES.map((s) => html`<option value="${s}"${sel(value === s)}>${label2(STATUS, s, lang)}</option>`)}</select>`;
}

function projectForm(lang, developers, p = {}, action = "/app/catalogue/projects") {
  return html`<form method="post" action="${action}" class="card stack" data-project-form>
  <label>${L(lang, "اسم المشروع *", "Project name *")} <input name="name" required maxlength="120" value="${p.name || ""}"></label>
  <label>${L(lang, "الاسم بالإنجليزي", "Name in English")} <input name="name_en" maxlength="120" dir="ltr" value="${p.name_en || ""}"></label>
  <label>${L(lang, "المطور", "Developer")} <select name="developer_id"><option value="">—</option>${developers.map((d) => html`<option value="${d.id}"${sel(p.developer_id === d.id)}>${d.name}</option>`)}</select></label>
  <label>${L(lang, "أو مطور جديد", "Or a new developer")} <input name="developer_name" maxlength="120"></label>
  <label>${L(lang, "الحالة", "Status")} ${statusSelect("status", p.status || "selling", lang)}</label>
  <div class="row">
    <label>${L(lang, "المنطقة", "District")} <input name="district" maxlength="80" value="${p.district || ""}"></label>
    <label>${L(lang, "المدينة", "City")} <input name="city" maxlength="80" value="${p.city || ""}"></label>
  </div>
  <div class="row">
    <label>${L(lang, "سنة الاستلام", "Delivery year")} <input name="delivery_year" inputmode="numeric" dir="ltr" size="5" value="${val(p.delivery_year)}"></label>
    <label>${L(lang, "الربع (1-4)", "Quarter (1-4)")} <input name="delivery_quarter" inputmode="numeric" dir="ltr" size="2" value="${val(p.delivery_quarter)}"></label>
    <label>${L(lang, "الصيانة %", "Maintenance %")} <input name="maintenance_pct" inputmode="decimal" dir="ltr" size="4" value="${val(p.maintenance_pct)}"></label>
  </div>
  <label>${L(lang, "ملاحظات داخلية", "Internal notes")} <textarea name="notes" maxlength="1000" rows="2">${p.notes || ""}</textarea></label>
  <button type="submit">${p.id ? L(lang, "حفظ المشروع", "Save project") : L(lang, "إضافة المشروع", "Add project")}</button>
</form>`;
}

function developerForm(lang, d = {}, action = "/app/catalogue/developers") {
  return html`<form method="post" action="${action}" class="card stack" data-developer-form>
  <label>${L(lang, "اسم المطور *", "Developer name *")} <input name="name" required maxlength="120" value="${d.name || ""}"></label>
  <label>${L(lang, "الاسم بالإنجليزي", "Name in English")} <input name="name_en" maxlength="120" dir="ltr" value="${d.name_en || ""}"></label>
  <p class="muted">🔒 ${L(lang, "بيانات التواصل للمديرين بس، وعمرها ما بتظهر للعميل.", "The contact is for managers only and never shown to clients.")}</p>
  <label>${L(lang, "مسؤول المبيعات", "Sales contact")} <input name="contact_name" maxlength="120" value="${d.contact_name || ""}"></label>
  <label>${L(lang, "تليفونه", "Phone")} <input name="contact_phone" maxlength="30" dir="ltr" inputmode="tel" value="${d.contact_phone || ""}"></label>
  <label>${L(lang, "ملاحظات", "Notes")} <textarea name="notes" maxlength="1000" rows="2">${d.notes || ""}</textarea></label>
  <button type="submit">${d.id ? L(lang, "حفظ المطور", "Save developer") : L(lang, "إضافة المطور", "Add developer")}</button>
</form>`;
}

function listPage(lang, manager, { projects, developers, archived, notice }) {
  return html`<h1>🏗️ ${L(lang, "كتالوج المطورين", "Developer catalogue")}</h1>
${notice || ""}
<nav class="row"><a class="btn secondary" href="/app/catalogue${archived ? "" : "?archived=1"}">${archived ? L(lang, "المشاريع الحالية", "Current projects") : L(lang, "المشاريع المؤرشفة", "Archived projects")}</a></nav>
<section class="card">
  <h2>${archived ? L(lang, "مؤرشفة", "Archived") : L(lang, "المشاريع", "Projects")}</h2>
  ${projects.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "المشروع", "Project")}</th><th>${L(lang, "المطور", "Developer")}</th><th>${L(lang, "الحالة", "Status")}</th><th>${L(lang, "الاستلام", "Delivery")}</th><th>${L(lang, "وحدات", "Units")}</th><th>${L(lang, "أنظمة سداد", "Plans")}</th></tr></thead>
      <tbody>${projects.map((p) => html`<tr data-project="${p.id}"><td><a href="/app/catalogue/projects/${p.id}">${lang === "en" ? p.name_en || p.name : p.name}</a></td><td>${devName(p, lang)}</td><td>${label2(STATUS, p.status, lang)}</td><td dir="ltr">${deliveryText(p, lang)}</td><td>${p.units}</td><td>${p.plans}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "لسه مفيش مشاريع.", "No projects yet.")}</p>`}
</section>
${manager && !archived ? html`<details class="card"><summary>➕ ${L(lang, "مشروع جديد", "New project")}</summary>${projectForm(lang, developers)}</details>` : ""}
<section class="card">
  <h2>${L(lang, "المطورين", "Developers")}</h2>
  ${developers.length
    ? html`<ul>${developers.map((d) => html`<li data-developer="${d.id}">${manager ? html`<a href="/app/catalogue/developers/${d.id}">${d.name}</a>` : d.name}${d.name_en ? ` · ${d.name_en}` : ""} · ${d.projects} ${L(lang, "مشروع", "projects")}${manager && d.contact_phone ? html` · <span dir="ltr">${d.contact_phone}</span>` : ""}</li>`)}</ul>`
    : html`<p class="muted">${L(lang, "لسه مفيش مطورين.", "No developers yet.")}</p>`}
</section>
${manager ? html`<details class="card"><summary>➕ ${L(lang, "مطور جديد", "New developer")}</summary>${developerForm(lang)}</details>` : ""}`;
}

function planLine(pl, lang) {
  const parts = [`${L(lang, "مقدم", "Down")} ${Number(pl.down_payment_pct)}%`];
  if (Number(pl.years) > 0) parts.push(`${Number(pl.years)} ${L(lang, "سنين", "years")} · ${label2(FREQ, pl.frequency, lang)}`);
  else parts.push(L(lang, "كاش", "Cash"));
  if (Number(pl.discount_pct) > 0) parts.push(`${L(lang, "خصم", "discount")} ${Number(pl.discount_pct)}%`);
  for (const m of pl.milestones || []) parts.push(`${m.pct}% ${L(lang, `بعد ${m.due_after_months} شهر`, `after ${m.due_after_months} months`)}${m.label ? ` (${m.label})` : ""}`);
  if (pl.maintenance_pct !== null && pl.maintenance_pct !== undefined) parts.push(`${L(lang, "صيانة", "maintenance")} ${Number(pl.maintenance_pct)}%${pl.maintenance_due ? ` ${label2(DUE, pl.maintenance_due, lang)}` : ""}`);
  for (const f of pl.extra_fees || []) parts.push(`${f.label}: ${Commission.money(f.amount, lang)}`);
  return parts.join(" · ");
}

function planForm(lang, projectId, phases, pl = {}) {
  const ms = [...(pl.milestones || []), {}, {}].slice(0, 4);
  const fees = [...(pl.extra_fees || []), {}, {}].slice(0, 4);
  return html`<form method="post" action="/app/catalogue/projects/${projectId}/plans" class="card stack" data-plan-form>
  ${pl.id ? html`<input type="hidden" name="id" value="${pl.id}">` : ""}
  <label>${L(lang, "اسم النظام *", "Plan name *")} <input name="name" required maxlength="80" value="${pl.name || ""}" placeholder="${L(lang, "مثلاً: 10% مقدم على 8 سنين", "e.g. 10% down over 8 years")}"></label>
  ${phases.length ? html`<label>${L(lang, "المرحلة", "Phase")} <select name="phase_id"><option value="">${L(lang, "كل المشروع", "Whole project")}</option>${phases.map((ph) => html`<option value="${ph.id}"${sel(pl.phase_id === ph.id)}>${ph.name}</option>`)}</select></label>` : ""}
  <div class="row">
    <label>${L(lang, "المقدم % *", "Down payment % *")} <input name="down_payment_pct" required inputmode="decimal" dir="ltr" size="4" value="${val(pl.down_payment_pct)}"></label>
    <label>${L(lang, "سنين (0 = كاش)", "Years (0 = cash)")} <input name="years" inputmode="decimal" dir="ltr" size="3" value="${val(pl.years)}"></label>
    <label>${L(lang, "القسط", "Installments")} <select name="frequency">${Catalogue.FREQUENCIES.map((f) => html`<option value="${f}"${sel((pl.frequency || "quarterly") === f)}>${label2(FREQ, f, lang)}</option>`)}</select></label>
    <label>${L(lang, "خصم %", "Discount %")} <input name="discount_pct" inputmode="decimal" dir="ltr" size="4" value="${val(pl.discount_pct)}"></label>
  </div>
  <fieldset><legend>${L(lang, "دفعات إضافية (اختياري)", "Milestones (optional)")}</legend>
    ${ms.map((m) => html`<div class="row"><input name="milestone_pct" inputmode="decimal" dir="ltr" size="4" placeholder="%" value="${val(m.pct)}" aria-label="%"><input name="milestone_months" inputmode="numeric" dir="ltr" size="4" placeholder="${L(lang, "بعد كام شهر", "after months")}" value="${val(m.due_after_months)}" aria-label="${L(lang, "بعد كام شهر", "After months")}"><input name="milestone_label" maxlength="60" placeholder="${L(lang, "مثلاً: عند الاستلام", "e.g. at delivery")}" value="${m.label || ""}" aria-label="${L(lang, "الوصف", "Label")}"></div>`)}
  </fieldset>
  <div class="row">
    <label>${L(lang, "الصيانة % (سيبها فاضية لو مش معروفة)", "Maintenance % (blank when unknown)")} <input name="maintenance_pct" inputmode="decimal" dir="ltr" size="4" value="${val(pl.maintenance_pct)}"></label>
    <label>${L(lang, "تتدفع", "Due")} <select name="maintenance_due">${Catalogue.MAINTENANCE_DUE.map((d) => html`<option value="${d}"${sel((pl.maintenance_due || "delivery") === d)}>${label2(DUE, d, lang)}</option>`)}</select></label>
    <label>${L(lang, "على كام دفعة", "In how many payments")} <input name="maintenance_splits" inputmode="numeric" dir="ltr" size="2" value="${val(pl.maintenance_splits)}"></label>
  </div>
  <fieldset><legend>${L(lang, "مصاريف ثابتة (نادي، جراج...)", "Fixed extra fees (club, parking...)")}</legend>
    ${fees.map((f) => html`<div class="row"><input name="fee_label" maxlength="60" placeholder="${L(lang, "البند", "Item")}" value="${f.label || ""}" aria-label="${L(lang, "البند", "Item")}"><input name="fee_amount" inputmode="numeric" dir="ltr" size="9" placeholder="${L(lang, "المبلغ ج.م", "Amount EGP")}" value="${val(f.amount)}" aria-label="${L(lang, "المبلغ", "Amount")}"></div>`)}
  </fieldset>
  <button type="submit">${pl.id ? L(lang, "حفظ النظام", "Save plan") : L(lang, "إضافة النظام", "Add plan")}</button>
</form>`;
}

function projectPage(lang, manager, data, developers, { notice = null } = {}) {
  const { project: p, developer: d, phases, plans, materials, units } = data;
  const base = `/app/catalogue/projects/${p.id}`;
  const phaseName = (id) => phases.find((x) => x.id === id)?.name;
  return html`<p><a href="/app/catalogue">‹ ${L(lang, "الكتالوج", "Catalogue")}</a></p>
<h1>🏗️ ${lang === "en" ? p.name_en || p.name : p.name}</h1>
${notice || ""}
<section class="card stack" id="details" data-project-status="${p.status}">
  <p>${label2(STATUS, p.status, lang)} · ${L(lang, "الاستلام", "Delivery")}: <span dir="ltr">${deliveryText(p, lang)}</span> · ${L(lang, "الصيانة", "Maintenance")}: ${pctText(p.maintenance_pct)}${p.archived_at ? html` · <strong>${L(lang, "مؤرشف", "Archived")}</strong>` : ""}</p>
  ${[p.district, p.city].filter(Boolean).length ? html`<p>📍 ${[p.district, p.city].filter(Boolean).join("، ")}</p>` : ""}
  <p>🏢 ${d ? d.name : "—"}${manager && d?.contact_name ? ` · ${d.contact_name}` : ""}${manager && d?.contact_phone ? html` · <a href="tel:${d.contact_phone}" dir="ltr" data-developer-contact>${d.contact_phone}</a>` : ""}</p>
  ${manager && p.notes ? html`<p class="muted">🔒 ${p.notes}</p>` : ""}
</section>
${manager ? html`<details class="card"><summary>✏️ ${L(lang, "تعديل المشروع", "Edit project")}</summary>${projectForm(lang, developers, p, base)}
  <form method="post" action="${base}/archive"><input type="hidden" name="archived" value="${p.archived_at ? "0" : "1"}"><button type="submit" class="secondary">${p.archived_at ? L(lang, "رجّعه من الأرشيف", "Restore") : L(lang, "أرشفة المشروع", "Archive project")}</button></form></details>` : ""}

<section class="card" id="phases">
  <h2>${L(lang, "المراحل", "Phases")}</h2>
  ${phases.length ? html`<ul>${phases.map((ph) => html`<li data-phase="${ph.id}">${ph.name} · ${label2(STATUS, ph.status, lang)} · <span dir="ltr">${deliveryText(ph, lang)}</span>${manager ? html` <form method="post" action="${base}/phases/${ph.id}/delete" class="inline"><button type="submit" class="link">${L(lang, "حذف", "Delete")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "مفيش مراحل (المشروع كله مرحلة واحدة).", "No phases (the whole project is one).")}</p>`}
  ${manager ? html`<form method="post" action="${base}/phases" class="row" data-phase-form>
    <input name="name" required maxlength="80" placeholder="${L(lang, "اسم المرحلة", "Phase name")}" aria-label="${L(lang, "اسم المرحلة", "Phase name")}">
    ${statusSelect("status", "selling", lang)}
    <input name="delivery_year" inputmode="numeric" dir="ltr" size="5" placeholder="${L(lang, "سنة الاستلام", "Delivery year")}" aria-label="${L(lang, "سنة الاستلام", "Delivery year")}">
    <input name="delivery_quarter" inputmode="numeric" dir="ltr" size="2" placeholder="Q" aria-label="${L(lang, "الربع", "Quarter")}">
    <button type="submit" class="secondary">${L(lang, "إضافة مرحلة", "Add phase")}</button></form>` : ""}
</section>

<section class="card" id="plans">
  <h2>💳 ${L(lang, "أنظمة السداد", "Payment plans")}</h2>
  <p class="muted">${L(lang, "النظام بيتطبق على كل وحدات المشروع (أو المرحلة) تلقائي، إلا الوحدة اللي ليها أنظمتها الخاصة.", "A plan applies to every unit of the project (or phase) automatically, except a unit with its own plans.")}</p>
  ${plans.length ? html`<ul>${plans.map((pl) => html`<li data-plan="${pl.id}"><strong>${pl.name}</strong>${pl.phase_id ? ` (${phaseName(pl.phase_id) || ""})` : ""}: ${planLine(pl, lang)}${manager ? html` · <a href="${base}/plans/${pl.id}">${L(lang, "تعديل", "Edit")}</a> <form method="post" action="${base}/plans/${pl.id}/delete" class="inline"><button type="submit" class="link">${L(lang, "حذف", "Delete")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش أنظمة سداد.", "No payment plans yet.")}</p>`}
</section>
${manager ? html`<details class="card"><summary>➕ ${L(lang, "نظام سداد جديد", "New payment plan")}</summary>${planForm(lang, p.id, phases)}</details>` : ""}

<section class="card" id="materials">
  <h2>📁 ${L(lang, "الملفات واللينكات", "Materials")}</h2>
  ${materials.length ? html`<ul>${materials.map((m) => html`<li data-material="${m.id}" data-client-visible="${m.client_visible ? "1" : "0"}">
    <a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.label}</a> · ${label2(KIND, m.kind, lang)}${m.unit_type ? ` · ${m.unit_type}` : ""} · ${m.client_visible ? L(lang, "👁️ بيظهر للعميل", "👁️ Client-visible") : L(lang, "🔒 داخلي", "🔒 Internal")}${m.check_status === "broken" ? html` · <strong data-broken>⚠️ ${L(lang, "مبقاش بيفتح", "Not opening")}</strong>` : ""}
    ${manager ? html`${m.kind === "price_sheet" ? "" : html`<form method="post" action="${base}/materials/${m.id}/visibility" class="inline"><input type="hidden" name="visible" value="${m.client_visible ? "0" : "1"}"><button type="submit" class="link">${m.client_visible ? L(lang, "خليه داخلي", "Make internal") : L(lang, "اعرضه للعميل", "Show to clients")}</button></form>`}
    <form method="post" action="${base}/materials/${m.id}/delete" class="inline"><button type="submit" class="link">${L(lang, "حذف", "Delete")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش لينكات.", "No links yet.")}</p>`}
  ${manager ? html`<form method="post" action="${base}/materials" class="stack" data-material-form>
    <div class="row">
      <input name="label" required maxlength="80" placeholder="${L(lang, "الاسم (مثلاً: بروشور المرحلة 2)", "Label (e.g. Phase 2 brochure)")}" aria-label="${L(lang, "الاسم", "Label")}">
      <select name="kind" aria-label="${L(lang, "النوع", "Type")}">${Catalogue.KINDS.map((k) => html`<option value="${k}">${label2(KIND, k, lang)}</option>`)}</select>
    </div>
    <input name="url" required type="url" dir="ltr" placeholder="https://" aria-label="${L(lang, "اللينك", "Link")}">
    <input name="unit_type" maxlength="60" placeholder="${L(lang, "نوع الوحدة (للمخطط، اختياري)", "Unit type (for a layout, optional)")}" aria-label="${L(lang, "نوع الوحدة", "Unit type")}">
    <label><input type="checkbox" name="client_visible" value="1"> ${L(lang, "يظهر للعميل", "Show to clients")}</label>
    <button type="submit" class="secondary">${L(lang, "إضافة لينك", "Add link")}</button>
    <p class="muted">${L(lang, "بنتأكد مرة في الأسبوع إن كل لينك لسه بيفتح ونبلغ المديرين لو واحد وقف.", "Once a week every link is checked and managers hear about broken ones.")}</p>
  </form>` : ""}
</section>

<section class="card" id="units">
  <h2>🏠 ${L(lang, "وحدات المشروع", "Project units")} (${units.length})</h2>
  ${units.length ? html`<ul>${units.map((u) => html`<li data-unit="${u.code}"><a href="/app/units/${encodeURIComponent(u.code)}">${u.code}</a>${u.developer_unit_code ? ` · ${u.developer_unit_code}` : ""}${u.phase_id ? ` · ${phaseName(u.phase_id) || ""}` : ""} · ${u.status}${manager ? html` <form method="post" action="${base}/units/${u.id}/unlink" class="inline"><button type="submit" class="link">${L(lang, "شيلها من المشروع", "Remove from project")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش وحدات مربوطة بالمشروع.", "No units linked yet.")}</p>`}
  ${manager ? html`<form method="post" action="${base}/units" class="stack" data-link-units>
    <label>${L(lang, "اربط وحدات بأكوادها (مسافة أو فاصلة بينهم)", "Link units by code (space or comma between)")} <input name="codes" required dir="ltr"></label>
    ${phases.length ? html`<label>${L(lang, "المرحلة", "Phase")} <select name="phase_id"><option value="">—</option>${phases.map((ph) => html`<option value="${ph.id}">${ph.name}</option>`)}</select></label>` : ""}
    <button type="submit" class="secondary">${L(lang, "ربط", "Link")}</button></form>` : ""}
</section>`;
}

function register(web, { pool, page }) {
  const forbidden = (req, res) => res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
  const notFound = (req, res) => res.status(404).type("text/plain").send(L(langOf(req), "مش موجود", "Not found"));
  const title = (lang) => L(lang, "كتالوج المطورين", "Developer catalogue");
  const SAVED = { 1: ["اتحفظ.", "Saved."], linked: ["الوحدات اتربطت.", "Units linked."] };
  const savedNotice = (req) => {
    const s = SAVED[req.query.saved];
    if (!s) return null;
    const lang = langOf(req);
    const missing = String(req.query.missing || "").trim();
    return html`${noticeOk(s[lang === "en" ? 1 : 0])}${missing ? noticeBad(`${L(lang, "الأكواد دي مش موجودة", "These codes were not found")}: ${missing}`) : ""}`;
  };

  const showList = async (req, res, notice = null, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const archived = req.query.archived === "1";
    const [projects, developers] = await Promise.all([Catalogue.listProjects(pool, actor, { archived }), Catalogue.listDevelopers(pool, actor)]);
    return page(req, res, { title: title(lang), body: listPage(lang, isManager(actor), { projects, developers, archived, notice: notice || savedNotice(req) }) }, status);
  };

  const showProject = async (req, res, notice = null, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    if (!data) return notFound(req, res);
    const developers = isManager(actor) ? await Catalogue.listDevelopers(pool, actor) : [];
    return page(req, res, { title: data.project.name, body: projectPage(lang, isManager(actor), data, developers, { notice: notice || savedNotice(req) }) }, status);
  };

  /** Runs a service write and answers: 403, 404, the page again with the error (400), or a redirect. */
  const write = (fn, { show, done }) => async (req, res) => {
    const r = await fn(req);
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return show(req, res, noticeBad(errorText(r, langOf(req))), 400);
    return res.redirect(303, done(req, r));
  };
  const projectUrl = (req, extra = "saved=1") => `/app/catalogue/projects/${req.params.id}?${extra}`;
  const actorOf = (req) => req.session.broker;

  web.get("/catalogue", (req, res) => showList(req, res));
  web.post("/catalogue/developers", write((req) => Catalogue.saveDeveloper(pool, actorOf(req), req.body), { show: showList, done: () => "/app/catalogue?saved=1" }));
  web.post("/catalogue/projects", write((req) => Catalogue.saveProject(pool, actorOf(req), req.body), { show: showList, done: (_req, r) => `/app/catalogue/projects/${r.project.id}?saved=1` }));

  const showDeveloper = async (req, res, notice = null, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const d = await Catalogue.getDeveloper(pool, actor, req.params.id);
    if (!d) return notFound(req, res);
    const projects = await Catalogue.listProjects(pool, actor, { developerId: d.id });
    return page(req, res, {
      title: d.name,
      body: html`<p><a href="/app/catalogue">‹ ${L(lang, "الكتالوج", "Catalogue")}</a></p><h1>🏢 ${d.name}</h1>${notice || savedNotice(req) || ""}
${developerForm(lang, d, `/app/catalogue/developers/${d.id}`)}
<section class="card"><h2>${L(lang, "مشاريعه", "Projects")}</h2>${projects.length ? html`<ul>${projects.map((p) => html`<li><a href="/app/catalogue/projects/${p.id}">${p.name}</a></li>`)}</ul>` : html`<p class="muted">—</p>`}</section>`
    }, status);
  };
  web.get("/catalogue/developers/:id", (req, res) => showDeveloper(req, res));
  web.post("/catalogue/developers/:id", write((req) => Catalogue.saveDeveloper(pool, actorOf(req), { ...req.body, id: req.params.id }), { show: showDeveloper, done: (req) => `/app/catalogue/developers/${req.params.id}?saved=1` }));

  web.get("/catalogue/projects/:id", (req, res) => showProject(req, res));
  web.post("/catalogue/projects/:id", write((req) => Catalogue.saveProject(pool, actorOf(req), { ...req.body, id: req.params.id }), { show: showProject, done: (req) => projectUrl(req) }));
  web.post("/catalogue/projects/:id/archive", write((req) => Catalogue.archiveProject(pool, actorOf(req), req.params.id, req.body.archived === "1"), { show: showProject, done: (req) => projectUrl(req) }));
  web.post("/catalogue/projects/:id/phases", write((req) => Catalogue.savePhase(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#phases` }));
  web.post("/catalogue/projects/:id/phases/:phaseId/delete", write((req) => Catalogue.deletePhase(pool, actorOf(req), req.params.id, req.params.phaseId), { show: showProject, done: (req) => `${projectUrl(req)}#phases` }));
  web.post("/catalogue/projects/:id/plans", write((req) => Catalogue.savePlan(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#plans` }));
  web.post("/catalogue/projects/:id/plans/:planId/delete", write((req) => Catalogue.deletePlan(pool, actorOf(req), req.params.id, req.params.planId), { show: showProject, done: (req) => `${projectUrl(req)}#plans` }));
  web.get("/catalogue/projects/:id/plans/:planId", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    const plan = data?.plans.find((pl) => pl.id === req.params.planId);
    if (!plan) return notFound(req, res);
    return page(req, res, {
      title: plan.name,
      body: html`<p><a href="/app/catalogue/projects/${data.project.id}#plans">‹ ${data.project.name}</a></p><h1>💳 ${plan.name}</h1>${planForm(lang, data.project.id, data.phases, plan)}`
    });
  });
  web.post("/catalogue/projects/:id/materials", write((req) => Catalogue.saveMaterial(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/materials/:mid/visibility", write((req) => Catalogue.setMaterialVisibility(pool, actorOf(req), req.params.id, req.params.mid, req.body.visible === "1"), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/materials/:mid/delete", write((req) => Catalogue.deleteMaterial(pool, actorOf(req), req.params.id, req.params.mid), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/units", write((req) => Catalogue.linkUnits(pool, actorOf(req), req.params.id, { codes: req.body.codes, phaseId: req.body.phase_id || null }), {
    show: showProject,
    done: (req, r) => `${projectUrl(req, `saved=linked${r.missing.length ? `&missing=${encodeURIComponent(r.missing.join(" "))}` : ""}`)}#units`
  }));
  web.post("/catalogue/projects/:id/units/:lid/unlink", write((req) => Catalogue.unlinkUnit(pool, actorOf(req), req.params.id, req.params.lid), { show: showProject, done: (req) => `${projectUrl(req)}#units` }));
}

module.exports = { register };
