// services/unitPrivacy.js — Who sees a unit's secret details (owner, owner phone, commission, co-broker, notes, unit
// number, address and the map pin). The agency chooses: 'restricted' (default: the unit's broker and managers) or
// 'all' (every broker in the agency). A broker who may not see them asks once; the unit's broker or a manager says
// yes or no. Every switch, ask, answer and managers' Excel export is logged. Nothing here ever reaches client pages.
"use strict";

const { isManager, isAgencyOwner } = require("../lib/authz");
const { logOperation } = require("../lib/db");
const Notifications = require("../lib/notifications");

const SCOPES = ["restricted", "all"];
const SECRET_DETAILS = ["owner_name", "owner_phone", "owner_lead", "commission", "co_broker", "notes", "unit_no", "address"];
const GRANT_DAYS = 30;

/** The agency's choice ('restricted' unless a manager opened it to all). */
async function scopeOf(pool, agencyId) {
  const { rows } = await pool.query("SELECT crm_settings->>'secret_details' AS s FROM agencies WHERE id = $1", [agencyId]);
  return rows[0]?.s === "all" ? "all" : "restricted";
}

/** Only the agency owner switches who sees secret details. */
async function setScope(pool, manager, scope) {
  if (!isAgencyOwner(manager) || !SCOPES.includes(scope)) return { ok: false, reason: "not_allowed" };
  await pool.query("UPDATE agencies SET crm_settings = crm_settings || jsonb_build_object('secret_details', $2::text) WHERE id = $1", [manager.agency_id, scope]);
  logOperation(pool, { agency_id: manager.agency_id, broker_id: manager.id, operation_type: "secret_details_scope", status: "success", metadata: { scope } });
  return { ok: true, scope };
}

/** Has this broker an approved ask for this unit in the last 30 days? */
async function granted(pool, broker, listingId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM unit_access_requests WHERE agency_id = $1 AND listing_id = $2 AND broker_id = $3 AND status = 'approved'
        AND decided_at > now() - make_interval(days => $4) LIMIT 1`,
    [broker.agency_id, listingId, broker.id, GRANT_DAYS]
  );
  return rows.length > 0;
}

/** May this broker see the unit's secret details? */
async function canSee(pool, broker, listing, { scope = null } = {}) {
  if (!broker || !listing || listing.agency_id !== broker.agency_id) return false;
  if (isManager(broker) || listing.broker_id === broker.id) return true;
  if ((scope || (await scopeOf(pool, broker.agency_id))) === "all") return true;
  return granted(pool, broker, listing.id);
}

/** The unit without its secret details (for a broker who may not see them). */
function redact(listing) {
  const details = { ...(listing.details || {}) };
  for (const k of SECRET_DETAILS) delete details[k];
  return { ...listing, details, lat: null, lng: null };
}

/** The unit as this broker may see it, and whether anything was hidden. */
async function forBroker(pool, broker, listing) {
  if (await canSee(pool, broker, listing)) return { listing, hidden: false };
  const d = listing.details || {};
  const hadSecrets = SECRET_DETAILS.some((k) => d[k]) || listing.lat != null;
  return { listing: redact(listing), hidden: hadSecrets };
}

/** The pin to use for a unit: its own, else its catalogue project's. */
async function pinOf(pool, listing) {
  if (listing.lat != null && listing.lng != null) return { lat: Number(listing.lat), lng: Number(listing.lng), from: "unit" };
  if (!listing.project_id) return null;
  const { rows } = await pool.query("SELECT lat, lng FROM projects WHERE id = $1 AND agency_id = $2", [listing.project_id, listing.agency_id]);
  const p = rows[0];
  return p && p.lat != null && p.lng != null ? { lat: Number(p.lat), lng: Number(p.lng), from: "project" } : null;
}

const mapsUrl = (pin) => (pin ? `https://maps.google.com/?q=${pin.lat},${pin.lng}` : null);

/**
 * A pin from text: "30.0444, 31.2357", or a Google Maps link carrying @lat,lng, q=lat,lng, ll= or !3d…!4d….
 * Short links (maps.app.goo.gl) carry no numbers, so they are refused with a hint.
 */
function parsePin(text) {
  const s = decodeURIComponent(String(text || "").trim());
  if (!s) return null;
  const pats = [/@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/, /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, /^(-?\d{1,2}\.\d+)\s*[,،\s]\s*(-?\d{1,3}\.\d+)$/];
  for (const p of pats) {
    const m = s.match(p);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

/** Save a unit's pin (its own broker or a manager). pin null clears it. */
async function setPin(pool, actor, listing, pin, { source = "web" } = {}) {
  if (!actor || listing.agency_id !== actor.agency_id || !(isManager(actor) || listing.broker_id === actor.id)) return { ok: false, reason: "not_allowed" };
  await pool.query("UPDATE listings SET lat = $3, lng = $4, updated_at = now() WHERE id = $1 AND agency_id = $2", [listing.id, actor.agency_id, pin?.lat ?? null, pin?.lng ?? null]);
  logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "unit_pin", status: "success", metadata: { code: listing.code, source, cleared: !pin } });
  return { ok: true };
}

/** A broker asks to see a unit's secret details: its broker and the managers hear (once a day per asker). */
async function requestAccess(pool, broker, listing) {
  if (await canSee(pool, broker, listing)) return { ok: true, already: true };
  const open = await pool.query("SELECT id FROM unit_access_requests WHERE agency_id = $1 AND listing_id = $2 AND broker_id = $3 AND status = 'pending' LIMIT 1", [broker.agency_id, listing.id, broker.id]);
  const id = open.rows[0]?.id || (await pool.query("INSERT INTO unit_access_requests (agency_id, listing_id, broker_id) VALUES ($1, $2, $3) RETURNING id", [broker.agency_id, listing.id, broker.id])).rows[0].id;
  logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "secret_details_request", status: "success", metadata: { code: listing.code, request_id: id } });
  const day = new Date().toISOString().slice(0, 10);
  const deciders = await Notifications.managersOf(pool, broker.agency_id);
  if (listing.broker_id && !deciders.some((m) => m.id === listing.broker_id)) {
    const { rows } = await pool.query("SELECT * FROM brokers WHERE id = $1 AND agency_id = $2 AND is_active", [listing.broker_id, broker.agency_id]);
    deciders.push(...rows);
  }
  for (const d of deciders) {
    if (d.id === broker.id) continue;
    const en = d.preferred_lang === "en";
    await Notifications.notifyBroker(pool, d, {
      kind: "manager_alert",
      dedupeKey: `unit_access:${id}:${day}`,
      title: en ? `🔒 ${broker.name} asks to see ${listing.code}'s private details` : `🔒 ${broker.name} بيطلب يشوف بيانات ${listing.code} الخاصة`,
      body: en ? "Owner, address and pin. Answer on the unit page." : "المالك والعنوان واللوكيشن. رد من صفحة الوحدة.",
      url: `/app/units/${encodeURIComponent(listing.code)}#access`,
      listingId: listing.id
    }).catch(() => {});
  }
  return { ok: true, id };
}

