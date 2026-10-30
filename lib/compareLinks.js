// lib/compareLinks.js — Client comparisons (Release A, C7): /<agency-slug>/compare/<token> compares 2 or 3 of the
// agency's active units side by side. Same rules as share links (lib/shareLinks.js): the token is stored hashed, link
// previews and the agency's own brokers are not counted, and the broker who sent it gets an alert at most every 6 hours.
"use strict";

const crypto = require("crypto");
const Links = require("./links");
const Notifications = require("./notifications");
const Store = require("./listingStore");
const Share = require("./shareLinks");
const { canView } = require("./authz");
const Vis = require("../lib/visibility");

const MAX_UNITS = 3;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const looksLikeToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);

/** Codes typed by the broker ("BD-1, BD-2 BD-3") → up to 3, upper case, once each. */
function parseCodes(input) {
  const out = [];
  for (const c of [].concat(input || []).join(" ").split(/[\s,،]+/)) {
    const code = c.replace(/^#/, "").trim().toUpperCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** New comparison link: { ok, token, url, codes } | { error: "count" | "missing" (codes) }. */
async function createCompareLink(pool, broker, input, { lang = "ar" } = {}) {
  const codes = parseCodes(input);
  if (codes.length < 2 || codes.length > MAX_UNITS) return { error: "count" };
  const listings = [];
  const missing = [];
  for (const code of codes) {
    const l = await Store.findByCode(pool, broker.agency_id, code);
    if (!l || !canView(broker, l) || l.status !== "active") missing.push(code);
    else listings.push(l);
  }
  if (missing.length) return { error: "missing", missing };
  const { rows } = await pool.query("SELECT slug FROM agencies WHERE id = $1", [broker.agency_id]);
  const token = crypto.randomBytes(16).toString("base64url");
  await pool.query("INSERT INTO compare_links (token_hash, agency_id, broker_id, listing_ids, lang) VALUES ($1, $2, $3, $4::uuid[], $5)", [
    sha256(token),
    broker.agency_id,
    broker.id,
    listings.map((l) => l.id),
    lang === "en" ? "en" : "ar"
  ]);
  return { ok: true, token, url: Links.compareUrl(rows[0].slug, token), codes: listings.map((l) => l.code) };
}

/** { link, listings (in the broker's order), agency, broker } for a public URL, or null. */
async function resolveCompareLink(pool, slug, token) {
  if (!looksLikeToken(token)) return null;
  const { rows } = await pool.query(
    `SELECT c.*, a.name AS agency_name, a.logo_url AS agency_logo_url, a.phone AS agency_phone, a.slug AS agency_slug
       FROM compare_links c JOIN agencies a ON a.id = c.agency_id
      WHERE c.token_hash = $1 AND a.slug = $2 AND c.revoked_at IS NULL AND c.expires_at > NOW()`,
    [sha256(token), String(slug).toLowerCase()]
  );
  const link = rows[0];
  if (!link) return null;
  const { rows: units } = await pool.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND id = ANY($1::uuid[]) AND agency_id = $2", [link.listing_ids, link.agency_id]);
  const listings = link.listing_ids.map((id) => units.find((u) => u.id === id)).filter(Boolean);
  let broker = null;
  if (link.broker_id) {
    const b = await pool.query("SELECT id, agency_id, name, role, phone_number, phone_normalized, contact_phone, preferred_lang, is_active, notify_prefs FROM brokers WHERE id = $1 AND agency_id = $2", [link.broker_id, link.agency_id]);
    broker = b.rows[0] || null;
  }
  return {
    link,
    listings,
    agency: { id: link.agency_id, name: link.agency_name, logo_url: link.agency_logo_url, phone: link.agency_phone, slug: link.agency_slug },
    broker
  };
}

/** Counts a client open and alerts the broker (never a link preview or the agency's own brokers). */
async function recordOpen(pool, resolved, { userAgent = "", viewerAgencyId = null } = {}) {
  const { link, broker, listings } = resolved;
  if (Share.isBot(userAgent) || viewerAgencyId === link.agency_id) return { counted: false, alerted: false };
  const { rows } = await pool.query(
    `UPDATE compare_links SET open_count = open_count + 1, last_opened_at = NOW(),
       last_alert_at = CASE WHEN last_alert_at IS NULL OR last_alert_at < NOW() - make_interval(hours => $2) THEN NOW() ELSE last_alert_at END
     WHERE token_hash = $1 RETURNING open_count, (last_alert_at = last_opened_at) AS alert`,
    [link.token_hash, Share.ALERT_EVERY_HOURS]
  );
  const alert = Boolean(rows[0]?.alert) && broker?.is_active;
  if (alert) {
    const en = broker.preferred_lang === "en";
    const codes = listings.map((l) => l.code).join(", ");
    await Notifications.notifyBroker(pool, broker, {
      kind: "share_opened",
      dedupeKey: `compare_opened:${link.token_hash.slice(0, 24)}:${rows[0].open_count}`,
      title: en ? `👀 Your client opened the comparison of ${codes}. A good moment to follow up.` : `👀 العميل فتح المقارنة بين ${codes}. وقت مناسب تتابع معاه.`,
      url: "/app/compare",
      push: { title: en ? "👀 Client opened your comparison" : "👀 العميل فتح المقارنة", body: codes }
    }).catch((e) => console.warn("Compare-open notification failed:", e.message));
  }
  return { counted: true, alerted: Boolean(alert) };
}

/** The broker's recent comparisons with their opens. */
async function linksOf(pool, broker) {
  const { rows } = await pool.query(
    `SELECT c.created_at, c.open_count, c.last_opened_at, c.lang, ARRAY(SELECT l.code FROM unnest(c.listing_ids) WITH ORDINALITY u(id, n) JOIN listings l ON l.id = u.id ORDER BY u.n) AS codes
       FROM compare_links c WHERE ${Vis.units("l")} AND c.agency_id = $1 AND c.broker_id = $2 AND c.revoked_at IS NULL ORDER BY c.created_at DESC LIMIT 20`,
    [broker.agency_id, broker.id]
  );
  return rows;
}

module.exports = { MAX_UNITS, parseCodes, createCompareLink, resolveCompareLink, recordOpen, linksOf };
