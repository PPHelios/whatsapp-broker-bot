// services/commissions.js — The developer commission tracker (Release A, C8). A deal on a catalogue unit (a project
// with a developer) gets one commission row; managers move it expected → claimable → claimed (invoice number and link,
// due date from the developer's payment days) → paid or partly paid, and see a statement per developer (also as Excel).
// Brokers see only their own share and the commission's state. domain/commissionTracker.js holds the rules.
"use strict";

const ExcelJS = require("exceljs");
const { isManager } = require("../lib/authz");
const C = require("../domain/commissionTracker");
const Stages = require("../domain/leadStages");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => UUID_RE.test(String(v || ""));
const today = (now = new Date()) => Stages.toCairoLocal(now).slice(0, 10);
const httpsOnly = (u) => (/^https?:\/\/[^\s"'<>]+$/.test(String(u || "").trim()) ? String(u).trim().slice(0, 500) : null);

/* ---------------------------------------------------------------------- */
/* Terms per project                                                       */
/* ---------------------------------------------------------------------- */

async function getTerms(db, actor, projectId) {
  if (!isId(projectId)) return null;
  const { rows } = await db.query("SELECT * FROM commission_terms WHERE project_id = $1 AND agency_id = $2", [projectId, actor.agency_id]);
  return rows[0] || null;
}

async function saveTerms(db, actor, projectId, input) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!isId(projectId)) return { error: "not_found" };
  const { rows: p } = await db.query("SELECT id FROM projects WHERE id = $1 AND agency_id = $2", [projectId, actor.agency_id]);
  if (!p[0]) return { error: "not_found" };
  const v = C.termsFields(input);
  if (v.error) return v;
  const f = v.fields;
  const { rows } = await db.query(
    `INSERT INTO commission_terms (project_id, agency_id, mode, pct, amount, tiers, claim_trigger, claim_paid_pct, payment_days, registration_days, notes, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, now())
     ON CONFLICT (project_id) DO UPDATE SET mode = $3, pct = $4, amount = $5, tiers = $6::jsonb, claim_trigger = $7, claim_paid_pct = $8,
       payment_days = $9, registration_days = $10, notes = $11, updated_at = now()
     RETURNING *`,
    [projectId, actor.agency_id, f.mode, f.pct, f.amount, JSON.stringify(f.tiers), f.claim_trigger, f.claim_paid_pct, f.payment_days, f.registration_days, f.notes]
  );
  return { ok: true, terms: rows[0] };
}

/* ---------------------------------------------------------------------- */
/* One commission per developer deal                                       */
/* ---------------------------------------------------------------------- */

/**
 * The commission row of a deal on a catalogue unit (created once; a resale unit linked to a project has none, the
 * developer pays nothing on it). Call inside the deal's transaction or after it.
 */
async function ensureForDeal(db, deal) {
  if (!deal?.listing_id || deal.status === "cancelled") return null;
  const { rows } = await db.query(
    `SELECT l.project_id, p.developer_id, (l.details->>'catalogue' = 'true' OR l.market = 'primary') AS developer_unit
       FROM listings l JOIN projects p ON p.id = l.project_id WHERE l.id = $1 AND l.agency_id = $2`,
    [deal.listing_id, deal.agency_id]
  );
  const unit = rows[0];
  if (!unit?.developer_unit) return null;
  const terms = (await db.query("SELECT * FROM commission_terms WHERE project_id = $1", [unit.project_id])).rows[0] || null;
  const { rows: n } = await db.query(
    `SELECT count(*)::int AS n FROM deals d JOIN listings l ON l.id = d.listing_id
      WHERE d.agency_id = $1 AND l.project_id = $2 AND d.status <> 'cancelled' AND d.closed_at <= $3
        AND date_trunc('year', d.closed_at AT TIME ZONE 'Africa/Cairo') = date_trunc('year', $3::timestamptz AT TIME ZONE 'Africa/Cairo')`,
    [deal.agency_id, unit.project_id, deal.closed_at]
  );
  const e = C.expectedFor(terms, { price: deal.price, unitsThisYear: Math.max(1, n[0].n), dealTotal: deal.commission_total });
  const claimable = terms?.claim_trigger === "contract" && ["signed", "paid"].includes(deal.status);
  const ins = await db.query(
    `INSERT INTO commissions (agency_id, deal_id, project_id, developer_id, rate_pct, expected_amount, status, claimable_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (deal_id) DO NOTHING RETURNING *`,
    [deal.agency_id, deal.id, unit.project_id, unit.developer_id, e.rate_pct, e.expected_amount, claimable ? "claimable" : "expected", claimable ? new Date().toISOString() : null]
  );
  return ins.rows[0] || null;
}

