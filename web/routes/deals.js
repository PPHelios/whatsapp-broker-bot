// web/routes/deals.js — Deals on the web (Release 3 step 10): the list with the month's totals (managers: the agency's;
// a broker: their own share), recording a deal (from the lead page's "🤝 Record deal"), and a deal's page where the
// closing broker moves its status and a manager corrects the money. Writes go through services/deals.js with the
// version the page was opened at; a form saves once (its idem token).
"use strict";

const crypto = require("crypto");
const Deals = require("../../services/deals");
const Leads = require("../../services/leads");
const Card = require("../../domain/leadCard");
const Commission = require("../../domain/commission");
const { parseCommission } = require("../../lib/deals");
const T = require("../../lib/text");
const { isManager, canEditDeal } = require("../../lib/authz");
const { html } = require("../html");
const { dealsSwitch } = require("../views/tabs");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => Commission.money(n, lang);
const when = (d) => new Date(d).toISOString().slice(0, 10);

const ERRORS = {
  lead_not_found: ["العميل مش موجود أو مش معاك.", "Lead not found or not yours."],
  forbidden: ["مش مسموح.", "Not allowed."],
  unit_not_found: ["كود الوحدة مش موجود.", "Unit code not found."],
  unit_not_active: ["الوحدة مش متاحة.", "The unit isn't active."],
  unit_not_yours: ["الوحدة مش بتاعتك؛ شيل علامة «اتباعت».", "The unit isn't yours; untick \"mark sold\"."],
  unit_conflict: ["الوحدة اتعدلت من مكان تاني؛ الصفقة متسجلتش. راجع وابعت تاني.", "The unit changed elsewhere; the deal wasn't saved. Check and send again."],
  price: ["اكتب السعر.", "Enter the price."],
  commission_missing: ["اكتب العمولة: نسبة (2%) أو مبلغ.", "Enter the commission: a % (2%) or an amount."],
  commission_pct: ["نسبة العمولة لازم تبقى بين 0 و 100.", "The commission % must be between 0 and 100."],
  commission_amount: ["مبلغ العمولة غلط.", "The commission amount is wrong."],
  commission_over_price: ["العمولة أكبر من السعر.", "The commission is more than the price."],
  external_over_total: ["نصيب الوسيط الخارجي أكبر من العمولة.", "The external share is more than the commission."],
  external_pct: ["نسبة الوسيط الخارجي غلط.", "The external % is wrong."],
  split_pct: ["نسبة الزميل لازم تبقى بين 0 و 100.", "The colleague's % must be between 0 and 100."],
  split_total: ["التقسيم لازم يسيب نصيب للي قفل الصفقة.", "The split must leave a share for the closing broker."],
  split_duplicate: ["الزميل متكرر.", "The colleague is listed twice."],
  broker_not_found: ["الوسيط مش موجود.", "Broker not found."],
  status: ["حالة غير معروفة.", "Unknown status."],
  not_found: ["مش موجود.", "Not found."]
};
const errorText = (code, lang) => (ERRORS[code] || [code, code])[lang === "en" ? 1 : 0];

async function colleagues(pool, broker) {
  const { rows } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [broker.agency_id]);
  return rows;
}

/** Form fields → services/deals.js input. */
function inputOf(body, broker) {
  const commission = parseCommission(String(body.commission || "")) || {};
  const extText = String(body.external || "").trim();
  const extPct = Commission.parsePct(extText);
  const extAmount = !extPct && extText ? T.parseEgyptianPrice(T.normalizeDigits(extText))?.priceValue || null : null;
  const external = extPct ? { pct: extPct.pct, name: body.external_name } : extAmount ? { amount: extAmount, name: body.external_name } : null;
  const price = String(body.price || "").trim() ? T.parseEgyptianPrice(T.normalizeDigits(String(body.price)))?.priceValue || -1 : null;
  const splitPct = Number(String(body.split_pct || "").replace(/[%٪\s]/g, ""));
  return {
    leadKey: String(body.lead || "").trim(),
    unitCode: String(body.unit || "").trim() || null,
    price,
    mode: commission.mode,
    pct: commission.pct,
    amount: commission.amount,
    external,
    splits: body.split_with ? [{ brokerId: body.split_with, pct: splitPct }] : [],
    dealType: body.deal_type,
    status: body.status,
    markSold: body.mark_sold === "1",
    notes: body.notes,
    closingBrokerId: isManager(broker) && body.closing_broker ? body.closing_broker : null
  };
}

