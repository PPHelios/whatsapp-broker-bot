// tests/web/duplicates-catalogue.test.js — Release A C3: catalogue units are never broker duplicates, a broker
// listing that looks like a catalogue unit or model gets a soft note, and resale units link to a project
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const Store = require("../../lib/listingStore");
const Dup = require("../../domain/unitDuplicate");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code_norm = upper($1)", [code]))[0];

const FULL = {
  listing_type: "sale",
  market: "resale",
  property_type: "apartment",
  compound: "Hyde Park",
  price_value: "8.5 مليون",
  area_value: "150",
  bedrooms: "3",
  bathrooms: "2",
  finishing: "fully_finished",
  down_payment_value: "8.5 مليون",
  delivery_year: "2027"
};

const form = (agent, url, csrf, fields) => agent.post(url).type("form").send({ _csrf: csrf, ...fields });

function post(agent, url, csrf, fields = {}) {
  let r = agent.post(url).set("X-CSRF-Token", csrf);
  for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) r = r.field(k, String(one));
  return r;
}

async function seedCatalogue() {
  const admin = await row("admin");
  const p = await Catalogue.saveProject(h.pool, admin, { name: "Hyde Park", delivery_year: "2028", delivery_quarter: "2" });
  expect(p.ok).toBe(true);
  const cat = { broker_id: null, market: "primary", details: { catalogue: true }, project_id: p.project.id };
  await h.insertListing({ ...cat, code: "CAT-U1", inventory_type: "primary_unit", developer_unit_code: "B12-04", area_value: 151, price_value: 8.45e6 });
  await h.insertListing({ ...cat, code: "CAT-M1", inventory_type: "developer_model", area_value: 180, price_value: 10e6, details: { catalogue: true, area_to: 220, price_from: true } });
  return { admin, project: p.project };
}

describe("matching rules", () => {
  test("a unit matches within 5% on area and price; a model by its area range and from price", () => {
    const mine = { compound: "Hyde Park", property_type: "apartment", bedrooms: 3, area_value: 150, price_value: 8.5e6, listing_type: "sale" };
    expect(Dup.catalogueMatch(mine, { compound: "hyde park", property_type: "apartment", bedrooms: 3, area_value: 152, price_value: 8.6e6 })).toBe(true);
    expect(Dup.catalogueMatch(mine, { compound: "Hyde Park", property_type: "apartment", bedrooms: 3, area_value: 170, price_value: 8.5e6 })).toBe(false);
    expect(Dup.catalogueMatch(mine, { compound: "Mivida", property_type: "apartment", bedrooms: 3, area_value: 150, price_value: 8.5e6 })).toBe(false);
    const model = { compound: "Hyde Park", property_type: "apartment", bedrooms: null, inventory_type: "developer_model", area_value: 140, price_value: 7e6, details: { area_to: 160 } };
    expect(Dup.catalogueMatch(mine, model)).toBe(true);
    expect(Dup.catalogueMatch(mine, { ...model, price_value: 6e6 })).toBe(false); // 8.5M is over 1.3 × 6M
    expect(Dup.catalogueMatch({ ...mine, area_value: 200 }, model)).toBe(false);
  });

  test("catalogue units are not broker duplicates; a broker listing that looks like one gets the catalogue unit", async () => {
    await seedCatalogue();
    const l = { compound: "Hyde Park", property_type: "apartment", bedrooms: 3, area_value: 150, price_value: 8.5e6, listing_type: "sale", details: {} };
    expect(await Store.findDuplicate(h.pool, h.BROKERS.broker.agency_id, l)).toBeNull();
    expect(await Store.findCatalogueMatch(h.pool, h.BROKERS.broker.agency_id, l)).toEqual({ code: "CAT-U1", dev_code: "B12-04", model: false, project: "Hyde Park" });
    const big = { ...l, area_value: 200, price_value: 11e6 };
    expect(await Store.findCatalogueMatch(h.pool, h.BROKERS.broker.agency_id, big)).toMatchObject({ code: "CAT-M1", model: true });
    expect(await Store.findCatalogueMatch(h.pool, h.BROKERS.broker.agency_id, { ...l, details: { catalogue: true } })).toBeNull();
  });
});

describe("web review", () => {
  test("the review shows a soft catalogue note (not the duplicate warning) and saving is not blocked", async () => {
    await seedCatalogue();
    const { agent, csrf } = await signIn(h, "broker");
    const review = await post(agent, "/app/units/review", csrf, FULL);
    expect(review.text).toMatch(/data-catalogue-match="CAT-U1"/);
    expect(review.text).toMatch(/B12-04/);
    expect(review.text).not.toMatch(/data-duplicate=/);
    expect(review.text).toMatch(/data-review="ok"/);
  });
});

describe("resale link to a project", () => {
  test("the owner links a resale unit; its own terms stay when the project's plans change; the page shows the delivery", async () => {
    const { admin, project } = await seedCatalogue();
    await h.insertListing({ code: "BD-7", payment_terms: { plans: [{ name: "Resale rest", down_payment_pct: 50, years: 3 }] } });
    const { agent, csrf } = await signIn(h, "broker");
    const page = await agent.get("/app/units/BD-7");
    expect(page.text).toMatch(/id="resale-project"/);
    const r = await form(agent, "/app/units/BD-7/project", csrf, { project_id: project.id });
    expect(r.status).toBe(303);
    expect((await unit("BD-7")).project_id).toBe(project.id);

    await Catalogue.savePlan(h.pool, admin, project.id, { name: "10% / 8y", down_payment_pct: "10", years: "8" });
    const terms = (await unit("BD-7")).payment_terms;
    expect(terms.plans_own).toBe(true);
    expect(terms.plans.map((p) => p.name)).toEqual(["Resale rest"]);

    // A developer increase moves the catalogue units only; the resale contract keeps its price.
    const PriceSheets = require("../../services/priceSheets");
    await PriceSheets.scheduleIncrease(h.pool, admin, project.id, { pct: "10", effectiveOn: "2026-01-01" });
    expect(Number((await unit("BD-7")).price_value)).toBe(8500000);
    expect(Number((await unit("CAT-U1")).price_value)).toBe(9295000);

    const shown = await agent.get("/app/units/BD-7");
    expect(shown.text).not.toMatch(/data-prices-fresh/);
    expect(shown.text).toMatch(/data-project-delivery/);
    expect(shown.text).toMatch(/Q2 2028/);

    // Clearing the link; nobody else may link it; catalogue units are linked on the project page only.
    await form(agent, "/app/units/BD-7/project", csrf, { project_id: "" });
    expect((await unit("BD-7")).project_id).toBeNull();
    const other = await signIn(h, "colleague");
    expect((await form(other.agent, "/app/units/BD-7/project", other.csrf, { project_id: project.id })).status).toBe(403);
    expect(await Catalogue.linkResale(h.pool, admin, await unit("CAT-U1"), project.id)).toEqual({ error: "catalogue_unit" });
  });
});
