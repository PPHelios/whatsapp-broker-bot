// web/routes/leadImports.js — Importing clients from a CSV or Excel file (Release 3 step 6): upload with the lawful-basis
// tick, a preview of what each row will do (new, merge, colleague, erased before, repeated, invalid), one apply that
// runs in the background with a progress bar, and the template. Nothing is written before the apply.
"use strict";

const RateLimit = require("../../lib/rateLimit");
const Sheets = require("../../lib/sheets");
const LeadImports = require("../../services/leadImports");
const Imports = require("../../services/imports");
const LeadImport = require("../../domain/leadImport");
const Stages = require("../../domain/leadStages");
const Card = require("../../domain/leadCard");
const Phone = require("../../domain/phone");
const { isManager } = require("../../lib/authz");
const { logOperation } = require("../../lib/db");
const Session = require("../session");
const { uploads } = require("../uploads");
const { html, raw } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const SHOWN = 200; // rows listed per section; the counts cover all of them
// Browsers send a CSV as text/csv, application/vnd.ms-excel (Windows) or nothing useful.
const FILE = { name: "file", maxCount: 1, accept: /^(text\/(csv|plain|comma-separated-values)|application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-excel|csv|octet-stream|zip))$/ };
const upload = uploads([FILE], { maxMb: 5 });
Session.allowMultipart(/^\/leads\/import$/);

const ImportTemplate = require("../../lib/importTemplate");
const TEMPLATE_HEADERS = [
  "Name / الاسم",
  "Phone / الموبايل",
  "Second phone / رقم تاني",
  "Lead type / نوع العميل",
  "Source / المصدر",
  "Budget / الميزانية",
  "Area or compound / المنطقة او الكمبوند",
  "Property type / نوع العقار",
  "Bedrooms / الغرف",
  "Sale or rent / بيع او ايجار",
  "Notes / ملاحظات",
  "Stage / المرحلة",
  "Assigned to / المسؤول",
  "Lawful basis / الأساس القانوني"
];

const KIND_LABEL = {
  new: ["🆕 عملاء جداد", "🆕 New leads"],
  merge: ["🔄 متسجلين بالفعل (هنكمّل الناقص بس)", "🔄 Already saved (only blanks are filled)"],
  colleague: ["👥 عملاء مع زملاء (مش هيتحولوا)", "👥 A colleague's clients (not reassigned)"],
  erased_before: ["🔒 طلبوا يتمسحوا قبل كده (مش هيتضافوا)", "🔒 Asked to be deleted before (not added)"],
  repeated: ["♻️ مكررين في الملف", "♻️ Repeated in the file"],
  invalid: ["⛔ صفوف فيها مشكلة", "⛔ Rows with a problem"]
};
const FILL_LABEL = { name: ["الاسم", "name"], source: ["المصدر", "source"], notes: ["الملاحظات", "notes"], phones: ["رقم جديد", "new number"], request: ["الطلب", "request"] };
const ORDER = ["new", "merge", "colleague", "erased_before", "repeated", "invalid"];

const who = (i, lang) => `${i.name || L(lang, "بدون اسم", "No name")} · ${i.phones.map((p) => Phone.displayPhone(p)).join("، ")}`;