/** A deal changed: cancelled → its commission is cancelled (unless paid); signed + "contract" trigger → claimable. */
async function onDealChanged(db, deal) {
  if (deal.status === "cancelled") {
    await db.query("UPDATE commissions SET status = 'cancelled', updated_at = now(), version = version + 1 WHERE deal_id = $1 AND status IN ('expected', 'claimable', 'claimed')", [deal.id]);
    return;
  }
  const c = (await db.query("SELECT id FROM commissions WHERE deal_id = $1", [deal.id])).rows[0];
  if (!c) {
    await ensureForDeal(db, deal);
    return;
  }
  if (["signed", "paid"].includes(deal.status)) {
    await db.query(
      `UPDATE commissions c SET status = 'claimable', claimable_at = now(), updated_at = now(), version = version + 1
        FROM commission_terms t WHERE c.deal_id = $1 AND c.status = 'expected' AND t.project_id = c.project_id AND t.claim_trigger = 'contract'`,
      [deal.id]
    );
  }
}

/** Deals recorded before the tracker (or before their project was set up) get their row. */
async function syncAgency(db, agencyId) {
  const { rows } = await db.query(
    `SELECT d.* FROM deals d JOIN listings l ON l.id = d.listing_id
      WHERE d.agency_id = $1 AND l.project_id IS NOT NULL AND d.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM commissions c WHERE c.deal_id = d.id) ORDER BY d.closed_at LIMIT 200`,
    [agencyId]
  );
  for (const d of rows) await ensureForDeal(db, d);
  return rows.length;
}

/* ---------------------------------------------------------------------- */
/* Reads                                                                   */
/* ---------------------------------------------------------------------- */

const LIST_SQL = `SELECT c.*, d.ref AS deal_ref, d.unit_code, d.price, d.client_name, d.closed_at, d.status AS deal_status, d.closing_broker_id,
         p.name AS project_name, v.name AS developer_name, b.name AS closing_broker_name,
         (SELECT amount FROM deal_splits s WHERE s.deal_id = d.id AND s.broker_id = $2) AS my_share
    FROM commissions c JOIN deals d ON d.id = c.deal_id
    LEFT JOIN projects p ON p.id = c.project_id LEFT JOIN developers v ON v.id = c.developer_id
    LEFT JOIN brokers b ON b.id = d.closing_broker_id`;

/** Managers: every commission (filters: status, developer, overdue). Brokers: those they share in, with their share. */
async function listCommissions(db, actor, { status = null, developerId = null, overdue = false, now = new Date() } = {}) {
  await syncAgency(db, actor.agency_id);
  const params = [actor.agency_id, actor.id];
  const where = ["c.agency_id = $1"];
  if (!isManager(actor)) where.push("(d.closing_broker_id = $2 OR EXISTS (SELECT 1 FROM deal_splits s WHERE s.deal_id = d.id AND s.broker_id = $2))");
  if (C.STATUSES.includes(status)) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  if (isId(developerId)) {
    params.push(developerId);
    where.push(`c.developer_id = $${params.length}`);
  }
  if (overdue) {
    params.push(today(now));
    where.push(`c.status IN ('claimed', 'partly_paid') AND c.due_on < $${params.length}::date`);
  }
  const { rows } = await db.query(`${LIST_SQL} WHERE ${where.join(" AND ")} ORDER BY c.due_on NULLS LAST, d.closed_at DESC LIMIT 300`, params);
  const day = today(now);
  return rows.map((r) => shape(r, actor, day));
}

function shape(r, actor, day) {
  const out = { ...r, expected_amount: Number(r.expected_amount), paid_amount: Number(r.paid_amount), price: Number(r.price), my_share: r.my_share == null ? null : Number(r.my_share), overdue_days: C.overdueDays(r, day) };
  if (!isManager(actor)) {
    // A broker sees the state and their own share; the developer's amount, invoice and payments stay with managers.
    for (const k of ["expected_amount", "paid_amount", "invoice_no", "invoice_url", "payments", "rate_pct", "notes"]) delete out[k];
  }
  return out;
}

async function getCommission(db, actor, id) {
  if (!isId(id)) return null;
  const { rows } = await db.query(`${LIST_SQL} WHERE c.agency_id = $1 AND c.id = $3`, [actor.agency_id, actor.id, id]);
  const r = rows[0];
  if (!r) return null;
  if (!isManager(actor) && r.closing_broker_id !== actor.id && r.my_share == null) return null;
  return shape(r, actor, today());
}

