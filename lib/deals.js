// lib/deals.js — Deals on WhatsApp (Release 3 step 10): «صفقة L-0042 VIL-08 8.5 مليون عمولة 2%» /
// `deal L-0042 VIL-08 8.5M commission 2% split 60/40` → a review card → [✅ Confirm] [✏️ Edit] [❌ Cancel]. A missing
// commission asks for it (amount or %). Recording a deal can't be undone, so it is confirmed first; the deal waits
// server-side and the buttons carry only its nonce (a double tap saves once).
"use strict";

const crypto = require("crypto");
const Deals = require("../services/deals");
const Commission = require("../domain/commission");
const Card = require("../domain/leadCard");
const T = require("./text");
const Links = require("./links");
const { t } = require("./copy");
const { reply, replyButtons, setTurnAction } = require("./dispatcher");
const Vis = require("../lib/visibility");

const SESSION_MINUTES = 30;
const DEAL = /^(?:صفقة|صفقه|deal)(?:\s+(.*))?$/i;
const COMMISSION = /(?:عمولة|عموله|العمولة|commission|comm)\s*:?\s*/i;
const EXTERNAL = /(?:خارجي|وسيط خارجي|external|co-?broker)\s*:?\s*/i;
const SPLIT = /(?:تقسيم|قسمة|split)\s*:?\s*/i;
const WITH = /(?:\s|^)(?:مع|with)\s+(.+)$/i;
const CANCEL = /^(cancel|إلغاء|الغاء|خروج|abort|exit)$/i;
const KEYWORDS = new RegExp(`${COMMISSION.source}|${EXTERNAL.source}|${SPLIT.source}`, "gi");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (ctx) => (ctx.lang === "en" ? "en" : "ar");
const toLatin = (s) => String(s || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/٫/g, ".");
const money = (n, lang) => Commission.money(n, lang);

/** Amount or percentage: "2%" → pct, "170 ألف" / "170k" → amount. */
function parseCommission(text) {
  const pct = Commission.parsePct(text);
  if (pct) return pct;
  const p = T.parseEgyptianPrice(T.normalizeDigits(String(text || "")));
  return p?.priceValue > 0 ? { mode: "amount", amount: p.priceValue } : null;
}

/** Splits the text into the part before the first keyword and each keyword's part. */
function sections(rest) {
  const out = { head: rest, commission: null, external: null, split: null };
  const marks = [];
  for (const [key, re] of [["commission", COMMISSION], ["external", EXTERNAL], ["split", SPLIT]]) {
    const m = rest.match(re);
    if (m) marks.push({ key, at: m.index, end: m.index + m[0].length });
  }
  marks.sort((a, b) => a.at - b.at);
  if (marks.length) out.head = rest.slice(0, marks[0].at);
  marks.forEach((m, i) => {
    out[m.key] = rest.slice(m.end, i + 1 < marks.length ? marks[i + 1].at : rest.length).trim();
  });
  return out;
}

/**
 * «صفقة L-0042 VIL-08 8.5 مليون عمولة 2% خارجي 10% تقسيم 60/40 مع عمر» → the parts as typed.
 * @returns {null | { leadRef, unitCode, price, commission, external, split, splitWith }}
 */
