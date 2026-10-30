// services/viewings.js — Viewing scheduler (phase 2 step 6). The broker sets a viewing on a lead (date, time, unit,
// place): it becomes the lead's open viewing follow-up (reminders as usual) and a viewing with a private link. The
// broker sends that link to the client in one tap (wa.me from their own WhatsApp: nothing goes out from our number);
// on the page the client confirms or asks for another time, the broker is alerted, and both can add it to a calendar
// (.ics or Google Calendar). The page shows the agency, the broker, the time, the place and the unit, never the
// client's own data.
"use strict";

const crypto = require("crypto");
const Leads = require("./leads");
const Authz = require("../lib/authz");
const Links = require("../lib/links");
const Phone = require("../domain/phone");
const Describe = require("../domain/describe");
const { notifyBroker } = require("../lib/notifications");
const Vis = require("../lib/visibility");

const HOUR = 3600 * 1000;
const DURATION_MS = HOUR;
const OPEN = ["proposed", "confirmed", "reschedule"];
const L = (lang, ar, en) => (lang === "en" ? en : ar);
const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n) || null;

/** "الأحد 2 نوفمبر، 3:00 م" / "Sun, 2 Nov, 3:00 PM" in Cairo time. */
function whenLabel(at, lang = "ar") {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(at));
}

/** The unit as a client may see it: type · compound · area (and its display code). */
function unitLabel(listing, lang = "ar") {
  if (!listing) return null;
  const type = Describe.TYPE_LABELS[listing.property_type]?.[lang === "en" ? 1 : 0];
  return [type, listing.compound || listing.district, Describe.areaLabel(listing, lang), listing.code].filter(Boolean).join(" · ");
}

/** The latest viewing of a lead (any status), or null. */
async function latestFor(db, agencyId, leadId) {
  const { rows } = await db.query(
    `SELECT v.*, l.code, l.property_type, l.compound, l.district, l.area_value FROM viewings v LEFT JOIN listings l ON l.id = v.listing_id
      WHERE ${Vis.units("l")} AND v.agency_id = $1 AND v.lead_id = $2 ORDER BY v.created_at DESC LIMIT 1`,
    [agencyId, leadId]
  );
  return rows[0] || null;
}

function clientMessage({ lead, actor, listing, at, place, url, lang }) {
  const first = String(lead.name || "").trim().split(/\s+/)[0];
  const hello = lang === "en" ? `Hello${first ? ` ${first}` : ""},` : `أهلاً${first ? ` ${first}` : ""}،`;
  return [
    hello,
    L(lang, `ميعاد المعاينة: ${whenLabel(at, lang)}`, `Your viewing: ${whenLabel(at, lang)}`),
    listing ? `🏠 ${unitLabel(listing, lang)}` : null,
    place ? `📍 ${place}` : null,
    L(lang, `أكّد أو اختار ميعاد تاني من هنا: ${url}`, `Confirm or pick another time here: ${url}`),
    actor.name ? `— ${actor.name}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Schedules a viewing: the lead's follow-up becomes this viewing, earlier open viewings of the lead are replaced, and
 * the client's wa.me link comes back ({ ok, viewing, url (the page), wa (wa.me, null for a landline) } or { error }).
 * @param {Object} input - { at: Date, listing (agency's unit row or null), place, version, lang }
 */
async function schedule(pool, actor, leadKey, { at, listing = null, place = null, version = null, lang = "ar", now = new Date() } = {}) {
  const lead = await Leads.getLead(pool, actor, leadKey);
  if (!lead) return { error: "not_found" };
  if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return { error: "follow_up_time" };
  if (at.getTime() < now.getTime() - HOUR) return { error: "past" };
  if (listing && listing.agency_id !== actor.agency_id) return { error: "unit_not_found" };
  const where = clean(place, 200);
  const f = await Leads.setFollowUp(pool, actor, lead.id, { at, kind: "viewing", listingId: listing?.id || null, note: where, version, now });
  if (f.error || f.conflict) return f;
  const clientLang = lead.lang || lang;
  const token = crypto.randomBytes(16).toString("base64url");
  await pool.query("UPDATE viewings SET status = 'cancelled', updated_at = $3 WHERE agency_id = $1 AND lead_id = $2 AND status = ANY($4)", [actor.agency_id, lead.id, now.toISOString(), OPEN]);
  const { rows } = await pool.query(
    `INSERT INTO viewings (agency_id, lead_id, broker_id, listing_id, starts_at, place, lang, token_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
    [actor.agency_id, lead.id, actor.id, listing?.id || null, at.toISOString(), where, clientLang, tokenHash(token), now.toISOString()]
  );
  const url = Links.viewingUrl(token);
  const wa = Phone.waMeUrl(lead.phone_e164, clientMessage({ lead, actor, listing, at, place: where, url, lang: clientLang }));
  return { ok: true, viewing: rows[0], url, wa, lead: f.lead };
}

/** The viewing behind a client's link with what its page shows (agency, broker, unit), or null. */
async function byToken(db, token) {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ""))) return null;
  const { rows } = await db.query(
    `SELECT v.*, a.name AS agency_name, b.name AS broker_name, COALESCE(b.contact_phone, b.phone_number) AS broker_phone,
            l.code, l.property_type, l.compound, l.district, l.area_value
       FROM viewings v JOIN agencies a ON a.id = v.agency_id
       LEFT JOIN brokers b ON b.id = v.broker_id
       LEFT JOIN listings l ON l.id = v.listing_id
      WHERE ${Vis.units("l")} AND v.token_hash = $1`,
    [tokenHash(token)]
  );
  return rows[0] || null;
}

