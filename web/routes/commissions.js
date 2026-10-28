// web/routes/commissions.js — The developer commission tracker on the web (Release A, C8). Managers: every commission
// by state (overdue first), one commission's moves (claimable, claim with invoice number and link, payments, client
// registration, expected amount, cancel), a statement per developer (also as Excel), and each project's commission
// terms (termsSection on the project page). Brokers: their own share and the state, read only.
"use strict";

const Commissions = require("../../services/commissions");
const C = require("../../domain/commissionTracker");
const Commission = require("../../domain/commission");
const { isManager } = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => (n === null || n === undefined ? "—" : Commission.money(Number(n), lang));
const day = (d) => (d ? C.isoDay(d) : "—");
const dealLabel = (ref) => `D-${String(ref).padStart(4, "0")}`;

const ERRORS = {
  invoice_no: ["اكتب رقم الفاتورة.", "Enter the invoice number."],
  invoice_url: ["رابط الفاتورة لازم يبدأ بـ https://", "The invoice link must start with https://"],
  amount: ["المبلغ غلط.", "The amount is wrong."],
  registered_on: ["اكتب تاريخ التسجيل.", "Enter the registration date."],
  pct: ["النسبة من 0 لـ 20%.", "The rate is 0 to 20%."],
  tiers: ["الشرايح: عدد وحدات (1 أو أكتر) ونسبة لكل شريحة، لحد 5 شرايح، ومع النسبة بس.", "Tiers: a unit count (1 or more) and a rate each, up to 5, with a rate only."],
  claim_paid_pct: ["اكتب نسبة المدفوع اللي بعدها تتطالب.", "Enter the % paid that makes it claimable."],
  payment_days: ["أيام الدفع من 0 لـ 365.", "Payment days are 0 to 365."],
  registration_days: ["مدة التسجيل من 1 لـ 365 يوم.", "Registration lasts 1 to 365 days."],
  state: ["الخطوة دي مش متاحة في الحالة دي.", "That step isn't available in this state."],
  conflict: ["حد عدّل العمولة دي قبلك؛ افتحها تاني.", "Someone changed this commission first; open it again."]
};
const errText = (out, lang) => (ERRORS[out.field] || ERRORS[out.error] || ["مش مسموح.", "Not allowed."])[lang === "en" ? 1 : 0];

function badge(c, lang) {
  const late = c.overdue_days > 0 ? html` <span class="notice bad" data-overdue="${c.overdue_days}">⏰ ${L(lang, `متأخرة ${c.overdue_days} يوم`, `${c.overdue_days} days late`)}</span>` : "";
  return html`<span data-commission-status="${c.status}">${Commissions.statusWord(c.status, lang)}</span>${late}`;
}

/** The project page's commission terms card (managers). */
function termsSection(lang, projectId, terms, notice = "") {
  const t = terms || {};
  const tiers = [...(t.tiers || []), {}, {}].slice(0, Math.max(2, (t.tiers || []).length + 1));
  const opt = (v, label, cur) => html`<option value="${v}"${v === cur ? " selected" : ""}>${label}</option>`;
  return html`<section class="card stack" id="commission-terms">
  <h2>💸 ${L(lang, "شروط عمولة المطور", "Developer commission terms")}</h2>
  ${notice}
  <form method="post" action="/app/catalogue/projects/${projectId}/commission-terms" class="stack">
    <div class="row">
      <label>${L(lang, "النوع", "Type")} <select name="mode">${opt("pct", L(lang, "نسبة من السعر", "% of the price"), t.mode || "pct")}${opt("amount", L(lang, "مبلغ ثابت", "Fixed amount"), t.mode)}</select></label>
      <label>${L(lang, "النسبة %", "Rate %")} <input name="pct" inputmode="decimal" dir="ltr" size="5" value="${t.pct ?? ""}"></label>
      <label>${L(lang, "المبلغ", "Amount")} <input name="amount" inputmode="numeric" dir="ltr" size="10" value="${t.amount ?? ""}"></label>
    </div>
    <fieldset class="row"><legend>${L(lang, "شرايح السنة (من عدد وحدات → نسبة)", "Yearly tiers (from units sold → rate)")}</legend>
      ${tiers.map((x) => html`<span class="row"><input name="tier_min" inputmode="numeric" dir="ltr" size="3" placeholder="${L(lang, "وحدات", "units")}" value="${x.min_units ?? ""}"> → <input name="tier_pct" inputmode="decimal" dir="ltr" size="4" placeholder="%" value="${x.pct ?? ""}"></span>`)}
    </fieldset>
    <div class="row">
      <label>${L(lang, "تتطالب بعد", "Claimable after")} <select name="claim_trigger">${opt("contract", L(lang, "العقد", "the contract"), t.claim_trigger || "contract")}${opt("down_payment", L(lang, "دفع المقدم", "the down payment"), t.claim_trigger)}${opt("paid_pct", L(lang, "دفع نسبة من السعر", "a % of the price paid"), t.claim_trigger)}</select></label>
      <label>${L(lang, "نسبة المدفوع %", "% paid")} <input name="claim_paid_pct" inputmode="decimal" dir="ltr" size="4" value="${t.claim_paid_pct ?? ""}"></label>
      <label>${L(lang, "المطور بيدفع خلال (يوم)", "Developer pays within (days)")} <input name="payment_days" inputmode="numeric" dir="ltr" size="4" value="${t.payment_days ?? 60}"></label>
      <label>${L(lang, "تسجيل العميل صالح (يوم)", "Client registration valid (days)")} <input name="registration_days" inputmode="numeric" dir="ltr" size="4" value="${t.registration_days ?? ""}"></label>
    </div>
    <label>${L(lang, "ملاحظات", "Notes")} <textarea name="notes" rows="2" maxlength="1000">${t.notes || ""}</textarea></label>
    <p class="muted">${L(lang, "من غير ضريبة: المبالغ زي ما المطور بيدفعها. لو مفيش شروط، العمولة المتوقعة هي اللي في الصفقة.", "No VAT: amounts as the developer pays them. Without terms, the expected commission is the deal's.")}</p>
    <button type="submit" class="secondary">${L(lang, "حفظ الشروط", "Save the terms")}</button>
  </form>
</section>`;
}

