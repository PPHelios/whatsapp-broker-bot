"use strict";
const crypto = require("crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizePhone = (p) => (p ? String(p).replace(/@.*$/, "").replace(/\D/g, "") : "");
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

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

// Tiny fixed-window counter for abuse protection.
function createCounter(windowMs, max) {
  const m = new Map();
  return (key) => {
    const now = Date.now();
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
  sleep, normalizePhone, sha1, withTimeout,
  createLimiter, createSerializer, createRateGate, createCounter
};
