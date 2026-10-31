// domain/chatMatch.js — Which photos of a WhatsApp chat export belong to which unit (pure; runs in the browser).
// The match page reads the zip in the browser and calls match() with the chat text, so the zip and the rest of the
// chat never reach the server. Two ways to know the units:
//   codes: the unit codes already in the app (e.g. after the Excel import): a post or caption naming a known code
//          is that unit's description. No AI.
//   posts: no codes: posts that look like a unit (price + area or rooms) are the units (the server reads their text).
// A photo run goes to the description next to it. Photos then text, or text then photos, is detected from the chat
// (or chosen); a run that cannot be placed without guessing goes to the tray instead.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./chatParse"));
  else root.ChatMatch = factory(root.ChatParse);
})(typeof self !== "undefined" ? self : this, function (P) {
  "use strict";

  const MAX_POSTS = 40;
  const MEDIA_LINE = /^(?:<(?:attached|مرفق)\s*:[^>]*>|.+\((?:file attached|ملف مرفق)\))\s*$/i;
  const OMITTED = /^(<media omitted>|<الوسائط محذوفة>|image omitted)$/i;
  const NUMBER_WORDS = new Set(["كود", "code", "no", "رقم", "unit"]);

  /** A code with the noise taken out: "nh v-12" → "NHV12" (Arabic digits too). */
  const normCode = (s) => P.latin(String(s || "")).toUpperCase().replace(/[\s._\-/\\]+/g, "");
  const words = (text) => P.latin(String(text || "")).split(/[^A-Za-z0-9\u0600-\u06FF]+/).filter(Boolean);
  const dedupeKey = (text) => String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

  /** Edit distance up to 1 (substitution, insertion, deletion) without the full table. */
  function withinOne(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    return s.slice(i) === l.slice(i + 1);
  }

  /**
   * @param {string[]} codes the unit codes in the app
   * @returns {(text: string) => string[]} the known codes a text names (distinct, in order)
   */
  function codeFinder(codes, aliases = {}) {
    const known = new Map();
    for (const [k, v] of Object.entries(aliases || {})) if (k && v) known.set(String(k), v);
    for (const c of codes || []) {
      const n = normCode(c);
      if (n.length >= 2 && (/\d/.test(n) || n.length >= 5)) known.set(n, c);
    }
    return (text) => {
      const w = words(text);
      const out = [];
      for (let s = 0; s < w.length; s++) {
        let joined = "";
        for (let len = 1; len <= 4 && s + len <= w.length; len++) {
          joined += w[s + len - 1].toUpperCase();
          const hit = known.get(joined);
          if (!hit) continue;
          // A bare number is a code only after "code"/"كود"/"رقم" (a price or an area is a number too).
          if (/^\d+$/.test(joined) && !(s > 0 && NUMBER_WORDS.has(w[s - 1].toLowerCase()))) continue;
          if (!out.includes(hit)) out.push(hit);
        }
      }
      return out;
    };
  }

  /** Code-looking words of a text that are not known codes, with the known codes one character away. */
  function unknownCodes(text, knownNorms, find) {
    const out = [];
    const re = /(?<![A-Za-z0-9])[A-Za-z]{1,4}(?:[\s._-]?[A-Za-z]{1,2})?[\s._-]?\d{1,5}(?![A-Za-z0-9])/g;
    for (const m of P.latin(String(text || "")).matchAll(re)) {
      const n = normCode(m[0]);
      if (n.length < 3 || knownNorms.has(n) || find(m[0]).length) continue;
      const suggestions = [];
      for (const [k, v] of knownNorms) if (withinOne(n, k)) suggestions.push(v);
      out.push({ token: m[0].trim(), suggestions: suggestions.slice(0, 3) });
    }
    return out;
  }

  /**
   * @param {string} text the chat .txt
   * @param {object} o
   * @param {string|null} o.since "YYYY-MM-DD": older messages are dropped (and their photos never read)
   * @param {number} o.windowMin minutes: a longer silence starts a new block
   * @param {boolean} o.sameSender only the same person's photos go with a description
   * @param {"auto"|"photos_first"|"text_first"} o.pattern
   * @param {string[]|null} o.codes the unit codes in the app (codes mode) or null (posts mode)
   * @param {Object} o.aliases a chat word the person chose to read as a code ({ NORMALISED_WORD: code })
   */
  function match(text, { since = null, windowMin = 10, sameSender = true, pattern = "auto", codes = null, aliases = {} } = {}) {
    const find = codes ? codeFinder(codes, aliases) : null;
    const knownNorms = new Map((codes || []).map((c) => [normCode(c), c]));
    const windowMs = Math.max(1, Number(windowMin) || 10) * 60 * 1000;
    const messages = P.parseWithAttachments(text).filter(P.notOlder(P.sinceMs(since)));
    const stats = { messages: messages.length, photos: 0, skippedMedia: 0, omittedMedia: 0, duplicates: 0, truncated: 0 };
    for (const line of String(text || "").split(/\r?\n/)) {
      const body = line.replace(/^.*?\s-\s[^:]{1,80}:\s?/, "").replace(/^\[[^\]]*\]\s*[^:]{1,80}:\s?/, "").trim();
      if (OMITTED.test(body)) stats.omittedMedia++;
    }

    // Items in chat order: an anchor (a description), or a photo.
    const seenPost = new Set();
    const items = [];
    for (const m of messages) {
      const t = P.atMs(m.at);
      const hasText = Boolean(m.text && m.text.trim());
      let anchor = null;
      if (hasText && MEDIA_LINE.test(m.text.trim())) {
        stats.skippedMedia++;
      } else if (hasText && find) {
        const found = find(m.text);
        if (found.length) anchor = { codes: found };
      } else if (hasText && P.looksLikeListing(m.text)) {
        const key = dedupeKey(m.text);
        if (seenPost.has(key)) stats.duplicates++;
        else {
          seenPost.add(key);
          anchor = { post: true };
        }
      }
      const refs = m.files.map((name) => ({ name, i: m.i, at: m.at }));
      if (anchor) items.push({ kind: "A", m, t, sender: m.sender, own: refs, ...anchor });
      else if (refs.length) items.push({ kind: "P", m, t, sender: m.sender, files: refs });
      stats.photos += m.files.length;
    }

    // Per sender (or all together): sequence → bursts → elements (anchors and photo runs).
    const sequences = new Map();
    for (const it of items) {
      const key = sameSender ? it.sender || "" : "";
      if (!sequences.has(key)) sequences.set(key, []);
      sequences.get(key).push(it);
    }
    const bursts = [];
    for (const seq of sequences.values()) {
      let burst = null;
      let prev = null;
      for (const it of seq) {
        const gap = prev && prev.t !== null && it.t !== null ? Math.abs(it.t - prev.t) : 0;
        if (!burst || gap > windowMs) {
          burst = [];
          bursts.push(burst);
        }
        const last = burst[burst.length - 1];
        if (it.kind === "P" && last && last.kind === "P") last.files.push(...it.files);
        else burst.push(it.kind === "P" ? { kind: "P", files: it.files.slice(), m: it.m, sender: it.sender } : it);
        prev = it;
      }
    }

    // Which comes first, from the bursts that show it: starts with photos and ends with a description, or the opposite.
    let pf = 0;
    let tf = 0;
    for (const b of bursts) {
      if (!b.some((e) => e.kind === "A") || !b.some((e) => e.kind === "P")) continue;
      const first = b[0].kind;
      const last = b[b.length - 1].kind;
      if (first === "P" && last === "A") pf++;
      else if (first === "A" && last === "P") tf++;
    }
    const detected = pf && !tf ? "photos_first" : tf && !pf ? "text_first" : pf && tf ? "mixed" : "unknown";
    const forced = pattern === "photos_first" || pattern === "text_first";
    const rule = forced ? pattern : detected;

    const tray = [];
    const refOf = (a) => (a.post ? a : a.codes.length === 1 ? a.codes[0] : null);
    const addTo = (a, run) => {
      a.attached = a.attached || [];
      a.attached.push(...run.files);
    };
    const toTray = (run, reason, candidates) => tray.push({ id: `t${tray.length}`, reason, sender: run.sender || null, at: run.files[0].at, files: run.files, candidates });
    const candidateOf = (a) => (a.post ? { post: a.m.i } : { codes: a.codes });

    for (const b of bursts) {
      b.forEach((e, k) => {
        if (e.kind !== "P") return;
        const prevA = k > 0 && b[k - 1].kind === "A" ? b[k - 1] : null;
        const nextA = k < b.length - 1 && b[k + 1].kind === "A" ? b[k + 1] : null;
        if (!prevA && !nextA) return toTray(e, "orphan", []);
        let target = null;
        if (prevA && nextA) {
          if (rule === "photos_first") target = nextA;
          else if (rule === "text_first") target = prevA;
          else return toTray(e, "ambiguous", [candidateOf(prevA), candidateOf(nextA)]);
        } else {
          const only = prevA || nextA;
          const against = (rule === "photos_first" && !nextA) || (rule === "text_first" && !prevA);
          if (against && rule !== "unknown") return toTray(e, "against_pattern", [candidateOf(only)]);
          target = only;
        }
        if (!refOf(target)) return toTray(e, "multi_code", [candidateOf(target)]);
        return addTo(target, e);
      });
    }

    // Collect per unit / per post, in chat order. A description with several codes cannot place its own photos.
    const byAnchor = items.filter((x) => x.kind === "A");
    const result = { mode: find ? "codes" : "posts", pattern: rule, detected, tray, stats, unknownCodes: [] };

    const withFiles = (a) => [...a.own, ...(a.attached || [])];
    if (find) {
      const units = new Map();
      for (const a of byAnchor) {
        if (a.codes.length > 1) {
          if (a.own.length) tray.push({ id: `t${tray.length}`, reason: "multi_code", sender: a.sender, at: a.m.at, files: a.own, candidates: [candidateOf(a)] });
          continue;
        }
        const code = a.codes[0];
        const u = units.get(code) || { code, files: [], messages: 0 };
        u.messages++;
        for (const f of withFiles(a)) if (!u.files.some((x) => x.name === f.name)) u.files.push(f);
        units.set(code, u);
      }
      result.units = [...units.values()].map((u) => {
        u.files.sort((x, y) => x.i - y.i);
        const over = Math.max(0, u.files.length - P.MAX_PHOTOS);
        return { ...u, files: u.files.slice(0, P.MAX_PHOTOS), over };
      });
      // Code-like words that are not known codes: shown when a known code is one character away, or when they sit
      // in a caption or a short message; never applied without a tap.
      const photoAt = new Set(messages.filter((m) => m.files.length).map((m) => m.i));
      const seen = new Set();
      for (const m of messages) {
        if (!m.text || MEDIA_LINE.test(m.text.trim())) continue;
        const near = photoAt.has(m.i) || photoAt.has(m.i - 1) || photoAt.has(m.i + 1) || photoAt.has(m.i - 2);
        for (const u of unknownCodes(m.text, knownNorms, find)) {
          const key = normCode(u.token);
          if (seen.has(key) || !(u.suggestions.length || (near && m.text.length <= 80))) continue;
          seen.add(key);
          result.unknownCodes.push({ ...u, sender: m.sender, at: m.at });
        }
      }
      result.unknownCodes = result.unknownCodes.slice(0, 50);
      const used = new Set(result.units.map((u) => u.code));
      result.noPhotos = (codes || []).filter((c) => !used.has(c) || !result.units.find((u) => u.code === c).files.length);
    } else {
      const posts = byAnchor.map((a) => ({ i: a.m.i, sender: a.sender, at: a.m.at, text: a.m.text.slice(0, 4000), files: withFiles(a).sort((x, y) => x.i - y.i).slice(0, P.MAX_PHOTOS) }));
      stats.truncated = Math.max(0, posts.length - MAX_POSTS);
      result.posts = posts.slice(0, MAX_POSTS);
    }
    return result;
  }

  return { match, codeFinder, normCode, MAX_POSTS };
});
