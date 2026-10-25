// scripts/onboard.js — Onboards the pilot agency, its brokers, roles and branding from a JSON file.
// Usage: node --env-file=.env scripts/onboard.js docs/pilot/agency.example.json [--dry-run]
// Re-running with the same file is safe (agency matched by name, brokers by phone).
// A broker leaves: node --env-file=.env scripts/onboard.js --deactivate <agency.json> <phone>
//   (sign-in stops at once; their leads go to the unassigned pool and the managers are told).
"use strict";

const fs = require("fs");
const path = require("path");
const { createPool } = require("../lib/db");
const { runMigrations } = require("../lib/migrate");
const Onboarding = require("../lib/onboarding");
const Links = require("../lib/links");
const Brokers = require("../services/brokers");

async function deactivate(file, phone) {
  const input = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const pool = createPool();
  try {
    await runMigrations(pool);
    const a = await pool.query("SELECT id FROM agencies WHERE name = $1", [String(input.agency?.name || "").trim()]);
    if (!a.rows.length) throw new Error(`Agency not found: ${input.agency?.name}`);
    const res = await Brokers.deactivateBroker(pool, { agencyId: a.rows[0].id, phone });
    if (res.error) throw new Error(`No broker with phone ${phone} in this agency`);
    console.log(`Deactivated ${res.broker.name}: ${res.released} lead(s) moved to the unassigned pool; the managers were notified.`);
  } finally {
    await pool.end();
  }
}

async function main() {
  if (process.argv[2] === "--deactivate") {
    if (!process.argv[3] || !process.argv[4]) {
      console.error("Usage: node --env-file=.env scripts/onboard.js --deactivate <agency.json> <phone>");
      process.exit(1);
    }
    return deactivate(process.argv[3], process.argv[4]);
  }
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node --env-file=.env scripts/onboard.js <agency.json> [--dry-run]");
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const { errors, plan } = Onboarding.validate(input);
  if (errors.length) {
    console.error(`Invalid onboarding file:\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`Agency: ${input.agency.name}`);
  for (const b of plan) console.log(`  ${b.role.padEnd(8)} ${b.phone}  ${b.name} (${b.lang})`);
  if (process.argv.includes("--dry-run")) {
    console.log("\nDry run: nothing written.");
    return;
  }

  const pool = createPool();
  try {
    await runMigrations(pool);
    const res = await Onboarding.onboard(pool, input);
    console.log(`\nAgency id ${res.agencyId} (slug ${res.slug}): ${res.created.length} broker(s) added, ${res.updated.length} updated.`);
    console.log(`Broker web app: ${Links.appUrl("/")}`);
    console.log("Next: send each broker the how-to in docs/pilot/broker-howto-ar.md (they must message the bot first).");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
