// web/routes/imports.js — Excel diff import, group import (forwarded posts / chat export) and bulk edit
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const Supabase = require("../../lib/supabase");
const AI = require("../../lib/ai");
const RateLimit = require("../../lib/rateLimit");
const Sheets = require("../../lib/sheets");
const { logOperation } = require("../../lib/db");
const Imports = require("../../services/imports");
const Plans = require("../../domain/plans");
const ChatPhotos = require("../../services/chatPhotos");
const Bulk = require("../../services/bulk");
const Chat = require("../../domain/chatExport");
const Describe = require("../../domain/describe");
const Session = require("../session");
const { uploads } = require("../uploads");
const { html, raw } = require("../html");
const { stripMarkdown } = require("../views/units");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const SHEET = { name: "sheet", maxCount: 1, accept: /^application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream|zip)$/ };
const CHAT = { name: "chat", maxCount: 1, accept: /^(text\/plain|application\/(zip|x-zip-compressed|octet-stream))$/ };
const uploadSheet = uploads([SHEET], { maxMb: 5 });
const uploadChat = uploads([CHAT], { maxMb: 10, fieldSizeKb: 512 });
for (const re of [/^\/import\/excel$/, /^\/import\/group$/]) Session.allowMultipart(re);

const TEMPLATE_HEADERS = ["Code / الكود", "Compound / الكمبوند", "Property Type / النوع", "Purpose / بيع او ايجار", "Price / السعر", "Area (sqm) / المساحة", "Bedrooms / الغرف", "Bathrooms / الحمامات", "Floor / الدور", "Finishing / التشطيب", "Delivery / التسليم", "Paid / المدفوع", "Remaining / المتبقي", "Installment / القسط", "Frequency / دورية القسط", "Features / المميزات", "District / المنطقة", "Status / الحالة", "Owner / المالك", "Owner phone / تليفون المالك", "Notes / ملاحظات"];

/** A chat export uploaded as .txt → its text (a .zip goes through services/chatPhotos.js, photos included). */
async function chatText(file) {
  if (!file || ChatPhotos.isZip(file.buffer)) return "";
  return file.buffer.toString("utf8").slice(0, 5_000_000);
}

// Where a broker's chat export zip lands in the private chat-imports bucket: their agency and id first, so a path
// sent back with the form can only be one of their own uploads.
const zipPrefix = (broker) => `${broker.agency_id}/${broker.id}/`;
const ZIP_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d{13}-[0-9a-f]{12}\.zip$/;

const KIND_LABEL = {
  new: ["🆕 جديدة", "🆕 New"],
  changed: ["✏️ متغيرة", "✏️ Changed"],
  unchanged: ["✔️ زي ما هي", "✔️ Unchanged"],
  invalid: ["⛔ ناقصة أو غلط", "⛔ Invalid"],
  forbidden: ["🔒 مش من حقك تعدلها", "🔒 Not yours to change"]
};

