// server.js — Webhook Ingress, Routing Dispatcher & Render Lifecycle Supervisor
// The message dispatcher is routes/dispatch.js, the turn pipeline routes/turns.js and Telegram updates
// routes/telegramIngress.js.
"use strict";

const express = require("express");
const crypto = require("crypto");

const { getConfig } = require("./config");
const Db = require("./lib/db");
const { runMigrations } = require("./lib/migrate");

const TgLink = require("./lib/tgLink");
const TapGuard = require("./lib/tapGuard");
const Flyer = require("./lib/flyer");
const ErrorReports = require("./lib/errorReports");
const { dispatchMessage } = require("./routes/dispatch");
const { createTurnPipeline } = require("./routes/turns");
const { createTelegramIngress } = require("./routes/telegramIngress");
const { mountWeb } = require("./web");
const { createScheduler } = require("./lib/scheduler");
const { buildJobs } = require("./lib/jobs");


/**
 * Builds the Express app and message pipeline around an injected pg-compatible pool.
 * Tests pass an in-process Postgres; production passes the lib/db.js pool (see bootstrap below).
 */
function createApp({ pool, config = getConfig(), jobs, tapGuard = TapGuard.createTapGuard() }) {
  const APP_SECRET = config.whatsapp.appSecret;
  const VERIFY_TOKEN = config.whatsapp.verifyToken;

  // Drain Protocol State (Distributed Multi-Pod Invariant)
  const state = { inFlight: 0, isDraining: false };
  // tapGuard drops repeated button taps (double taps, re-taps while a slow review runs): lib/tapGuard.js.

  const app = express();

  // Capture raw body for cryptographic HMAC verification
  app.use(
    express.json({
      limit: config.bodyLimit,
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );

  const { runTurn, handleWebhookBody, handleInboundMessage, bootRecovery } = createTurnPipeline({ pool, config, tapGuard, state });
  const { handleTelegramUpdate } = createTelegramIngress({ pool, tapGuard, runTurn });

  /**
   * SEC-01: Cryptographic Webhook HMAC-SHA256 Verification
   */
  function verifyWebhookSignature(req) {
    // Fail closed: without a secret nothing is accepted, unless explicitly allowed in local dev.
    if (!APP_SECRET) return config.whatsapp.allowUnsigned;
    const signature = req.headers["x-hub-signature-256"];
    if (!signature) return false;

    const expected =
      "sha256=" +
      crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, "utf8"),
        Buffer.from(expected, "utf8")
      );
    } catch {
      return false;
    }
  }

  /**
   * Meta Webhook Verification Endpoint (GET)
   */
  app.get("/webhook", (req, res) => {
    if (!config.whatsapp.enabled) return res.sendStatus(404);
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  /**
   * Inbound Webhook Ingress (POST)
   */
  app.post("/webhook", async (req, res) => {
    // Graceful Drain: Stop accepting webhooks during pod shutdown (Render multi-pod rollout)
    if (state.isDraining) {
      return res.status(503).send("SERVICE_DRAINING");
    }

    // WhatsApp switched off (WHATSAPP_ENABLED=false): acknowledge so Meta doesn't retry, and do nothing.
    if (!config.whatsapp.enabled) return res.status(200).send("WHATSAPP_DISABLED");

    // 1. Authenticate Meta Signature (SEC-01)
    if (!verifyWebhookSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    // Fast acknowledgment to prevent Meta HTTP timeout retries
    res.status(200).send("EVENT_RECEIVED");

    await handleWebhookBody(req.body);
  });

  // "📤 Send on WhatsApp" from Telegram when the wa.me link is too long for a button: a redirect to the stored link.
  app.get("/go/wa/:token", async (req, res) => {
    const url = await TgLink.waLinkOf(pool, req.params.token);
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
    return url ? res.redirect(302, url) : res.status(404).send("Not found");
  });

  /**
   * Telegram webhook (Release 3T): only Telegram knows the secret_token we gave setWebhook, so a request without the
   * matching header is refused (fail closed: without a configured secret nothing is accepted).
   */
  app.post("/telegram/webhook", async (req, res) => {
    if (state.isDraining) return res.status(503).send("SERVICE_DRAINING");
    const secret = config.telegram.webhookSecret;
    const sent = String(req.get("X-Telegram-Bot-Api-Secret-Token") || "");
    const ok =
      Boolean(secret) &&
      sent.length === secret.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(secret));
    if (!ok) return res.sendStatus(401);
    res.status(200).send("OK");
    await handleTelegramUpdate(req.body).catch((err) => console.error("Telegram update failed:", err.message));
  });

  /**
   * Render Health Check Probe
   */
  app.get("/health", async (_req, res) => {
    if (state.isDraining) {
      return res.status(503).json({ status: "draining" });
    }

    try {
      await pool.query("SELECT 1");
      res
        .status(200)
        .json({ status: "healthy", timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: "degraded", error: err.message });
    }
  });

  // L1: per-agency lead intake (Make.com lead ads, forms): POST JSON or form fields to the agency's secret URL.
  app.post("/intake/:token", express.urlencoded({ extended: false, limit: "64kb" }), async (req, res, next) => {
    try {
      const r = await require("./services/leadIntake").receive(pool, req.params.token, req.body || {});
      res.status(r.status).json(r.json);
    } catch (err) {
      next(err);
    }
  });

  // Release 2: the broker web app (/app/) and the public pages, after /webhook and /health.
  mountWeb(app, { pool, config });

  // Anything else that throws (webhooks, public pages): recorded and alerted, then a plain 500.
  // eslint-disable-next-line no-unused-vars
  app.use(async (err, req, res, _next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500; // 4xx: a bad request (e.g. broken JSON), not our bug
    if (status === 500) await ErrorReports.capture(err, { pool, source: "http", path: `${req.method} ${req.path}` });
    if (!res.headersSent) res.status(status).send(status === 500 ? "Error" : "Bad request");
  });

  /**
   * Pre-warms Cairo fonts into process memory
   */
  async function preWarmAssets() {
    try {
      await Promise.all([
        Flyer.loadFont("Cairo-Bold.ttf"),
        Flyer.loadFont("Cairo-Regular.ttf")
      ]);
      console.log("🎨 Cairo typography assets pre-warmed successfully.");
    } catch (err) {
      console.warn("⚠️ Typography pre-warming warning:", err.message);
    }
  }

  // Background jobs (follow-ups, match sweeps, retention…): one tick a minute, each job on one instance.
  const scheduler = createScheduler({
    pool,
    jobs: jobs || buildJobs({ pool, config }),
    tickMs: config.scheduler.tickMs,
    enabled: config.scheduler.enabled,
    onError: (err, job) => ErrorReports.capture(err, { pool, source: "job", metadata: { job: job.name } })
  });

  return {
    app,
    state,
    scheduler,
    handleWebhookBody,
    handleTelegramUpdate,
    handleInboundMessage,
    dispatchMessage,
    bootRecovery,
    preWarmAssets
  };
}

/* ====================================================================== */
/* Production bootstrap (skipped when required by tests)                  */
/* ====================================================================== */
async function start() {
  // Fails fast in production when required configuration is missing.
  const config = getConfig();
  const pool = Db.getPool();
  // Unhandled rejections and crashes land in error_events and alert the owner (lib/errorReports.js).
  ErrorReports.installProcessHandlers(pool);

  if (config.db.migrateOnBoot) {
    const applied = await runMigrations(pool, { log: (m) => console.log(`[MIGRATE] ${m}`) });
    if (applied.length) console.log(`[MIGRATE] ${applied.length} migration(s) applied`);
  }

  const { app, state, scheduler, bootRecovery, preWarmAssets } = createApp({ pool, config });

  // Start Server & Bind Port Immediately for Render Health Probes
  const server = app.listen(config.port, () => {
    console.log(
      `🚀 WehdatHub Engine live on port ${config.port} (Node.js ${process.version})`
    );
    preWarmAssets();
    bootRecovery();
    require("./lib/tgSetup").setup().catch(() => {});
    // After the port binds, so health probes never wait on it.
    if (scheduler.start()) console.log(`⏱️ Scheduler on (${scheduler.jobs.length} jobs)`);
    const keepAwake = require("./lib/keepAwake").createKeepAwake({
      ...config.keepAwake,
      url: require("./lib/links").healthUrl()
    });
    if (keepAwake.start()) console.log(`☕ Keep-awake ping on (${config.keepAwake.hours} Cairo)`);
  });

  /**
   * Render Graceful Termination & Drain Protocol (25-second window)
   */
  async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Initiating Render drain protocol...`);
    state.isDraining = true;
    // The scheduler stops first: no new job starts while the instance drains.
    scheduler.stop().catch(() => {});

    server.close(() => {
      console.log("HTTP server closed to new connections.");
    });

    const drainTimeout = setTimeout(async () => {
      console.warn(
        `Drain window elapsed with ${state.inFlight} tasks remaining. Forcing pool shutdown...`
      );
      await pool.end().catch(() => {});
      process.exit(1);
    }, 25000);

    const checkDrain = setInterval(async () => {
      if (state.inFlight === 0) {
        clearInterval(checkDrain);
        clearTimeout(drainTimeout);
        console.log(
          "All in-flight turns completed. Closing PostgreSQL pool..."
        );
        await Flyer.stopFlyerWorker().catch(() => {});
        await pool.end().catch(() => {});
        console.log("Graceful shutdown complete.");
        process.exit(0);
      }
    }, 250);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Startup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
