// services/bulk.js — Bulk edit of selected units: status changes and a price change by percent.
// Each unit goes through the same lock, authorization and applyListingPatch as a single edit.
"use strict";

const Store = require("../lib/listingStore");
const Edits = require("../lib/edits");
const Authz = require("../lib/authz");

const ACTIONS = ["sold", "archive", "available", "price_pct"];
const STATUS_FOR = { sold: "sold", archive: "archived", available: "active" };
const MAX_UNITS = 200;
const PCT_RANGE = [-50, 100];

const isDeveloper = (l) => l.is_primary_developer || l.inventory_type === "developer_model";

/**
 * @param {Object} opts - { codes: string[], action, pct }
 * @returns {Promise<{ updated, forbidden, missing, skipped, conflicts }>} codes per outcome
 * @throws {Error} code INVALID_BULK for an unknown action, a bad percent or too many units
 */
async function bulkUpdate(pool, broker, { codes = [], action, pct = null }) {
  const list = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  const p = Number(pct);
  if (!ACTIONS.includes(action) || !list.length || list.length > MAX_UNITS || (action === "price_pct" && !(p >= PCT_RANGE[0] && p <= PCT_RANGE[1] && p !== 0))) {
    throw Object.assign(new Error("Invalid bulk edit"), { code: "INVALID_BULK" });
  }
  const out = { updated: [], forbidden: [], missing: [], skipped: [], conflicts: [] };
  for (const code of list) {
    const res = await Edits.withCodeLock(pool, broker.agency_id, code, async (client) => {
      const listing = await Store.findByCode(client, broker.agency_id, code, { forUpdate: true });
      if (!listing) return { rollback: true, outcome: "missing" };
      if (!Authz.canEdit(broker, listing)) return { rollback: true, outcome: "forbidden" };
      let patch;
      if (action === "price_pct") {
        // Developer prices follow the approved payment matrix (EDT-04).
        if (isDeveloper(listing) || !(Number(listing.price_value) > 0)) return { rollback: true, outcome: "skipped" };
        patch = { price_value: Math.round((Number(listing.price_value) * (1 + p / 100)) / 1000) * 1000 };
      } else {
        patch = { status: STATUS_FOR[action] };
      }
      const r = await Store.applyListingPatch(client, broker, { listing, patch });
      if (r.conflict) return { rollback: true, outcome: "conflicts" };
      return { outcome: "updated", code: r.listing.code };
    });
    out[res.outcome].push(res.code || code);
  }
  return out;
}

module.exports = { ACTIONS, MAX_UNITS, PCT_RANGE, bulkUpdate };