function register(web, { pool, page }) {
  const forbidden = (req, res) => res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));

  web.get("/commissions", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const manager = isManager(actor);
    const status = C.STATUSES.includes(req.query.status) ? req.query.status : null;
    const overdue = req.query.overdue === "1";
    const rows = await Commissions.listCommissions(pool, actor, { status, overdue });
    const t = manager ? Commissions.totals(rows) : null;
    const devs = manager ? [...new Map(rows.filter((r) => r.developer_id).map((r) => [r.developer_id, r.developer_name])).entries()] : [];
    return page(req, res, {
      title: L(lang, "العمولات", "Commissions"),
      nav: "commissions",
      body: html`<h1>💸 ${L(lang, "عمولات المطورين", "Developer commissions")}</h1>
${manager ? html`<section class="card row" data-commission-totals>
  <span>${L(lang, "متوقع", "Expected")}: <strong>${money(t.expected, lang)}</strong></span>
  <span>${L(lang, "متطالب بيه", "Claimed")}: <strong>${money(t.claimed, lang)}</strong></span>
  <span>${L(lang, "اتدفع", "Paid")}: <strong>${money(t.paid, lang)}</strong></span>
  <span>${L(lang, "الباقي", "Outstanding")}: <strong>${money(t.outstanding, lang)}</strong></span>
  ${t.overdue ? html`<a class="notice bad" href="/app/commissions?overdue=1">⏰ ${L(lang, `${t.overdue} متأخرة`, `${t.overdue} overdue`)}</a>` : ""}
</section>` : ""}
<nav class="row">${[null, ...C.STATUSES].map((s) => html`<a class="btn ${s === status ? "" : "secondary"}" href="/app/commissions${s ? `?status=${s}` : ""}">${s ? Commissions.statusWord(s, lang) : L(lang, "الكل", "All")}</a>`)}</nav>
${devs.length ? html`<p class="muted">${L(lang, "كشف حساب:", "Statements:")} ${devs.map(([id, name], i) => html`${i ? " · " : ""}<a href="/app/commissions/developers/${id}">${name}</a>`)}</p>` : ""}
<section class="card">${rows.length
  ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الصفقة", "Deal")}</th><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "المطور", "Developer")}</th><th>${manager ? L(lang, "العمولة", "Commission") : L(lang, "نصيبك", "Your share")}</th><th>${L(lang, "الحالة", "Status")}</th>${manager ? html`<th>${L(lang, "ميعاد الدفع", "Due")}</th>` : ""}</tr></thead>
  <tbody>${rows.map((c) => html`<tr data-commission="${c.id}"><td>${manager ? html`<a href="/app/commissions/${c.id}">${dealLabel(c.deal_ref)}</a>` : dealLabel(c.deal_ref)}</td><td dir="ltr">${c.unit_code || "—"}</td><td>${c.developer_name || "—"}</td><td>${manager ? html`${money(c.expected_amount, lang)}${c.paid_amount ? html`<br><span class="muted">${L(lang, "اتدفع", "paid")} ${money(c.paid_amount, lang)}</span>` : ""}` : html`<span data-my-share>${money(c.my_share, lang)}</span>`}</td><td>${badge(c, lang)}</td>${manager ? html`<td dir="ltr">${day(c.due_on)}</td>` : ""}</tr>`)}</tbody></table></div>`
  : html`<p class="muted">${L(lang, "لسه مفيش عمولات مطورين. أي صفقة على وحدة من الكتالوج بتظهر هنا.", "No developer commissions yet. Any deal on a catalogue unit shows up here.")}</p>`}</section>`
    });
  });

  web.get("/commissions/developers/:id", async (req, res, next) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const st = await Commissions.statement(pool, actor, req.params.id);
    if (st.error) return next();
    if (req.query.format === "xlsx") {
      const buf = await Commissions.statementWorkbook(st, lang);
      return res
        .set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="commission-statement.xlsx"' })
        .send(Buffer.from(buf));
    }
    return page(req, res, {
      title: st.developer.name,
      nav: "commissions",
      body: html`<h1>📄 ${L(lang, "كشف عمولات", "Commission statement")}: ${st.developer.name}</h1>
<p class="row"><a href="/app/commissions">${L(lang, "رجوع للعمولات", "Back to commissions")}</a> <a class="btn secondary" href="/app/commissions/developers/${st.developer.id}?format=xlsx" data-statement-xlsx>⬇️ Excel</a></p>
<section class="card row" data-statement-totals="${st.totals.outstanding}">
  <span>${L(lang, "متوقع", "Expected")}: <strong>${money(st.totals.expected, lang)}</strong></span>
  <span>${L(lang, "اتدفع", "Paid")}: <strong>${money(st.totals.paid, lang)}</strong></span>
  <span>${L(lang, "الباقي", "Outstanding")}: <strong>${money(st.totals.outstanding, lang)}</strong></span>
</section>
<section class="card"><div class="scroll"><table><thead><tr><th>${L(lang, "الصفقة", "Deal")}</th><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "المشروع", "Project")}</th><th>${L(lang, "العمولة", "Commission")}</th><th>${L(lang, "الحالة", "Status")}</th><th>${L(lang, "الفاتورة", "Invoice")}</th><th>${L(lang, "ميعاد الدفع", "Due")}</th><th>${L(lang, "المدفوع", "Paid")}</th></tr></thead>
<tbody>${st.rows.map((c) => html`<tr><td><a href="/app/commissions/${c.id}">${dealLabel(c.deal_ref)}</a></td><td dir="ltr">${c.unit_code || "—"}</td><td>${c.project_name || "—"}</td><td>${money(c.expected_amount, lang)}</td><td>${badge(c, lang)}</td><td dir="ltr">${c.invoice_url ? html`<a href="${c.invoice_url}" target="_blank" rel="noopener noreferrer">${c.invoice_no || "🔗"}</a>` : c.invoice_no || "—"}</td><td dir="ltr">${day(c.due_on)}</td><td>${money(c.paid_amount, lang)}</td></tr>`)}</tbody></table></div></section>`
    });
  });

  const showOne = async (req, res, notice = "", status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const c = await Commissions.getCommission(pool, actor, req.params.id);
    if (!c) return res.status(404).type("text/plain").send(L(lang, "مش موجود", "Not found"));
    const base = `/app/commissions/${c.id}`;
    const form = (action, inner, label, cls = "secondary") =>
      html`<form method="post" action="${base}" class="row"><input type="hidden" name="action" value="${action}"><input type="hidden" name="version" value="${c.version}">${inner}<button type="submit" class="${cls}" data-commission-action="${action}">${label}</button></form>`;
    const open = C.OPEN.includes(c.status);
    return page(req, res, {
      title: dealLabel(c.deal_ref),
      nav: "commissions",
      body: html`<h1>💸 ${dealLabel(c.deal_ref)} · ${c.unit_code || ""}</h1>
