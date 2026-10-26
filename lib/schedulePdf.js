// lib/schedulePdf.js — A client's payment schedule as a PDF (Release A, C7): the agency's name and logo, the unit, the
// plan's numbers and the dated table, the broker to call. Pages are drawn with Satori (Arabic set word by word from the
// right, since Satori lays text left to right), turned into JPEGs with sharp and wrapped in a minimal PDF (one image a
// page), so no PDF library is needed. Never developer contacts or internal notes: the input is the client-safe data.
"use strict";

const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const { loadFont } = require("./flyerAssets");

const W = 1240;
const H = 1754; // A4 at 150 dpi
const PAD = 80;
const FIRST_ROWS = 13;
const MORE_ROWS = 20;
const INK = "#1f2937";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";

let fontsPromise = null;
function fonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([loadFont("Cairo.ttf"), loadFont("Cairo-Bold.ttf")]).then(([regular, bold]) => [
      { name: "Cairo", data: regular, weight: 400, style: "normal" },
      { name: "Cairo", data: bold, weight: 700, style: "normal" }
    ]);
  }
  return fontsPromise;
}

const el = (type, style, children) => ({ type, props: { style: { display: "flex", ...style }, ...(children !== undefined ? { children } : {}) } });

/** One line of text; Arabic runs right to left word by word (numbers and Latin words stay whole). */
function text(s, { size = 26, weight = 400, color = INK, rtl = false, style = {} } = {}) {
  const base = { fontSize: size, fontWeight: weight, color, fontFamily: "Cairo", lineHeight: 1.35, ...style };
  const str = String(s ?? "");
  // An Arabic label (a plan or fee name) on an English page still runs right to left.
  if (!rtl && !(/[\u0600-\u06FF]/.test(str) && !/[A-Za-z]{2,}/.test(str))) return el("div", base, str);
  // "150م" would come out reversed: digits and Arabic letters become separate words.
  const words = str.replace(/(\d)([\u0600-\u06FF])/g, "$1 $2").replace(/([\u0600-\u06FF])(\d)/g, "$1 $2").split(/\s+/).filter(Boolean);
  return el("div", { ...base, flexDirection: "row-reverse", flexWrap: "wrap", gap: Math.round(size * 0.28) }, words.map((w) => el("div", {}, w)));
}

const money = (n, lang) => (n === null || n === undefined ? "—" : `${Math.round(Number(n)).toLocaleString("en-US")} ${lang === "en" ? "EGP" : "جنيه"}`);

