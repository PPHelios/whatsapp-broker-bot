// services/unitOwners.js — Unit owner profiles (people with a unit to sell or rent), a separate thing from clients.
// A profile belongs to the agency and is merged by phone. A unit points to its owner (listings.owner_id) and the profile
// is made or found whenever a unit is saved with an owner phone. Who sees a profile:
//   - the agency owner: all;
//   - a manager: every profile except those whose units are all private (a private unit's owner is hidden from managers too);
//   - a broker: the owners of units they may see the secret details of (their own, the agency opened them to all, or a
//     manager approved a request in the last 30 days).
// Managers edit notes and the flag, delete a profile, and move a unit to another owner (a profile, a lead or a new person).
// A broker edits an owner while one of their active units belongs to that owner.
"use strict";

const Phone = require("../domain/phone");
const { isManager, isAgencyOwner, isDataEntry } = require("../lib/authz");

/** Managers and data entry see every owner (VIP owners stay hidden: Vis.owners); brokers see their own units' owners. */
const seesAllOwners = (viewer) => isManager(viewer) || isDataEntry(viewer);
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

/** The agency's next owner code (O-0042): a counter on the agency row, so two saves at once never get the same number. */
async function nextCode(db, agencyId) {
  // The counter never hands out a number at or below the highest existing owner code, so imports or resets cannot clash.
  const { rows } = await db.query(
    `UPDATE agencies SET owner_code_next = GREATEST(owner_code_next, COALESCE((SELECT max(substring(code from 3)::int) FROM unit_owners WHERE agency_id = $1 AND code ~ '^O-[0-9]{1,9}$'), 0) + 1) + 1
      WHERE id = $1 RETURNING owner_code_next - 1 AS n`,
    [agencyId]
  );
  return `O-${String(rows[0]?.n || 1).padStart(4, "0")}`;
}

async function findOrCreate(db, agencyId, { phone, name = null, brokerId = null }) {
  const digits = Phone.normalizePhone(phone);
  if (!digits) return null;
  const found = await db.query("SELECT * FROM unit_owners WHERE agency_id = $1 AND phones @> ARRAY[$2]::text[] ORDER BY created_at LIMIT 1", [agencyId, digits]);
  if (found.rows[0]) {
    if (!found.rows[0].name && name) await db.query("UPDATE unit_owners SET name = $2, updated_at = now() WHERE id = $1", [found.rows[0].id, clean(name, 120)]);
    return found.rows[0];
  }
  const code = await nextCode(db, agencyId);
  const { rows } = await db.query("INSERT INTO unit_owners (agency_id, name, phones, created_by, code) VALUES ($1, $2, ARRAY[$3]::text[], $4, $5) RETURNING *", [agencyId, clean(name, 120), digits, brokerId, code]);
  await addEvent(db, agencyId, rows[0].id, brokerId, "created", { phone: digits, code });
  return rows[0];
}

/** May this person rename an owner right away? Managers, data entry and the agency owner can; a broker asks (see requestRename). */
const canRenameDirectly = (viewer) => isManager(viewer) || isDataEntry(viewer);

/**
 * The broker chose the typed name on a unit draft. Managers and data entry rename the owner (found by phone) at once, history kept.
 * A broker cannot: the typed name becomes a rename request and the unit keeps the saved name until it is approved.
 * → the owner, or { owner, requested: true }
 */
async function renameFromDraft(db, broker, phone, name, { listing = null } = {}) {
  const digits = Phone.normalizePhone(phone);
  const next = clean(name, 120);
  if (!digits || !next) return null;
  const { rows } = await db.query("SELECT * FROM unit_owners WHERE agency_id = $1 AND phones @> ARRAY[$2]::text[] ORDER BY created_at LIMIT 1", [broker.agency_id, digits]);
  const owner = rows[0];
  if (!owner || owner.name === next) return owner || null;
  if (!canRenameDirectly(broker)) {
    await requestRename(db, broker, owner, next, { listing });
    return { owner, requested: true };
  }
  await db.query("UPDATE unit_owners SET name = $2, updated_at = now() WHERE id = $1", [owner.id, next]);
  await addEvent(db, broker.agency_id, owner.id, broker.id, "edited", { name: next });
  return owner;
}

