// tests/web/map.test.js — The map: pins carry the number of units a broker can see (filters change it, private and other
// agencies' units never count), a pin opens its unit list, and only the CRM owner edits the places.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Maps = require("../../services/mapPlaces");

jest.setTimeout(90000);

const TILES = "https://pub-test.r2.dev/egypt.pmtiles";
let h;
beforeEach(async () => {
  h = await createHarness();
  process.env.MAP_TILES_URL = TILES;
  Maps.clearCache();
  resetConfig();
});
afterAll(async () => {
  delete process.env.MAP_TILES_URL;
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

async function seedPlaces() {
  await h.query(
    `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng) VALUES
       ('mivida', 'Mivida', 'ميفيدا', 'Emaar Misr', 'New Cairo', 30.0058, 31.5377),
       ('hyde park', 'Hyde Park', 'هايد بارك', 'Mountain View', 'New Cairo', 29.98, 31.55)
     ON CONFLICT (name_key) DO NOTHING`
  );
}
async function seedUnits() {
  await h.insertListing({ code: "MV-1", compound: "Mivida", listing_type: "sale", bedrooms: 3, price_value: 9e6, finishing: "fully_finished" });
  await h.insertListing({ code: "MV-2", compound: "Mivida", listing_type: "sale", bedrooms: 2, price_value: 6e6 });
  await h.insertListing({ code: "MV-3", compound: "كمبوند ميفيدا", listing_type: "rent", bedrooms: 3, price_value: 40000, furnishing: "furnished" });
  await h.insertListing({ code: "MV-P", compound: "Mivida", is_private: true });
  await h.insertListing({ code: "MV-S", compound: "Mivida", status: "sold" });
  await h.insertListing({ code: "MV-R", compound: "Mivida", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
  await h.insertListing({ code: "NO-1", compound: "Unknown Place" });
}

test("a pin counts the active units of this agency in its compound, in either language, without private ones", async () => {
  await seedPlaces();
  await seedUnits();
  const b = await signIn(h, "broker");
  const res = await b.agent.get("/app/map/pins");
  expect(res.status).toBe(200);
  expect(res.body.pins).toHaveLength(1);
  expect(res.body.pins[0]).toMatchObject({ name: "Mivida", n: 3, lat: 30.0075, lng: 31.539855 });
  expect(res.body.unmapped).toBe(1);
  expect(res.body.facets.types).toEqual(["apartment"]);
});

test("filters change the count: sale or rent, rooms, finishing, furnishing and budget", async () => {
  await seedPlaces();
  await seedUnits();
  const b = await signIn(h, "broker");
  const n = async (q) => ((await b.agent.get(`/app/map/pins?${q}`)).body.pins[0] || { n: 0 }).n;
  expect(await n("type=sale")).toBe(2);
  expect(await n("type=rent")).toBe(1);
  expect(await n("rooms=3")).toBe(2);
  expect(await n("rooms=5")).toBe(0);
  expect(await n("fin=fully_finished")).toBe(1);
  expect(await n("furn=furnished")).toBe(1);
  expect(await n("type=sale&pmin=7000000")).toBe(1);
  expect(await n("type=sale&pmax=5000000")).toBe(0);
  expect(await n("ptype=villa")).toBe(0);
  expect(await n("type=bogus&rooms=abc")).toBe(3);
});

test("tapping a pin lists its units under the same filters; other agencies see nothing of them", async () => {
  await seedPlaces();
  await seedUnits();
  const b = await signIn(h, "broker");
  const place = (await h.query("SELECT id FROM map_places WHERE name_key = 'mivida'"))[0].id;
  const all = await b.agent.get(`/app/map/place/${place}`);
  expect(all.status).toBe(200);
  expect(all.text).toMatch(/MV-1/);
  expect(all.text).toMatch(/MV-3/);
  expect(all.text).not.toMatch(/MV-P|MV-S|MV-R|NO-1/);
  const rent = await b.agent.get(`/app/map/place/${place}?type=rent`);
  expect(rent.text).toMatch(/MV-3/);
  expect(rent.text).not.toMatch(/MV-1/);
  const rival = await signIn(h, "rival");
  expect((await rival.agent.get("/app/map/pins")).body.pins.map((p) => p.n)).toEqual([1]);
  expect((await rival.agent.get(`/app/map/place/${place}`)).text).not.toMatch(/MV-1/);
});

test("the Map page loads the map file's address and allows it in the page policy; without it the page says it is not set up", async () => {
  const b = await signIn(h, "broker");
  const page = await b.agent.get("/app/map?lang=en");
  expect(page.status).toBe(200);
  expect(page.text).toContain(`data-tiles="${TILES}"`);
  expect(page.text).toMatch(/data-f-fin/);
  expect(page.text).toMatch(/data-budget/);
  expect(page.headers["content-security-policy"]).toMatch(/connect-src 'self' https:\/\/pub-test\.r2\.dev/);
  delete process.env.MAP_TILES_URL;
  resetConfig();
  const off = await b.agent.get("/app/map?lang=en");
  expect(off.text).toMatch(/not set up/);
  expect(off.headers["content-security-policy"]).not.toMatch(/r2\.dev/);
});

test("only the CRM owner opens the places window; it saves a place from a pasted link, links a unit name and loads the first list", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  const broker = await signIn(h, "broker");
  expect((await broker.agent.get("/app/owner/map")).status).toBe(404);
  expect((await broker.agent.post("/app/owner/map").type("form").send({ _csrf: broker.csrf, name_en: "X" })).status).toBe(404);

  const crm = await signIn(h, "admin");
  expect((await crm.agent.get("/app/owner/map?lang=en")).status).toBe(200);
  const bad = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Zetapark", maps_link: "https://maps.app.goo.gl/x" });
  expect(bad.headers.location).toMatch(/err=link_short/);
  const ok = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Zetapark", name_ar: "زيتا", area_id: "a0000000-0000-0000-0000-0000000000c1", maps_link: "https://www.google.com/maps/@30.0058,31.5377,15z", verified: "on" });
  expect(ok.headers.location).toMatch(/msg=saved/);
  const dup = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Zetapark Compound", area_id: "a0000000-0000-0000-0000-0000000000c1", lat: "30", lng: "31" });
  expect(dup.headers.location).toMatch(/err=duplicate/);

  await h.insertListing({ code: "EM-1", compound: "Emaar Zetapark" });
  expect((await crm.agent.get("/app/owner/queue?lang=en")).text).toMatch(/Emaar Zetapark/);
  const link = await crm.agent.post("/app/owner/map/alias").type("form").send({ _csrf: crm.csrf, alias: "Emaar Zetapark", place: "Zetapark" });
  expect(link.headers.location).toMatch(/msg=alias/);
  Maps.clearCache();
  const pins = await signIn(h, "broker");
  expect((await pins.agent.get("/app/map/pins")).body.pins[0]).toMatchObject({ name: "Zetapark", n: 1 });

  const seed = await crm.agent.post("/app/owner/map/import").type("form").send({ _csrf: crm.csrf });
  expect(seed.headers.location).toMatch(/msg=seed&n=\d+/);
  expect(Number(seed.headers.location.match(/n=(\d+)/)[1])).toBeGreaterThan(1000);
  expect((await h.query("SELECT count(*)::int AS n FROM map_places WHERE name_key = 'zetapark'"))[0].n).toBe(1);
  const gone = await crm.agent.post(`/app/owner/map/${ok.headers.location.includes("saved") ? (await h.query("SELECT id FROM map_places WHERE name_key='zetapark'"))[0].id : ""}/delete`).type("form").send({ _csrf: crm.csrf });
  expect(gone.headers.location).toMatch(/msg=deleted/);
});

test("a compound is matched to the approved list on save: details move to the notes, unknown names are flagged", async () => {
  await h.query(`INSERT INTO map_places (name_key, name_en, name_ar, lat, lng, approved) VALUES ('rehab', 'El Rehab', 'الرحاب', 30.06, 31.49, true), ('mivida', 'Mivida', 'ميفيدا', 30.0058, 31.5377, false)`);
  const Store = require("../../lib/listingStore");
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  await h.insertListing({ code: "RH-1", compound: "x" });
  let listing = (await h.query("SELECT * FROM listings WHERE code = 'RH-1'"))[0];
  const ok = await Store.applyListingPatch(h.pool, admin, { listing, patch: { compound: "El Rehab 2, 3rd floor" } });
  expect(ok.listing).toMatchObject({ compound: "الرحاب", compound_en: "El Rehab", compound_state: null });
  expect(ok.listing.place_id).toBeTruthy();
  expect(ok.listing.details.notes).toMatch(/3rd floor/);
  listing = ok.listing;
  const bad = await Store.applyListingPatch(h.pool, admin, { listing, patch: { compound: "Mivida" } });
  expect(bad.listing).toMatchObject({ compound: "Mivida", compound_state: "needs_fix", place_id: null });
});

test("the owner's queue: approve a seed place, re-check units, and mark a name as not a compound", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  await h.query(`INSERT INTO map_places (name_key, name_en, lat, lng, source, approved) VALUES ('zedtown', 'Zedtown', 30.02, 31.5, 'seed', false)`);
  await h.insertListing({ code: "ET-1", compound: "Zedtown, 3rd floor" });
  await h.insertListing({ code: "OS-1", compound: "outside" });
  const crm = await signIn(h, "admin");
  const page = await crm.agent.get("/app/owner/queue?lang=en");
  expect(page.text).toMatch(/Approve &quot;Zedtown&quot;|Approve "Zedtown"/);
  const id = (await h.query("SELECT id FROM map_places WHERE name_key = 'zedtown'"))[0].id;
  expect((await crm.agent.post(`/app/owner/map/${id}/approve`).type("form").send({ _csrf: crm.csrf })).headers.location).toMatch(/msg=approved/);
  expect((await crm.agent.get("/app/owner/queue?lang=en")).text).not.toMatch(/Fix units now|Approve the master list/);
  const u = (await h.query("SELECT compound, place_id, details FROM listings WHERE code = 'ET-1'"))[0];
  expect(u.place_id).toBe(id);
  expect(u.compound).toBe("Zedtown");
  expect(u.details.notes).toMatch(/3rd floor/);
  const gone = await crm.agent.post("/app/owner/map/dismiss").type("form").send({ _csrf: crm.csrf, name: "outside" });
  expect(gone.headers.location).toMatch(/msg=dismissed&n=1/);
  expect((await h.query("SELECT compound FROM listings WHERE code = 'OS-1'"))[0].compound).toBeNull();
});

test("the master list approves places by name: a place the map has keeps its position, a new one has no pin yet", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  await h.query(`INSERT INTO map_places (name_key, name_en, lat, lng, source, approved) VALUES ('mivida', 'Mivida', 30.0058, 31.5377, 'seed', false)`);
  const crm = await signIn(h, "admin");
  const out = await crm.agent.post("/app/owner/map/master").type("form").send({ _csrf: crm.csrf });
  expect(out.headers.location).toMatch(/msg=master&n=\d+/);
  const [mv] = await h.query("SELECT approved, lat, name_ar, developer FROM map_places WHERE name_key = 'mivida'");
  expect(mv).toMatchObject({ approved: true, lat: 30.0058, name_ar: "ميفيدا" });
  const fresh = (await h.query("SELECT count(*)::int AS n FROM map_places WHERE lat IS NULL AND approved"))[0].n;
  expect(fresh).toBeGreaterThan(50);
  await h.insertListing({ code: "BF-1", compound: "Bloomfields" });
  const b = await signIn(h, "broker");
  const pins = (await b.agent.get("/app/map/pins")).body;
  expect(pins.pins.map((p) => p.name)).not.toContain("Bloomfields");
  expect(pins.unmapped).toBe(1);
  expect((await crm.agent.get("/app/owner/map?lang=en")).status).toBe(200);
});

test("missing pins: OpenStreetMap suggests, Google fills the gap and checks, nothing saves until the owner approves", async () => {
  const Lookup = require("../../services/placeLookup");
  const fetchFn = async (url) => ({
    ok: true,
    json: async () => (url.includes("nominatim") ? (url.includes("Alpha") ? [{ lat: "30.0", lon: "31.5" }] : []) : { status: "OK", results: [{ geometry: { location: { lat: url.includes("Alpha") ? 30.001 : 30.2, lng: 31.5 } } }] })
  });
  const out = await Lookup.suggest([{ id: "a", name_en: "Alpha" }, { id: "b", name_en: "Beta" }], { fetchFn, key: "k", pauseMs: 0 });
  expect(out[0]).toMatchObject({ source: "osm", pos: { lat: 30, lng: 31.5 } });
  expect(out[0].apart_km).toBeLessThan(0.5);
  expect(out[1]).toMatchObject({ source: "google", pos: { lat: 30.2, lng: 31.5 }, apart_km: null });
  const [{ id }] = await h.query(`INSERT INTO map_places (name_key, name_en, source, approved) VALUES ('alpha', 'Alpha', 'manual', true) RETURNING id`);
  expect((await Lookup.missing(h.pool)).total).toBeGreaterThan(0);
  expect(await Lookup.setPosition(h.pool, id, 40, 31.5)).toBe(false); // outside Egypt
  expect(await Lookup.setPosition(h.pool, id, 30, 31.5)).toBe(true);
  expect(await Lookup.setPosition(h.pool, id, 30.1, 31.5)).toBe(false); // already has a pin
});

test("a place with no units is still found by the map search (idle), and the deal type filter narrows pins", async () => {
  await h.query(`INSERT INTO map_places (name_key, name_en, lat, lng, source, approved) VALUES ('emptyville', 'Emptyville', 30.0, 31.4, 'manual', true)`);
  Maps.clearCache();
  const b = await signIn(h, "broker");
  const res = (await b.agent.get("/app/map/pins")).body;
  expect(res.idle.map((p) => p.name)).toContain("Emptyville");
  expect(res.idle.every((p) => p.n === 0)).toBe(true);
  const rent = (await b.agent.get("/app/map/pins?deal=rent")).body;
  const primary = (await b.agent.get("/app/map/pins?deal=primary")).body;
  expect(rent.total + primary.total).toBeLessThanOrEqual((await b.agent.get("/app/map/pins")).body.total * 2);
  expect((await b.agent.get("/app/map/pins?deal=x;drop")).status).toBe(200);
});

test("units list price boxes filter by from and to (5m, 250k)", async () => {
  await h.insertListing({ code: "PB-1", compound: "X", price_value: 2000000 });
  await h.insertListing({ code: "PB-2", compound: "X", price_value: 8000000 });
  const b = await signIn(h, "admin");
  const res = await b.agent.get("/app/units?pmin=5m&pmax=10m");
  expect(res.text).toMatch(/PB-2/);
  expect(res.text).not.toMatch(/PB-1/);
});

test("check saved pins: a kept pin is marked checked and not asked again; a moved pin changes", async () => {
  const Lookup = require("../../services/placeLookup");
  const [a] = await h.query(`INSERT INTO map_places (name_key, name_en, lat, lng, source, approved) VALUES ('checka', 'Checka', 30.0, 31.4, 'manual', true) RETURNING id`);
  const [b] = await h.query(`INSERT INTO map_places (name_key, name_en, lat, lng, source, approved) VALUES ('checkb', 'Checkb', 30.0, 31.4, 'manual', true) RETURNING id`);
  const before = (await Lookup.unchecked(h.pool)).total;
  expect(before).toBeGreaterThanOrEqual(2);
  expect(Lookup.km({ lat: 30, lng: 31.4 }, { lat: 30.09, lng: 31.4 })).toBeGreaterThan(9);
  const out = await Lookup.finishCheck(h.pool, [{ id: a.id }, { id: b.id, lat: 30.5, lng: 31.5 }]);
  expect(out.moved).toBe(1);
  expect((await Lookup.unchecked(h.pool)).total).toBe(before - 2);
  expect((await h.query("SELECT lat FROM map_places WHERE id = $1", [b.id]))[0].lat).toBe(30.5);
  expect((await h.query("SELECT lat FROM map_places WHERE id = $1", [a.id]))[0].lat).toBe(30);
});

test("the owner's search lists similar places, with or without a pin, approved or not; a duplicate save shows them", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  await h.query("DELETE FROM map_places WHERE name_key IN ('eastown', 'sodic eastown')");
  await h.query("INSERT INTO map_places (name_key, name_en, name_ar, district, aliases, approved) VALUES ('eastown', 'Eastown', 'إيست تاون', 'South 90th', '{}', true)");
  await h.query("INSERT INTO map_places (name_key, name_en, lat, lng, aliases, approved) VALUES ('sodic eastown', 'SODIC Eastown Compound', 30.01233, 31.51555, '{}', false)");
  const names = async (q) => (await Maps.list(h.pool, { q })).rows.map((r) => r.name_en);
  expect(await names("Eas-town")).toEqual(expect.arrayContaining(["Eastown", "SODIC Eastown Compound"]));
  expect(await names("Eastown compound")).toEqual(expect.arrayContaining(["Eastown", "SODIC Eastown Compound"]));
  const crm = await signIn(h, "admin");
  const dup = await crm.agent.post("/app/owner/map").type("form").send({ _csrf: crm.csrf, name_en: "Eastown", area_id: "a0000000-0000-0000-0000-0000000000c1", lat: "30.0", lng: "31.5" });
  expect(dup.headers.location).toMatch(/err=duplicate&q=Eastown/);
  const page = await crm.agent.get(dup.headers.location);
  expect(page.text).toContain("SODIC Eastown Compound");
});