function formBody(req, { error = null } = {}) {
  const lang = langOf(req);
  const manager = isManager(req.session.broker);
  return html`<h1>📥 ${L(lang, "استيراد عملاء من ملف", "Import clients from a file")}</h1>
${error ? html`<p class="card notice bad" role="alert">⚠️ ${error}</p>` : ""}
<form method="post" action="/app/leads/import" enctype="multipart/form-data" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <p class="muted">${L(lang, "ملف CSV أو إكسيل (.xlsx)، لحد 5 ميجا و2000 صف. لازم عمود الموبايل؛ الباقي اختياري. هنوريك كل صف هيعمل إيه قبل أي حفظ. استخدم", "A CSV or Excel (.xlsx) file, up to 5 MB and 2,000 rows. The phone column is required; the rest is optional. You see what each row will do before anything is saved. Use")} <a href="/app/leads/import/template.xlsx">${L(lang, "النموذج ده", "this template")}</a>.</p>
  <input type="file" name="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
  <fieldset class="stack"><legend>${L(lang, "الأساس القانوني للعملاء دول *", "Lawful basis for these clients *")}</legend>
    ${Stages.LAWFUL_BASES.map((b, i) => html`<label class="check"><input type="radio" name="basis" value="${b}"${i === 0 ? raw(" checked") : ""} required> ${Stages.basisLabel(b, lang)}</label>`)}
    <p class="muted">${L(lang, "عمود «الأساس القانوني» في الملف (لو موجود) بيغلب على الاختيار ده للصف بتاعه.", "A \"Lawful basis\" column in the file (if any) wins for its row.")}</p>
    <label class="check"><input type="checkbox" name="confirm" value="1" required> ${L(lang, "أأكد إن كل العملاء في الملف ده ليهم الأساس ده (طلبوا التواصل، أو وافقوا، أو عملاء حاليين).", "I confirm every client in this file has this basis (they asked to be contacted, consented, or are existing clients).")}</label>
  </fieldset>
  ${manager
    ? html`<label class="check"><input type="checkbox" name="round_robin" value="1"> ${L(lang, "وزّع العملاء الجداد اللي مالهمش وسيط في الملف على الوسطاء بالدور", "Share new clients with no broker in the file among the brokers, in turn")}</label>`
    : ""}
  <button type="submit">${L(lang, "راجع الملف", "Review the file")}</button>
</form>`;
}

function section(imp, kind, lang, body) {
  const rows = imp.payload.items.filter((i) => i.kind === kind);
  if (!rows.length) return "";
  const extra = rows.length - SHOWN;
  return html`<section class="card" data-kind="${kind}"><h2>${L(lang, KIND_LABEL[kind][0], KIND_LABEL[kind][1])} (${rows.length})</h2>
<ul>${rows.slice(0, SHOWN).map((i) => html`<li data-row="${i.row}">${L(lang, "صف", "Row")} ${i.row}: ${body(i)}</li>`)}</ul>
${extra > 0 ? html`<p class="muted">${L(lang, `و${extra} كمان`, `and ${extra} more`)}</p>` : ""}</section>`;
}

function planBody(imp, req) {
  const lang = langOf(req);
  const { counts } = imp.payload;
  const warn = (i) => (i.warnings?.length ? html`<div class="warn muted">${i.warnings.map((w) => LeadImport.warningLabel(w, lang)).join(" · ")}</div>` : "");
  const n = (counts.new || 0) + (counts.merge || 0);
  return html`<h1>📥 ${L(lang, "مراجعة الاستيراد", "Review the import")} <span class="muted">${imp.filename || ""}</span></h1>
<p class="muted" data-counts>${ORDER.filter((k) => counts[k]).map((k) => `${L(lang, KIND_LABEL[k][0], KIND_LABEL[k][1]).split(" (")[0]}: ${counts[k]}`).join(" · ")}</p>
${section(imp, "new", lang, (i) => html`${who(i, lang)} · ${Stages.kindLabel(i.fields.kind, lang)}${i.fields.stage && i.fields.stage !== "new" ? ` · ${Stages.stageLabel(i.fields.stage, lang)}` : ""}${i.assignee_name ? ` · 🧑‍💼 ${i.assignee_name}` : ""}${warn(i)}`)}
${section(imp, "merge", lang, (i) => html`${Card.refLabel(i.ref)} · ${who(i, lang)}${i.fills.length ? ` · ${L(lang, "هيتكمّل:", "Fills:")} ${i.fills.map((f) => L(lang, FILL_LABEL[f][0], FILL_LABEL[f][1])).join("، ")}` : ` · ${L(lang, "مفيش جديد", "Nothing new")}`}${warn(i)}`)}
${section(imp, "colleague", lang, (i) => who(i, lang))}
${section(imp, "erased_before", lang, (i) => who(i, lang))}
${section(imp, "repeated", lang, (i) => html`${who(i, lang)} · ${L(lang, `زي صف ${i.first}`, `same as row ${i.first}`)}`)}
${section(imp, "invalid", lang, (i) => html`${i.name || ""} ${i.reasons.map((r) => LeadImport.errorLabel(r, lang)).join("، ")}`)}
${n
  ? html`<form method="post" action="/app/leads/import/${imp.id}/apply" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <p>${L(lang, `هيتضاف ${counts.new || 0} عميل جديد ويتحدّث ${counts.merge || 0}. الباقي مش هيتلمس.`, `${counts.new || 0} new leads will be added and ${counts.merge || 0} updated. The rest is left alone.`)}</p>
  <button type="submit">✅ ${L(lang, "استورد", "Import")}</button>
</form>`
  : html`<p class="card">${L(lang, "مفيش صفوف ينفع تتضاف.", "No rows can be imported.")} <a href="/app/leads/import">${L(lang, "ملف تاني", "Another file")}</a></p>`}`;
}

