// tests/web/price-sheets.test.js — Release A C2: price-sheet preview and apply, models, price history, increases,
// freshness and the 30-day reminder
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const PriceSheets = require("../../services/priceSheets");
const Sheet = require("../../domain/priceSheet");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const withOwner = (lines) => lines.map((l, i) => (i === 0 ? `${l},Owner Phone` : `${l},01012345678`));
const csv = (lines) => Buffer.from(withOwner(lines).join("\n"), "utf8");

async function seed() {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya", delivery_year: "2028", maintenance_pct: "8" })).project;
  const phase = (await Catalogue.savePhase(h.pool, admin, project.id, { name: "B12", delivery_year: "2029", delivery_quarter: "3" })).phase;
  await Catalogue.savePlan(h.pool, admin, project.id, { name: "10% / 8y", down_payment_pct: "10", years: "8" });
  return { admin, project, phase };
}

const SHEET_1 = [
  "Unit Code,Building,Type,Floor,Area,Bedrooms,Price,Status",
  "B12-304,B12,Apartment,3,165,3,9200000,Available",
  "B12-404,B12,Apartment,4,165,3,9300000,Available",
  "B12-404,B12,Apartment,4,165,3,9300000,Available",
  ",,Villa,,250-280,4,from 18.5M,",
  "B12-504,B12,Spaceship,5,165,3,9.4M,Available",
  "B12-604,B12,Apartment,6,165,3,,Available"
];

describe("the sheet", () => {
  test("rows: exact units by developer code, models as 'from' rows with an area range; Arabic headers work", () => {
    expect(Sheet.columnFor("كود الوحدة")).toBe("dev_code");
    expect(Sheet.columnFor("المساحة (م²)")).toBe("area");
    expect(Sheet.columnFor("Price (EGP)")).toBe("price");
    expect(Sheet.rowToEntry({ dev_code: "b12-304", property_type: "شقة", area: "165", price: "9,200,000" })).toMatchObject({ kind: "unit", dev_code: "B12-304", price: 9200000, price_from: false });
    expect(Sheet.rowToEntry({ property_type: "Villa", area: "250 - 280", price: "يبدأ من 18.5 مليون" })).toMatchObject({ kind: "model", area: 250, area_to: 280, price: 18500000, price_from: true });
    expect(Sheet.rowToEntry({ dev_code: "X", price: "abc" })).toEqual({ error: "price" });
    expect(Sheet.rowToEntry({ dev_code: "X", price: "1M", status: "مباع" })).toMatchObject({ sold: true });
  });

  test("preview → apply: new units and a model join the project (phase by building), get its plans and a price history; nothing is saved before apply", async () => {
    const { admin, project, phase } = await seed();
    const up = await PriceSheets.upload(h.pool, admin, project.id, csv(SHEET_1), { fileName: "badya.csv" });
    expect(up.ok).toBe(true);
    expect(up.sheet.summary).toMatchObject({ new: 3, repeated: 1, invalid: 2, changed: 0 });
    expect((await h.query("SELECT count(*)::int AS n FROM listings WHERE project_id = $1", [project.id]))[0].n).toBe(0);

    const r = await PriceSheets.apply(h.pool, admin, project.id, up.sheet.id);
    expect(r).toMatchObject({ ok: true, created: 3, updated: 0 });
    const units = await h.query("SELECT * FROM listings WHERE project_id = $1 ORDER BY developer_unit_code NULLS LAST", [project.id]);
    expect(units.map((u) => [u.developer_unit_code, u.inventory_type, Number(u.price_value)])).toEqual([
      ["B12-304", "primary_unit", 9200000],
      ["B12-404", "primary_unit", 9300000],
      [null, "developer_model", 18500000]
    ]);
    expect(units[0]).toMatchObject({ broker_id: null, market: "primary", compound: "Badya", phase_id: phase.id, delivery_year: 2029, delivery_quarter: 3 });
    expect(units[2].details).toMatchObject({ area_to: 280, price_from: true });
    expect(units[0].payment_terms.plans.map((p) => p.name)).toEqual(["10% / 8y"]);
    expect((await h.query("SELECT count(*)::int AS n FROM listing_prices WHERE listing_id = $1", [units[0].id]))[0].n).toBe(1);
    expect((await h.query("SELECT prices_updated_at FROM projects WHERE id = $1", [project.id]))[0].prices_updated_at).not.toBeNull();
    // A second apply of the same sheet does nothing.
    expect((await PriceSheets.apply(h.pool, admin, project.id, up.sheet.id)).error).toBe("stale");
  });

  test("the next sheet: price changes from → to, a sold unit, a unit no longer listed marked sold only when ticked; history keeps both prices", async () => {
    const { admin, project } = await seed();
    await PriceSheets.apply(h.pool, admin, project.id, (await PriceSheets.upload(h.pool, admin, project.id, csv(SHEET_1.slice(0, 3)))).sheet.id);
    await PriceSheets.apply(h.pool, admin, project.id, (await PriceSheets.upload(h.pool, admin, project.id, csv([SHEET_1[0], "B12-504,B12,Apartment,5,165,3,9500000,Available"]))).sheet.id);
    const next = await PriceSheets.upload(h.pool, admin, project.id, csv([SHEET_1[0], "B12-304,B12,Apartment,3,165,3,9600000,Available", "B12-404,B12,Apartment,4,165,3,9300000,Sold"]));
    expect(next.sheet.summary).toMatchObject({ changed: 2, removed: 1, new: 0 });
    const changed = next.sheet.entries.find((e) => e.dev_code === "B12-304");
    expect(changed).toMatchObject({ action: "changed", old_price: 9200000, price: 9600000 });
    const removed = next.sheet.entries.find((e) => e.action === "removed");
    expect(await PriceSheets.apply(h.pool, admin, project.id, next.sheet.id, { markSold: [removed.listing_id] })).toMatchObject({ updated: 2, sold: 1 });
    const byCode = Object.fromEntries((await h.query("SELECT developer_unit_code, status, price_value, id, agency_id FROM listings WHERE project_id = $1", [project.id])).map((u) => [u.developer_unit_code, u]));
    expect(byCode["B12-404"].status).toBe("sold");
    expect(byCode["B12-504"].status).toBe("sold");
    expect((await PriceSheets.history(h.pool, byCode["B12-304"])).map((x) => x.price)).toEqual([9600000, 9200000]);
  });

  test("an edit on the unit form joins the history (with the old price)", async () => {
    const admin = await row("admin");
    await h.insertListing({ code: "HP-1", price_value: 5000000 });
    const listing = (await h.query("SELECT * FROM listings WHERE code = 'HP-1'"))[0];
    const Store = require("../../lib/listingStore");
    expect((await Store.applyListingPatch(h.pool, admin, { listing, patch: { price_value: 5500000 } })).listing).toBeDefined();
    expect((await PriceSheets.history(h.pool, listing)).map((x) => x.price)).toEqual([5500000, 5000000]);
  });
});

