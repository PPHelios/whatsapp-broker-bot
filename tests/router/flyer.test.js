// tests/router/flyer.test.js — Flyer by button or text: one pipeline, one message with a caption
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const unit = () =>
  h.insertListing({ code: "VIL-08", property_type: "villa", compound: "بالم هيلز أكتوبر", compound_en: "Palm Hills October", bedrooms: 5, area_value: 400, price_value: 35e6, feature_keys: ["north_facing"] });

test("the Flyer button sends exactly one message: the image with its caption", async () => {
  await unit();
  const out = await h.tap("broker", "flyer:en:dark:VIL-08");
  expect(out).toHaveLength(1);
  expect(out[0].type).toBe("image");
  expect(out[0].caption).toBe("Villa in Palm Hills October\nRef VIL-08\nAgency Alpha");
  expect(out[0].media).toMatch(/^https:\/\/storage\.test\/.*flyers\//);
  const [log] = await h.query("SELECT status, flyer_render_ms FROM operation_logs WHERE operation_type = 'flyer_render'");
  expect(log.status).toBe("success");
});

test("'flyer CODE' uses the same pipeline; a second request is served from the cache", async () => {
  await unit();
  const first = await h.text("broker", "flyer vil-08");
  expect(first.map((r) => r.type)).toEqual(["image"]);
  const uploads = h.Storage.objects.size;
  const second = await h.text("broker", "كتالوج VIL-08");
  expect(second.map((r) => r.type)).toEqual(["image"]);
  expect(second[0].media).toBe(first[0].media);
  expect(h.Storage.objects.size).toBe(uploads);
});

test("a changed unit gets a fresh flyer (cache key follows the data)", async () => {
  await unit();
  const first = await h.text("broker", "flyer VIL-08");
  await h.text("broker", "سعر VIL-08 33 مليون");
  const second = await h.text("broker", "flyer VIL-08");
  expect(second[0].media).not.toBe(first[0].media);
});

test("an unknown code says so", async () => {
  const out = await h.text("broker", "flyer NOPE-1");
  expect(out[0].text).toMatch(/غير موجودة|لم يتم العثور/);
});
