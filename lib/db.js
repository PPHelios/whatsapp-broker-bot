// lib/db.js — Hardened Database Pool, Transaction Wrappers & Sanitized Telemetry
"use strict";

const { Pool } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");

const isProd = process.env.NODE_ENV === "production";

// Request tracing context shared across asynchronous execution paths
const als = new AsyncLocalStorage();
const getRequestContext = () => als.getStore() || {};

/* ====================================================================== */
/* 1. Connection Pool Configuration                                       */
/* ====================================================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000, // Terminates hanging queries beyond 10s[cite: 3]
  ssl:
    process.env.DATABASE_SSL === "true" ||
    (isProd && !process.env.DATABASE_URL?.includes("localhost"))
      ? { rejectUnauthorized: false }
      : false
});

// Guard against unhandled idle client dropouts crashing the Node process[cite: 3]
pool.on("error", (err) => {
  logStdout("error", "Unexpected error on idle PostgreSQL client", {
    err: err.message,
    code: err.code
  });
});

/* ====================================================================== */
/* 2. Structured Stdout Logging (NDJSON) with PII & Secret Redaction      */
/* ====================================================================== */

/**
 * Recursively scrubs authorization tokens, API secrets, and masks phone numbers.
 */
function sanitizeLogData(obj, depth = 0) {
  if (!obj || depth > 4) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeLogData(item, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const keyLower = k.toLowerCase();

    // Redact authorization tokens, bearer strings, and API secrets[cite: 13]
    if (
      keyLower.includes("token") ||
      keyLower.includes("secret") ||
      keyLower.includes("authorization") ||
      keyLower.includes("password") ||
      keyLower.includes("apikey")
    ) {
      out[k] = "[REDACTED]";
    } else if (
      (keyLower === "phone" ||
        keyLower === "phone_key" ||
        keyLower === "recipient") &&
      typeof v === "string"
    ) {
      // Mask phone numbers to preserve privacy: e.g. 201012345678 -> 2010****5678
      out[k] =
        v.length > 7
          ? v.replace(/(\d{4})\d+(\d{3,4})/, "$1****$2")
          : "[MASKED]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = sanitizeLogData(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function logStdout(level, msg, meta = {}) {
  const ctx = getRequestContext();
  let sanitizedMeta = {};

  try {
    sanitizedMeta = sanitizeLogData(meta);
  } catch (_) {
    sanitizedMeta = { sanitization_error: true };
  }

  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    reqId: ctx.reqId || null,
    agencyId: ctx.agencyId || null,
    brokerId: ctx.brokerId || null,
    ...sanitizedMeta
  });

  (level === "error" ? console.error : console.log)(line);
}

/* ====================================================================== */
/* 3. Query Instrumentation & Slow Query Detection                        */
/* ====================================================================== */
const SLOW_QUERY_THRESHOLD_MS = Number(process.env.SLOW_QUERY_MS || 1000);

/**
 * Instrumented query runner that tracks execution latency and warns on slow queries[cite: 3].
 */
async function query(text, params) {
  const t0 = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - t0;

    if (duration > SLOW_QUERY_THRESHOLD_MS) {
      logStdout("warn", "Slow SQL query detected", {
        duration_ms: duration,
        query: text.replace(/\s+/g, " ").trim().slice(0, 150),
        rows: res.rowCount
      });
    }

    return res;
  } catch (err) {
    const duration = Date.now() - t0;
    logStdout("error", "SQL query execution failed", {
      duration_ms: duration,
      err: err.message,
      code: err.code,
      query: text.replace(/\s+/g, " ").trim().slice(0, 150)
    });
    throw err;
  }
}

/* ====================================================================== */
/* 4. Transaction & Distributed Advisory Lock Wrappers                    */
/* ====================================================================== */
/**
 * Executes a callback within a managed transaction block with automatic ROLLBACK on failure[cite: 3].
 */
