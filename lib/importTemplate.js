// lib/importTemplate.js — The downloadable import templates: mandatory columns in red, optional in grey, a Read me sheet,
// and dummy sample rows (marked, to delete before uploading real data).
"use strict";

const ExcelJS = require("exceljs");

const RED = "FFB42318";
const GREY = "FF475467";

/**
 * @param {Object} o - { sheetName, headers, required: [header index], samples: [rows], text: [column numbers kept as text],
 *   readme: [[ar, en]] }
 * @returns {Promise<Buffer>}
 */
async function build({ sheetName, headers, required, samples, text = [], readme = [] }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  const head = sheet.addRow(headers);
  head.height = 30;
  head.eachCell((cell, n) => {
    const must = required.includes(n - 1);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: must ? RED : GREY } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.note = must ? "Mandatory / مطلوب" : "Optional / اختياري";
  });
  for (const r of samples) sheet.addRow(r);
  for (const n of text) sheet.getColumn(n).numFmt = "@";
  sheet.columns.forEach((c) => (c.width = 20));

  const info = wb.addWorksheet("Read me");
  info.getColumn(1).width = 90;
  info.addRow(["Red column = mandatory · Grey column = optional   |   الأحمر مطلوب · الرمادي اختياري"]).font = { bold: true };
  info.addRow([`Mandatory: ${required.map((i) => headers[i]).join(" | ")}`]);
  info.addRow(["The sample rows are dummy data: delete them before you upload your own. / الصفوف التجريبية بيانات وهمية: امسحها قبل ما ترفع بياناتك."]);
  info.addRow([""]);
  for (const [ar, en] of readme) info.addRow([`${en}  /  ${ar}`]);
  info.getColumn(1).alignment = { wrapText: true, vertical: "top" };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { build };
