// services/leadRequests.js — What a buyer or tenant is looking for (Release 3 step 7). A request is a saved search
// tied to the lead (saved_searches.lead_id, up to 3 per lead, several places each), owned by the lead's broker and
// alerting by default. Saving one records the units that already fit it (lead_matches, status new, shown and never
// alerted), so the match sweep (services/matchSweep.js) only alerts on units that newly fit.
"use strict";

const Leads = require("./leads");
const Search = require("./search");
const Authz = require("../lib/authz");
const Card = require("../domain/leadCard");
const Phone = require("../domain/phone");
const Q = require("../domain/searchQuery");
const SearchLink = require("../domain/searchLink");
const { withTransaction } = require("../lib/db");
const Vis = require("../lib/visibility");

const MAX_REQUESTS = 3;
const SHOWN = 5;
const RECORDED = 200; // matches recorded when a request is saved (more are simply never alerted)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lead's requests, oldest first. */
async function listRequests(pool, actor, lead) {
  const { rows } = await pool.query(
    "SELECT id, filters, alerts_enabled, created_at, updated_at FROM saved_searches WHERE agency_id = $1 AND lead_id = $2 ORDER BY created_at, id",
    [actor.agency_id, lead.id]
  );
  return rows.map((r) => ({ ...r, filters: SearchLink.sanitizeFilters(r.filters) }));
}

/** Units that fit the filters now (the strict search, same SQL as search). → { total, ids, rows (first 5) } */
async function currentMatches(pool, agencyId, filters, { limit = RECORDED } = {}) {
  const { sql, params } = Search.buildSearchQuery(agencyId, { filters }, { limit });
  const { rows } = await pool.query(sql, params);
  return { total: rows.length ? Number(rows[0].total_count) : 0, ids: rows.map((r) => r.id), rows: rows.slice(0, SHOWN) };
}

/**
 * Adds a request to a lead, or replaces one (requestId).
 * @returns {Promise<{ ok, request, lead, matches: { total, rows } } | { error: "not_found"|"forbidden"|"request_empty"|"too_many_requests" }>}
 */
async function saveRequest(pool, actor, leadKey, rawFilters, { requestId = null, now = new Date() } = {}) {
  const lead = await Leads.getLead(pool, actor, leadKey);
  if (!lead) return { error: "not_found" };
  if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
  const filters = SearchLink.sanitizeFilters(rawFilters || {});
  if (!filters || !Q.hasAnyFilter({ filters }) || filters.code) return { error: "request_empty" };
  if (requestId && !UUID.test(String(requestId))) return { error: "not_found" };
  const name = Card.requestSummary(filters, "ar").replace(/\s+/g, " ").trim().slice(0, 80) || "طلب";
  const owner = lead.assigned_broker_id || actor.id;
  const found = await currentMatches(pool, actor.agency_id, filters);

  const out = await withTransaction(pool, async (client) => {
    // One writer per lead, so two taps can't make a fourth request.
    await client.query("SELECT 1 FROM leads WHERE " + Vis.leads("leads") + " AND id = $1 AND agency_id = $2 FOR UPDATE", [lead.id, actor.agency_id]);
    let request;
    if (requestId) {
      const { rows } = await client.query(
        `UPDATE saved_searches SET filters = $4::jsonb, name = $5, broker_id = $6, updated_at = $7
          WHERE id = $1 AND agency_id = $2 AND lead_id = $3 RETURNING id, filters, alerts_enabled, created_at`,
        [requestId, actor.agency_id, lead.id, JSON.stringify(filters), name, owner, now.toISOString()]
      );
      if (!rows[0]) return { error: "not_found" };
      request = rows[0];
      // Units that fit the old request but not the new one may alert later if they come to fit; nothing else changes.
      await client.query("DELETE FROM lead_matches WHERE agency_id = $1 AND search_id = $2 AND status = 'new' AND NOT (listing_id = ANY($3::uuid[]))", [
        actor.agency_id,
        request.id,
        found.ids
      ]);
    } else {
      const { rows: n } = await client.query("SELECT count(*)::int AS n FROM saved_searches WHERE agency_id = $1 AND lead_id = $2", [actor.agency_id, lead.id]);
      if (n[0].n >= MAX_REQUESTS) return { error: "too_many_requests" };
      const { rows } = await client.query(
        `INSERT INTO saved_searches (agency_id, broker_id, lead_id, name, filters, alerts_enabled, last_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, true, $6, $6, $6) RETURNING id, filters, alerts_enabled, created_at`,
        [actor.agency_id, owner, lead.id, name, JSON.stringify(filters), now.toISOString()]
      );
      request = rows[0];
    }
    if (found.ids.length) {
      await client.query(
        `INSERT INTO lead_matches (agency_id, lead_id, search_id, listing_id, status, created_at)
         SELECT $1, $2, $3, unnest($4::uuid[]), 'new', $5 ON CONFLICT (search_id, listing_id) DO NOTHING`,
        [actor.agency_id, lead.id, request.id, found.ids, now.toISOString()]
      );
    }
    return { request };
  });
  if (out.error) return out;
  // The timeline (and the 10-minute undo of the event itself; the request stays until removed).
  const ev = await Leads.noteRequest(pool, actor, lead.id, filters, { now, requestId: out.request.id });
  return { ok: true, request: { ...out.request, filters }, lead: ev.lead || lead, matches: { total: found.total, rows: found.rows } };
}

