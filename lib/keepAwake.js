// lib/keepAwake.js — Optional self-ping that keeps a Render Free instance from spinning down (P4.4).
"use strict";

/**
 * Render Free stops an instance after 15 minutes without inbound traffic, and the free plan has a
 * monthly cap on instance hours. So this is OFF unless KEEP_AWAKE=true. When on, the instance asks
 * its own public /health every 10 minutes during the Cairo working window (KEEP_AWAKE_HOURS,
 * default 6-1 = 06:00 to 01:00) and lets itself sleep overnight. A request to the public URL goes
 * through Render's router, which is what counts as traffic.
 */

const EVERY_MS = 10 * 60 * 1000;

/** Parses "6-1" into { from: 6, to: 1 } (hours 0–24, may wrap past midnight); null when invalid. */
function parseHours(spec) {
  const m = String(spec || "").trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from > 24 || to > 24) return null;
  return { from: from % 24, to: to % 24 };
}

/** Current hour in Africa/Cairo. */
function cairoHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", hourCycle: "h23" }).format(now));
}

/** True when the hour falls inside the window [from, to); from === to means all day. */
function inWindow(hour, { from, to }) {
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function createKeepAwake({ enabled, url, hours, fetchImpl = globalThis.fetch, now = () => new Date(), log = console } = {}) {
  let timer = null;
  const window = parseHours(hours) || { from: 6, to: 1 };

  async function ping() {
    if (!inWindow(cairoHour(now()), window)) return "skipped";
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
      return res.ok ? "ok" : `status_${res.status}`;
    } catch (err) {
      log.warn?.(`[KEEP_AWAKE] ping failed: ${err.message}`);
      return "failed";
    }
  }

  return {
    window,
    ping,
    /** Starts the timer when enabled; returns whether it started. */
    start() {
      if (!enabled || !url || timer) return false;
      timer = setInterval(ping, EVERY_MS);
      timer.unref?.();
      return true;
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { EVERY_MS, parseHours, cairoHour, inWindow, createKeepAwake };
