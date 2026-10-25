// lib/authz.js — Who may see or change a listing, a lead or a deal (the single copy; routes and services call this)
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

const isManager = (broker) => MANAGER_ROLES.includes(String(broker?.role || "").toLowerCase());
const sameAgency = (broker, row) => Boolean(broker && row && broker.agency_id && row.agency_id === broker.agency_id);

/** Q1: managers see every lead in the agency; a broker sees the leads assigned to them (unassigned: managers only). */
function canViewLead(broker, lead) {
  if (!sameAgency(broker, lead)) return false;
  return isManager(broker) || (Boolean(lead.assigned_broker_id) && lead.assigned_broker_id === broker.id);
}

/** Whoever may see a lead may work it (stage, notes, follow-ups); reassigning needs canManageLeads. */
const canEditLead = (broker, lead) => canViewLead(broker, lead);

/** Assigning, reassigning, export and erase (Q9): managers only. */
const canManageLeads = (broker) => Boolean(broker?.agency_id) && isManager(broker);

/** Q10: a broker sees the deals they closed or have a share in; managers see all of the agency's deals. */
function canViewDeal(broker, deal) {
  if (!sameAgency(broker, deal)) return false;
  if (isManager(broker) || deal.closing_broker_id === broker.id) return true;
  return (deal.shares || []).some((s) => s.broker_id === broker.id);
}

/** The closing broker enters the deal; a manager can correct it. */
function canEditDeal(broker, deal) {
  if (!sameAgency(broker, deal)) return false;
  return isManager(broker) || deal.closing_broker_id === broker.id;
}

module.exports = { MANAGER_ROLES, isManager, canView, canEdit, canViewLead, canEditLead, canManageLeads, canViewDeal, canEditDeal };
