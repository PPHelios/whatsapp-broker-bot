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
const Onboarding = require("../../services/onboarding");
const Quotas = require("../../services/quotas");
const { quotaSection } = require("../views/quotas");
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
const { icon } = require("../icons");
const Privacy = require("../../services/unitPrivacy");
const OwnerAgencies = require("../../services/ownerAgencies");
const { isManager } = require("../../lib/authz");
const { logOperation } = require("../../lib/db");

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
  const kpi = (label, value, attr) => html`<div class="kpi" data-kpi="${attr}"><span class="muted small">${label}</span><strong>${value}</strong></div>`;
  const q = d.brokerId ? `&broker=${d.brokerId}` : "";
  const todo = [
    ["uncontacted", d.uncontacted, L(lang, "عملاء جداد محدش كلمهم", "New leads nobody called"), "/app/leads?tab=new"],
    ["overdue", d.overdue, L(lang, "متابعات متأخرة", "Overdue follow-ups"), "/app/leads?tab=overdue"],
    ["unassigned", d.unassigned, L(lang, "عملاء من غير بروكر", "Leads with no broker"), "/app/leads?broker=none"],
    ["stale", d.units.stale, L(lang, "وحدات محتاجة تأكيد (21 يوم)", "Units to confirm (21 days)"), "/app/units"]
  ];
  const maxStage = Math.max(1, ...Object.values(d.pipeline));
  const maxWeek = Math.max(1, ...(d.weekly || []));
  return html`<h1>${L(lang, "لوحة الوكالة", "Agency dashboard")}</h1>
<form method="get" action="/app/dashboard" class="stack" data-dash-filters>
  <nav class="seg" aria-label="${L(lang, "الفترة", "Period")}">${Dash.PERIODS.map(
    (p) => html`<a href="/app/dashboard?days=${p}${q}"${p === d.days ? html` aria-current="page"` : ""}>${L(lang, `${p} يوم`, `${p} days`)}</a>`
  )}</nav>
  <input type="hidden" name="days" value="${d.days}">
  <select name="broker" data-autosubmit aria-label="${L(lang, "البروكر", "Broker")}"><option value="">${L(lang, "كل الفريق", "Whole team")}</option>${d.team.map((b) => html`<option value="${b.id}"${b.id === d.brokerId ? html` selected` : ""}>${b.name}</option>`)}</select>
  <noscript><button type="submit">${L(lang, "تطبيق", "Apply")}</button></noscript>
</form>
<div class="kpis">
  ${kpi(L(lang, "عملاء جداد", "New leads"), d.leads, "leads")}
  ${kpi(L(lang, "صفقات", "Deals"), d.deals.n, "deals")}
  ${kpi(L(lang, "العمولة", "Commission"), money(d.deals.commission, lang), "commission")}
  ${kpi(L(lang, "وحدات متاحة", "Active units"), d.units.active, "units")}
</div>
${todo.some(([, n]) => n)
  ? html`<section class="card list" id="needs-action"><h2>${L(lang, "محتاج تتصرف", "Needs action")}</h2><ul class="rows">${todo.filter(([, n]) => n).map(
      ([k, n, label, href]) => html`<li data-kpi="${k}"><a class="listrow" href="${href}">${label}<b class="chip late">${n}</b></a></li>`
    )}</ul></section>`
  : html`<p class="card notice ok" id="needs-action">${L(lang, "مفيش حاجة متأخرة. شغل نضيف.", "Nothing late. Clean work.")}</p>`}
${d.weekly && d.weekly.some(Boolean)
  ? html`<section class="card" id="weekly"><h2>${L(lang, "عملاء جداد كل أسبوع", "New leads per week")}</h2>
  <ol class="bars" aria-label="${L(lang, "آخر 8 أسابيع", "Last 8 weeks")}">${d.weekly.map((n, i) => html`<li title="${n}"><span class="bar" data-h="${Math.round((n * 10) / maxWeek)}"></span><span class="small">${n}</span><span class="muted small">${i === 7 ? L(lang, "ده", "now") : `-${7 - i}`}</span></li>`)}</ol>
