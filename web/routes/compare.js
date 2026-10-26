// web/routes/compare.js — Compare up to 3 units for a client (Release A, C7): the broker picks 2 or 3 of the agency's
// active units and gets one link (/<agency>/compare/<token>) to send; the page shows client-safe facts side by side.
"use strict";

const Compare = require("../../lib/compareLinks");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

function register(web, { pool, page }) {
  const show = async (req, res, { codes = [], fresh = null, error = null } = {}, status = 200) => {
    const lang = langOf(req);
    const recent = await Compare.linksOf(pool, req.session.broker);
    const slots = [0, 1, 2].map((i) => codes[i] || "");
    return page(req, res, {
      title: L(lang, "مقارنة وحدات", "Compare units"),
      nav: "units",
      body: html`<h1>⚖️ ${L(lang, "مقارنة وحدات للعميل", "Compare units for a client")}</h1>
${error ? html`<p class="notice bad card" data-compare-error="${error.code}">${error.text}</p>` : ""}
${fresh
  ? html`<section class="card notice ok" id="compare-link"><h2>✅ ${L(lang, "الرابط جاهز", "The link is ready")}</h2>
  <p class="share-url" data-compare-url>${fresh.url}</p>
  <p><a class="btn" href="https://wa.me/?text=${encodeURIComponent(`${L(fresh.lang, "مقارنة الوحدات", "Unit comparison")} ${fresh.codes.join(" · ")}\n🔗 ${fresh.url}`)}" rel="noopener">${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p></section>`
  : ""}
<form method="post" action="/app/compare" class="card stack">
  <p class="muted">${L(lang, "اكتب كود 2 أو 3 وحدات متاحة. العميل بيشوف السعر وسعر المتر والمواصفات وأول خطة دفع والتسليم جنب بعض، من غير أي بيانات داخلية.", "Enter 2 or 3 available unit codes. The client sees price, price per m², details, the first payment plan and delivery side by side, with nothing internal.")}</p>
  <div class="row">${slots.map((c, i) => html`<input name="code" value="${c}" dir="ltr" size="10" placeholder="${L(lang, `كود ${i + 1}`, `Code ${i + 1}`)}" aria-label="${L(lang, `كود ${i + 1}`, `Code ${i + 1}`)}">`)}</div>
  <label>${L(lang, "لغة الصفحة", "Page language")} <select name="lang"><option value="ar">عربي</option><option value="en">English</option></select></label>
  <button type="submit">${L(lang, "اعمل رابط المقارنة", "Make the comparison link")}</button>
</form>
${recent.length ? html`<section class="card"><h2>${L(lang, "مقارناتك", "Your comparisons")}</h2><ul class="muted">${recent.map((r) => html`<li data-compare-opens="${r.open_count}">${day(r.created_at)} · ${r.codes.join(" · ")} · ${L(lang, `اتفتح ${r.open_count} مرة`, `opened ${r.open_count} time(s)`)}</li>`)}</ul></section>` : ""}`
    }, status);
  };

  web.get("/compare", (req, res) => show(req, res, { codes: Compare.parseCodes(req.query.codes || "") }));

  web.post("/compare", async (req, res) => {
    const lang = langOf(req);
    const codes = Compare.parseCodes(req.body.code);
    const linkLang = req.body.lang === "en" ? "en" : "ar";
    const out = await Compare.createCompareLink(pool, req.session.broker, codes, { lang: linkLang });
    if (out.error === "count") return show(req, res, { codes, error: { code: "count", text: L(lang, "اختار من 2 لـ 3 وحدات.", "Choose 2 or 3 units.") } }, 400);
    if (out.error) return show(req, res, { codes, error: { code: "missing", text: L(lang, `مش لاقيين وحدة متاحة بالكود: ${out.missing.join("، ")}`, `No available unit with code: ${out.missing.join(", ")}`) } }, 400);
    return show(req, res, { codes: out.codes, fresh: { ...out, lang: linkLang } });
  });
}

module.exports = { register };
