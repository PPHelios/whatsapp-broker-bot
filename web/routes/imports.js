// web/routes/imports.js — Excel diff import, group import (forwarded posts / chat export) and bulk edit
"use strict";

const AI = require("../../lib/ai");
const RateLimit = require("../../lib/rateLimit");
const Sheets = require("../../lib/sheets");
const { logOperation } = require("../../lib/db");
const { isManager } = require("../../lib/authz");
const Imports = require("../../services/imports");
const Edits = require("../../lib/edits");
const Plans = require("../../domain/plans");
const Chat = require("../../domain/chatExport");
const Describe = require("../../domain/describe");
const Session = require("../session");
const { uploads } = require("../uploads");
const { html, raw } = require("../html");
const { tabs } = require("../views/tabs");
const { stripMarkdown } = require("../views/units");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const SHEET = { name: "sheet", maxCount: 1, accept: /^application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream|zip)$/ };
const CHAT = { name: "chat", maxCount: 1, accept: /^(text\/plain|application\/(zip|x-zip-compressed|octet-stream))$/ };
const uploadSheet = uploads([SHEET], { maxMb: 5 });
const uploadChat = uploads([CHAT], { maxMb: 10, fieldSizeKb: 512 });
for (const re of [/^\/import\/excel$/, /^\/import\/group$/]) Session.allowMultipart(re);

const ImportTemplate = require("../../lib/importTemplate");
const TEMPLATE_HEADERS = ["Code / الكود", "Compound / الكمبوند", "Property Type / النوع", "Purpose / بيع او ايجار", "Price / السعر", "Area (sqm) / المساحة", "Bedrooms / الغرف", "Bathrooms / الحمامات", "Floor / الدور", "Finishing / التشطيب", "Delivery / التسليم", "Paid / المدفوع", "Remaining / المتبقي", "Installment / القسط", "Frequency / دورية القسط", "Features / المميزات", "District / المنطقة", "Status / الحالة", "Owner / المالك", "Owner phone / تليفون المالك", "Notes / ملاحظات"];

/** True when a buffer starts like a zip file (a chat export with photos goes to the Match photos tab). */
const isZip = (b) => Buffer.isBuffer(b) && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;

/** A chat export uploaded as .txt → its text. */
async function chatText(file) {
  if (!file || isZip(file.buffer)) return "";
  return file.buffer.toString("utf8").slice(0, 5_000_000);
}

const KIND_LABEL = {
  new: ["🆕 جديدة", "🆕 New"],
  changed: ["✏️ متغيرة", "✏️ Changed"],
  unchanged: ["✔️ زي ما هي", "✔️ Unchanged"],
  invalid: ["⛔ ناقصة أو غلط", "⛔ Invalid"],
  forbidden: ["🔒 مش من حقك تعدلها", "🔒 Not yours to change"]
};

