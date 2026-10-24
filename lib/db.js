// lib/db.js — Hardened Database Pool, Transaction Wrappers & Sanitized Telemetry
"use strict";
const pg = require("pg");
const Pool = pg.Pool || pg.default?.Pool;
const { AsyncLocalStorage } = require("async_hooks");

const { getConfig, estimateCostUsd } = require("../config");

// Request tracing context shared across asynchronous execution paths
const als = new AsyncLocalStorage();
const getRequestContext = () => als.getStore() || {};

/* ====================================================================== */
/* 1. Connection Pool (the only pool the app creates)                     */
/* ====================================================================== */

// NUMERIC (1700) and INT8 (20) arrive as numbers, not strings, so arithmetic and
// comparisons on prices, areas and counts never concatenate by accident.
const NUMERIC_OID = 1700;
const INT8_OID = 20;
const parseNumeric = (v) => (v === null ? null : Number(v));
const TYPE_OVERRIDES = {
  getTypeParser(oid, format) {
    if (oid === NUMERIC_OID || oid === INT8_OID) return parseNumeric;
    return pg.types.getTypeParser(oid, format);
  }
};

/**
 * Creates the application pool: statement_timeout, SSL and number parsers come from config.
 */
function createPool(cfg = getConfig().db) {
  const pool = new Pool({
    connectionString: cfg.url,
    max: cfg.poolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: cfg.statementTimeoutMs,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    types: TYPE_OVERRIDES
  });

  // Guard against unhandled idle client dropouts crashing the Node process
  pool.on("error", (err) => {
    logStdout("error", "Unexpected error on idle PostgreSQL client", {
      err: err.message,
      code: err.code
    });
  });
  return pool;
}

let defaultPool = null;
/** Lazily created process pool (production bootstrap and scripts). */
function getPool() {
  if (!defaultPool) defaultPool = createPool();
  return defaultPool;
}

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

    // Redact authorization tokens, bearer strings, and API secrets
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
 * Instrumented query runner that tracks execution latency and warns on slow queries.
 */
async function query(pool, text, params) {
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
 * Executes a callback within a managed transaction block with automatic ROLLBACK on failure.
 */
async function withTransaction(pool, workFn) {
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
 * Acquires a transaction-scoped PostgreSQL advisory lock using hashtext to eliminate race conditions.
 */
async function withAdvisoryLock(pool, key1, key2 = null, workFn) {
  return withTransaction(pool, async (client) => {
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
 * latency profiles, and cost calculations.
 */
async function logOperation(pool, p) {
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

  // Cost from configured per-model prices (config.js)
  const cost = p.model_used
    ? estimateCostUsd(p.model_used, p.tokens_input, p.tokens_output)
    : 0;

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
  pool,
  agencyId,
  brokerId,
  {
    agencyLimit = getConfig().ai.quotas.agencyDaily,
    brokerLimit = getConfig().ai.quotas.brokerDaily
  } = {}
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

  const row = res?.rows?.[0] || {};
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
  createPool,
  getPool,
  TYPE_OVERRIDES,
  query,
  withTransaction,
  withAdvisoryLock,
  logOperation,
  logStdout,
  als,
  getRequestContext,
  checkAiQuota
};
