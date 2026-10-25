// tests/unit/lead-import.test.js — Lead file parsing (Release 3 step 6): Arabic and English headers, CSV with a BOM,
// semicolons, quotes and line breaks, Windows-1256 and UTF-16 text, phones in any spelling, budgets, kinds, stages,
// and the broker a cell names.
"use strict";

const I = require("../../domain/leadImport");
const S = require("../../lib/sheets");

const read = (text) => S.readTable(Buffer.isBuffer(text) ? text : Buffer.from(text), { matcher: I.columnFor, minColumns: 1 });

describe("headers", () => {
  test.each([
    ["Name", "name"], ["الاسم", "name"], ["Phone", "phone"], ["رقم الموبايل", "phone"], ["Second phone", "phone2"], ["رقم تاني", "phone2"],
    ["Lead type", "kind"], ["نوع العميل", "kind"], ["Property type", "property_type"], ["نوع العقار", "property_type"], ["Budget", "budget"],
    ["الميزانية", "budget"], ["Area or compound", "location"], ["الكمبوند", "location"], ["Bedrooms", "bedrooms"], ["Sale or rent", "listing_type"],
    ["بيع او ايجار", "listing_type"], ["Notes", "notes"], ["المرحلة", "stage"], ["Assigned to", "assigned"], ["المسؤول", "assigned"],
    ["Lawful basis", "lawful_basis"], ["الأساس القانوني", "lawful_basis"], ["Source", "source"], ["المصدر", "source"], ["Favourite colour", null]
  ])("%s → %s", (h, key) => expect(I.columnFor(h)).toBe(key));
});

describe("cells", () => {
  test("phones in any spelling, several in one cell, Excel's lost leading zero", () => {
    expect(I.phonesIn("٠١٠١ ٢٣٤ ٥٦٧٨ / +20 122 345 6789").phones).toEqual(["+201012345678", "+201223456789"]);
    expect(I.phonesIn(1012345678).phones).toEqual(["+201012345678"]);
    expect(I.phonesIn("12345").bad).toEqual(["12345"]);
  });
  test("budgets", () => {
    expect(I.budget("من 7 لـ 9 مليون")).toEqual({ min: 7000000, max: 9000000 });
    expect(I.budget("7-9M")).toEqual({ min: 7000000, max: 9000000 });
    expect(I.budget("25 ألف")).toEqual({ min: null, max: 25000 });
    expect(I.budget("كتير")).toBeNull();
  });
  test("kinds, stages and bases in both languages", () => {
    expect(["مشتري", "Buyer", "مستأجر", "landlord", "بايع"].map(I.leadKind)).toEqual(["buyer", "buyer", "tenant", "landlord", "seller"]);
    expect(["مهتم", "Negotiation", "won", "جديد", "xyz"].map(I.stage)).toEqual(["interested", "negotiation", "won", "new", null]);
    expect(["consent", "عميل حالي", "client request"].map(I.lawfulBasis)).toEqual(["consent", "existing_client", "client_request"]);
  });
  test("a row → capture input with a request; a plain Type column holding a unit type is the property type", () => {
    const r = I.rowToLead({ name: "  Sara  ", phone: "01012345678", kind: "شقة", budget: "8 مليون", location: "التجمع", bedrooms: "3", stage: "مهتم" });
    expect(r).toMatchObject({ name: "Sara", phones: ["+201012345678"], kind: null, stage: "interested", errors: [], warnings: [] });
    expect(r.request).toMatchObject({ property_types: ["apartment"], price_max: 8000000, bedrooms_min: 3 });
    expect(r.request.places.length).toBe(1);
    expect(I.rowToLead({ phone: "01012345678", listing_type: "ايجار" }).kind).toBe("tenant");
  });
  test("no phone or a bad phone stops the row; an unread cell is a warning", () => {
    expect(I.rowToLead({ name: "x" }).errors).toEqual(["phone_required"]);
    expect(I.rowToLead({ phone: "123" }).errors).toEqual(["phone_invalid"]);
    expect(I.rowToLead({ phone: "01012345678", stage: "؟؟", budget: "كتير" }).warnings).toEqual(["stage", "budget"]);
  });
  test("the broker a cell names, by full name, unique first name or phone", () => {
    const brokers = [{ id: "a", name: "Sara Ali", phone_normalized: "201000000001" }, { id: "b", name: "Sara Omar" }, { id: "c", name: "Omar Hany" }];
    expect(I.matchBroker("sara ali", brokers).id).toBe("a");
    expect(I.matchBroker("Omar", brokers).id).toBe("c");
    expect(I.matchBroker("Sara", brokers)).toBeNull();
    expect(I.matchBroker("01000000001", brokers).id).toBe("a");
  });
});

