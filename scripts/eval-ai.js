// scripts/eval-ai.js — Manual AI quality/latency eval (plan Part 6, L1-eval). Calls real Gemini; not run in CI.
// Usage: node --env-file=.env scripts/eval-ai.js [--key-env KEY_A,KEY_B] [--model gemini-3.8-flash] [--configs A,B,C,D,E] [--cases 01,02]
// Recordings: tests/eval/audio/*.ogg (local only). Results: tests/eval/results/<model>.json (local only).
"use strict";

// Evals must never consume the production key's daily quota (it starves the live bot).
// --key-env takes one or more env var names (comma-separated), each a key from a separate
// Google AI Studio project; when one hits its daily limit the eval moves to the next.
const keyFlag = process.argv.indexOf("--key-env");
const KEY_ENVS = (keyFlag > -1 ? process.argv[keyFlag + 1] : "GEMINI_EVAL_API_KEY").split(",");
const PROD_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const EVAL_KEYS = KEY_ENVS.map((name) => {
  const key = String(process.env[name] || "").trim();
  if (!key) {
    console.error(`${name} is not set. Add a key from a separate Google AI Studio project to .env.`);
    process.exit(1);
  }
  if (name === "GEMINI_API_KEY" || key === PROD_KEY) {
    console.error("Eval keys must differ from the production GEMINI_API_KEY.");
    process.exit(1);
  }
  return { name, key };
});

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const L = require("../lib/listing");
const AI = require("../lib/ai");
const { scoreExtraction } = require("../tests/eval/score");

const ROOT = path.join(__dirname, "..");
const AUDIO_DIR = path.join(ROOT, "tests", "eval", "audio");
const RESULTS_DIR = path.join(ROOT, "tests", "eval", "results");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const MODEL = arg("model", AI.TIERS[0]);
const MIN_GAP_MS = Number(arg("gap", 6500)); // free tier: stay under ~10 requests/minute

// Each config: how the draft is extracted from the voice notes.
const CONFIGS = {
  A: { label: "1 call, audio, default thinking", twoStep: false, extract: null },
  B: { label: "1 call, audio, MINIMAL", twoStep: false, extract: "MINIMAL" },
  C: { label: "1 call, audio, LOW", twoStep: false, extract: "LOW" },
  D: { label: "transcribe MINIMAL -> text extract LOW", twoStep: true, transcribe: "MINIMAL", extract: "LOW" },
  E: { label: "transcribe MINIMAL -> text extract MINIMAL", twoStep: true, transcribe: "MINIMAL", extract: "MINIMAL" }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
let keyIndex = 0;
const clients = new Map();

async function client() {
  const { name, key } = EVAL_KEYS[keyIndex];
  if (!clients.has(name)) {
    const { GoogleGenAI } = await import("@google/genai");
    clients.set(name, new GoogleGenAI({ apiKey: key }));
  }
  return clients.get(name);
}

// Levels a model refuses (lib/ai.js THINKING): 3.8 Flash has no MINIMAL, so it runs at LOW (the production setting).
const THINKING_FLOOR = { "gemini-3.8-flash": { MINIMAL: "LOW" } };

async function callGemini(_unused, parts, { thinking: asked, json }) {
  const thinking = (THINKING_FLOOR[MODEL] || {})[asked] || asked;
  const config = { temperature: 0.1 };
  if (json) config.responseMimeType = "application/json";
  if (thinking) config.thinkingConfig = { thinkingLevel: thinking };
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const t0 = Date.now();
    try {
      const res = await (await client()).models.generateContent({ model: MODEL, contents: [{ role: "user", parts }], config });
      const u = res.usageMetadata || {};
      return {
        text: res.text || "",
        ms: Date.now() - t0,
        tokens: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0 },
        retries: attempt
      };
    } catch (err) {
      if (/PerDay/.test(err.message)) {
        // This project's daily limit is used up: move to the next key (does not count as a retry).
        if (keyIndex + 1 >= EVAL_KEYS.length) throw err;
        console.log(`
[eval] ${EVAL_KEYS[keyIndex].name} hit its daily limit; switching to ${EVAL_KEYS[keyIndex + 1].name}`);
        keyIndex++;
        attempt--;
        continue;
      }
      const transient = /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|high demand/i.test(err.message);
      if (!transient || attempt === 3) throw err;
      await sleep(20000 * (attempt + 1)); // back off; retried attempts are not timed
    }
  }
}

const audioPart = (file) => ({
  inlineData: { mimeType: "audio/ogg", data: fs.readFileSync(path.join(AUDIO_DIR, file)).toString("base64") }
});

