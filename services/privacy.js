// services/privacy.js — The PDPL duties for leads (Law 151/2020; Release 3 step 11, Q8 and Q9). Managers export a
// client's data (a zip with a .json and a readable .txt, nothing about other people) and erase a client (typing the
// last 4 digits; a hard delete that keeps only a keyed hash of each phone, so a later re-capture says "this client
// asked to be deleted"; deals stay without the client's name and phone). A daily job erases leads with no activity for
// 18 months (managers are warned 30 days before) and clears stored WhatsApp payloads after 7 days.
"use strict";

const JSZip = require("jszip");
const Leads = require("./leads");
const Authz = require("../lib/authz");
const Notifications = require("../lib/notifications");
const Card = require("../domain/leadCard");
const Stages = require("../domain/leadStages");
const SearchLink = require("../domain/searchLink");
const { withTransaction } = require("../lib/db");

const RETENTION_MONTHS = 18;
const WARN_DAYS = 30;
const PAYLOAD_DAYS = 7;
const BATCH = 500;
const DAY_MS = 24 * 3600 * 1000;

const monthsAgo = (now, n) => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};
const iso = (d) => (d ? new Date(d).toISOString() : null);

// Event fields that describe the client's own history (an allow-list: no broker names or ids, no undo snapshots).
const EVENT_FIELDS = ["text", "lost_reason", "at", "kind", "code", "unit_code", "price", "source"];

function eventData(ev) {
  const d = ev.data || {};
  const out = Object.fromEntries(EVENT_FIELDS.filter((k) => d[k] !== undefined && d[k] !== null).map((k) => [k, d[k]]));
  if (ev.kind === "stage" && d.to) out.stage = d.to;
  if (ev.kind === "deal" && d.ref) out.deal = `D-${String(d.ref).padStart(4, "0")}`;
  return out;
}

/**
 * Everything the agency holds about one client. Managers only.
 * @returns {Promise<{ filename, zip: Buffer, data } | { error: "forbidden"|"not_found" }>}
 */
