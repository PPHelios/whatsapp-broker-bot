// services/followUpReminders.js — Follow-up and viewing reminders, and the 24-hour "not contacted" nudge (Release 3
// step 8). A scheduler job claims the due follow-ups (FOR UPDATE SKIP LOCKED, stamping follow_up_reminded_at), so two
// instances never remind twice, and tells each lead's current broker once per run, grouped (5 lines and "and N
// more"). A single reminder carries [✅ Done] [📅 Postpone]; a viewing carries the unit's compact line and its place.
// Quiet hours hold the message until they end (lib/notifications.js). A new lead nobody has contacted 24 hours after
// it arrived gets one nudge to its broker. A lead marked Interested with no follow-up planned and nothing happening for
// 24 hours gets one nudge too (6.5), again only after new activity and another quiet day.
"use strict";

const crypto = require("crypto");
const Notifications = require("../lib/notifications");
const Card = require("../domain/leadCard");
const Phone = require("../domain/phone");
const Describe = require("../domain/describe");
const Rules = require("../domain/leadRules");
const { withTransaction } = require("../lib/db");

const BATCH = 200;
const LINES = 5;
const NUDGE_AFTER_MS = 24 * 3600 * 1000;
const NUDGE_WINDOW_MS = 72 * 3600 * 1000; // older untouched leads (first deploy, old imports) are never nudged
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, away_until";

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const latin = (s) => (s && !/[؀-ۿ]/.test(s) ? s : null);
const time = (d, b) => new Date(d).toLocaleTimeString(en(b) ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
const dedupe = (prefix, rows, field) => `${prefix}:${crypto.createHash("sha1").update(rows.map((r) => `${r.id}@${new Date(r[field]).toISOString()}`).sort().join(",")).digest("hex").slice(0, 20)}`;

/** "📍 Mivida، New Cairo": where a viewing is. */
function placeLine(listing, broker) {
  const parts = en(broker)
    ? [listing.compound_en || latin(listing.compound), latin(listing.district), latin(listing.city)]
    : [listing.compound || listing.compound_en, listing.district, listing.city];
  const uniq = [...new Set(parts.filter(Boolean))];
  return uniq.length ? `📍 ${uniq.join("، ")}` : listing.location ? `📍 ${listing.location}` : null;
}

/** One lead's line in a grouped reminder. */
function reminderLine(lead, broker) {
  const lang = en(broker) ? "en" : "ar";
  const unit = lead.listing ? ` · 🏠 ${lead.listing.code}` : lead.follow_up_kind === "viewing" ? L(broker, " · 🏠 معاينة", " · 🏠 viewing") : "";
  return `• ${time(lead.next_follow_up_at, broker)} · ${Card.refLabel(lead.ref)} ${Card.displayName(lead, lang)}${unit}`;
}

/** The notification for one broker's due follow-ups. */
function reminderMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    const who = `${Card.displayName(lead, lang)} (${ref})`;
    const viewing = lead.follow_up_kind === "viewing";
    const body = [];
    if (viewing && lead.listing) body.push(Describe.compactLine(lead.listing, lang), placeLine(lead.listing, broker));
    if (lead.follow_up_note) body.push(`📝 ${lead.follow_up_note}`);
    if (lead.phone_e164) body.push(`📞 ${Phone.displayPhone(lead.phone_e164)}`);
    return {
      title: viewing
        ? L(broker, `🏠 معاينة ${time(lead.next_follow_up_at, broker)}: ${who}`, `🏠 Viewing at ${time(lead.next_follow_up_at, broker)}: ${who}`)
        : L(broker, `📅 متابعة: ${who}`, `📅 Follow-up: ${who}`),
      body: body.filter(Boolean).join("\n"),
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      listingId: lead.listing?.id || null,
      buttons: [
        { id: `ld:fudone:${ref}`, title: L(broker, "✅ خلصت", "✅ Done") },
        { id: `ld:fupost:${ref}`, title: L(broker, "📅 أجّل يوم", "📅 Postpone") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => reminderLine(l, broker));
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `📅 ${leads.length} متابعات دلوقتي`, `📅 ${leads.length} follow-ups due`),
    body: lines.join("\n"),
    url: "/app/leads?overdue=1",
    leadId: null,
    listingId: null,
    buttons: null
  };
}

