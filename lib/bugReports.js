// lib/bugReports.js — *bug …* / *مشكلة …* in the bot (WhatsApp and Telegram): the broker's report goes to the owner
"use strict";

const ErrorReports = require("./errorReports");
const { reply } = require("./dispatcher");

// "bug" / "/bug" / "report bug" / "بلاغ" with or without the description; "مشكلة" alone or with a colon ("مشكلة: …"),
// so a client's forwarded "مشكلة الشقة…" stays a normal message.
const COMMAND = /^(?:\/?(?:bug|report(?:\s+a)?\s+bug|بلاغ)(?=$|[\s:：\-])|(?:مشكلة|مشكله)(?=$|\s*[:：]))\s*[:：\-]?\s*([\s\S]*)$/i;
const CANCEL = /^(?:cancel|الغاء|إلغاء|لا)$/i;
const SESSION = "bug_report";

const COPY = {
  ask: {
    ar: "🐞 اكتب في رسالة واحدة إيه اللي حصل وإيه اللي كنت متوقعه (أو *إلغاء*).",
    en: "🐞 Describe in one message what happened and what you expected (or *cancel*)."
  },
  sent: {
    ar: (id) => `✅ وصلنا البلاغ #R${id}. شكراً! هنبص عليه في أقرب وقت.`,
    en: (id) => `✅ Got it, report #R${id}. Thank you! We'll look into it soon.`
  },
  limited: {
    ar: "⚠️ بعت بلاغات كتير الساعة دي، حاول تاني بعد شوية.",
    en: "⚠️ Too many reports this hour; please try again later."
  },
  cancelled: { ar: "تمام، اتلغى.", en: "OK, cancelled." }
};

async function send(broker, ctx, text) {
  const r = await ErrorReports.submitReport(ctx.pool, broker, { text, channel: broker.channel || "whatsapp" });
  const lang = ctx.lang === "en" ? "en" : "ar";
  await reply(broker, r.limited ? COPY.limited[lang] : COPY.sent[lang](r.id));
}

/**
 * A text turn: a pending "describe the problem" prompt takes this message as the report; *bug …* sends one
 * (or asks for the description). True when the message was handled here.
 */
async function handle(broker, text, ctx) {
  const { pool } = ctx;
  const lang = ctx.lang === "en" ? "en" : "ar";
  const m = String(text || "").trim().match(COMMAND);

  if (!m) {
    const { rowCount } = await pool.query(
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()",
      [broker.id, SESSION]
    );
    if (!rowCount) return false;
    if (CANCEL.test(String(text).trim())) {
      await reply(broker, COPY.cancelled[lang]);
      return true;
    }
    await send(broker, ctx, text);
    return true;
  }

  const description = m[1].trim();
  if (description.length >= 3) {
    await pool.query("DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2", [broker.id, SESSION]);
    await send(broker, ctx, description);
    return true;
  }
  await pool.query(
    `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
     VALUES ($1, $2, '{}'::jsonb, NOW() + INTERVAL '10 minutes')
     ON CONFLICT (broker_id, session_type) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [broker.id, SESSION]
  );
  await reply(broker, COPY.ask[lang]);
  return true;
}

module.exports = { handle, COMMAND };
