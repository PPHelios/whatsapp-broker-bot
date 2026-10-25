// routes/telegramIngress.js — Telegram updates (Release 3T): links an unknown Telegram user (start token or own
// contact), claims button taps, then runs the same guarded turn as WhatsApp. Split out of server.js.
"use strict";

const TG = require("../lib/telegram");
const TgLink = require("../lib/tgLink");
const TgIngress = require("../lib/tgIngress");
const TapGuard = require("../lib/tapGuard");

const TG_COPY = {
  linkAsk:
    "👋 أهلاً! عشان نوصّل حسابك اضغط «📱 ابعت رقمي» تحت (لازم يكون نفس الرقم المسجل في وكالتك)، أو افتح رابط البداية اللي وصلك من مديرك.\n" +
    "👋 Hi! To link your account, tap \"📱 Share my number\" below (the number your agency registered), or open the start link your manager sent you.",
  shareButton: "📱 ابعت رقمي / Share my number",
  invalid: "⚠️ الرابط ده مش صالح أو اتستخدم قبل كده. اطلب رابط جديد من مديرك، أو اضغط «📱 ابعت رقمي».\n⚠️ This link is invalid or already used. Ask your manager for a new one, or tap \"📱 Share my number\".",
  notOwn: "⚠️ ابعت رقمك إنت من زرار «📱 ابعت رقمي».\n⚠️ Please share your own number with the \"📱 Share my number\" button.",
  unknown: "⚠️ الرقم ده مش متسجل كوسيط في WehdatHub. كلم مدير وكالتك.\n⚠️ This number isn't registered as a WehdatHub broker. Ask your agency admin.",
  linked: (b) => (b.preferred_lang === "en" ? `✅ Linked. Welcome, ${b.name}!` : `✅ تم ربط حسابك. أهلاً يا ${b.name}!`)
};

/** Builds the Telegram update handler around the pool, the tap guard and the shared turn runner. */
function createTelegramIngress({ pool, tapGuard, runTurn }) {
  async function tgAskToLink(chatId, text = TG_COPY.linkAsk) {
    await TG.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: { keyboard: [[{ text: TG_COPY.shareButton, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    }).catch((e) => console.warn("Telegram link prompt failed:", e.message));
  }

  /** Links an unknown Telegram user (start token or own contact); true when the update was about linking. */
  async function tgLink(norm) {
    let res = null;
    if (norm.start) res = await TgLink.linkByToken(pool, norm.start, norm.ids);
    else if (norm.contact) res = await TgLink.linkByContact(pool, norm.contact, norm.ids);
    else {
      await tgAskToLink(norm.ids.chatId);
      return null;
    }
    if (res.broker) {
      await TG.call("sendMessage", { chat_id: norm.ids.chatId, text: TG_COPY.linked(res.broker), reply_markup: { remove_keyboard: true } }).catch(() => {});
      return res.broker;
    }
    await tgAskToLink(norm.ids.chatId, res.error === "not_own" ? TG_COPY.notOwn : res.error === "unknown" ? TG_COPY.unknown : TG_COPY.invalid);
    return null;
  }

  /** One Telegram update: link if needed, then the same guarded turn as WhatsApp, answered on Telegram. */
  async function handleTelegramUpdate(update) {
    const norm = TgIngress.normalize(update);
    if (!norm) return;
    // A tap's spinner is stopped once we know whether the tap runs (a dropped tap gets a short toast instead).
    let answered = !norm.callbackId;
    const answer = (text = "") => {
      if (answered) return;
      answered = true;
      TG.answerCallback(norm.callbackId, text).catch(() => {});
    };
    let tap = null;
    try {
      await telegramTurn(norm, answer, (t) => (tap = t));
    } finally {
      answer();
      tap?.release();
    }
  }

  async function telegramTurn(norm, answer, holdTap) {
    let broker = await TgLink.findBroker(pool, norm.ids.userId);
    let message = norm.message || null;
    if (!broker) {
      broker = await tgLink(norm);
      if (!broker) return;
      message = { id: `tg:${norm.ids.chatId}:start:${Date.now()}`, from: `tg:${norm.ids.userId}`, type: "text", text: { body: broker.preferred_lang === "en" ? "help" : "مساعدة" } };
    } else if (norm.start !== undefined) {
      // /start from a linked broker: the command list.
      message = { id: `tg:${norm.ids.chatId}:start:${Date.now()}`, from: `tg:${norm.ids.userId}`, type: "text", text: { body: broker.preferred_lang === "en" ? "help" : "مساعدة" } };
    } else if (norm.callbackId) {
      const id = await TgLink.decodeCallback(pool, norm.data);
      if (!id) return;
      const tap = tapGuard.claim(broker.id, id);
      if (!tap.ok) return answer(TapGuard.toast(tap.reason, broker.preferred_lang));
      holdTap(tap);
      message = TgIngress.buttonMessage(norm, id);
      // "More" is used once: its button leaves the earlier results (the next page comes as a new message).
      if (norm.messageId && (id === "MORE_SEARCH" || id.startsWith("search_more:"))) {
        TG.call("editMessageReplyMarkup", { chat_id: norm.ids.chatId, message_id: norm.messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
    }
    if (!message) return;
    if (String(broker.telegram_chat_id) !== String(norm.ids.chatId)) {
      await pool.query("UPDATE brokers SET telegram_chat_id = $2 WHERE id = $1", [broker.id, norm.ids.chatId]);
    }
    broker = { ...broker, channel: "telegram", telegram_chat_id: norm.ids.chatId };
    answer();
    TG.sendTyping(norm.ids.chatId).catch(() => {});
    await runTurn(broker, message, `tg:${norm.ids.userId}`);
  }

  return { handleTelegramUpdate };
}

module.exports = { TG_COPY, createTelegramIngress };
