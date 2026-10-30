// web/routes/assistant.js — "Ask" (Release B, C10 + N1): the assistant on the website. The broker asks about a project,
// their clients, follow-ups or units; the answer comes from the agency's own data only, with the data dates, or says it
// is not in our data. A web answer (owner switch) is shown apart, labelled unverified, with its source links. A found
// answer about a project has a "Send on WhatsApp" button. Managers also see the recent questions the data could not
// answer, so they know what to add. Logic lives in services/assistant.js.
"use strict";

const Assistant = require("../../services/assistant");
const A = require("../../domain/assistant");
const { isManager } = require("../../lib/authz");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const day = (d) => new Date(d).toISOString().slice(0, 10);

const ERRORS = {
  empty: ["اكتب سؤالك.", "Write your question."],
  quota: ["المساعد وصل لحد النهارده، جرب بكرة.", "The assistant reached today's limit; try tomorrow."],
  info: ["مش لاقي المشروع أو الوحدة دي.", "That project or unit wasn't found."],
  ai: ["المساعد مش متاح دلوقتي، جرب كمان شوية.", "The assistant is not available right now; try again shortly."]
};

function answerCard(out, question, lang) {
  const al = out.lang;
  const dates = out.found ? Assistant.datesLine(out.dates || [], al) : "";
  const forClient = out.found && out.dates?.length;
  return html`<section class="card ${out.found ? "notice ok" : ""}" data-assistant-answer data-found="${out.found ? "yes" : "no"}">
  <p class="muted">❓ ${question}</p>
  <p class="pre" data-answer-text>${out.answer}</p>
  ${dates ? html`<p class="muted" data-answer-dates>${dates}</p>` : ""}
  ${forClient ? html`<p><a class="btn" href="https://wa.me/?text=${encodeURIComponent(out.answer)}" target="_blank" rel="noopener noreferrer" data-send-whatsapp>📤 ${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>` : ""}
</section>`;
}

function register(web, { pool, page }) {
  const show = async (req, res, { question = "", out = null, error = null, saved = null } = {}, status = 200) => {
    const lang = langOf(req);
    const broker = req.session.broker;
    const missed = isManager(broker) ? await Assistant.unanswered(pool, broker) : null;
    const projects = missed?.length ? (await pool.query("SELECT id, name FROM projects WHERE agency_id = $1 AND archived_at IS NULL ORDER BY name LIMIT 200", [broker.agency_id])).rows : [];
    return page(req, res, {
      title: L(lang, "اسأل", "Ask"),
      nav: "ask",
      body: html`<h1>💬 ${L(lang, "اسأل المساعد", "Ask the assistant")}</h1>
<p class="muted">${L(lang, "بيرد من بيانات الوكالة بس (المشاريع، الأسعار، البروشور، عملاءك، متابعاتك، الوحدات) ومعاه تاريخ البيانات. لو المعلومة مش عندنا هيقولك كده ومش هيخمّن.", "Answers only from the agency's data (projects, prices, brochures, your clients, follow-ups, units), with the data's date. If we don't have it, it says so and never guesses.")}</p>
${saved ? html`<p class="notice ok card" data-info-saved>✅ ${L(lang, `اتضافت المعلومة على ${saved.kind === "unit" ? "الوحدة" : "المشروع"} ${saved.name}. المساعد هيستخدمها من دلوقتي.`, `Added to ${saved.kind === "unit" ? "unit" : "project"} ${saved.name}. The assistant will use it from now on.`)}</p>` : ""}
${error ? html`<p class="notice bad card" data-assistant-error="${error}">${(ERRORS[error] || ERRORS.ai)[lang === "en" ? 1 : 0]}</p>` : ""}
<form method="post" action="/app/ask" class="card stack">
  <label>${L(lang, "سؤالك", "Your question")}
  <textarea name="q" rows="3" maxlength="${A.MAX_QUESTION}" required placeholder="${L(lang, "مثلا: امتى استلام بادية؟ مين من عملائي عايز 3 أوض في زايد؟ ورايا إيه النهارده؟", "e.g. When is Badya's delivery? Which of my clients want 3 bedrooms in Zayed? What's due today?")}">${question}</textarea></label>
  <button type="submit">${L(lang, "اسأل", "Ask")}</button>
</form>
${out ? answerCard(out, question, lang) : ""}
${missed
  ? html`<section class="card" data-unanswered><h2>${L(lang, "أسئلة ملقيناش ردها في بياناتنا", "Questions our data could not answer")}</h2>
  <p class="muted">${L(lang, "ضيف المعلومة دي للمشروع أو الوحدة عشان المساعد يرد عليها المرة الجاية.", "Add this information to the project or unit so the assistant can answer next time.")}</p>
  ${missed.length
    ? html`<ul>${missed.map(
        (m) => html`<li data-question="${m.id}">${day(m.created_at)} · ${m.broker_name || "—"}: ${m.question}
    <details><summary>➕ ${L(lang, "ضيف الإجابة", "Add the answer")}</summary>
      <form method="post" action="/app/ask/info" class="stack">
        <input type="hidden" name="question" value="${m.id}">
        <label>${L(lang, "المشروع", "Project")} <select name="project"><option value="">—</option>${projects.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
        <label>${L(lang, "أو كود الوحدة", "Or unit code")} <input name="unit" dir="ltr" maxlength="40" placeholder="NH-V12"></label>
        <label>${L(lang, "المعلومة", "The information")} <textarea name="text" rows="2" maxlength="500" required></textarea></label>
        <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
      </form>
    </details></li>`
      )}</ul>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
</section>`
  : ""}`
    }, status);
  };

  web.get("/ask", (req, res) => show(req, res));

  web.post("/ask/info", async (req, res) => {
    const lang = langOf(req);
    const r = await Assistant.addInfo(pool, req.session.broker, { questionId: req.body.question, project: req.body.project, unit: req.body.unit, text: req.body.text });
    if (r.error === "forbidden") return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    if (r.error) return show(req, res, { error: r.error === "empty" ? "empty" : "info" }, 400);
    return show(req, res, { saved: r.target });
  });

  web.post("/ask", async (req, res) => {
    const question = String(req.body.q || "").trim().slice(0, A.MAX_QUESTION);
    if (!question) return show(req, res, { error: "empty" }, 400);
    const out = await Assistant.ask(pool, req.session.broker, question, { channel: "web" });
    if (out.error) return show(req, res, { question, error: out.error }, out.error === "empty" ? 400 : 200);
    return show(req, res, { question, out });
  });
}

module.exports = { register };
