// lib/util.js
"use strict";
const crypto = require("crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizePhone = (p) =>
  p ? String(p).replace(/@.*$/, "").replace(/\D/g, "") : "";

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

function hashListingCode(code) {
  const raw = String(code ?? "")
    .trim()
    .toUpperCase();
  if (!raw) return 0;

  const digest = crypto.createHash("sha256").update(raw).digest();
  const hi = BigInt(`0x${digest.subarray(0, 8).toString("hex")}`);
  return Number(hi & BigInt(0x7fffffffffffffff));
}

function withTimeout(promise, ms, label = "operation") {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timeout`)), ms);
    })
  ]).finally(() => clearTimeout(t));
}

// Concurrency limiter with a bounded queue (back-pressure instead of unbounded growth).
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
      if (active < concurrency) run();
      else if (queue.length >= maxQueue)
        reject(Object.assign(new Error("QUEUE_FULL"), { code: "QUEUE_FULL" }));
      else queue.push(run);
    });
  limiter.stats = () => ({ active, queued: queue.length });
  return limiter;
}

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

// Runs tasks that share a key strictly one after another (per-broker / per-listing ordering).
function createSerializer() {
  const tails = new Map();
  const run = (key, fn) => {
    const prev = tails.get(key) || Promise.resolve();
    const result = prev.then(fn);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
  run.size = () => tails.size;
  return run;
}

// Sliding-window gate: at most `perMinute` calls start per rolling minute (waits instead of failing).
function createRateGate(perMinute) {
  const stamps = [];
  let chain = Promise.resolve();
  return () =>
    (chain = chain.then(async () => {
      for (;;) {
        const now = Date.now();
        while (stamps.length && now - stamps[0] > 60000) stamps.shift();
        if (stamps.length < perMinute) {
          stamps.push(now);
          return;
        }
        await sleep(stamps[0] + 60000 - now + 25);
      }
    }));
}

// Fixed-window counter with automatic memory leak pruning for long-running processes.
function createCounter(windowMs, max) {
  const m = new Map();
  let lastPrune = Date.now();

  return (key) => {
    const now = Date.now();

    // Periodically prune stale window keys to prevent memory leaks
    if (now - lastPrune > windowMs * 2) {
      for (const [k, v] of m.entries()) {
        if (now - v.start > windowMs) m.delete(k);
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
  cleanAudioMime
};
