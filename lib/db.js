// lib/db.js
"use strict";
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";

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
  console.error("⚠️ [PG POOL IDLE CLIENT ERROR]:", err.message);
});

module.exports = { pool };
