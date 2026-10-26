// services/dailyDigest.js — The broker's morning brief (6.1) and the manager's evening digest (6.2). One scheduler job
// looks every 5 minutes; inside the Cairo window (brief 09:00–11:59, digest 19:00–21:59) it builds one message per
// active broker (or manager) and sends it through the notification centre with kind daily_brief / daily_digest, which
// goes to Telegram first and never to WhatsApp (lib/notifications.js DAILY_KINDS). The dedupe key carries the Cairo
// date, so retries, a second instance or a late wake never send twice; outside the window nothing is sent (a brief
// at 3 pm is stale). An empty brief is not sent. The watermark records the last day each pass finished.
"use strict";

const Notifications = require("../lib/notifications");
const Stages = require("../domain/leadStages");
const Card = require("../domain/leadCard");
const { MANAGER_ROLES } = require("../lib/authz");

const BRIEF_HOURS = [9, 12];
const DIGEST_HOURS = [19, 22];
const LINES = 3;
const HOT_DAYS = 7;
const BROKER_COLS = "id, agency_id, name, role, is_active, preferred_lang, phone_number, phone_normalized, notify_prefs, telegram_chat_id";

const en = (b) => b?.preferred_lang === "en";
const L = (b, ar, eng) => (en(b) ? eng : ar);
const lang = (b) => (en(b) ? "en" : "ar");

/** Cairo date "2026-11-02" and hour of a moment. */
function cairoDay(now) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 };
}

const inHours = (hour, [from, to]) => hour >= from && hour < to;
const time = (d, b) => new Date(d).toLocaleTimeString(en(b) ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });
const more = (b, n) => (n > 0 ? L(b, `  …و${n} كمان`, `  …and ${n} more`) : null);

/* ---------------------------------------------------------------------- */
/* Morning brief (6.1)                                                     */
/* ---------------------------------------------------------------------- */

/** Everything the broker's day needs, read in a few small queries (their own leads only). */
async function briefData(pool, broker, now) {
  const dayStart = Stages.cairoDayAt(now, 0, 0);
  const dayEnd = Stages.cairoDayAt(now, 1, 0);
  const args = [broker.agency_id, broker.id];
  const due = await pool.query(
    `SELECT l.ref, l.name, l.lang, l.phone_e164, l.next_follow_up_at, l.follow_up_kind, u.code AS unit_code
       FROM leads l LEFT JOIN listings u ON u.id = l.follow_up_listing_id AND u.agency_id = l.agency_id
      WHERE l.agency_id = $1 AND l.assigned_broker_id = $2 AND l.follow_up_status = 'open' AND l.next_follow_up_at < $3
        AND l.stage NOT IN ('won', 'lost')
      ORDER BY l.next_follow_up_at`,
    [...args, dayEnd.toISOString()]
  );
  const today = due.rows.filter((r) => new Date(r.next_follow_up_at) >= dayStart);
  const overdue = due.rows.filter((r) => new Date(r.next_follow_up_at) < dayStart);
  const matches = await pool.query(
    `SELECT l.ref, l.name, l.lang, l.phone_e164, count(*)::int AS n
       FROM lead_matches m JOIN leads l ON l.id = m.lead_id AND l.agency_id = m.agency_id
      WHERE m.agency_id = $1 AND l.assigned_broker_id = $2 AND m.status IN ('new', 'alerted') AND m.created_at > $3
        AND l.stage NOT IN ('won', 'lost')
      GROUP BY l.ref, l.name, l.lang, l.phone_e164 ORDER BY n DESC, l.ref`,
    [...args, new Date(now.getTime() - 24 * 3600 * 1000).toISOString()]
  );
  const hot = await pool.query(
    `SELECT ref, name, lang, phone_e164 FROM leads
      WHERE agency_id = $1 AND assigned_broker_id = $2 AND hot_at > $3 AND stage NOT IN ('won', 'lost')
      ORDER BY hot_at DESC`,
    [...args, new Date(now.getTime() - HOT_DAYS * 24 * 3600 * 1000).toISOString()]
  );
  const fresh = await pool.query(
    `SELECT count(*)::int AS n FROM leads WHERE agency_id = $1 AND assigned_broker_id = $2 AND stage = 'new' AND last_contact_at IS NULL`,
    args
  );
  // C8: managers also hear about overdue developer commissions (every 7 days) and client registrations about to lapse.
  const commissions = MANAGER_ROLES.includes(String(broker.role || "").toLowerCase())
    ? await require("./commissions").briefItems(pool, broker.agency_id, { now }).catch(() => null)
    : null;
  // N6: the broker's progress against their monthly target.
  const target = (await require("./targets").progress(pool, broker.agency_id, { now, brokerId: broker.id }).catch(() => new Map())).get(broker.id) || null;
  return {
    commissions,
    target,
    viewings: today.filter((r) => r.follow_up_kind === "viewing"),
    calls: today.filter((r) => r.follow_up_kind !== "viewing"),
    overdue,
    matches: matches.rows,
    hot: hot.rows,
    uncontacted: fresh.rows[0].n
  };
}

