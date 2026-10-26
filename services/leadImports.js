// services/leadImports.js — Importing clients from a CSV or Excel file (Release 3 step 6): plan → preview → apply once.
// The plan reads every row against the agency's leads and erasures (nothing is written); the apply runs in the
// background through services/leads.js captureLead, so every row gets the same duplicate, colleague and erasure
// rules as WhatsApp and the web form. A merge only fills blanks; a colleague's client is never reassigned.
// Managers hear once per import, and each assignee once, never once per row. Names and phones stay out of logs.
"use strict";

const Rules = require("../domain/leadRules");

const Leads = require("./leads");
const Imports = require("./imports");
const LeadRequests = require("./leadRequests");
const Notifications = require("../lib/notifications");
const Authz = require("../lib/authz");
const LeadImport = require("../domain/leadImport");
const Stages = require("../domain/leadStages");
const { logOperation } = require("../lib/db");

const PROGRESS_EVERY = 25;
const jobs = new Map(); // import id → promise (tests and graceful shutdown can wait for it)

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);

async function activeBrokers(pool, agencyId) {
  const { rows } = await pool.query(
    "SELECT id, name, role, phone_number, phone_normalized, away_until FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name, id",
    [agencyId]
  );
  return rows;
}

/**
 * Plans a lead import (nothing is written).
 * @param {Object} table - lib/sheets.js readTable output (LeadImport.columnFor)
 * @param {Object} opts - { basis (the lawful basis ticked for the file), roundRobin (managers: share unassigned rows) }
 * @returns {Promise<{ items, counts, basis, roundRobin }>}
 *   item kinds: new | merge | colleague | erased_before | repeated | invalid
 */
async function planLeads(pool, broker, table, { basis = "client_request", roundRobin = false } = {}) {
  if (!Stages.LAWFUL_BASES.includes(basis)) throw Object.assign(new Error("Unknown lawful basis"), { code: "BASIS" });
  const manager = Authz.isManager(broker);
  const parsed = table.rows.map((r) => ({ row: r.rowNumber, ...LeadImport.rowToLead(r.cells) }));

  const allPhones = [...new Set(parsed.flatMap((p) => p.phones))];
  const { rows: found } = allPhones.length
    ? await pool.query("SELECT id, ref, name, phones, assigned_broker_id, source, notes FROM leads WHERE agency_id = $1 AND phones && $2::text[]", [broker.agency_id, allPhones])
    : { rows: [] };
  const byPhone = new Map(found.flatMap((l) => l.phones.map((p) => [p, l])));
  const hashes = allPhones.map((p) => [p, Leads.phoneHash(p)]);
  const { rows: erased } = hashes.length
    ? await pool.query("SELECT phone_hash FROM lead_erasures WHERE agency_id = $1 AND phone_hash = ANY($2::text[])", [broker.agency_id, hashes.map(([, h]) => h)])
    : { rows: [] };
  const erasedSet = new Set(erased.map((r) => r.phone_hash));
  const erasedPhones = new Set(hashes.filter(([, h]) => erasedSet.has(h)).map(([p]) => p));

  const brokers = manager ? await activeBrokers(pool, broker.agency_id) : [];
  // Round-robin goes to the brokers (role broker); an agency of managers only shares among them.
  // Brokers away (R3) take no new leads and are skipped.
  const available = brokers.filter((b) => !Rules.awayNow(b));
  const pool_ = available.filter((b) => b.role === "broker");
  const rotation = pool_.length ? pool_ : available;
  let turn = 0;

  const seen = new Map(); // phone → first row
  const items = [];
  for (const p of parsed) {
    const base = { row: p.row, name: p.name, phones: p.phones };
    if (p.errors.length) {
      items.push({ ...base, kind: "invalid", reasons: p.errors });
      continue;
    }
    const first = p.phones.map((ph) => seen.get(ph)).find(Boolean);
    if (first) {
      items.push({ ...base, kind: "repeated", first });
      continue;
    }
    p.phones.forEach((ph) => seen.set(ph, p.row));
    const warnings = [...p.warnings];
    const fields = {
      kind: p.kind || "buyer",
      source: p.source,
      notes: p.notes,
      stage: p.stage,
      basis: p.lawfulBasis || basis,
      request: p.request
    };
    const existing = p.phones.map((ph) => byPhone.get(ph)).find(Boolean);
    if (existing) {
      if (!manager && existing.assigned_broker_id && existing.assigned_broker_id !== broker.id) {
        items.push({ ...base, kind: "colleague" });
        continue;
      }
      const fills = [
        !existing.name && p.name ? "name" : null,
        !existing.source && p.source ? "source" : null,
        !existing.notes && p.notes ? "notes" : null,
        p.phones.some((ph) => !existing.phones.includes(ph)) ? "phones" : null,
        p.request ? "request" : null
      ].filter(Boolean);
      items.push({ ...base, kind: "merge", ref: existing.ref, fills, fields, warnings });
      continue;
    }
    if (p.phones.some((ph) => erasedPhones.has(ph))) {
      items.push({ ...base, kind: "erased_before" });
      continue;
    }
    let assignee = null;
    if (manager) {
      if (p.assigned) {
        assignee = LeadImport.matchBroker(p.assigned, brokers);
        if (!assignee) warnings.push("assigned");
        else if (Rules.awayNow(assignee)) {
          warnings.push("assigned_away");
          assignee = null;
        }
      }
      if (!assignee && roundRobin && rotation.length) assignee = rotation[turn++ % rotation.length];
    }
    items.push({ ...base, kind: "new", fields, warnings, assignee_id: assignee?.id || null, assignee_name: assignee?.name || null });
  }
  const counts = items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});
  return { items, counts, basis, roundRobin: Boolean(roundRobin && manager) };
}

