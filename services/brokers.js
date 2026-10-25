// services/brokers.js — A broker leaves the agency: deactivated, their web sessions stop at once
// (lib/webAuth.js checks is_active), and their leads go to the unassigned pool for the managers (P6).
"use strict";

const Leads = require("./leads");
const Phone = require("../domain/phone");

/**
 * @param {Object} who - { agencyId, brokerId } or { agencyId, phone }
 * @returns {Promise<{ ok: true, broker, released } | { error: "not_found" }>}
 */
async function deactivateBroker(pool, { agencyId, brokerId = null, phone = null, actorId = null, now = new Date() }) {
  const digits = phone ? Phone.normalizePhone(phone) : null;
  const { rows } = await pool.query(
    `UPDATE brokers SET is_active = false
      WHERE agency_id = $1 AND (id = $2 OR ($2::uuid IS NULL AND phone_normalized = $3))
      RETURNING id, agency_id, name, role, is_active`,
    [agencyId, brokerId, digits]
  );
  const broker = rows[0];
  if (!broker) return { error: "not_found" };
  const { count } = await Leads.releaseBrokerLeads(pool, agencyId, broker.id, { actorId, now });
  return { ok: true, broker, released: count };
}

module.exports = { deactivateBroker };
