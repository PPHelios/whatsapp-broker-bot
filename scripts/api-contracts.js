// scripts/api-contracts.js — Regenerates the "libraries" map in API_CONTRACTS.json from the real exports.
// Usage: node scripts/api-contracts.js [--check]
// --check exits 1 when the file differs (tests/contract-guard.test.js runs the same comparison).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "API_CONTRACTS.json");

/** Parameter names of a function, from its source ("{ a, b }" → "params", "x = 1" → "x"). */
function paramNames(fn) {
  const src = Function.prototype.toString.call(fn).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  let m = src.match(/^(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(/) || src.match(/^(?:async\s*)?\(/) || src.match(/^[\w$]+\s*\(/);
  let inner;
  if (m) {
    let depth = 1;
    let i = m[0].length;
    const start = i;
    for (; i < src.length && depth; i++) {
      if ("([{".includes(src[i])) depth++;
      else if (")]}".includes(src[i])) depth--;
    }
    inner = src.slice(start, i - 1);
  } else {
    const arrow = src.match(/^(?:async\s+)?([\w$]+)\s*=>/);
    inner = arrow ? arrow[1] : "";
  }
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith("...")) return p.slice(3).split(/[\s=]/)[0];
      if (p.startsWith("{")) return "params";
      if (p.startsWith("[")) return "list";
      return p.split(/[\s=]/)[0];
    });
}

function typeName(v) {
  if (Array.isArray(v)) return "Array";
  if (v instanceof Set) return "Set";
  if (v instanceof Map) return "Map";
  if (v === null) return "Null";
  if (typeof v === "object") return "Object";
  return typeof v === "string" ? "String" : typeof v === "number" ? "Number" : typeof v === "boolean" ? "Boolean" : typeof v;
}

/** The contract entry of one module: export name → parameter names (functions) or a type name. */
function describeModule(relPath) {
  const mod = require(path.join(ROOT, relPath));
  const out = {};
  for (const [k, v] of Object.entries(mod)) {
    if (k.startsWith("_")) continue; // test hooks (e.g. _setClientForTests)
    out[k] = typeof v === "function" ? paramNames(v) : typeName(v);
  }
  return out;
}

function build() {
  const contracts = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const libraries = {};
  for (const rel of Object.keys(contracts.libraries)) libraries[rel] = describeModule(rel);
  return { ...contracts, libraries };
}

/** Pretty JSON with short arrays kept on one line (the file's hand-written style). */
function format(obj) {
  const text = JSON.stringify(obj, null, 2).replace(/\[\n\s*([^\[\]{}]*?)\n\s*\]/g, (all, inner) => {
    const one = `[${inner.split(/,\n\s*/).join(", ")}]`;
    return one.length <= 90 ? one : all;
  });
  return `${text}\n`;
}

if (require.main === module) {
  const next = format(build());
  if (process.argv.includes("--check")) {
    const same = fs.readFileSync(FILE, "utf8") === next;
    console.log(same ? "API_CONTRACTS.json matches the exports." : "API_CONTRACTS.json is stale: run node scripts/api-contracts.js");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(FILE, next);
  console.log("API_CONTRACTS.json updated.");
}

module.exports = { paramNames, describeModule, build, format, FILE };
