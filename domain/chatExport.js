// domain/chatExport.js — WhatsApp group posts: chat exports and pasted forwards → candidate listing posts (pure)
"use strict";

const crypto = require("crypto");
const { normalizeSearch } = require("./searchText");

const MAX_POSTS = 40;
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const AR = "٠١٢٣٤٥٦٧٨٩";
const latin = (s) => String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

// [24/10/2026, 10:15:32] Name: text   (iOS)
const IOS = /^\[(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap]\.?[Mm]\.?|\s*[صم])?)\]\s*([^:]{1,80}?):\s?([\s\S]*)$/;
// 24/10/2026, 10:15 - Name: text   (Android; "ص"/"م" or AM/PM)
const ANDROID = /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s*[APap]\.?[Mm]\.?|\s*[صم])?)\s+-\s+([^:]{1,80}?):\s?([\s\S]*)$/;
const HEAD = /^\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}/;
// A photo in an export with media: "IMG-20261024-WA0001.jpg (file attached)" (Android, Arabic "(ملف مرفق)") or
// "<attached: 00000012-PHOTO-2026-10-24-10-15-32.jpg>" (iOS, Arabic "<مرفق: …>"). HEIC isn't readable here: skipped.
const ATTACHED = /^(?:<(?:attached|مرفق)\s*:\s*([^>]+?\.(?:jpe?g|png|webp))\s*>|([^\s<>]+?\.(?:jpe?g|png|webp))\s*\((?:file attached|ملف مرفق)\))\s*$/i;
const PHOTO_WINDOW_MS = 10 * 60 * 1000;
const MAX_PHOTOS = 15;
const SKIP = /^(<media omitted>|<الوسائط محذوفة>|image omitted|video omitted|sticker omitted|this message was deleted|تم حذف هذه الرسالة|null)$/i;

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

/** "24/10/2026 10:15:32 PM" (day first, as Egyptian phones write it) → a comparable number of ms, or null. */
function atMs(at) {
  const m = String(at || "").match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([APap]\.?[Mm]\.?|[صم])?/);
  if (!m) return null;
  const [, d, mo, y, hh, mm, ss] = m;
  const ampm = (m[7] || "").toLowerCase().replace(/\./g, "");
  let hour = Number(hh);
  if ((ampm === "pm" || ampm === "م") && hour < 12) hour += 12;
  if ((ampm === "am" || ampm === "ص") && hour === 12) hour = 0;
  const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  return Date.UTC(year, Number(mo) - 1, Number(d), hour, Number(mm), Number(ss || 0));
}

/**
 * A chat export with media → messages [{ sender, at, text, files, i }]: a photo line becomes a file of its message
 * (Android puts a caption under it), other media lines are dropped.
 */
function parseWithAttachments(text) {
  const out = [];
  for (const raw of String(text || "").replace(BIDI, "").split(/\r?\n/)) {
    const line = latin(raw).trimEnd();
    const m = line.trim().match(IOS) || line.trim().match(ANDROID);
    if (m) {
      const first = m[4].trim();
      const file = first.match(ATTACHED);
      out.push({ sender: m[3].trim(), at: `${m[1]} ${m[2]}`.trim(), text: file ? "" : first, files: file ? [(file[1] || file[2]).trim()] : [] });
    } else if (HEAD.test(line.trim())) {
      out.push({ sender: null, at: null, text: "", files: [], system: true });
    } else if (out.length && line.trim()) {
      const last = out[out.length - 1];
      last.text = last.text ? `${last.text}\n${line.trim()}` : line.trim();
    }
  }
  return out.filter((m) => !m.system && (m.files.length || (m.text && !SKIP.test(m.text.trim())))).map((m, i) => ({ ...m, i }));
}

/**
 * Hands each photo to the listing post it belongs to: the same sender's nearest post (in order, within 10 minutes when
 * both times read), with no other post of theirs in between; at most 15 a post. Mutates posts (adds files).
 */
function assignPhotos(messages, posts) {
  const bySender = new Map();
  for (const p of posts) {
    if (!bySender.has(p.sender)) bySender.set(p.sender, []);
    bySender.get(p.sender).push(p);
    p.files = p.files || [];
  }
  for (const m of messages) {
    if (!m.files.length) continue;
    const own = bySender.get(m.sender) || [];
    if (!own.length) continue;
    const before = [...own].reverse().find((p) => p.i <= m.i);
    const after = own.find((p) => p.i > m.i);
    const t = atMs(m.at);
    const close = (p) => {
      if (!p) return false;
      const tp = atMs(p.at);
      return t === null || tp === null ? Math.abs(p.i - m.i) <= 15 : Math.abs(tp - t) <= PHOTO_WINDOW_MS;
    };
    const candidates = [before, after].filter(close);
    if (!candidates.length) continue;
    // Nearest by position; a tie goes to the post that follows (photos are usually sent first).
    const target = candidates.sort((a, b) => Math.abs(a.i - m.i) - Math.abs(b.i - m.i) || b.i - a.i)[0];
    for (const f of m.files) if (target.files.length < MAX_PHOTOS && !target.files.includes(f)) target.files.push(f);
  }
  return posts;
}

/**
 * A chat export with its media (the .zip WhatsApp makes) → candidate posts like candidatePosts, each with the photo
 * file names that belong to it.
 */
function candidatePostsWithPhotos(text) {
  const messages = parseWithAttachments(text);
  const seen = new Set();
  const posts = [];
  let skipped = 0;
  let duplicates = 0;
  for (const m of messages) {
    if (!m.text) continue;
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
    posts.push({ sender: m.sender, at: m.at, i: m.i, text: m.text.slice(0, 4000), hash, files: [...m.files] });
  }
  const kept = posts.slice(0, MAX_POSTS);
  assignPhotos(messages, kept);
  return { posts: kept, total: messages.length, skipped, duplicates, truncated: Math.max(0, posts.length - MAX_POSTS), photos: messages.reduce((n, m) => n + m.files.length, 0) };
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

const PRICE = /(\d[\d.,]*\s*(?:مليون|ألف|الف|million|k\b|m\b|ج|جنيه|egp))|(?:السعر|سعر|price|مقدم|المقدم|down payment|اجمالي|إجمالي)/i;
const UNIT = /(\d+\s*(?:م|متر|م2|م²|sqm|m2|m²)\b)|(?:غرف|غرفة|غرفه|bedroom|beds?|شقة|شقه|فيلا|تاون|توين|دوبلكس|استوديو|بنتهاوس|شاليه|apartment|villa|duplex|studio|chalet|مساحة|مساحه|area)/i;
const REQUEST = /(?:^|\s)(مطلوب|عايز|عاوز|محتاج|ابحث|looking for|wanted|required)(?=\s|$)/i;

/** A post that describes a unit for sale or rent (not a request, not chatter). */
function looksLikeListing(text) {
  const t = latin(String(text || ""));
  if (t.length < 30 || REQUEST.test(t)) return false;
  return PRICE.test(t) && UNIT.test(t);
}

/**
 * Upload or paste → candidate posts, de-duplicated by normalized text, at most MAX_POSTS.
 * @returns {{ posts: [{ sender, at, text, hash }], total, skipped, duplicates, truncated }}
 */
function candidatePosts(text) {
  const messages = isChatExport(text) ? parseChatExport(text) : splitPasted(text);
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

module.exports = { MAX_POSTS, MAX_PHOTOS, isChatExport, parseChatExport, splitPasted, looksLikeListing, candidatePosts, atMs, parseWithAttachments, assignPhotos, candidatePostsWithPhotos };
