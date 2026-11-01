// tests/web/excel-roundtrip.test.js — Fake-data Excel pass: template download, upload, preview, apply, manager export,
// and the export read back. No AI or WhatsApp calls.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.seedBroker("manager");
});
afterAll(closeHarness);

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HEAD = ["الكود", "الكمبوند", "النوع", "بيع او ايجار", "السعر", "المساحة", "الغرف", "الحمامات", "المميزات", "الحالة"];
const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

async function workbook(rows) {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Inventory");
  s.addRow([...HEAD, "تليفون المالك"]);
  for (const r of rows) s.addRow([...r, "01012345678"]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Reads the first sheet back as plain values: one array per row, header included.
async function readBack(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const out = [];
  wb.worksheets[0].eachRow((row) => out.push(row.values.slice(1)));
  return out;
}

const upload = (agent, csrf, buf, name = "inventory.xlsx") =>
  agent.post("/app/import/excel").field("_csrf", csrf).attach("sheet", buf, { filename: name, contentType: XLSX });
const importId = (res) => res.headers.location.split("/").pop();
const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code_norm = upper($1)", [code]))[0];

test("the template downloads as a real workbook with the inventory headers", async () => {
  const { agent } = await signIn(h, "manager");
  const res = await agent.get("/app/import/template.xlsx").buffer(true).parse(binary);
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/spreadsheetml/);
  const rows = await readBack(res.body);
  expect(rows[0]).toEqual(expect.arrayContaining(["Code / الكود", "Compound / الكمبوند", "Price / السعر"]));
  expect(rows.length).toBeGreaterThan(1);
});

test("fake inventory: upload, preview, apply two new units; the manager's export reads back with every unit", async () => {
  await h.insertListing({ code: "FX-OLD", compound: "Hyde Park", price_value: 7e6, area_value: 140, bedrooms: 2 });
  const rows = [
    ["FX-1", "Hyde Park", "شقة", "بيع", "8.5 مليون", 150, 3, 2, "", "تشطيب كامل"],
    ["FX-2", "Mivida", "فيلا", "بيع", "21 مليون", 320, 5, 4, "حديقة", ""],
    ["FX-OLD", "Hyde Park", "شقة", "بيع", "7.4 مليون", 140, 2, 2, "", ""]
  ];
  const { agent, csrf } = await signIn(h, "manager");
  const preview = await upload(agent, csrf, await workbook(rows));
  expect(preview.status).toBe(303);
  const id = importId(preview);
  expect((await agent.get(preview.headers.location)).text).toMatch(/data-kind="new"/);
  expect(await unit("FX-1")).toBeUndefined();

  const apply = await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=2&rows=3&rows=4");
  expect(apply.status).toBe(303);
  expect(await unit("FX-1")).toMatchObject({ price_value: 8.5e6, area_value: 150, bedrooms: 3 });
  expect(await unit("FX-2")).toMatchObject({ property_type: "villa", price_value: 2.1e7 });
  expect((await unit("FX-OLD")).price_value).toBe(7.4e6);

  const manager = await signIn(h, "admin");
  const exported = await manager.agent.get("/app/units-export.xlsx").buffer(true).parse(binary);
  expect(exported.status).toBe(200);
  const sheet = await readBack(exported.body);
  const codes = sheet.map((r) => r[0]);
  expect(codes).toEqual(expect.arrayContaining(["FX-1", "FX-2", "FX-OLD"]));
});

test("a broker cannot download the agency export", async () => {
  const { agent } = await signIn(h, "broker");
  const res = await agent.get("/app/units-export.xlsx");
  expect(res.status).toBe(403);
});

test("a file that is not a workbook, or has no header row, is refused and nothing is imported", async () => {
  const { agent, csrf } = await signIn(h, "manager");
  const notXlsx = await upload(agent, csrf, Buffer.from("this is a text file"), "fake.xlsx");
  expect(notXlsx.status).toBe(422);
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("x");
  s.addRow(["random", "notes"]);
  s.addRow(["more", "text"]);
  const res = await upload(agent, csrf, Buffer.from(await wb.xlsx.writeBuffer()), "notes.xlsx");
  expect(res.status).toBe(422);
  expect(res.text).toMatch(/صف العناوين/);
  const [{ count }] = await h.query("SELECT COUNT(*)::int AS count FROM listings");
  expect(count).toBe(0);
});
