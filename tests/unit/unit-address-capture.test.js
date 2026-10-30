// tests/unit/unit-address-capture.test.js — The private unit details (unit no., street address) are read from every
// entry method (AI text and voice, Excel rows), and client-facing serializers never carry them.
"use strict";

const SheetImport = require("../../domain/sheetImport");
const { normalizeExtraction } = require("../../lib/listingExtract");
const PublicUnit = require("../../domain/publicUnit");
const Privacy = require("../../services/unitPrivacy");

const SECRET = { unit_no: "B-14", address: "12 Street 90, Madinaty", owner_phone: "01099998888", owner_lead: "L-0042" };
const listing = {
  id: "11111111-1111-4111-8111-111111111111",
  agency_id: "22222222-2222-4222-8222-222222222222",
  broker_id: "33333333-3333-4333-8333-333333333333",
  code: "HP-1",
  status: "active",
  listing_type: "sale",
  property_type: "apartment",
  compound: "Hyde Park",
  area_value: 150,
  bedrooms: 3,
  price_value: 8e6,
  lat: 30.0123,
  lng: 31.4567,
  details: { ...SECRET, clean_summary: "Sunny flat", summary_en: "Sunny flat" }
};

describe("the address and unit number come in from every entry method", () => {
  test("Excel headers map to the private keys, and the plain Arabic 'العنوان' stays the title", () => {
    expect(SheetImport.columnFor("Unit No")).toBe("unit_no");
    expect(SheetImport.columnFor("رقم الوحدة")).toBe("unit_no");
    expect(SheetImport.columnFor("Full Address")).toBe("address");
    expect(SheetImport.columnFor("العنوان")).toBe("title");
  });

  test("an Excel row keeps the unit number and address in details, and a missing column never clears them", () => {
    const { draft } = SheetImport.rowToDraft({ unit_no: "B-14", address: "12 Street 90, Madinaty", compound: "Hyde Park" });
    expect(draft.details).toMatchObject({ unit_no: "B-14", address: "12 Street 90, Madinaty" });
    expect(SheetImport.rowToDraft({ compound: "Hyde Park" }).draft.details).not.toHaveProperty("address");
  });

  test("the AI extraction stores a stated unit number and address in details, never in the public location", () => {
    const out = normalizeExtraction({ compound: "Madinaty", location: "Madinaty", unit_no: "B-14", address: "12 Street 90" });
    expect(out.details).toMatchObject({ unit_no: "B-14", address: "12 Street 90" });
    expect(out.location).toBe("Madinaty");
    expect(normalizeExtraction({ compound: "Madinaty" }).details).not.toHaveProperty("address");
  });
});

describe("client-facing output never carries the private details", () => {
  const SECRET_TEXT = /B-14|12 Street 90|01099998888|L-0042|30\.0123|31\.4567|maps\.google/;

  test("a public unit page is built from the public fields only", () => {
    const page = PublicUnit.toPublicUnit(listing, { agency: { name: "Test Agency" }, lang: "en" });
    expect(JSON.stringify(page)).not.toMatch(SECRET_TEXT);
    expect(JSON.stringify(page)).toContain("Sunny flat");
  });

  test("a unit a broker may not see is redacted: no address, unit no., owner link or pin", () => {
    const hidden = Privacy.redact(listing);
    expect(JSON.stringify(hidden)).not.toMatch(SECRET_TEXT);
    expect(hidden.details.clean_summary).toBe("Sunny flat");
  });
});
