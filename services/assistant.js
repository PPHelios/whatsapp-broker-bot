// services/assistant.js — The assistant (Release B, C10 project assistant + N1 own-data assistant). A broker asks in
// words or by voice ("اسأل امتى استلام بادية؟", "which of my clients want 3 bedrooms in Zayed?", "what's due today?").
// Only the data the question needs is gathered: the stored context of projects named in it (services/
// projectContext.js), the broker's own clients (all of them for managers), their follow-ups, the agency's units. One
// text call answers from that data only, with its date, or says it is not in our data. When it isn't, and the app
// owner switched web search on for the agency (and its monthly web answers are not used up), a second call searches
// the web; that answer is always labelled unverified with its source links. Every question is logged.
"use strict";

const AI = require("../lib/ai");
const A = require("../domain/assistant");
const Card = require("../domain/leadCard");
const Describe = require("../domain/describe");
const ProjectContext = require("./projectContext");
const { isManager } = require("../lib/authz");

const MAX_PROJECTS = 3;
const MAX_LEADS = 60;
const MAX_UNITS = 60;
const MAX_FOLLOW_UPS = 30;
const DEFAULT_WEB_MONTH = 30;

const cairoDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const monthStart = (now) => {
  const [y, m] = cairoDay(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - 3 * 3600 * 1000); // a few hours early is fine for a monthly count
};
const typeLabel = (t) => (Describe.TYPE_LABELS?.[t] ? Describe.TYPE_LABELS[t][1] : t || "unit");

/** The agency's web setting: { web, web_month }. */
async function webSetting(db, agencyId) {
  const { rows } = await db.query("SELECT assistant FROM agencies WHERE id = $1", [agencyId]);
  const a = rows[0]?.assistant || {};
  return { web: a.web === true, web_month: Number.isInteger(a.web_month) && a.web_month >= 0 && a.web_month <= 1000 ? a.web_month : DEFAULT_WEB_MONTH };
}

/** The owner switches web answers on or off for an agency. */
async function setWeb(db, agencyId, { enabled, webMonth }) {
  const n = Number(String(webMonth ?? DEFAULT_WEB_MONTH).trim() || DEFAULT_WEB_MONTH);
  if (!Number.isInteger(n) || n < 0 || n > 1000) return { error: "web_month" };
  const { rows } = await db.query("UPDATE agencies SET assistant = $2::jsonb WHERE id = $1 RETURNING id, name", [agencyId, JSON.stringify({ web: Boolean(enabled), web_month: n })]);
  return rows[0] ? { ok: true, agency: rows[0], web: Boolean(enabled), web_month: n } : { error: "not_found" };
}

async function webUsed(db, agencyId, now) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM assistant_questions WHERE agency_id = $1 AND web AND created_at >= $2", [agencyId, monthStart(now).toISOString()]);
  return rows[0].n;
}