function excelPlanPage(imp, lang) {
  const { items, counts, rows: sheetRows, columns } = imp.payload;
  const applied = imp.status !== "ready";
  const section = (kind, body) => {
    const rows = items.filter((i) => i.kind === kind);
    if (!rows.length) return "";
    return html`<section class="card" data-kind="${kind}"><h2>${L(lang, KIND_LABEL[kind][0], KIND_LABEL[kind][1])} (${rows.length})</h2>${body(rows)}</section>`;
  };
  // Editing is per row: a small form outside the apply form (forms cannot nest), its inputs joined by the form attribute.
  const canEdit = !applied && Array.isArray(sheetRows) && Array.isArray(columns) && columns.length > 0;
  const rowCells = (n) => sheetRows?.find((r) => r.rowNumber === n)?.cells || {};
  const editor = (i) =>
    canEdit
      ? html`<details class="edit-row"><summary>✏️ ${L(lang, "تعديل", "Edit")}</summary>
  <div class="stack">${columns.map((k) => html`<label>${(Edits.FIELD_LABELS[k] || [k, k])[lang === "en" ? 1 : 0]}<input form="edit-${i.row}" name="c_${k}" value="${rowCells(i.row)[k] ?? ""}" maxlength="600"></label>`)}
  <button type="submit" form="edit-${i.row}" class="secondary">${L(lang, "احفظ التعديل وراجع تاني", "Save the edit and review again")}</button></div></details>`
      : "";
  const editForms = canEdit
    ? items.filter((i) => ["new", "changed", "invalid"].includes(i.kind)).map((i) => html`<form method="post" action="/app/import/${imp.id}/edit/${i.row}" id="edit-${i.row}"></form>`)
    : "";
  const box = (i, on = true) => (applied ? "" : html`<input type="checkbox" name="rows" value="${i.row}"${on ? raw(" checked") : ""}>`);
  return html`<h1>📥 ${L(lang, "مراجعة الاستيراد", "Review the import")} <span class="muted">${imp.filename || ""}</span></h1>
<p class="muted">${Object.entries(counts).map(([k, n]) => `${L(lang, KIND_LABEL[k][0], KIND_LABEL[k][1])}: ${n}`).join(" · ")}</p>
${imp.result ? resultCard(imp.result, lang) : ""}
<form method="post" action="/app/import/${imp.id}/apply" class="stack">
${section("new", (rows) => html`<table><thead><tr><th></th><th>${L(lang, "صف", "Row")}</th><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "الوحدة", "Unit")}</th></tr></thead><tbody>${rows.map(
  (i) => html`<tr data-row="${i.row}"><td>${box(i)}</td><td>${i.row}</td><td>${i.code || L(lang, "(تلقائي)", "(auto)")}</td><td>${stripMarkdown(Describe.compactLine({ ...i.fields, code: "" }, lang).replace(/^``\s*·\s*/, ""))}${i.warnings.length ? html`<div class="warn muted">${i.warnings.join(" · ")}</div>` : ""}${editor(i)}</td></tr>`
)}</tbody></table>`)}
${section("changed", (rows) => html`<table><thead><tr><th></th><th>${L(lang, "صف", "Row")}</th><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "التغيير", "Change")}</th></tr></thead><tbody>${rows.map(
  (i) => html`<tr data-row="${i.row}"><td>${box(i)}</td><td>${i.row}</td><td>${i.code}</td><td><ul>${i.changes.map((c) => html`<li data-change="${c.field}">${c.label}: <del>${c.from}</del> ← <ins>${c.to}</ins></li>`)}</ul>${editor(i)}</td></tr>`
)}</tbody></table>`)}
${section("invalid", (rows) => html`<ul>${rows.map((i) => html`<li data-row="${i.row}">${L(lang, "صف", "Row")} ${i.row}${i.code ? ` (${i.code})` : ""}: ${i.reasons.join("، ")}${editor(i)}</li>`)}</ul>`)}
${section("forbidden", (rows) => html`<ul>${rows.map((i) => html`<li data-row="${i.row}">${i.code}</li>`)}</ul>`)}
${section("unchanged", (rows) => html`<p class="muted">${rows.map((i) => i.code).join("، ")}</p>`)}
${applied ? "" : html`<button type="submit">✅ ${L(lang, "طبّق المختار", "Apply the selected rows")}</button>`}
</form>
${editForms}`;
}

function resultCard(r, lang) {
  const line = (label, list) => (list && list.length ? html`<li>${label}: ${list.length} <span class="muted">${list.join("، ")}</span></li>` : "");
  return html`<div class="card notice" data-result>
  <h2>✅ ${L(lang, "اتطبق", "Applied")}</h2>
  <ul>
    ${line(L(lang, "اتضافت", "Created"), r.created)}
    ${line(L(lang, "اتعدلت", "Updated"), r.updated)}
    ${line(L(lang, "اتغيرت من شخص تاني بعد المراجعة (متعدلتش)", "Changed by someone else since the review (not applied)"), r.conflicts)}
    ${line(L(lang, "متطبقتش", "Not applied"), r.failed)}
  </ul>
  ${r.limit ? html`<p class="notice bad" data-unit-limit>${Plans.unitLimitText(r.limit, lang)}</p>` : ""}
</div>`;
}

