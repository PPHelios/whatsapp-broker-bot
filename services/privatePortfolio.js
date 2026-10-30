// services/privatePortfolio.js — The agency owner's private units and leads. A private item is invisible to brokers and
// managers on every surface (lib/visibility.js); only the agency owner sets it, and every change is logged.
"use strict";

const { isAgencyOwner } = require("../lib/authz");
const { logOperation } = require("../lib/db");

const TABLES = { unit: "listings", lead: "leads" };

/**
 * Marks one unit or lead of the owner's agency private (or public again).
 * @returns {Promise<{ ok: true, private: boolean } | { error: 'forbidden' | 'kind' | 'not_found' }>}
 */
async function setPrivate(pool, owner, kind, id, value) {
  if (!isAgencyOwner(owner)) return { error: "forbidden" };
  const table = TABLES[kind];
  if (!table) return { error: "kind" };
  const { rowCount } = await pool.query(`UPDATE ${table} SET is_private = $3 WHERE id = $1 AND agency_id = $2`, [id, owner.agency_id, Boolean(value)]);
  if (!rowCount) return { error: "not_found" };
  logOperation(pool, { agency_id: owner.agency_id, broker_id: owner.id, operation_type: "portfolio_private", status: "success", metadata: { kind, id, private: Boolean(value) } });
  return { ok: true, private: Boolean(value) };
}

module.exports = { setPrivate };
