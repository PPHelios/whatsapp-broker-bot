// tests/harness/db.js — In-process Postgres (PGlite) behind a pg.Pool-compatible adapter
"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA_PATH = path.join(__dirname, "..", "..", "db", "schema.sql");

// node-pg returns NUMERIC and INT8 as strings; mirror that so tests see production types.
const PG_COMPAT_PARSERS = {
  1700: (v) => v, // numeric
  20: (v) => v // int8
};

/**
 * Creates a fresh database loaded with db/schema.sql and returns a pg.Pool-like object.
 * PGlite has a single connection, so the adapter serializes transactions: while a client
 * holds an open transaction, pool.query calls wait until it commits or rolls back.
 */
async function createTestDb() {
  // CommonJS builds: Jest cannot import() ESM without experimental VM flags.
  const { PGlite } = require("@electric-sql/pglite");
  const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
  const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
  const { uuid_ossp } = require("@electric-sql/pglite/contrib/uuid_ossp");

  const db = new PGlite({
    extensions: { pg_trgm, pgcrypto, uuid_ossp },
    parsers: PG_COMPAT_PARSERS
  });
  await db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

  let txOwner = null; // client currently inside BEGIN … COMMIT/ROLLBACK
  let txDone = Promise.resolve();
  let releaseTx = () => {};

  const toResult = (r) => ({
    rows: r.rows,
    rowCount: r.affectedRows ?? r.rows.length,
    fields: r.fields
  });

  async function run(text, params) {
    // Multi-statement text without params goes through exec (simple protocol).
    if (!params || params.length === 0) {
      const results = await db.exec(text);
      return toResult(results[results.length - 1] || { rows: [] });
    }
    return toResult(await db.query(text, params));
  }

  async function waitForTx(caller) {
    const started = Date.now();
    while (txOwner && txOwner !== caller) {
      await Promise.race([txDone, new Promise((r) => setTimeout(r, 50))]);
      if (Date.now() - started > 5000) {
        throw new Error(
          "Test DB deadlock: query waited >5s for another client's open transaction"
        );
      }
    }
  }

  function makeClient() {
    const client = {
      async query(text, params) {
        const sql = typeof text === "string" ? text : text.text;
        const values = typeof text === "string" ? params : text.values;
        const verb = sql.trim().split(/\s+/)[0].toUpperCase();
        if (verb === "BEGIN" || verb === "START") {
          await waitForTx(client);
          txOwner = client;
          txDone = new Promise((r) => (releaseTx = r));
        } else {
          await waitForTx(client);
        }
        try {
          return await run(sql, values);
        } finally {
          if ((verb === "COMMIT" || verb === "ROLLBACK" || verb === "END") && txOwner === client) {
            txOwner = null;
            releaseTx();
          }
        }
      },
      release() {
        if (txOwner === client) {
          // Mirror pg: releasing a client mid-transaction must not leak the open transaction.
          txOwner = null;
          releaseTx();
          return db.exec("ROLLBACK").catch(() => {});
        }
      }
    };
    return client;
  }

  const pool = {
    query: (text, params) => makeClient().query(text, params),
    connect: async () => makeClient(),
    end: async () => db.close(),
    on: () => {}
  };

  return { pool, db };
}

module.exports = { createTestDb, SCHEMA_PATH };