/** A post's photos from a chat export zip: thumbnails, and a warning when a photo is already on a unit. */
function photosLine(post, lang) {
  const photos = post.photos || [];
  if (!photos.length && !post.missing) return "";
  const same = [...new Set(photos.map((x) => x.same_as).filter(Boolean))];
  const twins = [...new Set(photos.map((x) => x.twin).filter((x) => x !== undefined && x !== null))];
  return html`<div class="stack" data-photos="${photos.length}">
  <p>📷 ${L(lang, `${photos.length} صورة`, `${photos.length} photos`)}${post.missing ? html` <span class="muted">· ${L(lang, `${post.missing} مش موجودة في الملف`, `${post.missing} not in the file`)}</span>` : ""}</p>
  ${photos.length ? html`<div class="row thumbs">${photos.slice(0, 6).map((x) => html`<img src="${x.url}" alt="" width="64" height="64" loading="lazy">`)}</div>` : ""}
  ${same.map((code) => html`<p class="warn" data-same-photo="${code}">⚠️ ${L(lang, "نفس صورة الوحدة", "Same photo as unit")} <a href="/app/units/${encodeURIComponent(code)}">${code}</a></p>`)}
  ${twins.map((n) => html`<p class="warn">⚠️ ${L(lang, `نفس صورة في بوست ${n + 1}`, `Same photo as in post ${n + 1}`)}</p>`)}
</div>`;
}

function groupPage(imp, lang) {
  const posts = imp.payload.posts || [];
  const results = imp.payload.results || [];
  const done = results.filter(Boolean).length;
  if (imp.status === "processing") {
    return html`<div id="group-status" hx-get="/app/import/${imp.id}" hx-trigger="every 2s" hx-select="#group-status" hx-swap="outerHTML" class="card">
  <h1>⏳ ${L(lang, "جاري قراءة البوستات", "Reading the posts")}</h1><p>${done} / ${posts.length}</p></div>`;
  }
  if (imp.status === "failed") {
    const why = {
      no_posts: L(lang, "ملقيناش بوستات فيها وحدات (سعر ومساحة أو غرف).", "No posts describing a unit (price and area or rooms) were found.")
    }[imp.payload.error] || L(lang, "حصلت مشكلة في قراءة الملف.", "Something went wrong reading the file.");
    return html`<div id="group-status" class="card notice bad" data-import-error="${imp.payload.error || "failed"}"><h1>⚠️ ${why}</h1><a href="/app/import">${L(lang, "رجوع", "Back")}</a></div>`;
  }
  const applied = imp.status !== "ready";
  return html`<div id="group-status"><h1>📥 ${L(lang, "استيراد من الجروب", "Group import")}</h1>
${imp.result ? resultCard(imp.result, lang) : ""}
<form method="post" action="/app/import/${imp.id}/apply" class="stack">
<ol class="results">${posts.map((p, i) => {
    const r = results[i];
    const twin = r?.same_as !== undefined && r?.same_as !== null;
    const state = !r ? "pending" : r.error ? "error" : r.ok ? (r.duplicate || twin ? "duplicate" : "ok") : "incomplete";
    return html`<li class="card" data-post="${i}" data-state="${state}">
  <div class="row">${!applied && r?.ok ? html`<input type="checkbox" name="rows" value="${i}"${r.duplicate || twin ? "" : raw(" checked")}>` : ""}<strong>${p.sender || L(lang, "بوست", "Post")}</strong> <span class="muted">${p.at || ""}</span></div>
  <p class="muted">${p.text.slice(0, 280)}</p>
  ${photosLine(p, lang)}
  ${r?.ok ? html`<p>${stripMarkdown(Describe.compactLine({ ...r.fields, code: "" }, lang).replace(/^``\s*·\s*/, ""))}</p>` : ""}
  ${r?.duplicate ? html`<p class="warn">⚠️ ${L(lang, "شكلها نفس الوحدة", "Looks like the same unit as")} <a href="/app/units/${encodeURIComponent(r.duplicate)}">${r.duplicate}</a></p>` : ""}
  ${twin ? html`<p class="warn">⚠️ ${L(lang, `شكلها نفس الوحدة في بوست ${r.same_as + 1}`, `Looks like the same unit as post ${r.same_as + 1}`)}</p>` : ""}
  ${r && !r.ok && !r.error ? html`<p class="bad">⛔ ${r.blockers.join("، ")}</p>` : ""}
  ${r?.error ? html`<p class="bad">❌ ${r.error === "quota" ? L(lang, "حد الذكاء الاصطناعي خلص (حد اليوم أو رصيد الباقة)", "AI limit reached (today's limit or the plan's allowance)") : L(lang, "تعذرت قراءته", "Could not be read")}</p>` : ""}
</li>`;
  })}</ol>
${applied ? "" : html`<button type="submit">✅ ${L(lang, "ضيف المختار", "Add the selected units")}</button>`}
</form></div>`;
}

