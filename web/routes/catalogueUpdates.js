// web/routes/catalogueUpdates.js — Smart quick updates to the catalogue (Release A, C4), managers: type or record one
// change ("7% increase on Badya from next month", "B12-304 sold", "new plan 5% down 8 years on Badya"), check the card
// (unit count and an example), apply, and Undo within 24 hours. services/catalogueUpdates.js does the work.
"use strict";

const Updates = require("../../services/catalogueUpdates");
const RateLimit = require("../../lib/rateLimit");
const Session = require("../session");
const { isManager } = require("../../lib/authz");
const { uploads, VOICE } = require("../uploads");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const upload = uploads([VOICE], { maxMb: 10 });
Session.allowMultipart(/^\/catalogue\/updates$/);

const STATUS = { preview: ["معاينة", "Preview"], applied: ["اتطبق", "Applied"], undone: ["اتلغى", "Undone"], discarded: ["اتشال", "Discarded"] };
const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "");

/** One update as a card with its buttons (Apply / Discard on a preview; Undo for 24 hours once applied). */
function updateCard(u, lang, { csrf = "", now = new Date(), changed = null } = {}) {
  const c = Updates.card(u, lang);
  const base = `/app/catalogue/updates/${u.id}`;
  const form = (action, label, cls = "secondary") =>
    html`<form method="post" action="${base}/${action}" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="${cls}" data-cu-${action}>${label}</button></form>`;
  return html`<section class="card" id="cu-result" data-update="${u.id}" data-update-status="${u.status}">
  <h2>${c.title}</h2>
  <p class="muted">«${u.input}»</p>
  <ul>${c.lines.map((l) => html`<li>${l}</li>`)}</ul>
  ${changed !== null ? html`<p class="notice ok" data-cu-changed="${changed}">✅ ${L(lang, `اتطبق على ${changed} وحدة.`, `Applied to ${changed} units.`)}${u.action === "increase" && !u.payload?.now ? L(lang, " الزيادة هتتطبق في ميعادها.", " The increase applies on its date.") : ""}</p>` : ""}
  <div class="row">
    ${u.status === "preview" ? html`${form("apply", `✅ ${L(lang, "تطبيق", "Apply")}`, "")}${form("discard", `❌ ${L(lang, "إلغاء", "Discard")}`)}` : ""}
    ${Updates.canUndo(u, now) ? form("undo", `↩️ ${L(lang, "تراجع", "Undo")}`) : html`<span class="muted">${L(lang, ...STATUS[u.status])}</span>`}
  </div>
</section>`;
}

function inputCard(lang, text = "") {
  return html`<form method="post" action="/app/catalogue/updates" class="card stack" id="cu-form">
  <label>${L(lang, "التحديث (زي ما بتقوله)", "The update (as you would say it)")}<textarea name="text" rows="2" maxlength="1000" placeholder="${L(lang, "زيادة 7% على بادية من الشهر الجاي", "7% increase on Badya from next month")}">${text}</textarea></label>
  <div class="row">
    <button type="submit">⚡ ${L(lang, "اقرأ التحديث", "Read the update")}</button>
    <button type="button" class="secondary" data-voice-target="#cu-result" data-voice-url="/app/catalogue/updates" data-stop="■ ${L(lang, "إيقاف وإرسال", "Stop and send")}" data-unsupported="${L(lang, "المتصفح ده مش بيدعم التسجيل", "Recording is not supported here")}">🎙️ ${L(lang, "سجّل فويس", "Record voice")}</button>
  </div>
  <p class="muted">${L(lang, "أمثلة: «B12-304 اتباعت»، «تخفيض 5% على المرحلة 2 في بادية من 1/12»، «خطة جديدة 5% مقدم 8 سنين على بادية»، «سعر B12-304 9.5 مليون». هتشوف عدد الوحدات ومثال قبل أي تغيير.", "Examples: \"B12-304 sold\", \"5% cut on Phase 2 of Badya from 1/12\", \"new plan 5% down 8 years on Badya\", \"price B12-304 9.5M\". You see the unit count and an example before anything changes.")}</p>
</form>`;
}

