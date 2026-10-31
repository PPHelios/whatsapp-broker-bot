// domain/chatExport.js — WhatsApp group posts: chat exports and pasted forwards → candidate listing posts (pure)
"use strict";

const crypto = require("crypto");
const { normalizeSearch } = require("./searchText");
const { BIDI, latin, IOS, ANDROID, HEAD, SKIP, MAX_PHOTOS, DEFAULT_DAYS, atMs, sinceMs, defaultSince, notOlder, parseWithAttachments, looksLikeListing } = require("./chatParse");

const MAX_POSTS = 40;
/** True when a text is a WhatsApp chat export (most non-empty lines start with a timestamp). */
function isChatExport(text) {
  const lines = String(text || "").replace(BIDI, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const stamped = lines.filter((l) => HEAD.test(latin(l.trim()))).length;
  return stamped >= Math.max(2, lines.length * 0.2);
}

/** Chat export text → messages [{ sender, at, text }]; continuation lines join the message above. */
function parseChatExport(text) {
  const out = [];
  for (const raw of String(text || "").replace(BIDI, "").split(/\r?\n/)) {
    const line = latin(raw).trimEnd();
    const m = line.trim().match(IOS) || line.trim().match(ANDROID);
    if (m) {
      out.push({ sender: m[3].trim(), at: `${m[1]} ${m[2]}`.trim(), text: m[4].trim() });
    } else if (HEAD.test(line.trim())) {
      out.push({ sender: null, at: null, text: "", system: true }); // "Messages are end-to-end encrypted", joins, ...
    } else if (out.length && line.trim()) {
      out[out.length - 1].text += `\n${line.trim()}`;
    }
  }
  return out.filter((m) => !m.system && m.text && !SKIP.test(m.text.trim()));
}

/** Pasted forwards → posts: blank lines (two or more) or a "Forwarded" marker separate them. */
function splitPasted(text) {
  return String(text || "")
    .replace(BIDI, "")
    .split(/\n\s*\n\s*\n+|^\s*(?:forwarded|تمت إعادة التوجيه|معاد توجيهها)\s*$/im)
    .map((t) => (t || "").trim())
    .filter(Boolean)
    .map((t) => ({ sender: null, at: null, text: t }));
}

/**
 * Upload or paste → candidate posts, de-duplicated by normalized text, at most MAX_POSTS.
 * @returns {{ posts: [{ sender, at, text, hash }], total, skipped, duplicates, truncated }}
 */
function candidatePosts(text, { since = null } = {}) {
  const messages = (isChatExport(text) ? parseChatExport(text) : splitPasted(text)).filter(notOlder(sinceMs(since)));
  const seen = new Set();
  const posts = [];
  let skipped = 0;
  let duplicates = 0;
  for (const m of messages) {
    if (!looksLikeListing(m.text)) {
      skipped++;
      continue;
    }
    const hash = crypto.createHash("sha1").update(normalizeSearch(m.text)).digest("hex").slice(0, 16);
    if (seen.has(hash)) {
      duplicates++;
      continue;
    }
    seen.add(hash);
    posts.push({ ...m, text: m.text.slice(0, 4000), hash });
  }
  return { posts: posts.slice(0, MAX_POSTS), total: messages.length, skipped, duplicates, truncated: Math.max(0, posts.length - MAX_POSTS) };
}

module.exports = { DEFAULT_DAYS, defaultSince, MAX_POSTS, MAX_PHOTOS, isChatExport, parseChatExport, splitPasted, looksLikeListing, candidatePosts, atMs, parseWithAttachments };
