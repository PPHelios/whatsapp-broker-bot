// services/catalogueUpdates.js — Smart quick updates to the catalogue (Release A, C4), managers only, on the website
// and the bot: one sentence (typed or a voice note) → a preview with the unit count and an example → apply → Undo
// (24 hours, only where nothing changed since). domain/catalogueUpdate.js reads the sentence; the changes go through
// the same writes as the pages (price increases, applyListingPatch, project plans).
"use strict";

const crypto = require("crypto");
const AI = require("../lib/ai");
const Store = require("../lib/listingStore");
const Financials = require("../lib/financials");
const { isManager } = require("../lib/authz");
const U = require("../domain/catalogueUpdate");
const Stages = require("../domain/leadStages");
const Commission = require("../domain/commission");
const Catalogue = require("./catalogue");
const PriceSheets = require("./priceSheets");
const Vis = require("../lib/visibility");

const UNDO_HOURS = 24;
const PREVIEW_HOURS = 24;
const MAX_INPUT = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => UUID_RE.test(String(v || ""));
const cairoDay = (now) => Stages.toCairoLocal(now).slice(0, 10);
const bad = (error, extra = {}) => ({ error, ...extra });

/** A voice note → its words (counted as a voice note against the allowance). */
async function transcribe(voice, ctx) {
  return String((await AI.transcribeAudio(voice.buffer, voice.mimeType, ctx)) || "").trim();
}