/**
 * Sends one grouped notification per broker. A broker away (R3) is not disturbed: the managers get it instead, titled
 * with whose leads they are. → number of brokers told
 */
async function tellBrokers(pool, byBroker, build, prefix, field, now) {
  let told = 0;
  for (const [brokerId, { agencyId, leads }] of byBroker) {
    const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE id = $1 AND agency_id = $2`, [brokerId, agencyId]);
    const broker = rows[0];
    if (!broker || !broker.is_active) continue;
    if (Rules.awayNow(broker, now)) {
      for (const m of await Notifications.managersOf(pool, agencyId)) {
        if (m.id === broker.id) continue;
        const msg = build(m, leads);
        const title = `${msg.title} · ${L(m, `بدل ${broker.name} (إجازة)`, `for ${broker.name} (away)`)}`;
        await Notifications.notifyBroker(pool, m, { kind: "follow_up", dedupeKey: `${dedupe(prefix, leads, field)}:${broker.id}`, ...msg, title, buttons: null, now });
      }
      told++;
      continue;
    }
    const m = build(broker, leads);
    await Notifications.notifyBroker(pool, broker, { kind: "follow_up", dedupeKey: dedupe(prefix, leads, field), ...m, now });
    told++;
  }
  return told;
}

const groupByBroker = (rows) => {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.assigned_broker_id)) out.set(r.assigned_broker_id, { agencyId: r.agency_id, leads: [] });
    out.get(r.assigned_broker_id).leads.push(r);
  }
  return out;
};

/** Claims and reminds the due follow-ups. → { reminded, brokers } */
async function remindDue(pool, { now = new Date(), limit = BATCH } = {}) {
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM leads
        WHERE follow_up_status = 'open' AND next_follow_up_at <= $1 AND follow_up_reminded_at IS NULL
          AND assigned_broker_id IS NOT NULL AND stage NOT IN ('won', 'lost')
        ORDER BY next_follow_up_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now.toISOString(), limit]
    );
    if (!rows.length) return [];
    // The claim is not an edit: version and updated_at stay, so an open lead page doesn't conflict.
    const upd = await client.query("UPDATE leads SET follow_up_reminded_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows;
  });
  if (!claimed.length) return { reminded: 0, brokers: 0 };
  const unitIds = [...new Set(claimed.map((l) => l.follow_up_listing_id).filter(Boolean))];
  const units = unitIds.length ? (await pool.query("SELECT * FROM listings WHERE id = ANY($1::uuid[])", [unitIds])).rows : [];
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const l of claimed) l.listing = byId.get(l.follow_up_listing_id) || null;
  claimed.sort((a, b) => new Date(a.next_follow_up_at) - new Date(b.next_follow_up_at));
  const brokers = await tellBrokers(pool, groupByBroker(claimed), reminderMessage, "fu", "next_follow_up_at", now);
  return { reminded: claimed.length, brokers };
}

/** The nudge for one broker's untouched new leads. */
function nudgeMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    return {
      title: L(broker, `⏰ ${Card.displayName(lead, lang)} (${ref}) لسه محدش كلمه من 24 ساعة`, `⏰ Nobody has contacted ${Card.displayName(lead, lang)} (${ref}) in 24 hours`),
      body: lead.phone_e164 ? `📞 ${Phone.displayPhone(lead.phone_e164)}` : "",
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [
        { id: `ld:called:${ref}`, title: L(broker, "📞 كلمته", "📞 Called") },
        { id: `ld:fu:${ref}`, title: L(broker, "📅 متابعة", "📅 Follow-up") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => `• ${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`);
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `⏰ ${leads.length} عملاء جداد لسه محدش كلمهم`, `⏰ ${leads.length} new clients not contacted yet`),
    body: lines.join("\n"),
    url: "/app/leads?tab=new",
    buttons: null
  };
}

/** One nudge per new lead still uncontacted 24 hours after it arrived (and with no follow-up planned). */
async function nudgeUntouched(pool, { now = new Date(), limit = BATCH } = {}) {
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM leads
        WHERE stage = 'new' AND last_contact_at IS NULL AND nudged_at IS NULL AND assigned_broker_id IS NOT NULL
          AND follow_up_status IS DISTINCT FROM 'open' AND created_at <= $1 AND created_at > $2
        ORDER BY created_at, id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - NUDGE_AFTER_MS).toISOString(), new Date(now.getTime() - NUDGE_WINDOW_MS).toISOString(), limit]
    );
    if (!rows.length) return [];
    const upd = await client.query("UPDATE leads SET nudged_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  });
  if (!claimed.length) return { nudged: 0, brokers: 0 };
  const brokers = await tellBrokers(pool, groupByBroker(claimed), nudgeMessage, "nudge", "created_at", now);
  return { nudged: claimed.length, brokers };
}

const INTEREST_QUIET_MS = 24 * 3600 * 1000;

/** The nudge for one broker's interested leads with no next step. */
function interestMessage(broker, leads) {
  const lang = en(broker) ? "en" : "ar";
  if (leads.length === 1) {
    const lead = leads[0];
    const ref = Card.refLabel(lead.ref);
    return {
      title: L(broker, `👍 ${Card.displayName(lead, lang)} (${ref}) مهتم ومفيش متابعة متحددة`, `👍 ${Card.displayName(lead, lang)} (${ref}) is interested but has no follow-up`),
      body: lead.phone_e164 ? `📞 ${Phone.displayPhone(lead.phone_e164)}` : "",
      url: `/app/leads/${ref}`,
      leadId: lead.id,
      buttons: [
        { id: `ld:fu:${ref}`, title: L(broker, "📅 متابعة", "📅 Follow-up") },
        { id: `ld:called:${ref}`, title: L(broker, "📞 كلمته", "📞 Called") }
      ]
    };
  }
  const lines = leads.slice(0, LINES).map((l) => `• ${Card.refLabel(l.ref)} ${Card.displayName(l, lang)}`);
  if (leads.length > LINES) lines.push(L(broker, `…و${leads.length - LINES} كمان`, `…and ${leads.length - LINES} more`));
  return {
    title: L(broker, `👍 ${leads.length} عملاء مهتمين ومفيش متابعة متحددة`, `👍 ${leads.length} interested clients with no follow-up`),
    body: lines.join("\n"),
    url: "/app/leads?stage=interested",
    buttons: null
  };
}

/** One nudge per interested lead with no open follow-up and no activity for 24 hours (again after new activity). */
async function nudgeInterested(pool, { now = new Date(), limit = BATCH } = {}) {
  const claimed = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM leads
        WHERE stage = 'interested' AND assigned_broker_id IS NOT NULL AND follow_up_status IS DISTINCT FROM 'open'
          AND last_activity_at <= $1 AND (interest_nudged_at IS NULL OR interest_nudged_at < last_activity_at)
        ORDER BY last_activity_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [new Date(now.getTime() - INTEREST_QUIET_MS).toISOString(), limit]
    );
    if (!rows.length) return [];
    // A stamp, not activity: last_activity_at and version stay.
    const upd = await client.query("UPDATE leads SET interest_nudged_at = $2 WHERE id = ANY($1::uuid[]) RETURNING *", [rows.map((r) => r.id), now.toISOString()]);
    return upd.rows.sort((a, b) => a.ref - b.ref);
  });
  if (!claimed.length) return { nudged: 0, brokers: 0 };
  const brokers = await tellBrokers(pool, groupByBroker(claimed), interestMessage, "interest", "interest_nudged_at", now);
  return { nudged: claimed.length, brokers };
}

/** The scheduler job entry (lib/jobs.js). */
const reminderJob = () => ({
  name: "follow_up_reminders",
  everyMs: 60 * 1000,
  run: async ({ pool, now }) => {
    const r = await remindDue(pool, { now });
    const n = await nudgeUntouched(pool, { now });
    const i = await nudgeInterested(pool, { now });
    return { counts: { reminded: r.reminded, nudged: n.nudged, interest: i.nudged, brokers: r.brokers + n.brokers + i.brokers } };
  }
});

module.exports = { remindDue, nudgeUntouched, nudgeInterested, reminderMessage, nudgeMessage, interestMessage, reminderJob };