async function exportLead(pool, actor, key, { now = new Date() } = {}) {
  if (!Authz.canManageLeads(actor)) return { error: "forbidden" };
  const lead = await Leads.getLead(pool, actor, key);
  if (!lead) return { error: "not_found" };
  const events = await pool.query("SELECT kind, data, created_at, undone_at FROM lead_events WHERE lead_id = $1 AND agency_id = $2 ORDER BY id", [lead.id, actor.agency_id]);
  const requests = await pool.query("SELECT filters, created_at FROM saved_searches WHERE lead_id = $1 AND agency_id = $2 ORDER BY created_at", [lead.id, actor.agency_id]);
  const sent = await pool.query(
    `SELECT l.code, s.created_at, s.open_count FROM share_links s JOIN listings l ON l.id = s.listing_id
      WHERE s.lead_id = $1 AND s.agency_id = $2 ORDER BY s.created_at`,
    [lead.id, actor.agency_id]
  );
  const deals = await pool.query("SELECT ref, unit_code, deal_type, price, status, closed_at FROM deals WHERE lead_id = $1 AND agency_id = $2 ORDER BY ref", [lead.id, actor.agency_id]);
  const agency = (await pool.query("SELECT name FROM agencies WHERE id = $1", [actor.agency_id])).rows[0];
  const data = {
    exported_at: iso(now),
    controller: agency?.name || null,
    client: {
      reference: Card.refLabel(lead.ref),
      name: lead.name,
      phones: lead.phones,
      kind: lead.kind,
      source: lead.source,
      lawful_basis: lead.lawful_basis,
      consent_at: iso(lead.consent_at),
      consent_note: lead.consent_note,
      stage: lead.stage,
      lost_reason: lead.lost_reason,
      notes: lead.notes,
      next_follow_up_at: lead.follow_up_status === "open" ? iso(lead.next_follow_up_at) : null,
      last_contact_at: iso(lead.last_contact_at),
      created_at: iso(lead.created_at)
    },
    requests: requests.rows.map((r) => ({ what: Card.requestSummary(SearchLink.sanitizeFilters(r.filters) || {}, "en"), created_at: iso(r.created_at) })),
    units_sent: sent.rows.map((r) => ({ unit: r.code, sent_at: iso(r.created_at), opens: Number(r.open_count || 0) })),
    deals: deals.rows.map((d) => ({ reference: `D-${String(d.ref).padStart(4, "0")}`, unit: d.unit_code, type: d.deal_type, price: Number(d.price), status: d.status, closed_at: iso(d.closed_at) })),
    history: events.rows.filter((e) => !e.undone_at && e.kind !== "undo").map((e) => ({ at: iso(e.created_at), what: e.kind, ...eventData(e) }))
  };
  const txt = [
    `Data held about ${data.client.name || "(no name)"} (${data.client.reference}) by ${data.controller || "the agency"}`,
    `Exported ${data.exported_at}`,
    "",
    `Phones: ${data.client.phones.join(", ")}`,
    `Type: ${Stages.kindLabel(data.client.kind, "en")} · Source: ${data.client.source || "-"} · Stage: ${Stages.stageLabel(data.client.stage, "en")}`,
    `Lawful basis: ${Stages.basisLabel(data.client.lawful_basis, "en")}${data.client.consent_at ? ` (consent ${data.client.consent_at})` : ""}`,
    data.client.notes ? `Notes: ${data.client.notes}` : null,
    "",
    "Requests:",
    ...(data.requests.length ? data.requests.map((r) => `- ${r.what} (${r.created_at})`) : ["- none"]),
    "",
    "Units sent:",
    ...(data.units_sent.length ? data.units_sent.map((u) => `- ${u.unit} on ${u.sent_at}, opened ${u.opens} time(s)`) : ["- none"]),
    "",
    "Deals:",
    ...(data.deals.length ? data.deals.map((d) => `- ${d.reference} ${d.unit || ""} ${d.type} ${d.price} EGP, ${d.status}, ${d.closed_at}`) : ["- none"]),
    "",
    "History:",
    ...data.history.map((h) => `- ${h.at} ${h.what}${h.text ? `: ${h.text}` : ""}`)
  ]
    .filter((x) => x !== null)
    .join("\n");
  const zip = new JSZip();
  const base = `client-${Card.refLabel(lead.ref)}`;
  zip.file(`${base}.json`, JSON.stringify(data, null, 2));
  zip.file(`${base}.txt`, txt);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await pool.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, 'exported', '{}', $4)", [
    actor.agency_id,
    lead.id,
    actor.id,
    now.toISOString()
  ]);
  return { filename: `${base}.zip`, zip: buffer, data };
}

/** Inside a transaction: the hard delete of one lead (hashes kept, deals stripped, its notifications and sessions gone). */
async function eraseInTx(client, agencyId, lead, { byBrokerId = null, now = new Date() } = {}) {
  for (const p of lead.phones || [lead.phone_e164]) {
    await client.query(
      "INSERT INTO lead_erasures (agency_id, phone_hash, erased_at, erased_by_broker_id) VALUES ($1, $2, $3, $4) ON CONFLICT (agency_id, phone_hash) DO UPDATE SET erased_at = EXCLUDED.erased_at",
      [agencyId, Leads.phoneHash(p), now.toISOString(), byBrokerId]
    );
  }
  await client.query("UPDATE deals SET client_name = NULL, client_phone = NULL, lead_id = NULL, updated_at = $3 WHERE agency_id = $1 AND lead_id = $2", [agencyId, lead.id, now.toISOString()]);
  // Notifications about the client: their own rows go; grouped ones that name the client lose their text.
  await client.query("DELETE FROM notifications WHERE agency_id = $1 AND lead_id = $2", [agencyId, lead.id]);
  const label = Card.refLabel(lead.ref);
  await client.query(
    "UPDATE notifications SET title = '🔒', body = '' WHERE agency_id = $1 AND (strpos(title, $2) > 0 OR strpos(body, $2) > 0 OR ($3::text IS NOT NULL AND (strpos(title, $3) > 0 OR strpos(body, $3) > 0)))",
    [agencyId, label, lead.name || null]
  );
  await client.query("DELETE FROM broker_sessions WHERE strpos(session_data::text, $1) > 0", [lead.id]);
  await client.query("DELETE FROM leads WHERE id = $1 AND agency_id = $2", [lead.id, agencyId]);
}

/**
 * Erases a client. Managers only, after typing the last 4 digits of the client's phone.
 * @returns {Promise<{ ok, ref } | { error: "forbidden"|"not_found"|"confirm" }>}
 */