const APPROVER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, telegram_chat_id";

/**
 * Who decides a rename of this owner: the agency owner for a VIP owner; otherwise data entry (when owners are on for them),
 * else the managers, else the agency owner.
 */
async function approversFor(db, owner) {
  const q = (roles) => db.query(`SELECT ${APPROVER_COLS} FROM brokers WHERE agency_id = $1 AND is_active AND lower(role) = ANY($2::text[])`, [owner.agency_id, roles]).then((r) => r.rows);
  if (owner.is_private) return q(["owner"]);
  if (await dataEntryOwnersOn(db, owner.agency_id)) {
    const de = await q(["data_entry"]);
    if (de.length) return de;
  }
  const mgr = await q(["manager", "admin", "team_lead"]);
  if (mgr.length) return mgr;
  return q(["owner"]);
}

/** Asks for a new name. One pending request per owner and name; the approvers are told. → the request id (or null when one is already waiting) */
async function requestRename(db, broker, owner, newName, { listing = null } = {}) {
  const next = clean(newName, 120);
  if (!next) return null;
  const ins = await db.query(
    `INSERT INTO owner_change_requests (agency_id, owner_id, kind, old_value, new_value, requested_by, listing_id) VALUES ($1, $2, 'rename', $3, $4, $5, $6)
     ON CONFLICT (owner_id, lower(new_value)) WHERE status = 'pending' DO NOTHING RETURNING id`,
    [broker.agency_id, owner.id, owner.name, next, broker.id, listing?.id || null]
  );
  if (!ins.rows[0]) return null;
  await addEvent(db, broker.agency_id, owner.id, broker.id, "rename_requested", { name: next });
  // A unit saved with the typed name goes back to the saved name until the request is approved.
  if (listing?.id) await db.query("UPDATE listings SET details = details || jsonb_build_object('owner_name', $3::text) WHERE id = $1 AND agency_id = $2 AND $3::text IS NOT NULL", [listing.id, broker.agency_id, owner.name]);
  try {
    const Notifications = require("../lib/notifications");
    for (const a of await approversFor(db, owner)) {
      await Notifications.notifyBroker(db, a, { kind: "manager_alert", dedupeKey: `owner_rename:${ins.rows[0].id}:${a.id}`, title: `✏️ ${broker.name || "A broker"} asks to rename ${owner.code || "an owner"}: ${owner.name || "—"} → ${next}`, body: "Approve or reject it under Owners → Name requests.", url: "/app/owners/requests" }).catch(() => {});
    }
  } catch { /* the request is saved; a missed alert is not an error */ }
  return ins.rows[0].id;
}

/** May this person decide requests for this owner? The agency owner always; data entry for non-VIP owners (switch on); a manager only when the agency has no data entry. */
async function canDecide(pool, viewer, owner) {
  if (!viewer || viewer.agency_id !== owner.agency_id) return false;
  if (isAgencyOwner(viewer)) return true;
  if (owner.is_private) return false;
  if (isDataEntry(viewer)) return dataEntryOwnersOn(pool, viewer.agency_id);
  if (isManager(viewer)) {
    if (!(await dataEntryOwnersOn(pool, viewer.agency_id))) return true;
    const { rows } = await pool.query("SELECT 1 FROM brokers WHERE agency_id = $1 AND is_active AND lower(role) = 'data_entry' LIMIT 1", [viewer.agency_id]);
    return rows.length === 0;
  }
  return false;
}

