// tests/web/project-gallery.test.js — F23: a project's photo gallery. AI sorts photos into shared, layout (matched to
// units by type and area, unsure ones wait for the manager) or hidden; shared photos and a unit's layouts show on its
// client page; with reading off photos are shared and sorted by hand.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const FakeAI = require("../harness/fake-ai");
const Share = require("../../lib/shareLinks");
const Catalogue = require("../../services/catalogue");
const PriceReading = require("../../services/priceReading");
const Gallery = require("../../services/projectGallery");
const G = require("../../domain/gallery");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const img = (name) => ({ buffer: Buffer.from(`\x89PNG ${name}`), mimetype: "image/png", originalname: `${name}.png` });

test("rules: classify and match", () => {
  expect(G.classify('{"kind":"layout","unit_type":"apartment","area":"151","bedrooms":3,"label":"Type A"}').result).toEqual({ kind: "layout", layout: { unit_type: "apartment", area: 151, bedrooms: 3, label: "Type A" } });
  expect(G.classify('{"kind":"weird"}').result).toEqual({ kind: "other", layout: {} });
  const units = [{ id: "a", property_type: "apartment", bedrooms: 3, area_value: 150 }, { id: "b", property_type: "apartment", bedrooms: 2, area_value: 150 }, { id: "c", property_type: "villa", area_value: 150 }];
  expect(G.matchUnits({ unit_type: "apartment", area: 152, bedrooms: 3 }, units)).toEqual({ status: "matched", ids: ["a"] });
  expect(G.matchUnits({ unit_type: "apartment", area: 200, bedrooms: 3 }, units).status).toBe("unsure");
  expect(G.matchUnits({ unit_type: "apartment", bedrooms: 3 }, units).status).toBe("unsure");
});

test("AI sorts the photos; layouts attach to units; unsure waits; the client page shows shared photos and the unit's layout", async () => {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya" })).project;
  const u1 = await h.insertListing({ code: "BD-1", project_id: project.id, area_value: 150, bedrooms: 3 });
  const u2 = await h.insertListing({ code: "BD-2", project_id: project.id, area_value: 220, bedrooms: 4 });
  await PriceReading.setForAgency(h.pool, admin.agency_id, { enabled: "on", pages_month: "20" });
  FakeAI.respond((call) => {
    expect(call.operation).toBe("gallery_read");
    const name = Buffer.from(call.contents[0].parts[1].inlineData.data, "base64").toString("latin1");
    if (name.includes("render")) return { kind: "render" };
    if (name.includes("typeA")) return { kind: "layout", unit_type: "apartment", area: 151, bedrooms: 3, label: "Type A" };
    if (name.includes("typeX")) return { kind: "layout", unit_type: "apartment", label: "Type X" };
    return { kind: "other" };
  });
  const r = await Gallery.upload(h.pool, admin, project.id, { files: [img("render"), img("typeA"), img("typeX"), img("logo")] });
  expect(r).toMatchObject({ ok: true, added: 4, shared: 1, layouts: 2, matched: 1, unsure: 1, hidden: 1, ai: true });
  const imgs = await h.query("SELECT * FROM project_images WHERE project_id = $1 ORDER BY position", [project.id]);
  expect(imgs.map((i) => [i.role, i.match_status])).toEqual([["shared", null], ["layout", "matched"], ["layout", "unsure"], ["hidden", null]]);
  expect(imgs[1].listing_ids).toEqual([u1.id]);

  // The manager attaches the unsure layout to BD-2 on the page.
  const { agent, csrf } = await signIn(h, "admin");
  const url = `/app/catalogue/projects/${project.id}`;
  const page = await agent.get(url);
  expect(page.text).toContain("data-gallery-unsure");
  expect((await agent.post(`${url}/gallery/${imgs[2].id}`).set("X-CSRF-Token", csrf).type("form").send(`role=layout&units_sent=1&unit=${u2.id}`)).status).toBe(303);
  expect((await h.query("SELECT match_status, listing_ids FROM project_images WHERE id = $1", [imgs[2].id]))[0]).toEqual({ match_status: "manual", listing_ids: [u2.id] });
  expect((await agent.get(url)).text).not.toContain("data-gallery-unsure");

  // Brokers see no hidden photo and can't change anything.
  const b = await signIn(h, "broker");
  const bp = await b.agent.get(url);
  expect(bp.text).not.toContain(imgs[3].url);
  expect(bp.text).not.toContain("data-gallery-upload");
  expect((await b.agent.post(`${url}/gallery/${imgs[0].id}/delete`).set("X-CSRF-Token", b.csrf).type("form").send("")).status).toBe(403);

  // Client page of BD-1: its layout and the shared render; never the hidden logo or BD-2's layout.
  const { token } = await Share.createShareLink(h.pool, await row("broker"), u1, { channel: "web", lang: "en" });
  const pub = await request(h.app.app).get(`/agency-alpha/BD-1?s=${token}`).set("User-Agent", BROWSER);
  expect(pub.text).toContain(imgs[0].url);
  expect(pub.text).toContain(imgs[1].url);
  expect(pub.text).not.toContain(imgs[2].url);
  expect(pub.text).not.toContain(imgs[3].url);

  // Delete removes the file.
  expect((await agent.post(`${url}/gallery/${imgs[3].id}/delete`).set("X-CSRF-Token", csrf).type("form").send("")).status).toBe(303);
  expect(await require("../harness/fake-supabase").downloadListingImage(imgs[3].url)).toBeNull();
});

test("reading off: photos are shared without AI; a PDF is refused", async () => {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Zed" })).project;
  expect(await Gallery.upload(h.pool, admin, project.id, { files: [img("a"), img("b")] })).toMatchObject({ added: 2, shared: 2, ai: false });
  expect(FakeAI.calls).toHaveLength(0);
  expect((await Gallery.upload(h.pool, admin, project.id, { files: [{ buffer: Buffer.from("%PDF"), mimetype: "application/pdf", originalname: "x.pdf" }] })).error).toBe("OFF");
});