/** Open asks for one unit (for its broker or a manager). */
async function pendingFor(pool, actor, listing) {
  if (!(isManager(actor) || listing.broker_id === actor.id) || listing.agency_id !== actor.agency_id) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.created_at, b.name FROM unit_access_requests r JOIN brokers b ON b.id = r.broker_id
      WHERE r.agency_id = $1 AND r.listing_id = $2 AND r.status = 'pending' ORDER BY r.created_at`,
    [actor.agency_id, listing.id]
  );
  return rows;
}

/** Does this broker have an open ask for the unit? */
async function hasPending(pool, broker, listing) {
  const { rows } = await pool.query("SELECT 1 FROM unit_access_requests WHERE agency_id = $1 AND listing_id = $2 AND broker_id = $3 AND status = 'pending' LIMIT 1", [broker.agency_id, listing.id, broker.id]);
  return rows.length > 0;
}

/** The unit's broker or a manager says yes or no; the asker hears. */
async function decide(pool, actor, listing, requestId, approve) {
  if (!(isManager(actor) || listing.broker_id === actor.id) || listing.agency_id !== actor.agency_id) return { ok: false, reason: "not_allowed" };
  const { rows } = await pool.query(
    `UPDATE unit_access_requests SET status = $4, decided_by = $3, decided_at = now()
      WHERE id = $1 AND agency_id = $2 AND listing_id = $5 AND status = 'pending' RETURNING broker_id`,
    [requestId, actor.agency_id, actor.id, approve ? "approved" : "declined", listing.id]
  );
  if (!rows[0]) return { ok: false, reason: "not_found" };
  logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "secret_details_decision", status: "success", metadata: { code: listing.code, request_id: requestId, approved: Boolean(approve) } });
  const asker = (await pool.query("SELECT * FROM brokers WHERE id = $1 AND agency_id = $2", [rows[0].broker_id, actor.agency_id])).rows[0];
  if (asker) {
    const en = asker.preferred_lang === "en";
    await Notifications.notifyBroker(pool, asker, {
      kind: "manager_alert",
      dedupeKey: `unit_access_answer:${requestId}`,
      title: approve ? (en ? `✅ You can see ${listing.code}'s private details` : `✅ تقدر تشوف بيانات ${listing.code} الخاصة`) : en ? `${listing.code}: access not given` : `${listing.code}: الطلب اترفض`,
      url: `/app/units/${encodeURIComponent(listing.code)}`,
      listingId: listing.id
    }).catch(() => {});
  }
  return { ok: true };
}

module.exports = { SCOPES, SECRET_DETAILS, GRANT_DAYS, scopeOf, setScope, canSee, redact, forBroker, pinOf, mapsUrl, parsePin, setPin, requestAccess, pendingFor, hasPending, decide };