/** The pending requests this person may decide. */
async function pendingFor(pool, viewer) {
  const { rows } = await pool.query(
    `SELECT r.id, r.owner_id, r.old_value, r.new_value, r.created_at, o.code, o.is_private, o.agency_id, b.name AS requested_by_name
       FROM owner_change_requests r JOIN unit_owners o ON o.id = r.owner_id LEFT JOIN brokers b ON b.id = r.requested_by
      WHERE r.agency_id = $1 AND r.status = 'pending' ORDER BY r.created_at LIMIT 200`,
    [viewer.agency_id]
  );
  const out = [];
  for (const r of rows) if (await canDecide(pool, viewer, { agency_id: r.agency_id, is_private: r.is_private })) out.push(r);
  return out;
}

/** Approves (the owner takes the new name; units of a non-VIP owner follow) or rejects a request. History and the operation log record it. */
async function decideRequest(pool, viewer, requestId, approve) {
  if (!/^[0-9a-f-]{36}$/i.test(String(requestId))) return { error: "not_found" };
  const { rows } = await pool.query("SELECT r.*, o.is_private, o.name AS current_name, o.code FROM owner_change_requests r JOIN unit_owners o ON o.id = r.owner_id WHERE r.id = $1 AND r.agency_id = $2", [requestId, viewer.agency_id]);
  const r = rows[0];
  if (!r) return { error: "not_found" };
  if (r.status !== "pending") return { error: "decided" };
  if (!(await canDecide(pool, viewer, { agency_id: r.agency_id, is_private: r.is_private }))) return { error: "forbidden" };
  const upd = await pool.query("UPDATE owner_change_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending'", [r.id, approve ? "approved" : "rejected", viewer.id]);
  if (!upd.rowCount) return { error: "decided" };
  if (approve) {
    await pool.query("UPDATE unit_owners SET name = $3, updated_at = now() WHERE id = $1 AND agency_id = $2", [r.owner_id, r.agency_id, r.new_value]);
    await addEvent(pool, r.agency_id, r.owner_id, viewer.id, "edited", { name: r.new_value, approved_request: r.id });
    if (!r.is_private) await pool.query("UPDATE listings SET details = details || jsonb_build_object('owner_name', $3::text) WHERE owner_id = $1 AND agency_id = $2 AND details ? 'owner_name'", [r.owner_id, r.agency_id, r.new_value]);
  } else {
    await addEvent(pool, r.agency_id, r.owner_id, viewer.id, "rename_rejected", { name: r.new_value });
  }
  logOperation(pool, { agency_id: r.agency_id, broker_id: viewer.id, operation_type: approve ? "owner_rename_approved" : "owner_rename_rejected", status: "success", metadata: { request_id: r.id, owner_id: r.owner_id } });
  return { ok: true, approved: Boolean(approve) };
}

/** A broker linked a unit to a VIP owner: the agency owner is told (information only; nothing is blocked). */
async function warnVipLink(db, broker, owner, listing) {
  if (!owner?.is_private || !broker || isAgencyOwner(broker)) return;
  try {
    const Notifications = require("../lib/notifications");
    const { rows } = await db.query(`SELECT ${APPROVER_COLS} FROM brokers WHERE agency_id = $1 AND is_active AND lower(role) = 'owner'`, [owner.agency_id]);
    for (const a of rows) {
      await Notifications.notifyBroker(db, a, { kind: "manager_alert", dedupeKey: `vip_link:${owner.id}:${listing.id}`, title: `⭐ ${broker.name || "A broker"} linked unit ${listing.code} to the VIP owner ${owner.code || ""}`, body: "Information only. The broker sees just their own unit.", url: `/app/owners/${owner.id}` }).catch(() => {});
    }
  } catch { /* information only */ }
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
  if (owner) {
    const wasLinked = listing.owner_id === owner.id;
    await link(db, listing.agency_id, listing, owner.id, broker?.id || null);
    if (!wasLinked) await warnVipLink(db, broker, owner, listing);
  }
  // A VIP owner's name and phone are not kept on the unit: the link stays, the details do not.
  if (owner?.is_private) await db.query("UPDATE listings SET details = details - 'owner_name' - 'owner_phone' WHERE id = $1 AND agency_id = $2", [listing.id, listing.agency_id]);
  return owner;
}

