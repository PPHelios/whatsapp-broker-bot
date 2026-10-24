// scripts/migrate.js — Applies pending db/migrations to DATABASE_URL.
// Usage: node --env-file=.env scripts/migrate.js
"use strict";

const { createPool } = require("../lib/db");
const { runMigrations } = require("../lib/migrate");

async function main() {
  const pool = createPool();
  try {
    const applied = await runMigrations(pool, { log: (m) => console.log(m) });
    console.log(applied.length ? `${applied.length} migration(s) applied.` : "Database is up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