function excelPlanPage(imp, lang) {
  const { items, missing, counts } = imp.payload;
  const applied = imp.status !== "ready";
  const section = (kind, body) => {
    const rows = items.filter((i) => i.kind === kind);
    if (!rows.length) return "";
    return html`<section class="card" data-kind="${kind}"><h2>${L(lang, KIND_LABEL[kind][0], KIND_LABEL[kind][1])} (${rows.length})</h2>${body(rows)}</section>`;
  };
  const box = (i, on = true) => (applied ? "" : html`<input type="checkbox" name="rows" value="${i.row}"${on ? raw(" checked") : ""}>`);
  return html`<h1>📥 ${L(lang, "مراجعة الاستيراد", "Review the import")} <span class="muted">${imp.filename || ""}</span></h1>
<p class="muted">${Object.entries(counts).map(([k, n]) => `${L(lang, KIND_LABEL[k][0], KIND_LABEL[k][1])}: ${n}`).join(" · ")}</p>
${imp.result ? resultCard(imp.result, lang) : ""}
<form method="post" action="/app/import/${imp.id}/apply" class="stack">
${section("new", (rows) => html`<table><thead><tr><th></th><th>${L(lang, "صف", "Row")}</th><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "الوحدة", "Unit")}</th></tr></thead><tbody>${rows.map(
  (i) => html`<tr data-row="${i.row}"><td>${box(i)}</td><td>${i.row}</td><td>${i.code || L(lang, "(تلقائي)", "(auto)")}</td><td>${stripMarkdown(Describe.compactLine({ ...i.fields, code: "" }, lang).replace(/^``\s*·\s*/, ""))}${i.warnings.length ? html`<div class="warn muted">${i.warnings.join(" · ")}</div>` : ""}</td></tr>`
)}</tbody></table>`)}
${section("changed", (rows) => html`<table><thead><tr><th></th><th>${L(lang, "صف", "Row")}</th><th>${L(lang, "الكود", "Code")}</th><th>${L(lang, "التغيير", "Change")}</th></tr></thead><tbody>${rows.map(
  (i) => html`<tr data-row="${i.row}"><td>${box(i)}</td><td>${i.row}</td><td>${i.code}</td><td><ul>${i.changes.map((c) => html`<li data-change="${c.field}">${c.label}: <del>${c.from}</del> ← <ins>${c.to}</ins></li>`)}</ul></td></tr>`
)}</tbody></table>`)}
${section("invalid", (rows) => html`<ul>${rows.map((i) => html`<li data-row="${i.row}">${L(lang, "صف", "Row")} ${i.row}${i.code ? ` (${i.code})` : ""}: ${i.reasons.join("، ")}</li>`)}</ul>`)}
${section("forbidden", (rows) => html`<ul>${rows.map((i) => html`<li data-row="${i.row}">${i.code}</li>`)}</ul>`)}
${section("unchanged", (rows) => html`<p class="muted">${rows.map((i) => i.code).join("، ")}</p>`)}
${missing.length
  ? html`<section class="card" data-kind="missing"><h2>❔ ${L(lang, "وحدات متاحة مش في الشيت", "Available units not in the sheet")} (${missing.length})</h2>
  <p class="muted">${L(lang, "اختار اللي عايز تأرشفه (مفيش حاجة بتتأرشف لوحدها).", "Pick any to archive (nothing is archived on its own).")}</p>
  <div class="row">${missing.map((c) => html`<label class="check">${applied ? "" : html`<input type="checkbox" name="archive" value="${c}">`}${c}</label>`)}</div></section>`
  : ""}
${applied ? "" : html`<button type="submit">✅ ${L(lang, "طبّق المختار", "Apply the selected rows")}</button>`}
</form>`;
}

