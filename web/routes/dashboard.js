// web/routes/dashboard.js — The agency dashboard and leaderboard (7.2, managers: /app/dashboard) and the owner's tracking
// dashboard (5.4, OWNER_BROKER_IDS only: /app/owner; everyone else gets the ordinary 404). Numbers only: no client's name
// or phone appears on either page. Queries live in services/dashboards.js. The owner page also switches PDF and photo
// price-list reading on per agency with its monthly pages (Release B C5).
"use strict";

const PriceReading = require("../../services/priceReading");
const Assistant = require("../../services/assistant");
const Leases = require("../../services/leases");
const Reading = require("../../domain/priceReading");
const Dash = require("../../services/dashboards");
const Stages = require("../../domain/leadStages");
const Commission = require("../../domain/commission");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Signup = require("../../services/signup");
const Plans = require("../../domain/plans");
const Phone = require("../../domain/phone");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => Commission.money(n, lang);
const minutes = (m, lang) => {
  if (m === null || m === undefined) return "—";
  if (m < 60) return L(lang, `${m} د`, `${m} min`);
  if (m < 48 * 60) return L(lang, `${Math.round(m / 60)} س`, `${Math.round(m / 60)} h`);
  return L(lang, `${Math.round(m / 1440)} يوم`, `${Math.round(m / 1440)} d`);
};
const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}`;
const notFound = (req, res, page) =>
  page(req, res, { title: L(langOf(req), "غير موجود", "Not found"), body: html`<div class="card"><h1>🔍 ${L(langOf(req), "الصفحة غير موجودة", "Page not found")}</h1><p><a href="/app/">${L(langOf(req), "الرئيسية", "Home")}</a></p></div>` }, 404);

/** N4: rented units whose lease ends in the next 90 days. */
function leaseEnds(rows, lang) {
  return html`<section class="card" id="lease-ends">
  <h2>🔑 ${L(lang, "عقود إيجار بتخلص خلال 90 يوم", "Leases ending in the next 90 days")}</h2>
  ${rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "بتخلص", "Ends")}</th><th>${L(lang, "المستأجر", "Tenant")}</th><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "الإيجار", "Rent")}</th></tr></thead>
  <tbody>${rows.map((r) => html`<tr data-lease-end="${r.code}"><td><a href="/app/units/${encodeURIComponent(r.code)}#lease">${r.code}</a></td><td dir="ltr">${r.end.toISOString().slice(0, 10)}</td><td>${r.tenant_name || "—"}</td><td>${r.broker_name || "—"}${r.remind ? " 🔔" : ""}</td><td>${r.rent ? money(r.rent, lang) : "—"}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش. سجّل عقد الإيجار من صفحة الوحدة المؤجرة.", "None. Enter a lease on the rented unit's page.")}</p>`}
</section>`;
}

function agencyPage(d, lang) {
  const tile = (label, value, attr) => html`<div class="card tile" data-kpi="${attr}"><div class="muted">${label}</div><strong>${value}</strong></div>`;
  return html`<h1>📈 ${L(lang, "لوحة الوكالة", "Agency dashboard")}</h1>
<p><a class="btn secondary" href="/app/sources">📣 ${L(lang, "مصادر العملاء وتكلفة الإعلانات", "Lead sources and ad cost")}</a></p>
<nav class="row" aria-label="${L(lang, "الفترة", "Period")}">${Dash.PERIODS.map(
    (p) => html`<a class="btn ${p === d.days ? "" : "secondary"}" href="/app/dashboard?days=${p}"${p === d.days ? html` aria-current="page"` : ""}>${L(lang, `${p} يوم`, `${p} days`)}</a>`
  )}</nav>
<div class="grid">
  ${tile(L(lang, "عملاء جداد", "New leads"), d.leads, "leads")}
  ${tile(L(lang, "صفقات", "Deals"), d.deals.n, "deals")}
  ${tile(L(lang, "العمولة", "Commission"), money(d.deals.commission, lang), "commission")}
  ${tile(L(lang, "لسه محدش كلمهم", "Not contacted yet"), d.uncontacted, "uncontacted")}
  ${tile(L(lang, "متابعات متأخرة", "Overdue follow-ups"), d.overdue, "overdue")}
  ${tile(L(lang, "من غير بروكر", "Unassigned"), d.unassigned, "unassigned")}
  ${tile(L(lang, "وحدات متاحة", "Active units"), d.units.active, "units")}
  ${tile(L(lang, "محتاجة تأكيد (21 يوم)", "To confirm (21 days)"), d.units.stale, "stale")}
</div>
<section class="card">
  <h2>${L(lang, "المراحل دلوقتي", "Pipeline now")}</h2>
  <table><tbody>${Stages.STAGES.map((s) => html`<tr data-stage="${s}"><td>${Stages.stageLabel(s, lang)}</td><td>${d.pipeline[s]}</td></tr>`)}</tbody></table>
</section>
<section class="card">
  <h2>🏆 ${L(lang, `ترتيب البروكرز (آخر ${d.days} يوم)`, `Leaderboard (last ${d.days} days)`)}</h2>
  ${d.board.length
    ? html`<div class="scroll"><table>
  <thead><tr><th>#</th><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "صفقات", "Deals")}</th><th>${L(lang, "عمولته", "Commission")}</th><th>${L(lang, "عملاء جداد", "New leads")}</th><th>${L(lang, "مكالمات", "Contacted")}</th><th>${L(lang, "تحريك للأمام", "Moved forward")}</th><th>${L(lang, "معاينات", "Viewings")}</th><th>${L(lang, "وحدات أضافها", "Units added")}</th><th>${L(lang, "وقت الرد", "Response time")}</th><th>${L(lang, "عملاء مفتوحين", "Open leads")}</th></tr></thead>
  <tbody>${d.board.map(
    (b, i) => html`<tr data-broker="${b.id}"><td>${medal(i)}</td><td>${b.name}</td><td>${b.deals}</td><td>${money(b.commission, lang)}</td><td>${b.leads}</td><td>${b.contacted}</td><td>${b.forward}</td><td>${b.viewings}</td><td>${b.units}</td><td>${minutes(b.responseMin, lang)}</td><td>${b.open}</td></tr>`
  )}</tbody></table></div>
  <p class="muted">${L(lang, "الترتيب: الصفقات، بعدين العمولة، بعدين التحريك للأمام. وقت الرد = الوسيط من وصول العميل لأول مكالمة.", "Ranked by deals, then commission, then moves forward. Response time = median from a lead arriving to its first contact.")}</p>`
    : html`<p class="muted">${L(lang, "مفيش نشاط في الفترة دي.", "No activity in this period.")}</p>`}
</section>`;
}

/** Owner controls (phase 2 step 4): the sign-up switch and waiting sign-ups, where agencies pay, payments to confirm. */
function billingSections(b, lang) {
  const day = (x) => new Date(x).toISOString().slice(0, 10);
  return html`<section class="card" id="signups">
  <h2>🏢 ${L(lang, "التسجيل", "Sign-up")}</h2>
  <form method="post" action="/app/owner/signup" class="row">
    <span>${b.open ? L(lang, "التسجيل مفتوح؛ كل طلب مستني موافقتك.", "Sign-up is open; every request waits for your approval.") : L(lang, "التسجيل مقفول.", "Sign-up is closed.")}</span>
    <input type="hidden" name="open" value="${b.open ? "0" : "1"}">
    <button type="submit" class="${b.open ? "secondary" : ""}" data-signup-toggle="${b.open ? "close" : "open"}">${b.open ? L(lang, "اقفل التسجيل", "Close sign-up") : L(lang, "افتح التسجيل", "Open sign-up")}</button>
  </form>
  ${b.signups.length
    ? html`<table><tbody>${b.signups.map(
        (s) => html`<tr data-signup="${s.id}"><td>${s.name}</td><td>${s.broker_name || "—"}</td><td dir="ltr">${s.phone_number ? `+${s.phone_number}` : "—"}</td><td dir="ltr">${day(s.signed_up_at)}</td>
  <td class="row"><form method="post" action="/app/owner/signups/${s.id}/approve"><button type="submit">✅ ${L(lang, "وافق", "Approve")}</button></form>
  <form method="post" action="/app/owner/signups/${s.id}/reject" data-confirm="${L(lang, "ترفض الطلب ده؟", "Reject this request?")}"><button type="submit" class="secondary">✖ ${L(lang, "ارفض", "Reject")}</button></form></td></tr>`
      )}</tbody></table>`
    : html`<p class="muted">${L(lang, "مفيش طلبات مستنية.", "No requests waiting.")}</p>`}
</section>
<section class="card" id="trial-agencies">
  <h2>⏳ ${L(lang, "وكالات في التجربة", "Agencies on a trial")}</h2>
  ${b.trials.length
    ? html`<div class="scroll"><table><tbody>${b.trials.map(
        (t) => html`<tr data-trial-agency="${t.id}"><td>${t.name}</td><td>${new Date(t.trial_ends_at) > new Date() ? L(lang, "تنتهي", "Ends") : L(lang, "انتهت", "Ended")} <span dir="ltr">${day(t.trial_ends_at)}</span></td>
  <td class="row">${Billing.EXTEND_DAYS.map((n) => html`<form method="post" action="/app/owner/trials/${t.id}/extend"><input type="hidden" name="days" value="${n}"><button type="submit" class="secondary">+${n} ${L(lang, "يوم", "days")}</button></form>`)}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card" id="payments">
  <h2>💳 ${L(lang, "مدفوعات مستنية التأكيد", "Payments to confirm")}</h2>
  ${b.payments.length
    ? html`<div class="scroll"><table><tbody>${b.payments.map(
        (p) => html`<tr data-payment="${p.reference}"><td dir="ltr">${p.reference}</td><td>${p.agency_name}</td><td>${p.kind === "voice_pack" ? L(lang, "باقة فويس", "Voice pack") : `${Plans.planName(Plans.planById(p.plan), lang)} × ${p.months}`}</td><td>${p.amount_egp} ${L(lang, "ج.م", "EGP")}</td><td dir="ltr">${day(p.created_at)}</td>
  <td class="row"><form method="post" action="/app/owner/payments/${p.id}/confirm" data-confirm="${L(lang, `وصلك ${p.amount_egp} ج.م بالمرجع ${p.reference}؟`, `Did ${p.amount_egp} EGP with reference ${p.reference} arrive?`)}"><button type="submit">✅ ${L(lang, "وصل", "Received")}</button></form>
  <form method="post" action="/app/owner/payments/${p.id}/cancel"><button type="submit" class="secondary">✖ ${L(lang, "الغِ", "Cancel")}</button></form></td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
  <form method="post" action="/app/owner/pay-to" class="stack">
    <h3>${L(lang, "الوكالات تدفع فين", "Where agencies pay")}</h3>
    <label>InstaPay <input name="instapay" maxlength="120" dir="ltr" placeholder="name@instapay" value="${b.payTo.instapay}"></label>
    <label>${L(lang, "تحويل بنكي (اختياري)", "Bank transfer (optional)")} <textarea name="bank" maxlength="300" rows="2">${b.payTo.bank}</textarea></label>
    <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
  </form>
</section>`;
}

/** C5: PDF and photo price-list reading, off per agency until switched on here, with its monthly pages. */
function readingSection(rows, lang) {
  return html`<section class="card" id="price-reading">
  <h2>🤖 ${L(lang, "قراية قوايم الأسعار PDF والصور", "Reading PDF and photo price lists")}</h2>
  <p class="muted">${L(lang, "مقفولة لكل وكالة لحد ما تفتحها هنا. الصفحة اللي اتقرت قبل كده (من أي وكالة) بتتعاد من غير تكلفة ومش بتتحسب.", "Off for every agency until you switch it on here. A page read before (by any agency) is reused at no cost and not counted.")}</p>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوكالة", "Agency")}</th><th>${L(lang, "الشهر ده", "This month")}</th><th></th></tr></thead>
  <tbody>${rows.map(
    (a) => html`<tr data-reading="${a.id}"><td>${a.name}</td><td>${a.used} / ${a.pages_month}${a.reused ? html` <span class="muted">(+${a.reused} ${L(lang, "متعادة", "reused")})</span>` : ""}</td>
    <td><form method="post" action="/app/owner/price-reading/${a.id}" class="row">
      <label><input type="checkbox" name="enabled" value="on"${a.enabled ? html` checked` : ""}> ${L(lang, "مفعّلة", "On")}</label>
      <label>${L(lang, "صفحات/شهر", "Pages/month")} <input name="pages_month" type="number" min="0" max="${Reading.MAX_PAGES_MONTH}" value="${a.pages_month}" size="5"></label>
      <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
    </form></td></tr>`
  )}</tbody></table></div>
</section>`;
}

/** C10/N1: the assistant's web answers, off per agency until switched on here, with a monthly count. */
function assistantSection(rows, lang) {
  return html`<section class="card" id="assistant-web">
  <h2>🌐 ${L(lang, "المساعد: البحث على الإنترنت", "Assistant: web answers")}</h2>
  <p class="muted">${L(lang, "المساعد بيرد من بيانات الوكالة بس. لو مفعّل هنا وملقاش الرد عندنا، بيدور على الإنترنت ويقول إن الرد «من الإنترنت، غير مؤكد» ومعاه المصادر.", "The assistant answers from the agency's data only. When switched on here and our data has no answer, it searches the web and labels the answer \"from the web, unverified\" with its sources.")}</p>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوكالة", "Agency")}</th><th>${L(lang, "أسئلة الشهر", "Questions this month")}</th><th>${L(lang, "ردود الإنترنت", "Web answers")}</th><th></th></tr></thead>
  <tbody>${rows.map(
    (a) => html`<tr data-assistant-web="${a.id}"><td>${a.name}</td><td>${a.asked}</td><td>${a.web_used} / ${a.web_month}</td>
    <td><form method="post" action="/app/owner/assistant/${a.id}" class="row">
      <label><input type="checkbox" name="enabled" value="on"${a.web ? html` checked` : ""}> ${L(lang, "مفعّل", "On")}</label>
      <label>${L(lang, "ردود/شهر", "Answers/month")} <input name="web_month" type="number" min="0" max="1000" value="${a.web_month}" size="5"></label>
      <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
    </form></td></tr>`
  )}</tbody></table></div>
</section>`;
}

function ownerPage(d, lang, { billing = null, notice = null, reading = [], assistant = [] } = {}) {
  const usd = (n) => `$${Number(n).toFixed(n < 1 ? 4 : 2)}`;
  return html`<h1>🛠️ ${L(lang, "متابعة التطبيق", "App tracking")}</h1>
${notice || ""}
${billing ? billingSections(billing, lang) : ""}
${readingSection(reading, lang)}
${assistantSection(assistant, lang)}
<section class="card">
  <h2>${L(lang, "كل أسبوع", "Weekly")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الأسبوع", "Week")}</th><th>${L(lang, "وكالات نشطة", "Active agencies")}</th><th>${L(lang, "وسطاء نشطين", "Active brokers")}</th><th>${L(lang, "وحدات", "Units")}</th><th>${L(lang, "عملاء", "Leads")}</th><th>${L(lang, "صفقات", "Deals")}</th><th>${L(lang, "أخطاء", "Errors")}</th><th>${L(lang, "بلاغات", "Bug reports")}</th></tr></thead>
  <tbody>${d.weeks.map(
    (w) => html`<tr data-week="${w.week}"><td dir="ltr">${w.week}</td><td>${w.agencies}</td><td>${w.brokers}</td><td>${w.units}</td><td>${w.leads}</td><td>${w.deals}</td><td>${w.errors}</td><td>${w.reports}</td></tr>`
  )}</tbody></table></div>
  <p class="muted">${L(lang, "نشط = استخدم البوت أو الموقع في الأسبوع ده (الأسبوع بيبدأ الاتنين).", "Active = used the bot or the website that week (weeks start on Monday).")}</p>
</section>
<section class="card">
  <h2>${L(lang, "الذكاء الاصطناعي لكل وكالة (آخر 30 يوم)", "AI per agency (last 30 days)")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوكالة", "Agency")}</th><th>${L(lang, "وسطاء", "Brokers")}</th><th>Telegram</th><th>${L(lang, "طلبات AI", "AI calls")}</th><th>${L(lang, "فشلت", "Failed")}</th><th>${L(lang, "التكلفة", "Cost")}</th></tr></thead>
  <tbody>${d.agencies.map(
    (a) => html`<tr data-agency="${a.id}"><td>${a.name}</td><td>${a.brokers ?? 0}</td><td>${a.telegram ?? 0}</td><td>${a.calls}</td><td>${a.failed}</td><td dir="ltr">${usd(a.usd)}</td></tr>`
  )}</tbody>
  <tfoot><tr><td colspan="5">${L(lang, "الإجمالي", "Total")}</td><td dir="ltr" data-total-usd="${d.totalUsd.toFixed(4)}">${usd(d.totalUsd)}</td></tr></tfoot></table></div>
</section>
<section class="card">
  <h2>${L(lang, "أخطاء وبلاغات مفتوحة (آخر 7 أيام)", "Open errors and reports (last 7 days)")}</h2>
  ${d.topErrors.length
    ? html`<table><thead><tr><th>#</th><th>${L(lang, "النوع", "Kind")}</th><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "الرسالة", "Message")}</th><th>${L(lang, "مرات", "Times")}</th></tr></thead>
  <tbody>${d.topErrors.map((e) => html`<tr><td dir="ltr">${e.kind === "report" ? "#R" : "#E"}${e.last_id}</td><td>${e.kind}</td><td>${e.source}</td><td dir="ltr">${String(e.message || "").slice(0, 140)}</td><td>${e.n}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">✅ ${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card" id="trials">
  <h2>🤝 ${L(lang, "طلبات التجربة", "Trial requests")}</h2>
  ${d.trials.length
    ? html`<div class="scroll"><table><tbody>${d.trials.map(
        (t) => html`<tr data-trial="${t.id}"><td dir="ltr">#T${t.id}</td><td>${t.name}</td><td>${t.agency_name || "—"}</td><td dir="ltr"><a href="tel:${t.phone_e164}">${t.phone_e164}</a></td><td>${t.team_size ?? "—"}</td><td dir="ltr">${new Date(t.created_at).toISOString().slice(0, 10)}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش لسه.", "None yet.")}</p>`}
</section>
<section class="card">
  <h2>${L(lang, "المهام الخلفية", "Background jobs")}</h2>
  <table><tbody>${d.jobs.map(
    (j) => html`<tr data-job="${j.name}"><td dir="ltr">${j.name}</td><td>${j.last_status === "failed" ? "❌" : j.last_status === "running" ? "⏳" : "✅"} ${j.last_status || "—"}</td><td dir="ltr">${j.last_finished_at ? new Date(j.last_finished_at).toISOString().slice(0, 16).replace("T", " ") : "—"}</td></tr>`
  )}</tbody></table>
</section>`;
}

function register(web, { pool, page }) {
  web.get("/dashboard", async (req, res) => {
    const lang = langOf(req);
    const d = await Dash.agencyDashboard(pool, req.session.broker, { days: req.query.days });
    if (!d) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    const leases = await Leases.upcoming(pool, req.session.broker);
    return page(req, res, { title: L(lang, "لوحة الوكالة", "Agency dashboard"), body: html`${agencyPage(d, lang)}${leaseEnds(leases || [], lang)}` });
  });

  const ownerView = async (req, res, notice = null, status = 200) => {
    const d = await Dash.ownerDashboard(pool, req.session.broker);
    if (!d) return notFound(req, res, page);
    const [open, signups, payments, payTo, trials, reading, assistant] = await Promise.all([Signup.isOpen(pool), Signup.pending(pool), Billing.pendingPayments(pool), Billing.payTo(pool), Billing.trialAgencies(pool), PriceReading.overview(pool), Assistant.overview(pool)]);
    return page(req, res, { title: L(langOf(req), "متابعة التطبيق", "App tracking"), body: ownerPage(d, langOf(req), { billing: { open, signups, payments, payTo, trials }, notice, reading, assistant }) }, status);
  };
  const ok = (text) => html`<p class="card notice ok" role="status">✅ ${text}</p>`;
  const bad = (text) => html`<p class="card notice bad" role="alert">❌ ${text}</p>`;
  const ownerOnly = (handler) => async (req, res) => {
    if (!Dash.isOwner(req.session.broker)) return notFound(req, res, page);
    return handler(req, res, langOf(req));
  };
  const idParam = (req) => (/^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null);
  const uuidParam = (req) => (/^[0-9a-f-]{36}$/i.test(req.params.id) ? req.params.id : null);

  web.get("/owner", (req, res) => ownerView(req, res));

  web.post("/owner/signup", ownerOnly(async (req, res, lang) => {
    await Signup.setOpen(pool, req.body.open === "1");
    return ownerView(req, res, ok(req.body.open === "1" ? L(lang, "التسجيل اتفتح.", "Sign-up is open.") : L(lang, "التسجيل اتقفل.", "Sign-up is closed.")));
  }));

  web.post("/owner/signups/:id/approve", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Signup.approve(pool, id) : { error: "not_pending" };
    if (r.error) return ownerView(req, res, bad(L(lang, "الطلب مش مستني.", "That request isn't waiting.")), 400);
    const b = r.broker;
    const text = b.preferred_lang === "en"
      ? `Hi ${b.name}! ${r.agency.name} is on WehdatHub: a ${Plans.TRIAL.days}-day free trial on the Office plan. Tap this link to start on Telegram (works once, for 7 days): ${r.url || ""}`
      : `أهلاً ${b.name}! ${r.agency.name} اتفعّلت على WehdatHub: ${Plans.TRIAL.days} يوم تجربة مجانية على باقة المكتب. دوس على اللينك ده عشان تبدأ على تيليجرام (يشتغل مرة واحدة، لمدة ٧ أيام): ${r.url || ""}`;
    const wa = r.url ? Phone.waMeUrl(b.phone_number, text) : null;
    return ownerView(req, res, html`<section class="card notice ok" role="status" data-approved="${r.agency.id}"><h2>✅ ${L(lang, `${r.agency.name} اتوافق عليها؛ التجربة شغالة.`, `${r.agency.name} approved; the trial has started.`)}</h2>
${r.url ? html`<p dir="ltr"><input readonly value="${r.url}" aria-label="${L(lang, "لينك البداية", "Start link")}"></p>` : html`<p class="muted">${L(lang, "بوت تيليجرام مش متظبط (TELEGRAM_BOT_USERNAME).", "The Telegram bot isn't set up (TELEGRAM_BOT_USERNAME).")}</p>`}
${wa ? html`<p><a class="btn" href="${wa}" target="_blank" rel="noopener noreferrer">📤 ${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>` : ""}</section>`);
  }));

  web.post("/owner/signups/:id/reject", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Signup.reject(pool, id) : { error: "not_pending" };
    return r.error ? ownerView(req, res, bad(L(lang, "الطلب مش مستني.", "That request isn't waiting.")), 400) : ownerView(req, res, ok(L(lang, `${r.agency.name} اترفضت.`, `${r.agency.name} rejected.`)));
  }));

  web.post("/owner/payments/:id/confirm", ownerOnly(async (req, res, lang) => {
    const id = idParam(req);
    const r = id ? await Billing.confirmPayment(pool, id) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, "الدفع ده مش مستني.", "That payment isn't waiting.")), 400);
    await BillingNotices.paymentConfirmed(pool, r).catch((e) => console.warn("Payment notice failed:", e.message));
    return ownerView(req, res, ok(L(lang, `${r.payment.reference} اتأكد.`, `${r.payment.reference} confirmed.`)));
  }));

  web.post("/owner/payments/:id/cancel", ownerOnly(async (req, res, lang) => {
    const id = idParam(req);
    const r = id ? await Billing.cancelPayment(pool, id) : { error: "not_pending" };
    return r.error ? ownerView(req, res, bad(L(lang, "الدفع ده مش مستني.", "That payment isn't waiting.")), 400) : ownerView(req, res, ok(L(lang, `${r.payment.reference} اتلغى.`, `${r.payment.reference} cancelled.`)));
  }));

  web.post("/owner/trials/:id/extend", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Billing.extendTrial(pool, id, req.body.days) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, "مينفعش تمدّد دي.", "That trial can't be extended.")), 400);
    const until = new Date(r.agency.trial_ends_at).toISOString().slice(0, 10);
    return ownerView(req, res, ok(L(lang, `تجربة ${r.agency.name} اتمدّت لحد ${until}.`, `${r.agency.name}'s trial now ends ${until}.`)));
  }));

  web.post("/owner/price-reading/:id", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await PriceReading.setForAgency(pool, id, req.body) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, `الصفحات رقم من 0 لـ ${Reading.MAX_PAGES_MONTH}.`, `Pages must be 0 to ${Reading.MAX_PAGES_MONTH}.`)), 400);
    return ownerView(req, res, ok(r.setting.enabled ? L(lang, `${r.agency.name}: القراية مفعّلة، ${r.setting.pages_month} صفحة في الشهر.`, `${r.agency.name}: reading on, ${r.setting.pages_month} pages a month.`) : L(lang, `${r.agency.name}: القراية مقفولة.`, `${r.agency.name}: reading off.`)));
  }));

  web.post("/owner/assistant/:id", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Assistant.setWeb(pool, id, { enabled: req.body.enabled === "on", webMonth: req.body.web_month }) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, "الردود رقم من 0 لـ 1000.", "Answers must be 0 to 1000.")), 400);
    return ownerView(req, res, ok(r.web ? L(lang, `${r.agency.name}: البحث على الإنترنت مفعّل، ${r.web_month} رد في الشهر.`, `${r.agency.name}: web answers on, ${r.web_month} a month.`) : L(lang, `${r.agency.name}: البحث على الإنترنت مقفول.`, `${r.agency.name}: web answers off.`)));
  }));

  web.post("/owner/pay-to", ownerOnly(async (req, res, lang) => {
    await Billing.savePayTo(pool, { instapay: req.body.instapay, bank: req.body.bank });
    return ownerView(req, res, ok(L(lang, "اتحفظ.", "Saved.")));
  }));
}

module.exports = { register };