describe("increases and freshness", () => {
  test("an announced increase waits for its date, then moves every available unit (rounded to 1,000) once; a cut works; cancel stops it", async () => {
    const { admin, project, phase } = await seed();
    await PriceSheets.apply(h.pool, admin, project.id, (await PriceSheets.upload(h.pool, admin, project.id, csv(SHEET_1.slice(0, 3)))).sheet.id);
    const now = new Date("2026-10-25T10:00:00Z");
    const s = await PriceSheets.scheduleIncrease(h.pool, admin, project.id, { pct: "7", effectiveOn: "2026-11-01", now });
    expect(s).toMatchObject({ ok: true, applied: null });
    expect((await PriceSheets.applyDueIncreases(h.pool, { now })).applied).toBe(0);
    const due = new Date("2026-11-01T06:00:00Z");
    expect(await PriceSheets.applyDueIncreases(h.pool, { now: due })).toEqual({ applied: 1, units: 2 });
    expect((await PriceSheets.applyDueIncreases(h.pool, { now: due })).applied).toBe(0);
    const prices = (await h.query("SELECT developer_unit_code, price_value FROM listings WHERE project_id = $1 ORDER BY developer_unit_code", [project.id])).map((u) => Number(u.price_value));
    expect(prices).toEqual([9844000, 9951000]);
    const cut = await PriceSheets.scheduleIncrease(h.pool, admin, project.id, { pct: "-5", effectiveOn: "2026-10-01", phaseId: phase.id, now: due });
    expect(cut.applied).toEqual({ units: 2 });
    const later = await PriceSheets.scheduleIncrease(h.pool, admin, project.id, { pct: "3", effectiveOn: "2027-01-01", now: due });
    expect((await PriceSheets.cancelIncrease(h.pool, admin, project.id, later.increase.id)).ok).toBe(true);
    expect((await PriceSheets.applyDueIncreases(h.pool, { now: new Date("2027-01-02T08:00:00Z") })).applied).toBe(0);
    expect(await PriceSheets.scheduleIncrease(h.pool, admin, project.id, { pct: "0", effectiveOn: "2027-01-01" })).toMatchObject({ field: "pct" });
    expect((await PriceSheets.scheduleIncrease(h.pool, await row("broker"), project.id, { pct: "5", effectiveOn: "2027-01-01" })).error).toBe("forbidden");
  });

  test("30 days without new prices: managers are reminded once (again 30 days later); a new sheet clears it", async () => {
    const { admin, project } = await seed();
    const up = await PriceSheets.upload(h.pool, admin, project.id, csv(SHEET_1.slice(0, 2)));
    await PriceSheets.apply(h.pool, admin, project.id, up.sheet.id, { now: new Date("2026-09-01T10:00:00Z") });
    const seen = [];
    const notify = async (p, days) => seen.push([p.id, days]);
    expect(PriceSheets.freshness({ prices_updated_at: "2026-09-01T10:00:00Z" }, { now: new Date("2026-10-05T10:00:00Z") })).toBe("stale");
    await PriceSheets.staleReminders(h.pool, { now: new Date("2026-09-20T10:00:00Z"), notify });
    await PriceSheets.staleReminders(h.pool, { now: new Date("2026-10-05T10:00:00Z"), notify });
    await PriceSheets.staleReminders(h.pool, { now: new Date("2026-10-06T10:00:00Z"), notify });
    expect(seen).toEqual([[project.id, 34]]);
    await PriceSheets.staleReminders(h.pool, { now: new Date("2026-11-06T10:00:00Z"), notify });
    expect(seen).toHaveLength(2);
  });
});