/** Saves a plan (and drops this broker's expired lead plans: they hold clients' names and phones). */
async function savePlan(pool, broker, plan, { filename = null } = {}) {
  await pool.query("DELETE FROM web_imports WHERE agency_id = $1 AND broker_id = $2 AND kind = 'leads' AND expires_at < NOW()", [broker.agency_id, broker.id]);
  return Imports.savePlan(pool, broker, "leads", plan, { filename });
}

/** Claims a ready plan once and marks it running (a second apply, a stale tab or an expired plan gets null). */
async function claim(pool, broker, id, total) {
  const { rows } = await pool.query(
    `UPDATE web_imports SET status = 'processing', applied_at = NOW(), result = $4::jsonb
     WHERE id = $1 AND agency_id = $2 AND broker_id = $3 AND kind = 'leads' AND status = 'ready' AND expires_at > NOW()
     RETURNING *`,
    [id, broker.agency_id, broker.id, JSON.stringify({ done: 0, total })]
  );
  return rows[0] || null;
}

const importable = (items) => items.filter((i) => i.kind === "new" || i.kind === "merge");

/** One summary to the managers and one to each assignee (never one per row). */
async function notifyOnce(pool, broker, id, result, assigned, now) {
  for (const m of await Notifications.managersOf(pool, broker.agency_id)) {
    if (m.id === broker.id) continue;
    await Notifications.notifyBroker(pool, m, {
      kind: "manager_alert",
      dedupeKey: `lead_import:${id}`,
      title: L(m, `📥 ${broker.name || "—"} استورد ${result.created} عميل جديد`, `📥 ${broker.name || "—"} imported ${result.created} new leads`),
      body: L(m, `اتحدّث: ${result.merged} · مع زملاء: ${result.colleague}`, `Updated: ${result.merged} · With colleagues: ${result.colleague}`),
      url: "/app/leads",
      now
    });
  }
  for (const [brokerId, n] of assigned) {
    if (brokerId === broker.id) continue;
    const b = (await pool.query("SELECT id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, broker.agency_id])).rows[0];
    if (!b) continue;
    await Notifications.notifyBroker(pool, b, {
      kind: "assignment",
      dedupeKey: `lead_import:${id}:${b.id}`,
      title: L(b, `🧑‍💼 اتسلملك ${n} عميل جديد من ملف`, `🧑‍💼 ${n} new leads assigned to you from a file`),
      body: L(b, "افتح عملائي عشان تبدأ تكلمهم.", "Open your leads to start calling them."),
      url: "/app/leads",
      now
    });
  }
}

async function runApply(pool, broker, imp, { now = () => new Date() } = {}) {
  const rows = importable(imp.payload.items);
  const result = { done: 0, total: rows.length, created: 0, merged: 0, colleague: 0, erased_before: 0, failed: 0, refs: [] };
  const assigned = new Map();
  const save = (status = "processing") => pool.query("UPDATE web_imports SET result = $2::jsonb, status = $3 WHERE id = $1", [imp.id, JSON.stringify(result), status]);

  for (const item of rows) {
    const f = item.fields;
    try {
      const res = await Leads.captureLead(
        pool,
        broker,
        { phones: item.phones, name: item.name, kind: f.kind, source: f.source, notes: f.notes, stage: f.stage, lawfulBasis: f.basis, assignTo: item.assignee_id },
        { now: now(), quiet: true }
      );
      if (res.outcome === "created" || res.outcome === "merged") {
        result[res.outcome === "created" ? "created" : "merged"]++;
        if (result.refs.length < 500) result.refs.push(res.lead.ref);
        if (res.outcome === "created" && res.lead.assigned_broker_id) assigned.set(res.lead.assigned_broker_id, (assigned.get(res.lead.assigned_broker_id) || 0) + 1);
        if (f.request) await LeadRequests.saveRequest(pool, broker, res.lead.id, f.request, { now: now() });
      } else if (res.outcome === "colleague") result.colleague++;
      else if (res.outcome === "erased_before") result.erased_before++;
      else result.failed++;
    } catch (err) {
      console.error("Lead import row failed:", err.code || err.message);
      result.failed++;
    }
    result.done++;
    if (result.done % PROGRESS_EVERY === 0) await save().catch(() => {});
  }
  await notifyOnce(pool, broker, imp.id, result, assigned, now());
  // The file's names and phones are not kept once applied: the leads hold them now.
  await pool.query("UPDATE web_imports SET payload = jsonb_build_object('counts', payload->'counts', 'basis', payload->'basis'), result = $2::jsonb, status = 'applied' WHERE id = $1", [
    imp.id,
    JSON.stringify(result)
  ]);
  await logOperation(pool, {
    agency_id: broker.agency_id,
    broker_id: broker.id,
    operation_type: "lead_import",
    metadata: { created: result.created, merged: result.merged, colleague: result.colleague, erased_before: result.erased_before, failed: result.failed }
  });
  return result;
}

/**
 * Starts applying a plan in the background (each row its own transaction, progress saved every 25 rows).
 * @returns {Promise<boolean>} false when the plan was already applied, has expired or is not this broker's
 */
async function startApply(pool, broker, id, opts = {}) {
  const imp = await Imports.loadImport(pool, broker, id);
  if (!imp || imp.kind !== "leads") return false;
  const claimed = await claim(pool, broker, id, importable(imp.payload.items || []).length);
  if (!claimed) return false;
  const job = new Promise((resolve) => setImmediate(resolve))
    .then(() => runApply(pool, broker, claimed, opts))
    .catch(async (err) => {
      console.error("Lead import failed:", err.message);
      await pool.query("UPDATE web_imports SET status = 'failed' WHERE id = $1", [id]).catch(() => {});
    })
    .finally(() => jobs.delete(id));
  jobs.set(id, job);
  return true;
}

/** Resolves when a running apply finishes (immediately if none). */
function waitForApply(id) {
  return jobs.get(id) || Promise.resolve();
}

module.exports = { planLeads, savePlan, startApply, waitForApply };
