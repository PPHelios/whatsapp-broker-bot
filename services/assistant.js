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
const Vis = require("../lib/visibility");

const MAX_PROJECTS = 3;
const MAX_LEADS = 60;
const MAX_UNITS = 60;
const MAX_FOLLOW_UPS = 30;

const cairoDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const monthStart = (now) => {
  const [y, m] = cairoDay(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1) - 3 * 3600 * 1000); // a few hours early is fine for a monthly count
};
const typeLabel = (t) => (Describe.TYPE_LABELS?.[t] ? Describe.TYPE_LABELS[t][1] : t || "unit");

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
    dates.push({ project: p.name, prices: f.prices?.as_of || null, brochure: f.brochure?.as_of || null, plans: f.sources?.plans?.as_of || null });
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
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND ($2 OR l.assigned_broker_id = $3) AND l.stage NOT IN ('won', 'lost')
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
      WHERE ${Vis.leads("l")} AND l.agency_id = $1 AND l.assigned_broker_id = $2 AND l.follow_up_status = 'open' AND l.next_follow_up_at <= $3
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
    `SELECT l.code, l.property_type, l.listing_type, l.price_value, l.area_value, l.bedrooms, l.compound, l.district, l.city, l.finishing, l.delivery_year, l.is_ready, l.details->>'notes' AS note, p.name AS project
       FROM listings l LEFT JOIN projects p ON p.id = l.project_id
      WHERE ${Vis.units("l")} AND l.agency_id = $1 AND l.status = 'active' AND (cardinality($2::uuid[]) = 0 OR l.project_id = ANY($2::uuid[]))
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
            u.is_ready ? "ready" : u.delivery_year ? `delivery ${u.delivery_year}` : null,
            u.note ? `note: ${String(u.note).slice(0, 200)}` : null
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
 * @returns {Promise<{ answer, found, lang, dates } | { error }>}
 *   dates: [{ project, prices, brochure, plans }] for the projects the answer could use (shown under the answer).
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

  await pool.query("INSERT INTO assistant_questions (agency_id, broker_id, question, channel, found, web, scopes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    broker.agency_id,
    broker.id,
    q,
    channel,
    res.found,
    false,
    [named.length ? "projects" : null, leads ? "clients" : null, scopes.followups ? "followups" : null, scopes.units || named.length ? "units" : null].filter(Boolean),
    now.toISOString()
  ]);
  return { answer: res.answer, found: res.found, lang, dates };
}

/** The data dates under an answer, one line. */
function datesLine(dates, lang) {
  const en = lang === "en";
  const parts = dates.map((d) => {
    const bits = [d.prices ? (en ? `prices ${d.prices}` : `الأسعار ${d.prices}`) : null, d.brochure ? (en ? `brochure ${d.brochure}` : `البروشور ${d.brochure}`) : null, d.plans ? (en ? `plans file ${d.plans}` : `ملف الأنظمة ${d.plans}`) : null].filter(Boolean);
    return bits.length ? `${d.project}: ${bits.join(en ? ", " : "، ")}` : null;
  });
  const list = parts.filter(Boolean);
  return list.length ? `📅 ${en ? "Data" : "البيانات"}: ${list.join(" · ")}` : "";
}

/** The managers' list of recent questions the data could not answer (what brokers need). */
async function unanswered(pool, manager, { limit = 30 } = {}) {
  if (!isManager(manager)) return null;
  const { rows } = await pool.query(
    `SELECT q.id, q.question, q.created_at, q.web, b.name AS broker_name FROM assistant_questions q LEFT JOIN brokers b ON b.id = q.broker_id
      WHERE q.agency_id = $1 AND NOT q.found AND q.resolved_at IS NULL ORDER BY q.created_at DESC LIMIT $2`,
    [manager.agency_id, limit]
  );
  return rows;
}

/**
 * A manager adds the information a question needed: to a project's notes (the assistant's project context is rebuilt)
 * or to a unit's internal notes. → { ok, target } | { error: forbidden|empty|not_found }
 */
async function addInfo(pool, manager, { questionId = null, project = null, unit = null, text }) {
  if (!isManager(manager)) return { error: "forbidden" };
  const note = String(text || "").trim().slice(0, 500);
  if (!note) return { error: "empty" };
  let target = null;
  if (String(unit || "").trim()) {
    const Store = require("../lib/listingStore");
    const listing = await Store.findByCode(pool, manager.agency_id, String(unit).trim());
    if (!listing) return { error: "not_found" };
    await pool.query(
      `UPDATE listings SET details = jsonb_set(details, '{notes}', to_jsonb(left(concat_ws(E'\n', NULLIF(details->>'notes', ''), $3::text), 1000))), updated_at = now() WHERE id = $1 AND agency_id = $2`,
      [listing.id, manager.agency_id, note]
    );
    target = { kind: "unit", name: listing.code };
  } else if (/^[0-9a-f-]{36}$/i.test(String(project || ""))) {
    const { rows } = await pool.query(
      "UPDATE projects SET notes = left(concat_ws(E'\n', NULLIF(notes, ''), $3::text), 1500), updated_at = now() WHERE id = $1 AND agency_id = $2 RETURNING name",
      [project, manager.agency_id, note]
    );
    if (!rows[0]) return { error: "not_found" };
    target = { kind: "project", name: rows[0].name };
  } else {
    return { error: "not_found" };
  }
  if (/^\d{1,12}$/.test(String(questionId || ""))) {
    await pool.query("UPDATE assistant_questions SET resolved_at = now() WHERE id = $1 AND agency_id = $2", [questionId, manager.agency_id]);
  }
  return { ok: true, target };
}

module.exports = { addInfo, ask, datesLine, unanswered };
