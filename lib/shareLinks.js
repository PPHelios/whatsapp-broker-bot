// lib/shareLinks.js — Client share links: /<agency-slug>/<unit-code>?s=<token> (token stored hashed),
// open counting and the "client opened" alert to the broker who shared it.
"use strict";

const crypto = require("crypto");
const Links = require("./links");
const { notify } = require("./dispatcher");

const ALERT_EVERY_HOURS = 6;
// Link previews and crawlers fetch the page too; they are not the client.
const BOT_UA = /(whatsapp|facebookexternalhit|facebot|meta-externalagent|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|applebot|yandex|baiduspider|duckduckbot|embedly|pinterest|bot\b|crawler|spider|preview|headless|curl|wget|python-requests|node-fetch)/i;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const looksLikeToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);
const isBot = (ua) => !ua || BOT_UA.test(ua);

/** New share link for an active listing. Returns { token, url }. */
async function createShareLink(pool, broker, listing, { channel = "whatsapp", lang = "ar" } = {}) {
  const { rows } = await pool.query("SELECT slug FROM agencies WHERE id = $1", [listing.agency_id]);
  const slug = rows[0]?.slug;
  if (!slug || listing.agency_id !== broker.agency_id) throw new Error("share link: unknown agency");
  const token = crypto.randomBytes(16).toString("base64url");
  await pool.query(
    "INSERT INTO share_links (token_hash, agency_id, listing_id, broker_id, channel, lang) VALUES ($1, $2, $3, $4, $5, $6)",
    [sha256(token), listing.agency_id, listing.id, broker.id, channel, lang === "en" ? "en" : "ar"]
  );
  return { token, url: Links.unitPageUrl(slug, listing.code, token) };
}

/**
 * The link, unit, agency and sharing broker for a public URL, or null. The slug, the code and the
 * token must all match the same agency and unit; anything else is "not found".
 */
async function resolveShareLink(pool, slug, code, token) {
  if (!looksLikeToken(token)) return null;
  const { rows } = await pool.query(
    `SELECT s.token_hash, s.broker_id AS share_broker_id, s.open_count, s.last_alert_at, s.lang AS link_lang, l.*,
            a.name AS agency_name, a.logo_url AS agency_logo_url, a.phone AS agency_phone, a.slug AS agency_slug
     FROM share_links s
     JOIN listings l ON l.id = s.listing_id AND l.agency_id = s.agency_id
     JOIN agencies a ON a.id = s.agency_id
     WHERE s.token_hash = $1 AND a.slug = $2 AND l.code_norm = upper($3)
       AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [sha256(token), String(slug).toLowerCase(), String(code)]
  );
  const r = rows[0];
  if (!r) return null;
  const { token_hash, share_broker_id: broker_id, open_count, last_alert_at, link_lang, agency_name, agency_logo_url, agency_phone, agency_slug, ...listing } = r;
  let broker = null;
  if (broker_id) {
    const b = await pool.query(
      "SELECT id, agency_id, name, phone_number, phone_normalized, contact_phone, preferred_lang, is_active FROM brokers WHERE id = $1 AND agency_id = $2",
      [broker_id, listing.agency_id]
    );
    broker = b.rows[0] || null;
  }
  return {
    link: { token_hash, broker_id, open_count, last_alert_at, lang: link_lang },
    listing,
    agency: { id: listing.agency_id, name: agency_name, logo_url: agency_logo_url, phone: agency_phone, slug: agency_slug },
    broker
  };
}

/**
 * Counts a client open (never a link preview or the agency's own signed-in brokers) and alerts the
 * broker who shared the link, at most once per ALERT_EVERY_HOURS per link.
 * @returns {Promise<{ counted: boolean, alerted: boolean, opens: number }>}
 */
async function recordOpen(pool, resolved, { userAgent = "", viewerAgencyId = null } = {}) {
  const { link, listing, broker } = resolved;
  if (isBot(userAgent) || viewerAgencyId === listing.agency_id) return { counted: false, alerted: false, opens: link.open_count };
  const { rows } = await pool.query(
    `UPDATE share_links SET open_count = open_count + 1, last_opened_at = NOW(), first_opened_at = COALESCE(first_opened_at, NOW()),
       last_alert_at = CASE WHEN last_alert_at IS NULL OR last_alert_at < NOW() - make_interval(hours => $2) THEN NOW() ELSE last_alert_at END
     WHERE token_hash = $1
     RETURNING open_count, (last_alert_at = last_opened_at) AS alert`,
    [link.token_hash, ALERT_EVERY_HOURS]
  );
  const opens = rows[0]?.open_count || 0;
  const alert = Boolean(rows[0]?.alert) && broker && broker.is_active;
  if (alert) {
    const en = broker.preferred_lang === "en";
    const text = en
      ? `👀 Your client opened the link for #${listing.code}${opens > 1 ? ` (${opens} opens)` : ""}. A good moment to follow up.`
      : `👀 العميل فتح رابط الوحدة #${listing.code}${opens > 1 ? ` (${opens} مرات)` : ""}. وقت مناسب تتابع معاه.`;
    await notify(broker, text, { pool, kind: "share_opened" });
  }
  await pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, metadata, created_at)
       VALUES ($1, $2, $3, 'share_opened', 'success', $4::jsonb, NOW())`,
      [listing.agency_id, broker?.id || null, listing.code, JSON.stringify({ opens, alerted: Boolean(alert) })]
    )
    .catch(() => {});
  return { counted: true, alerted: Boolean(alert), opens };
}

/** Client copy text plus a fresh share link (WhatsApp); the copy alone if the unit is not active. */
async function clientCopyWithLink(pool, broker, listing, lang, copyText) {
  if (listing.status !== "active") return copyText;
  try {
    const { url } = await createShareLink(pool, broker, listing, { channel: "whatsapp", lang });
    return `${copyText}\n\n🔗 ${lang === "en" ? "Photos and details" : "الصور والتفاصيل"}: ${url}`;
  } catch (err) {
    console.warn("Share link failed:", err.message);
    return copyText;
  }
}

/** A broker's links for a unit, newest first, with their opens. */
async function linksFor(pool, broker, listing) {
  const { rows } = await pool.query(
    `SELECT channel, created_at, open_count, last_opened_at FROM share_links
     WHERE agency_id = $1 AND listing_id = $2 AND broker_id = $3 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 20`,
    [broker.agency_id, listing.id, broker.id]
  );
  return rows;
}

module.exports = { ALERT_EVERY_HOURS, BOT_UA, isBot, createShareLink, resolveShareLink, recordOpen, clientCopyWithLink, linksFor };
