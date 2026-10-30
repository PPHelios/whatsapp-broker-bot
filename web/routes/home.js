// web/routes/home.js — /app/ home of a signed-in broker
"use strict";

const { html, navFor } = require("../html");
const { icon } = require("../icons");
const Dash = require("../../services/dashboards");
const Onboarding = require("../../services/onboarding");
const Digest = require("../../services/dailyDigest");

/** Onboarding: the welcome card after the first sign-in, until the broker closes it. */
function welcomeCard(w, en) {
  return html`<section class="card welcome stack" data-welcome>
  <h2>${w.title}</h2>
  <p class="muted">${en ? "Four steps and you're set:" : "أربع خطوات وتبقى جاهز:"}</p>
  <ol>${w.steps.map((s) => html`<li><a href="${s.href}">${s.text}</a></li>`)}</ol>
  <form method="post" action="/app/onboarding/welcome"><button type="submit">${en ? "Got it" : "تمام، فهمت"}</button></form>
</section>`;
}

function register(web, { pool, page }) {
  web.post("/onboarding/welcome", async (req, res) => {
    await Onboarding.closeWelcome(pool, req.session.broker);
    return res.redirect(303, "/app/");
  });
  // The welcome card's Telegram step: the broker links their own account.
  web.get("/onboarding/telegram", async (req, res) => {
    const url = await Onboarding.telegramLink(pool, req.session.broker);
    return res.redirect(303, url || "/app/settings");
  });
  // More: every page that isn't on the bottom bar, grouped, plus language, support and Sign out.
  web.get("/more", (req, res) => {
    const { broker } = req.session;
    const en = broker.preferred_lang === "en";
    const groups = [
      ["work", en ? "Work" : "الشغل"],
      ["agency", en ? "Agency" : "الوكالة"],
      ["account", en ? "Account" : "الحساب"]
    ];
    const items = navFor(broker);
    const support = Onboarding.supportUrl(broker, en ? "en" : "ar");
    const row = (href, ic, label, extra = "") => html`<li><a class="listrow" href="${href}"${extra}>${icon(ic)}<span>${label}</span></a></li>`;
    return page(req, res, {
      title: en ? "More" : "المزيد",
      body: html`<h1>${en ? "More" : "المزيد"}</h1>
${groups.map(([g, label]) => {
  const list = items.filter((n) => n.group === g);
  return list.length ? html`<section class="card list" data-more="${g}"><h2>${label}</h2><ul class="rows">${list.map((n) => row(n.href, n.icon, en ? n.en : n.ar))}</ul></section>` : "";
})}
<section class="card list"><ul class="rows">
  <li><a class="listrow" data-lang-switch href="?lang=${en ? "ar" : "en"}" hreflang="${en ? "ar" : "en"}" lang="${en ? "ar" : "en"}">${icon("globe")}<span>${en ? "عربي" : "English"}</span></a></li>
  ${row("/app/report", "bug", en ? "Report a problem" : "بلّغ عن مشكلة")}
  ${support ? html`<li><a class="listrow" href="${support}" target="_blank" rel="noopener" data-support>${icon("support")}<span>${en ? "Talk to a person" : "كلّم حد من فريقنا"}</span></a></li>` : ""}
  <li><form method="post" action="/app/logout" class="logout"><button type="submit" class="listrow danger">${icon("logout")}<span>${en ? "Sign out" : "خروج"}</span></button></form></li>
</ul></section>`
    });
  });
  // The + button: everything a broker adds, one tap each.
  web.get("/add", (req, res) => {
    const en = req.session.broker.preferred_lang === "en";
    const tile = (href, ic, title, sub) => html`<a class="tile-link" href="${href}">${icon(ic, 28)}<span><b>${title}</b><span class="muted">${sub}</span></span></a>`;
    return page(req, res, {
      title: en ? "Add" : "إضافة",
      body: html`<h1>${en ? "Add" : "إضافة"}</h1>
<div class="tiles">
  ${tile("/app/units/new", "mic", en ? "Add a unit" : "إضافة وحدة", en ? "Speak, paste a description, or fill the form" : "سجّل فويس، الصق الوصف، أو املأ الفورم")}
  ${tile("/app/leads/new", "leads", en ? "New lead" : "عميل جديد", en ? "Paste the client's message or type it" : "الصق رسالة العميل أو اكتبها")}
  ${tile("/app/deals/new", "deal", en ? "Record a deal" : "سجّل صفقة", en ? "Unit, client and commission" : "الوحدة والعميل والعمولة")}
  ${tile("/app/import", "import", en ? "Import units" : "استيراد وحدات", en ? "Excel sheet, group posts or chat export" : "شيت إكسيل، بوستات الجروبات أو تصدير الشات")}
  ${tile("/app/leads/import", "import", en ? "Import leads" : "استيراد عملاء", en ? "CSV or Excel from Facebook or your sheet" : "ملف من فيسبوك أو شيتك")}
</div>`
    });
  });
  // Open pages refresh their CSRF token from here (web/static/app.js) so a form left open still saves.
  web.get("/csrf", (req, res) => res.json({ csrf: req.session.csrf }));
  web.get("/", async (req, res) => {
    const { broker, agency } = req.session;
    const en = broker.preferred_lang === "en";
    const now = new Date();
    const [welcome, day] = await Promise.all([Onboarding.welcomeFor(pool, broker), Digest.briefData(pool, broker, now).catch(() => null)]);
    return page(req, res, { title: en ? "Today" : "اليوم", body: todayPage({ broker, agency, welcome, day, now, en }) });
  });
}