/** Totals for a set of rows: expected, claimed (not yet paid), paid, outstanding. */
function totals(rows) {
  const open = rows.filter((r) => r.status !== "cancelled");
  const sum = (f) => open.reduce((s, r) => s + f(r), 0);
  return {
    count: open.length,
    expected: sum((r) => r.expected_amount),
    claimed: sum((r) => (["claimed", "partly_paid"].includes(r.status) ? r.expected_amount - r.paid_amount : 0)),
    paid: sum((r) => r.paid_amount),
    outstanding: sum((r) => Math.max(0, r.expected_amount - r.paid_amount)),
    overdue: open.filter((r) => r.overdue_days > 0).length
  };
}

/** A developer's statement: their commissions with totals (managers). */
async function statement(db, actor, developerId, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!isId(developerId)) return { error: "not_found" };
  const { rows: dev } = await db.query("SELECT id, name, name_en FROM developers WHERE id = $1 AND agency_id = $2", [developerId, actor.agency_id]);
  if (!dev[0]) return { error: "not_found" };
  const rows = await listCommissions(db, actor, { developerId, now });
  return { ok: true, developer: dev[0], rows, totals: totals(rows) };
}

const STATUS_WORDS = { expected: ["متوقعة", "Expected"], claimable: ["جاهزة للمطالبة", "Claimable"], claimed: ["اتطالب بيها", "Claimed"], partly_paid: ["اتدفع جزء", "Partly paid"], paid: ["اتدفعت", "Paid"], cancelled: ["اتلغت", "Cancelled"] };
const statusWord = (s, lang) => (STATUS_WORDS[s] || [s, s])[lang === "en" ? 1 : 0];

async function statementWorkbook(st, lang = "ar") {
  const L = (ar, en) => (lang === "en" ? en : ar);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(L("كشف حساب", "Statement"), { views: [{ rightToLeft: lang !== "en" }] });
  ws.addRow([`${L("كشف عمولات", "Commission statement")}: ${st.developer.name}`]);
  ws.addRow([]);
  ws.addRow([L("الصفقة", "Deal"), L("الوحدة", "Unit"), L("المشروع", "Project"), L("العميل", "Client"), L("التاريخ", "Date"), L("السعر", "Price"), L("النسبة", "Rate %"), L("العمولة", "Commission"), L("الحالة", "Status"), L("رقم الفاتورة", "Invoice no."), L("ميعاد الدفع", "Due"), L("المدفوع", "Paid"), L("الباقي", "Outstanding")]).font = { bold: true };
  const safe = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
  for (const r of st.rows) {
    ws.addRow([
      `D-${String(r.deal_ref).padStart(4, "0")}`,
      safe(r.unit_code || ""),
      safe(r.project_name || ""),
      safe(r.client_name || ""),
      Stages.toCairoLocal(new Date(r.closed_at)).slice(0, 10),
      r.price,
      r.rate_pct === null ? "" : Number(r.rate_pct),
      r.expected_amount,
      statusWord(r.status, lang),
      safe(r.invoice_no || ""),
      r.due_on ? C.isoDay(r.due_on) : "",
      r.paid_amount,
      r.status === "cancelled" ? 0 : Math.max(0, r.expected_amount - r.paid_amount)
    ]);
  }
  ws.addRow([]);
  ws.addRow([L("الإجمالي", "Total"), "", "", "", "", "", "", st.totals.expected, "", "", "", st.totals.paid, st.totals.outstanding]).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 16));
  return wb.xlsx.writeBuffer();
}

/* ---------------------------------------------------------------------- */
/* Moves (managers)                                                        */
/* ---------------------------------------------------------------------- */

/**
 * One move on a commission: claimable | claim { invoice_no, invoice_url, claimed_on } | payment { amount, paid_on } |
 * registration { registered_on } | expected { amount } | cancel | reopen. Optimistic lock on version.
 */