/** The pages' element trees. data = { lang, agency: { name, logo }, unit: { code, headline }, schedule, contact: { name, phone }, today } */
function pages(data) {
  const { lang, schedule: s } = data;
  const rtl = lang !== "en";
  const dir = rtl ? "row-reverse" : "row";
  const align = rtl ? "flex-end" : "flex-start";
  const L = (ar, en) => (rtl ? ar : en);
  const cols = [
    [L("#", "#"), 70],
    [L("الميعاد", "Due"), 210],
    [L("البند", "Item"), 330],
    [L("المبلغ", "Amount"), 260],
    ...(s.totals.maintenance_scheduled ? [[L("الصيانة", "Maintenance"), 210]] : [])
  ];
  const cell = (v, w, o = {}) => el("div", { width: w, justifyContent: rtl ? "flex-end" : "flex-start", padding: "10px 8px" }, [text(v, { size: 24, rtl, ...o })]);
  const head = el("div", { flexDirection: dir, borderBottom: `3px solid ${INK}` }, cols.map(([t, w]) => cell(t, w, { weight: 700 })));
  const row = (r) =>
    el("div", { flexDirection: dir, borderBottom: `1px solid ${LINE}` }, [
      cell(String(r.n), cols[0][1]),
      cell(r.date, cols[1][1]),
      cell(r.label, cols[2][1]),
      cell(money(r.amount, lang), cols[3][1], { weight: 700 }),
      ...(s.totals.maintenance_scheduled ? [cell(r.maintenance ? money(r.maintenance, lang) : "—", cols[4][1])] : [])
    ]);

  const chunks = [s.rows.slice(0, FIRST_ROWS)];
  for (let i = FIRST_ROWS; i < s.rows.length; i += MORE_ROWS) chunks.push(s.rows.slice(i, i + MORE_ROWS));
  const p = s.plan;
  const sum = [
    `${L("المقدم", "Down payment")} ${p.down_payment_pct}%: ${money(p.summary.down_payment, lang)}`,
    p.summary.installments ? `${p.summary.installments} ${L("قسط", "installments")} ${p.frequency_label} × ${money(p.summary.installment, lang)}` : null,
    p.summary.maintenance ? `${L("الصيانة", "Maintenance")} ${p.summary.maintenance_pct}%: ${money(p.summary.maintenance, lang)}` : null,
    ...p.fees.map((f) => `${f.label}: ${money(f.amount, lang)}`)
  ].filter(Boolean);

  const header = el("div", { flexDirection: dir, alignItems: "center", justifyContent: "space-between", borderBottom: `2px solid ${LINE}`, paddingBottom: 24 }, [
    el("div", { flexDirection: dir, alignItems: "center", gap: 24 }, [
      data.agency.logo ? { type: "img", props: { src: data.agency.logo, width: 120, height: 120, style: { width: 120, height: 120, objectFit: "contain" } } } : null,
      text(data.agency.name || "", { size: 40, weight: 700, rtl })
    ].filter(Boolean)),
    text(data.today, { size: 24, color: MUTED })
  ]);
  const footer = (n, total) =>
    el("div", { flexDirection: "column", alignItems: align, marginTop: "auto", borderTop: `2px solid ${LINE}`, paddingTop: 20, gap: 6 }, [
      data.contact ? text(`${L("للتواصل", "Contact")}: ${data.contact.name || ""} ${data.contact.phone || ""}`, { size: 26, weight: 700, rtl }) : null,
      text(L(`الأسعار والخطط حسب بيانات يوم ${data.today} وممكن تتغير. ده جدول استرشادي مش عقد، والمواعيد محسوبة من النهارده.`, `Prices and plans as of ${data.today}; they may change. An indicative schedule, not a contract; dates count from today.`), { size: 20, color: MUTED, rtl }),
      text(`${n} / ${total}`, { size: 20, color: MUTED })
    ].filter(Boolean));

  return chunks.map((rows, i) =>
    el("div", { flexDirection: "column", width: W, height: H, padding: PAD, background: "#ffffff", gap: 24 }, [
      header,
      ...(i === 0
        ? [
            el("div", { flexDirection: "column", alignItems: align, gap: 8 }, [
              text(L("جدول الدفع", "Payment schedule"), { size: 52, weight: 700, rtl }),
              text(data.unit.headline, { size: 30, rtl }),
              text(`${L("كود الوحدة", "Unit code")}: ${data.unit.code} · ${L("السعر", "Price")}: ${money(s.totals.price, lang)}`, { size: 28, weight: 700, rtl }),
              text(`${L("الخطة", "Plan")}: ${p.name}`, { size: 28, rtl })
            ]),
            el("div", { flexDirection: "column", alignItems: align, gap: 4, background: "#f3f4f6", padding: 20, borderRadius: 12 }, sum.map((t) => text(t, { size: 26, rtl })))
          ]
        : []),
      el("div", { flexDirection: "column" }, [head, ...rows.map(row)]),
      footer(i + 1, chunks.length)
    ])
  );
}

/** Minimal PDF: one JPEG page image per A4 page. */
function imagePdf(images) {
  const PW = 595.28;
  const PH = 841.89;
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1");
    parts.push(buf);
    size += buf.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    for (const b of [].concat(body)) push(b);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const pageIds = images.map((_, i) => 3 + i * 3);
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${images.length} >>`);
  images.forEach((img, i) => {
    const pid = 3 + i * 3;
    const draw = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${pid + 2} 0 R >> >> /Contents ${pid + 1} 0 R >>`);
    obj(pid + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(pid + 2, [`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.buffer.length} >>\nstream\n`, img.buffer, "\nendstream"]);
  });
  const count = 3 + images.length * 3;
  const xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** data (see pages) → PDF buffer. */
async function renderSchedulePdf(data) {
  const f = await fonts();
  const images = [];
  for (const tree of pages(data)) {
    const svg = await satori(tree, { width: W, height: H, fonts: f });
    const buffer = await sharp(Buffer.from(svg)).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
    images.push({ buffer, width: W, height: H });
  }
  return imagePdf(images);
}

module.exports = { renderSchedulePdf, imagePdf, pages };