/** The brief as a notification message, or null when there's nothing to say. */
function briefMessage(broker, data) {
  const lg = lang(broker);
  const who = (l) => `${Card.refLabel(l.ref)} ${Card.displayName(l, lg)}`;
  const section = (head, rows, line) => {
    if (!rows.length) return [];
    return [head, ...rows.slice(0, LINES).map(line), more(broker, rows.length - LINES)].filter(Boolean);
  };
  const parts = [
    section(L(broker, `🏠 معاينات النهارده (${data.viewings.length})`, `🏠 Viewings today (${data.viewings.length})`), data.viewings, (l) => `• ${time(l.next_follow_up_at, broker)} · ${who(l)}${l.unit_code ? ` · ${l.unit_code}` : ""}`),
    section(L(broker, `📞 مكالمات النهارده (${data.calls.length})`, `📞 Calls today (${data.calls.length})`), data.calls, (l) => `• ${time(l.next_follow_up_at, broker)} · ${who(l)}`),
    section(L(broker, `⚠️ متأخرة (${data.overdue.length})`, `⚠️ Overdue (${data.overdue.length})`), data.overdue, (l) => `• ${who(l)}`),
    section(L(broker, `✨ وحدات جديدة مناسبة لعملائك`, `✨ New matches for your clients`), data.matches, (m) => `• ${who(m)}: ${m.n} ${L(broker, m.n === 1 ? "وحدة" : "وحدات", m.n === 1 ? "unit" : "units")}`),
    section(L(broker, `🔥 عملاء مهتمين جداً`, `🔥 Hot clients`), data.hot, (l) => `• ${who(l)}`),
    data.uncontacted ? [L(broker, `🆕 ${data.uncontacted} عملاء جداد لسه محدش كلمهم`, `🆕 ${data.uncontacted} new clients not contacted yet`)] : [],
    section(L(broker, `💸 عمولات متأخرة عند المطورين`, `💸 Overdue developer commissions`), data.commissions?.overdue || [], (c) => `• D-${String(c.deal_ref).padStart(4, "0")} ${c.unit_code || ""} · ${c.developer_name || "—"} · ${money(c.outstanding, broker)} · ${L(broker, `متأخرة ${c.days} يوم`, `${c.days} days late`)}`),
    section(L(broker, `📝 تسجيل عملاء هيخلص`, `📝 Client registrations about to lapse`), data.commissions?.registrations || [], (c) => `• D-${String(c.deal_ref).padStart(4, "0")} ${c.unit_code || ""} · ${c.developer_name || "—"} · ${L(broker, `فاضل ${c.days_left} يوم`, `${c.days_left} days left`)}`)
  ].filter((p) => p.length);
  if (!parts.length) return null;
  const goal = require("./targets").briefLine(data.target, lg, (n) => money(n, broker));
  if (goal) parts.push([goal]);
  const first = String(broker.name || "").split(/\s+/)[0];
  const followUps = data.viewings.length + data.calls.length + data.overdue.length;
  const buttons = [];
  if (followUps) buttons.push({ id: "ld:fulist", title: L(broker, "📅 متابعاتي", "📅 My follow-ups") });
  buttons.push({ id: "ld:mylist", title: L(broker, "👥 عملائي", "👥 My clients") });
  return {
    title: L(broker, `☀️ صباح الخير${first ? ` يا ${first}` : ""}! يومك:`, `☀️ Good morning${first ? `, ${first}` : ""}! Your day:`),
    body: parts.map((p) => p.join("\n")).join("\n\n"),
    url: followUps ? "/app/leads?overdue=1" : "/app/leads",
    buttons
  };
}

/* ---------------------------------------------------------------------- */
/* Manager evening digest (6.2)                                            */
/* ---------------------------------------------------------------------- */

