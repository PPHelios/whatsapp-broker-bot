// web/routes/team.js — "My team" for managers (5.5): the agency's brokers, inviting one with a Telegram start link,
// a fresh link for someone not linked yet, and deactivating a broker. The start link is shown once on the page that
// created it (no-store) with a "Send on WhatsApp" button that opens the manager's own WhatsApp; it is never stored in
// clear. Logic lives in services/team.js.
"use strict";

const Team = require("../../services/team");
const Phone = require("../../domain/phone");
const RateLimit = require("../../lib/rateLimit");
const { MANAGER_ROLES } = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const INVITES = { limit: 30, windowSec: 24 * 3600 };
const LINKS = { limit: 30, windowSec: 24 * 3600 };

const ERRORS = {
  name: ["اكتب الاسم.", "Enter the name."],
  phone: ["رقم موبايل مصري صحيح (01xxxxxxxxx).", "A valid Egyptian mobile (01xxxxxxxxx)."],
  role: ["الدور لازم يبقى بروكر أو مدير.", "The role must be broker or manager."],
  phone_taken: ["الرقم ده مسجل مع وكالة تانية.", "This number is registered with another agency."],
  not_found: ["الوسيط مش موجود.", "Broker not found."],
  inactive: ["الوسيط موقوف؛ رجّعه الأول.", "The broker is deactivated; bring them back first."],
  self: ["مينفعش توقف نفسك.", "You can't deactivate yourself."],
  no_bot: ["بوت تيليجرام مش متظبط (TELEGRAM_BOT_USERNAME).", "The Telegram bot isn't set up (TELEGRAM_BOT_USERNAME)."],
  rate: ["دعوات كتير النهارده؛ جرب بكرة.", "Too many invites today; try tomorrow."],
  linked: ["الوسيط مربوط بتيليجرام بالفعل.", "This broker is already on Telegram."],
  rank: ["الأدمن والمالك يتداروا من الأدمن أو المالك بس.", "Only an admin or owner can manage an admin or owner."],
  forbidden: ["للمديرين بس.", "Managers only."]
};
const errorText = (code, lang) => (ERRORS[code] || ERRORS.forbidden)[lang === "en" ? 1 : 0];
const when = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