async function withTransaction(workFn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await workFn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Acquires a transaction-scoped PostgreSQL advisory lock using hashtext to eliminate race conditions[cite: 3].
 */
async function withAdvisoryLock(key1, key2 = null, workFn) {
  return withTransaction(async (client) => {
    if (key2 !== null) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(key1), String(key2)]
      );
    } else {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        String(key1)
      ]);
    }
    return await workFn(client);
  });
}

/* ====================================================================== */
/* 5. Centralized Operation Logging (`operation_logs`)                    */
/* ====================================================================== */
/**
 * Canonical audit logger for recording business operations, token telemetry,
 * latency profiles, and cost calculations[cite: 3].
 */
async function logOperation(p) {
  const ctx = getRequestContext();
  const sql = `
    INSERT INTO operation_logs (
      agency_id, broker_id, listing_code, operation_type, status, error_code,
      total_duration_ms, gemini_ms, media_download_ms, image_process_ms, flyer_render_ms,
      storage_upload_ms, db_ms, tokens_input, tokens_output, model_used,
      estimated_cost_usd, metadata
    ) VALUES (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15, $16,
      $17, $18
    )
  `;

  // Standard pricing estimation per 1M tokens (Gemini Flash baseline)[cite: 3]
  const inputCost = ((p.tokens_input || 0) / 1000000) * 0.075;
  const outputCost = ((p.tokens_output || 0) / 1000000) * 0.3;
  const cost = Number((inputCost + outputCost).toFixed(6));

  try {
    await pool.query(sql, [
      p.agency_id || ctx.agencyId || null,
      p.broker_id || ctx.brokerId || null,
      p.listing_code || null,
      p.operation_type,
      p.status || "success",
      p.error_code || null,
      p.total_duration_ms || 0,
      p.gemini_ms || 0,
      p.media_download_ms || 0,
      p.image_process_ms || 0,
      p.flyer_render_ms || 0,
      p.storage_upload_ms || 0,
      p.db_ms || 0,
      p.tokens_input || 0,
      p.tokens_output || 0,
      p.model_used || null,
      cost,
      JSON.stringify(sanitizeLogData(p.metadata || {}))
    ]);
  } catch (err) {
    logStdout("warn", "Failed to write canonical operation log", {
      err: err.message,
      code: err.code,
      operation_type: p.operation_type
    });
  }
}

/* ====================================================================== */
/* 6. AI Daily Quota Enforcement Gatekeeper                              */
/* ====================================================================== */
/**
 * Evaluates whether an agency or individual broker has exceeded their daily AI quota.
 * Rejects requests with QUOTA_EXCEEDED before initiating calls to Gemini.
 */
async function checkAiQuota(
  agencyId,
  brokerId,
  { agencyLimit = 300, brokerLimit = 60 } = {}
) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const res = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE broker_id = $2) AS broker_count,
       COUNT(*) AS agency_count
     FROM operation_logs
     WHERE agency_id = $1
       AND gemini_ms > 0
       AND created_at >= $3`,
    [agencyId, brokerId, startOfDay.toISOString()]
  );

  const row = res.rows[0] || {};
  const brokerUsage = parseInt(row.broker_count || 0, 10);
  const agencyUsage = parseInt(row.agency_count || 0, 10);

  if (brokerUsage >= brokerLimit) {
    const err = new Error("Broker daily AI quota exceeded");
    err.code = "BROKER_QUOTA_EXCEEDED";
    err.limit = brokerLimit;
    err.used = brokerUsage;
    throw err;
  }

  if (agencyUsage >= agencyLimit) {
    const err = new Error("Agency daily AI quota exceeded");
    err.code = "AGENCY_QUOTA_EXCEEDED";
    err.limit = agencyLimit;
    err.used = agencyUsage;
    throw err;
  }

  return { ok: true, brokerUsage, agencyUsage };
}

module.exports = {
  pool,
  query,
  withTransaction,
  withAdvisoryLock,
  logOperation,
  logStdout,
  als,
  getRequestContext,
  checkAiQuota
};
