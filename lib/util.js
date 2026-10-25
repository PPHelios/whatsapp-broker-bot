// lib/util.js — Concurrency Limiters, Rate Gates, Serializers & Helper Utilities
"use strict";

const crypto = require("crypto");

const Phone = require("../domain/phone");

/**
 * Promise-based non-blocking sleep timer.
 */
const sleep = (ms) =>
  new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

/**
 * Normalizes phone numbers to international digits through domain/phone.js (the one rule, P1).
 * Keeps the old contract for callers: "" for empty input, and plain digits when the input is not a
 * recognizable phone (WhatsApp ids are always international, so they pass through unchanged).
 */
const normalizePhone = (p) =>
  p ? Phone.normalizePhone(p) || toAsciiDigitsOnly(p) : "";
const toAsciiDigitsOnly = (p) => Phone.toAsciiDigits(String(p).replace(/@.*$/, "")).replace(/\D/g, "");

/**
 * Generates standard hex-encoded SHA-1 hash.
 */
const sha1 = (s) =>
  crypto
    .createHash("sha1")
    .update(String(s || ""))
    .digest("hex");

/**
 * Deterministic numeric hash of property codes for numeric partitioning or hashing.
 */
function hashListingCode(code) {
  const raw = String(code ?? "")
    .trim()
    .toUpperCase();
  if (!raw) return 0;

  const digest = crypto.createHash("sha256").update(raw).digest();
  const hi = BigInt(`0x${digest.subarray(0, 8).toString("hex")}`);
  return Number(hi & BigInt(0x7fffffffffffffff));
}

/**
 * Enforces a strict execution timeout on any asynchronous Promise.
 */
function withTimeout(promise, ms, label = "operation") {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => {
        const err = new Error(`${label} timeout`);
        err.code = "TIMEOUT";
        rej(err);
      }, ms);
    })
  ]).finally(() => clearTimeout(t));
}

/**
 * Concurrency limiter with a bounded FIFO queue to apply back-pressure.
 */
function createLimiter(concurrency, { maxQueue = Infinity } = {}) {
  let active = 0;
  const queue = [];

  const next = () => {
    active--;
    const job = queue.shift();
    if (job) job();
  };

  const limiter = (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(next);
      };

      if (active < concurrency) {
        run();
      } else if (queue.length >= maxQueue) {
        const err = new Error("QUEUE_FULL");
        err.code = "QUEUE_FULL";
        reject(err);
      } else {
        queue.push(run);
      }
    });

  limiter.stats = () => ({ active, queued: queue.length });
  return limiter;
}

/**
 * Maps incoming audio MIME types to canonical formats supported by Google Gemini.
 */
function cleanAudioMime(raw) {
  if (!raw) return "audio/ogg";
  const clean = String(raw).split(";")[0].trim().toLowerCase();

  const SUPPORTED_AUDIO_MAP = {
    "audio/ogg": "audio/ogg",
    "audio/opus": "audio/ogg",
    "audio/oga": "audio/ogg",
    "audio/aac": "audio/aac",
    "audio/mp4": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "audio/x-m4a": "audio/mp4",
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/amr": "audio/amr",
    "audio/3gpp": "audio/mp4",
    "audio/webm": "audio/webm",
    "audio/mp3": "audio/mp3",
    "audio/mpeg": "audio/mp3"
  };

  return SUPPORTED_AUDIO_MAP[clean] || "audio/ogg";
}

/**
 * Runs tasks sharing the same key strictly one after another (FIFO per broker or code).
 */
function createSerializer() {
  const tails = new Map();

  const run = (key, fn) => {
    const prev = tails.get(key) || Promise.resolve();
    const result = prev.then(fn);
    const tail = result.catch(() => {});
    tails.set(key, tail);

    tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });

    return result;
  };

  run.size = () => tails.size;
  return run;
}

/**
 * Sliding-window gatekeeper: ensures at most `perMinute` calls execute per rolling 60 seconds.
 */
function createRateGate(perMinute) {
  const stamps = [];
  let chain = Promise.resolve();

  return () =>
    (chain = chain.then(async () => {
      for (;;) {
        const now = Date.now();
        while (stamps.length && now - stamps[0] > 60000) {
          stamps.shift();
        }

        if (stamps.length < perMinute) {
          stamps.push(now);
          return;
        }

        await sleep(stamps[0] + 60000 - now + 25);
      }
    }));
}

/**
 * Fixed-window counter with automatic memory-leak pruning for long-running worker loops.
 */
function createCounter(windowMs, max) {
  const m = new Map();
  let lastPrune = Date.now();

  return (key) => {
    const now = Date.now();

    // Periodically prune stale keys to eliminate memory leaks
    if (now - lastPrune > windowMs * 2) {
      for (const [k, v] of m.entries()) {
        if (now - v.start > windowMs) {
          m.delete(k);
        }
      }
      lastPrune = now;
    }

    const e = m.get(key);
    if (!e || now - e.start > windowMs) {
      m.set(key, { start: now, n: 1 });
      return true;
    }

    e.n++;
    return e.n <= max;
  };
}

/**
 * Validates whether an incoming binary buffer matches PKZip magic bytes (50 4B 03 04).
 * Used to verify .xlsx workbooks before feeding them to decompression engines.
 */
function isValidZipBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 4) return false;
  return (
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
    (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
  );
}

module.exports = {
  sleep,
  normalizePhone,
  sha1,
  hashListingCode,
  withTimeout,
  createLimiter,
  createSerializer,
  createRateGate,
  createCounter,
  cleanAudioMime,
  isValidZipBuffer
};
