// services/unitOwners.js — Unit owner profiles (people with a unit to sell or rent), a separate thing from clients.
// A profile belongs to the agency and is merged by phone. A unit points to its owner (listings.owner_id) and the profile
// is made or found whenever a unit is saved with an owner phone. Who sees a profile:
//   - the agency owner: all;
//   - a manager: every profile except those whose units are all private (a private unit's owner is hidden from managers too);
//   - a broker: the owners of their own active, non-private units.
// Managers edit notes and the flag, delete a profile, and move a unit to another owner (a profile, a lead or a new person).
"use strict";

const Phone = require("../domain/phone");
const { isManager, isAgencyOwner } = require("../lib/authz");
const { logOperation } = require("../lib/db");
const Vis = require("../lib/visibility");

const NOTE_MAX = 2000;
const clean = (v, n) => String(v ?? "").trim().slice(0, n) || null;

async function addEvent(db, agencyId, ownerId, brokerId, kind, data = {}) {
  await db.query("INSERT INTO unit_owner_events (agency_id, owner_id, broker_id, kind, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [agencyId, ownerId, brokerId, kind, JSON.stringify(data)]);
}

/** The profile with this phone in the agency, made (with a creation event) when none exists. Returns the row, or null for no usable phone. */
/** The agency's owner with this phone, or null. Read only: nothing is created. */
async function findByPhone(db, agencyId, phone) {
  const digits = Phone.normalizePhone(phone);
  if (!digits) return null;
  const { rows } = await db.query("SELECT id, name, phones FROM unit_owners WHERE agency_id = $1 AND phones @> ARRAY[$2]::text[] ORDER BY created_at LIMIT 1", [agencyId, digits]);
  return rows[0] || null;
}

async function findOrCreate(db, agencyId, { phone, name = null, brokerId = null }) {
  const digits = Phone.normalizePhone(phone);
  if (!digits) return null;
  const found = await db.query("SELECT * FROM unit_owners WHERE agency_id = $1 AND phones @> ARRAY[$2]::text[] ORDER BY created_at LIMIT 1", [agencyId, digits]);
  if (found.rows[0]) {
    if (!found.rows[0].name && name) await db.query("UPDATE unit_owners SET name = $2, updated_at = now() WHERE id = $1", [found.rows[0].id, clean(name, 120)]);
    return found.rows[0];
  }
  const { rows } = await db.query("INSERT INTO unit_owners (agency_id, name, phones, created_by) VALUES ($1, $2, ARRAY[$3]::text[], $4) RETURNING *", [agencyId, clean(name, 120), digits, brokerId]);
  await addEvent(db, agencyId, rows[0].id, brokerId, "created", { phone: digits });
  return rows[0];
}

/** Points a unit at an owner (no-op when it already does) and records it on the owner's history. */
async function link(db, agencyId, listing, ownerId, brokerId, kind = "unit_linked") {
  if (listing.owner_id === ownerId) return;
  await db.query("UPDATE listings SET owner_id = $3 WHERE id = $1 AND agency_id = $2", [listing.id, agencyId, ownerId]);
  await addEvent(db, agencyId, ownerId, brokerId, kind, { code: listing.code, listing_id: listing.id });
}

/** Called after a unit is saved: its owner phone (and name) make or find the profile and link it. Returns the owner or null. */
async function syncFromListing(db, broker, listing) {
  const d = listing?.details || {};
  if (!d.owner_phone) return null;
  const owner = await findOrCreate(db, listing.agency_id, { phone: d.owner_phone, name: d.owner_name, brokerId: broker?.id || null });
  if (owner) await link(db, listing.agency_id, listing, owner.id, broker?.id || null);
  return owner;
}

/** On top of Vis.units: a broker sees only their own active units on an owner's page; managers see them all. */
function brokerOnly(viewer, alias = "u") {
  return isManager(viewer) ? "" : ` AND ${alias}.broker_id = '${String(viewer.id).replace(/[^0-9a-f-]/gi, "")}'::uuid AND ${alias}.status = 'active'`;
}

/** May this person see this profile? Returns the profile with its visible units, or null. */
async function getFor(pool, viewer, ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(ownerId))) return null;
  const { rows } = await pool.query("SELECT * FROM unit_owners WHERE id = $1 AND agency_id = $2", [ownerId, viewer.agency_id]);
  if (!rows[0]) return null;
  const { rows: units } = await pool.query(
    `SELECT u.id, u.code, u.status, u.listing_type, u.property_type, u.compound, u.price_value, u.broker_id, u.is_private
       FROM listings u WHERE u.owner_id = $1 AND u.agency_id = $2 AND ${Vis.units("u")}${brokerOnly(viewer)} ORDER BY u.created_at DESC`,
    [ownerId, viewer.agency_id]
  );
  const total = (await pool.query("SELECT count(*)::int AS n FROM listings WHERE " + Vis.allUnits() + " AND owner_id = $1 AND agency_id = $2", [ownerId, viewer.agency_id])).rows[0].n;
  // Hidden when none of its units is visible to this viewer; a manager still sees a profile that has no units at all.
  if (!units.length && !(isManager(viewer) && total === 0)) return null;
  return { ...rows[0], units };
}