function resultCard(r, lang) {
  const line = (label, list) => (list && list.length ? html`<li>${label}: ${list.length} <span class="muted">${list.join("، ")}</span></li>` : "");
  return html`<div class="card notice" data-result>
  <h2>✅ ${L(lang, "اتطبق", "Applied")}</h2>
  <ul>
    ${line(L(lang, "اتضافت", "Created"), r.created)}
    ${line(L(lang, "اتعدلت", "Updated"), r.updated)}
    ${line(L(lang, "اتأرشفت", "Archived"), r.archived)}
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
  ${imp.payload.stage === "photos"
    ? html`<h1>⏳ ${L(lang, "جاري فك الشات والصور", "Unpacking the chat and photos")}</h1><p class="muted">${L(lang, "ممكن ياخد دقيقة أو اتنين للشات الكبير.", "A big chat can take a minute or two.")}</p>`
    : html`<h1>⏳ ${L(lang, "جاري قراءة البوستات", "Reading the posts")}</h1><p>${done} / ${posts.length}</p>`}</div>`;
  }
  if (imp.status === "failed") {
    const why = {
      no_chat: L(lang, "الملف مش تصدير شات واتساب (مفيش ملف الشات .txt جوه الـ zip).", "The file isn't a WhatsApp chat export (no chat .txt inside the zip)."),
      no_posts: L(lang, "ملقيناش بوستات فيها وحدات (سعر ومساحة أو غرف).", "No posts describing a unit (price and area or rooms) were found."),
      not_found: L(lang, "الملف موصلش كامل. ارفعه تاني.", "The file didn't arrive in full. Upload it again."),
      too_large: L(lang, "الملف أكبر من المسموح.", "The file is larger than allowed.")
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

function register(web, { pool, page }) {
  const importPage = (req, res, body, status = 200) => page(req, res, { title: L(langOf(req), "استيراد", "Import"), nav: "import", body }, status);

  web.get("/import", (req, res) => {
    const lang = langOf(req);
    return importPage(
      req,
      res,
      html`<h1>📥 ${L(lang, "استيراد", "Import")}</h1>
<form method="post" action="/app/import/excel" enctype="multipart/form-data" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <h2>📊 ${L(lang, "شيت إكسيل (مقارنة بالمخزون)", "Excel sheet (compared with your inventory)")}</h2>
  <p class="muted">${L(lang, "هنوريك الجديد والمتغير قبل أي حفظ. ينفع شيت التصدير من البوت أو", "You see what is new and what changed before anything is saved. The bot's export works, or")} <a href="/app/import/template.xlsx">${L(lang, "النموذج ده", "this template")}</a>.</p>
  <input type="file" name="sheet" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required>
  <button type="submit">${L(lang, "قارن", "Compare")}</button>
</form>
<form method="post" action="/app/import/group" enctype="multipart/form-data" class="card stack">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <h2>💬 ${L(lang, "بوستات الجروبات", "Group posts")}</h2>
  <label>${L(lang, "الصق البوستات (سيب سطرين فاضيين بين كل بوست)", "Paste the posts (two empty lines between posts)")}<textarea name="text" rows="6"></textarea></label>
  <label>${L(lang, "أو ارفع تصدير الشات من واتساب (.txt أو .zip)", "Or upload a WhatsApp chat export (.txt or .zip)")}<input type="file" name="chat" accept=".txt,.zip,text/plain,application/zip"></label>
  <p class="muted">${L(lang, `بنقرا لحد ${Chat.MAX_POSTS} بوست في المرة، وبنعلّم المكرر.`, `Up to ${Chat.MAX_POSTS} posts at a time; duplicates are flagged.`)}</p>
  <button type="submit">${L(lang, "اقرأ البوستات", "Read the posts")}</button>
</form>
<form method="post" action="/app/import/zip" class="card stack" data-zip-upload data-max="${Supabase.CHAT_ZIP_MAX_BYTES}">
  <input type="hidden" name="_csrf" value="${req.session.csrf}">
  <input type="hidden" name="path" value="">
  <input type="hidden" name="filename" value="">
  <h2>📷 ${L(lang, "تصدير شات بالصور", "Chat export with photos")}</h2>
  <p class="muted">${L(lang, `من واتساب: الجروب ← المزيد ← تصدير الشات ← «إرفاق الوسائط». ارفع الـ zip هنا (لحد ${Math.round(Supabase.CHAT_ZIP_MAX_BYTES / 1048576)} ميجا): كل صورة بتروح للبوست بتاعها (نفس الراسل وفي خلال دقايق)، لحد ${Chat.MAX_PHOTOS} صورة للوحدة، وبنعلّم الصور اللي موجودة على وحدة عندك.`, `In WhatsApp: the group → More → Export chat → "Attach media". Upload the zip here (up to ${Math.round(Supabase.CHAT_ZIP_MAX_BYTES / 1048576)} MB): each photo goes to its post (same sender, within minutes), up to ${Chat.MAX_PHOTOS} a unit, and photos already on one of your units are flagged.`)}</p>
  <input type="file" accept=".zip,application/zip" data-zip-file required>
  <progress max="100" value="0" hidden data-zip-progress></progress>
  <p class="muted" hidden data-zip-status data-msg-big="${L(lang, "الملف أكبر من المسموح.", "The file is larger than allowed.")}" data-msg-fail="${L(lang, "الرفع فشل. جرب تاني.", "The upload failed. Try again.")}" data-msg-wait="${L(lang, "جاري الرفع…", "Uploading…")}"></p>
  <button type="submit">${L(lang, "ارفع واقرأ", "Upload and read")}</button>
</form>`
    );
  });

  web.get("/import/template.xlsx", async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Inventory");
    sheet.addRow(TEMPLATE_HEADERS).font = { bold: true };
    sheet.addRow(["HP-101", "Hyde Park", "شقة", "بيع", "8.5 مليون", 150, 3, 2, 4, "تشطيب كامل", "2027 Q3", "3 مليون", "5.5 مليون", 250000, "ربع سنوي", "بحري، ناصية", "التجمع الخامس", "متاحة", "", "", ""]);
    sheet.columns.forEach((c) => (c.width = 18));
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", 'attachment; filename="wehdathub-inventory-template.xlsx"');
    return res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  web.post("/import/excel", uploadSheet, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, html`<p class="card notice bad">⏳ ${L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.")}</p>`, 429);
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
      return importPage(req, res, html`<p class="card notice bad">⚠️ ${msg} <a href="/app/import">${L(lang, "رجوع", "Back")}</a></p>`, 422);
    }
    const plan = await Imports.planExcel(pool, broker, sheet, { lang });
    const id = await Imports.savePlan(pool, broker, "excel", plan, { filename: String(file.originalname || "").slice(0, 120) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "excel", rows: sheet.rows.length, counts: plan.counts } });
    return res.redirect(303, `/app/import/${id}`);
  });

  web.post("/import/group", uploadChat, async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return importPage(req, res, html`<p class="card notice bad">⏳ ${L(lang, "رفعت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment.")}</p>`, 429);
    const file = (req.files?.chat || [])[0];
    const text = [String(req.body.text || ""), await chatText(file)].filter((t) => t.trim()).join("\n\n\n");
    const found = Chat.candidatePosts(text);
    if (file && ChatPhotos.isZip(file.buffer)) {
      // A small zip sent with the form: read with its photos in the background, pasted posts first.
      const id = await Imports.startGroupImport(pool, broker, [], {
        AI,
        ctx: { pool, broker, agency: req.session.agency, lang },
        lang,
        filename: String(file.originalname || "").slice(0, 120),
        prepare: (importId) => ChatPhotos.postsFromExport(pool, broker, importId, { buffer: file.buffer }, { extraPosts: found.posts })
      });
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "group_zip", bytes: file.buffer.length } });
      return res.redirect(303, `/app/import/${id}`);
    }
    if (!found.posts.length) {
      return importPage(req, res, html`<p class="card notice">🔍 ${L(lang, "ملقيناش بوستات فيها وحدات (سعر ومساحة أو غرف).", "No posts describing a unit (price and area or rooms) were found.")} <a href="/app/import">${L(lang, "رجوع", "Back")}</a></p>`, 422);
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

  // A chat export zip with photos goes from the browser straight to Storage (a signed upload URL), so a 100 MB file
  // never passes through this server's memory; the server then streams it to a temp file and reads it from there.
  web.post("/import/zip/start", async (req, res) => {
    const { broker } = req.session;
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return res.status(429).json({ error: "rate" });
    const target = `${zipPrefix(broker)}${Date.now()}-${crypto.randomBytes(6).toString("hex")}.zip`;
    const signed = await Supabase.createChatUploadUrl(target);
    if (!signed) return res.status(503).json({ error: "storage" });
    return res.json({ url: signed.url, path: target });
  });

  web.post("/import/zip", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const target = String(req.body.path || "");
    if (!ZIP_PATH.test(target) || !target.startsWith(zipPrefix(broker))) {
      return importPage(req, res, html`<p class="card notice bad">⚠️ ${L(lang, "اختار ملف الـ zip الأول.", "Choose the zip file first.")} <a href="/app/import">${L(lang, "رجوع", "Back")}</a></p>`, 400);
    }
    const tmp = path.join(os.tmpdir(), `chat-${crypto.randomBytes(8).toString("hex")}.zip`);
    const id = await Imports.startGroupImport(pool, broker, [], {
      AI,
      ctx: { pool, broker, agency: req.session.agency, lang },
      lang,
      filename: String(req.body.filename || "").slice(0, 120) || null,
      prepare: async (importId) => {
        try {
          await Supabase.downloadChatExportToFile(target, tmp);
        } catch (err) {
          if (err.code === "NOT_FOUND") return { error: "not_found" };
          if (err.code === "TOO_LARGE") return { error: "too_large" };
          throw err;
        }
        return ChatPhotos.postsFromExport(pool, broker, importId, { file: tmp });
      },
      cleanup: async () => {
        await fs.promises.unlink(tmp).catch(() => {});
        await Supabase.deleteChatExport(target);
      }
    });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_plan", metadata: { kind: "group_zip_upload" } });
    return res.redirect(303, `/app/import/${id}`);
  });

  web.get("/import/:id", async (req, res, next) => {
    const lang = langOf(req);
    const imp = await Imports.loadImport(pool, req.session.broker, req.params.id);
    if (!imp) return next();
    if (imp.kind === "leads") return res.redirect(303, `/app/leads/import/${imp.id}`);
    return importPage(req, res, imp.kind === "excel" ? excelPlanPage(imp, lang) : groupPage(imp, lang));
  });

  web.post("/import/:id/apply", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const imp = await Imports.loadImport(pool, broker, req.params.id);
    if (!imp || imp.kind === "leads") return next();
    const rows = [].concat(req.body.rows || []);
    const result =
      imp.kind === "excel"
        ? await Imports.applyExcel(pool, broker, imp.id, { rows, archive: [].concat(req.body.archive || []), lang })
        : await Imports.applyGroup(pool, broker, imp.id, { rows, lang });
    if (!result) {
      return importPage(req, res, html`<p class="card notice bad">⚠️ ${L(lang, "الاستيراد ده اتطبق قبل كده أو انتهت صلاحيته.", "This import was already applied or has expired.")} <a href="/app/import/${imp.id}">${L(lang, "عرض", "View")}</a></p>`, 409);
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_import_apply", metadata: { kind: imp.kind, ...Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.length])) } });
    return res.redirect(303, `/app/import/${imp.id}`);
  });

  /* Bulk edit from the units list. */
  web.post("/units/bulk", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    let out;
    try {
      out = await Bulk.bulkUpdate(pool, broker, { codes: [].concat(req.body.code || []), action: req.body.action, pct: req.body.pct });
    } catch (err) {
      if (err.code !== "INVALID_BULK") throw err;
      return page(req, res, { title: L(lang, "تعديل جماعي", "Bulk edit"), nav: "units", body: html`<p class="card notice bad">⚠️ ${L(lang, "اختار وحدات وإجراء صحيح (النسبة من -50% لـ +100%).", "Pick units and a valid action (percent from -50% to +100%).")} <a href="/app/units">${L(lang, "رجوع", "Back")}</a></p>` }, 422);
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_bulk_edit", metadata: { action: req.body.action, pct: req.body.pct || null, updated: out.updated.length, forbidden: out.forbidden.length, conflicts: out.conflicts.length } });
    const line = (label, list) => (list.length ? html`<li data-outcome>${label}: ${list.length} <span class="muted">${list.join("، ")}</span></li>` : "");
    return page(req, res, {
      title: L(lang, "تعديل جماعي", "Bulk edit"),
      nav: "units",
      body: html`<div class="card notice" data-bulk-result>
  <h1>✅ ${L(lang, "تعديل جماعي", "Bulk edit")}</h1>
  <ul>
    ${line(L(lang, "اتعدلت", "Updated"), out.updated)}
    ${line(L(lang, "مش من حقك تعدلها", "Not yours to change"), out.forbidden)}
    ${line(L(lang, "أسعار مطور (بتتعدل بشيت الأسعار)", "Developer prices (change them with the price sheet)"), out.skipped)}
    ${line(L(lang, "اتغيرت في نفس اللحظة، جرب تاني", "Changed at the same moment, try again"), out.conflicts)}
    ${line(L(lang, "مش موجودة", "Not found"), out.missing)}
  </ul>
  <a href="/app/units">${L(lang, "رجوع للوحدات", "Back to units")}</a>
</div>`
    });
  });
}

module.exports = { register, chatText, TEMPLATE_HEADERS };
