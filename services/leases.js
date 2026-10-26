// services/leases.js — Rental renewals (Release B, N4). A rented unit's lease (one per unit) is saved by whoever may
// edit the unit; reminders are opt-in ("remind me") and go to the broker who saved it, as follow-up notifications:
// 60 and 30 days before the end (renew or re-list) and 30 days before each yearly increase. The `lease_reminders` job
// runs hourly and sends each reminder once (leases.reminded). Managers see the next 90 days of lease ends on the
// agency dashboard. The rules are in domain/leases.js.
"use strict";

const Lz = require("../domain/leases");
const Describe = require("../domain/describe");
const Notifications = require("../lib/notifications");
const { canEdit, isManager } = require("../lib/authz");

const cairoDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function forListing(db, listing) {
  const { rows } = await db.query("SELECT * FROM leases WHERE listing_id = $1 AND agency_id = $2", [listing.id, listing.agency_id]);
  return rows[0] || null;
}

async function save(db, actor, listing, form) {
  if (!listing || listing.agency_id !== actor.agency_id || !canEdit(actor, listing)) return { error: "forbidden" };
  if (listing.listing_type !== "rent") return { error: "not_rent" };
  const f = Lz.fromForm(form);
  if (f.error) return f;
  const { rows } = await db.query(
    `INSERT INTO leases (agency_id, listing_id, broker_id, tenant_name, start_date, months, rent, increase_pct, remind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (listing_id) DO UPDATE SET broker_id = EXCLUDED.broker_id, tenant_name = EXCLUDED.tenant_name, start_date = EXCLUDED.start_date,
       months = EXCLUDED.months, rent = EXCLUDED.rent, increase_pct = EXCLUDED.increase_pct, remind = EXCLUDED.remind,
       reminded = CASE WHEN leases.start_date = EXCLUDED.start_date AND leases.months = EXCLUDED.months THEN leases.reminded ELSE '{}' END,
       updated_at = now()
     RETURNING *`,
    [actor.agency_id, listing.id, actor.id, f.tenant_name, f.start_date, f.months, f.rent, f.increase_pct, f.remind]
  );
  return { ok: true, lease: rows[0] };
}

async function remove(db, actor, listing) {
  if (!listing || listing.agency_id !== actor.agency_id || !canEdit(actor, listing)) return { error: "forbidden" };
  await db.query("DELETE FROM leases WHERE listing_id = $1 AND agency_id = $2", [listing.id, actor.agency_id]);
  return { ok: true };
}

/** Lease ends in the next `days` days for the agency (managers): [{ code, tenant_name, end, broker_name, remind }]. */
async function upcoming(db, manager, { days = 90, now = new Date() } = {}) {
  if (!isManager(manager)) return null;
  const { rows } = await db.query(
    `SELECT z.*, l.code, b.name AS broker_name FROM leases z JOIN listings l ON l.id = z.listing_id LEFT JOIN brokers b ON b.id = z.broker_id
      WHERE z.agency_id = $1`,
    [manager.agency_id]
  );
  const today = Date.parse(`${cairoDay(now)}T00:00:00Z`);
  return rows
    .map((r) => ({ code: r.code, tenant_name: r.tenant_name, broker_name: r.broker_name, remind: r.remind, rent: r.rent === null ? null : Number(r.rent), end: Lz.endDate(r) }))
    .filter((r) => r.end.getTime() >= today && r.end.getTime() <= today + days * 24 * 3600 * 1000)
    .sort((a, b) => a.end - b.end);
}

function reminderText(lease, r, lang) {
  const en = lang === "en";
  const date = Lz.ymd(r.date);
  if (r.kind === "end") {
    return {
      title: en ? `🏠 ${lease.code}: lease ends ${date} (${r.days} days)` : `🏠 ${lease.code}: الإيجار بيخلص ${date} (بعد ${r.days} يوم)`,
      body: en ? `${lease.tenant_name ? `Tenant ${lease.tenant_name}. ` : ""}Ask about renewing, or get the unit ready to re-list.` : `${lease.tenant_name ? `المستأجر ${lease.tenant_name}. ` : ""}اسأل عن التجديد، أو جهّز الوحدة تتعرض تاني.`
    };
  }
  const pct = lease.increase_pct === null ? null : Number(lease.increase_pct);
  const next = pct !== null && lease.rent !== null ? Math.round(Number(lease.rent) * Math.pow(1 + pct / 100, Number(r.key.slice(3)))) : null;
  return {
    title: en ? `📈 ${lease.code}: yearly rent increase on ${date}` : `📈 ${lease.code}: الزيادة السنوية للإيجار يوم ${date}`,
    body: pct !== null
      ? en
        ? `Increase ${pct}%${next ? `: new rent ${Describe.money(next, "en")}` : ""}. Remind the tenant and the owner.`
        : `زيادة ${pct}%${next ? `: الإيجار الجديد ${Describe.money(next, "ar")}` : ""}. فكّر المستأجر والمالك.`
      : en
        ? "Agree the new rent with the owner and the tenant."
        : "اتفق على الإيجار الجديد مع المالك والمستأجر."
  };
}

/** Sends the due reminders once. */
async function remindDue(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT z.*, l.code, l.status, b.id AS b_id, b.agency_id AS b_agency, b.name AS b_name, b.role, b.preferred_lang, b.phone_number, b.phone_normalized, b.notify_prefs, b.telegram_chat_id, b.is_active
       FROM leases z JOIN listings l ON l.id = z.listing_id JOIN brokers b ON b.id = z.broker_id
      WHERE z.remind AND b.is_active`
  );
  const today = cairoDay(now);
  let sent = 0;
  for (const z of rows) {
    for (const r of Lz.dueReminders(z, today)) {
      // Claim first, so two instances never send twice.
      const claim = await db.query("UPDATE leases SET reminded = array_append(reminded, $2) WHERE id = $1 AND NOT ($2 = ANY(reminded)) RETURNING id", [z.id, r.key]);
      if (!claim.rows[0]) continue;
      const broker = { id: z.b_id, agency_id: z.b_agency, name: z.b_name, role: z.role, preferred_lang: z.preferred_lang, phone_number: z.phone_number, phone_normalized: z.phone_normalized, notify_prefs: z.notify_prefs, telegram_chat_id: z.telegram_chat_id };
      const t = reminderText(z, r, z.preferred_lang === "en" ? "en" : "ar");
      await Notifications.notifyBroker(db, broker, { kind: "follow_up", dedupeKey: `lease:${z.id}:${r.key}`, title: t.title, body: t.body, url: `/app/units/${encodeURIComponent(z.code)}#lease`, now });
      sent++;
    }
  }
  return { sent };
}

function reminderJob() {
  return { name: "lease_reminders", everyMs: 60 * 60 * 1000, run: ({ pool, now }) => remindDue(pool, { now }) };
}

module.exports = { forListing, save, remove, upcoming, remindDue, reminderJob };
