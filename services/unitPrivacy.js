// services/unitPrivacy.js — Who sees a unit's secret details (owner, owner phone, commission, co-broker, notes, unit
// number, address and the map pin). The agency chooses: 'restricted' (default: the unit's broker and managers) or
// 'all' (every broker in the agency). A broker who may not see them asks once; a manager says yes, then the agency owner
// (when the agency has one); either can say no. Every switch, ask, answer and managers' Excel export is logged and each
// step is notified. Nothing here ever reaches client pages.
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

/** Active people of the agency by rank: managers (not the owner) and agency owners. */
async function approvers(pool, agencyId) {
  const all = await Notifications.managersOf(pool, agencyId);
  return { managers: all.filter((m) => !isAgencyOwner(m)), owners: all.filter(isAgencyOwner) };
}

const alert = (pool, to, { key, ar, en: eng, bodyAr = "", bodyEn = "", listing }) => {
  const en = to.preferred_lang === "en";
  return Notifications.notifyBroker(pool, to, {
    kind: "manager_alert",
    dedupeKey: key,
    title: en ? eng : ar,
    body: en ? bodyEn : bodyAr,
    url: `/app/units/${encodeURIComponent(listing.code)}#access`,
    listingId: listing.id
  }).catch(() => {});
};

/**
 * A broker asks to see a unit's secret details. The chain: a manager says yes, then the agency owner. Managers hear first
 * (the owner hears first only when the agency has no other manager); every step is logged.
 */
async function requestAccess(pool, broker, listing) {
  if (await canSee(pool, broker, listing)) return { ok: true, already: true };
  const open = await pool.query("SELECT id FROM unit_access_requests WHERE agency_id = $1 AND listing_id = $2 AND broker_id = $3 AND status IN ('pending', 'owner_review') LIMIT 1", [broker.agency_id, listing.id, broker.id]);
  const id = open.rows[0]?.id || (await pool.query("INSERT INTO unit_access_requests (agency_id, listing_id, broker_id) VALUES ($1, $2, $3) RETURNING id", [broker.agency_id, listing.id, broker.id])).rows[0].id;
  logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "secret_details_request", status: "success", metadata: { code: listing.code, request_id: id } });
  if (open.rows[0]) return { ok: true, id };
  const day = new Date().toISOString().slice(0, 10);
  const { managers, owners } = await approvers(pool, broker.agency_id);
  for (const d of managers.length ? managers : owners) {
    if (d.id === broker.id) continue;
    await alert(pool, d, {
      key: `unit_access:${id}:${day}`,
      ar: `🔒 ${broker.name} بيطلب يشوف بيانات ${listing.code} الخاصة`,
      en: `🔒 ${broker.name} asks to see ${listing.code}'s private details`,
      bodyAr: "المالك والعنوان واللوكيشن. رد من صفحة الوحدة.",
      bodyEn: "Owner, address and pin. Answer on the unit page.",
      listing
    });
  }
  return { ok: true, id };
}

/**
 * Open asks this person may answer now: managers see the first step, the agency owner sees the first step (when the agency
 * has no other manager, or to answer for a manager) and every ask a manager passed on. Each row says which step it is at.
 */
async function pendingFor(pool, actor, listing) {
  if (!isManager(actor) || listing.agency_id !== actor.agency_id) return [];
  const { rows } = await pool.query(
    `SELECT r.id, r.created_at, r.status, b.name, m.name AS manager_name FROM unit_access_requests r
       JOIN brokers b ON b.id = r.broker_id LEFT JOIN brokers m ON m.id = r.manager_decided_by
      WHERE r.agency_id = $1 AND r.listing_id = $2 AND r.status IN ('pending', 'owner_review') ORDER BY r.created_at`,
    [actor.agency_id, listing.id]
  );
  return isAgencyOwner(actor) ? rows : rows.filter((r) => r.status === "pending");
}

