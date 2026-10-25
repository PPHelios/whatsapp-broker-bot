// scripts/eval-leads.js — Manual eval of the CRM prompts (Release 3 step 9): lead_extraction and lead_update on the
// text cases in tests/eval/lead-cases.json, with the production prompt builders and normalizers. Calls real Gemini;
// not run in CI. Results: tests/eval/results/leads-<model>.json (local only).
// Usage: node --env-file=.env scripts/eval-leads.js --key-env GEMINI_API_KEY_EVAL [--model gemini-3.6-flash] [--gap 1000]
"use strict";

const fs = require("fs");
const path = require("path");
const Intake = require("../domain/leadIntake");
const Update = require("../domain/leadUpdate");
const Phone = require("../domain/phone");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
// Evals never use the production key (its daily quota serves the live bot).
const KEY_ENV = arg("key-env", "GEMINI_EVAL_API_KEY");
const KEY = String(process.env[KEY_ENV] || "").trim();
if (!KEY || KEY_ENV === "GEMINI_API_KEY" || KEY === String(process.env.GEMINI_API_KEY || "").trim()) {
  console.error(`${KEY_ENV} must be set to an eval key that differs from the production GEMINI_API_KEY.`);
  process.exit(1);
}
const MODEL = arg("model", "gemini-3.6-flash");
const GAP_MS = Number(arg("gap", 6500));
const THINKING = { "gemini-3.8-flash": "LOW" }; // 3.8 Flash refuses MINIMAL
const PRICES = { "gemini-3.5-flash-lite": [0.3, 2.5] }; // USD per million tokens; Flash otherwise
const ROOT = path.join(__dirname, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
let ai = null;

async function call(parts) {
  if (!ai) {
    const { GoogleGenAI } = await import("@google/genai");
    ai = new GoogleGenAI({ apiKey: KEY });
  }
  const config = { temperature: 0.1, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: THINKING[MODEL] || "MINIMAL" } };
  for (let attempt = 0; ; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const t0 = Date.now();
    try {
      const res = await ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }], config });
      const u = res.usageMetadata || {};
      return { text: res.text || "", ms: Date.now() - t0, tokens: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
    } catch (err) {
      if (attempt >= 3 || !/429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded/i.test(err.message)) throw err;
      await sleep(20000 * (attempt + 1));
    }
  }
}

const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const digits = (p) => (Phone.toE164(p) || String(p)).replace(/\D/g, "");

/** One expected field against the output: phones as sets, "*" = anything, text folded and matched loosely. */
function same(key, exp, out) {
  const got = get(out, key);
  if (exp === "*") return got != null && got !== "";
  if (exp === null) return got == null;
  if (key === "phones") return Array.isArray(got) && got.length === exp.length && exp.every((p) => got.map(digits).includes(digits(p)));
  if (typeof exp === "string" && typeof got === "string") {
    const [a, b] = [Update.fold(exp), Update.fold(got)];
    return a === b || b.includes(a) || a.includes(b);
  }
  return got === exp;
}

async function run(kind, c, now) {
  const fence = "EVALFENCE";
  const prompt = kind === "extraction" ? Intake.buildLeadPrompt("ar", fence) : Update.buildUpdatePrompt("ar", fence, { now });
  const r = await call([{ text: prompt }, { text: `===${fence}===\n${c.text}\n===${fence}===` }]);
  let out = null;
  try {
    const raw = JSON.parse(r.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    out = kind === "extraction" ? Intake.normalizeLeadExtraction(raw) : Update.normalizeUpdate(raw);
  } catch {
    out = null;
  }
  const keys = Object.keys(c.expected);
  const misses = out ? keys.filter((k) => !same(k, c.expected[k], out)) : keys;
  return { id: c.id, ms: r.ms, tokens: r.tokens, correct: keys.length - misses.length, total: keys.length, misses, out };
}

async function main() {
  const set = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "eval", "lead-cases.json"), "utf8"));
  const now = new Date(set.now);
  const [pin, pout] = PRICES[MODEL] || [0.75, 3.75];
  const report = { model: MODEL, at: new Date().toISOString(), suites: {} };
  for (const kind of ["extraction", "update"]) {
    const results = [];
    for (const c of set[kind]) {
      const r = await run(kind, c, now);
      results.push(r);
      process.stdout.write(r.misses.length ? "x" : ".");
    }
    const sum = (f) => results.reduce((s, r) => s + f(r), 0);
    const summary = {
      fieldAccuracy: Math.round((sum((r) => r.correct) / sum((r) => r.total)) * 1000) / 10,
      perfect: results.filter((r) => !r.misses.length).length,
      cases: results.length,
      tokensIn: Math.round(sum((r) => r.tokens.in) / results.length),
      tokensOut: Math.round(sum((r) => r.tokens.out) / results.length),
      costPerCall: Number(((sum((r) => r.tokens.in) * pin + sum((r) => r.tokens.out) * pout) / 1e6 / results.length).toFixed(5)),
      p50Ms: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)]
    };
    report.suites[kind] = { summary, results };
    console.log(`\n${MODEL} lead_${kind}: ${summary.fieldAccuracy}% fields, ${summary.perfect}/${summary.cases} perfect, ~${summary.tokensIn}/${summary.tokensOut} tokens, $${summary.costPerCall}/call`);
    for (const r of results.filter((x) => x.misses.length)) console.log(`  ${r.id} missed ${r.misses.join(", ")}`);
  }
  const dir = path.join(ROOT, "tests", "eval", "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `leads-${MODEL}.json`), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