describe("the pages", () => {
  test("a manager uploads a sheet, sees the preview and applies it; brokers see prices but can't upload; the unit page shows freshness and history", async () => {
    const { project } = await seed();
    const { agent, csrf } = await signIn(h, "admin");
    const up = await agent.post(`/app/catalogue/projects/${project.id}/sheets`).field("_csrf", csrf).attach("sheet", csv(SHEET_1), { filename: "badya.csv", contentType: "text/csv" });
    expect(up.status).toBe(303);
    expect(up.headers.location).toMatch(/\/sheets\/[0-9a-f-]{36}$/);
    const preview = (await agent.get(up.headers.location)).text;
    expect(preview).toMatch(/data-new-price/);
    expect(preview).toMatch(/data-invalid-row="6"/);
    expect(preview).toMatch(/data-repeated-row="4"/);
    const applied = await agent.post(`${up.headers.location}/apply`).set("X-CSRF-Token", csrf).type("form").send("");
    expect(applied.status).toBe(303);
    const projectPage = (await agent.get(applied.headers.location.split("#")[0])).text;
    expect(projectPage).toMatch(/3 (جديد|new)/);
    expect(projectPage).toMatch(/data-prices-fresh="fresh"/);
    expect(projectPage).toMatch(/data-unit-price=/);
    const bad = await agent.post(`/app/catalogue/projects/${project.id}/sheets`).field("_csrf", csrf).attach("sheet", Buffer.from("hello"), { filename: "x.csv", contentType: "text/csv" });
    expect(bad.headers.location).toMatch(/sheet_error=NO_HEADER/);
    const inc = await agent.post(`/app/catalogue/projects/${project.id}/increases`).set("X-CSRF-Token", csrf).type("form").send("pct=7&effective_on=2099-01-01");
    expect(inc.headers.location).toMatch(/scheduled=1/);

    const b = await signIn(h, "broker");
    const seen = (await b.agent.get(`/app/catalogue/projects/${project.id}`)).text;
    expect(seen).toMatch(/data-unit-price=/);
    expect(seen).not.toMatch(/data-sheet-upload|data-increase-form/);
    expect((await b.agent.post(`/app/catalogue/projects/${project.id}/sheets`).field("_csrf", b.csrf).attach("sheet", csv(SHEET_1), { filename: "b.csv", contentType: "text/csv" })).status).toBe(403);
    const code = (await h.query("SELECT code FROM listings WHERE developer_unit_code = 'B12-304'"))[0].code;
    expect((await b.agent.get(`/app/units/${code}`)).text).toMatch(/data-prices-fresh="fresh"/);
  });
});
