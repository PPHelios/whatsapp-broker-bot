// tests/unit/flyer.test.js — Flyer model rules, worker rendering and the PNG regression snapshots
"use strict";

jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Flyer = require("../../lib/flyer");
const Describe = require("../../domain/describe");
const { SAMPLES, sampleInputs } = require("../flyer/samples");

jest.setTimeout(120000);

const SNAP_DIR = path.join(__dirname, "..", "flyer", "samples");
const ARABIC = /[؀-ۿ]/;
const strings = (o) => JSON.stringify(o);

afterAll(() => Flyer.stopFlyerWorker());

describe.each(SAMPLES.map((s) => [s.name, s]))("%s model", (_name, s) => {
  const build = async () => {
    const { agency, broker } = await sampleInputs({ ...s, photos: 0 });
    return Flyer.buildFlyerModel({ listing: s.listing, agency, broker, theme: s.theme || "dark" });
  };

  test("no Arabic script anywhere", async () => {
    expect(strings(await build())).not.toMatch(ARABIC);
  });

  test("every English feature label is on the flyer (chip, or counted in '+N more')", async () => {
    const m = await build();
    const labels = Describe.featureLabels(s.listing, "en");
    const shown = m.chips.map((c) => c.text);
    const visible = shown.slice(0, 9); // chipMax 10 → 9 chips + "+N more"
    const missing = labels.filter((l) => !shown.some((t) => l.startsWith(t.replace(/\.\.\.$/, ""))));
    expect(missing).toEqual([]);
    if (labels.length) expect(visible.length).toBeGreaterThan(0);
  });

  test("nothing internal, no warnings, no placeholders", async () => {
    const txt = strings(await build());
    expect(txt).not.toMatch(/⚠️|not recorded|undefined|null sqm|NaN/);
  });
});

test("resale with installments: cash required, remaining schedule and fees from the structured columns", async () => {
  const s = SAMPLES.find((x) => x.name === "02-resale-installments");
  const m = Flyer.buildFlyerModel({ listing: s.listing, agency: {}, broker: {} });
  expect(m.card.right).toEqual({ type: "figure", label: "Cash required", value: "4M" });
  expect(m.card.notes.join(" | ")).toMatch(/Remaining 6M • quarterly installment 250K • \d+(\.\d)? years left/);
  expect(m.card.notes.join(" | ")).toMatch(/Over price 500K • Club fee 150K/);
  expect(m.chips[0]).toEqual({ text: "Delivery 2027 Q3", hi: true });
});

test("primary: plans and maintenance terms; unknown maintenance reads 'as per contract'", () => {
  const s = SAMPLES.find((x) => x.name === "03-primary-plans");
  const m = Flyer.buildFlyerModel({ listing: s.listing });
  expect(m.card.right.lines).toEqual(["Cash 9M", "10% down • 8 years • quarterly", "5% down • 10 years • monthly"]);
  expect(m.card.notes).toEqual(["Maintenance 8%"]);
  const unknown = Flyer.buildFlyerModel({ listing: { ...s.listing, maintenance_pct: null } });
  expect(unknown.card.notes).toEqual(["Maintenance as per contract"]);
});

test("a villa never shows a floor; overflow facts become chips", () => {
  const s = SAMPLES.find((x) => x.name === "04-villa");
  const m = Flyer.buildFlyerModel({ listing: { ...s.listing, floor_level: 2 } });
  expect(m.facts.map((f) => f.label)).toEqual(["BUA", "Land", "Bedrooms", "Bathrooms", "Finishing", "Garden"]);
  expect(m.chips.map((c) => c.text)).toContain("Roof 80 sqm");
});

test("an Arabic-only compound falls back to the English area name", () => {
  const s = SAMPLES.find((x) => x.name === "08-long-arabic-name-many-features");
  const m = Flyer.buildFlyerModel({ listing: s.listing });
  expect(m.locationLine).toBe("Sheikh Zayed");
});

/** Mean absolute difference (0-255) between two images, compared at a small common size. */
async function imageDiff(a, b) {
  const meta = await sharp(b).metadata();
  const small = async (buf) => sharp(buf).resize(270, Math.round((270 * meta.height) / meta.width), { fit: "fill" }).removeAlpha().raw().toBuffer();
  const [x, y] = await Promise.all([small(a), small(b)]);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

describe("PNG regression snapshots (tests/flyer/samples)", () => {
  test.each(SAMPLES.map((s) => [s.name, s]))("%s renders like the approved sample", async (name, s) => {
    const { bufs, logoBuf, agency, broker } = await sampleInputs(s);
    const model = Flyer.buildFlyerModel({ listing: s.listing, agency, broker, theme: s.theme || "dark" });
    const png = await Flyer.renderFlyerImage({ model, theme: s.theme || "dark", primary: agency.primary_color, secondary: agency.secondary_color, bufs, logoBuf, format: "png" });
    const approved = fs.readFileSync(path.join(SNAP_DIR, `${name}.png`));
    const [m1, m2] = await Promise.all([sharp(png).metadata(), sharp(approved).metadata()]);
    expect(m1.width).toBe(1080);
    expect(Math.abs(m1.height - m2.height)).toBeLessThanOrEqual(4);
    expect(await imageDiff(png, approved)).toBeLessThan(3);
  });
});

describe("Worker rendering", () => {
  test("renders off the main thread and returns an image", async () => {
    const s = SAMPLES[4];
    const { bufs, logoBuf, agency, broker } = await sampleInputs(s);
    const model = Flyer.buildFlyerModel({ listing: s.listing, agency, broker });
    const { buffer } = await Flyer.renderOffThread({ model, theme: "dark", bufs, logoBuf, format: "jpeg" });
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1080);
  });

  test("the queue is bounded (QUEUE_FULL instead of unbounded memory)", async () => {
    const s = SAMPLES[6];
    const model = Flyer.buildFlyerModel({ listing: s.listing });
    const jobs = Array.from({ length: 12 }, () => Flyer.renderOffThread({ model, theme: "dark", bufs: [], logoBuf: null }).then(() => "ok", (e) => e.code));
    const results = await Promise.all(jobs);
    expect(results).toContain("QUEUE_FULL");
    expect(results.filter((r) => r === "ok").length).toBeGreaterThan(0);
  });
});

test("there is one flyer pipeline (deliverFlyer is gone)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../routes/commandDeliverables.js"), "utf8");
  expect(src).not.toMatch(/async function deliverFlyer\(/);
  expect(src).toMatch(/renderFlyerOnDemand/);
});