${notice}
<section class="card">
  <p>${c.developer_name || "—"} · ${c.project_name || "—"} · ${L(lang, "السعر", "Price")} ${money(c.price, lang)}</p>
  <p>${L(lang, "العمولة المتوقعة", "Expected commission")}: <strong>${money(c.expected_amount, lang)}</strong>${c.rate_pct ? ` (${Number(c.rate_pct)}%)` : ""} · ${badge(c, lang)}</p>
  ${c.invoice_no ? html`<p>${L(lang, "فاتورة", "Invoice")} <span dir="ltr">${c.invoice_no}</span>${c.invoice_url ? html` · <a href="${c.invoice_url}" target="_blank" rel="noopener noreferrer">🔗</a>` : ""} · ${L(lang, "ميعاد الدفع", "Due")} <span dir="ltr">${day(c.due_on)}</span></p>` : ""}
  ${(c.payments || []).length ? html`<ul>${c.payments.map((p) => html`<li dir="ltr">${p.on}: ${money(p.amount, lang)}</li>`)}</ul>` : ""}
  ${c.client_registered_on ? html`<p>📝 ${L(lang, "تسجيل العميل", "Client registered")} <span dir="ltr">${day(c.client_registered_on)}</span>${c.registration_expires_on ? html` · ${L(lang, "صالح لحد", "valid until")} <span dir="ltr">${day(c.registration_expires_on)}</span>` : ""}</p>` : ""}
