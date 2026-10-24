// scripts/render-flyer-samples.js — Renders the flyer sample set to PNGs and reports peak memory.
// Usage: node scripts/render-flyer-samples.js [outDir]   (default: tests/flyer/samples, the regression snapshots)
"use strict";

process.env.FLYER_WORKER = process.env.FLYER_WORKER || "true";

const fs = require("fs");
const path = require("path");
const Flyer = require("../lib/flyer");
const { SAMPLES, sampleInputs } = require("../tests/flyer/samples");

const OUT = process.argv[2] || path.join(__dirname, "..", "tests", "flyer", "samples");

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // Baseline: the app's modules loaded, no render yet (what the web process holds at rest).
  require("../server");
  const baseline = process.memoryUsage().rss;
  let peak = process.memoryUsage().rss;
  const tick = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
  const t0 = Date.now();
  for (const s of SAMPLES) {
    const { bufs, logoBuf, agency, broker } = await sampleInputs(s);
    const model = Flyer.buildFlyerModel({ listing: s.listing, agency, broker, theme: s.theme || "dark" });
    const payload = { model, theme: s.theme || "dark", primary: agency.primary_color, secondary: agency.secondary_color, bufs, logoBuf, format: "png" };
    const start = Date.now();
    const { buffer, rss } = await Flyer.renderOffThread(payload);
    peak = Math.max(peak, rss || 0);
    fs.writeFileSync(path.join(OUT, `${s.name}.png`), buffer);
    console.log(`${s.name}.png  ${Date.now() - start}ms`);
  }
  clearInterval(tick);
  await Flyer.stopFlyerWorker();
  console.log(`\n${SAMPLES.length} samples in ${Date.now() - t0}ms; baseline RSS ${Math.round(baseline / 1048576)} MB, peak RSS ${Math.round(peak / 1048576)} MB (process incl. worker)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
