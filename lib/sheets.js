// lib/sheets.js — Reads an uploaded inventory workbook in memory (exceljs) into mapped rows
"use strict";

const ExcelJS = require("exceljs");
const U = require("./util");
const { columnFor } = require("../domain/sheetImport");

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const HEADER_SCAN = 10;

const cellValue = (cell) => {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "result" in v) return v.result ?? null; // formula: its value, never the formula
  return cell.text;
};

/**
 * @returns {Promise<{ headers: string[], mapped: Object, unmapped: string[], rows: [{ rowNumber, cells }] }>}
 * @throws {Error} code NOT_XLSX | TOO_LARGE | NO_HEADER | TOO_MANY_ROWS
 */
async function readInventorySheet(buffer) {
  if (!buffer || buffer.length > MAX_BYTES) throw Object.assign(new Error("File is larger than 5 MB"), { code: "TOO_LARGE" });
  if (!U.isValidZipBuffer(buffer)) throw Object.assign(new Error("Not an .xlsx workbook"), { code: "NOT_XLSX" });
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw Object.assign(new Error("Not an .xlsx workbook"), { code: "NOT_XLSX" });
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw Object.assign(new Error("The workbook has no sheet"), { code: "NO_HEADER" });

  // The header row is the first of the top rows that names at least three known columns.
  let headerRow = null;
  let map = {};
  for (let r = 1; r <= Math.min(HEADER_SCAN, sheet.rowCount); r++) {
    const m = {};
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      const key = columnFor(String(cell.text || ""));
      if (key && !Object.values(m).includes(key)) m[col] = key;
    });
    if (Object.keys(m).length >= 3) {
      headerRow = r;
      map = m;
      break;
    }
  }
  if (!headerRow) throw Object.assign(new Error("No header row with known columns (code, compound, price, area, …)"), { code: "NO_HEADER" });

  const headers = [];
  const unmapped = [];
  sheet.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, col) => {
    headers.push(String(cell.text || "").trim());
    if (!map[col]) unmapped.push(String(cell.text || "").trim());
  });

  const rows = [];
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells = {};
    let any = false;
    for (const [col, key] of Object.entries(map)) {
      const v = cellValue(row.getCell(Number(col)));
      if (v !== null && String(v).trim() !== "") {
        cells[key] = v;
        any = true;
      }
    }
    if (!any) continue;
    rows.push({ rowNumber: r, cells });
    if (rows.length > MAX_ROWS) throw Object.assign(new Error(`More than ${MAX_ROWS} rows`), { code: "TOO_MANY_ROWS" });
  }
  return { headers, mapped: Object.values(map), unmapped, rows };
}

module.exports = { MAX_BYTES, MAX_ROWS, readInventorySheet };