function register(web, { pool, page, assets }) {
  const importPage = (req, res, body, status = 200) => page(req, res, { title: L(langOf(req), "استيراد", "Import"), nav: "import", body }, status);

  /**
   * The import hub: one tile per way in (Excel, pasted group posts, a chat export with photos, leads). An error shows
   * above its own form, with that tile open (tab: 0 Excel, 1 group posts, 2 chat with photos).
   */
  const importHub = (req, { notice = null, tab = 0 } = {}) => {
    const lang = langOf(req);
    const err = (n) => (notice && tab === n ? notice : "");
    return html`<h1>${L(lang, "استيراد", "Import")}</h1>
${tabs("import_tab", [
  [html`<span class="ti">📊</span>${L(lang, "شيت إكسيل", "Excel sheet")}`, html`${err(0)}<form method="post" action="/app/import/excel" enctype="multipart/form-data" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <h2>📊 ${L(lang, "شيت إكسيل (مقارنة بالمخزون)", "Excel sheet (compared with your inventory)")}</h2>
  <p class="muted">${L(lang, "هنوريك الجديد والمتغير قبل أي حفظ. ينفع شيت التصدير من البوت أو", "You see what is new and what changed before anything is saved. The bot's export works, or")} <a href="/app/import/template.xlsx">${L(lang, "النموذج ده", "this template")}</a>.</p>
  <input type="file" name="sheet" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
  <button type="submit">${L(lang, "قارن", "Compare")}</button>
</form>`],
  [html`<span class="ti">💬</span>${L(lang, "بوستات جروبات", "Group posts")}`, html`${err(1)}<form method="post" action="/app/import/group" enctype="multipart/form-data" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <h2>💬 ${L(lang, "بوستات الجروبات", "Group posts")}</h2>
  <label>${L(lang, "الصق البوستات (سيب سطرين فاضيين بين كل بوست)", "Paste the posts (two empty lines between posts)")}<textarea name="text" rows="6"></textarea></label>
  <label>${L(lang, "أو ارفع تصدير الشات من واتساب (.txt)", "Or upload a WhatsApp chat export (.txt)")}<input type="file" name="chat" accept=".txt,text/plain"></label>
  <label>${L(lang, "استورد البوستات من تاريخ", "Import posts from")}<input type="date" name="since" value="${Chat.defaultSince()}"></label>
  <p class="muted">${L(lang, `بنقرا لحد ${Chat.MAX_POSTS} بوست في المرة، وبنعلّم المكرر.`, `Up to ${Chat.MAX_POSTS} posts at a time; duplicates are flagged.`)}</p>
  <button type="submit">${L(lang, "اقرأ البوستات", "Read the posts")}</button>
</form>`],
  [html`<span class="ti">📷</span>${L(lang, "شات بالصور", "Chat with photos")}`, html`${err(2)}<div class="card stack" data-cp data-lang="${lang}" data-csrf="${req.session.csrf}" data-units-url="/app/import/match/units" data-start-url="/app/import/match/start" data-unit-url="/app/import/match/unit/{code}/photo" data-post-url="/app/import/match/{id}/photo/{n}">
  <h2>📷 ${L(lang, "تطابق الصور من شات واتساب", "Match photos from a WhatsApp chat")}</h2>
  <p class="muted">${L(lang, "من واتساب: الجروب ← المزيد ← تصدير الشات ← «إرفاق الوسائط». الملف بيتفتح في المتصفح عندك بس: مش بيترفع، فمفيش حد أقصى لحجمه. بنوزع كل صورة على وحدتها حسب الكود في الوصف أو حسب الترتيب والراسل، وإنت بتراجع قبل أي رفع. مفيش حاجة بتتحفظ إلا الصور اللي تختارها.", "In WhatsApp: the group → More → Export chat → “Attach media”. The file is opened in your browser only: it is not uploaded, so its size has no limit. Each photo is placed on its unit by the code in the description, or by order and sender, and you review it before anything is sent. Only the photos you choose are saved.")}</p>
  <input type="file" accept=".zip,.txt,application/zip,text/plain" data-cp-file>
  <label>${L(lang, "الوحدات", "Units")}<select data-cp-mode>
    <option value="codes">${L(lang, "الوحدات اللي في التطبيق (بالكود)", "Units already in the app (by code)")}</option>
    <option value="posts">${L(lang, "اقرأ الوحدات من البوستات (ذكاء اصطناعي)", "Read the units from the posts (AI)")}</option>
  </select></label>
  <label>${L(lang, "من تاريخ", "From date")}<input type="date" data-cp-since value="${Chat.defaultSince()}"></label>
  <label>${L(lang, "الفاصل بين الصور والوصف", "Gap between photos and description")}<select data-cp-window>
    <option value="5">5 ${L(lang, "دقايق", "minutes")}</option><option value="10" selected>10 ${L(lang, "دقايق", "minutes")}</option><option value="30">30 ${L(lang, "دقيقة", "minutes")}</option>
  </select></label>
  <label>${L(lang, "ترتيب الصور والوصف", "Order of photos and description")}<select data-cp-pattern>
    <option value="auto">${L(lang, "اكتشف تلقائياً", "Detect automatically")}</option>
    <option value="photos_first">${L(lang, "الصور الأول وبعدها الوصف", "Photos first, then the description")}</option>
    <option value="text_first">${L(lang, "الوصف الأول وبعدها الصور", "Description first, then photos")}</option>
  </select></label>
  <label class="row"><input type="checkbox" data-cp-same checked> ${L(lang, "نفس الشخص اللي بعت الوصف بس", "Only photos from the same person as the description")}</label>
  <button type="button" data-cp-read>${L(lang, "اقرأ الملف", "Read the file")}</button>
  <div data-cp-out></div>
  <script src="${assets.url("zipread.js")}"></script><script src="${assets.url("chatparse.js")}"></script><script src="${assets.url("chatmatch.js")}"></script><script src="${assets.url("chatphotos.js")}"></script>
</div>`]
], { open: tab, cls: "tiles" })}`;
  };

  web.get("/import", (req, res) => importPage(req, res, importHub(req)));

  web.get("/import/template.xlsx", async (_req, res) => {
    const buf = await ImportTemplate.build({
      sheetName: "Inventory",
      headers: TEMPLATE_HEADERS,
      required: [1, 2, 3, 4, 5],
      samples: [
        ["SAMPLE-1", "Hyde Park", "شقة", "بيع", "8.5 مليون", 150, 3, 2, 4, "تشطيب كامل", "2027 Q3", "3 مليون", "5.5 مليون", 250000, "ربع سنوي", "بحري، ناصية", "التجمع الخامس", "متاحة", "مثال: أحمد", "01000000000", "صف تجريبي، امسحه"],
        ["SAMPLE-2", "Mountain View", "فيلا", "بيع", "21 مليون", 320, 4, 4, "", "سوبر لوكس", "جاهز", "", "", "", "", "حديقة، مسبح", "الشيخ زايد", "متاحة", "مثال: منى", "01100000000", "صف تجريبي، امسحه"]
      ],
      text: [20],
      readme: [
        ["الكود اختياري: لو فاضي النظام يعمله.", "Code is optional: left empty, the system makes one."],
        ["لازم الكمبوند، النوع، بيع/إيجار، السعر والمساحة.", "Compound, property type, sale/rent, price and area are needed."],
        ["السعر يقبل «8.5 مليون» أو 8500000.", "Price accepts '8.5 million' or 8500000."],
        ["الاستيراد للمديرين بس، وبتشوف كل صف هيعمل إيه قبل الحفظ.", "Import is for managers; you see what every row will do before anything is saved."]
      ]
    });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", 'attachment; filename="wehdathub-inventory-template.xlsx"');
    return res.send(buf);
  });

  // Imports (Excel, group posts, chat with photos) are for managers. Brokers add single units by form, voice and text.
  const managersOnly = (req, res, next) =>
    isManager(req.session.broker) ? next() : res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));

  web.post("/import/excel", managersOnly, uploadSheet, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, importHub(req, { tab: 0, notice: html`<p class="card notice bad" role="alert">⏳ ${L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.")}</p>` }), 429);
    const file = (req.files?.sheet || [])[0];
    let sheet;
    try {
      sheet = await Sheets.readInventorySheet(file?.buffer);
    } catch (err) {
      const msg = {
        NOT_XLSX: L(lang, "الملف لازم يكون إكسيل .xlsx.", "The file must be an .xlsx workbook."),
        TOO_LARGE: L(lang, "الملف أكبر من 5 ميجا.", "The file is larger than 5 MB."),
        NO_HEADER: L(lang, "مش لاقيين صف العناوين (الكود، الكمبوند، السعر، المساحة…).", "No header row found (code, compound, price, area, …)."),
        TOO_MANY_ROWS: L(lang, `أكتر من ${Sheets.MAX_ROWS} صف.`, `More than ${Sheets.MAX_ROWS} rows.`)
      }[err.code];
      if (!msg) throw err;
      return importPage(req, res, importHub(req, { tab: 0, notice: html`<p class="card notice bad" role="alert">⚠️ ${msg}</p>` }), 422);
    }
    const plan = await Imports.planExcel(pool, broker, sheet, { lang });
    const id = await Imports.savePlan(pool, broker, "excel", { ...plan, rows: sheet.rows, columns: sheet.mapped }, { filename: String(file.originalname || "").slice(0, 120) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "excel", rows: sheet.rows.length, counts: plan.counts } });
    return res.redirect(303, `/app/import/${id}`);
  });

  web.post("/import/group", managersOnly, uploadChat, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, importHub(req, { tab: 1, notice: html`<p class="card notice bad" role="alert">⏳ ${L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.")}</p>` }), 429);
    const file = (req.files?.chat || [])[0];
    const text = [String(req.body.text || ""), await chatText(file)].filter((t) => t.trim()).join("\n\n\n");
    const found = Chat.candidatePosts(text, { since: req.body.since });
    if (file && isZip(file.buffer)) {
      return importPage(req, res, importHub(req, { tab: 1, notice: html`<p class="card notice bad" role="alert" data-import-error="zip">⚠️ ${L(lang, "الـ zip بالصور بيتفتح من تبويب «شات بالصور».", "A zip with photos goes in the “Chat with photos” tab.")}</p>` }), 422);
    }
    if (!found.posts.length) {
      return importPage(req, res, importHub(req, { tab: 1, notice: html`<p class="card notice bad" role="alert">🔍 ${L(lang, "ملقيناش بوستات فيها وحدات (سعر ومساحة أو غرف).", "No posts describing a unit (price and area or rooms) were found.")}</p>` }), 422);
    }
    const id = await Imports.startGroupImport(pool, broker, found.posts, {
      AI,
      ctx: { pool, broker, agency: req.session.agency, lang },
      lang,
      filename: file ? String(file.originalname || "").slice(0, 120) : null
    });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "group", posts: found.posts.length, skipped: found.skipped, duplicates: found.duplicates } });
    return res.redirect(303, `/app/import/${id}`);
  });

  web.get("/import/:id", async (req, res, next) => {
    const lang = langOf(req);
    const imp = await Imports.loadImport(pool, req.session.broker, req.params.id);
    if (!imp) return next();
    if (imp.kind === "leads") return res.redirect(303, `/app/leads/import/${imp.id}`);
    return importPage(req, res, imp.kind === "excel" ? excelPlanPage(imp, lang) : groupPage(imp, lang));
  });

  // Edit one row of a ready plan: the whole sheet is planned again with the changed cells (same rules as an upload).
  web.post("/import/:id/edit/:row", managersOnly, async (req, res, next) => {
    const lang = langOf(req);
    const cells = {};
    for (const [k, v] of Object.entries(req.body || {})) if (k.startsWith("c_") && typeof v === "string") cells[k.slice(2)] = v;
    const ok = await Imports.editExcelRow(pool, req.session.broker, req.params.id, Number(req.params.row), cells, { lang });
    if (!ok) return next();
    return res.redirect(303, `/app/import/${req.params.id}`);
  });

  web.post("/import/:id/apply", managersOnly, async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    if (!imp || imp.kind === "leads") return next();
    const rows = [].concat(req.body.rows || []);
    const result =
      imp.kind === "excel"
        ? await Imports.applyExcel(pool, broker, imp.id, { rows, lang })
        : await Imports.applyGroup(pool, broker, imp.id, { rows, lang });
    if (!result) {
      return importPage(req, res, html`<p class="card notice bad">⚠️ ${L(lang, "الاستيراد ده اتطبق قبل كده أو انتهت صلاحيته.", "This import was already applied or has expired.")} <a href="/app/import/${imp.id}">${L(lang, "عرض", "View")}</a></p>`, 409);
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_apply", metadata: { kind: imp.kind, ...Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])) } });
    return res.redirect(303, `/app/import/${imp.id}`);
  });

}

module.exports = { register, chatText, TEMPLATE_HEADERS };