describe("CSV", () => {
  test("BOM, semicolons, quotes, doubled quotes, line breaks inside quotes, blank lines; a formula stays text", async () => {
    const t = await read('﻿الاسم;الموبايل;ملاحظات\r\n"أحمد; علي";01012345678;"قال ""عايز"" شقة\nفي التجمع"\r\n\r\n=1+1;01122223333;\r\n');
    expect(t.mapped).toEqual(["name", "phone", "notes"]);
    expect(t.rows).toEqual([
      { rowNumber: 2, cells: { name: "أحمد; علي", phone: "01012345678", notes: 'قال "عايز" شقة\nفي التجمع' } },
      { rowNumber: 5, cells: { name: "=1+1", phone: "01122223333" } }
    ]);
  });
  test("comma and tab files; the header can sit below a title row", async () => {
    expect((await read("Clients export\nName,Phone\nSara,01012345678\n")).rows[0].cells).toEqual({ name: "Sara", phone: "01012345678" });
    expect((await read("Name\tPhone\nSara\t01012345678")).rows[0].cells).toEqual({ name: "Sara", phone: "01012345678" });
  });
  test("Windows-1256 and UTF-16 text", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("الاسم,الموبايل\nسارة,01012345678\n", "utf16le")]);
    expect((await read(utf16)).rows[0].cells.name).toBe("سارة");
    // "سارة" in Windows-1256
    const cp = Buffer.concat([Buffer.from("name,phone\n"), Buffer.from([0xd3, 0xc7, 0xd1, 0xc9]), Buffer.from(",01012345678\n")]);
    expect((await read(cp)).rows[0].cells.name).toBe("سارة");
  });
  test("a Meta Leads Center export (UTF-16, tabs, \"p:+20…\" numbers, the campaign as the source)", async () => {
    const header = "id\tcreated_time\tad_name\tcampaign_name\tform_name\tplatform\tfull_name\tphone_number\temail";
    const row = "l:123\t2026-10-25T10:00:00+0200\tVillas ad\tNew Cairo Oct\tVilla form\tfb\tSara Ali\tp:+201012345678\ts@x.com";
    const file = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${header}\n${row}\n`, "utf16le")]);
    const lead = I.rowToLead((await read(file)).rows[0].cells);
    expect(lead).toMatchObject({ phones: ["+201012345678"], name: "Sara Ali", source: "New Cairo Oct", errors: [] });
  });
  test("limits: 2,000 rows and 5 MB", async () => {
    const many = "name,phone\n" + Array.from({ length: 2001 }, (_, i) => `n${i},010${String(i).padStart(8, "0")}`).join("\n");
    await expect(read(many)).rejects.toMatchObject({ code: "TOO_MANY_ROWS" });
    await expect(read(Buffer.alloc(S.MAX_BYTES + 1, 0x41))).rejects.toMatchObject({ code: "TOO_LARGE" });
    const ok = "name,phone\n" + Array.from({ length: 2000 }, (_, i) => `n${i},010${String(i).padStart(8, "0")}`).join("\n");
    expect((await read(ok)).rows).toHaveLength(2000);
  });
});