/** Pages of profiles this person may see, newest first. */
async function listFor(pool, viewer, { q = "", limit = 50, offset = 0 } = {}) {
  const term = String(q || "").trim();
  const digits = Phone.normalizePhone(term);
  const { rows } = await pool.query(
    `SELECT o.*, (SELECT count(*)::int FROM listings u WHERE u.owner_id = o.id AND u.agency_id = o.agency_id AND ${Vis.units("u")}${brokerOnly(viewer)}) AS unit_count
       FROM unit_owners o
      WHERE o.agency_id = $1
        AND (CASE WHEN $2::text = '' THEN true ELSE (o.name ILIKE '%' || $2 || '%' OR ($3::text IS NOT NULL AND o.phones @> ARRAY[$3]::text[])) END)
        AND ((SELECT count(*) FROM listings u WHERE u.owner_id = o.id AND u.agency_id = o.agency_id AND ${Vis.units("u")}${brokerOnly(viewer)}) > 0
             ${isManager(viewer) ? `OR NOT EXISTS (SELECT 1 FROM listings u WHERE ${Vis.allUnits()} AND u.owner_id = o.id AND u.agency_id = o.agency_id)` : ""})
      ORDER BY o.created_at DESC LIMIT $4 OFFSET $5`,
    [viewer.agency_id, term.replace(/[%_\\]/g, (c) => `\\${c}`), digits, limit + 1, offset]
  );
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** The owner's history, newest first. */
async function history(pool, viewer, ownerId, { limit = 50 } = {}) {
  if (!isManager(viewer)) return [];
  const { rows } = await pool.query(
    `SELECT e.kind, e.data, e.created_at, b.name AS broker_name FROM unit_owner_events e LEFT JOIN brokers b ON b.id = e.broker_id
      WHERE e.owner_id = $1 AND e.agency_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [ownerId, viewer.agency_id, limit]
  );
  return rows;
}

/** Managers edit the name, notes and flag. */
async function edit(pool, actor, ownerId, { name, notes, flag }) {
  if (!isManager(actor)) return { error: "forbidden" };
  const before = (await pool.query("SELECT * FROM unit_owners WHERE id = $1 AND agency_id = $2", [ownerId, actor.agency_id])).rows[0];
  if (!before) return { error: "not_found" };
  if (!(await getFor(pool, actor, ownerId))) return { error: "not_found" };
  const next = { name: clean(name, 120), notes: clean(notes, NOTE_MAX), flag: clean(flag, 200) };
  await pool.query("UPDATE unit_owners SET name = $3, notes = $4, flag = $5, updated_at = now() WHERE id = $1 AND agency_id = $2", [ownerId, actor.agency_id, next.name, next.notes, next.flag]);
  if (next.flag !== before.flag) await addEvent(pool, actor.agency_id, ownerId, actor.id, "flag", { from: before.flag, to: next.flag });
  if (next.notes !== before.notes) await addEvent(pool, actor.agency_id, ownerId, actor.id, "note", { text: next.notes });
  if (next.name !== before.name) await addEvent(pool, actor.agency_id, ownerId, actor.id, "edited", { name: next.name });
  return { ok: true };
}

/** Managers delete a profile; its units stay and lose the link. */
async function remove(pool, actor, ownerId) {
  if (!isManager(actor)) return { error: "forbidden" };
  if (!(await getFor(pool, actor, ownerId))) return { error: "not_found" };
  await pool.query("DELETE FROM unit_owners WHERE id = $1 AND agency_id = $2", [ownerId, actor.agency_id]);
  logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "unit_owner_deleted", status: "success", metadata: { owner_id: ownerId } });
  return { ok: true };
}

/**
 * A manager moves a unit to another owner: an existing profile ({ ownerId }), a lead who bought it ({ leadRef }: the lead's
 * name and phone become, or join, an owner profile; the lead itself stays a lead) or a new person ({ name, phone }). The unit's
 * owner name and phone follow, and both owners' histories record the move.
 * @returns {Promise<{ ok: true, owner } | { error }>}
 */
async function reassign(pool, actor, listing, to) {
  if (!isManager(actor) || listing.agency_id !== actor.agency_id) return { error: "forbidden" };
  let target = null;
  if (to.ownerId) {
    target = (await pool.query("SELECT * FROM unit_owners WHERE id = $1 AND agency_id = $2", [to.ownerId, actor.agency_id])).rows[0] || null;
    if (!target) return { error: "not_found" };
  } else if (to.leadRef) {
    const ref = Number(String(to.leadRef).replace(/\D/g, ""));
    const lead = ref ? (await pool.query("SELECT name, phones FROM leads l WHERE " + Vis.leads("l") + " AND l.agency_id = $1 AND l.ref = $2", [actor.agency_id, ref])).rows[0] : null;
    if (!lead || !lead.phones?.length) return { error: "lead" };
    target = await findOrCreate(pool, actor.agency_id, { phone: lead.phones[0], name: lead.name, brokerId: actor.id });
  } else {
    target = await findOrCreate(pool, actor.agency_id, { phone: to.phone, name: to.name, brokerId: actor.id });
  }
  if (!target) return { error: "phone" };
  if (listing.owner_id === target.id) return { error: "same" };
  if (listing.owner_id) await addEvent(pool, actor.agency_id, listing.owner_id, actor.id, "unit_moved_out", { code: listing.code, to: target.id });
  await link(pool, actor.agency_id, { ...listing, owner_id: null }, target.id, actor.id, "unit_moved_in");
  const phone = target.phones[0] ? `+${target.phones[0]}` : null;
  await pool.query(
    `UPDATE listings SET details = (details - 'owner_name' - 'owner_phone' - 'owner_lead') || jsonb_strip_nulls(jsonb_build_object('owner_name', $3::text, 'owner_phone', $4::text)),
            version = version + 1, updated_at = now() WHERE id = $1 AND agency_id = $2`,
    [listing.id, actor.agency_id, target.name, phone]
  );
  logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "unit_owner_moved", status: "success", metadata: { code: listing.code, from: listing.owner_id, to: target.id } });
  return { ok: true, owner: target };
}

/** The lead with this profile's phone, when this viewer may see it (the two-way link shown on the lead and owner pages). */
async function leadFor(pool, viewer, owner) {
  const phones = (owner.phones || []).map((p) => `+${p}`);
  if (!phones.length) return null;
  const { rows } = await pool.query(
    "SELECT l.ref, l.name, l.assigned_broker_id, l.agency_id FROM leads l WHERE " + Vis.leads("l") + " AND l.agency_id = $1 AND l.phones && $2::text[] ORDER BY l.created_at LIMIT 1",
    [viewer.agency_id, phones]
  );
  const lead = rows[0];
  if (!lead) return null;
  return isManager(viewer) || lead.assigned_broker_id === viewer.id ? lead : null;
}

/** The profile for a lead's phone, when this viewer may see it (shown on the lead page). */
async function forLead(pool, viewer, lead) {
  const digits = (lead.phones || []).map((p) => String(p).replace(/\D/g, "")).filter(Boolean);
  if (!digits.length) return null;
  const { rows } = await pool.query("SELECT id FROM unit_owners WHERE agency_id = $1 AND phones && $2::text[] LIMIT 1", [viewer.agency_id, digits]);
  return rows[0] ? getFor(pool, viewer, rows[0].id) : null;
}

module.exports = { findByPhone, findOrCreate, syncFromListing, getFor, listFor, history, edit, remove, reassign, leadFor, forLead };