function register(web, { pool, page }) {
  /* The list and the month's totals */
  web.get("/deals", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const n = Math.max(0, parseInt(req.query.page, 10) || 0);
    const { rows, more } = await Deals.listDeals(pool, broker, { status: req.query.status, offset: n * 20 });
    const totals = await Deals.monthlyTotals(pool, broker);
    return page(req, res, {
      title: L(lang, "الصفقات", "Deals"),
      nav: "deals",
      body: html`<h1>🤝 ${L(lang, "الصفقات", "Deals")}</h1>
${dealsSwitch(lang, "/app/deals")}
<p><a class="btn secondary" href="/app/commissions" data-commissions-link>💸 ${L(lang, "عمولات المطورين", "Developer commissions")}</a></p>
<section class="card" id="totals"><h2>📊 ${manager ? L(lang, "إجمالي الشهور", "Monthly totals") : L(lang, "نصيبك كل شهر", "Your share per month")}</h2>
${totals.length
  ? html`<table class="table"><thead><tr><th>${L(lang, "الشهر", "Month")}</th><th>${L(lang, "صفقات", "Deals")}</th>${manager
      ? html`<th>${L(lang, "حجم المبيعات", "Volume")}</th><th>${L(lang, "العمولة", "Commission")}</th><th>${L(lang, "خارجي", "External")}</th><th>${L(lang, "للوكالة", "Agency")}</th>`
      : html`<th>${L(lang, "نصيبك", "Your share")}</th>`}</tr></thead><tbody>${totals.map(
      (t) => html`<tr><td>${t.month}</td><td>${t.deals}</td>${manager
        ? html`<td>${money(t.volume, lang)}</td><td>${money(t.commission, lang)}</td><td>${money(t.external, lang)}</td><td>${money(t.agency, lang)}</td>`
        : html`<td>${money(t.mine, lang)}</td>`}</tr>`
    )}</tbody></table>`
  : html`<p class="muted">${L(lang, "مفيش صفقات لسه.", "No deals yet.")}</p>`}
</section>
${rows.length
  ? html`<ul class="list">${rows.map(
      (d) => html`<li class="card"><a href="/app/deals/${Deals.refLabel(d.ref)}"><strong>${Deals.refLabel(d.ref)}</strong></a> · ${d.unit_code || "—"} · ${d.client_name || (d.lead_ref ? Card.refLabel(d.lead_ref) : "—")}
  <div class="muted">${when(d.closed_at)} · ${money(d.price, lang)} · ${Deals.statusLabel(d.status, lang)}${manager ? html` · ${d.closing_broker_name} · ${L(lang, "عمولة", "commission")} ${money(d.commission_total, lang)}` : ""}${d.my_share != null ? html` · ${L(lang, "نصيبك", "your share")} ${money(d.my_share, lang)}` : ""}</div></li>`
    )}</ul>
<p class="row">${n > 0 ? html`<a href="/app/deals?page=${n - 1}">${L(lang, "→ الأحدث", "← Newer")}</a>` : ""} ${more ? html`<a href="/app/deals?page=${n + 1}">${L(lang, "الأقدم ←", "Older →")}</a>` : ""}</p>`
  : ""}
<p class="muted">${L(lang, "تسجل الصفقة من صفحة العميل (🤝 سجل صفقة) أو للبوت: صفقة L-0042 VIL-08 8.5 مليون عمولة 2%", "Record a deal from the lead's page (🤝 Record deal) or to the bot: deal L-0042 VIL-08 8.5M commission 2%")}</p>`
    });
  });

  /* Recording a deal */
  /** Suggestions for the client and unit boxes: the broker's open leads and active units (a manager's: the agency's). */
  async function pickers(db, broker) {
    const { rows } = await Leads.listLeads(db, broker, { limit: 100 });
    const leads = rows.filter((x) => !["won", "lost"].includes(x.stage));
    const units = (
      await db.query(
        `SELECT code, title, compound, location, price_display FROM listings
          WHERE agency_id = $1 AND status = 'active' AND ($2::uuid IS NULL OR broker_id = $2) ORDER BY updated_at DESC LIMIT 200`,
        [broker.agency_id, isManager(broker) ? null : broker.id]
      )
    ).rows;
    return { leads, units };
  }

  async function form(req, res, { values = {}, notice = null, status = 200 } = {}) {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const team = await colleagues(pool, broker);
    const v = { lead: req.query.lead || "", unit: req.query.unit || "", mark_sold: "1", ...values };
    const lead = v.lead ? await Leads.getLead(pool, broker, v.lead) : null;
    const picks = await pickers(pool, broker);
    return page(req, res, {
      title: L(lang, "صفقة جديدة", "New deal"),
      nav: "deals",
      body: html`<h1>🤝 ${L(lang, "صفقة جديدة", "New deal")}</h1>
${notice ? html`<div class="card notice bad" role="alert">⚠️ ${notice}</div>` : ""}
<form method="post" action="/app/deals/new" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="idem" value="${v.idem || crypto.randomBytes(8).toString("hex")}">
  <label>${L(lang, "العميل (L-…)", "Client (L-…)")}<input name="lead" required dir="ltr" value="${v.lead}" list="deal-leads" autocomplete="off" placeholder="${L(lang, "اكتب الاسم أو L-…", "Type a name or L-…")}"></label>
  <datalist id="deal-leads">${picks.leads.map((x) => html`<option value="${Card.refLabel(x.ref)}">${Card.displayName(x, lang)}</option>`)}</datalist>
  ${lead ? html`<p class="muted">👤 ${Card.displayName(lead, lang)}</p>` : ""}
  <label>${L(lang, "كود الوحدة", "Unit code")}<input name="unit" dir="ltr" value="${v.unit}" list="deal-units" autocomplete="off"></label>
  <datalist id="deal-units">${picks.units.map((u) => html`<option value="${u.code}">${[u.title || u.compound || u.location, u.price_display].filter(Boolean).join(" · ")}</option>`)}</datalist>
  <label>${L(lang, "النوع", "Type")}<select name="deal_type"><option value="">${L(lang, "زي الوحدة", "As the unit")}</option><option value="sale"${v.deal_type === "sale" ? html` selected` : ""}>${L(lang, "بيع", "Sale")}</option><option value="rent"${v.deal_type === "rent" ? html` selected` : ""}>${L(lang, "إيجار", "Rent")}</option></select></label>
  <label>${L(lang, "السعر (فاضي = سعر الوحدة)", "Price (empty = the unit's price)")}<input name="price" inputmode="decimal" value="${v.price || ""}" placeholder="${L(lang, "8.5 مليون", "8.5M")}"></label>
  <label>${L(lang, "العمولة: نسبة أو مبلغ", "Commission: a % or an amount")}<input name="commission" required value="${v.commission || ""}" placeholder="2% / 170000"></label>
  <fieldset><legend>${L(lang, "وسيط خارجي (اختياري)", "External co-broker (optional)")}</legend>
    <label>${L(lang, "نصيبه: نسبة من العمولة أو مبلغ", "Their share: a % of the commission or an amount")}<input name="external" value="${v.external || ""}" placeholder="10% / 20000"></label>
    <label>${L(lang, "اسمه", "Name")}<input name="external_name" maxlength="120" value="${v.external_name || ""}"></label>
  </fieldset>
  <fieldset><legend>${L(lang, "تقسيم مع زميل (اختياري)", "Split with a colleague (optional)")}</legend>
    <label>${L(lang, "الزميل", "Colleague")}<select name="split_with"><option value="">—</option>${team
      .filter((b) => b.id !== broker.id)
      .map((b) => html`<option value="${b.id}"${v.split_with === b.id ? html` selected` : ""}>${b.name}</option>`)}</select></label>
    <label>${L(lang, "نصيبه % (الباقي ليك)", "Their % (the rest is yours)")}<input name="split_pct" inputmode="decimal" value="${v.split_pct || ""}" placeholder="40"></label>
  </fieldset>
  ${manager
    ? html`<label>${L(lang, "اللي قفل الصفقة", "Closing broker")}<select name="closing_broker">${team.map((b) => html`<option value="${b.id}"${(v.closing_broker || broker.id) === b.id ? html` selected` : ""}>${b.name}</option>`)}</select></label>`
    : ""}
  <label>${L(lang, "الحالة", "Status")}<select name="status">${["pending", "signed", "paid"].map((s) => html`<option value="${s}"${v.status === s ? html` selected` : ""}>${Deals.statusLabel(s, lang)}</option>`)}</select></label>
  <label class="check"><input type="checkbox" name="mark_sold" value="1"${v.mark_sold === "1" ? html` checked` : ""}> ${L(lang, "علّم الوحدة اتباعت (لو بتاعتك)", "Mark the unit sold (if it's yours)")}</label>
  <label>${L(lang, "ملاحظات", "Notes")}<textarea name="notes" maxlength="1000">${v.notes || ""}</textarea></label>
  <p class="muted">${L(lang, "العميل هيتعلم «اتقفلت ✅». الصفقة مش بتتلغي من هنا؛ المدير يقدر يصححها.", "The lead becomes Won ✅. A deal can't be undone here; a manager can correct it.")}</p>
  <button type="submit">💾 ${L(lang, "سجل الصفقة", "Save the deal")}</button>
</form>`
    }, status);
  }

  web.get("/deals/new", (req, res) => form(req, res));

  web.post("/deals/new", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const input = inputOf(req.body, broker);
    if (!input.mode) return form(req, res, { values: req.body, notice: errorText("commission_missing", lang), status: 422 });
    const idem = /^[0-9a-f]{16}$/.test(String(req.body.idem || "")) ? `web:${broker.id}:${req.body.idem}` : null;
    const r = await Deals.createDeal(pool, broker, input, { idemKey: idem });
    if (r.ok) return res.redirect(303, `/app/deals/${Deals.refLabel(r.deal.ref)}?saved=1`);
    return form(req, res, { values: req.body, notice: errorText(r.error, lang), status: r.error === "forbidden" ? 403 : r.error === "unit_conflict" ? 409 : 422 });
  });

  /* A deal's page */
  async function dealPage(req, res, deal, { notice = null, status = 200 } = {}) {
    const lang = langOf(req);
    const { broker } = req.session;
    const manager = isManager(broker);
    const editable = canEditDeal(broker, deal);
    const hidden = html`<input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="version" value="${deal.version}">`;
    return page(req, res, {
      title: `${Deals.refLabel(deal.ref)} · ${L(lang, "صفقة", "Deal")}`,
      nav: "deals",
      body: html`${notice ? html`<div class="card notice${status >= 400 ? " bad" : ""}" role="status">${notice}</div>` : ""}
<h1>🤝 ${Deals.refLabel(deal.ref)} · ${Deals.statusLabel(deal.status, lang)}</h1>
<section class="card">
  <p>👤 ${deal.client_name || "—"}${deal.lead_ref ? html` · <a href="/app/leads/${Card.refLabel(deal.lead_ref)}">${Card.refLabel(deal.lead_ref)}</a>` : ""}</p>
  <p>🏠 ${deal.unit_code || "—"} · ${deal.deal_type === "rent" ? L(lang, "إيجار", "Rent") : L(lang, "بيع", "Sale")} · ${when(deal.closed_at)}</p>
  <p>💰 ${L(lang, "السعر", "Price")}: ${money(deal.price, lang)}</p>
  ${manager
    ? html`<p>💼 ${L(lang, "العمولة", "Commission")}: ${deal.commission_mode === "pct" ? `${Number(deal.commission_pct)}% = ` : ""}${money(deal.commission_total, lang)}${Number(deal.external_share) ? html` · 🤝 ${L(lang, "خارجي", "External")}${deal.external_name ? ` (${deal.external_name})` : ""}: ${money(deal.external_share, lang)}` : ""}</p>`
    : ""}
  <ul>${deal.shares.map((s) => html`<li>👥 ${s.name}: ${Number(s.pct)}% = ${money(s.amount, lang)}</li>`)}</ul>
  <p class="muted">🧑‍💼 ${deal.closing_broker_name}</p>
  ${deal.notes ? html`<p>📝 ${deal.notes}</p>` : ""}
</section>
${editable
  ? html`<section class="card" id="status"><h2>${L(lang, "الحالة", "Status")}</h2>
  <form method="post" action="/app/deals/${Deals.refLabel(deal.ref)}" class="row">${hidden}
    <select name="status">${Deals.STATUSES.map((s) => html`<option value="${s}"${s === deal.status ? html` selected` : ""}>${Deals.statusLabel(s, lang)}</option>`)}</select>
    <button type="submit">${L(lang, "حفظ", "Save")}</button>
  </form></section>`
  : ""}
${manager
  ? html`<section class="card" id="correct"><h2>✏️ ${L(lang, "تصحيح (للمدير)", "Correct (managers)")}</h2>
  <form method="post" action="/app/deals/${Deals.refLabel(deal.ref)}" class="stack">${hidden}
    <label>${L(lang, "السعر", "Price")}<input name="price" value="${Number(deal.price)}"></label>
    <label>${L(lang, "العمولة: نسبة أو مبلغ", "Commission: a % or an amount")}<input name="commission" value="${deal.commission_mode === "pct" ? `${Number(deal.commission_pct)}%` : Number(deal.commission_total)}"></label>
    <label>${L(lang, "وسيط خارجي: نسبة أو مبلغ", "External: a % or an amount")}<input name="external" value="${Number(deal.external_share) || ""}"></label>
    <button type="submit">${L(lang, "صحح", "Correct")}</button>
  </form></section>`
  : ""}`
    }, status);
  }

  web.get("/deals/:ref", async (req, res, next) => {
    const deal = await Deals.getDeal(pool, req.session.broker, req.params.ref);
    if (!deal) return next();
    return dealPage(req, res, deal, { notice: req.query.saved ? L(langOf(req), "✅ الصفقة اتسجلت.", "✅ Deal saved.") : req.query.done ? L(langOf(req), "✅ اتحفظ.", "✅ Saved.") : null });
  });

  web.post("/deals/:ref", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const deal = await Deals.getDeal(pool, broker, req.params.ref);
    if (!deal) return next();
    const change = {};
    if (req.body.status !== undefined) change.status = req.body.status;
    if (req.body.commission !== undefined) {
      const c = parseCommission(String(req.body.commission || ""));
      if (!c) return dealPage(req, res, deal, { notice: `⚠️ ${errorText("commission_missing", lang)}`, status: 422 });
      Object.assign(change, c);
      const price = T.parseEgyptianPrice(T.normalizeDigits(String(req.body.price || "")))?.priceValue;
      if (price) change.price = price;
      const ext = String(req.body.external || "").trim();
      const pct = Commission.parsePct(ext);
      change.external = pct ? { pct: pct.pct } : { amount: ext ? T.parseEgyptianPrice(T.normalizeDigits(ext))?.priceValue || 0 : 0 };
    }
    const r = await Deals.updateDeal(pool, broker, deal.id, change, { version: req.body.version });
    if (r.ok || r.unchanged) return res.redirect(303, `/app/deals/${Deals.refLabel(deal.ref)}?done=1`);
    const fresh = (await Deals.getDeal(pool, broker, deal.id)) || deal;
    if (r.conflict) return dealPage(req, res, fresh, { notice: L(lang, "⚠️ الصفقة اتعدلت من مكان تاني. دي آخر نسخة؛ عيد التعديل.", "⚠️ The deal changed elsewhere. This is the latest version; make your change again."), status: 409 });
    if (r.error === "forbidden") return res.status(403).send(L(lang, "مش مسموح.", "Not allowed."));
    return dealPage(req, res, fresh, { notice: `⚠️ ${errorText(r.error, lang)}`, status: 422 });
  });
}

module.exports = { register };
