// services/leadIntake.js — Per-agency lead intake (next picks L1, L7, L8). The app owner makes a secret URL for an
// agency (only its SHA-256 is kept); Make.com (Facebook/Instagram lead ads), a website form or any automation posts
// leads to it. Each lead goes through services/leads.js captureLead (dedupe by phone, erasures, the response rule),
// gets the intake's source and the next broker in the round robin; the broker hears on Telegram/the website, managers
// get the new-lead alert. A repeat (same Meta lead id) is taken once. Every request is logged without the phone (last 4
// digits only). An intake with no lead for its quiet days alerts the owner and the agency's managers once.
"use strict";

const crypto = require("crypto");

const Leads = require("./leads");
const LeadRules = require("./leadRules");
const LeadRequests = require("./leadRequests");
const Notifications = require("../lib/notifications");
const ErrorReports = require("../lib/errorReports");
const RateLimit = require("../lib/rateLimit");
const Links = require("../lib/links");
const LeadImport = require("../domain/leadImport");
const Stages = require("../domain/leadStages");
const Card = require("../domain/leadCard");
const Vis = require("../lib/visibility");

const PER_HOUR = { limit: 300, windowSec: 3600 };
const LOG_KEEP = 50;
const L = (b, ar, en) => (b?.preferred_lang === "en" ? en : ar);

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const clean = (v, max) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** The intake URL for a token. */
const intakeUrl = (token) => `${Links.siteOrigin()}/intake/${token}`;

/** Owner: a new intake for an agency → { intake, token, url } (the token is shown once) or { error }. */
async function create(pool, agencyId, { name, source, quietDays = 3 } = {}) {
  const n = clean(name, 60);
  const s = clean(source, 60);
  const q = Number(quietDays);
  if (!n || !s) return { error: "fields" };
  if (!Number.isInteger(q) || q < 1 || q > 60) return { error: "quiet_days" };
  const agency = (await pool.query("SELECT id, name FROM agencies WHERE id = $1", [agencyId])).rows[0];
  if (!agency) return { error: "not_found" };
  const token = crypto.randomBytes(24).toString("base64url");
  const { rows } = await pool.query(
    "INSERT INTO lead_intakes (agency_id, name, source, token_hash, token_hint, quiet_days) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
    [agencyId, n, s, hashToken(token), token.slice(-4), q]
  );
  return { intake: rows[0], agency, token, url: intakeUrl(token) };
}

/** Owner: stops an intake (its URL answers 404 from now on). */
async function revoke(pool, intakeId, { now = new Date() } = {}) {
  const { rows } = await pool.query("UPDATE lead_intakes SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING *", [intakeId, now.toISOString()]);
  return rows[0] ? { intake: rows[0] } : { error: "not_found" };
}

/**
 * Body → cells for domain/leadImport.js rowToLead, plus the extra answers for the notes and the sender's lead id.
 * Accepts flat fields ({ full_name, phone_number, platform, campaign_name, … }) and Meta's field_data
 * ([{ name, values: [...] }]) as Make's Facebook Lead Ads module sends it.
 */