/** Removes a request (and its recorded matches). */
async function removeRequest(pool, actor, leadKey, requestId) {
  const lead = await Leads.getLead(pool, actor, leadKey);
  if (!lead) return { error: "not_found" };
  if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
  if (!UUID.test(String(requestId))) return { error: "not_found" };
  const { rowCount } = await pool.query("DELETE FROM saved_searches WHERE id = $1 AND agency_id = $2 AND lead_id = $3", [requestId, actor.agency_id, lead.id]);
  return rowCount ? { ok: true, lead } : { error: "not_found" };
}

/**
 * "🔥 N clients want this unit": the agency's open leads with an alerting request this unit fits (the same SQL as
 * search, on this unit only). The count is the agency's; the leads listed are only those the broker may see.
 * @returns {Promise<{ total, leads: [{ id, ref, name, phone_e164 }], others }>}
 */
async function whoWants(pool, actor, listing) {
  if (!listing?.id || listing.agency_id !== actor.agency_id) return { total: 0, leads: [], others: 0 };
  const { rows } = await pool.query(
    `SELECT s.filters, l.id, l.ref, l.name, l.phone_e164, l.agency_id, l.assigned_broker_id
       FROM saved_searches s JOIN leads l ON l.id = s.lead_id AND l.agency_id = s.agency_id
      WHERE ${Vis.leads("l")} AND s.agency_id = $1 AND s.alerts_enabled AND l.stage NOT IN ('won', 'lost')
      ORDER BY l.last_activity_at DESC`,
    [actor.agency_id]
  );
  const fits = new Map();
  for (const r of rows) {
    if (fits.has(r.id)) continue;
    const { sql, params } = Search.buildSearchQuery(actor.agency_id, { filters: SearchLink.sanitizeFilters(r.filters) }, { onlyIds: [listing.id], limit: 1 });
    if ((await pool.query(sql, params)).rows.length) fits.set(r.id, r);
  }
  const all = [...fits.values()];
  const visible = all.filter((l) => Authz.canViewLead(actor, l)).map(({ id, ref, name, phone_e164 }) => ({ id, ref, name, phone_e164 }));
  return { total: all.length, leads: visible, others: all.length - visible.length };
}

/**
 * "Send to client / ابعت للعميل": the client copy and a share link that carries the lead (so the client's opens
 * count for the hot signal), as a wa.me link to the client's number; a match_sent event; the match marked sent.
 * @returns {Promise<{ ok, url, lead } | { error: "not_found"|"forbidden"|"unit" }>}
 */
async function sendToClient(pool, actor, leadKey, listing, { lang = "ar", now = new Date() } = {}) {
  const lead = await Leads.getLead(pool, actor, leadKey);
  if (!lead) return { error: "not_found" };
  if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
  if (!listing || listing.agency_id !== actor.agency_id || listing.status !== "active") return { error: "unit" };
  const clientLang = lead.lang || lang;
  const T = require("../lib/text");
  const ShareLinks = require("../lib/shareLinks");
  const { url } = await ShareLinks.createShareLink(pool, actor, listing, { channel: "whatsapp", lang: clientLang, leadId: lead.id });
  const text = `${T.formatClientListingText(listing, actor, clientLang)}\n\n🔗 ${clientLang === "en" ? "Photos and details" : "الصور والتفاصيل"}: ${url}`;
  const wa = Phone.waMeUrl(lead.phone_e164, text);
  await pool.query("UPDATE lead_matches SET status = 'sent_to_client' WHERE agency_id = $1 AND lead_id = $2 AND listing_id = $3", [actor.agency_id, lead.id, listing.id]);
  const ev = await Leads.logMatchSent(pool, actor, lead.id, listing, { now });
  return { ok: true, url: wa, lead: ev.lead || lead };
}

module.exports = { MAX_REQUESTS, listRequests, currentMatches, saveRequest, removeRequest, whoWants, sendToClient };
