// lib/authz.js — Who may change a listing (the single copy; routes and services call this)
"use strict";

const MANAGER_ROLES = ["admin", "owner", "manager"];

/** Same agency is required for everything; changing a unit needs ownership or a manager role. */
function canView(broker, listing) {
  return Boolean(broker && listing && broker.agency_id && listing.agency_id === broker.agency_id);
}

function canEdit(broker, listing) {
  if (!broker || !listing) return false;
  if (listing.agency_id && listing.agency_id !== broker.agency_id) return false;
  if (MANAGER_ROLES.includes(String(broker.role || "").toLowerCase())) return true;
  return listing.broker_id === broker.id;
}

module.exports = { MANAGER_ROLES, canView, canEdit };
