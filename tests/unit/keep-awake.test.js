// tests/unit/keep-awake.test.js — KEEP_AWAKE self-ping: off by default, Cairo window, failures never throw.
"use strict";

const K = require("../../lib/keepAwake");
const { loadConfig } = require("../../config");

test("off unless KEEP_AWAKE is true; default window 6-1", () => {
  expect(loadConfig({}).keepAwake).toEqual({ enabled: false, hours: "6-1" });
  expect(loadConfig({ KEEP_AWAKE: "true" }).keepAwake.enabled).toBe(true);
  expect(loadConfig({ KEEP_AWAKE: "false" }).keepAwake.enabled).toBe(false);
  expect(K.createKeepAwake({ enabled: false, url: "https://x/health" }).start()).toBe(false);
});

test("window parsing and wrap past midnight", () => {
  expect(K.parseHours("6-1")).toEqual({ from: 6, to: 1 });
  expect(K.parseHours("nonsense")).toBeNull();
  const w = { from: 6, to: 1 };
  expect(K.inWindow(9, w)).toBe(true);
  expect(K.inWindow(0, w)).toBe(true);
  expect(K.inWindow(3, w)).toBe(false);
  expect(K.inWindow(3, { from: 0, to: 0 })).toBe(true);
});

test("pings inside the Cairo window, skips outside, and swallows failures", async () => {
  const calls = [];
  const fetchImpl = async (url) => (calls.push(url), { ok: true, status: 200 });
  const day = K.createKeepAwake({ enabled: true, url: "https://x/health", fetchImpl, now: () => new Date("2026-11-02T08:00:00Z") });
  expect(await day.ping()).toBe("ok"); // 10:00 Cairo
  const night = K.createKeepAwake({ enabled: true, url: "https://x/health", fetchImpl, now: () => new Date("2026-11-02T01:30:00Z") });
  expect(await night.ping()).toBe("skipped"); // 03:30 Cairo
  expect(calls).toEqual(["https://x/health"]);
  const broken = K.createKeepAwake({ enabled: true, url: "https://x/health", fetchImpl: async () => { throw new Error("down"); }, now: () => new Date("2026-11-02T08:00:00Z"), log: { warn() {} } });
  expect(await broken.ping()).toBe("failed");
});
