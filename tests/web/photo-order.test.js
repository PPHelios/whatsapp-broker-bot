// tests/web/photo-order.test.js — P3: a broker drags a unit's photos into their own order on the web edit form (the
// first is the cover), and AI curation then leaves that order alone; managers can switch AI photo ordering off for the
// agency (saves credits), and photos keep the order they were sent in.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const AI = require("../../lib/ai");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { ensureListingImagesCurated } = require("../../lib/vision");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  AI.reset();
  AI.respond(() => new Error("no AI expected"));
});
afterAll(closeHarness);

async function unitWithPhotos(n) {
  const l = await h.insertListing({ code: "PO-1", compound: "Hyde Park", property_type: "apartment", listing_type: "sale", bedrooms: 3, area_value: 150, price_value: 9e6 });
  for (let i = 0; i < n; i++) {
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url, role) VALUES ($1, $2, $3, $4, NULL)", [l.id, l.agency_id, i, `https://img.test/${i}.jpg`]);
  }
  return l;
}
const urls = async (l) => (await h.query("SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position", [l.id])).map((r) => r.url.replace("https://img.test/", ""));
const ids = async (l) => (await h.query("SELECT id FROM listing_images WHERE listing_id = $1 ORDER BY position", [l.id])).map((r) => r.id);

function post(agent, url, csrf, fields) {
  let r = agent.post(url).field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) r = r.field(k, String(one));
  return r;
}
const FIELDS = { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", price_value: "9 مليون", area_value: "150", bedrooms: "3" };

test("the edit form saves the dragged order; AI curation then leaves it alone", async () => {
  const l = await unitWithPhotos(3);
  const [a, b, c] = await ids(l);
  const { agent, csrf } = await signIn(h, "admin");
  const page = await agent.get("/app/units/PO-1/edit");
  expect(page.text).toContain("data-sortable");
  const version = page.text.match(/name="version" value="(\d+)"/)[1];

  // Saving without moving anything keeps the order and leaves AI ordering on.
  expect((await post(agent, "/app/units/PO-1/edit", csrf, { ...FIELDS, version, photo_order: [a, b, c] })).status).toBe(303);
  expect((await h.query("SELECT details FROM listings WHERE id = $1", [l.id]))[0].details.photo_order).toBeUndefined();

  const v2 = (await agent.get("/app/units/PO-1/edit")).text.match(/name="version" value="(\d+)"/)[1];
  expect((await post(agent, "/app/units/PO-1/edit", csrf, { ...FIELDS, version: v2, photo_order: [c, a, b], remove_photo: b })).status).toBe(303);
  expect(await urls(l)).toEqual(["2.jpg", "0.jpg"]);
  const row = (await h.query("SELECT hero_position, details FROM listings WHERE id = $1", [l.id]))[0];
  expect(row).toMatchObject({ hero_position: 0, details: expect.objectContaining({ photo_order: "manual" }) });

  // Curation (flyer time) makes no AI call and keeps the order.
  const out = await ensureListingImagesCurated(l.id, { pool: h.pool });
  expect(out.map((i) => i.url)).toEqual(["https://img.test/2.jpg", "https://img.test/0.jpg"]);
  expect(AI.calls.filter((x) => x.operation === "vision_curation")).toHaveLength(0);
});

test("managers switch AI photo ordering off on My usage; curation is skipped", async () => {
  const l = await unitWithPhotos(2);
  const { agent, csrf } = await signIn(h, "admin");
  expect((await agent.get("/app/usage")).text).toMatch(/data-ai-photo-order/);
  const r = await agent.post("/app/usage/agency").type("form").send({ _csrf: csrf, monthly: "1000", code_prefix: "AA" });
  expect(r.status).toBe(303);
  expect((await h.query("SELECT crm_settings FROM agencies WHERE id = $1", [l.agency_id]))[0].crm_settings.ai_photo_order).toBe(false);
  expect((await agent.get("/app/usage")).text).not.toMatch(/name="ai_photo_order" value="on" checked/);
  const out = await ensureListingImagesCurated(l.id, { pool: h.pool });
  expect(out.map((i) => i.url)).toEqual(["https://img.test/0.jpg", "https://img.test/1.jpg"]);
  expect(AI.calls.filter((x) => x.operation === "vision_curation")).toHaveLength(0);
  await agent.post("/app/usage/agency").type("form").send({ _csrf: csrf, monthly: "1000", ai_photo_order: "on" });
  expect((await h.query("SELECT crm_settings FROM agencies WHERE id = $1", [l.agency_id]))[0].crm_settings.ai_photo_order).toBe(true);
});

test("add form: ticking 'I ordered them myself' stores the photos as a manual order that AI curation skips", async () => {
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } }).png().toBuffer();
  const { agent, csrf } = await signIn(h, "admin");
  const page = await agent.get("/app/units/new?lang=en");
  expect(page.text).toContain("saves AI credits");
  let r = agent.post("/app/units/new").field("_csrf", csrf).field("force", "1").field("photo_manual", "on");
  for (const [k, v] of Object.entries(FIELDS)) r = r.field(k, v);
  r = r.attach("photos", png, { filename: "a.png", contentType: "image/png" }).attach("photos", png, { filename: "b.png", contentType: "image/png" });
  const res = await r;
  expect(res.status).toBe(303);
  const code = decodeURIComponent(res.headers.location.match(/units\/([^?]+)/)[1]);
  const [unit] = await h.query("SELECT id, details FROM listings WHERE code = $1", [code]);
  expect(unit.details.photo_order).toBe("manual");
  const out = await ensureListingImagesCurated(unit.id, { pool: h.pool });
  expect(out).toHaveLength(2);
  expect(AI.calls.filter((x) => x.operation === "vision_curation")).toHaveLength(0);
});
