// lib/visibility.js — The one place that says which units (listings) and leads a read may return.
// Every SELECT that serves a person or a job puts one of these conditions in its WHERE, so a rule such as "the agency
// owner's private items are hidden" is kept here once, not in every query. tests/visibility-guard.test.js fails when a
// read on listings or leads skips it; reads written before the helper existed are listed in tests/visibility-baseline.json.
//
// The viewer travels with the request (website session or bot turn) in an AsyncLocalStorage store, so no call site passes
// it. The test is null-safe (IS NOT TRUE) because the alias may sit on the outer side of a LEFT JOIN. Anything outside a request (jobs, digests, match alerts) has no viewer and never sees a private item. Only the
// agency owner, as the viewer, sees them.
"use strict";

const { AsyncLocalStorage } = require("async_hooks");
const { isAgencyOwner } = require("./authz");

const store = new AsyncLocalStorage();

/** Runs fn with `viewer` (a broker row) as the one who is looking; no viewer means a job. */
const run = (viewer, fn) => store.run({ viewer }, fn);
/** Runs fn as the system: private items stay hidden even inside a request (alerts to other people). */
const asSystem = (fn) => store.run({ viewer: null }, fn);
const ownerLooking = () => isAgencyOwner(store.getStore()?.viewer);

const cond = (tag, alias) => (ownerLooking() ? `/*vis:${tag}*/ TRUE` : `/*vis:${tag}*/ ${alias}.is_private IS NOT TRUE`);

/**
 * SQL condition for units. `alias` is the table alias used in the query (default: the table name).
 * @param {string} [alias]
 * @returns {string}
 */
const units = (alias = "listings") => cond("units", alias);

/**
 * SQL condition for leads. Who may open a lead (assigned broker, managers) stays in lib/authz.js; this one is for
 * items hidden from everybody but the agency owner.
 * @param {string} [alias]
 * @returns {string}
 */
const leads = (alias = "leads") => cond("leads", alias);

/** Reads that must count every row whoever is looking (plan limits, erasure, the owner's own counts). */
const allUnits = () => "/*vis:all*/ TRUE";
const allLeads = () => "/*vis:all*/ TRUE";

module.exports = { units, leads, allUnits, allLeads, run, asSystem };
