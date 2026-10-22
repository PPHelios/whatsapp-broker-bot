// lib/db.js
"use strict";

const { Pool } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");

const isProd = process.env.NODE_ENV === "production";

// Request tracing context shared across async calls
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
  statement_timeout: 10000, // Terminates hanging queries beyond 10s
  ssl:
    process.env.DATABASE_SSL === "true" ||
    (isProd && !process.env.DATABASE_URL?.includes("localhost"))
      ? { rejectUnauthorized: false }
      : false
});

// Guard against unhandled idle client dropouts crashing the Node process
pool.on("error", (err) => {
  logStdout("error", "Unexpected error on idle PostgreSQL client", {
    err: err.message,
    code: err.code
  });
});

/* ====================================================================== */
/* 2. Structured Stdout Logging (NDJSON)                                  */
/* ====================================================================== */
function logStdout(level, msg, meta = {}) {
  const ctx = getRequestContext();
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    reqId: ctx.reqId || null,
    agencyId: ctx.agencyId || null,
    brokerId: ctx.brokerId || null,
    ...meta
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
 * Executes a callback within a managed transaction block with automatic ROLLBACK on failure.
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
 * Acquires a transaction-scoped PostgreSQL advisory lock using hashtext to prevent race conditions.
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
 * Canonical audit logger. Can be called from any service to record business operations,
 * token usage, latency breakdowns, and contextual metadata.
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

  // Standard pricing estimation per 1M tokens (Gemini 2.5/3.x flash averages)
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
      JSON.stringify(p.metadata || {})
    ]);
  } catch (err) {
    logStdout("warn", "Failed to write canonical operation log", {
      err: err.message,
      code: err.code,
      operation_type: p.operation_type
    });
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
  withAdvisoryLock,
  logOperation,
  logStdout,
  als,
  getRequestContext
};
