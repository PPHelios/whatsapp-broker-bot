// services/activityLog.js — The agency's audit trail for people with authority: who asked for and who answered a request
// to see a unit's private details, inventory exports, and (agency owner only) role changes, the secret-details switch and
// private-portfolio changes. Read from operation_logs; kept 90 days. Managers see the data-request part; the agency owner sees all.
"use strict";

const { isManager, isAgencyOwner } = require("../lib/authz");

const KEEP_DAYS = 90;
const MANAGER_TYPES = ["secret_details_request", "secret_details_decision", "command_inventory_export"];
const OWNER_TYPES = [...MANAGER_TYPES, "secret_details_scope", "team_role_change", "portfolio_private"];
const PAGE = 50;

/** Pages of 50, newest first, or null for someone who may not read the log. */
async function list(pool, viewer, { offset = 0, now = new Date() } = {}) {
  if (!isManager(viewer)) return null;
  const types = isAgencyOwner(viewer) ? OWNER_TYPES : MANAGER_TYPES;
  const since = new Date(now.getTime() - KEEP_DAYS * 24 * 3600 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT o.id, o.created_at, o.operation_type, o.metadata, b.name AS broker_name
       FROM operation_logs o LEFT JOIN brokers b ON b.id = o.broker_id
      WHERE o.agency_id = $1 AND o.operation_type = ANY($2::text[]) AND o.created_at >= $3
      ORDER BY o.created_at DESC, o.id DESC LIMIT $4 OFFSET $5`,
    [viewer.agency_id, types, since, PAGE + 1, offset]
  );
  return { rows: rows.slice(0, PAGE), more: rows.length > PAGE };
}

/** One readable line for a log row. */
function describe(row, lang) {
  const m = row.metadata || {};
  const L = (ar, en) => (lang === "en" ? en : ar);
  switch (row.operation_type) {
    case "secret_details_request":
      return L(`طلب يشوف البيانات الخاصة لـ ${m.code || ""}`, `Asked to see ${m.code || "a unit"}'s private details`);
    case "secret_details_decision":
      return m.approved ? L(`وافق على طلب ${m.code || ""}`, `Approved the ask for ${m.code || "a unit"}`) : L(`رفض طلب ${m.code || ""}`, `Declined the ask for ${m.code || "a unit"}`);
    case "command_inventory_export":
      return L(`نزّل الوحدات (${m.rowsCount ?? ""})`, `Exported the units (${m.rowsCount ?? ""})`);
    case "secret_details_scope":
      return L(`غيّر مين يشوف البيانات الخاصة: ${m.scope}`, `Changed who sees private details: ${m.scope}`);
    case "team_role_change":
      return L(`غيّر دور: ${m.from} ← ${m.to}`, `Changed a role: ${m.from} → ${m.to}`);
    case "portfolio_private":
      return m.private ? L(`خلّى ${m.kind === "lead" ? "عميل" : "وحدة"} خاص`, `Made a ${m.kind} private`) : L(`رجّع ${m.kind === "lead" ? "عميل" : "وحدة"} للفريق`, `Made a ${m.kind} visible again`);
    default:
      return row.operation_type;
  }
}

module.exports = { KEEP_DAYS, PAGE, list, describe };
