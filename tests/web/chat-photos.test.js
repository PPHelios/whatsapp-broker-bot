// tests/web/chat-photos.test.js — The photo hash (duplicate-photo flag), its backfill job and the chat start date
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const PhotoHash = require("../../services/photoHash");
const Chat = require("../../domain/chatExport");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  h.Storage.reset();
  h.AI.respond((c) => {
    if (c.operation !== "listing_extraction") return null;
    const t = JSON.stringify(c.contents);
    return t.includes("ميفيدا")
      ? { listing_type: "sale", market: "resale", property_type: "apartment", compound: "ميفيدا", area_value: 200, bedrooms: 3, price_value: 12e6 }
      : { listing_type: "sale", market: "resale", property_type: "villa", compound: "Hyde Park", area_value: 300, bedrooms: 4, price_value: 25e6 };
  });
});
afterAll(closeHarness);

/** A distinct test picture: smooth waves whose pattern depends on `seed` (0–1), like a photo's shading. */
async function picture(seed, { size = 400 } = {}) {
  const px = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 128 + 60 * Math.sin((x / size) * (3 + seed * 9) + seed * 5) + 60 * Math.cos((y / size) * (2 + seed * 7) + seed * 11);
      const o = (y * size + x) * 3;
      px[o] = px[o + 1] = px[o + 2] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 3 } }).jpeg().toBuffer();
}

describe("start date", () => {
  test("posts before the chosen date are dropped; the default is 30 days back", () => {
    const text = [
      "01/01/2026, 10:15 - Ahmed: شقة للبيع في ميفيدا 200 متر 3 غرف السعر 12 مليون",
      "24/10/2026, 10:20 - Sara: فيلا في هايد بارك 300 متر 4 غرف السعر 25 مليون"
    ].join("\n");
    expect(Chat.candidatePosts(text).posts).toHaveLength(2);
    expect(Chat.candidatePosts(text, { since: "2026-09-01" }).posts.map((p) => p.sender)).toEqual(["Sara"]);
    expect(Chat.defaultSince(new Date("2026-10-28T00:00:00Z"))).toBe("2026-09-28");
  });
});

describe("photo hash", () => {
  test("the photo hash survives resizing and recompression but tells different pictures apart", async () => {
    const a = await PhotoHash.hashImage(await picture(0.3));
    const aSmall = await PhotoHash.hashImage(await sharp(await picture(0.3)).resize(120).jpeg({ quality: 40 }).toBuffer());
    const b = await PhotoHash.hashImage(await picture(0.7));
    expect(a).toMatch(/^[01]{64}$/);
    expect(PhotoHash.distance(a, aSmall)).toBeLessThanOrEqual(PhotoHash.MAX_DISTANCE);
    expect(PhotoHash.distance(a, b)).toBeGreaterThan(PhotoHash.MAX_DISTANCE);
    expect(await PhotoHash.hashImage(Buffer.from("not an image"))).toBeNull();
  });
});

describe("photo hash backfill", () => {
  test("photos stored before hashing get a hash; the job is registered", async () => {
    const l = await h.insertListing({ code: "B-1" });
    const url = `${h.Storage.BASE}old/b.jpg`;
    h.Storage.objects.set("old/b.jpg", await picture(0.4));
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, $3)", [l.id, h.AGENCY_A, url]);
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 1, $3)", [l.id, h.AGENCY_A, `${h.Storage.BASE}gone.jpg`]);
    expect(await PhotoHash.backfill(h.pool)).toEqual({ seen: 2, hashed: 1 });
    const [img] = await h.query("SELECT phash FROM listing_images WHERE url = $1", [url]);
    expect(img.phash).toMatch(/^[01]{64}$/);
    expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("photo_hashes");
  });
});
