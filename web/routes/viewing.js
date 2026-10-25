// web/routes/viewing.js — The client's viewing page (phase 2 step 6), opened from the broker's WhatsApp message:
// /app/v/<token>. Open without signing in; it shows the agency, the broker, the time, the place and the unit, and lets
// the client confirm or ask for another time, and add it to a calendar. Never the client's own data.
"use strict";

const Viewings = require("../../services/viewings");
const Stages = require("../../domain/leadStages");
const Phone = require("../../domain/phone");
const RateLimit = require("../../lib/rateLimit");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const RESPOND = { limit: 10, windowSec: 3600 };
const STATUS = {
  proposed: ["⏳ مستني تأكيدك", "⏳ Waiting for your confirmation"],
  confirmed: ["✅ اتأكدت", "✅ Confirmed"],
  reschedule: ["🔁 طلبت ميعاد تاني؛ الوسيط هيكلمك", "🔁 You asked for another time; the broker will contact you"]
};

function langFor(req, v) {
  if (req.query.lang === "ar" || req.query.lang === "en") return req.query.lang;
  return req.cookies?.aq_lang ? req.lang : v.lang;
}

function viewingPage(v, token, lang, { notice = null } = {}) {
  const entry = Viewings.calendarEntry(v, { lang });
  const call = v.broker_phone ? Phone.normalizePhone(v.broker_phone) : null;
  return html`<section class="card stack" id="viewing" data-status="${v.status}">
  <h1>🏠 ${L(lang, "ميعاد المعاينة", "Your viewing")}</h1>
  <p class="muted">${v.agency_name}${v.broker_name ? ` · ${v.broker_name}` : ""}</p>
  ${notice || ""}
  <p><strong>📅 ${Viewings.whenLabel(v.starts_at, lang)}</strong></p>
  ${v.code ? html`<p>🏠 ${Viewings.unitLabel(v, lang)}</p>` : ""}
  ${v.place ? html`<p>📍 ${v.place}</p>` : ""}
  <p data-status-line>${STATUS[v.status][lang === "en" ? 1 : 0]}</p>
  <div class="row">
    <a class="btn secondary" href="/app/v/${token}/calendar.ics">📆 ${L(lang, "أضف للتقويم", "Add to calendar")}</a>
    <a class="btn secondary" href="${Viewings.googleCalendarUrl(entry)}" target="_blank" rel="noopener">Google Calendar</a>
    ${call ? html`<a class="btn secondary" href="tel:+${call}">📞 ${L(lang, "كلّم الوسيط", "Call the broker")}</a>` : ""}
  </div>
</section>
${v.status === "confirmed"
  ? ""
  : html`<form method="post" action="/app/v/${token}" class="card">
  <input type="hidden" name="action" value="confirm">
  <button type="submit">✅ ${L(lang, "أكّد الميعاد", "Confirm the time")}</button>
</form>`}
<form method="post" action="/app/v/${token}" class="card stack">
  <h2>🔁 ${L(lang, "الميعاد مش مناسب؟", "That time doesn't suit you?")}</h2>
  <input type="hidden" name="action" value="reschedule">
  <label>${L(lang, "اقترح ميعاد (بتوقيت القاهرة)", "Suggest a time (Cairo time)")} <input type="datetime-local" name="at"></label>
  <label>${L(lang, "أو اكتب للوسيط", "Or write to the broker")} <input name="note" maxlength="300"></label>
  <button type="submit" class="secondary">${L(lang, "ابعت للوسيط", "Send to the broker")}</button>
</form>`;
}

function gonePage(lang) {
  return html`<div class="card"><h1>⌛ ${L(lang, "اللينك ده مبقاش شغال", "This link no longer works")}</h1><p>${L(lang, "الميعاد اتغير أو عدّى. كلّم الوسيط بتاعك.", "The viewing was changed or has passed. Please contact your broker.")}</p></div>`;
}

function register(web, { pool, page }) {
  const title = (lang) => L(lang, "ميعاد المعاينة", "Your viewing");
  const show = (req, res, v, token, lang, extra = {}, status = 200) =>
    page(req, res, { title: title(lang), lang, langSwitch: true, body: viewingPage(v, token, lang, extra) }, status);

  web.get("/v/:token", async (req, res) => {
    // A private link: never indexed, cached or passed on as a referrer.
    res.set({ "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    const v = await Viewings.byToken(pool, req.params.token);
    const lang = v ? langFor(req, v) : req.lang;
    if (!v || !Viewings.isLive(v)) return page(req, res, { title: title(lang), lang, body: gonePage(lang) }, v ? 410 : 404);
    const notice = req.query.sent === "1" ? html`<p class="notice ok" role="status">${L(lang, "✅ وصل للوسيط. شكراً!", "✅ The broker has it. Thank you!")}</p>` : null;
    return show(req, res, v, req.params.token, lang, { notice });
  });

  web.post("/v/:token", async (req, res) => {
    const token = req.params.token;
    const v = await Viewings.byToken(pool, token);
    const lang = v ? langFor(req, v) : req.lang;
    if (!v || !Viewings.isLive(v)) return page(req, res, { title: title(lang), lang, body: gonePage(lang) }, v ? 410 : 404);
    const gate = await RateLimit.hit(pool, `viewing:${v.id}`, RESPOND);
    if (!gate.allowed) return show(req, res, v, token, lang, { notice: html`<p class="notice bad" role="alert">${L(lang, "طلبات كتير؛ جرب بعد شوية.", "Too many requests; try again later.")}</p>` }, 429);
    const action = req.body?.action === "confirm" ? "confirm" : "reschedule";
    const proposedAt = req.body?.at ? Stages.fromCairoLocal(req.body.at) || new Date(NaN) : null;
    const r = await Viewings.respond(pool, token, { action, proposedAt, note: req.body?.note });
    if (r.error === "time") return show(req, res, v, token, lang, { notice: html`<p class="notice bad" role="alert">${L(lang, "اختار ميعاد جاي أو اكتب ملاحظة.", "Pick a future time or write a note.")}</p>` }, 400);
    if (r.error) return page(req, res, { title: title(lang), lang, body: gonePage(lang) }, 410);
    return res.redirect(303, `/app/v/${token}?sent=1`);
  });

  web.get("/v/:token/calendar.ics", async (req, res) => {
    const v = await Viewings.byToken(pool, req.params.token);
    if (!v || !Viewings.isLive(v)) return res.status(404).type("text/plain").send("Not found");
    const lang = langFor(req, v);
    res.type("text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="viewing.ics"');
    return res.send(Viewings.ics(v, Viewings.calendarEntry(v, { lang })));
  });
}

module.exports = { register };