async function move(db, actor, id, action, input = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const c = await getCommission(db, actor, id);
  if (!c) return { error: "not_found" };
  if (input.version !== undefined && input.version !== "" && Number(input.version) !== c.version) return { error: "conflict" };
  const day = today(now);
  const dateOf = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !Number.isNaN(Date.parse(v)) ? String(v) : null);
  const set = {};
  if (action === "claimable") {
    if (c.status !== "expected") return { error: "state" };
    Object.assign(set, { status: "claimable", claimable_at: now.toISOString() });
  } else if (action === "claim") {
    if (!["expected", "claimable"].includes(c.status)) return { error: "state" };
    const invoice = String(input.invoice_no || "").trim().slice(0, 60);
    if (!invoice) return { error: "invalid", field: "invoice_no" };
    if (input.invoice_url && !httpsOnly(input.invoice_url)) return { error: "invalid", field: "invoice_url" };
    const claimedOn = dateOf(input.claimed_on) || day;
    const terms = c.project_id ? (await db.query("SELECT payment_days FROM commission_terms WHERE project_id = $1", [c.project_id])).rows[0] : null;
    Object.assign(set, { status: "claimed", claimed_at: `${claimedOn}T09:00:00Z`, invoice_no: invoice, invoice_url: httpsOnly(input.invoice_url), due_on: C.addDays(claimedOn, terms?.payment_days ?? 60) });
  } else if (action === "payment") {
    if (!["claimed", "partly_paid", "claimable", "expected"].includes(c.status)) return { error: "state" };
    const amount = C.num(input.amount);
    if (amount === null || Number.isNaN(amount) || amount <= 0 || amount > 1e10) return { error: "invalid", field: "amount" };
    const paidOn = dateOf(input.paid_on) || day;
    const payments = [...(c.payments || []), { amount: Math.round(amount), on: paidOn, by: actor.id }];
    const paid = payments.reduce((s, p) => s + Number(p.amount), 0);
    const status = C.statusAfterPayment(c.expected_amount, paid);
    Object.assign(set, { payments: JSON.stringify(payments), paid_amount: paid, status, paid_at: status === "paid" ? `${paidOn}T09:00:00Z` : null });
  } else if (action === "registration") {
    const on = dateOf(input.registered_on);
    if (!on) return { error: "invalid", field: "registered_on" };
    const terms = c.project_id ? (await db.query("SELECT registration_days FROM commission_terms WHERE project_id = $1", [c.project_id])).rows[0] : null;
    Object.assign(set, { client_registered_on: on, registration_expires_on: terms?.registration_days ? C.addDays(on, terms.registration_days) : null });
  } else if (action === "expected") {
    const amount = C.num(input.amount);
    if (amount === null || Number.isNaN(amount) || amount < 0 || amount > 1e10) return { error: "invalid", field: "amount" };
    Object.assign(set, { expected_amount: Math.round(amount), rate_pct: null });
    if (["partly_paid", "paid"].includes(c.status)) set.status = C.statusAfterPayment(Math.round(amount), c.paid_amount);
  } else if (action === "cancel") {
    if (c.status === "paid") return { error: "state" };
    set.status = "cancelled";
  } else if (action === "reopen") {
    if (c.status !== "cancelled") return { error: "state" };
    set.status = c.paid_amount > 0 ? C.statusAfterPayment(c.expected_amount, c.paid_amount) : c.invoice_no ? "claimed" : "expected";
  } else if (action === "notes") {
    set.notes = String(input.notes || "").trim().slice(0, 1000) || null;
  } else {
    return { error: "invalid", field: "action" };
  }
  const cols = Object.keys(set);
  const { rows } = await db.query(
    `UPDATE commissions SET ${cols.map((k, i) => `${k} = $${i + 3}${k === "payments" ? "::jsonb" : ""}`).join(", ")}, updated_at = now(), version = version + 1
      WHERE id = $1 AND agency_id = $2 AND version = $${cols.length + 3} RETURNING *`,
    [c.id, actor.agency_id, ...cols.map((k) => set[k]), c.version]
  );
  return rows[0] ? { ok: true, commission: rows[0] } : { error: "conflict" };
}

/* ---------------------------------------------------------------------- */
/* Morning brief (managers)                                                */
/* ---------------------------------------------------------------------- */

/** What a manager's morning brief says today: overdue claims (every 7 days) and registrations about to lapse. */
async function briefItems(db, agencyId, { now = new Date() } = {}) {
  const day = today(now);
  const { rows } = await db.query(
    `SELECT c.id, c.status, c.due_on, c.registration_expires_on, c.expected_amount, c.paid_amount, d.ref AS deal_ref, d.unit_code, v.name AS developer_name
       FROM commissions c JOIN deals d ON d.id = c.deal_id LEFT JOIN developers v ON v.id = c.developer_id
      WHERE c.agency_id = $1 AND c.status IN ('expected', 'claimable', 'claimed', 'partly_paid')
        AND (c.due_on < $2::date OR c.registration_expires_on BETWEEN $2::date AND $2::date + 7)`,
    [agencyId, day]
  );
  return {
    overdue: rows.filter((r) => C.remindOverdue(r, day)).map((r) => ({ ...r, days: C.overdueDays(r, day), outstanding: Number(r.expected_amount) - Number(r.paid_amount) })),
    registrations: rows.filter((r) => C.remindRegistration(r, day)).map((r) => ({ ...r, days_left: C.daysBetween(day, C.isoDay(r.registration_expires_on)) }))
  };
}

module.exports = { getTerms, saveTerms, ensureForDeal, onDealChanged, syncAgency, listCommissions, getCommission, totals, statement, statementWorkbook, statusWord, move, briefItems };