/** A link is usable while the viewing is open and not more than a day past. */
const isLive = (v, now = new Date()) => OPEN.includes(v.status) && new Date(v.starts_at).getTime() > now.getTime() - 24 * HOUR;

/**
 * The client answers: confirm, or ask for another time (with an optional time and note). The broker who set it is
 * alerted. → { ok, viewing } or { error: gone|time }
 */
async function respond(pool, token, { action, proposedAt = null, note = null, now = new Date() } = {}) {
  const v = await byToken(pool, token);
  if (!v || !isLive(v, now)) return { error: "gone" };
  let rows;
  if (action === "confirm") {
    ({ rows } = await pool.query("UPDATE viewings SET status = 'confirmed', responded_at = $2, updated_at = $2 WHERE id = $1 RETURNING *", [v.id, now.toISOString()]));
  } else {
    if (proposedAt && (Number.isNaN(proposedAt.getTime()) || proposedAt < now)) return { error: "time" };
    if (!proposedAt && !clean(note, 300)) return { error: "time" };
    ({ rows } = await pool.query(
      "UPDATE viewings SET status = 'reschedule', client_proposed_at = $2, client_note = $3, responded_at = $4, updated_at = $4 WHERE id = $1 RETURNING *",
      [v.id, proposedAt ? proposedAt.toISOString() : null, clean(note, 300), now.toISOString()]
    ));
  }
  await alertBroker(pool, { ...v, ...rows[0] }, now).catch((err) => console.error("Viewing alert failed:", err.message));
  return { ok: true, viewing: { ...v, ...rows[0] } };
}

async function alertBroker(pool, v, now) {
  const { rows } = await pool.query(
    "SELECT b.*, l.ref, l.name AS lead_name FROM brokers b JOIN leads l ON l.id = $2 WHERE " + Vis.leads("l") + " AND b.id = $1 AND b.is_active",
    [v.broker_id, v.lead_id]
  );
  const b = rows[0];
  if (!b) return;
  const lang = b.preferred_lang === "en" ? "en" : "ar";
  const ref = `L-${String(b.ref).padStart(4, "0")}`;
  const who = b.lead_name ? `${ref} · ${b.lead_name}` : ref;
  const confirmed = v.status === "confirmed";
  const title = confirmed ? L(lang, "✅ العميل أكّد المعاينة", "✅ The client confirmed the viewing") : L(lang, "🔁 العميل عايز ميعاد تاني للمعاينة", "🔁 The client asks for another viewing time");
  const body = [
    who,
    whenLabel(v.starts_at, lang),
    !confirmed && v.client_proposed_at ? L(lang, `الميعاد اللي اقترحه: ${whenLabel(v.client_proposed_at, lang)}`, `Suggested time: ${whenLabel(v.client_proposed_at, lang)}`) : null,
    !confirmed && v.client_note ? `💬 ${v.client_note}` : null
  ]
    .filter(Boolean)
    .join("\n");
  await notifyBroker(pool, b, { kind: "follow_up", dedupeKey: `viewing:${v.id}:${v.status}:${new Date(v.responded_at).getTime()}`, title, body, url: `/app/leads/${ref}#viewing`, leadId: v.lead_id, now, urgent: true });
}

// --- calendar ---------------------------------------------------------------------------------------------------------

const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 bytes are folded (RFC 5545), never inside a character. */
function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** What a calendar entry says: { title, details, location, start, end }. */
function calendarEntry(v, { lang = "ar", forBroker = false, leadLabel = null } = {}) {
  const unit = unitLabel(v.code ? v : null, lang);
  const title = forBroker ? L(lang, `معاينة: ${leadLabel || ""}`, `Viewing: ${leadLabel || ""}`).trim() : L(lang, `معاينة مع ${v.agency_name || ""}`, `Viewing with ${v.agency_name || ""}`).trim();
  const details = [unit, forBroker ? null : v.broker_name ? `${v.broker_name}${v.broker_phone ? ` · +${Phone.normalizePhone(v.broker_phone)}` : ""}` : null].filter(Boolean).join("\n");
  return { title, details, location: v.place || v.compound || "", start: new Date(v.starts_at), end: new Date(new Date(v.starts_at).getTime() + DURATION_MS) };
}

/** An .ics file (one event) for a calendar entry. */
function ics(v, entry, { now = new Date() } = {}) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WehdatHub//Viewing//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:viewing-${v.id}@wehdathub`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(entry.start)}`,
    `DTEND:${icsDate(entry.end)}`,
    `SUMMARY:${icsText(entry.title)}`,
    entry.location ? `LOCATION:${icsText(entry.location)}` : null,
    entry.details ? `DESCRIPTION:${icsText(entry.details)}` : null,
    "BEGIN:VALARM",
    "TRIGGER:-PT1H",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(entry.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ]
    .filter(Boolean)
    .map(fold)
    .join("\r\n") + "\r\n";
}

/** Google Calendar's "add event" link for a calendar entry. */
function googleCalendarUrl(entry) {
  const q = new URLSearchParams({ action: "TEMPLATE", text: entry.title, dates: `${icsDate(entry.start)}/${icsDate(entry.end)}`, details: entry.details, location: entry.location, ctz: "Africa/Cairo" });
  return `https://calendar.google.com/calendar/render?${q}`;
}

module.exports = { OPEN, whenLabel, unitLabel, latestFor, schedule, byToken, isLive, respond, calendarEntry, ics, googleCalendarUrl };