/** Removes the owner's name and phone from every unit linked to a VIP owner (the link stays). */
async function hideOwnerDetails(db, agencyId, ownerId) {
  await db.query("UPDATE listings SET details = details - 'owner_name' - 'owner_phone' WHERE owner_id = $1 AND agency_id = $2", [ownerId, agencyId]);
}

/** Puts the owner's name and phone back on every unit linked to the owner (used when VIP is removed). */
async function restoreOwnerDetails(db, agencyId, ownerId) {
  const { rows } = await db.query("SELECT name, phones FROM unit_owners WHERE id = $1 AND agency_id = $2", [ownerId, agencyId]);
  if (!rows[0]) return;
  const phone = rows[0].phones?.[0] ? `+${rows[0].phones[0]}` : null;
  await db.query(
    `UPDATE listings SET details = (details - 'owner_name' - 'owner_phone') || jsonb_strip_nulls(jsonb_build_object('owner_name', $3::text, 'owner_phone', $4::text)) WHERE owner_id = $1 AND agency_id = $2`,
    [ownerId, agencyId, rows[0].name, phone]
  );
}

/** Whether the agency lets every broker see secret details (the same switch unitPrivacy reads). */
async function scopeIsAll(pool, agencyId) {
  const { rows } = await pool.query("SELECT crm_settings->>'secret_details' AS s FROM agencies WHERE id = $1", [agencyId]);
  return rows[0]?.s === "all";
}

/**
 * On top of Vis.units: a broker sees an owner's unit only when they may see that unit's secret details: their own active unit,
 * every unit when the agency opened secret details to all brokers, or a unit a manager approved for them in the last 30 days.
 * Managers see every unit.
 */
function brokerSees(viewer, scopeAll, alias = "u") {
  if (seesAllOwners(viewer)) return "";
  if (scopeAll) return "";
  const me = String(viewer.id).replace(/[^0-9a-f-]/gi, "");
  return ` AND ((${alias}.broker_id = '${me}'::uuid AND ${alias}.status = 'active') OR EXISTS (SELECT 1 FROM unit_access_requests r WHERE r.listing_id = ${alias}.id AND r.broker_id = '${me}'::uuid AND r.status = 'approved' AND r.decided_at > now() - make_interval(days => 30)))`;
}

/** The agency owner\'s switch: may data entry see and edit owners (never VIP ones)? On by default. */
async function dataEntryOwnersOn(pool, agencyId) {
  const { rows } = await pool.query("SELECT crm_settings->>'data_entry_owners' AS s FROM agencies WHERE id = $1", [agencyId]);
  return rows[0]?.s !== "off";
}

/** Only the agency owner switches it. Logged. */
async function setDataEntryOwners(pool, actor, on) {
  if (!isAgencyOwner(actor)) return { ok: false, reason: "not_allowed" };
  await pool.query("UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('data_entry_owners', $2::text) WHERE id = $1", [actor.agency_id, on ? "on" : "off"]);
  logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "data_entry_owners_switch", status: "success", metadata: { on: Boolean(on) } });
  return { ok: true, on: Boolean(on) };
}

/** Managers and data entry edit any non-VIP owner; a broker edits an owner while one of their active units belongs to that owner. */
async function canEditOwner(pool, viewer, ownerId) {
  if (isManager(viewer)) return true;
  if (isDataEntry(viewer)) {
    if (!(await dataEntryOwnersOn(pool, viewer.agency_id))) return false;
    const { rows: open } = await pool.query("SELECT 1 FROM unit_owners WHERE id = $1 AND agency_id = $2 AND is_private IS NOT TRUE", [ownerId, viewer.agency_id]);
    return open.length > 0;
  }
  const { rows } = await pool.query(
    `SELECT 1 FROM listings WHERE owner_id = $1 AND agency_id = $2 AND broker_id = $3 AND status = 'active' AND ${Vis.units("listings")} LIMIT 1`,
    [ownerId, viewer.agency_id, viewer.id]
  );
  return rows.length > 0;
}