/** Every agency with its web setting and this month's web answers (the owner's page). */
async function overview(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.assistant,
            (SELECT count(*)::int FROM assistant_questions q WHERE q.agency_id = a.id AND q.created_at >= $1) AS asked,
            (SELECT count(*)::int FROM assistant_questions q WHERE q.agency_id = a.id AND q.web AND q.created_at >= $1) AS web_used
       FROM agencies a ORDER BY a.name`,
    [monthStart(now).toISOString()]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, web: r.assistant?.web === true, web_month: Number.isInteger(r.assistant?.web_month) ? r.assistant.web_month : DEFAULT_WEB_MONTH, asked: r.asked, web_used: r.web_used }));
}

/* ---------------------------------------------------------------------- */
/* The data blocks                                                         */
/* ---------------------------------------------------------------------- */

async function projectBlocks(pool, broker, question, scopes) {
  const { rows: projects } = await pool.query(
    `SELECT p.id, p.name, p.name_en, COALESCE(d.name, p.developer_name) AS developer_name FROM projects p LEFT JOIN developers d ON d.id = p.developer_id
      WHERE p.agency_id = $1 AND p.archived_at IS NULL ORDER BY p.name`,
    [broker.agency_id]
  );
  const named = A.matchProjects(question, projects).slice(0, MAX_PROJECTS);
  const blocks = [];
  const dates = [];
  for (const p of named) {
    const ctx = await ProjectContext.contextFor(pool, broker.agency_id, p.id);
    if (!ctx) continue;
    const f = ctx.facts;
    const lines = [ctx.summary];
    if (f.brochure?.facts?.length) lines.push(`Brochure (read ${f.brochure.as_of}): ${f.brochure.facts.join(" | ")}`);
    blocks.push({ title: `Project ${p.name}`, as_of: f.prices?.as_of || cairoDay(new Date(ctx.built_at)), text: lines.join("\n") });
    dates.push({ project: p.name, prices: f.prices?.as_of || null, brochure: f.brochure?.as_of || null });
  }
  // Nothing named and nothing personal asked: the list of projects we have, so "not in our data" is accurate.
  if (!named.length && !scopes.clients && !scopes.followups && projects.length) {
    blocks.push({ title: "Projects in our catalogue (names only)", as_of: cairoDay(), text: projects.slice(0, 80).map((p) => `${p.name}${p.name_en ? ` (${p.name_en})` : ""}${p.developer_name ? ` by ${p.developer_name}` : ""}`).join("; ") });
  }
  return { blocks, dates, named };
}

async function leadBlock(pool, broker, question, scopes) {
  const manager = isManager(broker);
  const { rows } = await pool.query(
    `SELECT l.id, l.ref, l.name, l.stage, l.kind, l.notes, l.next_follow_up_at, l.follow_up_status, l.last_contact_at, l.source, b.name AS broker_name,
            (SELECT array_agg(s.filters) FROM saved_searches s WHERE s.lead_id = l.id AND s.agency_id = l.agency_id) AS requests
       FROM leads l LEFT JOIN brokers b ON b.id = l.assigned_broker_id
      WHERE l.agency_id = $1 AND ($2 OR l.assigned_broker_id = $3) AND l.stage NOT IN ('won', 'lost')
      ORDER BY l.last_activity_at DESC LIMIT 400`,
    [broker.agency_id, manager, broker.id]
  );
  const named = A.matchLeads(question, rows);
  if (!scopes.clients && !named.length) return null;
  const pick = [...named, ...rows.filter((l) => !named.includes(l))].slice(0, MAX_LEADS);
  const lang = "en";
  const text = pick
    .map((l) => {
      const req = (l.requests || []).filter(Boolean).map((f) => Card.requestSummary(f, lang)).filter(Boolean).join(" / ");
      return [
        `${Card.refLabel(l.ref)} ${l.name || "(no name)"}`,
        `stage ${l.stage}`,
        manager && l.broker_name ? `broker ${l.broker_name}` : null,
        req ? `wants: ${req}` : null,
        l.follow_up_status === "open" && l.next_follow_up_at ? `next follow-up ${new Date(l.next_follow_up_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : null,
        l.last_contact_at ? `last contact ${cairoDay(new Date(l.last_contact_at))}` : "never contacted",
        named.includes(l) && l.notes ? `notes: ${String(l.notes).slice(0, 400)}` : null
      ]
        .filter(Boolean)
        .join("; ");
    })
    .join("\n");
  return { title: manager ? "The agency's open clients" : "Your open clients", as_of: cairoDay(), text: text || "(none)" };
}

async function followUpBlock(pool, broker, now) {
  const { rows } = await pool.query(
    `SELECT l.ref, l.name, l.next_follow_up_at, l.follow_up_kind, l.follow_up_note FROM leads l
      WHERE l.agency_id = $1 AND l.assigned_broker_id = $2 AND l.follow_up_status = 'open' AND l.next_follow_up_at <= $3
      ORDER BY l.next_follow_up_at LIMIT $4`,
    [broker.agency_id, broker.id, new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(), MAX_FOLLOW_UPS]
  );
  const fmt = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
  return {
    title: "Your follow-ups and viewings (overdue and the next 7 days, Cairo time)",
    as_of: cairoDay(now),
    text: rows.map((r) => `${fmt(r.next_follow_up_at)}: ${r.follow_up_kind || "call"} ${Card.refLabel(r.ref)} ${r.name || ""}${r.follow_up_note ? ` (${String(r.follow_up_note).slice(0, 120)})` : ""}`).join("\n") || "(none)"
  };
}

async function unitBlock(pool, broker, projectIds) {
  const { rows } = await pool.query(
    `SELECT l.code, l.property_type, l.listing_type, l.price_value, l.area_value, l.bedrooms, l.compound, l.district, l.city, l.finishing, l.delivery_year, l.is_ready, p.name AS project
       FROM listings l LEFT JOIN projects p ON p.id = l.project_id
      WHERE l.agency_id = $1 AND l.status = 'active' AND (cardinality($2::uuid[]) = 0 OR l.project_id = ANY($2::uuid[]))
      ORDER BY l.updated_at DESC LIMIT $3`,
    [broker.agency_id, projectIds, MAX_UNITS]
  );
  return {
    title: projectIds.length ? "Available units in those projects" : "The agency's available units (latest 60)",
    as_of: cairoDay(),
    text:
      rows
        .map((u) =>
          [
            u.code,
            typeLabel(u.property_type),
            u.listing_type === "rent" ? "rent" : "sale",
            u.price_value ? `${Math.round(Number(u.price_value))} EGP` : null,
            u.area_value ? `${Number(u.area_value)} m²` : null,
            u.bedrooms !== null && u.bedrooms !== undefined ? `${u.bedrooms} bd` : null,
            [u.project || u.compound, u.district, u.city].filter(Boolean).join(", ") || null,
            u.finishing || null,
            u.is_ready ? "ready" : u.delivery_year ? `delivery ${u.delivery_year}` : null
          ]
            .filter(Boolean)
            .join(" · ")
        )
        .join("\n") || "(none)"
  };
}

