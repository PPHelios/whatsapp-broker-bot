// routes/documents.js — Spreadsheets are no longer imported from chat; the manager-only import lives on the website
// (/app/units, Import) and the Telegram Mini App. A document sent to the bot gets a short pointer to it.
"use strict";

const { reply } = require("../lib/dispatcher");

async function handleDocument(broker, message, ctx) {
  const lang = (ctx && ctx.lang) || broker.preferred_lang || "ar";
  await reply(
    broker,
    lang === "en"
      ? "Spreadsheets can't be imported in chat. Managers import them from the app: open the menu, Units, Import."
      : "مش بنستورد ملفات الإكسيل من الشات. المدير بيستوردها من التطبيق: القائمة، الوحدات، استيراد."
  );
  return "done";
}

module.exports = { handleDocument };