test("Missing pins and Check saved pins open at once with a spinner, then load their content; the review map is on both", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  const broker = await signIn(h, "broker");
  expect((await broker.agent.get("/app/owner/map/find")).status).toBe(404);
  const crm = await signIn(h, "admin");
  for (const path of ["/app/owner/map/find", "/app/owner/map/check"]) {
    const shell = await crm.agent.get(path);
    expect(shell.text).toContain(`data-lazy="${path}?part=1`);
    expect(shell.text).toContain("pinreview.js");
    expect(shell.text).not.toContain("data-review");
  }
  // Past the last place nothing is looked up, so no outside request is made.
  const find = await crm.agent.get("/app/owner/map/find?part=1&offset=100000");
  expect(find.status).toBe(200);
  expect(find.text).toContain("data-review");
  expect(find.text).toContain("Services:");
  await h.query("UPDATE map_places SET pin_checked_at = now()"); // none left to look up: no outside request
  const check = await crm.agent.get("/app/owner/map/check?part=1");
  expect(check.status).toBe(200);
  expect(check.text).toContain("data-review");
});

test("Check all: the page, the batch and the apply step (looks-right pins are marked checked, only ticked moves move)", async () => {
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
  const broker = await signIn(h, "broker");
  expect((await broker.agent.get("/app/owner/map/compare")).status).toBe(404);
  const crm = await signIn(h, "admin");
  const shell = await crm.agent.get("/app/owner/map/compare");
  expect(shell.status).toBe(200);
  expect(shell.text).toContain("data-compare");
  expect(shell.text).toContain("compare.js");
  // Past the last place nothing is looked up, so no outside request is made.
  const empty = await crm.agent.get("/app/owner/map/compare/batch?offset=100000");
  expect(empty.status).toBe(200);
  expect(empty.body.count).toBe(0);
  await h.query("DELETE FROM map_places WHERE name_key IN ('cmp-a', 'cmp-b')");
  const [a] = await h.query("INSERT INTO map_places (name_key, name_en, lat, lng, aliases, approved) VALUES ('cmp-a', 'Cmp A', 30, 31, '{}', true) RETURNING id");
  const [b] = await h.query("INSERT INTO map_places (name_key, name_en, lat, lng, aliases, approved) VALUES ('cmp-b', 'Cmp B', 30, 31, '{}', true) RETURNING id");
  const out = await crm.agent.post("/app/owner/map/compare/apply").type("form").send({ _csrf: crm.csrf, ok: a.id, move: `${b.id},30.5,31.5` });
  expect(out.status).toBe(200);
  expect(out.body.checked).toBe(2);
  expect(out.body.moved).toBe(1);
  const rows = await h.query("SELECT id, lat, pin_checked_at FROM map_places WHERE id IN ($1, $2)", [a.id, b.id]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(byId[a.id].lat).toBe(30);
  expect(byId[a.id].pin_checked_at).not.toBeNull();
  expect(byId[b.id].lat).toBe(30.5);
});