function parseDealCommand(text) {
  const m = toLatin(String(text || "").trim()).replace(/\s+/g, " ").match(DEAL);
  if (!m) return null;
  const rest = (m[1] || "").trim();
  const s = sections(rest);
  const ref = s.head.match(/(?:^|\s)[Ll]-?(\d{1,6})(?=\s|$)/);
  let head = ref ? s.head.replace(ref[0], " ") : s.head;
  const code = head.match(/(?:^|\s)([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)(?=\s|$)/);
  if (code) head = head.replace(code[0], " ");
  const priceText = head.trim();
  const price = priceText ? T.parseEgyptianPrice(T.normalizeDigits(priceText))?.priceValue || null : null;
  let split = null;
  let splitWith = null;
  if (s.split) {
    const w = s.split.match(WITH);
    splitWith = w ? w[1].trim() : null;
    split = Commission.parseSplit(w ? s.split.slice(0, w.index) : s.split);
  }
  let external = null;
  if (s.external) {
    const pct = Commission.parsePct(s.external);
    const amount = pct ? null : T.parseEgyptianPrice(T.normalizeDigits(s.external))?.priceValue || null;
    if (pct) external = { pct: pct.pct };
    else if (amount) external = { amount };
  }
  return {
    leadRef: ref ? Number(ref[1]) : null,
    unitCode: code ? code[1].toUpperCase() : null,
    price,
    commission: s.commission ? parseCommission(s.commission) : null,
    external,
    split,
    splitWith,
    splitText: s.split
  };
}

/* ---------------------------------------------------------------------- */
/* Sessions: deal_draft (waiting for the commission) and pending_deal       */
/* ---------------------------------------------------------------------- */

async function setSession(pool, broker, type, data) {
  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1::uuid, $2, $3::jsonb, NOW() + ($4 || ' minutes')::interval)
     ON CONFLICT (broker_id, session_type) DO UPDATE SET session_data = EXCLUDED.session_data, expires_at = EXCLUDED.expires_at`,
    [broker.id, type, JSON.stringify(data), String(SESSION_MINUTES)]
  );
}
async function getSession(pool, broker, type) {
  const { rows } = await pool.query("SELECT session_data FROM broker_sessions WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()", [broker.id, type]);
  return rows[0]?.session_data || null;
}
const clearSession = (pool, broker, type) => pool.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2", [broker.id, type]);

/** The split's colleague: the one named, else the unit's broker when it isn't the closer. */
async function splitColleague(pool, broker, parsed) {
  if (parsed.splitWith) {
    const { rows } = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active AND id <> $2 AND name ILIKE $3 ORDER BY name LIMIT 2", [
      broker.agency_id,
      broker.id,
      `%${parsed.splitWith.replace(/[%_]/g, "")}%`
    ]);
    return rows.length === 1 ? rows[0] : null;
  }
  if (!parsed.unitCode) return null;
  const { rows } = await pool.query(
    "SELECT b.id, b.name FROM listings l JOIN brokers b ON b.id = l.broker_id AND b.agency_id = l.agency_id WHERE " + Vis.units("l") + " AND l.agency_id = $1 AND l.code_norm = upper($2) AND b.id <> $3 AND b.is_active",
    [broker.agency_id, parsed.unitCode, broker.id]
  );
  return rows[0] || null;
}

const WHY = {
  lead_not_found: ["العميل ده مش معاك أو مش موجود", "that lead isn't yours or doesn't exist"],
  forbidden: ["مش مسموح", "not allowed"],
  unit_not_found: ["كود الوحدة مش موجود", "unit code not found"],
  unit_not_active: ["الوحدة مش متاحة", "the unit isn't active"],
  price: ["السعر ناقص أو غلط", "the price is missing or wrong"],
  commission_pct: ["نسبة العمولة لازم تبقى بين 0 و 100", "the commission % must be between 0 and 100"],
  commission_amount: ["مبلغ العمولة غلط", "the commission amount is wrong"],
  commission_over_price: ["العمولة أكبر من السعر", "the commission is more than the price"],
  external_over_total: ["نصيب الوسيط الخارجي أكبر من العمولة", "the external share is more than the commission"],
  external_pct: ["نسبة الوسيط الخارجي غلط", "the external % is wrong"],
  split_pct: ["التقسيم لازم يبقى زي 60/40", "the split must look like 60/40"],
  split_total: ["التقسيم لازم يتجمع 100", "the split must add up to 100"],
  split_who: ["مش عارف هتقسم مع مين؛ اكتب «تقسيم 60/40 مع اسم الزميل»", "who is the split with? Write \"split 60/40 with <colleague>\""],
  broker_not_found: ["الزميل مش موجود", "colleague not found"],
  unit_not_yours: ["الوحدة مش بتاعتك فمش هتتعلم اتباعت", "the unit isn't yours, so it can't be marked sold"],
  unit_conflict: ["الوحدة اتعدلت من مكان تاني؛ الصفقة متسجلتش. ابعتها تاني", "the unit changed elsewhere; the deal wasn't saved. Send it again"]
};
const why = (code, lang) => (WHY[code] || [code, code])[lang === "en" ? 1 : 0];

/** The review card's lines. */
function reviewLines(d, lang) {
  const en = lang === "en";
  const lines = [`👤 ${Card.displayName({ name: d.leadName, ref: d.leadRef }, lang)} · ${Card.refLabel(d.leadRef)}`];
  if (d.unitCode) lines.push(`🏠 ${d.unitCode} · ${d.dealType === "rent" ? L(lang, "إيجار", "Rent") : L(lang, "بيع", "Sale")}`);
  lines.push(`💰 ${L(lang, "السعر", "Price")}: ${money(d.price, lang)}`);
  lines.push(`💼 ${L(lang, "العمولة", "Commission")}: ${d.mode === "pct" ? `${d.pct}% = ` : ""}${money(d.total, lang)}`);
  if (d.external) lines.push(`🤝 ${L(lang, "وسيط خارجي", "External co-broker")}: ${money(d.external, lang)}`);
  lines.push(`👥 ${d.shares.map((s) => `${s.name} ${s.pct}% = ${money(s.amount, lang)}`).join(" · ")}`);
  if (d.markSold) lines.push(en ? `✅ ${d.unitCode} will be marked sold · the lead → ✅ Won` : `✅ ${d.unitCode} هتتعلم اتباعت · العميل ← ✅ اتقفلت`);
  else if (d.unitCode) lines.push(en ? `ℹ️ ${d.unitCode} stays as it is (not yours or not active) · the lead → ✅ Won` : `ℹ️ ${d.unitCode} هتفضل زي ما هي (مش بتاعتك أو مش متاحة) · العميل ← ✅ اتقفلت`);
  else lines.push(en ? "the lead → ✅ Won" : "العميل ← ✅ اتقفلت");
  return lines.join("\n");
}

/** Parsed command → input for services/deals.js; a missing commission waits for it. */
async function review(broker, parsed, ctx) {
  const lang = langOf(ctx);
  const { pool } = ctx;
  setTurnAction("crm");
  if (!parsed.leadRef) return reply(broker, t("deal_usage", lang));
  if (!parsed.commission) {
    await setSession(pool, broker, "deal_draft", { parsed });
    return reply(broker, t("deal_need_commission", lang));
  }
  const splits = [];
  if (parsed.splitText) {
    if (!parsed.split) return reply(broker, t("deal_invalid", lang, { why: why("split_total", lang) }));
    const colleague = await splitColleague(pool, broker, parsed);
    if (!colleague) return reply(broker, t("deal_invalid", lang, { why: why("split_who", lang) }));
    splits.push({ brokerId: colleague.id, pct: parsed.split[1] });
  }
  const input = { leadKey: parsed.leadRef, unitCode: parsed.unitCode, price: parsed.price, ...parsed.commission, external: parsed.external, splits };
  const prep = await Deals.prepare(pool, broker, input);
  if (prep.error) return reply(broker, t("deal_invalid", lang, { why: why(prep.error, lang) }));
  await clearSession(pool, broker, "deal_draft");
  const nonce = crypto.randomBytes(4).toString("hex");
  await setSession(pool, broker, "pending_deal", { nonce, input, unitVersion: prep.draft.unitVersion });
  return replyButtons(broker, t("deal_review", lang, { lines: reviewLines(prep.draft, lang) }), [
    { id: `dl:ok:${nonce}`, title: L(lang, "✅ تأكيد", "✅ Confirm") },
    { id: `dl:edit:${nonce}`, title: L(lang, "✏️ تعديل", "✏️ Edit") },
    { id: `dl:no:${nonce}`, title: L(lang, "❌ إلغاء", "❌ Cancel") }
  ]);
}

/** «صفقة …» / `deal …` (lib/registry.js). */
async function dealCommand(broker, { text }, ctx) {
  await review(broker, parseDealCommand(text), ctx);
  return "done";
}

/** The next message while the deal waits for its commission. */
async function collect(broker, text, ctx) {
  const d = await getSession(ctx.pool, broker, "deal_draft");
  if (!d) return false;
  const clean = toLatin(String(text || "").trim());
  if (!clean) return false;
  if (CANCEL.test(clean)) {
    await clearSession(ctx.pool, broker, "deal_draft");
    return false;
  }
  if (DEAL.test(clean) || require("./registry").find(clean, {})) {
    await clearSession(ctx.pool, broker, "deal_draft");
    return false;
  }
  const commission = parseCommission(clean.replace(COMMISSION, ""));
  setTurnAction("crm");
  if (!commission) {
    await reply(broker, t("deal_need_commission", langOf(ctx)));
    return true;
  }
  await review(broker, { ...d.parsed, commission }, ctx);
  return true;
}

/** dl:* buttons. Returns false for other ids. */
async function handleButton(broker, id, ctx) {
  if (!String(id).startsWith("dl:")) return false;
  const lang = langOf(ctx);
  const { pool } = ctx;
  setTurnAction("crm");
  const [, action, nonce] = String(id).split(":");
  const p = await getSession(pool, broker, "pending_deal");
  if (!p || p.nonce !== nonce) {
    // A second tap on Confirm finds the deal the first one saved.
    const done = action === "ok" ? await pool.query("SELECT ref FROM deals WHERE agency_id = $1 AND idem_key = $2", [broker.agency_id, `wa:${broker.id}:${nonce}`]) : { rows: [] };
    await reply(broker, done.rows[0] ? t("deal_saved_already", lang, { ref: Deals.refLabel(done.rows[0].ref) }) : t("deal_expired", lang));
    return true;
  }
  if (action === "no") {
    await clearSession(pool, broker, "pending_deal");
    await reply(broker, t("deal_cancelled", lang));
    return true;
  }
  if (action === "edit") {
    await clearSession(pool, broker, "pending_deal");
    const ref = Card.refLabel(p.input.leadKey);
    await reply(broker, t("deal_edit", lang, { url: Links.appUrl("deals/new", { lead: ref, unit: p.input.unitCode || "" }) }));
    return true;
  }
  if (action !== "ok") {
    await reply(broker, t("deal_expired", lang));
    return true;
  }
  const r = await Deals.createDeal(pool, broker, p.input, { idemKey: `wa:${broker.id}:${nonce}`, unitVersion: p.unitVersion });
  await clearSession(pool, broker, "pending_deal");
  if (r.error) {
    await reply(broker, t("deal_invalid", lang, { why: why(r.error, lang) }));
    return true;
  }
  const deal = await Deals.getDeal(pool, broker, r.deal.id);
  const mine = deal?.shares?.find((s) => s.broker_id === broker.id);
  await reply(
    broker,
    t("deal_saved", lang, {
      ref: Deals.refLabel(r.deal.ref),
      total: money(r.deal.commission_total, lang),
      mine: mine ? money(mine.amount, lang) : "—",
      url: Links.appUrl(`deals/${Deals.refLabel(r.deal.ref)}`)
    })
  );
  return true;
}

module.exports = { parseDealCommand, parseCommission, reviewLines, dealCommand, collect, handleButton, DEAL };