function register(web, { pool, page }) {
  const forbidden = (req, res) => res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
  const errorCard = (out, lang) => html`<section class="card" id="cu-result"><p class="notice bad" data-cu-error="${out.error}">${Updates.errorText(out, lang)}</p></section>`;

  const show = async (req, res, result = "", status = 200, text = "") => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const recent = await Updates.listUpdates(pool, actor);
    return page(req, res, {
      title: L(lang, "تحديث سريع للكتالوج", "Quick catalogue update"),
      nav: "catalogue",
      body: html`<h1>⚡ ${L(lang, "تحديث سريع للكتالوج", "Quick catalogue update")}</h1>
<p><a href="/app/catalogue">${L(lang, "رجوع للكتالوج", "Back to the catalogue")}</a></p>
${inputCard(lang, text)}
${result || html`<section id="cu-result"></section>`}
${recent.length ? html`<section class="card"><h2>${L(lang, "آخر التحديثات", "Recent updates")}</h2><ul>${recent.map((u) => html`<li data-recent-update="${u.id}"><a href="/app/catalogue/updates/${u.id}">${Updates.card(u, lang).title}</a> <span class="muted">· ${L(lang, ...STATUS[u.status])} · <span dir="ltr">${when(u.created_at)}</span>${u.created_by_name ? ` · ${u.created_by_name}` : ""}</span></li>`)}</ul></section>` : ""}`
    }, status);
  };

  web.get("/catalogue/updates", async (req, res) => {
    if (!isManager(req.session.broker)) return forbidden(req, res);
    return show(req, res);
  });

  web.post("/catalogue/updates", upload, async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const htmx = req.get("HX-Request") === "true";
    const gate = await RateLimit.hit(pool, `extract:broker:${actor.id}`, RateLimit.LIMITS.extractBroker);
    if (!gate.allowed) {
      const out = errorCard({ error: "quota" }, lang);
      return htmx ? res.status(429).type("html").send(String(out)) : show(req, res, out, 429);
    }
    const file = (req.files?.voice || [])[0];
    const voice = file ? { buffer: file.buffer, mimeType: file.mimetype.split(";")[0] } : null;
    const out = await Updates.interpret(pool, actor, { text: voice ? "" : req.body.text, voice, channel: "web", lang });
    if (out.error === "forbidden") return forbidden(req, res);
    const fragment = out.error ? errorCard(out, lang) : updateCard(out.update, lang, { csrf: req.session.csrf });
    if (htmx) return res.status(out.error ? 400 : 200).type("html").send(String(fragment));
    if (out.error) return show(req, res, fragment, 400, out.input || req.body.text || "");
    return res.redirect(303, `/app/catalogue/updates/${out.update.id}`);
  });

  web.get("/catalogue/updates/:id", async (req, res, next) => {
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const u = await Updates.getUpdate(pool, actor, req.params.id);
    if (!u) return next();
    const changed = req.query.changed !== undefined ? Number(req.query.changed) || 0 : null;
    const notice = req.query.undone !== undefined ? html`<p class="notice ok" data-cu-undone="${req.query.undone}">↩️ ${L(langOf(req), `اترجع ${req.query.undone} وحدة.`, `${req.query.undone} units restored.`)}${Number(req.query.skipped) ? L(langOf(req), ` (${req.query.skipped} اتغيرت بعدها، سبناها)`, ` (${req.query.skipped} changed since, left as they are)`) : ""}</p>` : "";
    return show(req, res, html`${notice}${updateCard(u, langOf(req), { csrf: req.session.csrf, changed })}`);
  });

  const act = (fn, done) => async (req, res) => {
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const out = await fn(pool, actor, req.params.id);
    if (out.error === "forbidden") return forbidden(req, res);
    if (out.error) return show(req, res, errorCard(out, langOf(req)), 400);
    return res.redirect(303, done(req, out));
  };
  web.post("/catalogue/updates/:id/apply", act(Updates.apply, (req, out) => `/app/catalogue/updates/${req.params.id}?changed=${out.changed}`));
  web.post("/catalogue/updates/:id/discard", act(Updates.discard, () => "/app/catalogue/updates"));
  web.post("/catalogue/updates/:id/undo", act(Updates.undo, (req, out) => `/app/catalogue/updates/${req.params.id}?undone=${out.restored}&skipped=${out.skipped}`));
}

module.exports = { register, updateCard };
