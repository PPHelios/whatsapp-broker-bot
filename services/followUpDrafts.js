// services/followUpDrafts.js — Follow-up message drafts (Release B, N2): after a call or viewing, the next WhatsApp
// message to the client, drafted from the lead's own record (domain/followUpDraft.js) in the broker's tone (their
// optional sample in Settings, brokers.draft_style). Only someone who may see the lead can draft; one text call from
// the agency's allowance. The broker reviews and sends it themselves (wa.me to the client's number).
"use strict";

const AI = require("../lib/ai");
const D = require("../domain/followUpDraft");
const Card = require("../domain/leadCard");
const Phone = require("../domain/phone");
const Leads = require("./leads");
const LeadRequests = require("./leadRequests");
const Viewings = require("./viewings");

/** → { text, lead, wa } | { error: 'not_found' | 'quota' | 'ai' | 'empty' } */
async function draft(pool, broker, leadKey, { lang = "ar" } = {}) {
  const lead = await Leads.getLead(pool, broker, leadKey);
  if (!lead) return { error: "not_found" };
  const [{ rows: events }, requests, viewing, { rows: me }] = await Promise.all([
    pool.query("SELECT kind, data, created_at FROM lead_events WHERE lead_id = $1 AND agency_id = $2 AND undone_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 12", [lead.id, broker.agency_id]),
    LeadRequests.listRequests(pool, broker, lead),
    Viewings.latestFor(pool, broker.agency_id, lead.id),
    pool.query("SELECT b.name, b.draft_style, a.name AS agency_name FROM brokers b JOIN agencies a ON a.id = b.agency_id WHERE b.id = $1", [broker.id])
  ]);
  const facts = D.factsOf({ lead, events, requests, viewing, broker: { name: me[0]?.name || broker.name }, agencyName: me[0]?.agency_name, requestLine: (f) => Card.requestSummary(f, "en") });
  let out;
  try {
    const r = await AI.generateWithCascade({
      contents: D.prompt(facts, { lang, style: me[0]?.draft_style }),
      config: { responseMimeType: "application/json", temperature: 0.4 },
      operationType: "follow_up_draft",
      ctx: { pool, broker }
    });
    out = D.parse(r.text);
  } catch (err) {
    return { error: /QUOTA/.test(String(err.code || err.message)) ? "quota" : "ai" };
  }
  if (out.error) return out;
  return { text: out.text, lead, wa: Phone.waMeUrl(lead.phone_e164, out.text) };
}

/** The broker's tone sample (Settings); empty clears it. */
async function saveStyle(pool, broker, text) {
  const t = String(text || "").trim().slice(0, D.MAX_STYLE);
  await pool.query("UPDATE brokers SET draft_style = $3 WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id, t || null]);
  return { ok: true };
}

module.exports = { draft, saveStyle };
