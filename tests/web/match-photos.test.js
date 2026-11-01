// tests/web/match-photos.test.js — Match photos: the server half (unit codes, one photo onto a unit, posts → group import)
// The matching itself runs in the browser (tests/unit/chat-match.test.js); the old server-side zip import is gone.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Imports = require("../../services/imports");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
  h.Storage.reset();
  h.AI.respond((c) => {
    if (c.operation !== "listing_extraction") return null;
    return { listing_type: "sale", market: "resale", property_type: "villa", compound: "Hyde Park", area_value: 300, bedrooms: 4, price_value: 25e6 };
  });
});
afterAll(closeHarness);

/** A distinct test picture: smooth waves whose pattern depends on `seed` (0–1). */
async function picture(seed, { size = 300 } = {}) {
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

/** Picture number k: a random 9×8 brightness grid blown up, so no two are within the duplicate-photo distance. */
async function distinct(k) {
  let a = 0x9e3779b9 + k * 7919;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid = Buffer.from(Array.from({ length: 72 }, () => Math.floor(rnd() * 256)));
  return sharp(grid, { raw: { width: 9, height: 8, channels: 1 } }).resize(300, 300, { kernel: "nearest" }).jpeg().toBuffer();
}

const sendPhoto = (agent, csrf, url, buf) =>
  agent.post(url).set("X-CSRF-Token", csrf).attach("photo", buf, { filename: "photo.jpg", contentType: "image/jpeg" });
const unitUrl = (code) => `/app/import/match/unit/${encodeURIComponent(code)}/photo`;
const photosOf = (id) => h.query("SELECT url, phash::text AS phash FROM listing_images WHERE listing_id = $1 ORDER BY position", [id]);

describe("unit codes", () => {
  test("managers get the agency's codes with their photo counts; brokers are refused; other agencies' units never show", async () => {
    const a = await h.insertListing({ code: "HP-1" });
    await h.insertListing({ code: "HP-2" });
    await h.insertListing({ code: "RIV-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, $3)", [a.id, h.AGENCY_A, `${h.Storage.BASE}x.jpg`]);
    const { agent } = await signIn(h, "manager");
    const res = await agent.get("/app/import/match/units");
    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([{ code: "HP-1", photos: 1 }, { code: "HP-2", photos: 0 }]);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    const broker = await signIn(h, "broker");
    expect((await broker.agent.get("/app/import/match/units")).status).toBe(403);
  });

  test("a unit the agency owner marked private is hidden from the list and from photo uploads of a manager", async () => {
    await h.insertListing({ code: "HP-SECRET", is_private: true });
    const { agent, csrf } = await signIn(h, "manager");
    expect((await agent.get("/app/import/match/units")).body.units).toEqual([]);
    expect((await sendPhoto(agent, csrf, unitUrl("HP-SECRET"), await picture(0.2))).status).toBe(404);
  });
});

describe("one photo onto a unit", () => {
  test("it is stored with its hash on the unit; the same picture again is a duplicate; the 16th photo is refused", async () => {
    const l = await h.insertListing({ code: "HP-1" });
    const { agent, csrf } = await signIn(h, "manager");
    const first = await sendPhoto(agent, csrf, unitUrl("hp-1"), await picture(0.2));
    expect(first.body).toEqual({ ok: true });
    const [img] = await photosOf(l.id);
    expect(img.phash).toMatch(/^[01]{64}$/);
    expect(h.Storage.objects.size).toBe(1);

    // Resized and recompressed: still the same picture.
    const again = await sendPhoto(agent, csrf, unitUrl("HP-1"), await sharp(await picture(0.2)).resize(120).jpeg({ quality: 40 }).toBuffer());
    expect(again.body).toEqual({ dup: true });
    expect(await photosOf(l.id)).toHaveLength(1);
    expect(h.Storage.objects.size).toBe(1);

    for (let k = 1; k < 15; k++) expect((await sendPhoto(agent, csrf, unitUrl("HP-1"), await distinct(100 + k))).body.ok).toBe(true);
    expect((await sendPhoto(agent, csrf, unitUrl("HP-1"), await distinct(999))).body).toEqual({ full: true });
    expect(await photosOf(l.id)).toHaveLength(15);
    expect(h.Storage.objects.size).toBe(15);
  });

  test("a photo already on another active unit comes back flagged with that unit's code", async () => {
    const other = await h.insertListing({ code: "HP-OLD" });
    await h.insertListing({ code: "HP-NEW" });
    const { agent, csrf } = await signIn(h, "manager");
    await sendPhoto(agent, csrf, unitUrl("HP-OLD"), await picture(0.4));
    expect((await photosOf(other.id))).toHaveLength(1);
    const res = await sendPhoto(agent, csrf, unitUrl("HP-NEW"), await picture(0.4));
    expect(res.body).toEqual({ ok: true, same_as: "HP-OLD" });
  });

  test("unknown or other agencies' codes, brokers, a missing or unreadable photo and a missing token are refused", async () => {
    await h.insertListing({ code: "RIV-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
    const { agent, csrf } = await signIn(h, "manager");
    const jpg = await picture(0.3);
    expect((await sendPhoto(agent, csrf, unitUrl("NOPE-1"), jpg)).status).toBe(404);
    expect((await sendPhoto(agent, csrf, unitUrl("RIV-1"), jpg)).status).toBe(404);
    await h.insertListing({ code: "HP-1" });
    expect((await sendPhoto(agent, csrf, unitUrl("HP-1"), Buffer.from("not an image"))).status).toBe(422);
    expect((await agent.post(unitUrl("HP-1")).set("X-CSRF-Token", csrf)).status).toBe(400);
    expect((await agent.post(unitUrl("HP-1")).attach("photo", jpg, { filename: "p.jpg", contentType: "image/jpeg" })).status).toBe(403);
    const broker = await signIn(h, "broker");
    expect((await sendPhoto(broker.agent, broker.csrf, unitUrl("HP-1"), jpg)).status).toBe(403);
    expect(h.Storage.objects.size).toBe(0);
  });
});

describe("no codes: posts become a group import and the photos follow", () => {
  const posts = [
    { sender: "Ahmed", at: "24/10/2026 10:15", text: "فيلا في هايد بارك 300 متر 4 غرف السعر 25 مليون" },
    { sender: "Sara", at: "24/10/2026 10:20", text: "فيلا في ميفيدا 300 متر 4 غرف السعر 25 مليون تشطيب كامل" }
  ];

  test("photos are shown on the review, attached to the new unit with their hash; photos of posts that are not applied are deleted", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const start = await agent.post("/app/import/match/start").set("X-CSRF-Token", csrf).send({ filename: "chat.zip", posts });
    expect(start.status).toBe(200);
    expect(start.body.posts).toBe(2);
    const id = start.body.id;
    expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/0`, await picture(0.2))).body).toEqual({ ok: true });
    expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/0`, await picture(0.5))).body).toEqual({ ok: true });
    expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/1`, await picture(0.8))).body).toEqual({ ok: true });
    // The same picture in another post of the same run is flagged as a twin.
    expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/1`, await picture(0.2))).body).toEqual({ ok: true, twin: true });
    await Imports.waitForGroupImport(id);

    const page = (await agent.get(`/app/import/${id}`)).text;
    expect(page).toMatch(/data-post="0" data-state="ok"[\s\S]*data-photos="2"[\s\S]*data-post="1"[\s\S]*data-photos="2"/);
    expect(h.Storage.objects.size).toBe(4);

    await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=0");
    const [l] = await h.query("SELECT * FROM listings WHERE details->>'source' = 'group_import'");
    const imgs = await photosOf(l.id);
    expect(imgs).toHaveLength(2);
    expect(imgs.every((i) => /^[01]{64}$/.test(i.phash))).toBe(true);
    expect(h.Storage.objects.size).toBe(2);
  });

  test("the cap per post, other people's imports, unknown posts, bad bodies and the 40-post cap", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const id = (await agent.post("/app/import/match/start").set("X-CSRF-Token", csrf).send({ posts: [posts[0]] })).body.id;
    for (let k = 0; k < 15; k++) expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/0`, await distinct(200 + k))).body.ok).toBe(true);
    expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/0`, await distinct(998))).body).toEqual({ full: true });
    expect((await sendPhoto(agent, csrf, `/app/import/match/${id}/photo/5`, await picture(0.1))).status).toBe(404);
    expect(h.Storage.objects.size).toBe(15);
    await Imports.waitForGroupImport(id);

    const other = await signIn(h, "admin"); // a manager too, but not the one who started this import
    expect((await sendPhoto(other.agent, other.csrf, `/app/import/match/${id}/photo/0`, await picture(0.1))).status).toBe(404);
    const broker = await signIn(h, "broker");
    expect((await sendPhoto(broker.agent, broker.csrf, `/app/import/match/${id}/photo/0`, await picture(0.1))).status).toBe(403);
    expect((await agent.post("/app/import/match/start").set("X-CSRF-Token", csrf).send({ posts: [] })).status).toBe(422);
    expect((await agent.post("/app/import/match/start").set("X-CSRF-Token", csrf).send({ posts: [{ text: "x" }] })).status).toBe(422);
    const many = Array.from({ length: 60 }, (_, k) => ({ sender: "A", at: "", text: `فيلا رقم ${k} في هايد بارك 300 متر السعر 25 مليون` }));
    const big = await agent.post("/app/import/match/start").set("X-CSRF-Token", csrf).send({ posts: many });
    expect(big.body.posts).toBe(40);
    await Imports.waitForGroupImport(big.body.id);
  });
});