/** Does this broker have an open ask for the unit? */
async function hasPending(pool, broker, listing) {
  const { rows } = await pool.query("SELECT 1 FROM unit_access_requests WHERE agency_id = $1 AND listing_id = $2 AND broker_id = $3 AND status IN ('pending', 'owner_review') LIMIT 1", [broker.agency_id, listing.id, broker.id]);
  return rows.length > 0;
}

/**
 * A manager or the agency owner answers an ask. A manager's yes passes it to the agency owner (when the agency has one) and
 * tells them; the owner's yes grants access. Either can say no. The asker hears the final answer.
 * @returns {Promise<{ ok: true, status } | { ok: false, reason }>}
 */
async function decide(pool, actor, listing, requestId, approve) {
  if (!isManager(actor) || listing.agency_id !== actor.agency_id) return { ok: false, reason: "not_allowed" };
  const owner = isAgencyOwner(actor);
  const { rows: cur } = await pool.query("SELECT status, broker_id FROM unit_access_requests WHERE id = $1 AND agency_id = $2 AND listing_id = $3", [requestId, actor.agency_id, listing.id]);
  if (!cur[0] || !["pending", "owner_review"].includes(cur[0].status)) return { ok: false, reason: "not_found" };
  if (cur[0].status === "owner_review" && !owner) return { ok: false, reason: "not_allowed" };
  const hasOwner = owner || (await approvers(pool, actor.agency_id)).owners.length > 0;
  const passOn = approve && cur[0].status === "pending" && !owner && hasOwner;
  const next = !approve ? "declined" : passOn ? "owner_review" : "approved";
  const { rows } = await pool.query(
    passOn
      ? `UPDATE unit_access_requests SET status = 'owner_review', manager_decided_by = $3, manager_decided_at = now()
          WHERE id = $1 AND agency_id = $2 AND listing_id = $4 AND status = 'pending' RETURNING broker_id`
      : `UPDATE unit_access_requests SET status = $5, decided_by = $3, decided_at = now()
          WHERE id = $1 AND agency_id = $2 AND listing_id = $4 AND status IN ('pending', 'owner_review') RETURNING broker_id`,
    passOn ? [requestId, actor.agency_id, actor.id, listing.id] : [requestId, actor.agency_id, actor.id, listing.id, next]
  );
  if (!rows[0]) return { ok: false, reason: "not_found" };
  logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: "secret_details_decision", status: "success", metadata: { code: listing.code, request_id: requestId, approved: Boolean(approve), step: owner ? "owner" : "manager", result: next } });
  const asker = (await pool.query("SELECT * FROM brokers WHERE id = $1 AND agency_id = $2", [rows[0].broker_id, actor.agency_id])).rows[0];
  if (passOn) {
    for (const o of (await approvers(pool, actor.agency_id)).owners) {
      await alert(pool, o, {
        key: `unit_access_owner:${requestId}`,
        ar: `🔒 ${actor.name} وافق: ${asker?.name || ""} عايز يشوف بيانات ${listing.code} الخاصة`,
        en: `🔒 ${actor.name} agreed: ${asker?.name || ""} wants ${listing.code}'s private details`,
        bodyAr: "محتاج موافقتك. رد من صفحة الوحدة.",
        bodyEn: "Your approval is needed. Answer on the unit page.",
        listing
      });
    }
    return { ok: true, status: next };
  }
  if (asker) {
    await alert(pool, asker, {
      key: `unit_access_answer:${requestId}`,
      ar: approve ? `✅ تقدر تشوف بيانات ${listing.code} الخاصة` : `${listing.code}: الطلب اتقفل من غير موافقة`,
      en: approve ? `✅ You can see ${listing.code}'s private details` : `${listing.code}: access not given`,
      listing
    });
  }
  return { ok: true, status: next };
}

module.exports = { SCOPES, SECRET_DETAILS, GRANT_DAYS, scopeOf, setScope, canSee, redact, forBroker, pinOf, mapsUrl, parsePin, setPin, requestAccess, pendingFor, hasPending, decide };