/** May this person see this profile? Returns the profile with its visible units, or null. */
async function getFor(pool, viewer, ownerId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(ownerId))) return null;
  const { rows } = await pool.query(`SELECT * FROM unit_owners WHERE id = $1 AND agency_id = $2 AND ${Vis.owners("unit_owners")}`, [ownerId, viewer.agency_id]);
  if (!rows[0]) return null;
  const scopeAll = await scopeIsAll(pool, viewer.agency_id);
  const { rows: units } = await pool.query(
    `SELECT u.id, u.code, u.status, u.listing_type, u.property_type, u.compound, u.price_value, u.broker_id, u.is_private
       FROM listings u WHERE u.owner_id = $1 AND u.agency_id = $2 AND ${Vis.units("u")}${brokerSees(viewer, scopeAll)} ORDER BY u.created_at DESC`,
    [ownerId, viewer.agency_id]
  );
  const total = (await pool.query("SELECT count(*)::int AS n FROM listings WHERE " + Vis.allUnits() + " AND owner_id = $1 AND agency_id = $2", [ownerId, viewer.agency_id])).rows[0].n;
  // Hidden when none of its units is visible to this viewer; a manager still sees a profile that has no units at all.
  if (!units.length && !(isManager(viewer) && total === 0)) return null;
  return { ...rows[0], units, canEdit: await canEditOwner(pool, viewer, ownerId) };
}

/** Pages of profiles this person may see, newest first. */
async function listFor(pool, viewer, { q = "", limit = 50, offset = 0, onlyPrivate = false } = {}) {
  const term = String(q || "").trim();
  const digits = Phone.normalizePhone(term);
  const privateOnly = onlyPrivate && isAgencyOwner(viewer) ? " AND o.is_private" : "";
  const scopeAll = await scopeIsAll(pool, viewer.agency_id);
  const { rows } = await pool.query(
    `SELECT o.*, (SELECT count(*)::int FROM listings u WHERE u.owner_id = o.id AND u.agency_id = o.agency_id AND ${Vis.units("u")}${brokerSees(viewer, scopeAll)}) AS unit_count
       FROM unit_owners o
      WHERE o.agency_id = $1 AND ${Vis.owners("o")}${privateOnly}
        AND (CASE WHEN $2::text = '' THEN true ELSE (o.name ILIKE '%' || $2 || '%' OR upper(o.code) = upper($2) OR ($3::text IS NOT NULL AND o.phones @> ARRAY[$3]::text[])) END)
        AND ((SELECT count(*) FROM listings u WHERE u.owner_id = o.id AND u.agency_id = o.agency_id AND ${Vis.units("u")}${brokerSees(viewer, scopeAll)}) > 0
             ${seesAllOwners(viewer) ? `OR NOT EXISTS (SELECT 1 FROM listings u WHERE ${Vis.allUnits()} AND u.owner_id = o.id AND u.agency_id = o.agency_id)` : ""})
      ORDER BY o.created_at DESC LIMIT $4 OFFSET $5`,
    [viewer.agency_id, term.replace(/[%_\\]/g, (c) => `\\${c}`), digits, limit + 1, offset]
  );
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/** The owner's history, newest first. */
async function history(pool, viewer, ownerId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT e.kind, e.data, e.created_at, b.name AS broker_name FROM unit_owner_events e LEFT JOIN brokers b ON b.id = e.broker_id
      WHERE e.owner_id = $1 AND e.agency_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [ownerId, viewer.agency_id, limit]
  );
  return rows;
}

