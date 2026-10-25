// lib/sheets.js — Reads an uploaded workbook (.xlsx, exceljs) or CSV in memory into mapped rows. The header row is
// found among the top rows by the caller's column matcher; formulas are never evaluated or kept (a cached result
// is read, a CSV cell starting with "=" stays plain text).
"use strict";

const ExcelJS = require("exceljs");
const U = require("./util");
const { columnFor } = require("../domain/sheetImport");

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const HEADER_SCAN = 10;

const fail = (code, message) => Object.assign(new Error(message), { code });

const cellValue = (cell) => {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "formula" in v) return v.result ?? null; // formula: its value, never the formula
  if (typeof v === "object" && "result" in v) return v.result ?? null;
  return cell.text;
};

/**
 * Rows of raw values ([{ rowNumber, values: [] }], values indexed from 1) → the mapped table.
 * @param {Function} matcher - header text → column key (or null)
 * @param {number} minColumns - known columns a header row must name
 */
function mapTable(rows, { matcher = columnFor, minColumns = 3, noHeader = "No header row with known columns (code, compound, price, area, …)" } = {}) {
  let headerAt = -1;
  let map = {};
  for (let i = 0; i < Math.min(HEADER_SCAN, rows.length); i++) {
    const m = {};
    rows[i].values.forEach((v, col) => {
      const key = v === null || v === undefined ? null : matcher(String(v));
      if (key && !Object.values(m).includes(key)) m[col] = key;
    });
    if (Object.keys(m).length >= minColumns) {
      headerAt = i;
      map = m;
      break;
    }
  }
  if (headerAt < 0) throw fail("NO_HEADER", noHeader);

  const headers = [];
  const unmapped = [];
  rows[headerAt].values.forEach((v, col) => {
    const h = String(v ?? "").trim();
    if (!h) return;
    headers.push(h);
    if (!map[col]) unmapped.push(h);
  });

  const out = [];
  for (const row of rows.slice(headerAt + 1)) {
    const cells = {};
    let any = false;
    for (const [col, key] of Object.entries(map)) {
      const v = row.values[Number(col)];
      if (v !== null && v !== undefined && String(v).trim() !== "") {
        cells[key] = v;
        any = true;
      }
    }
    if (!any) continue;
    out.push({ rowNumber: row.rowNumber, cells });
    if (out.length > MAX_ROWS) throw fail("TOO_MANY_ROWS", `More than ${MAX_ROWS} rows`);
  }
  return { headers, mapped: Object.values(map), unmapped, rows: out };
}

/** The first sheet of an .xlsx as raw rows. */
async function xlsxRows(buffer) {
  if (!buffer || buffer.length > MAX_BYTES) throw fail("TOO_LARGE", "File is larger than 5 MB");
  if (!U.isValidZipBuffer(buffer)) throw fail("NOT_XLSX", "Not an .xlsx workbook");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw fail("NOT_XLSX", "Not an .xlsx workbook");
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw fail("NO_HEADER", "The workbook has no sheet");
  const rows = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const values = [];
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
      // Header cells are matched on their text; data cells keep numbers and dates.
      values[col] = r <= HEADER_SCAN && typeof cell.value === "string" ? cell.text : cellValue(cell);
    });
    rows.push({ rowNumber: r, values });
    if (rows.length > MAX_ROWS + HEADER_SCAN + 1000) break; // blank-row padding never makes a sheet unbounded
  }
  return rows;
}

/**
 * @returns {Promise<{ headers: string[], mapped: Object, unmapped: string[], rows: [{ rowNumber, cells }] }>}
 * @throws {Error} code NOT_XLSX | TOO_LARGE | NO_HEADER | TOO_MANY_ROWS
 */
async function readInventorySheet(buffer) {
  return mapTable(await xlsxRows(buffer));
}

/** Bytes → text: UTF-8 (with or without a BOM), UTF-16 (Excel's "Unicode text"), else Windows-1256 (Arabic Excel's CSV). */
function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  const body = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1256").decode(body);
  }
}

/** The delimiter of the first line outside quotes: comma, semicolon (Arabic and European Excel) or tab. */
function sniffDelimiter(text) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

/** RFC 4180 rows (quotes, doubled quotes, line breaks inside quotes, CRLF). Values indexed from 1. */
function parseCsv(text, limitRows = MAX_ROWS + HEADER_SCAN + 1) {
  const delim = sniffDelimiter(text);
  const rows = [];
  let values = [null];
  let field = "";
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  const endField = () => {
    values.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (values.some((v, i) => i > 0 && v.trim() !== "")) rows.push({ rowNumber: rowStart, values });
    values = [null];
    rowStart = line;
    if (rows.length > limitRows) throw fail("TOO_MANY_ROWS", `More than ${MAX_ROWS} rows`);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) endField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line++;
      endRow();
    } else field += ch;
  }
  if (field !== "" || values.length > 1) endRow();
  return rows;
}

/**
 * A CSV upload → raw rows.
 * @throws {Error} code TOO_LARGE | NOT_TEXT | TOO_MANY_ROWS
 */
function csvRows(buffer) {
  if (!buffer || buffer.length > MAX_BYTES) throw fail("TOO_LARGE", "File is larger than 5 MB");
  const text = decodeText(buffer);
  if (/\u0000/.test(text.slice(0, 4096))) throw fail("NOT_TEXT", "Not a CSV file");
  return parseCsv(text);
}

/**
 * A lead file (.xlsx or .csv, told apart by its bytes) → the mapped table.
 * @param {Object} opts - mapTable options (matcher, minColumns, noHeader)
 */
async function readTable(buffer, opts) {
  if (!buffer || buffer.length > MAX_BYTES) throw fail("TOO_LARGE", "File is larger than 5 MB");
  const zip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  return mapTable(zip ? await xlsxRows(buffer) : csvRows(buffer), opts);
}

module.exports = { MAX_BYTES, MAX_ROWS, readInventorySheet, readTable, parseCsv, decodeText, mapTable };
