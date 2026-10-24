// lib/registry.js — Command registry for the commands Release 1 touched (quick updates, price, edit, paging)
// Each entry is { name, match(text, state) → args | null, run(broker, args, ctx) }. Matchers are anchored and
// specific, so the first match is the only match (no order-dependent regex chain).
"use strict";

const Edits = require("./edits");

const CODE = "[#`\\[]?([A-Za-z0-9][A-Za-z0-9_\\-.\\/]{1,29})[`\\]]?";
const SOLD = "(?:تم البيع|تم بيعها|اتباعت|اتباع|اتبعت|بيعت|مباع[ةه]?|sold)";
const ARCHIVE = "(?:ارشفة|أرشفة|ارشفه|أرشفه|ارشف|أرشف|archive)";
const AVAILABLE = "(?:لسه متاح[ةه]?|لسه موجود[ةه]?|متاح[ةه]?|تفعيل|نشط[ةه]?|still available|available|active)";
const PRICE = "(?:سعر|السعر|price)";

const toLatin = (s) => String(s).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
const clean = (text) => toLatin(String(text || "").replace(/[\u200E\u200F\u202A-\u202E]/g, "")).trim().replace(/\s+/g, " ");

function matchStatus(text) {
  const s = clean(text);
  for (const [action, word] of [["sold", SOLD], ["archive", ARCHIVE], ["available", AVAILABLE]]) {
    let m = s.match(new RegExp(`^${word}(?:\\s+(?:الوحدة|unit|كود|code))?(?:\\s+${CODE})?[.!]?$`, "i"));
    if (m) return { action, code: m[1] || null };
    m = s.match(new RegExp(`^(?:الوحدة\\s+|كود\\s+)?${CODE}\\s+${word}[.!]?$`, "i"));
    if (m) return { action, code: m[1] };
  }
  return null;
}

/** "سعر CODE 9 مليون", "price CODE 9M", "تعديل سعر CODE إلى 9 مليون" (A5), "سعر CODE بقى 9 مليون". */
function matchPrice(text) {
  const s = clean(text);
  const m = s.match(new RegExp(`^(?:تعديل\\s+|edit\\s+)?${PRICE}\\s+(?:الوحدة\\s+)?${CODE}\\s+(?:الى|إلى|لـ|ل|بقى|بقا|to|=|:)?\\s*(.+)$`, "i"));
  if (m && /\d/.test(m[2])) return { code: m[1], priceText: m[2] };
  return null;
}

/** "تعديل CODE" or "تعديل CODE <instructions>" (A3). Price forms are matched by matchPrice first. */
function matchEdit(text) {
  const s = clean(text);
  if (matchPrice(s)) return null;
  const m = s.match(new RegExp(`^(?:تعديل|عدل|edit)(?:\\s+${CODE})?(?:\\s+(.+))?$`, "i"));
  if (!m) return null;
  // "تعديل السعر 9 مليون" without a code: the words are instructions for the last unit.
  if (m[1] && /^[\u0600-\u06FF]/.test(m[1])) return { code: null, instructions: [m[1], m[2]].filter(Boolean).join(" ") };
  return { code: m[1] || null, instructions: m[2] || null };
}

const WEB_LOGIN = /^(?:دخول|الدخول|تسجيل الدخول|الموقع|موقع|الويب|لوجين|login|log in|sign in|website|web)$/i;

async function sendLoginLink(broker, ctx) {
  const { reply } = require("./dispatcher");
  const WebAuth = require("./webAuth");
  const RateLimit = require("./rateLimit");
  const Links = require("./links");
  const { t } = require("./copy");
  const gate = await RateLimit.hit(ctx.pool, `login_link:broker:${broker.id}`, RateLimit.LIMITS.loginLinkBroker);
  if (!gate.allowed) {
    await reply(broker, t("web_login_limited", ctx.lang));
    return "done";
  }
  const token = await WebAuth.issueLoginToken(ctx.pool, broker, { channel: "whatsapp" });
  await reply(broker, t("web_login_link", ctx.lang, { url: Links.loginLinkUrl(token), minutes: WebAuth.LOGIN_TOKEN_TTL_MINUTES }));
  return "done";
}

const COMMANDS = [
  { name: "web_login", match: (text) => (WEB_LOGIN.test(clean(text)) ? {} : null), run: (b, _a, ctx) => sendLoginLink(b, ctx) },
  { name: "price", match: (text) => matchPrice(text), run: (b, a, ctx) => Edits.quickUpdate(b, { action: "price", ...a }, ctx) },
  { name: "status", match: (text) => matchStatus(text), run: (b, a, ctx) => Edits.quickUpdate(b, a, ctx) },
  { name: "edit", match: (text) => matchEdit(text), run: (b, a, ctx) => Edits.startEdit(b, a.code, ctx, { instructions: a.instructions }) },
  {
    name: "edit_done",
    match: (text, state) => (state.editOpen && /^(تم|خلاص|حفظ|مراجعة|done|save|review)$/i.test(clean(text)) ? {} : null),
    run: (b, _a, ctx) => Edits.reviewEdit(b, ctx)
  },
  {
    name: "more",
    match: (text, state) => (state.searchOpen && /^(المزيد|مزيد|كمان|more|next)$/i.test(clean(text)) ? {} : null),
    run: (b, _a, ctx) => ctx.S.handleMore(b, ctx)
  }
];

// Commands a voice transcript may trigger (the rest of a voice note is a search or draft input).
const VOICE_COMMANDS = new Set(["price", "status"]);

async function loadState(pool, brokerId) {
  const { rows } = await pool.query(
    "SELECT session_type FROM broker_sessions WHERE broker_id = $1 AND expires_at > NOW() AND session_type IN ('edit', 'search_state')",
    [brokerId]
  );
  const types = new Set(rows.map((r) => r.session_type));
  return { editOpen: types.has("edit"), searchOpen: types.has("search_state") };
}

/** The matching command for a text, or null. */
function find(text, state = {}, { voice = false } = {}) {
  for (const c of COMMANDS) {
    if (voice && !VOICE_COMMANDS.has(c.name)) continue;
    const args = c.match(text, state);
    if (args) return { command: c, args };
  }
  return null;
}

/** Runs the matching registered command; returns true when one handled the text. */
async function dispatch(broker, text, ctx, opts = {}) {
  const state = await loadState(ctx.pool, broker.id);
  const hit = find(text, state, opts);
  if (!hit) return false;
  await hit.command.run(broker, hit.args, ctx);
  return true;
}

module.exports = { COMMANDS, find, dispatch, matchStatus, matchPrice, matchEdit };