const fmtTime = (d, en) => new Date(d).toLocaleTimeString(en ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
const fmtDay = (d, en) => new Date(d).toLocaleDateString(en ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", weekday: "long", day: "numeric", month: "long" });
const digits = (p) => String(p || "").replace(/[^0-9]/g, "");

/** Today: the broker's day at a glance (counts, then the people who need them now with Call and WhatsApp). */
function todayPage({ broker, agency, welcome, day, now, en }) {
  const d = day || { viewings: [], calls: [], overdue: [], hot: [], matches: [], uncontacted: 0 };
  const seen = new Set();
  const tasks = [];
  const add = (r, chip, cls, note) => {
    if (!r || seen.has(r.ref)) return;
    seen.add(r.ref);
    tasks.push({ ...r, chip, cls, note });
  };
  for (const r of d.overdue) add(r, en ? "Late" : "متأخرة", "late", r.next_follow_up_at ? fmtDay(r.next_follow_up_at, en) : "");
  for (const r of d.viewings) add(r, en ? "Viewing" : "معاينة", "good", `${fmtTime(r.next_follow_up_at, en)}${r.unit_code ? ` · ${r.unit_code}` : ""}`);
  for (const r of d.hot) add(r, en ? "Very interested" : "مهتم جداً", "hot", en ? "Opened your link" : "فتح الرابط اللي بعته");
  for (const r of d.calls) add(r, en ? "Call" : "مكالمة", "new", fmtTime(r.next_follow_up_at, en));
  for (const r of d.matches) add(r, en ? `${r.n} new matches` : `${r.n} وحدة مناسبة`, "new", en ? "New units fit this client" : "وحدات جديدة تناسب العميل");
  const shown = tasks.slice(0, 8);
  const greet = en ? `Hello ${broker.name}` : `أهلاً ${broker.name}`;
  const count = (n, label, href, cls = "") => html`<a class="count ${cls}" href="${href}"><strong>${n}</strong><span>${label}</span></a>`;
  return html`<section class="today-head">
  <span class="muted">${fmtDay(now, en)} · ${agency.name}</span>
  <h1>${greet}</h1>
  <form method="get" action="/app/search" class="searchbox" role="search">
    ${icon("search", 20)}<input name="q" aria-label="${en ? "Search" : "بحث"}" placeholder="${en ? "Search: 3-bed flat in New Cairo under 5M" : "دوّر: شقة 3 غرف في التجمع تحت 5 مليون"}" enterkeyhint="search">
    <a class="mic" href="/app/search?voice=1" aria-label="${en ? "Search by voice" : "بحث بالصوت"}">${icon("mic", 20)}</a>
  </form>
</section>
<div class="counts">
  ${count(d.calls.length + d.viewings.length, en ? "Follow-ups today" : "متابعات النهارده", "/app/leads?tab=due_today")}
  ${count(d.viewings.length, en ? "Viewings" : "معاينات", "/app/leads?tab=viewing")}
  ${count(d.uncontacted, en ? "New leads" : "عملاء جداد", "/app/leads?tab=new", d.uncontacted ? "hot" : "")}
</div>
${welcome ? welcomeCard(welcome, en) : ""}
<section class="stack" data-today>
  <div class="row between"><h2>${en ? "Needs you now" : "مطلوب منك دلوقتي"}</h2><a href="/app/leads?tab=overdue">${en ? "All" : "الكل"}</a></div>
  ${shown.length
    ? shown.map(
        (t) => html`<article class="card task" data-task="${t.ref}">
    <div class="row between"><a class="grow" href="/app/leads/${t.ref}"><b>${t.name || t.ref}</b><span class="muted">${t.note}</span></a><span class="chip ${t.cls}">${t.chip}</span></div>
    <div class="row actions">
      ${t.phone_e164 ? html`<a class="btn call" href="tel:+${digits(t.phone_e164)}">${en ? "Call" : "اتصال"}</a><a class="btn secondary" href="https://wa.me/${digits(t.phone_e164)}" target="_blank" rel="noopener">${en ? "WhatsApp" : "واتساب"}</a>` : ""}
      <a class="btn secondary" href="/app/leads/${t.ref}" aria-label="${en ? "Open" : "افتح"}">${icon("back", 20)}</a>
    </div>
  </article>`
      )
    : html`<p class="card muted empty">${en ? "Nothing waiting. Add a unit or a lead with the + button." : "مفيش حاجة مستنياك. ضيف وحدة أو عميل من زرار +."}</p>`}
  ${tasks.length > shown.length ? html`<a class="btn secondary" href="/app/leads?tab=overdue">${en ? `${tasks.length - shown.length} more` : `${tasks.length - shown.length} كمان`}</a>` : ""}
</section>
${Dash.isManager(broker)
  ? html`<div class="row shortcuts"><a class="btn secondary" href="/app/dashboard">${icon("chart", 20)} ${en ? "Agency dashboard" : "لوحة الوكالة"}</a>${Dash.isOwner(broker) ? html`<a class="btn secondary" href="/app/owner">${icon("tools", 20)} ${en ? "App tracking" : "متابعة التطبيق"}</a>` : ""}</div>`
  : ""}`;
}

module.exports = { register };
