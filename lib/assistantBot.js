// lib/assistantBot.js — The assistant on the bot (Release B, C10 + N1): "اسأل امتى استلام بادية؟" / "ask what's due
// today?", typed or by voice. services/assistant.js answers from the agency's own data only; the reply shows the data
// dates, and a web answer (only when the owner switched it on) always under its "from the web, unverified" label with
// the source links. Answers about projects carry the "📤 Send on WhatsApp" button on Telegram.
"use strict";

const Assistant = require("../services/assistant");
const A = require("../domain/assistant");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const dispatcher = () => require("./dispatcher");

/** The reply text: answer, data dates, web block or why there is none. */
function replyText(out) {
  const lang = out.lang;
  const lines = [out.answer];
  const dates = Assistant.datesLine(out.dates || [], lang);
  if (dates && out.found) lines.push(dates);
  if (out.web) {
    lines.push("", A.WEB_LABEL[lang], out.web.answer, ...out.web.sources.map((s) => `🔗 ${s.title}: ${s.url}`));
  } else if (!out.found && out.webLimit) {
    lines.push("", L(lang, "🌐 البحث على الإنترنت خلص للشهر ده.", "🌐 This month's web answers are used up."));
  }
  return lines.join("\n");
}

const ERRORS = {
  empty: ["❓ اكتب سؤالك بعد كلمة «اسأل».", "❓ Write your question after the word \"ask\"."],
  quota: ["⏳ المساعد وصل لحد النهارده، جرب بكرة.", "⏳ The assistant reached today's limit; try tomorrow."],
  ai: ["⚠️ المساعد مش متاح دلوقتي، جرب كمان شوية.", "⚠️ The assistant is not available right now; try again shortly."]
};

async function command(broker, { question = "" }, ctx) {
  const { reply, replyForClient, setTurnAction, withProgress } = dispatcher();
  setTurnAction("assistant");
  const lang = question ? A.langOf(question) : ctx.lang === "en" ? "en" : "ar";
  if (!String(question).trim()) {
    await reply(broker, L(lang, ...ERRORS.empty));
    return "done";
  }
  const out = await withProgress(broker, L(lang, "🔎 بدور في بياناتنا…", "🔎 Checking our data…"), () => Assistant.ask(ctx.pool, broker, question, { channel: broker.channel === "telegram" ? "telegram" : "whatsapp" }), { whatsapp: false });
  if (out.error) {
    await reply(broker, L(lang, ...(ERRORS[out.error] || ERRORS.ai)));
    return "done";
  }
  const text = replyText(out);
  // A found answer about a project is ready for a client: Telegram adds "Send on WhatsApp" with just the answer.
  if (out.found && out.dates?.length) await replyForClient(broker, text, { lang, clientText: out.answer });
  else await reply(broker, text);
  return "done";
}

module.exports = { command, replyText };
