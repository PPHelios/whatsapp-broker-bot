// domain/leadCard.js — How a lead reads: reference, display name, the card, timeline lines (pure, both languages)
// A lead with no name is "Client ••5678", never an invented name. Notes stay internal: they are on the
// broker's card only, never in a client copy or a public page.
"use strict";

const Phone = require("./phone");
const Stages = require("./leadStages");

const L = (lang, ar, en) => (lang === "en" ? en : ar);

/** 42 → "L-0042". */
const refLabel = (ref) => `L-${String(ref).padStart(4, "0")}`;

/** "L-0042", "l-42", "ل-42", "#L42" → 42; anything else → null. */
function parseRef(text) {
  const m = Phone.toAsciiDigits(String(text || "")).trim().match(/^#?(?:L|ل)\s*-?\s*0*(\d{1,7})$/i);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

/** The lead's name, or "Client ••5678" / "عميل ••5678". */
function displayName(lead, lang) {
  const name = String(lead?.name || "").trim();
  if (name) return name;
  return L(lang, `عميل ••${Phone.last4(lead?.phone_e164)}`, `Client ••${Phone.last4(lead?.phone_e164)}`);
}

/** One line for lists: "L-0042 · Ahmed · 🆕 New". */
function listLine(lead, lang) {
  return `${refLabel(lead.ref)} · ${displayName(lead, lang)} · ${Stages.stageLabel(lead.stage, lang)}`;
}

const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "");

/**
 * The broker's card for a lead (WhatsApp text and the web header).
 * @param {Object} opts - { lang, assigneeName, request (one-line summary), now }
 */
function card(lead, { lang = "ar", assigneeName = null, request = null } = {}) {
  const lines = [`👤 ${displayName(lead, lang)} · ${refLabel(lead.ref)}`];
  lines.push(`📱 ${(lead.phones?.length ? lead.phones : [lead.phone_e164]).map((p) => Phone.displayPhone(p)).join(" · ")}`);
  lines.push(`${Stages.kindLabel(lead.kind, lang)} · ${Stages.stageLabel(lead.stage, lang)}${lead.stage === "lost" && lead.lost_reason ? ` (${lead.lost_reason})` : ""}`);
  if (lead.hot_at) lines.push(L(lang, "🔥 عميل مهتم جداً", "🔥 Hot client"));
  if (request) lines.push(`🔎 ${request}`);
  if (lead.follow_up_status === "open" && lead.next_follow_up_at) {
    const what = lead.follow_up_kind === "viewing" ? L(lang, "معاينة", "Viewing") : L(lang, "متابعة", "Follow-up");
    lines.push(`⏰ ${what}: ${when(lead.next_follow_up_at)}${lead.follow_up_note ? ` · ${lead.follow_up_note}` : ""}`);
  } else if (!Stages.isClosed(lead.stage)) {
    lines.push(L(lang, "⏰ مفيش خطوة جاية", "⏰ No next step"));
  }
  if (assigneeName) lines.push(L(lang, `🧑‍💼 مع: ${assigneeName}`, `🧑‍💼 With: ${assigneeName}`));
  else if (lead.assigned_broker_id === null) lines.push(L(lang, "🧑‍💼 مش متسلم لحد", "🧑‍💼 Unassigned"));
  if (lead.notes) lines.push(`📝 ${lead.notes}`);
  return lines.join("\n");
}

/** One timeline line for an event row ({ kind, data, broker_name, created_at, undone_at }). */
function timelineLine(ev, lang) {
  const d = ev.data || {};
  const who = ev.broker_name ? ` · ${ev.broker_name}` : "";
  const text = (() => {
    switch (ev.kind) {
      case "created":
        return L(lang, "🆕 اتسجل", "🆕 Added");
      case "inquiry":
        return d.colleague ? L(lang, "📨 زميل حاول يسجله تاني", "📨 A colleague tried to add them again") : L(lang, "📨 سأل تاني", "📨 Asked again");
      case "assigned":
        return d.to_name ? L(lang, `🧑‍💼 اتسلم لـ ${d.to_name}`, `🧑‍💼 Assigned to ${d.to_name}`) : L(lang, "🧑‍💼 رجع للمجموعة", "🧑‍💼 Back to the unassigned pool");
      case "stage":
        return `➡️ ${Stages.stageLabel(d.to, lang)}${d.lost_reason ? ` (${d.lost_reason})` : ""}`;
      case "note":
        return `📝 ${d.text || ""}`;
      case "contacted":
        return L(lang, "📞 اتكلمنا", "📞 Contacted");
      case "follow_up_set":
        return `⏰ ${d.kind === "viewing" ? L(lang, "معاينة", "Viewing") : L(lang, "متابعة", "Follow-up")} ${when(d.at)}`;
      case "follow_up_done":
        return L(lang, "✔️ المتابعة خلصت", "✔️ Follow-up done");
      case "request_set":
        return L(lang, "🔎 الطلب اتحدث", "🔎 Request updated");
      case "match_sent":
        return L(lang, `🏠 وحدة مناسبة: ${d.code || ""}`, `🏠 Match: ${d.code || ""}`);
      case "share_opened":
        return L(lang, `👀 فتح ${d.code || "الرابط"}`, `👀 Opened ${d.code || "the link"}`);
      case "deal":
        return L(lang, "💰 صفقة", "💰 Deal");
      case "exported":
        return L(lang, "📦 اتصدّرت بياناته", "📦 Data exported");
      case "merged":
        return L(lang, "🔗 رقم إضافي اتضاف", "🔗 Another number added");
      case "undo":
        return L(lang, "↩️ تراجع", "↩️ Undone");
      default:
        return ev.kind;
    }
  })();
  return `${when(ev.created_at)} ${text}${who}${ev.undone_at ? L(lang, " (اتلغى)", " (undone)") : ""}`;
}

module.exports = { refLabel, parseRef, displayName, listLine, card, timelineLine };
