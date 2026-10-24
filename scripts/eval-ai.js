// scripts/eval-ai.js — Manual AI quality/latency eval (plan Part 6, L1-eval). Calls real Gemini; not run in CI.
// Usage: node --env-file=.env scripts/eval-ai.js [--model gemini-3.8-flash] [--configs A,B,C,D,E] [--cases 01,02]
// Recordings: tests/eval/audio/*.ogg (local only). Results: tests/eval/results/<timestamp>.json (local only).
"use strict";

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

async function callGemini(genAI, parts, { thinking, json }) {
  const config = { temperature: 0.1 };
  if (json) config.responseMimeType = "application/json";
  if (thinking) config.thinkingConfig = { thinkingLevel: thinking };
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastCall + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const t0 = Date.now();
    try {
      const res = await genAI.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }], config });
      const u = res.usageMetadata || {};
      return {
        text: res.text || "",
        ms: Date.now() - t0,
        tokens: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0, thoughts: u.thoughtsTokenCount || 0 },
        retries: attempt
      };
    } catch (err) {
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

  if (cfg.twoStep) {
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
  const out = parseJson(r.text);
  return { id: c.id, atDoneMs: r.ms, transcribeMs, tokens, transcripts, score: scoreExtraction(c.expected, out), out };
}

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};

async function main() {
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "eval", "cases.json"), "utf8")).voice;
  const onlyCases = arg("cases", null)?.split(",");
  const selected = cases.filter((c) => !onlyCases || onlyCases.some((p) => c.id.startsWith(p)));
  const missing = selected.flatMap((c) => c.files).filter((f) => !fs.existsSync(path.join(AUDIO_DIR, f)));
  if (missing.length) throw new Error(`Missing recordings: ${missing.join(", ")}`);

  const genAI = await AI.getGenAI();
  const configIds = arg("configs", Object.keys(CONFIGS).join(",")).split(",");
  // One results file per model; saved after every case so an interrupted run resumes where it stopped.
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const file = path.join(RESULTS_DIR, `${MODEL}.json`);
  const report = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { model: MODEL, configs: {} };
  const save = () =>
    fs.writeFileSync(file, JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2));

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
    const ok = results.filter((r) => !r.error);
    const correct = results.reduce((s, r) => s + r.score.correct, 0);
    const total = results.reduce((s, r) => s + r.score.total, 0);
    const summary = {
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
