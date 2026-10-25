// tests/web/chat-photos.test.js — Phase 2 step 5: photos from a WhatsApp chat export zip and the duplicate-photo flag
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const JSZip = require("jszip");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Imports = require("../../services/imports");
const PhotoHash = require("../../services/photoHash");
const Chat = require("../../domain/chatExport");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
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

const importId = (res) => res.headers.location.split("/").pop();

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

const CHAT_ANDROID = [
  "24/10/2026, 10:14 - Ahmed: IMG-20261024-WA0001.jpg (file attached)",
  "24/10/2026, 10:14 - Ahmed: IMG-20261024-WA0002.jpg (file attached)",
  "24/10/2026, 10:15 - Ahmed: شقة للبيع في ميفيدا 200 متر 3 غرف",
  "السعر 12 مليون",
  "24/10/2026, 10:20 - Sara: فيلا في هايد بارك 300 متر 4 غرف السعر 25 مليون",
  "24/10/2026, 10:21 - Sara: IMG-20261024-WA0003.jpg (file attached)",
  "24/10/2026, 10:22 - Mona: IMG-20261024-WA0009.jpg (file attached)",
  "24/10/2026, 10:30 - Ahmed: تمام"
].join("\n");

async function exportZip(photos, chat = CHAT_ANDROID) {
  const zip = new JSZip();
  zip.file("WhatsApp Chat with Brokers.txt", chat);
  for (const [name, buf] of Object.entries(photos)) zip.file(name, buf);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("matching photos to posts", () => {
  test("Android and iOS exports: each photo goes to the same sender's nearest post within minutes", () => {
    const android = Chat.candidatePostsWithPhotos(CHAT_ANDROID);
    expect(android.posts.map((p) => [p.sender, p.files])).toEqual([
      ["Ahmed", ["IMG-20261024-WA0001.jpg", "IMG-20261024-WA0002.jpg"]],
      ["Sara", ["IMG-20261024-WA0003.jpg"]]
    ]);
    const ios = Chat.candidatePostsWithPhotos(
      [
        "[24/10/2026, 10:14:02 PM] Ahmed: <attached: 00000012-PHOTO-2026-10-24-22-14-02.jpg>",
        "[24/10/2026, 10:15:32 PM] Ahmed: شقة للبيع في ميفيدا 200 متر 3 غرف السعر 12 مليون",
        "[24/10/2026, 11:40:00 PM] Ahmed: <attached: 00000013-PHOTO-2026-10-24-23-40-00.jpg>"
      ].join("\n")
    );
    // The second photo came 85 minutes later: not this post's.
    expect(ios.posts[0].files).toEqual(["00000012-PHOTO-2026-10-24-22-14-02.jpg"]);
    expect(Chat.atMs("24/10/2026 10:15 م")).toBe(Date.UTC(2026, 9, 24, 22, 15));
  });

  test("at most 15 photos a post", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `24/10/2026, 10:14 - Ahmed: IMG-${i}.jpg (file attached)`);
    lines.push("24/10/2026, 10:15 - Ahmed: شقة للبيع في ميفيدا 200 متر 3 غرف السعر 12 مليون");
    expect(Chat.candidatePostsWithPhotos(lines.join("\n")).posts[0].files).toHaveLength(Chat.MAX_PHOTOS);
  });

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

describe("chat export zip with photos", () => {
  test("photos are stored with their posts, shown on the review, attached to the new unit with their hash; unused ones are deleted", async () => {
    const zip = await exportZip({ "IMG-20261024-WA0001.jpg": await picture(0.2), "IMG-20261024-WA0002.jpg": await picture(0.5), "IMG-20261024-WA0003.jpg": await picture(0.8) });
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/import/group").field("_csrf", csrf).attach("chat", zip, { filename: "chat.zip", contentType: "application/zip" });
    expect(r.status).toBe(303);
    const id = importId(r);
    await Imports.waitForGroupImport(id);
    const page = (await agent.get(`/app/import/${id}`)).text;
    expect(page).toMatch(/data-post="0" data-state="ok"[\s\S]*data-photos="2"[\s\S]*data-post="1"[\s\S]*data-photos="1"/);
    expect(page).toMatch(/📷 2 صورة/);
    expect(h.Storage.objects.size).toBe(3);

    await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=0");
    const [l] = await h.query("SELECT * FROM listings WHERE details->>'source' = 'group_import'");
    const imgs = await h.query("SELECT url, phash FROM listing_images WHERE listing_id = $1 ORDER BY position", [l.id]);
    expect(imgs).toHaveLength(2);
    expect(imgs.every((i) => /^[01]{64}$/.test(i.phash))).toBe(true);
    // Sara's post wasn't added: its photo is removed from storage.
    expect(h.Storage.objects.size).toBe(2);
  });

  test("a photo already on an active unit is flagged with that unit's code", async () => {
    const old = await h.insertListing({ code: "HP-OLD" });
    const same = await picture(0.2);
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url, phash) VALUES ($1, $2, 0, $3, $4::bit(64))", [old.id, h.AGENCY_A, `${h.Storage.BASE}x.jpg`, await PhotoHash.hashImage(same)]);
    // Another agency's identical photo is never a match.
    const rival = await h.insertListing({ code: "RIV-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url, phash) VALUES ($1, $2, 0, $3, $4::bit(64))", [rival.id, h.AGENCY_B, `${h.Storage.BASE}y.jpg`, await PhotoHash.hashImage(await picture(0.8))]);
    const zip = await exportZip({ "IMG-20261024-WA0001.jpg": await sharp(same).resize(200).jpeg({ quality: 50 }).toBuffer(), "IMG-20261024-WA0003.jpg": await picture(0.8) });
    const { agent, csrf } = await signIn(h, "broker");
    const id = importId(await agent.post("/app/import/group").field("_csrf", csrf).attach("chat", zip, { filename: "chat.zip", contentType: "application/zip" }));
    await Imports.waitForGroupImport(id);
    const page = (await agent.get(`/app/import/${id}`)).text;
    expect(page).toMatch(/data-post="0"[\s\S]*data-same-photo="HP-OLD"/);
    expect(page).not.toMatch(/RIV-1/);
    // Ahmed's second photo is named in the chat but missing from the zip.
    expect(page).toMatch(/1 مش موجودة في الملف/);
  });

  test("big exports: the browser uploads to a signed URL under the broker's own path, then the server reads it from storage", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const start = await agent.post("/app/import/zip/start").set("X-CSRF-Token", csrf);
    expect(start.status).toBe(200);
    expect(start.body.path.startsWith(`${h.AGENCY_A}/${h.BROKERS.broker.id}/`)).toBe(true);
    expect(start.body.url).toMatch(/^https:\/\/storage\.test\/upload\//);
    h.Storage.chats.set(start.body.path, await exportZip({ "IMG-20261024-WA0003.jpg": await picture(0.8) }));

    const r = await agent.post("/app/import/zip").set("X-CSRF-Token", csrf).type("form").send({ path: start.body.path, filename: "Brokers.zip" });
    expect(r.status).toBe(303);
    const id = importId(r);
    await Imports.waitForGroupImport(id);
    expect((await agent.get(`/app/import/${id}`)).text).toMatch(/data-post="1"[\s\S]*data-photos="1"/);
    // The zip is deleted from the private bucket once read.
    expect(h.Storage.chats.size).toBe(0);
  });

  test("someone else's upload path is refused; a file that never arrived or isn't a chat export is reported", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const foreign = `${h.AGENCY_B}/${h.BROKERS.rival.id}/1761300000000-0123456789ab.zip`;
    expect((await agent.post("/app/import/zip").set("X-CSRF-Token", csrf).type("form").send({ path: foreign })).status).toBe(400);

    const mine = `${h.AGENCY_A}/${h.BROKERS.broker.id}/1761300000000-0123456789ab.zip`;
    const missing = importId(await agent.post("/app/import/zip").set("X-CSRF-Token", csrf).type("form").send({ path: mine }));
    await Imports.waitForGroupImport(missing);
    expect((await agent.get(`/app/import/${missing}`)).text).toMatch(/data-import-error="not_found"/);

    const notChat = new JSZip();
    notChat.file("photo.jpg", await picture(0.5));
    h.Storage.chats.set(mine, await notChat.generateAsync({ type: "nodebuffer" }));
    const bad = importId(await agent.post("/app/import/zip").set("X-CSRF-Token", csrf).type("form").send({ path: mine }));
    await Imports.waitForGroupImport(bad);
    expect((await agent.get(`/app/import/${bad}`)).text).toMatch(/data-import-error="no_chat"/);
  });

  test("the import page offers the zip upload; the CSP has no inline script", async () => {
    const { agent } = await signIn(h, "broker");
    const page = await agent.get("/app/import");
    expect(page.text).toMatch(/data-zip-upload/);
    expect(page.text).not.toMatch(/<script>(?!<\/script>)/);
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