/** The sentence → { action, ... } by rules, else one AI call; null when it is not a catalogue change. */
async function read(text, { projects, today, lang, ctx }) {
  const ruled = U.parseRules(text, today);
  if (ruled) return ruled;
  const fence = crypto.randomBytes(4).toString("hex").toUpperCase();
  const res = await AI.generateWithCascade({
    contents: [{ role: "user", parts: [{ text: U.buildPrompt(lang, fence, { projects, today }) }, { text: `${text}\n===${fence}===` }] }],
    config: { temperature: 0.1, responseMimeType: "application/json" },
    operationType: "catalogue_update",
    ctx
  });
  let out = null;
  try {
    out = JSON.parse(String(res.text || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
  } catch {
    return null;
  }
  const n = U.normalizeAi(out, today);
  return n ? { ...n, words: U.clean(text) } : null;
}

const UNIT_COLS = "id, code, developer_unit_code, status, price_value, project_id, phase_id, broker_id, agency_id, details, version, inventory_type, listing_type";

/** Units named by agency code, or by developer code inside the catalogue (one project, or the one project that has it). */
async function unitsByCode(db, actor, codes, projectId) {
  const { rows } = await db.query(
    `SELECT ${UNIT_COLS}, upper(code) AS c1, upper(btrim(developer_unit_code)) AS c2 FROM listings
      WHERE ${Vis.units("listings")} AND agency_id = $1 AND status IN ('active', 'sold')
        AND (upper(code) = ANY($2::text[])
             OR (details->>'catalogue' = 'true' AND upper(btrim(developer_unit_code)) = ANY($2::text[]) AND ($3::uuid IS NULL OR project_id = $3)))`,
    [actor.agency_id, codes, projectId]
  );
  const found = [];
  const missing = [];
  const ambiguous = [];
  for (const c of codes) {
    const own = rows.filter((r) => r.c1 === c);
    const dev = rows.filter((r) => r.c2 === c);
    const hit = own.length ? own : dev;
    if (!hit.length) missing.push(c);
    else if (hit.length > 1) ambiguous.push(c);
    else if (!found.some((f) => f.id === hit[0].id)) found.push(hit[0]);
  }
  return { found, missing, ambiguous };
}

/** Active priced catalogue units an increase would move (the same rule as PriceSheets.applyIncrease). */
async function increaseUnits(db, projectId, phaseId) {
  const { rows } = await db.query(
    `SELECT ${UNIT_COLS} FROM listings WHERE ${Vis.units("listings")} AND project_id = $1 AND status = 'active' AND price_value > 0 AND details->>'catalogue' = 'true'
       AND ($2::uuid IS NULL OR phase_id = $2) ORDER BY code`,
    [projectId, phaseId]
  );
  return rows;
}

/**
 * Reads one sentence (or voice note) into a preview: { ok, update } or { error } — forbidden, empty, not_understood,
 * quota, no_project, no_units, codes (missing / ambiguous), invalid (field).
 */
async function interpret(pool, actor, { text = "", voice = null, channel = "web", now = new Date(), lang = "ar" } = {}) {
  if (!isManager(actor)) return bad("forbidden");
  const ctx = { pool, broker: actor, lang };
  let words = String(text || "").trim();
  try {
    if (!words && voice) words = await transcribe(voice, ctx);
  } catch (err) {
    return bad(/QUOTA/.test(err.code || "") ? "quota" : "not_understood");
  }
  words = words.slice(0, MAX_INPUT);
  if (!words) return bad("empty");
  const today = cairoDay(now);
  const projects = await Catalogue.listProjects(pool, actor);
  let said;
  try {
    said = await read(words, { projects, today, lang, ctx });
  } catch (err) {
    return bad(/QUOTA/.test(err.code || "") ? "quota" : "not_understood", { input: words });
  }
  if (!said) return bad("not_understood", { input: words });

  const project = (said.project && U.findNamed(said.project, projects)) || U.findNamed(words, projects);
  let phase = null;
  if (project) {
    const { rows: phases } = await pool.query("SELECT id, name FROM project_phases WHERE project_id = $1", [project.id]);
    phase = (said.phase && U.findNamed(said.phase, phases, ["name"])) || U.findNamed(words, phases, ["name"]);
  }
  const base = { input: words, action: said.action, project, phase };
  let built;
  if (said.action === "increase") built = await buildIncrease(pool, base, said, today);
  else if (said.action === "plan") built = await buildPlan(pool, base, said);
  else built = await buildUnits(pool, actor, base, said);
  if (built.error) return { ...built, input: words };

  const { rows } = await pool.query(
    `INSERT INTO catalogue_updates (agency_id, created_by, channel, input, action, project_id, payload, units, example)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) RETURNING *`,
    [actor.agency_id, actor.id, channel === "bot" ? "bot" : "web", words, said.action, project?.id || null, JSON.stringify(built.payload), built.units, JSON.stringify(built.example || null)]
  );
  return { ok: true, update: decorate(rows[0], project, phase) };
}

async function buildIncrease(pool, { project, phase }, said, today) {
  if (!project) return bad("no_project");
  const pct = Number(said.pct);
  if (!Number.isFinite(pct) || pct === 0 || pct > 100 || pct < -50) return bad("invalid", { field: "pct" });
  const effectiveOn = said.effective_on || today;
  const units = await increaseUnits(pool, project.id, phase?.id || null);
  if (!units.length) return bad("no_units");
  const u = units[0];
  const after = U.round1000(Number(u.price_value) * (1 + pct / 100));
  return {
    units: units.length,
    payload: { pct, effective_on: effectiveOn, date_given: Boolean(said.effective_on), phase_id: phase?.id || null, phase_name: phase?.name || null, now: effectiveOn <= today },
    example: { code: u.code, dev_code: u.developer_unit_code, before: Number(u.price_value), after }
  };
}

async function buildPlan(pool, { project, phase }, said) {
  if (!project) return bad("no_project");
  const p = said.plan || {};
  const v = Catalogue.planFields({ name: p.name || U.planName(p), down_payment_pct: p.down_payment_pct, years: p.years, frequency: p.frequency || "quarterly" });
  if (v.error) return v;
  const { rows } = await pool.query(
    `SELECT code, price_value FROM listings WHERE ${Vis.units("listings")} AND project_id = $1 AND status = 'active' AND NOT COALESCE((payment_terms->>'plans_own')::boolean, false)
       AND ($2::uuid IS NULL OR phase_id = $2) ORDER BY price_value IS NULL, code`,
    [project.id, phase?.id || null]
  );
  const priced = rows.find((r) => Number(r.price_value) > 0);
  const s = priced ? Financials.calculatePlanSummary(Number(priced.price_value), { ...v.fields, maintenance_pct: null }) : null;
  return {
    units: rows.length,
    payload: { plan: v.fields, phase_id: phase?.id || null, phase_name: phase?.name || null },
    example: s ? { code: priced.code, price: Number(priced.price_value), down_payment: s.down_payment, installments: s.total_installments_count, installment: s.installment_amount } : null
  };
}

async function buildUnits(pool, actor, { project }, said) {
  const codes = said.codes || [];
  if (!codes.length) return bad("codes", { missing: [], ambiguous: [] });
  const { found, missing, ambiguous } = await unitsByCode(pool, actor, codes, project?.id || null);
  if (ambiguous.length || !found.length) return bad("codes", { missing, ambiguous });
  if (said.action === "price") {
    const price = Number(said.price);
    if (!(price > 0) || price > 1e10) return bad("invalid", { field: "price" });
    const u = found[0];
    return { units: 1, payload: { price, unit_ids: [u.id], missing }, example: { code: u.code, dev_code: u.developer_unit_code, before: Number(u.price_value) || null, after: price } };
  }
  const status = said.status === "active" ? "active" : said.status === "sold" ? "sold" : null;
  if (!status) return bad("not_understood");
  const change = found.filter((u) => u.status !== status);
  if (!change.length) return bad("no_units", { same: found.map((u) => u.code) });
  const u = change[0];
  return { units: change.length, payload: { status, unit_ids: change.map((x) => x.id), codes: change.map((x) => x.code), missing }, example: { code: u.code, dev_code: u.developer_unit_code, before: u.status, after: status } };
}

/** The row plus the project's and phase's names, for the card. */
function decorate(row, project = null, phase = null) {
  return { ...row, project_name: row.project_name || project?.name || null, phase_name: row.payload?.phase_name || phase?.name || null };
}

async function getUpdate(db, actor, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query(
    `SELECT u.*, p.name AS project_name, b.name AS created_by_name FROM catalogue_updates u LEFT JOIN projects p ON p.id = u.project_id
       LEFT JOIN brokers b ON b.id = u.created_by WHERE u.id = $1 AND u.agency_id = $2`,
    [id, actor.agency_id]
  );
  return rows[0] ? decorate(rows[0]) : null;
}

async function listUpdates(db, actor, { limit = 20 } = {}) {
  const { rows } = await db.query(
    `SELECT u.*, p.name AS project_name, b.name AS created_by_name FROM catalogue_updates u LEFT JOIN projects p ON p.id = u.project_id
       LEFT JOIN brokers b ON b.id = u.created_by WHERE u.agency_id = $1 AND u.status <> 'discarded' ORDER BY u.created_at DESC LIMIT $2`,
    [actor.agency_id, limit]
  );
  return rows.map((r) => decorate(r));
}

const canUndo = (u, now = new Date()) => u.status === "applied" && u.applied_at && now - new Date(u.applied_at) < UNDO_HOURS * 3600 * 1000;

/** Applies a preview (once). { ok, update, changed } | { error } */
async function apply(pool, actor, id, { now = new Date() } = {}) {
  if (!isManager(actor)) return bad("forbidden");
  if (!isId(id)) return bad("not_found");
  const { rows } = await pool.query(
    `UPDATE catalogue_updates SET status = 'applied', applied_at = $3 WHERE id = $1 AND agency_id = $2 AND status = 'preview'
       AND created_at > $3::timestamptz - make_interval(hours => $4) RETURNING *`,
    [id, actor.agency_id, now.toISOString(), PREVIEW_HOURS]
  );
  const u = rows[0];
  if (!u) return bad("not_found");
  try {
    const { undo, changed } = await run(pool, actor, u, now);
    await pool.query("UPDATE catalogue_updates SET undo = $2::jsonb WHERE id = $1", [u.id, JSON.stringify(undo)]);
    return { ok: true, update: await getUpdate(pool, actor, u.id), changed };
  } catch (err) {
    await pool.query("UPDATE catalogue_updates SET status = 'preview', applied_at = NULL WHERE id = $1", [u.id]);
    if (err.userError) return bad(err.userError);
    throw err;
  }
}

async function run(pool, actor, u, now) {
  const p = u.payload || {};
  if (u.action === "increase") {
    const before = await increaseUnits(pool, u.project_id, p.phase_id);
    const r = await PriceSheets.scheduleIncrease(pool, actor, u.project_id, { pct: String(p.pct), effectiveOn: p.effective_on, phaseId: p.phase_id, now });
    if (r.error) throw Object.assign(new Error(r.error), { userError: r.error === "forbidden" ? "forbidden" : "invalid" });
    let prices = [];
    if (r.applied) {
      const { rows } = await pool.query("SELECT id, price_value FROM listings WHERE " + Vis.units("listings") + " AND id = ANY($1::uuid[])", [before.map((x) => x.id)]);
      const after = new Map(rows.map((x) => [x.id, Number(x.price_value)]));
      prices = before.map((x) => ({ id: x.id, before: Number(x.price_value), after: after.get(x.id) })).filter((x) => x.after !== x.before);
    }
    return { undo: { increase_id: r.increase.id, prices }, changed: r.applied ? r.applied.units : 0 };
  }
  if (u.action === "plan") {
    const r = await Catalogue.savePlan(pool, actor, u.project_id, { ...p.plan, phase_id: p.phase_id || null, milestone_pct: [], fee_label: [] });
    if (r.error) throw Object.assign(new Error(r.error), { userError: "invalid" });
    return { undo: { plan_id: r.plan.id }, changed: u.units };
  }
  const field = u.action === "price" ? "price_value" : "status";
  const target = u.action === "price" ? p.price : p.status;
  const entries = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const id of p.unit_ids || []) {
      const { rows } = await client.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND id = $1 AND agency_id = $2 FOR UPDATE", [id, actor.agency_id]);
      const listing = rows[0];
      if (!listing || String(listing[field]) === String(target)) continue;
      const res = await Store.applyListingPatch(client, actor, { listing, patch: { [field]: target }, priceSource: "quick" });
      if (res.listing) entries.push({ id, before: field === "price_value" ? Number(listing.price_value) || null : listing.status, after: target });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { undo: { field, entries }, changed: entries.length };
}

/** Undoes an applied change within 24 hours; units changed again since are left alone. { ok, restored, skipped } | { error } */
async function undo(pool, actor, id, { now = new Date() } = {}) {
  if (!isManager(actor)) return bad("forbidden");
  if (!isId(id)) return bad("not_found");
  const { rows } = await pool.query(
    `UPDATE catalogue_updates SET status = 'undone', undone_at = $3 WHERE id = $1 AND agency_id = $2 AND status = 'applied'
       AND applied_at > $3::timestamptz - make_interval(hours => $4) RETURNING *`,
    [id, actor.agency_id, now.toISOString(), UNDO_HOURS]
  );
  const u = rows[0];
  if (!u) return bad("too_late");
  const d = u.undo || {};
  let restored = 0;
  let skipped = 0;
  if (u.action === "increase") {
    await pool.query("UPDATE price_increases SET status = 'cancelled' WHERE id = $1 AND agency_id = $2 AND status IN ('scheduled', 'applied')", [d.increase_id, actor.agency_id]);
    const out = await restore(pool, actor, "price_value", d.prices || []);
    restored = out.restored;
    skipped = out.skipped;
  } else if (u.action === "plan") {
    const r = await Catalogue.deletePlan(pool, actor, u.project_id, d.plan_id);
    restored = r.ok ? u.units : 0;
  } else {
    const out = await restore(pool, actor, d.field, d.entries || []);
    restored = out.restored;
    skipped = out.skipped;
  }
  return { ok: true, restored, skipped };
}

async function restore(pool, actor, field, entries) {
  let restored = 0;
  let skipped = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      const { rows } = await client.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND id = $1 AND agency_id = $2 FOR UPDATE", [e.id, actor.agency_id]);
      const listing = rows[0];
      const now = listing ? (field === "price_value" ? Number(listing.price_value) : listing.status) : null;
      if (!listing || String(now) !== String(e.after) || e.before === null) {
        skipped++;
        continue;
      }
      const res = await Store.applyListingPatch(client, actor, { listing, patch: { [field]: e.before }, priceSource: "quick" });
      if (res.listing) restored++;
      else skipped++;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { restored, skipped };
}

async function discard(pool, actor, id) {
  if (!isManager(actor)) return bad("forbidden");
  if (!isId(id)) return bad("not_found");
  const { rowCount } = await pool.query("UPDATE catalogue_updates SET status = 'discarded' WHERE id = $1 AND agency_id = $2 AND status = 'preview'", [id, actor.agency_id]);
  return rowCount ? { ok: true } : bad("not_found");
}

/* ---------------------------------------------------------------------- */
/* The card (website and bot share the words)                              */
/* ---------------------------------------------------------------------- */

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const money = (n, lang) => Commission.money(n, lang);
const STATUS_WORD = { sold: ["مباعة", "sold"], active: ["متاحة", "available"] };
const FREQ = { monthly: ["شهري", "monthly"], quarterly: ["ربع سنوي", "quarterly"], semi_annual: ["نص سنوي", "semi-annual"], annual: ["سنوي", "annual"] };

/** { title, lines } for one update (plain text; the web page and the bot card escape and lay them out). */
function card(u, lang = "ar") {
  const p = u.payload || {};
  const where = `${u.project_name || "—"}${u.phase_name ? ` · ${u.phase_name}` : ""}`;
  const ex = u.example || {};
  const code = ex.code ? `${ex.code}${ex.dev_code && ex.dev_code !== ex.code ? ` (${ex.dev_code})` : ""}` : "";
  const lines = [];
  let title;
  if (u.action === "increase") {
    const up = p.pct > 0;
    title = `${up ? "📈" : "📉"} ${L(lang, up ? `زيادة ${p.pct}%` : `تخفيض ${-p.pct}%`, up ? `+${p.pct}% increase` : `${p.pct}% cut`)} · ${where}`;
    lines.push(`📅 ${L(lang, "من", "From")} ${p.effective_on}${p.date_given ? "" : L(lang, " (مفيش تاريخ في الرسالة، فهتتطبق من النهارده)", " (no date was said, so from today)")}`);
    lines.push(`🏠 ${L(lang, `${u.units} وحدة متاحة في الكتالوج`, `${u.units} available catalogue units`)}`);
    if (code) lines.push(`${L(lang, "مثال", "Example")}: ${code} ${money(ex.before, lang)} → ${money(ex.after, lang)}`);
  } else if (u.action === "plan") {
    const plan = p.plan || {};
    title = `🗓️ ${L(lang, "خطة جديدة", "New plan")} «${plan.name}» · ${where}`;
    lines.push(`${plan.down_payment_pct}% ${L(lang, "مقدم", "down")} · ${plan.years} ${L(lang, "سنين", "years")} · ${L(lang, ...(FREQ[plan.frequency] || FREQ.quarterly))}`);
    lines.push(`🏠 ${L(lang, `هتظهر على ${u.units} وحدة`, `Added to ${u.units} units`)}`);
    if (code) lines.push(`${L(lang, "مثال", "Example")}: ${code} ${money(ex.price, lang)}: ${L(lang, "مقدم", "down")} ${money(ex.down_payment, lang)}، ${ex.installments} × ${money(ex.installment, lang)}`);
  } else if (u.action === "price") {
    title = `🏷️ ${L(lang, "سعر جديد", "New price")} · ${code}`;
    lines.push(`${ex.before ? money(ex.before, lang) : "—"} → ${money(ex.after, lang)}`);
  } else {
    const w = STATUS_WORD[p.status] || STATUS_WORD.sold;
    title = `${p.status === "sold" ? "🔴" : "🟢"} ${L(lang, `تتعلم ${w[0]}`, `Mark ${w[1]}`)}: ${(p.codes || []).join("، ")}`;
    lines.push(`🏠 ${L(lang, `${u.units} وحدة`, `${u.units} units`)}`);
  }
  if ((p.missing || []).length) lines.push(`⚠️ ${L(lang, "مش لاقيين", "Not found")}: ${p.missing.join("، ")}`);
  return { title, lines };
}

/** The words for an error from interpret(). */
function errorText(out, lang = "ar") {
  switch (out.error) {
    case "forbidden":
      return L(lang, "⛔ التحديثات السريعة للكتالوج للمديرين بس.", "⛔ Quick catalogue updates are for managers only.");
    case "empty":
      return L(lang, "اكتب أو سجّل التحديث الأول.", "Type or record the update first.");
    case "quota":
      return L(lang, "⛔ حد الذكاء الاصطناعي خلص (حد اليوم أو رصيد الباقة).", "⛔ The AI limit was reached (today's limit or your plan's allowance).");
    case "no_project":
      return L(lang, "🏗️ مش عارفين أنهي مشروع. اكتب اسم المشروع زي ما هو في الكتالوج.", "🏗️ Which project? Write its name as it is in the catalogue.");
    case "no_units":
      return out.same?.length
        ? L(lang, `مفيش تغيير: ${out.same.join("، ")} كده كده على الحالة دي.`, `Nothing to change: ${out.same.join(", ")} already ${out.same.length > 1 ? "are" : "is"} like that.`)
        : L(lang, "مفيش وحدات في الكتالوج يطبق عليها التحديث ده.", "No catalogue units this update applies to.");
    case "codes":
      if (out.ambiguous?.length) return L(lang, `الكود ${out.ambiguous.join("، ")} موجود في أكتر من مشروع. اكتب اسم المشروع.`, `${out.ambiguous.join(", ")} is in more than one project. Add the project's name.`);
      return out.missing?.length ? L(lang, `مش لاقيين: ${out.missing.join("، ")}`, `Not found: ${out.missing.join(", ")}`) : L(lang, "اكتب كود الوحدة.", "Write the unit code.");
    case "invalid":
      return L(lang, "في رقم مش مظبوط (النسبة من -50 لـ 100، والسعر أكبر من صفر).", "A number is off (the % must be -50 to 100, the price above zero).");
    case "too_late":
      return L(lang, "مينفعش التراجع: عدى أكتر من 24 ساعة أو اتلغى قبل كده.", "Can't undo: over 24 hours have passed or it was already undone.");
    case "not_found":
      return L(lang, "التحديث ده مش موجود أو اتطبق أو اتلغى.", "This update is gone, applied or discarded.");
    default:
      return L(
        lang,
        "مفهمتش التحديث. أمثلة: «زيادة 7% على بادية من الشهر الجاي»، «B12-304 اتباعت»، «خطة جديدة 5% مقدم 8 سنين على بادية»، «سعر B12-304 9.5 مليون».",
        "I didn't get that update. Examples: \"7% increase on Badya from next month\", \"B12-304 sold\", \"new plan 5% down 8 years on Badya\", \"price B12-304 9.5M\"."
      );
  }
}

module.exports = { UNDO_HOURS, interpret, apply, undo, discard, getUpdate, listUpdates, canUndo, card, errorText };