function readBody(body = {}) {
  const flat = {};
  const add = (k, v) => {
    if (v === null || v === undefined || typeof v === "object") return;
    if (!(k in flat)) flat[k] = v;
  };
  for (const [k, v] of Object.entries(body || {})) {
    if (k === "field_data" && Array.isArray(v)) {
      for (const f of v) if (f && f.name) add(String(f.name), Array.isArray(f.values) ? f.values.join(", ") : f.value);
    } else add(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const externalId = clean(flat.leadgen_id ?? flat.lead_id ?? flat.id, 100);
  const cells = {};
  const extra = [];
  for (const [k, v] of Object.entries(flat)) {
    if (/^(id|leadgen_id|lead_id|created_time|test|ad_id|adset_id|campaign_id|form_id|page_id|is_organic)$/i.test(k)) continue;
    const col = LeadImport.columnFor(k.replace(/_/g, " "));
    if (col && !(col in cells)) cells[col] = v;
    else if (clean(v, 300) && extra.length < 15) extra.push(`${clean(k.replace(/_/g, " "), 60)}: ${clean(v, 300)}`);
  }
  return { cells, extra, externalId };
}

async function logRow(pool, intake, row) {
  await pool.query(
    `INSERT INTO lead_intake_log (intake_id, agency_id, outcome, external_id, lead_id, phone_tail, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [intake.id, intake.agency_id, row.outcome, row.externalId || null, row.leadId || null, row.phoneTail || null, row.detail ? String(row.detail).slice(0, 200) : null]
  );
  // Keep the newest rows per intake only.
  await pool.query(
    `DELETE FROM lead_intake_log WHERE intake_id = $1 AND id < (SELECT id FROM lead_intake_log WHERE intake_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1)`,
    [intake.id, LOG_KEEP * 10]
  );
}

/** The broker who already has a lead hears that the client asked again through this source. */
async function tellRepeat(pool, lead, intake, now) {
  if (!lead.assigned_broker_id) return;
  const b = (await pool.query(`SELECT * FROM brokers WHERE id = $1 AND agency_id = $2 AND is_active`, [lead.assigned_broker_id, lead.agency_id])).rows[0];
  if (!b) return;
  await Notifications.notifyBroker(pool, b, {
    kind: "assignment",
    dedupeKey: `intake_repeat:${lead.id}:${now.toISOString().slice(0, 10)}`,
    title: L(b, `🔁 ${Card.displayName(lead, "ar")} (${Card.refLabel(lead.ref)}) سأل تاني من ${intake.source}`, `🔁 ${Card.displayName(lead, "en")} (${Card.refLabel(lead.ref)}) asked again via ${intake.source}`),
    body: L(b, "كلّمه وهو لسه مهتم.", "Call while they're still interested."),
    url: `/app/leads/${Card.refLabel(lead.ref)}`,
    leadId: lead.id,
    now
  });
}

/**
 * One request to /intake/<token> → { status, json }. test: checks and logs, keeps no lead.
 */
async function receive(pool, token, body, { now = new Date(), test = false } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ""))) return { status: 404, json: { ok: false, error: "not_found" } };
  const intake = (await pool.query("SELECT * FROM lead_intakes WHERE token_hash = $1 AND revoked_at IS NULL", [hashToken(token)])).rows[0];
  if (!intake) return { status: 404, json: { ok: false, error: "not_found" } };
  return receiveFor(pool, intake, body, { now, test });
}

/** A sample Make/Meta lead for the owner's test button. */
const SAMPLE = {
  platform: "fb",
  campaign_name: "WehdatHub test",
  field_data: [{ name: "full_name", values: ["Test lead"] }, { name: "phone_number", values: ["p:+201000000000"] }]
};

/** Owner: the test button of an intake (test mode: checked and logged, no lead). */
async function testIntake(pool, intakeId, { now = new Date() } = {}) {
  const intake = (await pool.query("SELECT * FROM lead_intakes WHERE id = $1 AND revoked_at IS NULL", [intakeId])).rows[0];
  if (!intake) return { status: 404, json: { ok: false, error: "not_found" } };
  return receiveFor(pool, intake, SAMPLE, { now, test: true });
}

async function receiveFor(pool, intake, body, { now = new Date(), test = false } = {}) {
  const gate = await RateLimit.hit(pool, `intake:${intake.id}`, PER_HOUR);
  if (!gate.allowed) return { status: 429, json: { ok: false, error: "rate_limited" } };

  const isTest = test || body?.test === true || body?.test === "true";
  const { cells, extra, externalId } = readBody(body);
  const lead = LeadImport.rowToLead(cells);
  const phoneTail = lead.phones[0] ? lead.phones[0].slice(-4) : null;
  if (lead.errors.length) {
    await logRow(pool, intake, { outcome: "invalid", externalId, phoneTail, detail: lead.errors.join(", ") });
    return { status: 200, json: { ok: false, outcome: "invalid", error: lead.errors[0] } };
  }
  if (isTest) {
    await logRow(pool, intake, { outcome: "test", phoneTail, detail: [lead.name ? "name" : null, lead.source || intake.source].filter(Boolean).join(", ") });
    return { status: 200, json: { ok: true, outcome: "test", source: lead.source || intake.source } };
  }
  if (externalId) {
    const seen = await pool.query(
      "SELECT lead_id FROM lead_intake_log WHERE intake_id = $1 AND external_id = $2 AND outcome IN ('created', 'merged', 'colleague') LIMIT 1",
      [intake.id, externalId]
    );
    if (seen.rows.length) {
      await logRow(pool, intake, { outcome: "repeat", leadId: seen.rows[0].lead_id, phoneTail });
      return { status: 200, json: { ok: true, outcome: "repeat" } };
    }
  }

  try {
    // The intake acts as a manager of its agency (so it can assign); nobody is "the one who added it".
    const actor = { id: null, agency_id: intake.agency_id, role: "admin", name: intake.name, preferred_lang: "ar" };
    const next = await LeadRules.nextBroker(pool, intake.agency_id, { now, advance: true });
    const notes = [lead.notes, ...extra].filter(Boolean).join("\n");
    const res = await Leads.captureLead(
      pool,
      actor,
      { phones: lead.phones, name: lead.name, kind: lead.kind || undefined, source: lead.source || intake.source, notes, lawfulBasis: "client_request", assignTo: next?.id || null },
      { now }
    );
    const outcome = ["created", "merged", "colleague", "erased_before"].includes(res.outcome) ? res.outcome : "invalid";
    await logRow(pool, intake, { outcome, externalId, leadId: res.lead?.id || null, phoneTail, detail: res.error || null });
    if (outcome === "created" || outcome === "merged") {
      await pool.query("UPDATE lead_intakes SET last_lead_at = $2 WHERE id = $1", [intake.id, now.toISOString()]);
      if (outcome === "created" && lead.request) await LeadRequests.saveRequest(pool, actor, res.lead.id, lead.request, { now }).catch(() => {});
      if (outcome === "merged") await tellRepeat(pool, res.lead, intake, now).catch((e) => console.warn("Intake repeat notice failed:", e.message));
    }
    return { status: 200, json: { ok: outcome !== "invalid", outcome, ref: res.lead?.ref ? Card.refLabel(res.lead.ref) : undefined } };
  } catch (err) {
    console.error("Lead intake failed:", err.code || err.message);
    await logRow(pool, intake, { outcome: "error", externalId, phoneTail, detail: err.code || "error" }).catch(() => {});
    return { status: 500, json: { ok: false, error: "temporary" } };
  }
}

/** Owner and managers: an agency's intakes with their last 30 days' counts. */
async function listForAgency(pool, agencyId) {
  const { rows } = await pool.query(
    `SELECT i.*, (SELECT count(*)::int FROM lead_intake_log g WHERE g.intake_id = i.id AND g.outcome = 'created' AND g.received_at > now() - interval '30 days') AS created_30,
            (SELECT count(*)::int FROM lead_intake_log g WHERE g.intake_id = i.id AND g.outcome IN ('invalid', 'error') AND g.received_at > now() - interval '30 days') AS failed_30
       FROM lead_intakes i WHERE i.agency_id = $1 ORDER BY i.revoked_at NULLS FIRST, i.created_at`,
    [agencyId]
  );
  return rows;
}

/** Owner: every active agency with its intakes. */
async function overview(pool) {
  const { rows: agencies } = await pool.query("SELECT id, name FROM agencies ORDER BY name");
  const out = [];
  for (const a of agencies) out.push({ agency: a, intakes: await listForAgency(pool, a.id) });
  return out;
}

/** The newest log rows of an agency (or of one intake). */
async function log(pool, agencyId, { intakeId = null, limit = LOG_KEEP } = {}) {
  const { rows } = await pool.query(
    `SELECT g.*, i.name AS intake_name, l.ref AS lead_ref FROM lead_intake_log g JOIN lead_intakes i ON i.id = g.intake_id
       LEFT JOIN leads l ON l.id = g.lead_id
      WHERE ${Vis.leads("l")} AND g.agency_id = $1 ${intakeId ? "AND g.intake_id = $3" : ""} ORDER BY g.id DESC LIMIT $2`,
    intakeId ? [agencyId, limit, intakeId] : [agencyId, limit]
  );
  return rows;
}

/** L8: the sources an agency's leads use: the common ones, then its intakes' and its own (most used first). */
async function sourcesFor(pool, agencyId) {
  const known = Stages.SOURCES.map(([en]) => en);
  const { rows } = await pool.query(
    `SELECT source FROM (
       SELECT source, 1000000 AS n FROM lead_intakes WHERE agency_id = $1 AND revoked_at IS NULL
       UNION ALL SELECT source, count(*) AS n FROM leads WHERE ${Vis.leads("leads")} AND agency_id = $1 AND source IS NOT NULL AND source <> '' GROUP BY source
     ) s GROUP BY source ORDER BY max(n) DESC, source LIMIT 40`,
    [agencyId]
  );
  return rows.map((r) => r.source).filter((s) => !known.includes(s)).slice(0, 20);
}

/** Scheduler step: an intake with no lead for its quiet days alerts once (until a lead arrives again). */
async function quietCheck(pool, { now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT i.*, a.name AS agency_name FROM lead_intakes i JOIN agencies a ON a.id = i.agency_id
      WHERE i.revoked_at IS NULL AND COALESCE(i.last_lead_at, i.created_at) < $1::timestamptz - make_interval(days => i.quiet_days)
        AND (i.quiet_alerted_at IS NULL OR i.quiet_alerted_at < COALESCE(i.last_lead_at, i.created_at))`,
    [now.toISOString()]
  );
  for (const i of rows) {
    await pool.query("UPDATE lead_intakes SET quiet_alerted_at = $2 WHERE id = $1", [i.id, now.toISOString()]);
    const since = i.last_lead_at ? new Date(i.last_lead_at).toISOString().slice(0, 10) : null;
    ErrorReports.alertOwner([`🔕 Lead intake quiet: ${i.agency_name} · ${i.name}`, since ? `No lead since ${since} (${i.quiet_days}+ days).` : `No lead yet, ${i.quiet_days}+ days after it was made.`, "Check the Make scenario and the Page's leads access."].join("\n")).catch(() => {});
    for (const m of await Notifications.managersOf(pool, i.agency_id)) {
      await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `intake_quiet:${i.id}:${now.toISOString().slice(0, 10)}`,
        title: L(m, `🔕 مفيش عملاء من «${i.name}» من ${i.quiet_days} يوم أو أكتر`, `🔕 No leads from "${i.name}" for ${i.quiet_days}+ days`),
        body: L(m, "لو الإعلانات شغالة، كلّم دعم WehdatHub نتأكد من الربط.", "If your ads are running, tell WehdatHub support so we check the connection."),
        url: "/app/sources",
        now
      });
    }
  }
  return { counts: { quiet: rows.length } };
}

const quietJob = () => ({ name: "intake_quiet", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => quietCheck(pool, { now }) });

module.exports = { PER_HOUR, SAMPLE, hashToken, intakeUrl, create, revoke, readBody, receive, testIntake, listForAgency, overview, log, sourcesFor, quietCheck, quietJob };
