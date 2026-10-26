// lib/pdfPages.js — A PDF's pages for the price-list reader (Release B, C5): how many pages, and the pages a manager
// picked, each as its own one-page PDF with a fingerprint of what it draws (its decoded content streams, which hold
// the page's text and numbers). The same page of the same price list gives the same fingerprint whichever agency
// uploads it, so a page read once is never read again. Photos are fingerprinted by their bytes. pdf-lib only (no
// rendering).
"use strict";

const crypto = require("crypto");
const { PDFDocument, PDFArray, PDFRawStream, PDFName, decodePDFRawStream } = require("pdf-lib");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function load(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    const e = new Error("Not a PDF");
    e.code = "NOT_PDF";
    throw e;
  }
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    const e = new Error(`Unreadable PDF: ${err.message}`);
    e.code = "NOT_PDF";
    throw e;
  }
}

async function pageCount(buffer) {
  return (await load(buffer)).getPageCount();
}

/** The bytes a page draws, decoded (a page's Contents is one stream or an array of streams). */
function contentBytes(doc, page) {
  const ref = page.node.get(PDFName.of("Contents"));
  if (!ref) return Buffer.alloc(0);
  const obj = doc.context.lookup(ref);
  const streams = obj instanceof PDFArray ? obj.asArray().map((r) => doc.context.lookup(r)) : [obj];
  const parts = [];
  for (const s of streams) {
    if (!s) continue;
    try {
      parts.push(Buffer.from(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()));
    } catch {
      parts.push(Buffer.from(s.getContents ? s.getContents() : []));
    }
  }
  return Buffer.concat(parts);
}

/**
 * The picked pages (1-based) → [{ page, pdf, fingerprint }]. A page with nothing drawn (a scanned image only)
 * falls back to the hash of its one-page PDF.
 */
async function extract(buffer, pages) {
  const doc = await load(buffer);
  const out = [];
  for (const n of pages) {
    if (n < 1 || n > doc.getPageCount()) continue;
    const one = await PDFDocument.create();
    const [copy] = await one.copyPages(doc, [n - 1]);
    one.addPage(copy);
    const pdf = Buffer.from(await one.save({ useObjectStreams: false }));
    const drawn = contentBytes(doc, doc.getPage(n - 1));
    out.push({ page: n, pdf, fingerprint: `pdf:${sha(drawn.length > 64 ? drawn : pdf)}` });
  }
  return out;
}

const imageFingerprint = (buffer) => `img:${sha(buffer)}`;

module.exports = { pageCount, extract, imageFingerprint };
