"use strict";

// The place box: hidden area boxes by default, the add-new part opens when asked, and the Arabic name and map link wait on the pending name.
const { unitForm } = require("../../web/views/unitForm");
const PlaceNames = require("../../lib/placeNames");
const { createTestDb } = require("../harness/db");

jest.setTimeout(60000);

const areas = [
  { id: "11111111-1111-4111-8111-111111111111", parent_id: null, name_en: "New Cairo" },
  { id: "22222222-2222-4222-8222-222222222222", parent_id: "11111111-1111-4111-8111-111111111111", name_en: "5th Settlement" }
];
const { formFromUnit } = require("../../web/forms/unitForm");
const render = (values) => String(unitForm({ values: { ...formFromUnit({ market: "resale" }), ...values }, areas, lang: "en" }));

test("a known place shows one line and keeps the add-new part hidden", () => {
  const out = render({ compound: "Hyde Park", area_id: areas[0].id, subzone_id: areas[1].id });
  expect(out).toContain("New Cairo › 5th Settlement");
  expect(out).toMatch(/data-place-new hidden/);
  expect(out).toMatch(/name="compound_new" value="1" disabled/);
});

test("add-new opens with its fields when the unit came back with it", () => {
  const out = render({ compound: "Brand New Heights", compound_new: "1", compound_ar: "برايت" });
  expect(out).not.toMatch(/data-place-new hidden/);
  expect(out).toContain('name="compound_ar" value="برايت"');
  expect(out).not.toMatch(/name="compound_new" value="1" disabled/);
});

test("the Arabic name and link are kept on the pending name, once", async () => {
  const db = await createTestDb();
  try {
    await db.pool.query("INSERT INTO place_names (name_key, name_en) VALUES ('brand new heights', 'Brand New Heights')");
    await PlaceNames.addDetails(db.pool, "Brand New Heights", { nameAr: "براند نيو", pin: "https://maps.google.com/?q=30.1,31.4" });
    await PlaceNames.addDetails(db.pool, "Brand New Heights", { nameAr: "تاني", pin: "x" });
    const r = (await db.pool.query("SELECT name_ar, pin_link FROM place_names WHERE name_key = 'brand new heights'")).rows[0];
    expect(r).toEqual({ name_ar: "براند نيو", pin_link: "https://maps.google.com/?q=30.1,31.4" });
  } finally {
    await db.pool.end();
  }
});

test("suggestions match Arabic or English but show the reader's language", () => {
  const { suggest } = require("../../domain/areas");
  const lists = { places: [{ id: "p1", name_en: "Hyde Park", name_ar: "هايد بارك", aliases: [], area_id: areas[0].id, subzone_id: areas[1].id }], areas: areas.map((a) => ({ ...a, name_ar: a.id === areas[0].id ? "القاهرة الجديدة" : "التجمع الخامس", aliases: [] })) };
  const en = suggest("هايد", lists, 5, "en")[0];
  const ar = suggest("hyde", lists, 5, "ar")[0];
  expect(en).toMatchObject({ label: "Hyde Park", path: "New Cairo › 5th Settlement" });
  expect(ar).toMatchObject({ label: "هايد بارك", path: "القاهرة الجديدة › التجمع الخامس" });
});