/* ---------------------------------------------------------------------- */
/* Asking                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * @returns {Promise<{ answer, found, lang, dates, web: { answer, sources } | null, webOff, webLimit } | { error }>}
 *   dates: [{ project, prices, brochure }] for the projects the answer could use (shown under the answer).
 */
async function ask(pool, broker, question, { channel = "web", now = new Date() } = {}) {
  const q = String(question || "").trim().slice(0, A.MAX_QUESTION);
  if (!q) return { error: "empty" };
  const lang = A.langOf(q);
  const scopes = A.scopesOf(q);
  const { blocks, dates, named } = await projectBlocks(pool, broker, q, scopes);
  const leads = await leadBlock(pool, broker, q, scopes);
  if (leads) blocks.push(leads);
  if (scopes.followups) blocks.push(await followUpBlock(pool, broker, now));
  if (scopes.units || named.length) blocks.push(await unitBlock(pool, broker, named.map((p) => p.id)));

  let res;
  try {
    const r = await AI.generateWithCascade({
      contents: A.prompt(q, blocks, { lang, today: cairoDay(now) }),
      config: { responseMimeType: "application/json", temperature: 0 },
      operationType: "assistant",
      ctx: { pool, broker }
    });
    res = A.parseAnswer(r.text, lang);
  } catch (err) {
    return { error: /QUOTA/.test(String(err.code || err.message)) ? "quota" : "ai" };
  }

  let web = null;
  let webOff = false;
  let webLimit = false;
  if (!res.found) {
    const setting = await webSetting(pool, broker.agency_id);
    if (!setting.web) webOff = true;
    else if ((await webUsed(pool, broker.agency_id, now)) >= setting.web_month) webLimit = true;
    else {
      try {
        const r = await AI.generateWithCascade({
          contents: A.webPrompt(q, { lang }),
          config: { tools: [{ googleSearch: {} }], temperature: 0 },
          operationType: "assistant_web",
          ctx: { pool, broker }
        });
        const sources = A.webSources(r.grounding);
        const text = String(r.text || "").trim().slice(0, 1500);
        // An answer with no source is not shown: it could not be checked.
        if (text && sources.length) web = { answer: text, sources };
      } catch (err) {
        console.warn("Assistant web answer failed:", err.message);
      }
    }
  }
  await pool.query("INSERT INTO assistant_questions (agency_id, broker_id, question, channel, found, web, scopes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    broker.agency_id,
    broker.id,
    q,
    channel,
    res.found,
    Boolean(web),
    [named.length ? "projects" : null, leads ? "clients" : null, scopes.followups ? "followups" : null, scopes.units || named.length ? "units" : null].filter(Boolean),
    now.toISOString()
  ]);
  return { answer: res.answer, found: res.found, lang, dates, web, webOff, webLimit };
}

/** The data dates under an answer, one line. */
function datesLine(dates, lang) {
  const en = lang === "en";
  const parts = dates.map((d) => {
    const bits = [d.prices ? (en ? `prices ${d.prices}` : `الأسعار ${d.prices}`) : null, d.brochure ? (en ? `brochure ${d.brochure}` : `البروشور ${d.brochure}`) : null].filter(Boolean);
    return bits.length ? `${d.project}: ${bits.join(en ? ", " : "، ")}` : null;
  });
  const list = parts.filter(Boolean);
  return list.length ? `📅 ${en ? "Data" : "البيانات"}: ${list.join(" · ")}` : "";
}

/** The managers' list of recent questions the data could not answer (what brokers need). */
async function unanswered(pool, manager, { limit = 30 } = {}) {
  if (!isManager(manager)) return null;
  const { rows } = await pool.query(
    `SELECT q.question, q.created_at, q.web, b.name AS broker_name FROM assistant_questions q LEFT JOIN brokers b ON b.id = q.broker_id
      WHERE q.agency_id = $1 AND NOT q.found ORDER BY q.created_at DESC LIMIT $2`,
    [manager.agency_id, limit]
  );
  return rows;
}

module.exports = { ask, datesLine, unanswered, webSetting, setWeb, overview };