function parseJson(text) {
  try {
    return JSON.parse(String(text).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
  } catch {
    return null;
  }
}

async function runCase(genAI, cfg, c) {
  const fence = crypto.randomBytes(4).toString("hex").toUpperCase();
  const prompt = { text: L.buildListingPrompt("ar", fence) };
  const tokens = { in: 0, out: 0, thoughts: 0 };
  const add = (t) => Object.keys(tokens).forEach((k) => (tokens[k] += t[k]));
  let transcribeMs = 0;
  let parts;
  let transcripts = null;

  if (c.script && !c.files) {
    // Text case: the broker's written note, no recording.
    parts = [prompt, { text: `===${fence}===\n${c.script}\n===${fence}===` }];
  } else if (cfg.twoStep) {
    transcripts = [];
    for (const file of c.files) {
      const r = await callGemini(genAI, [{ text: AI.TRANSCRIPTION_PROMPT }, audioPart(file)], { thinking: cfg.transcribe });
      transcribeMs = Math.max(transcribeMs, r.ms); // notes are transcribed on arrival, in parallel with recording
      add(r.tokens);
      transcripts.push(r.text.trim());
    }
    parts = [prompt, { text: `===${fence}===\n${transcripts.join("\n")}\n===${fence}===` }];
  } else {
    parts = [prompt, ...c.files.map(audioPart)];
  }

  const r = await callGemini(genAI, parts, { thinking: cfg.extract, json: true });
  add(r.tokens);
  const raw = parseJson(r.text);
  // Score what production stores: the normalized extraction (raw kept for the free-text fields).
  const out = raw ? { ...raw, ...L.normalizeExtraction(raw), details: { ...(raw.details || {}), ...L.normalizeExtraction(raw).details } } : null;
  return { id: c.id, atDoneMs: r.ms, transcribeMs, tokens, transcripts, score: scoreExtraction(c.expected, out), out };
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

function summarize(cfg, results) {
  const ok = results.filter((r) => !r.error);
  const correct = results.reduce((s, r) => s + r.score.correct, 0);
  const total = results.reduce((s, r) => s + r.score.total, 0);
  return {
    label: cfg.label,
    fieldAccuracy: +(100 * (correct / total)).toFixed(1),
    perfectCases: results.filter((r) => r.score.correct === r.score.total).length,
    cases: results.length,
    errors: results.length - ok.length,
    atDoneP50: pct(ok.map((r) => r.atDoneMs), 50),
    atDoneP90: pct(ok.map((r) => r.atDoneMs), 90),
    transcribeP50: pct(ok.map((r) => r.transcribeMs), 50),
    thoughtTokensAvg: Math.round(ok.reduce((s, r) => s + r.tokens.thoughts, 0) / (ok.length || 1)),
    outTokensAvg: Math.round(ok.reduce((s, r) => s + r.tokens.out, 0) / (ok.length || 1))
  };
}

async function main() {
  const evalSet = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "eval", "cases.json"), "utf8"));
  const cases = [...evalSet.voice, ...(evalSet.text || [])];
  const onlyCases = arg("cases", null)?.split(",");
  const selected = cases.filter((c) => !onlyCases || onlyCases.some((p) => c.id.startsWith(p)));
  const missing = selected.flatMap((c) => c.files || []).filter((f) => !fs.existsSync(path.join(AUDIO_DIR, f)));
  if (missing.length) throw new Error(`Missing recordings: ${missing.join(", ")}`);

  const genAI = null; // clients come from EVAL_KEYS (see client())
  const configIds = arg("configs", Object.keys(CONFIGS).join(",")).split(",");
  // One results file per model; saved after every case so an interrupted run resumes where it stopped.
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${MODEL}.json`);
  const report = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { model: MODEL, configs: {} };
  const save = () =>
    fs.writeFileSync(file, JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2));

  // --rescore: re-apply the current scorer to stored outputs (no API calls), e.g. after a scorer fix.
  if (process.argv.includes("--rescore")) {
    const expectedById = new Map(cases.map((c) => [c.id, c.expected]));
    for (const [id, entry] of Object.entries(report.configs)) {
      for (const r of entry.results || []) {
        if (!r.error) r.score = scoreExtraction(expectedById.get(r.id), r.out);
      }
      if (entry.summary) entry.summary = { ...summarize(CONFIGS[id], entry.results) };
      if (entry.summary) console.log(`${id} ${entry.summary.label}: ${entry.summary.fieldAccuracy}% fields, ${entry.summary.perfectCases}/${entry.summary.cases} perfect`);
    }
    save();
    return;
  }

  for (const id of configIds) {
    const cfg = CONFIGS[id];
    const previous = new Map(
      (report.configs[id]?.results || []).filter((r) => !r.error).map((r) => [r.id, r])
    );
    const results = [];
    for (const c of selected) {
      if (previous.has(c.id)) {
        results.push(previous.get(c.id)); // finished in an earlier run
        process.stdout.write("=");
        continue;
      }
      try {
        results.push(await runCase(genAI, cfg, c));
      } catch (err) {
        results.push({ id: c.id, error: err.message, score: { correct: 0, total: Object.keys(c.expected).length, misses: [] } });
      }
      report.configs[id] = { ...report.configs[id], results };
      save();
      process.stdout.write(".");
    }
    const summary = summarize(cfg, results);
    report.configs[id] = { summary, results };
    save();
    console.log(`\n${id} ${cfg.label}: ${summary.fieldAccuracy}% fields, ${summary.perfectCases}/${summary.cases} perfect, ` +
      `at-done p50 ${summary.atDoneP50}ms p90 ${summary.atDoneP90}ms, thoughts ~${summary.thoughtTokensAvg} tok, errors ${summary.errors}`);
  }

  console.log(`\nFull results: ${file}`);
}

main().catch((err) => {
  console.error("Eval failed:", err.message);
  process.exit(1);
});
