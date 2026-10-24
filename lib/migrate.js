// lib/migrate.js — Ordered SQL migrations (db/migrations/NNN_name.sql) applied once each
"use strict";

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "db", "migrations");
// Serializes concurrent boots (several pods) on one database.
const MIGRATION_LOCK_KEY = 727001;

/** Migration files in apply order: [{ version, file, sql }]. */
function listMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3,}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      version: file.replace(/\.sql$/, ""),
      file,
      sql: fs.readFileSync(path.join(dir, file), "utf8")
    }));
}

/**
 * Applies every pending migration, each in its own transaction, and records it in
 * schema_migrations. Returns the versions applied by this call.
 */
async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );

  const lockClient = await pool.connect();
  const applied = [];
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const { rows } = await lockClient.query("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((r) => r.version));

    for (const m of listMigrations(dir)) {
      if (done.has(m.version)) continue;
      await lockClient.query("BEGIN");
      try {
        await lockClient.query(m.sql);
        await lockClient.query("INSERT INTO schema_migrations (version) VALUES ($1)", [m.version]);
        await lockClient.query("COMMIT");
      } catch (err) {
        await lockClient.query("ROLLBACK").catch(() => {});
        err.message = `Migration ${m.file} failed: ${err.message}`;
        throw err;
      }
      applied.push(m.version);
      log(`applied ${m.file}`);
    }
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
  return applied;
}

module.exports = { MIGRATIONS_DIR, listMigrations, runMigrations };