function progressBody(imp, lang) {
  const r = imp.result || { done: 0, total: 0 };
  return html`<div id="lead-import" class="card stack" hx-get="/app/leads/import/${imp.id}" hx-trigger="every 2s" hx-select="#lead-import" hx-swap="outerHTML">
  <h1>⏳ ${L(lang, "جاري الاستيراد", "Importing")}</h1>
  <progress max="${r.total || 1}" value="${r.done}"></progress>
  <p data-progress>${r.done} / ${r.total}</p>
</div>`;
}

function resultBody(imp, lang) {
  const r = imp.result || {};
  const line = (label, n) => (n ? html`<li>${label}: ${n}</li>` : "");
  return html`<div id="lead-import" class="card notice" data-result>
  <h1>${imp.status === "failed" ? `❌ ${L(lang, "الاستيراد وقف", "The import stopped")}` : `✅ ${L(lang, "اتستورد", "Imported")}`}</h1>
  <ul>
    ${line(L(lang, "عملاء جداد", "New leads"), r.created)}
    ${line(L(lang, "اتحدّثوا", "Updated"), r.merged)}
    ${line(L(lang, "بقوا مع زملاء من ساعة المراجعة (متحولوش)", "Now a colleague's clients (not reassigned)"), r.colleague)}
    ${line(L(lang, "طلبوا يتمسحوا قبل كده", "Asked to be deleted before"), r.erased_before)}
    ${line(L(lang, "متضافوش", "Not added"), r.failed)}
  </ul>
  ${imp.status === "failed" ? html`<p>${L(lang, `اتعمل ${r.done || 0} من ${r.total || 0}.`, `${r.done || 0} of ${r.total || 0} were done.`)}</p>` : ""}
  <a class="btn" href="/app/leads">👤 ${L(lang, "العملاء", "Leads")}</a>
</div>`;
}