</section>`
  : ""}
<section class="card" id="funnel">
  <h2>${L(lang, "المراحل دلوقتي", "Pipeline now")}</h2>
  <ul class="funnel">${Stages.STAGES.map((s) => html`<li data-stage="${s}"><a href="/app/leads?tab=${s}">${Stages.stageLabel(s, lang)}</a><progress max="${maxStage}" value="${d.pipeline[s]}"></progress><b>${d.pipeline[s]}</b></li>`)}</ul>
</section>
${d.sources && d.sources.length
  ? html`<section class="card" id="top-sources"><h2>${L(lang, "أكتر مصادر العملاء", "Top lead sources")}</h2>
  <ul class="rows">${d.sources.map((x) => html`<li class="listrow">${x.source === "-" ? L(lang, "من غير مصدر", "No source") : Stages.sourceLabel(x.source, lang)}<b>${x.n}</b></li>`)}</ul>
  <p class="row"><a href="/app/sources">${L(lang, "المصادر وتكلفة الإعلانات", "Sources and ad cost")}</a> · <a href="/app/winloss">${L(lang, "المكسب والخسارة", "Win and loss")}</a></p>
</section>`
  : html`<p class="row"><a href="/app/sources">${L(lang, "المصادر وتكلفة الإعلانات", "Sources and ad cost")}</a> · <a href="/app/winloss">${L(lang, "المكسب والخسارة", "Win and loss")}</a></p>`}
<section class="card" id="leaderboard">
  <h2>${L(lang, `ترتيب البروكرز (آخر ${d.days} يوم)`, `Leaderboard (last ${d.days} days)`)}</h2>
  ${d.board.length
    ? html`<ol class="board">${d.board.map(
        (b, i) => html`<li data-broker="${b.id}"><details><summary><span class="medal">${medal(i)}</span><strong>${b.name}</strong><span class="muted small">${L(lang, `${b.deals} صفقة`, `${b.deals} deal(s)`)} · ${money(b.commission, lang)}</span></summary>
  <dl class="bfacts">
    <div><dt>${L(lang, "عملاء جداد", "New leads")}</dt><dd>${b.leads}</dd></div>
    <div><dt>${L(lang, "مكالمات", "Contacted")}</dt><dd>${b.contacted}</dd></div>
    <div><dt>${L(lang, "تحريك للأمام", "Moved forward")}</dt><dd>${b.forward}</dd></div>
    <div><dt>${L(lang, "معاينات", "Viewings")}</dt><dd>${b.viewings}</dd></div>
    <div><dt>${L(lang, "وحدات أضافها", "Units added")}</dt><dd>${b.units}</dd></div>
    <div><dt>${L(lang, "وقت الرد", "Response time")}</dt><dd>${minutes(b.responseMin, lang)}</dd></div>
    <div><dt>${L(lang, "عملاء مفتوحين", "Open leads")}</dt><dd>${b.open}</dd></div>
  </dl></details></li>`
      )}</ol>
  <p class="muted small">${L(lang, "الترتيب: الصفقات، بعدين العمولة، بعدين التحريك للأمام. وقت الرد = الوسيط من وصول العميل لأول مكالمة.", "Ranked by deals, then commission, then moves forward. Response time = median from a lead arriving to its first contact.")}</p>`
    : html`<p class="muted">${L(lang, "مفيش نشاط في الفترة دي.", "No activity in this period.")}</p>`}
</section>`;
}

