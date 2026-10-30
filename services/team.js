// services/team.js — Managers run their team from the website (5.5): invite a broker (name, mobile, role) and hand them
// a one-time Telegram start link (lib/tgLink.js, 7 days), issue a fresh link to someone not linked yet, deactivate or
// bring back a broker. Every action is the manager's own agency only; a mobile registered with another agency is
// refused, never moved. Admin and owner roles stay with onboarding (npm run onboard).
"use strict";

const Phone = require("../domain/phone");
const TgLink = require("../lib/tgLink");
const Brokers = require("./brokers");
const Billing = require("./billing");
const { MANAGER_ROLES, isAgencyOwner } = require("../lib/authz");
const { getConfig } = require("../config");

const INVITE_ROLES = ["broker", "manager"];
const isManager = (b) => MANAGER_ROLES.includes(String(b?.role || "").toLowerCase());
const TOP_ROLES = ["admin", "owner"];
/** A manager may act on brokers and managers; only an admin or owner may act on an admin or owner. */
const mayActOn = (actor, targetRole) =>
  !TOP_ROLES.includes(String(targetRole || "").toLowerCase()) || TOP_ROLES.includes(String(actor?.role || "").toLowerCase());

/** The agency's brokers with what the team page shows (no client data): active by name, then former brokers, longest gone last. Never deleted. */
async function listTeam(pool, manager) {
  if (!isManager(manager)) return null;
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.role, b.is_active, b.phone_number, b.preferred_lang, b.last_active_at, b.telegram_linked_at,
            b.away_until, b.deactivated_at, b.notify_prefs, b.target_deals, b.target_commission, (b.telegram_chat_id IS NOT NULL) AS telegram,
            (SELECT max(t.expires_at) FROM telegram_link_tokens t WHERE t.broker_id = b.id AND t.used_at IS NULL AND t.expires_at > NOW()) AS link_until
       FROM brokers b WHERE b.agency_id = $1
      ORDER BY b.is_active DESC, CASE WHEN b.is_active THEN b.name END, b.deactivated_at DESC NULLS LAST, b.name`,
    [manager.agency_id]
  );
  return rows;
}

/**
 * A start link for one of the manager's brokers: { url, broker } or { error }. Never for someone already on Telegram
 * (tapping a link moves the account to whoever taps it) and never for a role above the manager's.
 */
async function startLinkFor(pool, manager, brokerId, { username = getConfig().telegram.botUsername } = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  if (!TgLink.startLink(username, "x")) return { error: "no_bot" };
  const { rows } = await pool.query("SELECT id, agency_id, name, role, phone_number, is_active, telegram_chat_id FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  const broker = rows[0];
  if (!broker) return { error: "not_found" };
  if (!mayActOn(manager, broker.role)) return { error: "rank" };
  if (!broker.is_active) return { error: "inactive" };
  if (broker.telegram_chat_id) return { error: "linked" };
  return { url: TgLink.startLink(username, await TgLink.issueLinkToken(pool, broker)), broker };
}

/**
 * Adds a broker to the manager's agency (or reactivates one of theirs with that mobile) and returns their start link.
 * @param {Object} input - { name, phone, role, lang }
 * @returns {Promise<{ ok: true, broker, url, created } | { error }>}
 */
async function invite(pool, manager, input = {}, opts = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  const name = String(input.name || "").trim().slice(0, 80);
  const digits = Phone.normalizePhone(input.phone);
  const role = INVITE_ROLES.includes(String(input.role || "broker")) ? String(input.role || "broker") : null;
  if (!name) return { error: "name" };
  if (!digits || !Phone.isEgyptMobile(digits)) return { error: "phone" };
  if (!role) return { error: "role" };
  // Only the agency owner adds managers; managers add brokers.
  if (role === "manager" && !isAgencyOwner(manager)) return { error: "forbidden" };
  const lang = input.lang === "en" ? "en" : "ar";
  const { rows: found } = await pool.query("SELECT id, agency_id, role, is_active FROM brokers WHERE phone_normalized = $1", [digits]);
  let brokerId;
  let created = false;
  if (found[0] && found[0].agency_id !== manager.agency_id) return { error: "phone_taken" };
  if (found[0] && !mayActOn(manager, found[0].role)) return { error: "rank" };
  // A new or returning broker takes a seat; the plan's seats are the ceiling (existing ones are never removed).
  if (!found[0]?.is_active && !(await Billing.seatAvailable(pool, manager.agency_id))) return { error: "seats" };
  if (found[0]) {
    // One of ours: bring them back; an admin or owner keeps their role.
    const keep = !INVITE_ROLES.includes(String(found[0].role || "").toLowerCase());
    await pool.query("UPDATE brokers SET name = $2, role = CASE WHEN $4 THEN role ELSE $3 END, is_active = true, deactivated_at = NULL WHERE id = $1", [found[0].id, name, role, keep]);
    brokerId = found[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [manager.agency_id, digits, name, role, lang]
    );
    brokerId = rows[0].id;
    created = true;
  }
  const link = await startLinkFor(pool, manager, brokerId, opts);
  const { rows: b } = await pool.query("SELECT id, name, role, phone_number, preferred_lang FROM brokers WHERE id = $1", [brokerId]);
  return { ok: true, broker: b[0], url: link.url || null, created, noBot: link.error === "no_bot" };
}

/** Deactivates one of the manager's brokers (never themselves, never a role above theirs); their leads go to the unassigned pool. */
async function deactivate(pool, manager, brokerId, { now = new Date() } = {}) {
  if (!isManager(manager)) return { error: "forbidden" };
  if (brokerId === manager.id) return { error: "self" };
  const { rows } = await pool.query("SELECT role FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, manager.agency_id]);
  if (!rows[0]) return { error: "not_found" };
  if (!mayActOn(manager, rows[0].role)) return { error: "rank" };
  return Brokers.deactivateBroker(pool, { agencyId: manager.agency_id, brokerId, actorId: manager.id, now });
}

/** The message a manager sends a new broker from their own WhatsApp: what WehdatHub is and the start link. */
function inviteText(broker, url, agencyName) {
  const en = broker.preferred_lang === "en";
  return en
    ? `Hi ${broker.name}! ${agencyName} added you to WehdatHub, our units and clients assistant on Telegram.\n1. Install Telegram if you don't have it.\n2. Tap this link (works once, for 7 days): ${url}`
    : `أهلاً ${broker.name}! ${agencyName} ضافك على WehdatHub، مساعد الوحدات والعملاء بتاعنا على تيليجرام.\n١. نزّل تيليجرام لو مش عندك.\n٢. دوس على اللينك ده (يشتغل مرة واحدة، لمدة ٧ أيام): ${url}`;
}

/**
 * The agency owner moves a broker to manager or back. Never their own role, never an admin or owner.
 * Pending private-data requests are not moved here: each approval re-reads the approver's role.
 * @returns {Promise<{ ok: true, broker, from, to } | { error }>}
 */
async function changeRole(pool, owner, brokerId, newRole) {
  if (!isAgencyOwner(owner)) return { error: "forbidden" };
  if (!INVITE_ROLES.includes(String(newRole || ""))) return { error: "role" };
  if (brokerId === owner.id) return { error: "self" };
  const { rows } = await pool.query("SELECT id, name, role FROM brokers WHERE id = $1 AND agency_id = $2", [brokerId, owner.agency_id]);
  if (!rows[0]) return { error: "not_found" };
  const from = String(rows[0].role || "").toLowerCase();
  if (TOP_ROLES.includes(from)) return { error: "rank" };
  if (from === newRole) return { error: "same" };
  await pool.query("UPDATE brokers SET role = $2 WHERE id = $1", [brokerId, newRole]);
  return { ok: true, broker: rows[0], from, to: newRole };
}

module.exports = { INVITE_ROLES, listTeam, startLinkFor, invite, deactivate, inviteText, changeRole };
