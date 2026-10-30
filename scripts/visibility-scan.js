// scripts/visibility-scan.js — Finds every read (FROM / JOIN) of listings or leads in the app code and says whether the
// statement uses lib/visibility. Used by tests/visibility-guard.test.js and by `node scripts/visibility-scan.js --write`,
// which rewrites tests/visibility-baseline.json (the reads that still skip the helper).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIRS = ["routes", "lib", "web", "services", "domain"];
const SKIP_DIRS = new Set(["node_modules", "tests", "scripts", ".git", "static", "migrations"]);
const BASELINE = path.join(ROOT, "tests", "visibility-baseline.json");
const READ = /\b(FROM|JOIN)\s+(listings|leads)\b/gi;
// `vis:exempt` in the statement (or on the line of a FROM constant) marks a read that must see every row: plan-limit counts, erasure, and fragments whose users add the helper.
const USES_HELPER = /\bVis\.(units|leads)\(|vis:exempt/;

function files(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) files(full, out);
    } else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

/** The text of the statement around a match: the enclosing template literal, or else the line. */
function statementAround(src, index) {
  const before = src.slice(0, index);
  const ticks = (before.match(/`/g) || []).length;
  if (ticks % 2 === 1) {
    const start = before.lastIndexOf("`");
    const end = src.indexOf("`", index);
    return src.slice(start, end === -1 ? src.length : end + 1);
  }
  const start = before.lastIndexOf("\n") + 1;
  const end = src.indexOf("\n", index);
  return src.slice(start, end === -1 ? src.length : end);
}

/** All reads: [{ file, key, covered }] where key identifies the statement (file + normalised text from the match). */
function scan() {
  const found = [];
  for (const dir of DIRS) {
    for (const file of files(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      for (const m of src.matchAll(READ)) {
        const stmt = statementAround(src, m.index);
        const from = src.slice(m.index, m.index + 160).replace(/\s+/g, " ").slice(0, 80);
        found.push({ file: rel, key: `${rel}|${from}`, covered: USES_HELPER.test(stmt) });
      }
    }
  }
  return found;
}

/** { key: count } of the reads that skip the helper. */
function uncovered(found = scan()) {
  const out = {};
  for (const f of found) if (!f.covered) out[f.key] = (out[f.key] || 0) + 1;
  return out;
}

function readBaseline() {
  return fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
}

if (require.main === module) {
  const found = scan();
  const u = uncovered(found);
  const total = Object.values(u).reduce((a, b) => a + b, 0);
  if (process.argv.includes("--write")) {
    fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(u).sort()), null, 2) + "\n");
    console.log(`baseline written: ${total} reads skip the helper, ${found.length - total} use it`);
  } else {
    console.log(`${total} reads skip the helper, ${found.length - total} use it`);
  }
}

module.exports = { scan, uncovered, readBaseline, BASELINE };
