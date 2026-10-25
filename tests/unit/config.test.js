// tests/unit/config.test.js — config.js: production fail-fast, URLs, prices, quotas
"use strict";

const { loadConfig, estimateCostUsd, REQUIRED_IN_PRODUCTION } = require("../../config");

const PROD = Object.fromEntries(REQUIRED_IN_PRODUCTION.map((k) => [k, "x"]));
PROD.NODE_ENV = "production";
PROD.PUBLIC_BASE_URL = "https://aqarchat.onrender.com/";

test("production refuses to start without required variables", () => {
  expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/WHATSAPP_APP_SECRET/);
  const { DATABASE_URL, ...noDb } = PROD;
  expect(() => loadConfig(noDb)).toThrow(/DATABASE_URL/);
});

test("production requires an https PUBLIC_BASE_URL; trailing slash is dropped", () => {
  expect(() => loadConfig({ ...PROD, PUBLIC_BASE_URL: "http://x.com" })).toThrow(/https/);
  expect(loadConfig(PROD).publicBaseUrl).toBe("https://aqarchat.onrender.com");
});

test("on Render, RENDER_EXTERNAL_URL stands in until PUBLIC_BASE_URL is set; PUBLIC_BASE_URL wins", () => {
  const { PUBLIC_BASE_URL, ...noBase } = PROD;
  expect(() => loadConfig(noBase)).toThrow(/PUBLIC_BASE_URL/);
  expect(loadConfig({ ...noBase, RENDER_EXTERNAL_URL: "https://aqarchat-x1.onrender.com" }).publicBaseUrl).toBe("https://aqarchat-x1.onrender.com");
  expect(loadConfig({ ...PROD, RENDER_EXTERNAL_URL: "https://aqarchat-x1.onrender.com" }).publicBaseUrl).toBe("https://aqarchat.onrender.com");
});

test("unsigned webhooks are never allowed in production, and only by opt-in elsewhere", () => {
  expect(loadConfig({ ...PROD, WEBHOOK_ALLOW_UNSIGNED: "true" }).whatsapp.allowUnsigned).toBe(false);
  expect(loadConfig({}).whatsapp.allowUnsigned).toBe(false);
  expect(loadConfig({ WEBHOOK_ALLOW_UNSIGNED: "true" }).whatsapp.allowUnsigned).toBe(true);
});

test("db settings: statement_timeout default, SSL on in production", () => {
  const c = loadConfig(PROD);
  expect(c.db.statementTimeoutMs).toBe(10000);
  expect(c.db.ssl).toBe(true);
  expect(loadConfig({}).db.ssl).toBe(false);
});

test("model prices are overridable and drive cost", () => {
  const c = loadConfig({ AI_PRICES_JSON: '{"m":{"inPerM":1,"outPerM":10}}' });
  expect(estimateCostUsd("m", 1e6, 1e5, c.ai.prices)).toBe(2);
  // Unknown model falls back to the default price.
  expect(estimateCostUsd("unknown", 1e6, 0, c.ai.prices)).toBe(c.ai.prices.default.inPerM);
  expect(() => loadConfig({ AI_PRICES_JSON: "{bad" })).toThrow(/AI_PRICES_JSON/);
});

test("quotas come from env", () => {
  const c = loadConfig({ AI_QUOTA_AGENCY_DAILY: "50", AI_QUOTA_BROKER_DAILY: "5" });
  expect(c.ai.quotas).toEqual({ agencyDaily: 50, brokerDaily: 5 });
});

test("built-in Gemini prices: Flash $0.75/$3.75 now, $1.50/$7.50 from 1 January 2027; Flash-Lite $0.30/$2.50", () => {
  const { DEFAULT_AI_PRICES } = require("../../config");
  expect(estimateCostUsd("gemini-3.8-flash", 1e6, 1e6, DEFAULT_AI_PRICES, new Date("2026-10-25T00:00:00Z"))).toBe(4.5);
  expect(estimateCostUsd("gemini-3.6-flash", 1e6, 1e6, DEFAULT_AI_PRICES, new Date("2027-01-01T00:00:00Z"))).toBe(9);
  expect(estimateCostUsd("gemini-3.5-flash-lite", 1e6, 1e6, DEFAULT_AI_PRICES, new Date("2027-06-01T00:00:00Z"))).toBe(2.8);
});