</section>
<section class="card stack">
  ${c.status === "expected" ? form("claimable", "", `✅ ${L(lang, "بقت جاهزة للمطالبة", "Mark claimable")}`) : ""}
  ${["expected", "claimable"].includes(c.status) ? form("claim", html`<input name="invoice_no" required maxlength="60" placeholder="${L(lang, "رقم الفاتورة", "Invoice no.")}" dir="ltr" size="10"><input name="invoice_url" placeholder="https://" dir="ltr" size="20"><input type="date" name="claimed_on">`, `🧾 ${L(lang, "اتطالب", "Claim")}`) : ""}
  ${open ? form("payment", html`<input name="amount" required inputmode="numeric" dir="ltr" size="10" placeholder="${L(lang, "المبلغ", "Amount")}"><input type="date" name="paid_on">`, `💰 ${L(lang, "سجّل دفعة", "Record a payment")}`) : ""}
  ${form("registration", html`<input type="date" name="registered_on" required value="${c.client_registered_on ? day(c.client_registered_on) : ""}">`, `📝 ${L(lang, "تاريخ تسجيل العميل", "Client registration date")}`)}
  ${form("expected", html`<input name="amount" required inputmode="numeric" dir="ltr" size="10" value="${c.expected_amount}">`, `✏️ ${L(lang, "عدّل المتوقع", "Correct the expected amount")}`)}
  ${c.status === "cancelled" ? form("reopen", "", L(lang, "رجّعها", "Reopen")) : c.status !== "paid" ? form("cancel", "", `❌ ${L(lang, "إلغاء", "Cancel")}`) : ""}
</section>
<p><a href="/app/commissions">${L(lang, "رجوع للعمولات", "Back to commissions")}</a>${c.developer_id ? html` · <a href="/app/commissions/developers/${c.developer_id}">${L(lang, "كشف المطور", "Developer statement")}</a>` : ""}</p>`
    }, status);
  };

  web.get("/commissions/:id", (req, res) => showOne(req, res));

  web.post("/commissions/:id", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const out = await Commissions.move(pool, actor, req.params.id, String(req.body.action || ""), req.body);
    if (out.error === "forbidden") return forbidden(req, res);
    if (out.error === "not_found") return res.status(404).type("text/plain").send(L(lang, "مش موجود", "Not found"));
    if (out.error) return showOne(req, res, html`<p class="notice bad card" data-commission-error="${out.field || out.error}">${errText(out, lang)}</p>`, out.error === "conflict" ? 409 : 400);
    return res.redirect(303, `/app/commissions/${req.params.id}`);
  });

  web.post("/catalogue/projects/:id/commission-terms", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const out = await Commissions.saveTerms(pool, actor, req.params.id, req.body);
    if (out.error === "forbidden") return forbidden(req, res);
    if (out.error === "not_found") return res.status(404).type("text/plain").send(L(lang, "مش موجود", "Not found"));
    if (out.error) {
      return page(req, res, { title: L(lang, "شروط العمولة", "Commission terms"), body: termsSection(lang, req.params.id, req.body, html`<p class="notice bad" data-terms-error="${out.field}">${errText(out, lang)}</p>`) }, 400);
    }
    return res.redirect(303, `/app/catalogue/projects/${req.params.id}?saved=1#commission-terms`);
  });
}

module.exports = { register, termsSection };
