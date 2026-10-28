// web/routes/dashboard.js — The agency dashboard and leaderboard (7.2, managers: /app/dashboard) and the owner's tracking
// dashboard (5.4, OWNER_BROKER_IDS only: /app/owner; everyone else gets the ordinary 404). Numbers only: no client's name
// or phone appears on either page. Queries live in services/dashboards.js. The owner page also switches PDF and photo
// price-list reading on per agency with its monthly pages (Release B C5).
"use strict";

const PriceReading = require("../../services/priceReading");
const Assistant = require("../../services/assistant");
const Leases = require("../../services/leases");
const Targets = require("../../services/targets");
const Reading = require("../../domain/priceReading");
const Dash = require("../../services/dashboards");
const Stages = require("../../domain/leadStages");
const Commission = require("../../domain/commission");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Signup = require("../../services/signup");
const Referrals = require("../../services/referrals");
const Intake = require("../../services/leadIntake");
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

/** N6: this month's progress against each broker's target. */
function targetsSection(rows, lang) {
  const bar = (n, of) => (of ? html`<progress max="100" value="${Math.min(100, Targets.pct(n, of))}"></progress> ${Targets.pct(n, of)}%` : "—");
  return html`<section class="card" id="targets">
  <h2>🎯 ${L(lang, "أهداف الشهر", "This month's targets")}</h2>
  ${rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "صفقات", "Deals")}</th><th></th><th>${L(lang, "العمولة", "Commission")}</th><th></th></tr></thead>
  <tbody>${rows.map((r) => html`<tr data-target="${r.id}"><td>${r.name}</td><td>${r.deals}${r.target_deals ? ` / ${r.target_deals}` : ""}</td><td>${bar(r.deals, r.target_deals)}</td><td>${money(r.commission, lang)}${r.target_commission ? html` / ${money(r.target_commission, lang)}` : ""}</td><td>${bar(r.commission, r.target_commission)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش أهداف. حط هدف لكل بروكر من صفحة الفريق.", "No targets yet. Set one per broker on the Team page.")} <a href="/app/team">${L(lang, "الفريق", "Team")}</a></p>`}
</section>`;
}

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
<p class="row"><a class="btn secondary" href="/app/sources">📣 ${L(lang, "مصادر العملاء وتكلفة الإعلانات", "Lead sources and ad cost")}</a> <a class="btn secondary" href="/app/winloss">📉 ${L(lang, "المكسب والخسارة", "Win and loss")}</a></p>
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

/** L1/L2: each agency's lead intake URLs (Make.com lead ads, forms): make one, test it, stop it. */
function intakeSection(rows, lang) {
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
  return html`<section class="card" id="lead-intake">
  <h2>📨 ${L(lang, "استقبال العملاء الأوتوماتيك (Make / فورم)", "Automatic lead intake (Make / forms)")}</h2>
  <p class="muted">${L(lang, "لكل وكالة لينك سري. في Make: سيناريو Facebook Lead Ads ← HTTP POST على اللينك ده (JSON). العميل بياخد المصدر، وبيروح للوسيط اللي عليه الدور، والوسيط بيوصله تنبيه. اللينك بيظهر مرة واحدة بس.", "One secret URL per source. In Make: a Facebook Lead Ads scenario → HTTP POST (JSON) to this URL. Leads get the source and go to the next broker in turn, who is alerted. The URL is shown once only.")}
</p>
  <details><summary>${L(lang, "خطوات ربط وكالة (Make + إعلانات فيسبوك)", "Agency setup steps (Make + Facebook lead ads)")}</summary><ol>
    <li>${L(lang, "الوكالة تضيف حسابك على فيسبوك لصفحتها بصلاحية العملاء (Leads)، ولو «Leads Access Manager» مقفول تسمح لـ Make.", "The agency adds your Facebook account to its Page with leads access; if Leads Access Manager is restricted, it also allows Make.")}</li>
    <li>${L(lang, "اعمل لينك جديد هنا للوكالة وانسخه.", "Make a new URL here for the agency and copy it.")}</li>
    <li>${L(lang, "في Make: انسخ سيناريو القالب (docs/make-lead-ads.md)، اختار صفحة الوكالة والفورم، وحط اللينك في موديول HTTP.", "In Make: clone the template scenario (docs/make-lead-ads.md), pick the agency's Page and form, and paste the URL into the HTTP module.")}</li>
    <li>${L(lang, "دوس 🧪 تجربة هنا، وبعدها ابعت عميل تجربة من أداة Meta Lead Ads Testing Tool واتأكد إنه ظهر عند وسيط.", "Press 🧪 Test here, then send a test lead from Meta's Lead Ads Testing Tool and check it reaches a broker.")}</li>
    <li>${L(lang, "شغّل السيناريو (Immediately). خطة Make المجانية فيها سيناريوهين شغالين بس.", "Turn the scenario on (Immediately). Make's free plan runs 2 active scenarios only.")}</li>
  </ol></details>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوكالة", "Agency")}</th><th>${L(lang, "الاسم", "Name")}</th><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "آخر عميل", "Last lead")}</th><th>${L(lang, "30 يوم", "30 days")}</th><th></th></tr></thead>
  <tbody>${rows.flatMap(({ agency, intakes }) =>
    intakes.map(
      (i) => html`<tr data-intake="${i.id}"${i.revoked_at ? html` class="muted"` : ""}><td>${agency.name}</td><td>${i.name} <span class="muted" dir="ltr">…${i.token_hint}</span></td><td>${i.source}</td><td dir="ltr">${day(i.last_lead_at)}</td>
      <td>${i.created_30} ${L(lang, "جديد", "new")}${i.failed_30 ? html` · <span class="bad">${i.failed_30} ${L(lang, "فشل", "failed")}</span>` : ""}</td>
      <td>${i.revoked_at
        ? L(lang, "متوقف", "Stopped")
        : html`<div class="row"><form method="post" action="/app/owner/intake/${i.id}/test"><button type="submit" class="secondary">🧪 ${L(lang, "تجربة", "Test")}</button></form>
        <form method="post" action="/app/owner/intake/${i.id}/revoke" data-confirm="${L(lang, "اللينك هيبطل يشتغل. متأكد؟", "The URL will stop working. Sure?")}"><button type="submit" class="secondary">⛔ ${L(lang, "وقّف", "Stop")}</button></form></div>`}</td></tr>`
    )
  )}</tbody></table></div>
  <form method="post" action="/app/owner/intake" class="row">
    <label>${L(lang, "الوكالة", "Agency")} <select name="agency" required>${rows.map(({ agency }) => html`<option value="${agency.id}">${agency.name}</option>`)}</select></label>
    <label>${L(lang, "الاسم", "Name")} <input name="name" required maxlength="60" value="Facebook ads (Make)"></label>
    <label>${L(lang, "المصدر", "Source")} <input name="source" required maxlength="60" value="Facebook"></label>
    <label>${L(lang, "تنبيه لو مفيش عملاء (أيام)", "Alert after quiet days")} <input name="quiet_days" type="number" min="1" max="60" value="3" size="3"></label>
    <button type="submit">➕ ${L(lang, "لينك جديد", "New URL")}</button>
  </form>
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

/** Owner: agency referrals (Release B N9) — who invited whom and whether the free months were given; link an agency. */
function referralsSection(r, lang) {
  const day = (x) => new Date(x).toISOString().slice(0, 10);
  return html`<section class="card" id="referrals">
  <h2>🎁 ${L(lang, "الدعوات بين الوكالات", "Agency referrals")}</h2>
  ${r.referrals.length
    ? html`<div class="scroll"><table><tbody>${r.referrals.map(
        (x) => html`<tr data-referral-row="${x.id}"><td>${x.name}</td><td>← ${x.referrer_name}</td><td>${x.referral_rewarded_at ? html`🎁 ${L(lang, "الشهرين اتحسبوا", "Both months given")} <span dir="ltr">${day(x.referral_rewarded_at)}</span>` : L(lang, "مستنية أول دفعة", "Waiting for its first payment")}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش دعوات لسه.", "No referrals yet.")}</p>`}
  ${r.linkable.length
    ? html`<form method="post" action="/app/owner/referrals" class="row">
    <label>${L(lang, "الوكالة", "Agency")} <select name="agency">${r.linkable.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
    <label>${L(lang, "كود الوكالة اللي دعتها", "Inviting agency's code")} <input name="code" required maxlength="12" dir="ltr"></label>
    <button type="submit" class="secondary">${L(lang, "اربط", "Link")}</button>
  </form>`
    : ""}
  <p class="muted">${L(lang, "الوكالة اللي اتدعت وتدفع أول باقة تاخد شهر زيادة، واللي دعتها تاخد شهر (على باقتها لو بتدفع، أو رصيد لأول دفعة جاية).", "An invited agency gets an extra month on its first plan payment, and its inviter gets one (on its paid plan, or as a credit for its next payment).")}</p>
</section>`;
}

function ownerPage(d, lang, { billing = null, notice = null, reading = [], assistant = [], referrals = null, intakes = [] } = {}) {
  const usd = (n) => `$${Number(n).toFixed(n < 1 ? 4 : 2)}`;
  return html`<h1>🛠️ ${L(lang, "متابعة التطبيق", "App tracking")}</h1>
${notice || ""}
${billing ? billingSections(billing, lang) : ""}
${referrals ? referralsSection(referrals, lang) : ""}
${intakeSection(intakes, lang)}
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
    const [leases, targets] = await Promise.all([Leases.upcoming(pool, req.session.broker), Targets.progress(pool, req.session.broker.agency_id)]);
    return page(req, res, { title: L(lang, "لوحة الوكالة", "Agency dashboard"), nav: "dashboard", body: html`${agencyPage(d, lang)}${targetsSection([...targets.values()], lang)}${leaseEnds(leases || [], lang)}` });
  });

  const ownerView = async (req, res, notice = null, status = 200) => {
    const d = await Dash.ownerDashboard(pool, req.session.broker);
    if (!d) return notFound(req, res, page);
    const [open, signups, payments, payTo, trials, reading, assistant, referrals, intakes] = await Promise.all([Signup.isOpen(pool), Signup.pending(pool), Billing.pendingPayments(pool), Billing.payTo(pool), Billing.trialAgencies(pool), PriceReading.overview(pool), Assistant.overview(pool), Referrals.overview(pool), Intake.overview(pool)]);
    return page(req, res, { title: L(langOf(req), "متابعة التطبيق", "App tracking"), nav: "owner", body: ownerPage(d, langOf(req), { billing: { open, signups, payments, payTo, trials }, notice, reading, assistant, referrals, intakes }) }, status);
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
${r.url ? html`<p class="row" dir="ltr"><input readonly value="${r.url}" id="start-link" aria-label="${L(lang, "لينك البداية", "Start link")}"> <button type="button" class="secondary" data-copy="#start-link">📋 ${L(lang, "نسخ", "Copy")}</button></p>` : html`<p class="muted">${L(lang, "بوت تيليجرام مش متظبط (TELEGRAM_BOT_USERNAME).", "The Telegram bot isn't set up (TELEGRAM_BOT_USERNAME).")}</p>`}
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

  web.post("/owner/referrals", ownerOnly(async (req, res, lang) => {
    const id = /^[0-9a-f-]{36}$/i.test(String(req.body.agency || "")) ? req.body.agency : null;
    const r = id ? await Referrals.link(pool, id, req.body.code) : { error: "referral" };
    const why = {
      referral: L(lang, "الكود ده مش موجود.", "That code doesn't exist."),
      self: L(lang, "الوكالة مينفعش تدعي نفسها.", "An agency can't invite itself."),
      paid: L(lang, "الوكالة دي دفعت قبل كده.", "That agency has already paid."),
      already: L(lang, "الوكالة دي مربوطة بدعوة بالفعل.", "That agency is already linked to an invite.")
    };
    if (r.error) return ownerView(req, res, bad(why[r.error]), 400);
    return ownerView(req, res, ok(L(lang, `اتربطت بدعوة ${r.referrer.name}.`, `Linked to ${r.referrer.name}'s invite.`)));
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

  web.post("/owner/intake", ownerOnly(async (req, res, lang) => {
    const id = /^[0-9a-f-]{36}$/i.test(String(req.body.agency || "")) ? req.body.agency : null;
    const r = id ? await Intake.create(pool, id, { name: req.body.name, source: req.body.source, quietDays: req.body.quiet_days }) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, "اكتب الاسم والمصدر، والأيام من 1 لـ 60.", "Fill in the name and source; quiet days 1 to 60.")), 400);
    return ownerView(req, res, html`<section class="card notice ok" role="status" data-intake-created="${r.intake.id}"><h2>✅ ${L(lang, `لينك ${r.agency.name} جاهز`, `${r.agency.name}'s URL is ready`)}</h2>
<p>${L(lang, "انسخه دلوقتي: مش هيظهر تاني. حطه في Make (HTTP → Make a request، POST، Body JSON).", "Copy it now: it won't be shown again. Put it in Make (HTTP → Make a request, POST, JSON body).")}</p>
<p class="row" dir="ltr"><input readonly value="${r.url}" id="intake-url" aria-label="URL"> <button type="button" class="secondary" data-copy="#intake-url">📋 ${L(lang, "نسخ", "Copy")}</button></p></section>`);
  }));

  web.post("/owner/intake/:id/test", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Intake.testIntake(pool, id) : { json: { ok: false } };
    return r.json.ok
      ? ownerView(req, res, ok(L(lang, `التجربة نجحت: اللينك شغال (المصدر ${r.json.source}). مفيش عميل اتسجل.`, `Test passed: the URL works (source ${r.json.source}). No lead was saved.`)))
      : ownerView(req, res, bad(L(lang, "التجربة فشلت: اللينك متوقف أو مش موجود.", "Test failed: the URL is stopped or missing.")), 400);
  }));

  web.post("/owner/intake/:id/revoke", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Intake.revoke(pool, id) : { error: "not_found" };
    return r.error ? ownerView(req, res, bad(L(lang, "اللينك متوقف بالفعل.", "That URL is already stopped.")), 400) : ownerView(req, res, ok(L(lang, `«${r.intake.name}» اتوقف.`, `"${r.intake.name}" stopped.`)));
  }));

  web.post("/owner/pay-to", ownerOnly(async (req, res, lang) => {
    await Billing.savePayTo(pool, { instapay: req.body.instapay, bank: req.body.bank });
    return ownerView(req, res, ok(L(lang, "اتحفظ.", "Saved.")));
  }));
}

module.exports = { register };
