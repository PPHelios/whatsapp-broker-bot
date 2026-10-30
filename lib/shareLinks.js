// lib/shareLinks.js — Client share links: /<agency-slug>/<unit-code>?s=<token> (token stored hashed),
// open counting and the "client opened" alert to the broker who shared it.
"use strict";

const crypto = require("crypto");
const Links = require("./links");
const Notifications = require("./notifications");
const Vis = require("../lib/visibility");

const ALERT_EVERY_HOURS = 6;
const HOT_OPENS = 3; // opens of a lead's links in 48 hours that make the lead hot
// Link previews and crawlers fetch the page too; they are not the client.
const BOT_UA = /(whatsapp|facebookexternalhit|facebot|meta-externalagent|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|applebot|yandex|baiduspider|duckduckbot|embedly|pinterest|bot\b|crawler|spider|preview|headless|curl|wget|python-requests|node-fetch)/i;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const looksLikeToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);
const isBot = (ua) => !ua || BOT_UA.test(ua);

/** New share link for an active listing. Returns { token, url }. */
async function createShareLink(pool, broker, listing, { channel = "whatsapp", lang = "ar", leadId = null } = {}) {
  const { rows } = await pool.query("SELECT slug FROM agencies WHERE id = $1", [listing.agency_id]);
  const slug = rows[0]?.slug;
  if (!slug || listing.agency_id !== broker.agency_id) throw new Error("share link: unknown agency");
  const token = crypto.randomBytes(16).toString("base64url");
  await pool.query(
    "INSERT INTO share_links (token_hash, agency_id, listing_id, broker_id, channel, lang, lead_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [sha256(token), listing.agency_id, listing.id, broker.id, channel, lang === "en" ? "en" : "ar", leadId]
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
    `SELECT s.token_hash, s.broker_id AS share_broker_id, s.open_count, s.last_alert_at, s.lang AS link_lang, s.lead_id AS share_lead_id, l.*,
            a.name AS agency_name, a.logo_url AS agency_logo_url, a.phone AS agency_phone, a.slug AS agency_slug
     FROM share_links s
     JOIN listings l ON l.id = s.listing_id AND l.agency_id = s.agency_id
     JOIN agencies a ON a.id = s.agency_id
     WHERE ${Vis.units("l")} AND s.token_hash = $1 AND a.slug = $2 AND l.code_norm = upper($3)
       AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
    [sha256(token), String(slug).toLowerCase(), String(code)]
  );
  const r = rows[0];
  if (!r) return null;
  const { token_hash, share_broker_id: broker_id, open_count, last_alert_at, link_lang, share_lead_id: lead_id, agency_name, agency_logo_url, agency_phone, agency_slug, ...listing } = r;
  let broker = null;
  if (broker_id) {
    const b = await pool.query(
      "SELECT id, agency_id, name, role, phone_number, phone_normalized, contact_phone, preferred_lang, is_active, notify_prefs FROM brokers WHERE id = $1 AND agency_id = $2",
      [broker_id, listing.agency_id]
    );
    broker = b.rows[0] || null;
  }
  return {
    link: { token_hash, broker_id, open_count, last_alert_at, lang: link_lang, lead_id },
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
    // Through the notification centre: WhatsApp or web push (the broker's choice), never both.
    await Notifications.notifyBroker(pool, broker, {
      kind: "share_opened",
      dedupeKey: `share_opened:${link.token_hash.slice(0, 24)}:${opens}`,
      title: text,
      url: `/app/units/${encodeURIComponent(listing.code)}`,
      listingId: listing.id,
      push: { title: en ? `👀 Client opened #${listing.code}` : `👀 العميل فتح #${listing.code}`, body: "" }
    }).catch((e) => console.warn("Share-open notification failed:", e.message));
  }
  const hot = link.lead_id ? await leadOpened(pool, link.lead_id, listing).catch((e) => console.warn("Hot-client check failed:", e.message)) : false;
  await pool
    .query(
      `INSERT INTO operation_logs (agency_id, broker_id, listing_code, operation_type, status, metadata, created_at)
       VALUES ($1, $2, $3, 'share_opened', 'success', $4::jsonb, NOW())`,
      [listing.agency_id, broker?.id || null, listing.code, JSON.stringify({ opens, alerted: Boolean(alert), hot: Boolean(hot) })]
    )
    .catch(() => {});
  return { counted: true, alerted: Boolean(alert), opens };
}

/**
 * A link sent to a lead was opened (step 7, wow 5): a share_opened event on the lead's timeline, and when the client
 * opened links 3 or more times in 48 hours, the lead becomes hot once (hot_at) and its broker gets one notification
 * with a follow-up button.
 * @returns {Promise<boolean>} true when the lead just became hot
 */
async function leadOpened(pool, leadId, listing) {
  const { rows } = await pool.query("SELECT id, agency_id, ref, name, phone_e164, assigned_broker_id, hot_at FROM leads WHERE " + Vis.leads("leads") + " AND id = $1 AND agency_id = $2", [leadId, listing.agency_id]);
  const lead = rows[0];
  if (!lead) return false;
  await pool.query("INSERT INTO lead_events (agency_id, lead_id, broker_id, kind, data) VALUES ($1, $2, NULL, 'share_opened', $3::jsonb)", [
    lead.agency_id,
    lead.id,
    JSON.stringify({ code: listing.code })
  ]);
  if (lead.hot_at) return false;
  const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM lead_events WHERE lead_id = $1 AND kind = 'share_opened' AND created_at > NOW() - INTERVAL '48 hours'", [lead.id]);
  if (n[0].n < HOT_OPENS) return false;
  const set = await pool.query("UPDATE leads SET hot_at = NOW(), last_activity_at = NOW() WHERE id = $1 AND hot_at IS NULL RETURNING id", [lead.id]);
  if (!set.rows.length || !lead.assigned_broker_id) return Boolean(set.rows.length);
  const b = await pool.query("SELECT id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs FROM brokers WHERE id = $1 AND agency_id = $2", [
    lead.assigned_broker_id,
    lead.agency_id
  ]);
  const broker = b.rows[0];
  if (broker?.is_active) {
    const en = broker.preferred_lang === "en";
    const ref = `L-${String(lead.ref).padStart(4, "0")}`;
    const who = lead.name || (en ? "Your client" : "العميل");
    await Notifications.notifyBroker(pool, broker, {
      kind: "hot_client",
      dedupeKey: `hot:${lead.id}`,
      title: en ? `🔥 ${who} (${ref}) opened your links ${n[0].n} times in 2 days. Call now?` : `🔥 ${who} (${ref}) فتح روابطك ${n[0].n} مرات في يومين. تكلمه دلوقتي؟`,
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [{ id: `ld:fu:${ref}`, title: en ? "📅 Follow-up" : "📅 متابعة" }]
    });
  }
  return true;
}

/** Client copy text plus a fresh share link (WhatsApp); the copy alone if the unit is not active. */
async function clientCopyWithLink(pool, broker, listing, lang, copyText) {
  require("./dispatcher").setTurnAction("client_copy");
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

module.exports = { ALERT_EVERY_HOURS, HOT_OPENS, BOT_UA, isBot, createShareLink, resolveShareLink, recordOpen, leadOpened, clientCopyWithLink, linksFor };
