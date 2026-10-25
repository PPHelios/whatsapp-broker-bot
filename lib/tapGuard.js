// lib/tapGuard.js — Drops repeated button taps (double taps, impatient re-taps while a slow review runs).
// A tap is dropped while the same broker's previous tap is still being handled, or when it is the same button
// again within a short window after that tap finished. Kept in memory: the bot runs as one instance.
"use strict";

const REPEAT_WINDOW_MS = 3000;
const STALE_MS = 90000; // a turn this old no longer holds the broker (a hung turn must not block every tap)

/**
 * @param {Object} [opts] - { windowMs, now }
 * @returns {{ claim(brokerId, buttonId): { ok: true, release() } | { ok: false, reason: "busy" | "repeat" } }}
 */
function createTapGuard({ windowMs = REPEAT_WINDOW_MS, now = () => Date.now() } = {}) {
  const busy = new Map(); // brokerId -> { id, at } tap being handled
  const recent = new Map(); // brokerId -> { id, at } last tap that finished

  function claim(brokerId, buttonId) {
    const key = String(brokerId);
    const t = now();
    const running = busy.get(key);
    if (running && t - running.at < STALE_MS) return { ok: false, reason: "busy" };
    const last = recent.get(key);
    if (last && last.id === buttonId && t - last.at < windowMs) return { ok: false, reason: "repeat" };
    const entry = { id: buttonId, at: t };
    busy.set(key, entry);
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        if (busy.get(key) === entry) busy.delete(key);
        recent.set(key, { id: buttonId, at: now() });
      }
    };
  }

  return { claim };
}

/** The button or list row id of an inbound interactive message, or null for anything else. */
function tapId(message) {
  if (message?.type !== "interactive") return null;
  const i = message.interactive || {};
  return i.button_reply?.id || i.list_reply?.id || null;
}

// Toast shown on Telegram when a tap is dropped.
const TOAST = {
  busy: { ar: "⏳ لحظة، لسه بنخلّص طلبك اللي فات", en: "⏳ One moment, still working on your last tap" },
  repeat: { ar: "✅ وصلت، مش محتاج تضغط تاني", en: "✅ Got it, no need to tap again" }
};
const toast = (reason, lang) => TOAST[reason]?.[lang === "en" ? "en" : "ar"] || "";

module.exports = { createTapGuard, tapId, toast, REPEAT_WINDOW_MS, STALE_MS };
