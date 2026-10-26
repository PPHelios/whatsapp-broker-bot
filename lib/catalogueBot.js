// lib/catalogueBot.js — Smart quick updates to the catalogue on the bot (Release A, C4), managers only:
// "تحديث زيادة 7% على بادية من الشهر الجاي" (or a voice note that starts with "تحديث") → the card with the unit count
// and an example → ✅ Apply / ❌ Cancel → ↩️ Undo (24 hours). Buttons cu:ok|no|undo:<id> reload the update and the
// rights every time. services/catalogueUpdates.js does the work; the website has the same card (/app/catalogue/updates).
"use strict";

const Updates = require("../services/catalogueUpdates");
const Links = require("./links");
const { isManager } = require("./authz");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (ctx) => (ctx.lang === "en" ? "en" : "ar");
const dispatcher = () => require("./dispatcher");

const cardText = (u, lang) => {
  const c = Updates.card(u, lang);
  return [c.title, ...c.lines].join("\n");
};

/** "تحديث …" / "update …": reads the change and shows the card (or says what is missing). */
async function command(broker, { text = "" }, ctx) {
  const { reply, replyButtons, setTurnAction } = dispatcher();
  setTurnAction("catalogue_update");
  const lang = langOf(ctx);
  if (!isManager(broker)) {
    // Not a catalogue update for a broker: let the rest of the bot read the words.
    return "pass";
  }
  if (!String(text).trim()) {
    await reply(broker, `${L(lang, "⚡ ابعت التحديث بعد كلمة «تحديث»، كتابة أو فويس.", "⚡ Send the update after the word \"update\", typed or by voice.")}\n${Updates.errorText({ error: "not_understood" }, lang).replace(/^[^:：]+[:：]\s*/, "")}`);
    return "done";
  }
  const out = await Updates.interpret(ctx.pool, broker, { text, channel: "bot", lang });
  if (out.error) {
    await reply(broker, Updates.errorText(out, lang));
    return "done";
  }
  await replyButtons(broker, cardText(out.update, lang), [
    { id: `cu:ok:${out.update.id}`, title: L(lang, "✅ تطبيق", "✅ Apply") },
    { id: `cu:no:${out.update.id}`, title: L(lang, "❌ إلغاء", "❌ Cancel") }
  ]);
  return "done";
}

/** cu:ok / cu:no / cu:undo buttons; true when handled. */
async function handleButton(broker, id, ctx) {
  const m = String(id).match(/^cu:(ok|no|undo):([0-9a-f-]{36})$/i);
  if (!m) return false;
  const { reply, replyButtons, setTurnAction } = dispatcher();
  setTurnAction("catalogue_update");
  const lang = langOf(ctx);
  const [, action, updateId] = m;
  if (!isManager(broker)) {
    await reply(broker, Updates.errorText({ error: "forbidden" }, lang));
    return true;
  }
  if (action === "no") {
    const out = await Updates.discard(ctx.pool, broker, updateId);
    await reply(broker, out.ok ? L(lang, "🗑️ اتلغى، مفيش حاجة اتغيرت.", "🗑️ Cancelled; nothing changed.") : Updates.errorText(out, lang));
    return true;
  }
  if (action === "undo") {
    const out = await Updates.undo(ctx.pool, broker, updateId);
    if (out.error) await reply(broker, Updates.errorText(out, lang));
    else await reply(broker, `${L(lang, `↩️ اترجع التحديث (${out.restored} وحدة).`, `↩️ Undone (${out.restored} units).`)}${out.skipped ? L(lang, ` ${out.skipped} اتغيرت بعدها، سبناها.`, ` ${out.skipped} changed since and were left as they are.`) : ""}`);
    return true;
  }
  const out = await Updates.apply(ctx.pool, broker, updateId);
  if (out.error) {
    await reply(broker, Updates.errorText(out, lang));
    return true;
  }
  const later = out.update.action === "increase" && !out.update.payload?.now;
  const done = later
    ? L(lang, `✅ اتسجلت. الزيادة هتتطبق يوم ${out.update.payload.effective_on}.`, `✅ Saved. The increase applies on ${out.update.payload.effective_on}.`)
    : L(lang, `✅ اتطبق على ${out.changed} وحدة.`, `✅ Applied to ${out.changed} units.`);
  await replyButtons(broker, `${done}\n${L(lang, "تقدر تتراجع خلال 24 ساعة.", "You can undo within 24 hours.")}\n${Links.appUrl(`catalogue/updates/${updateId}`)}`, [
    { id: `cu:undo:${updateId}`, title: L(lang, "↩️ تراجع", "↩️ Undo") }
  ]);
  return true;
}

module.exports = { command, handleButton };