function linkCard(broker, url, agencyName, lang) {
  const wa = Phone.waMeUrl(broker.phone_number, Team.inviteText(broker, url, agencyName));
  return html`<section class="card notice ok" data-start-link>
  <h2>📨 ${L(lang, `لينك تيليجرام لـ ${broker.name}`, `Telegram link for ${broker.name}`)}</h2>
  <p dir="ltr"><input readonly value="${url}" aria-label="${L(lang, "لينك البداية", "Start link")}"></p>
  <p class="muted">${L(lang, "يشتغل مرة واحدة لمدة ٧ أيام. ابعته للوسيط؛ أول ما يدوس عليه حسابه على تيليجرام يتربط.", "Works once, for 7 days. Send it to the broker; tapping it links their Telegram account.")}</p>
  ${wa ? html`<p><a class="btn" href="${wa}" target="_blank" rel="noopener noreferrer">📤 ${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>` : ""}
</section>`;
}

function teamPage({ team, lang, notice = null, link = null }) {
  return html`<h1>👥 ${L(lang, "فريقي", "My team")}</h1>
${notice}
${link || ""}
<form method="post" action="/app/team/invite" class="card stack">
  <h2>➕ ${L(lang, "ضيف وسيط", "Invite a broker")}</h2>
  <label>${L(lang, "الاسم", "Name")} <input name="name" required maxlength="80"></label>
  <label>${L(lang, "الموبايل", "Mobile")} <input name="phone" required inputmode="tel" dir="ltr" placeholder="01xxxxxxxxx"></label>
  <label>${L(lang, "الدور", "Role")} <select name="role"><option value="broker">${L(lang, "بروكر", "Broker")}</option><option value="manager">${L(lang, "مدير", "Manager")}</option></select></label>
  <label>${L(lang, "لغة البوت", "Bot language")} <select name="lang"><option value="ar">العربية</option><option value="en">English</option></select></label>
  <button type="submit">${L(lang, "ضيف واعمل لينك تيليجرام", "Add and make a Telegram link")}</button>
</form>
<section class="card">
  <h2>${L(lang, "الفريق", "Team")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الاسم", "Name")}</th><th>${L(lang, "الدور", "Role")}</th><th>Telegram</th><th>${L(lang, "آخر نشاط", "Last active")}</th><th></th></tr></thead>
  <tbody>${team.map(
    (b) => html`<tr data-broker="${b.id}" data-active="${b.is_active ? "1" : "0"}">
  <td>${b.name}${b.is_active ? "" : html` <span class="muted">(${L(lang, "موقوف", "deactivated")})</span>`}</td>
  <td>${b.role}</td>
  <td>${b.telegram ? "✅" : b.link_until ? html`⏳ <span class="muted">${L(lang, `لينك لحد ${when(b.link_until)}`, `link until ${when(b.link_until)}`)}</span>` : "—"}</td>
  <td dir="ltr">${when(b.last_active_at)}</td>
  <td class="row">${b.is_active && !b.telegram ? html`<form method="post" action="/app/team/${b.id}/link"><button type="submit" class="secondary">🔗 ${L(lang, "لينك جديد", "New link")}</button></form>` : ""}
  ${b.is_active ? html`<form method="post" action="/app/team/${b.id}/deactivate" data-confirm="${L(lang, "متأكد؟ عملاؤه هيرجعوا للمدير.", "Sure? Their leads go back to the managers.")}"><button type="submit" class="secondary">⛔ ${L(lang, "إيقاف", "Deactivate")}</button></form>` : html`<form method="post" action="/app/team/invite"><input type="hidden" name="name" value="${b.name}"><input type="hidden" name="phone" value="${b.phone_number}"><input type="hidden" name="role" value="${["broker", "manager"].includes(b.role) ? b.role : "broker"}"><button type="submit" class="secondary">↩️ ${L(lang, "رجّعه", "Bring back")}</button></form>`}</td>
</tr>`
  )}</tbody></table></div>
  <p class="muted">${L(lang, "الإيقاف بيقفل دخوله فوراً وبيرجّع عملاءه للمديرين.", "Deactivating signs them out at once and returns their leads to the managers.")}</p>
</section>`;
}

function register(web, { pool, page }) {
  const forbidden = (req, res) => res.status(403).type("text/plain").send(errorText("forbidden", langOf(req)));
  const render = async (req, res, extra = {}, status = 200) => {
    const lang = langOf(req);
    const team = await Team.listTeam(pool, req.session.broker);
    if (!team) return forbidden(req, res);
    return page(req, res, { title: L(lang, "فريقي", "My team"), nav: "settings", body: teamPage({ team, lang, ...extra }) }, status);
  };
  const bad = (code, lang) => html`<p class="card notice bad" role="alert">❌ ${errorText(code, lang)}</p>`;

  web.get("/team", (req, res) => render(req, res));

  web.post("/team/invite", async (req, res) => {
    const lang = langOf(req);
    const manager = req.session.broker;
    if (!MANAGER_ROLES.includes(String(manager.role || "").toLowerCase())) return forbidden(req, res);
    const rl = await RateLimit.hit(pool, `team_invite:agency:${manager.agency_id}`, INVITES);
    if (!rl.allowed) return render(req, res, { notice: bad("rate", lang) }, 429);
    const r = await Team.invite(pool, manager, { name: req.body.name, phone: req.body.phone, role: req.body.role, lang: req.body.lang });
    if (r.error) return render(req, res, { notice: bad(r.error, lang) }, ["forbidden", "rank"].includes(r.error) ? 403 : 400);
    const notice = html`<p class="card notice ok" role="status">✅ ${r.created ? L(lang, `اتضاف ${r.broker.name}.`, `${r.broker.name} added.`) : L(lang, `${r.broker.name} رجع للفريق.`, `${r.broker.name} is back on the team.`)}${r.noBot ? html` ${errorText("no_bot", lang)}` : ""}</p>`;
    return render(req, res, { notice, link: r.url ? linkCard(r.broker, r.url, req.session.agency.name, lang) : null });
  });

  web.post("/team/:id/link", async (req, res) => {
    const lang = langOf(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return render(req, res, { notice: bad("not_found", lang) }, 404);
    if (!MANAGER_ROLES.includes(String(req.session.broker.role || "").toLowerCase())) return forbidden(req, res);
    const rl = await RateLimit.hit(pool, `team_link:agency:${req.session.broker.agency_id}`, LINKS);
    if (!rl.allowed) return render(req, res, { notice: bad("rate", lang) }, 429);
    const r = await Team.startLinkFor(pool, req.session.broker, req.params.id);
    if (r.error) return render(req, res, { notice: bad(r.error, lang) }, ["forbidden", "rank"].includes(r.error) ? 403 : 400);
    const { rows } = await pool.query("SELECT id, name, phone_number, preferred_lang FROM brokers WHERE id = $1", [r.broker.id]);
    return render(req, res, { link: linkCard(rows[0], r.url, req.session.agency.name, lang) });
  });

  web.post("/team/:id/deactivate", async (req, res) => {
    const lang = langOf(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return render(req, res, { notice: bad("not_found", lang) }, 404);
    const r = await Team.deactivate(pool, req.session.broker, req.params.id);
    if (r.error) return render(req, res, { notice: bad(r.error, lang) }, ["forbidden", "rank"].includes(r.error) ? 403 : 400);
    return render(req, res, {
      notice: html`<p class="card notice ok" role="status">✅ ${L(lang, `${r.broker.name} اتوقف؛ ${r.released} عميل رجعوا للمديرين.`, `${r.broker.name} deactivated; ${r.released} leads went back to the managers.`)}</p>`
    });
  });
}

module.exports = { register };
