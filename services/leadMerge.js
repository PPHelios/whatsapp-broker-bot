// services/leadMerge.js — Duplicate lead merge (Release B, N8, managers). Two records for one client (saved under two
// different numbers) become one: the kept lead gains the other's numbers (up to 3; any extra is written into a note
// so nothing is lost), its name, source and notes where its own are empty, the further stage (a won lead stays won),
// the open follow-up when it has none, and the latest contact. Everything that pointed at the other lead moves over
// (history events, requests and their matches, share links, viewings, deals, notifications), a "merged" event is added
// and the other record is deleted. It can't be undone, so the page asks for the other lead's reference to confirm.
"use strict";

const Card = require("../domain/leadCard");
const Stages = require("../domain/leadStages");
const { withTransaction } = require("../lib/db");
const { isManager } = require("../lib/authz");

const MAX_PHONES = 3;
const MOVE = ["lead_events", "saved_searches", "lead_matches", "share_links", "viewings", "deals", "notifications"];

const rank = (s) => (s === "won" ? 100 : s === "lost" ? -1 : Stages.STAGES.indexOf(s));

/** The kept lead's fields after the merge (pure). */
function mergedFields(keep, drop) {
  const phones = [...new Set([...(keep.phones || []), ...(drop.phones || [])])];
  const extra = phones.slice(MAX_PHONES);
  const stage = rank(drop.stage) > rank(keep.stage) ? drop.stage : keep.stage;
  const later = (a, b) => (!a ? b || null : !b ? a : new Date(a) > new Date(b) ? a : b);
  const takeFollowUp = keep.follow_up_status !== "open" && drop.follow_up_status === "open";
  const notes = [keep.notes, drop.notes].filter(Boolean).join("\n—\n").slice(0, 4000) || null;
  return {
    phones: phones.slice(0, MAX_PHONES),
    extra,
    name: keep.name || drop.name || null,
    source: keep.source || drop.source || null,
    lang: keep.lang || drop.lang || null,
    notes,
    stage,
    lost_reason: stage === "lost" ? keep.lost_reason || drop.lost_reason : null,
    assigned_broker_id: keep.assigned_broker_id || drop.assigned_broker_id || null,
    last_contact_at: later(keep.last_contact_at, drop.last_contact_at),
    hot_at: later(keep.hot_at, drop.hot_at),
    follow_up: takeFollowUp ? { next_follow_up_at: drop.next_follow_up_at, follow_up_kind: drop.follow_up_kind, follow_up_listing_id: drop.follow_up_listing_id, follow_up_note: drop.follow_up_note, follow_up_status: "open" } : null
  };
}

/**
 * Merges `dropKey` into `keepKey`. confirm must be the other lead's reference ("L-0042").
 * @returns {Promise<{ ok, lead, moved } | { error: 'forbidden'|'not_found'|'same'|'confirm' }>}
 */
async function merge(pool, manager, keepKey, dropKey, { confirm = "", now = new Date() } = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  return withTransaction(pool, async (client) => {
    const load = async (key) => {
      const ref = Card.parseRef(key) || (/^\d+$/.test(String(key)) ? Number(key) : null);
      const byId = /^[0-9a-f-]{36}$/i.test(String(key));
      if (!ref && !byId) return null;
      const { rows } = await client.query(`SELECT * FROM leads WHERE agency_id = $1 AND ${byId ? "id = $2" : "ref = $2"} FOR UPDATE`, [manager.agency_id, byId ? key : ref]);
      return rows[0] || null;
    };
    const keep = await load(keepKey);
    const drop = await load(dropKey);
    if (!keep || !drop) return { error: "not_found" };
    if (keep.id === drop.id) return { error: "same" };
    if (Card.parseRef(confirm) !== drop.ref) return { error: "confirm" };

    const f = mergedFields(keep, drop);
    const moved = {};
    for (const t of MOVE) {
      const r = await client.query(`UPDATE ${t} SET lead_id = $1 WHERE lead_id = $2`, [keep.id, drop.id]);
      moved[t] = r.rowCount;
    }
    // The other record goes before the kept one takes its numbers (one primary number per agency).
    await client.query("DELETE FROM leads WHERE id = $1", [drop.id]);
    const fu = f.follow_up || {};
    const { rows } = await client.query(
      `UPDATE leads SET phones = $2, name = $3, source = $4, lang = $5, notes = $6, stage = $7, lost_reason = $8, assigned_broker_id = $9,
              last_contact_at = $10, hot_at = $11,
              next_follow_up_at = CASE WHEN $12 THEN $13::timestamptz ELSE next_follow_up_at END,
              follow_up_kind = CASE WHEN $12 THEN $14 ELSE follow_up_kind END,
              follow_up_listing_id = CASE WHEN $12 THEN $15::uuid ELSE follow_up_listing_id END,
              follow_up_note = CASE WHEN $12 THEN $16 ELSE follow_up_note END,
              follow_up_status = CASE WHEN $12 THEN 'open' ELSE follow_up_status END,
              version = version + 1, updated_at = $17, last_activity_at = $17
        WHERE id = $1 RETURNING *`,
      [keep.id, f.phones, f.name, f.source, f.lang, f.notes, f.stage, f.lost_reason, f.assigned_broker_id, f.last_contact_at, f.hot_at, Boolean(f.follow_up), fu.next_follow_up_at || null, fu.follow_up_kind || null, fu.follow_up_listing_id || null, fu.follow_up_note || null, now.toISOString()]
    );
    const data = { from_ref: drop.ref, from_name: drop.name || null, phones_added: f.phones.filter((p) => !(keep.phones || []).includes(p)).length, moved };
    await client.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, 'merged', $4, $5)", [keep.agency_id, keep.id, manager.id, JSON.stringify(data), now.toISOString()]);
    if (f.extra.length) {
      await client.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data, created_at) VALUES ($1, $2, $3, 'note', $4, $5)", [
        keep.agency_id,
        keep.id,
        manager.id,
        JSON.stringify({ text: `${Card.refLabel(drop.ref)}: ${f.extra.join(", ")}`, via: "merge" }),
        now.toISOString()
      ]);
    }
    return { ok: true, lead: rows[0], moved, from: drop };
  });
}

module.exports = { MAX_PHONES, mergedFields, merge };
