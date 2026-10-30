// lib/visibility.js — The one place that says which units (listings) and leads a read may return.
// Every SELECT that serves a person or a job puts one of these conditions in its WHERE, so a rule such as "the agency
// owner's private items are hidden" (a later patch) is added here once, not in every query. tests/visibility-guard.test.js
// fails when a read on listings or leads skips it; reads written before the helper existed are listed in
// tests/visibility-baseline.json and shrink as they are converted.
"use strict";

/**
 * SQL condition for units. `alias` is the table alias used in the query (default: the table name).
 * Today every unit of the agency is visible, so the condition is TRUE; the private-portfolio patch changes it here only.
 * @param {string} [_alias]
 * @returns {string}
 */
const units = (_alias = "listings") => "/*vis:units*/ TRUE";

/**
 * SQL condition for leads. Who may open a lead (assigned broker, managers) stays in lib/authz.js; this one is for
 * items hidden from everybody.
 * @param {string} [_alias]
 * @returns {string}
 */
const leads = (_alias = "leads") => "/*vis:leads*/ TRUE";

module.exports = { units, leads };
