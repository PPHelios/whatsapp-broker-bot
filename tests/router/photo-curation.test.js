// tests/router/photo-curation.test.js — F7: the AI photo order is saved (no unique-position clash), layouts go last,
// unrelated photos are left out of the flyer and the broker is told which ones
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const AI = require("../../lib/ai");
const { createHarness, closeHarness } = require("../harness/app");
const { ensureListingImagesCurated } = require("../../lib/vision");

jest.setTimeout(60000);

let h;
let realFetch;
beforeAll(async () => {
  const jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#888" } }).jpeg().toBuffer();
  realFetch = global.fetch;
  global.fetch = async (url) => (String(url).startsWith("https://img.test/") ? new Response(jpeg) : realFetch(url));
});
afterAll(async () => {
  global.fetch = realFetch;
  await closeHarness();
});
beforeEach(async () => {
  h = await createHarness();
  AI.reset();
});

async function unitWithPhotos(n) {
  const l = await h.insertListing({ code: "PH-01", compound: "ميفيدا", bedrooms: 3, area_value: 180, price_value: 9e6 });
  for (let i = 0; i < n; i++) {
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url, role) VALUES ($1, $2, $3, $4, NULL)", [l.id, l.agency_id, i, `https://img.test/${i}.jpg`]);
  }
  return l;
}

test("the curated order is saved; layouts go last and unrelated photos after them", async () => {
  const l = await unitWithPhotos(4);
  AI.respond((c) =>
    c.operation === "vision_curation"
      ? [
          { index: 0, role: "layout", aesthetic_score: 6, is_hero: false },
          { index: 1, role: "unrelated", aesthetic_score: 2, is_hero: false },
          { index: 2, role: "reception", aesthetic_score: 7, is_hero: false },
          { index: 3, role: "facade", aesthetic_score: 9, is_hero: true }
        ]
      : new Error("unexpected")
  );
  const out = await ensureListingImagesCurated(l.id, { pool: h.pool });
  expect(out.map((i) => i.url)).toEqual(["https://img.test/3.jpg", "https://img.test/2.jpg", "https://img.test/0.jpg", "https://img.test/1.jpg"]);
  expect(out.map((i) => i.role)).toEqual(["facade", "reception", "layout", "unrelated"]);
  expect(out.skipped).toEqual([2]);
});

test("the flyer leaves the unrelated photo out, says so, and doesn't ask the AI again next time", async () => {
  await unitWithPhotos(2);
  AI.respond((c) =>
    c.operation === "vision_curation"
      ? [{ index: 0, role: "unrelated", aesthetic_score: 2, is_hero: false }, { index: 1, role: "facade", aesthetic_score: 8, is_hero: true }]
      : new Error("unexpected")
  );
  const out = await h.text("broker", "flyer PH-01");
  expect(out[0].type).toBe("image");
  expect(out.map((r) => r.text || "").join("\n")).toMatch(/#1/);
  const curations = AI.calls.filter((c) => c.operation === "vision_curation").length;
  await h.text("broker", "flyer PH-01 en");
  expect(AI.calls.filter((c) => c.operation === "vision_curation")).toHaveLength(curations);
});
