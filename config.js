// config.js — Single source of runtime configuration (env, URLs, AI prices and quotas)
"use strict";

/**
 * Gemini list prices in USD per 1M tokens. Thinking tokens bill as output.
 * Verify against the Gemini pricing page before the pilot; override with AI_PRICES_JSON,
 * e.g. {"gemini-3.8-flash":{"inPerM":0.3,"outPerM":2.5}}.
 */
const DEFAULT_AI_PRICES = {
  "gemini-3.8-flash": { inPerM: 0.3, outPerM: 2.5 },
  "gemini-3.6-flash": { inPerM: 0.3, outPerM: 2.5 },
  "gemini-3.5-flash-lite": { inPerM: 0.1, outPerM: 0.4 },
  default: { inPerM: 0.3, outPerM: 2.5 }
};

// Required in production; the process refuses to start without them.
const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "GEMINI_API_KEY",
  "PUBLIC_BASE_URL"
];

const int = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v !== undefined ? Math.round(n) : fallback;
};

function parsePrices(raw) {
  if (!raw) return { ...DEFAULT_AI_PRICES };
  try {
    return { ...DEFAULT_AI_PRICES, ...JSON.parse(raw) };
  } catch {
    throw new Error("AI_PRICES_JSON is not valid JSON");
  }
}

/**
 * Builds the configuration from an environment map (process.env by default).
 * Throws in production when a required variable is missing.
 */
function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === "production";

  if (isProd) {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !String(env[k] || "").trim());
    if (missing.length) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
  }

  const publicBaseUrl = String(env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, "");
  if (isProd && !/^https:\/\//.test(publicBaseUrl)) {
    throw new Error("PUBLIC_BASE_URL must be an https:// URL in production");
  }

  return {
    isProd,
    port: int(env.PORT, 3000),
    publicBaseUrl,
    bodyLimit: env.BODY_LIMIT || "512kb",
    whatsapp: {
      appSecret: env.WHATSAPP_APP_SECRET || "",
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
      // Unsigned webhooks are accepted only when explicitly allowed outside production.
      allowUnsigned: !isProd && env.WEBHOOK_ALLOW_UNSIGNED === "true"
    },
    db: {
      url: env.DATABASE_URL || "",
      poolMax: int(env.DB_POOL_MAX, 10),
      statementTimeoutMs: int(env.DB_STATEMENT_TIMEOUT_MS, 10000),
      ssl:
        env.DATABASE_SSL === "true" ||
        (isProd && env.DATABASE_SSL !== "false" && !String(env.DATABASE_URL || "").includes("localhost")),
      migrateOnBoot: env.MIGRATE_ON_BOOT !== "false"
    },
    ai: {
      prices: parsePrices(env.AI_PRICES_JSON),
      quotas: {
        agencyDaily: int(env.AI_QUOTA_AGENCY_DAILY, 2000),
        brokerDaily: int(env.AI_QUOTA_BROKER_DAILY, 400)
      }
    }
  };
}

let cached = null;
/** Process-wide configuration, loaded once. */
function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test hook: forget the cached configuration so the next getConfig() re-reads env. */
function resetConfig() {
  cached = null;
}

/** Estimated USD cost of one AI call from configured per-model prices. */
function estimateCostUsd(model, tokensIn = 0, tokensOut = 0, prices = getConfig().ai.prices) {
  const p = prices[model] || prices.default;
  return Number((((tokensIn || 0) * p.inPerM + (tokensOut || 0) * p.outPerM) / 1e6).toFixed(6));
}

/** Absolute public URL for a path, built from PUBLIC_BASE_URL. */
function publicUrl(path = "/") {
  return getConfig().publicBaseUrl + (String(path).startsWith("/") ? path : `/${path}`);
}

module.exports = {
  DEFAULT_AI_PRICES,
  REQUIRED_IN_PRODUCTION,
  loadConfig,
  getConfig,
  resetConfig,
  estimateCostUsd,
  publicUrl
};
