// config.js — Single source of runtime configuration (env, URLs, AI prices and quotas)
"use strict";

/**
 * Gemini list prices in USD per 1M tokens. Thinking tokens bill as output.
 * Verify against the Gemini pricing page before the pilot; override with AI_PRICES_JSON,
 * e.g. {"gemini-3.8-flash":{"inPerM":0.3,"outPerM":2.5}}.
 */
// USD per million tokens (Google's paid tier, checked 2026-10-25). `next` is an announced price change.
const FLASH_2027 = { from: "2027-01-01T00:00:00Z", inPerM: 1.5, outPerM: 7.5 };
const DEFAULT_AI_PRICES = {
  "gemini-3.8-flash": { inPerM: 0.75, outPerM: 3.75, next: FLASH_2027 },
  "gemini-3.6-flash": { inPerM: 0.75, outPerM: 3.75, next: FLASH_2027 },
  "gemini-3.5-flash-lite": { inPerM: 0.3, outPerM: 2.5 },
  default: { inPerM: 0.75, outPerM: 3.75, next: FLASH_2027 }
};

// Required in production; the process refuses to start without them.
const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "GEMINI_API_KEY",
  "PUBLIC_BASE_URL",
  "WEB_PUSH_PUBLIC_KEY",
  "WEB_PUSH_PRIVATE_KEY",
  "LEAD_HASH_KEY"
];

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v !== undefined ? n : fallback;
};

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
  // Until PUBLIC_BASE_URL is set, Render's own https://<service>.onrender.com address is used.
  const baseUrl = String(env.PUBLIC_BASE_URL || "").trim() || String(env.RENDER_EXTERNAL_URL || "").trim();

  // WhatsApp is on unless WHATSAPP_ENABLED says false/0/off/no; switched off, its variables aren't required.
  const whatsappEnabled = !/^(false|0|off|no)$/i.test(String(env.WHATSAPP_ENABLED || "").trim());

  if (isProd) {
    const required = REQUIRED_IN_PRODUCTION.filter((k) => whatsappEnabled || !k.startsWith("WHATSAPP_"));
    const missing = required.filter((k) => !String(k === "PUBLIC_BASE_URL" ? baseUrl : env[k] || "").trim());
    if (missing.length) {
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
  }

  const publicBaseUrl = String(baseUrl || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, "");
  if (isProd && !/^https:\/\//.test(publicBaseUrl)) {
    throw new Error("PUBLIC_BASE_URL must be an https:// URL in production");
  }

  return {
    isProd,
    port: int(env.PORT, 3000),
    publicBaseUrl,
    bodyLimit: env.BODY_LIMIT || "512kb",
    whatsapp: {
      enabled: whatsappEnabled,
      appSecret: env.WHATSAPP_APP_SECRET || "",
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || "",
      // Unsigned webhooks are accepted only when explicitly allowed outside production.
      allowUnsigned: !isProd && env.WEBHOOK_ALLOW_UNSIGNED === "true"
    },
    // Telegram bot (Release 3T): on when the token is set; the webhook refuses everything without the secret.
    telegram: {
      enabled: Boolean(String(env.TELEGRAM_BOT_TOKEN || "").trim()),
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
      botUsername: String(env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim()
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
    flyer: {
      // Rendering runs in a worker thread so satori/sharp never block webhook handling.
      worker: env.FLYER_WORKER ? env.FLYER_WORKER !== "false" : env.NODE_ENV !== "test",
      maxQueue: int(env.FLYER_MAX_QUEUE, 6),
      timeoutMs: int(env.FLYER_TIMEOUT_MS, 45000)
    },
    // Message credits (1 credit = 1 WhatsApp message the bot sends) and their ceilings.
    credits: {
      monthly: int(env.WA_CREDITS_MONTHLY, 4000),
      warnPct: 80,
      ceilingPct: int(env.WA_CREDITS_CEILING_PCT, 110),
      globalMonthly: int(env.WA_GLOBAL_MONTHLY_CEILING, 8000),
      loginMonthly: int(env.WA_LOGIN_MONTHLY_CEILING, 200),
      priceEgp: num(env.WA_PRICE_EGP, 0.21)
    },
    // Keyed hash of an erased client's phone (lead_erasures); outside production a fixed development key.
    leads: {
      hashKey: env.LEAD_HASH_KEY || (isProd ? "" : "dev-only-lead-hash-key")
    },
    webPush: {
      publicKey: env.WEB_PUSH_PUBLIC_KEY || "",
      privateKey: env.WEB_PUSH_PRIVATE_KEY || "",
      subject: env.WEB_PUSH_SUBJECT || "mailto:support@wehdathub.com"
    },
    // Error alerts to the owner (lib/errorReports.js): a Telegram message through the bot, to the owner's chat.
    alerts: {
      telegramToken: env.TELEGRAM_BOT_TOKEN || "",
      telegramChatId: String(env.ALERT_TELEGRAM_CHAT_ID || "").trim(),
      everyMin: Math.max(1, int(env.ALERT_EVERY_MIN, 30))
    },
    // "Talk to a person" (services/onboarding.js): the owner's Telegram username.
    support: {
      telegram: String(env.SUPPORT_TELEGRAM || "").trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "")
    },
    scheduler: {
      // On by default outside tests; tests call tick({ now }) with a fixed clock instead.
      enabled: env.SCHEDULER_ENABLED ? env.SCHEDULER_ENABLED !== "false" : env.NODE_ENV !== "test",
      tickMs: Math.max(5000, int(env.SCHEDULER_TICK_MS, 60000))
    },
    // The product owner's broker ids (OWNER_BROKER_IDS, comma-separated): only they see /app/owner (services/dashboards.js).
    owner: {
      brokerIds: String(env.OWNER_BROKER_IDS || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f-]{36}$/.test(s))
    },
    // Self-ping so Render Free doesn't sleep (lib/keepAwake.js). Off unless KEEP_AWAKE=true: free hours are capped.
    keepAwake: {
      enabled: /^(true|1|on|yes)$/i.test(String(env.KEEP_AWAKE || "").trim()),
      hours: String(env.KEEP_AWAKE_HOURS || "6-1").trim()
    },
    ai: {
      prices: parsePrices(env.AI_PRICES_JSON),
      quotas: {
        agencyDaily: int(env.AI_QUOTA_AGENCY_DAILY, 300),
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
function estimateCostUsd(model, tokensIn = 0, tokensOut = 0, prices = getConfig().ai.prices, now = new Date()) {
  const base = prices[model] || prices.default;
  const p = base.next && now >= new Date(base.next.from) ? base.next : base;
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