async function eraseLead(pool, actor, key, { confirm = "", now = new Date() } = {}) {
  if (!Authz.canManageLeads(actor)) return { error: "forbidden" };
  return withTransaction(pool, async (client) => {
    const lead = await Leads.getLead(client, actor, key);
    if (!lead) return { error: "not_found" };
    const digits = String(confirm || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
    if (digits.length !== 4 || !String(lead.phone_e164).endsWith(digits)) return { error: "confirm" };
    await client.query("SELECT 1 FROM leads WHERE id = $1 FOR UPDATE", [lead.id]);
    await eraseInTx(client, actor.agency_id, lead, { byBrokerId: actor.id, now });
    return { ok: true, ref: lead.ref };
  });
}

/**
 * Q8: leads with no activity for 18 months are erased (in batches); managers get one warning a day listing how many
 * go within 30 days.
 */
async function retentionSweep(pool, { now = new Date(), batch = BATCH } = {}) {
  const cutoff = monthsAgo(now, RETENTION_MONTHS);
  const { rows } = await pool.query("SELECT * FROM leads WHERE last_activity_at < $1 ORDER BY last_activity_at LIMIT $2", [cutoff.toISOString(), batch]);
  let erased = 0;
  for (const lead of rows) {
    await withTransaction(pool, async (client) => {
      const locked = await client.query("SELECT 1 FROM leads WHERE id = $1 AND last_activity_at < $2 FOR UPDATE SKIP LOCKED", [lead.id, cutoff.toISOString()]);
      if (!locked.rows.length) return;
      await eraseInTx(client, lead.agency_id, lead, { now });
      erased++;
    });
  }
  const soon = await pool.query(
    "SELECT agency_id, count(*)::int AS n FROM leads WHERE last_activity_at < $1 AND last_activity_at >= $2 GROUP BY agency_id",
    [new Date(cutoff.getTime() + WARN_DAYS * DAY_MS).toISOString(), cutoff.toISOString()]
  );
  const day = Stages.toCairoLocal(now).slice(0, 10);
  let warned = 0;
  for (const { agency_id: agencyId, n } of soon.rows) {
    for (const m of await Notifications.managersOf(pool, agencyId)) {
      const en = m.preferred_lang === "en";
      const r = await Notifications.notifyBroker(pool, m, {
        kind: "manager_alert",
        dedupeKey: `retention:${day}`,
        title: en ? `🔒 ${n} clients will be erased within 30 days (no activity for 18 months)` : `🔒 ${n} عميل هيتمسحوا خلال 30 يوم (مفيش نشاط من 18 شهر)`,
        body: en ? "Any activity (a call, a note, a follow-up) keeps a client." : "أي نشاط (مكالمة، ملاحظة، متابعة) بيحافظ على العميل.",
        url: "/app/leads?tab=all",
        now
      });
      if (!r.duplicate) warned++;
    }
  }
  return { erased, warned, more: rows.length === batch };
}

/** P2: stored WhatsApp payloads are cleared 7 days after they were handled (new and batched rows are never touched). */
async function purgeInboundPayloads(pool, { now = new Date(), batch = 5000 } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE inbound_messages SET payload = '{"purged":true}'::jsonb
      WHERE msg_id IN (SELECT msg_id FROM inbound_messages
                        WHERE status IN ('completed', 'failed') AND received_at < $1 AND payload IS DISTINCT FROM '{"purged":true}'::jsonb
                        LIMIT $2)`,
    [new Date(now.getTime() - PAYLOAD_DAYS * DAY_MS).toISOString(), batch]
  );
  return { purged: rowCount };
}

/** The scheduler job entry (lib/jobs.js): every 6 hours, so a sleeping free instance still runs it daily. */
const privacyJob = () => ({
  name: "privacy",
  everyMs: 6 * 3600 * 1000,
  run: async ({ pool, now }) => ({
    counts: {
      ...(await retentionSweep(pool, { now })),
      ...(await purgeInboundPayloads(pool, { now })),
      telegram_purged: await require("../lib/tgLink").purgeCallbacks(pool)
    }
  })
});

module.exports = { RETENTION_MONTHS, exportLead, eraseLead, retentionSweep, purgeInboundPayloads, privacyJob };