describe("the page, and what is gone", () => {
  test("the import page carries the matcher with scripts from this site only; the zip upload is gone", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const page = await agent.get("/app/import");
    expect(page.text).toMatch(/data-cp[\s>]/);
    expect(page.text).not.toMatch(/data-zip-upload/);
    expect(page.text).not.toMatch(/<script>(?!<\/script>)/);
    expect(page.headers["content-security-policy"]).toMatch(/connect-src 'self'(;|$)/);
    for (const name of ["zipread.js", "chatparse.js", "chatmatch.js", "chatphotos.js"]) {
      const src = page.text.match(new RegExp(`src="(/app/static/${name.replace(".", "\\.")}[^"]*)"`));
      expect(src).not.toBeNull();
      const js = await agent.get(src[1]);
      expect(js.status).toBe(200);
      expect(js.headers["content-type"]).toMatch(/javascript/);
    }
    expect((await agent.post("/app/import/zip").set("X-CSRF-Token", csrf).type("form").send({ path: "x" })).status).toBe(404);
    expect((await agent.post("/app/import/zip/start").set("X-CSRF-Token", csrf)).status).toBe(404);
  });

  test("a zip sent to the pasted-posts form is sent to the photos tab instead of being read on the server", async () => {
    const { agent, csrf } = await signIn(h, "manager");
    const res = await agent.post("/app/import/group").field("_csrf", csrf).attach("chat", Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]), { filename: "chat.zip", contentType: "application/zip" });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/data-import-error="zip"/);
  });
});