/** Managers edit the name, phone, notes and flag. A phone already on another profile is refused (no merge yet); a change is logged with both numbers. Units follow the profile. */
async function edit(pool, actor, ownerId, { name, phone, notes, flag }) {
  if (!(await canEditOwner(pool, actor, ownerId))) return { error: "forbidden" };
  const before = (await pool.query("SELECT * FROM unit_owners WHERE id = $1 AND agency_id = $2", [ownerId, actor.agency_id])).rows[0];
  if (!before) return { error: "not_found" };
  if (!(await getFor(pool, actor, ownerId))) return { error: "not_found" };
  const next = { name: clean(name, 120), notes: clean(notes, NOTE_MAX), flag: clean(flag, 200) };
  // A broker cannot change a name: it becomes a request for the approver, and the rest of the edit goes through.
  let requested = false;
  if (!canRenameDirectly(actor) && next.name !== before.name) {
    if (next.name) await requestRename(pool, actor, before, next.name);
    next.name = before.name;
    requested = true;
  }
  // An empty phone keeps the current one; a new one must be valid and not belong to another profile.
  const digits = String(phone ?? "").trim() ? Phone.normalizePhone(phone) : (before.phones || [])[0] || null;
  if (!digits) return { error: "bad_phone" };
  const oldPhone = (before.phones || [])[0] || null;
  if (digits !== oldPhone) {
    const { rows: clash } = await pool.query("SELECT id, name FROM unit_owners WHERE agency_id = $1 AND phones @> ARRAY[$2]::text[] AND id <> $3 LIMIT 1", [actor.agency_id, digits, ownerId]);
    if (clash[0]) return { error: "duplicate", existingId: clash[0].id, existingName: clash[0].name };
  }
  const phones = [digits, ...(before.phones || []).slice(1).filter((p) => p !== digits)];
  await pool.query("UPDATE unit_owners SET name = $3, notes = $4, flag = $5, phones = $6::text[], updated_at = now() WHERE id = $1 AND agency_id = $2", [ownerId, actor.agency_id, next.name, next.notes, next.flag, phones]);
  if (digits !== oldPhone) await addEvent(pool, actor.agency_id, ownerId, actor.id, "edited", { phone_from: oldPhone, phone_to: digits });
  if (next.flag !== before.flag) await addEvent(pool, actor.agency_id, ownerId, actor.id, "flag", { from: before.flag, to: next.flag });
  if (next.notes !== before.notes) await addEvent(pool, actor.agency_id, ownerId, actor.id, "note", { text: next.notes });
  if (next.name !== before.name) await addEvent(pool, actor.agency_id, ownerId, actor.id, "edited", { name: next.name });
  return { ok: true, ...(requested ? { name_requested: true } : {}) };
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

/**
 * Typeahead for the owners search: owners this person may see whose name starts like, or whose code or phone matches, the typed text.
 * A search by code shows the code and name only; a phone is shown only to those who see every owner. → [{ id, code, name, phone? }]
 */
async function suggest(pool, viewer, q, { limit = 8 } = {}) {
  const term = String(q || "").trim().slice(0, 60);
  if (term.length < 2) return [];
  const list = await listFor(pool, viewer, { q: term, limit, offset: 0 });
  const wide = seesAllOwners(viewer);
  const byCode = /^o-?\d+$/i.test(term);
  return list.rows.map((o) => ({ id: o.id, code: o.code, name: o.name, ...(wide && !byCode && o.phones?.[0] ? { phone: `+${o.phones[0]}` } : {}) }));
}

module.exports = { nextCode, requestRename, approversFor, canDecide, pendingFor, decideRequest, suggest, warnVipLink, findByPhone, findOrCreate, renameFromDraft, syncFromListing, hideOwnerDetails, restoreOwnerDetails, getFor, listFor, history, edit, canEditOwner, remove, reassign, leadFor, forLead, dataEntryOwnersOn, setDataEntryOwners };