function register(web, { pool, page }) {
  const importPage = (req, res, body, status = 200) => page(req, res, { title: L(langOf(req), "استيراد عملاء", "Import clients"), nav: "leads", body }, status);

  web.get("/leads/import", (req, res) => importPage(req, res, formBody(req)));

  web.get("/leads/import/template.xlsx", async (_req, res) => {
    const buf = await ImportTemplate.build({
      sheetName: "Leads",
      headers: TEMPLATE_HEADERS,
      required: [1],
      samples: [
        ["أحمد علي (مثال)", "01012345678", "", "مشتري", "فيسبوك", "7-9 مليون", "التجمع الخامس", "شقة", 3, "بيع", "عايز تسليم قريب", "جديد", "", "صف تجريبي، امسحه"],
        ["منى حسن (مثال)", "01112345678", "", "مستأجر", "إعلان", "25 ألف", "الشيخ زايد", "شقة", 2, "إيجار", "", "جديد", "", "صف تجريبي، امسحه"]
      ],
      text: [2, 3],
      readme: [
        ["الموبايل هو العمود الوحيد المطلوب.", "The phone is the only mandatory column."],
        ["الصف اللي رقمه غلط بيتخطى ويظهرلك السبب.", "A row with a bad number is skipped and you see why."],
        ["أعمدة فيسبوك (platform, campaign_name) بتتقرأ تلقائياً.", "Meta export columns (platform, campaign_name) are read automatically."]
      ]
    });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", 'attachment; filename="wehdathub-leads-template.xlsx"');
    return res.send(buf);
  });

  web.post("/leads/import", upload, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, formBody(req, { error: L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.") }), 429);
    if (req.body.confirm !== "1" || !Stages.LAWFUL_BASES.includes(req.body.basis)) {
      return importPage(req, res, formBody(req, { error: L(lang, "لازم تختار الأساس القانوني وتأكده قبل الاستيراد.", "Pick the lawful basis and confirm it before importing.") }), 422);
    }
    const file = (req.files?.file || [])[0];
    let table;
    try {
      table = await Sheets.readTable(file?.buffer, { matcher: LeadImport.columnFor, minColumns: 1, noHeader: "No phone column" });
      if (!table.mapped.includes("phone") && !table.mapped.includes("phone2")) throw Object.assign(new Error("No phone column"), { code: "NO_HEADER" });
    } catch (err) {
      const msg = {
        NOT_XLSX: L(lang, "الملف لازم يكون CSV أو إكسيل .xlsx.", "The file must be a CSV or an .xlsx workbook."),
        NOT_TEXT: L(lang, "الملف لازم يكون CSV أو إكسيل .xlsx.", "The file must be a CSV or an .xlsx workbook."),
        TOO_LARGE: L(lang, "الملف أكبر من 5 ميجا.", "The file is larger than 5 MB."),
        NO_HEADER: L(lang, "مش لاقيين عمود الموبايل في أول صفوف الملف.", "No phone column found in the file's first rows."),
        TOO_MANY_ROWS: L(lang, `أكتر من ${Sheets.MAX_ROWS} صف.`, `More than ${Sheets.MAX_ROWS} rows.`)
      }[err.code];
      if (!msg) throw err;
      return importPage(req, res, formBody(req, { error: msg }), 422);
    }
    const plan = await LeadImports.planLeads(pool, broker, table, { basis: req.body.basis, roundRobin: req.body.round_robin === "1" });
    const id = await LeadImports.savePlan(pool, broker, plan, { filename: String(file.originalname || "").slice(0, 120) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "leads", rows: table.rows.length, counts: plan.counts } });
    return res.redirect(303, `/app/leads/import/${id}`);
  });

  web.get("/leads/import/:id", async (req, res, next) => {
    const lang = langOf(req);
    const imp = await Imports.loadImport(pool, req.session.broker, req.params.id);
    if (!imp || imp.kind !== "leads") return next();
    if (imp.status === "ready") return importPage(req, res, planBody(imp, req));
    return importPage(req, res, imp.status === "processing" ? progressBody(imp, lang) : resultBody(imp, lang));
  });

  web.post("/leads/import/:id/apply", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    if (!imp || imp.kind !== "leads") return next();
    if (!(await LeadImports.startApply(pool, broker, imp.id))) {
      return importPage(req, res, html`<p class="card notice bad">⚠️ ${L(lang, "الاستيراد ده اتطبق قبل كده أو انتهت صلاحيته.", "This import was already applied or has expired.")} <a href="/app/leads/import/${imp.id}">${L(lang, "عرض", "View")}</a></p>`, 409);
    }
    return res.redirect(303, `/app/leads/import/${imp.id}`);
  });
}

module.exports = { register, TEMPLATE_HEADERS };