/** Today's activity across the agency, per broker. */
async function digestData(pool, agencyId, now) {
  const since = Stages.cairoDayAt(now, 0, 0).toISOString();
  const leads = await pool.query(
    `SELECT assigned_broker_id AS broker_id, source, count(*)::int AS n FROM leads
      WHERE agency_id = $1 AND created_at >= $2 GROUP BY assigned_broker_id, source`,
    [agencyId, since]
  );
  const untouched = await pool.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE created_at < $2)::int AS old FROM leads
      WHERE agency_id = $1 AND stage = 'new' AND last_contact_at IS NULL`,
    [agencyId, new Date(now.getTime() - 24 * 3600 * 1000).toISOString()]
  );
  const events = await pool.query(
    `SELECT broker_id, kind, data->>'to' AS to_stage, count(*)::int AS n FROM lead_events
      WHERE agency_id = $1 AND created_at >= $2 AND undone_at IS NULL AND kind IN ('stage', 'contacted')
      GROUP BY broker_id, kind, data->>'to'`,
    [agencyId, since]
  );
  const deals = await pool.query(
    `SELECT closing_broker_id AS broker_id, count(*)::int AS n, coalesce(sum(commission_total), 0)::bigint AS commission FROM deals
      WHERE agency_id = $1 AND created_at >= $2 AND status <> 'cancelled' GROUP BY closing_broker_id`,
    [agencyId, since]
  );
  const brokers = await pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [agencyId]);
  const per = new Map(brokers.rows.map((b) => [b.id, { name: b.name, leads: 0, contacted: 0, moves: 0, deals: 0 }]));
  const row = (id) => per.get(id) || null;
  const sources = new Map();
  let newLeads = 0;
  let unassigned = 0;
  for (const r of leads.rows) {
    newLeads += r.n;
    if (!r.broker_id) unassigned += r.n;
    else if (row(r.broker_id)) row(r.broker_id).leads += r.n;
    const s = r.source || "—";
    sources.set(s, (sources.get(s) || 0) + r.n);
  }
  const stageMoves = {};
  for (const e of events.rows) {
    const b = row(e.broker_id);
    if (e.kind === "contacted") {
      if (b) b.contacted += e.n;
    } else {
      stageMoves[e.to_stage] = (stageMoves[e.to_stage] || 0) + e.n;
      if (b) b.moves += e.n;
    }
  }
  let dealCount = 0;
  let commission = 0;
  for (const d of deals.rows) {
    dealCount += d.n;
    commission += Number(d.commission);
    if (row(d.broker_id)) row(d.broker_id).deals += d.n;
  }
  return {
    newLeads,
    unassigned,
    sources: [...sources.entries()].sort((a, b) => b[1] - a[1]),
    uncontacted: untouched.rows[0].n,
    uncontactedOld: untouched.rows[0].old,
    stageMoves,
    deals: dealCount,
    commission,
    brokers: [...per.values()].filter((b) => b.leads || b.contacted || b.moves || b.deals)
  };
}

const money = (n, m) => `${Math.round(n).toLocaleString("en-US")} ${L(m, "ج.م", "EGP")}`;

/** The digest as a notification message for one manager, or null on a day with nothing at all. */
function digestMessage(manager, d) {
  const lg = lang(manager);
  if (!d.newLeads && !d.uncontacted && !Object.keys(d.stageMoves).length && !d.deals) return null;
  const lines = [];
  const src = d.sources.slice(0, 3).map(([s, n]) => `${s === "—" ? L(manager, "بدون مصدر", "no source") : Stages.sourceLabel(s, lg) || s} ${n}`).join(" · ");
  lines.push(L(manager, `🆕 عملاء جداد النهارده: ${d.newLeads}`, `🆕 New leads today: ${d.newLeads}`) + (d.newLeads && src ? ` (${src})` : ""));
  if (d.unassigned) lines.push(L(manager, `   منهم ${d.unassigned} من غير بروكر`, `   ${d.unassigned} not assigned yet`));
  if (d.uncontacted) {
    lines.push(
      L(manager, `⏰ لسه محدش كلمهم: ${d.uncontacted}`, `⏰ Not contacted yet: ${d.uncontacted}`) +
        (d.uncontactedOld ? L(manager, ` (${d.uncontactedOld} أكتر من 24 ساعة)`, ` (${d.uncontactedOld} over 24 hours)`) : "")
    );
  }
  const moves = Stages.STAGES.filter((s) => d.stageMoves[s]).map((s) => `${Stages.stageLabel(s, lg)} ${d.stageMoves[s]}`);
  if (moves.length) lines.push(L(manager, `🔀 تحركات المراحل: `, `🔀 Stage moves: `) + moves.join(" · "));
  lines.push(L(manager, `🤝 صفقات النهارده: ${d.deals}`, `🤝 Deals today: ${d.deals}`) + (d.deals ? ` · ${L(manager, "عمولة", "commission")} ${money(d.commission, manager)}` : ""));
  if (d.brokers.length) {
    lines.push("", L(manager, "👥 حسب البروكر:", "👥 By broker:"));
    for (const b of d.brokers.slice(0, 10)) {
      const bits = [];
      if (b.leads) bits.push(L(manager, `${b.leads} جداد`, `${b.leads} new`));
      if (b.contacted) bits.push(L(manager, `${b.contacted} مكالمة`, `${b.contacted} contacted`));
      if (b.moves) bits.push(L(manager, `${b.moves} تحريك`, `${b.moves} moves`));
      if (b.deals) bits.push(L(manager, `${b.deals} صفقة`, `${b.deals} deals`));
      lines.push(`• ${b.name}: ${bits.join(" · ")}`);
    }
    if (d.brokers.length > 10) lines.push(more(manager, d.brokers.length - 10));
  }
  return {
    title: L(manager, "🌙 ملخص اليوم للوكالة", "🌙 Today at the agency"),
    body: lines.join("\n"),
    url: "/app/dashboard?days=7",
    buttons: null
  };
}

/* ---------------------------------------------------------------------- */
/* Job                                                                     */
/* ---------------------------------------------------------------------- */

/** Sends today's morning briefs. → { sent, empty, skipped } */
async function sendBriefs(pool, { now = new Date(), agencyId = null } = {}) {
  const { date, hour } = cairoDay(now);
  if (!inHours(hour, BRIEF_HOURS)) return { sent: 0, empty: 0, skipped: true };
  const key = `brief:${date}`;
  const { rows: brokers } = await pool.query(
    `SELECT ${BROKER_COLS} FROM brokers b WHERE is_active AND ($2::uuid IS NULL OR agency_id = $2)
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.broker_id = b.id AND n.dedupe_key = $1)`,
    [key, agencyId]
  );
  let sent = 0;
  let empty = 0;
  for (const broker of brokers) {
    const m = briefMessage(broker, await briefData(pool, broker, now));
    if (!m) {
      empty++;
      continue;
    }
    const r = await Notifications.notifyBroker(pool, broker, { kind: "daily_brief", dedupeKey: key, ...m, now });
    if (!r.duplicate) sent++;
  }
  return { sent, empty, skipped: false };
}

/** Sends today's manager digests (one per manager, built once per agency). → { sent, skipped } */
async function sendDigests(pool, { now = new Date(), agencyId = null } = {}) {
  const { date, hour } = cairoDay(now);
  if (!inHours(hour, DIGEST_HOURS)) return { sent: 0, skipped: true };
  const key = `digest:${date}`;
  const { rows: managers } = await pool.query(
    `SELECT ${BROKER_COLS} FROM brokers b WHERE is_active AND lower(role) = ANY($2::text[]) AND ($3::uuid IS NULL OR agency_id = $3)
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.broker_id = b.id AND n.dedupe_key = $1)
      ORDER BY agency_id`,
    [key, MANAGER_ROLES, agencyId]
  );
  const byAgency = new Map();
  let sent = 0;
  for (const m of managers) {
    if (!byAgency.has(m.agency_id)) byAgency.set(m.agency_id, await digestData(pool, m.agency_id, now));
    const msg = digestMessage(m, byAgency.get(m.agency_id));
    if (!msg) continue;
    const r = await Notifications.notifyBroker(pool, m, { kind: "daily_digest", dedupeKey: key, ...msg, now });
    if (!r.duplicate) sent++;
  }
  return { sent, skipped: false };
}

/** The scheduler job entry (lib/jobs.js): every 5 minutes; each pass is cheap outside the windows. */
const digestJob = () => ({
  name: "daily_digest",
  everyMs: 5 * 60 * 1000,
  run: async ({ pool, now, watermark }) => {
    const { date } = cairoDay(now);
    const out = { ...watermark };
    const counts = {};
    if (watermark.brief !== date) {
      const b = await sendBriefs(pool, { now });
      Object.assign(counts, { briefs: b.sent, empty_briefs: b.empty });
      if (!b.skipped) out.brief = date;
    }
    if (watermark.digest !== date) {
      const d = await sendDigests(pool, { now });
      counts.digests = d.sent;
      if (!d.skipped) out.digest = date;
    }
    return { counts, watermark: out };
  }
});

module.exports = { BRIEF_HOURS, DIGEST_HOURS, cairoDay, briefData, briefMessage, digestData, digestMessage, sendBriefs, sendDigests, digestJob };