/** Data security for managers: who sees private unit details, and the Excel export of every unit. */
function privacySection(scope, lang, csrf, notice) {
  const opt = (v, label) => html`<label class="pill"><input type="radio" name="scope" value="${v}"${scope === v ? html` checked` : ""}><span>${label}</span></label>`;
  return html`<section class="card stack" id="data-security">
  <h2>${L(lang, "أمان البيانات", "Data security")}</h2>
  ${notice === "saved" ? html`<p class="notice ok">${L(lang, "✅ اتحفظ.", "✅ Saved.")}</p>` : ""}
  <form method="post" action="/app/dashboard/secret-details" class="stack"><input type="hidden" name="_csrf" value="${csrf}">
    <p>${L(lang, "مين يشوف المالك والعمولة ورقم الوحدة والعنوان واللوكيشن؟", "Who sees the owner, commission, unit number, address and pin?")}</p>
    <div class="pills">${opt("restricted", L(lang, "صاحب الوحدة والمديرين", "The unit's broker and managers"))}${opt("all", L(lang, "كل البروكرز في الوكالة", "Every broker in the agency"))}</div>
    <p class="muted small">${L(lang, "لو مقفولة، أي بروكر تاني يقدر يطلب يشوفها، وصاحب الوحدة أو مدير يوافق. كل طلب ورد بيتسجل.", "When closed, another broker can ask; the unit's broker or a manager answers. Every ask and answer is logged.")}</p>
    <button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
  </form>
  <p><a class="btn secondary" href="/app/units-export.xlsx" download>${icon("import", 18)} ${L(lang, "نزّل كل الوحدات (إكسيل)", "Download all units (Excel)")}</a> <span class="muted small">${L(lang, "للمديرين بس، وكل تنزيل بيتسجل.", "Managers only; every download is logged.")}</span></p>
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

const STUCK = {
  nothing_added: ["مضافش وحدة ولا عميل", "no unit or lead yet"],
  no_telegram: ["مربطش تيليجرام", "Telegram not linked"],
  quiet: ["مختفي من 7 أيام+", "quiet 7+ days"]
};

/** Onboarding: brokers who joined 2+ days ago and are stuck, with a WhatsApp link to reach them. */
function stuckSection(stuck, lang) {
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "—");
  return html`<section class="card" id="stuck">
  <h2>🧭 ${L(lang, `وسطاء محتاجين مساعدة (${stuck.length})`, `Brokers who need a hand (${stuck.length})`)}</h2>
  ${stuck.length
    ? html`<div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوسيط", "Broker")}</th><th>${L(lang, "الوكالة", "Agency")}</th><th>${L(lang, "انضم", "Joined")}</th><th>${L(lang, "آخر نشاط", "Last active")}</th><th>${L(lang, "واقف عند", "Stuck at")}</th><th></th></tr></thead>
  <tbody>${stuck.map(
    (b) => html`<tr data-stuck="${b.id}"><td>${b.name} <span class="muted">(${b.role})</span></td><td>${b.agency_name}</td><td dir="ltr">${day(b.created_at)}</td><td dir="ltr">${day(b.last_active_at)}</td>
    <td>${b.reasons.map((r) => (STUCK[r] || [r, r])[lang === "en" ? 1 : 0]).join(" · ")}</td>
    <td><a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/${String(b.phone_number).replace(/[^0-9]/g, "")}">💬 ${L(lang, "كلّمه", "Message")}</a></td></tr>`
  )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش حد واقف دلوقتي.", "Nobody is stuck right now.")}</p>`}
</section>`;
}

/** The owner's unit cap per plan: empty = the default in domain/plans.js. */
function limitsSection(limits, lang) {
  return html`<form method="post" action="/app/owner/plan-limits" class="card stack" data-plan-limits>
  <h2>🏠 ${L(lang, "حد الوحدات المتاحة لكل باقة", "Available-unit cap per plan")}</h2>
  <p class="muted">${L(lang, "الوحدات المباعة والمؤرشفة مش بتتحسب. لما الوكالة توصل للحد، الوحدة الجديدة مبتتحفظش ويظهر لها رسالة ترقية الباقة.", "Sold and archived units don't count. At the cap a new unit isn't saved and the broker is told to upgrade.")}</p>
  <div class="row">${Plans.ALL.map((p) => html`<label>${Plans.planName(p, lang)} <input name="${p.id}" type="number" min="1" max="1000000" value="${limits[p.id]}" data-limit="${p.id}"></label>`)}</div>
  <button type="submit">${L(lang, "احفظ", "Save")}</button>
</form>`;
}

/** Owner: every agency at a glance (plan in force, size, last seen), each linking to its own page. */
function agenciesSection(agencies, lang) {
  const src = { pilot: L(lang, "تجريبي مجاني", "Pilot"), paid: L(lang, "مدفوع", "Paid"), trial: L(lang, "تجربة", "Trial"), free: L(lang, "مجاني", "Free") };
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
  return html`<section class="card list" id="agencies"><h2>${L(lang, `الوكالات (${agencies.length})`, `Agencies (${agencies.length})`)}</h2>
  <ul class="rows">${agencies.map(
    (a) => html`<li data-agency-row="${a.id}"><a class="listrow" href="/app/owner/agencies/${a.id}"><span><strong>${a.name}</strong><br><span class="muted small">${Plans.planName(a.effective.plan, lang)} · ${src[a.effective.source]}${a.effective.until ? ` ${L(lang, "لحد", "until")} ${day(a.effective.until)}` : ""} · ${L(lang, `${a.brokers} بروكر · ${a.units} وحدة · ${a.leads30} عميل/30 يوم`, `${a.brokers} brokers · ${a.units} units · ${a.leads30} leads/30d`)}</span></span>${a.suspended_at ? html`<b class="chip late">${L(lang, "موقوفة", "Suspended")}</b>` : a.approval === "pending" ? html`<b class="chip new">${L(lang, "مستنية", "Pending")}</b>` : html`<b class="muted small">${day(a.last_seen)}</b>`}</a></li>`
  )}</ul></section>`;
}

/** Owner: one agency's page with its controls. */
function agencyControlPage(a, lang, csrf, notice) {
  const hidden = html`<input type="hidden" name="_csrf" value="${csrf}">`;
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
  return html`<h1>${a.name}</h1>
${notice || ""}
<div class="kpis">
  <div class="kpi"><span class="muted small">${L(lang, "الباقة الحالية", "Plan in force")}</span><strong>${Plans.planName(a.effective.plan, lang)}</strong></div>
  <div class="kpi"><span class="muted small">${L(lang, "لحد", "Until")}</span><strong dir="ltr">${a.effective.until ? day(a.effective.until) : "—"}</strong></div>
  <div class="kpi"><span class="muted small">${L(lang, "بروكرز نشطين", "Active brokers")}</span><strong>${a.brokers}</strong></div>
  <div class="kpi"><span class="muted small">${L(lang, "وحدات متاحة", "Active units")}</span><strong>${a.units}</strong></div>
</div>
<section class="card stack" id="plan"><h2>${L(lang, "تغيير الباقة", "Change the plan")}</h2>
  <form method="post" action="/app/owner/agencies/${a.id}/plan" class="stack">${hidden}
    <div class="pills">${Plans.PLANS.map((p) => html`<label class="pill"><input type="radio" name="plan" value="${p.id}"${p.id === a.plan ? html` checked` : ""}><span>${Plans.planName(p, lang)}</span></label>`)}</div>
    <div class="grid two">
      <label>${L(lang, "مدفوعة لحد", "Paid until")}<input type="date" name="until" value="${day(a.paid_until)}"></label>
      <label>${L(lang, "أو عدد شهور من النهارده", "Or months from today")}<input type="number" name="months" min="0" max="36" inputmode="numeric"></label>
    </div>
    <label class="check"><input type="checkbox" name="pilot" value="1"${a.pilot ? html` checked` : ""}> ${L(lang, "تجريبي مجاني (Pilot)", "Free pilot")}</label>
    <button type="submit">${L(lang, "حفظ الباقة", "Save the plan")}</button>
  </form>
  <p class="muted small">${L(lang, "الأسعار في ملف الباقات؛ هنا بتغير باقة الوكالة ومدتها بس.", "Prices live in the plans file; this only changes this agency's plan and dates.")}</p>
</section>
<section class="card list" id="team"><h2>${L(lang, "الفريق", "Team")}</h2><ul class="rows">${a.team.map((b) => html`<li class="listrow">${b.name} <span class="muted small">${b.role}</span><b class="${b.is_active ? "muted small" : "chip late"}">${b.is_active ? L(lang, "نشط", "Active") : L(lang, "مقفول", "Off")}</b></li>`)}</ul></section>
${a.payments.length ? html`<section class="card list"><h2>${L(lang, "المدفوعات", "Payments")}</h2><ul class="rows">${a.payments.map((p) => html`<li class="listrow"><span dir="ltr">${p.reference}</span> ${money(p.amount_egp, lang)}<b class="muted small">${p.status}</b></li>`)}</ul></section>` : ""}
<section class="card stack" id="suspend"><h2>${a.suspended_at ? L(lang, "الوكالة موقوفة", "Suspended") : L(lang, "إيقاف الوكالة", "Suspend the agency")}</h2>
  <p class="muted">${a.suspended_at ? L(lang, `اتوقفت ${day(a.suspended_at)}. الرجوع بيرجّع نفس البروكرز اللي كانوا شغالين.`, `Suspended ${day(a.suspended_at)}. Resuming brings back the same brokers.`) : L(lang, "كل البروكرز بيقفوا عن الشغل (البيانات بتفضل كما هي) لحد ما ترجعها.", "Every broker stops working (all data stays) until you resume it.")}</p>
  <form method="post" action="/app/owner/agencies/${a.id}/${a.suspended_at ? "resume" : "suspend"}" data-confirm="${a.suspended_at ? L(lang, "ترجع الوكالة؟", "Resume this agency?") : L(lang, `توقف ${a.name}؟`, `Suspend ${a.name}?`)}">${hidden}<button type="submit" class="${a.suspended_at ? "" : "danger"}">${a.suspended_at ? L(lang, "رجّع الوكالة", "Resume") : L(lang, "أوقف الوكالة", "Suspend")}</button></form>
</section>
<p><a href="/app/owner/agencies/${a.id}/ai-log">${L(lang, "سجل الذكاء الاصطناعي", "AI log")}</a></p>`;
}

/** Owner: an announcement to every manager, and the owner's own action log. */
function announceSection(log, lang, csrf) {
  const label = { owner_plan: L(lang, "تغيير باقة", "Plan change"), owner_suspend: L(lang, "إيقاف", "Suspend"), owner_resume: L(lang, "رجوع", "Resume"), owner_announcement: L(lang, "إعلان", "Announcement") };
  return html`<section class="card stack" id="announce"><h2>${L(lang, "إعلان لكل المديرين", "Announcement to every manager")}</h2>
  <form method="post" action="/app/owner/announce" class="stack" data-confirm="${L(lang, "تبعت الإعلان لكل المديرين؟", "Send this to every manager?")}"><input type="hidden" name="_csrf" value="${csrf}">
    <label>${L(lang, "العنوان", "Title")}<input name="title" required maxlength="120"></label>
    <label>${L(lang, "التفاصيل (اختياري)", "Details (optional)")}<textarea name="body" rows="3" maxlength="600"></textarea></label>
    <button type="submit">${L(lang, "ابعت", "Send")}</button>
  </form></section>
<section class="card list" id="owner-log"><h2>${L(lang, "سجل تصرفاتك", "Your actions log")}</h2>
  ${log.length ? html`<ul class="rows">${log.map((r) => html`<li class="listrow"><span>${label[r.operation_type] || r.operation_type}${r.agency ? ` · ${r.agency}` : ""}${r.metadata?.plan ? ` · ${r.metadata.plan}` : ""}${r.metadata?.title ? ` · ${r.metadata.title}` : ""}</span><b class="muted small" dir="ltr">${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}</b></li>`)}</ul>` : html`<p class="muted">${L(lang, "مفيش لسه.", "Nothing yet.")}</p>`}
</section>`;
}

const ownerTabs = (lang, panels) => html`<div class="tabs otabs">
  ${panels.map((_, i) => html`<input type="radio" name="owner_tab" id="ot-${i + 1}" class="tab-radio t${i + 1}"${i === 0 ? html` checked` : ""}>`)}
  <div class="tab-bar" role="tablist">${panels.map(([label], i) => html`<label for="ot-${i + 1}" role="tab" class="l${i + 1}">${label}</label>`)}</div>
  ${panels.map(([, body], i) => html`<div class="tab-panel p${i + 1}" data-tab="ot-${i + 1}">${body}</div>`)}
</div>`;

function ownerPage(d, lang, { billing = null, notice = null, reading = [], assistant = [], referrals = null, intakes = [], stuck = [], limits = null, agencies = [], log = [], csrf = "" } = {}) {
  const usd = (n) => `$${Number(n).toFixed(n < 1 ? 4 : 2)}`;
  return html`<h1>${L(lang, "متابعة التطبيق", "App tracking")}</h1>
${notice || ""}
${ownerTabs(lang, [
  [L(lang, "الوكالات", "Agencies"), html`${agenciesSection(agencies, lang)}${stuckSection(stuck, lang)}${announceSection(log, lang, csrf)}`],
  [L(lang, "الفلوس", "Money"), html`${billing ? billingSections(billing, lang) : ""}${referrals ? referralsSection(referrals, lang) : ""}${limits ? limitsSection(limits, lang) : ""}`],
  [L(lang, "الأدوات", "Tools"), html`${intakeSection(intakes, lang)}${readingSection(reading, lang)}${assistantSection(assistant, lang)}`],
  [L(lang, "الصحة", "Health"), healthSections(d, lang, usd)]
])}`;
}

function healthSections(d, lang, usd) {
  return html`<section class="card">
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
    (a) => html`<tr data-agency="${a.id}"><td><a href="/app/owner/agencies/${a.id}/ai-log" title="${L(lang, "سجل الذكاء الاصطناعي", "AI log")}">${a.name}</a></td><td>${a.brokers ?? 0}</td><td>${a.telegram ?? 0}</td><td>${a.calls}</td><td>${a.failed}</td><td dir="ltr">${usd(a.usd)}</td></tr>`
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
    const d = await Dash.agencyDashboard(pool, req.session.broker, { days: req.query.days, brokerId: String(req.query.broker || "") || null });
    if (!d) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    const [leases, targets, quotas, scope] = await Promise.all([Leases.upcoming(pool, req.session.broker), Targets.progress(pool, req.session.broker.agency_id), Quotas.forAgency(pool, req.session.broker.agency_id), Privacy.scopeOf(pool, req.session.broker.agency_id)]);
    return page(req, res, { title: L(lang, "لوحة الوكالة", "Agency dashboard"), nav: "dashboard", body: html`${agencyPage(d, lang)}${privacySection(scope, lang, req.session.csrf, req.query.privacy)}${quotaSection(quotas, lang)}${targetsSection([...targets.values()], lang)}${leaseEnds(leases || [], lang)}` });
  });

  // Who sees a unit's private details (services/unitPrivacy.js); managers only.
  web.post("/dashboard/secret-details", async (req, res) => {
    const out = await Privacy.setScope(pool, req.session.broker, String(req.body.scope || ""));
    if (!out.ok) return res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
    return res.redirect(303, "/app/dashboard?privacy=saved#data-security");
  });

  // The whole inventory as Excel: managers only, and every download is logged.
  web.get("/units-export.xlsx", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
    const t0 = Date.now();
    const { rows: listings } = await pool.query("SELECT * FROM listings WHERE agency_id = $1 AND status = 'active' ORDER BY created_at DESC", [broker.agency_id]);
    const { rows: agencies } = await pool.query("SELECT * FROM agencies WHERE id = $1", [broker.agency_id]);
    const buf = await require("../../lib/excel").buildAgencyInventoryWorkbook({ listings, agency: agencies[0], broker, lang: langOf(req) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "command_inventory_export", status: "success", total_duration_ms: Date.now() - t0, metadata: { channel: "web", rowsCount: listings.length } });
    return res
      .set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="Inventory_${new Date().toISOString().slice(0, 10)}.xlsx"` })
      .send(buf);
  });

  const ownerView = async (req, res, notice = null, status = 200) => {
    const d = await Dash.ownerDashboard(pool, req.session.broker);
    if (!d) return notFound(req, res, page);
    const [open, signups, payments, payTo, trials, reading, assistant, referrals, intakes, stuck, limits] = await Promise.all([Signup.isOpen(pool), Signup.pending(pool), Billing.pendingPayments(pool), Billing.payTo(pool), Billing.trialAgencies(pool), PriceReading.overview(pool), Assistant.overview(pool), Referrals.overview(pool), Intake.overview(pool), Onboarding.stuckList(pool), Billing.planLimits(pool)]);
    const [agencies, log] = await Promise.all([OwnerAgencies.list(pool), OwnerAgencies.auditLog(pool)]);
    return page(req, res, { title: L(langOf(req), "متابعة التطبيق", "App tracking"), nav: "owner", body: ownerPage(d, langOf(req), { billing: { open, signups, payments, payTo, trials }, notice, reading, assistant, referrals, intakes, stuck, limits, agencies, log, csrf: req.session.csrf }) }, status);
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

  // One agency's page and its controls (plan, suspend), and an announcement to every manager.
  const agencyView = async (req, res, lang, notice = null, status = 200) => {
    const a = uuidParam(req) ? await OwnerAgencies.get(pool, req.params.id) : null;
    if (!a) return notFound(req, res, page);
    return page(req, res, { title: a.name, nav: "owner", body: agencyControlPage(a, lang, req.session.csrf, notice) }, status);
  };
  web.get("/owner/agencies/:id", ownerOnly((req, res, lang) => agencyView(req, res, lang)));
  web.post("/owner/agencies/:id/plan", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.setPlan(pool, req.session.broker, req.params.id, { plan: req.body.plan, until: req.body.until || null, months: req.body.until ? null : req.body.months ?? null, pilot: req.body.pilot === "1" });
    if (r.error === "not_found") return notFound(req, res, page);
    if (r.error) return agencyView(req, res, lang, bad(L(lang, "راجع الباقة والتاريخ.", "Check the plan and the date.")), 422);
    return agencyView(req, res, lang, ok(L(lang, "الباقة اتحفظت.", "Plan saved.")));
  }));
  web.post("/owner/agencies/:id/suspend", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.suspend(pool, req.session.broker, req.params.id);
    if (r.error === "not_found") return notFound(req, res, page);
    return agencyView(req, res, lang, r.ok ? ok(L(lang, `اتوقفت (${r.brokers} بروكر).`, `Suspended (${r.brokers} brokers).`)) : bad(L(lang, "موقوفة بالفعل.", "Already suspended.")));
  }));
  web.post("/owner/agencies/:id/resume", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.resume(pool, req.session.broker, req.params.id);
    if (r.error === "not_found") return notFound(req, res, page);
    return agencyView(req, res, lang, r.ok ? ok(L(lang, `رجعت (${r.brokers} بروكر).`, `Resumed (${r.brokers} brokers).`)) : bad(L(lang, "مش موقوفة.", "Not suspended.")));
  }));
  web.post("/owner/announce", ownerOnly(async (req, res, lang) => {
    const r = await OwnerAgencies.announce(pool, req.session.broker, { title: req.body.title, body: req.body.body });
    return ownerView(req, res, r.ok ? ok(L(lang, `الإعلان اتبعت لـ ${r.sent} مدير.`, `Sent to ${r.sent} managers.`)) : bad(L(lang, "اكتب عنوان.", "Type a title.")), r.ok ? 200 : 422);
  }));

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

  web.post("/owner/plan-limits", ownerOnly(async (req, res, lang) => {
    await Billing.savePlanLimits(pool, req.body);
    return ownerView(req, res, ok(L(lang, "حدود الوحدات اتحفظت.", "Unit caps saved.")));
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
