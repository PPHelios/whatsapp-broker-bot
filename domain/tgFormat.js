// domain/tgFormat.js — WhatsApp-style text to Telegram HTML (Release 3T). Replies are written once with WhatsApp's
// *bold* / _italic_ / ~strike~ / ```mono```; Telegram gets the same text escaped and converted.
"use strict";

const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** WhatsApp formatting → Telegram HTML (parse_mode HTML). Everything else is escaped. */
function toHtml(text) {
  let s = escapeHtml(text);
  s = s.replace(/```([\s\S]+?)```/g, "<pre>$1</pre>");
  s = s.replace(/\*([^*\n]+?)\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(«"'])_([^_\n]+?)_(?=$|[\s).,!?:؛،»"'])/gm, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(«])~([^~\n]+?)~(?=$|[\s).,!?:؛،»])/gm, "$1<s>$2</s>");
  return s;
}

/** Fits a button label: Telegram shows long labels but they read badly on a phone. */
const label = (t) => Array.from(String(t || "").trim()).slice(0, 40).join("");

/**
 * WhatsApp reply buttons [{ id, title }] → inline keyboard rows, one button per row. `encode(id)` returns the
 * callback_data (ids over 64 bytes are swapped for a short token by the caller).
 */
async function keyboard(buttons, encode) {
  const rows = [];
  for (const b of buttons || []) rows.push([{ text: label(b.title), callback_data: await encode(String(b.id)) }]);
  return rows;
}

/** A WhatsApp list (sections of rows) → inline keyboard rows; the section titles aren't shown. */
async function listKeyboard(sections, encode) {
  const rows = [];
  for (const s of sections || []) {
    for (const r of s.rows || []) rows.push([{ text: label(r.description ? `${r.title} · ${r.description}` : r.title), callback_data: await encode(String(r.id)) }]);
  }
  return rows;
}

/** A URL button (wa.me, the website). */
const urlButton = (text, url) => [{ text: label(text), url }];

module.exports = { escapeHtml, toHtml, keyboard, listKeyboard, urlButton, label };
