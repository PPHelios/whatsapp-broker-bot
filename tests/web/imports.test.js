// tests/web/imports.test.js — Release 2 step 6: Excel diff import, bulk edit, group import
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const Imports = require("../../services/imports");
const Excel = require("../../lib/excel");
const Describe = require("../../domain/describe");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

async function workbook(rows, { headerAt = 1 } = {}) {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("x");
  for (let i = 1; i < headerAt; i++) s.addRow([i === 1 ? "Agency banner" : ""]);
  for (const r of rows) s.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = (agent, csrf, buf, name = "inv.xlsx") => agent.post("/app/import/excel").field("_csrf", csrf).attach("sheet", buf, { filename: name, contentType: XLSX });
const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code_norm = upper($1)", [code]))[0];
const importId = (res) => res.headers.location.split("/").pop();

const HEAD = ["الكود", "الكمبوند", "النوع", "بيع او ايجار", "السعر", "المساحة", "الغرف", "الحمامات", "المميزات", "الحالة"];

describe("Excel diff import", () => {
  async function seed() {
    await h.insertListing({ code: "HP-1", price_value: 8e6, area_value: 150, bedrooms: 3, bathrooms: 2, feature_keys: ["corner"] });
    await h.insertListing({ code: "HP-2", price_value: 9e6, area_value: 160, bedrooms: 3, bathrooms: 2 });
    await h.insertListing({ code: "COL-1", broker_id: h.BROKERS.colleague.id });
  }
  const rows = [
    HEAD,
    ["hp-1", "Hyde Park", "شقة", "بيع", "8.5 مليون", 150, 3, 2, "بحري، ناصية", "متاحة"], // changed: price + feature
    ["HP-2", "Hyde Park", "شقة", "بيع", 9000000, 160, 3, 2, "", ""], // unchanged
    ["NEW-9", "ميفيدا", "فيلا", "بيع", "20 مليون", 300, 4, 4, "روف", ""], // new
    ["BAD-1", "", "شقة", "بيع", "", 120, 2, 1, "", ""], // invalid
    ["COL-1", "Hyde Park", "شقة", "بيع", "1 مليون", 150, 3, 2, "", ""], // a colleague's unit
    ["NEW-9", "ميفيدا", "فيلا", "بيع", "21 مليون", 300, 4, 4, "", ""] // repeated code
  ];

  test("the preview shows new, changed (from → to), unchanged, invalid and forbidden rows; nothing is written yet", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "broker");
    const r = await upload(agent, csrf, await workbook(rows));
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/data-kind="new"/);
    expect(page.text).toMatch(/data-kind="changed"/);
    expect(page.text).toMatch(/data-change="price_value"[^>]*>السعر: <del>8 مليون ج.م<\/del> ← <ins>8.5 مليون ج.م<\/ins>/);
    expect(page.text).toMatch(/data-change="feature_keys"/);
    expect(page.text).toMatch(/data-kind="unchanged"[\s\S]*HP-2/);
    expect(page.text).toMatch(/صف 5[^<]*(الكمبوند|السعر)/);
    expect(page.text).toMatch(/data-kind="forbidden"[\s\S]*COL-1/);
    expect(page.text).toMatch(/الكود مكرر في الشيت/);
    expect((await unit("HP-1")).price_value).toBe(8e6);
    expect(await unit("NEW-9")).toBeUndefined();
  });

  test("applying the selected rows creates and updates through the same write path; a plan applies once", async () => {
    await seed();
    const before = await unit("HP-1");
    const { agent, csrf } = await signIn(h, "broker");
    const id = importId(await upload(agent, csrf, await workbook(rows)));
    const apply = await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=2&rows=4");
    expect(apply.status).toBe(303);
    const hp1 = await unit("HP-1");
    expect(hp1).toMatchObject({ price_value: 8.5e6, feature_keys: ["north_facing", "corner"], version: before.version + 1 });
    expect(new Date(hp1.confirmed_at) >= new Date(before.confirmed_at)).toBe(true);
    expect(await unit("NEW-9")).toMatchObject({ property_type: "villa", broker_id: h.BROKERS.broker.id, feature_keys: ["roof"] });
    expect((await unit("COL-1")).price_value).toBe(8.5e6); // untouched
    const view = await agent.get(`/app/import/${id}`);
    expect(view.text).toMatch(/data-result/);
    expect(view.text).toMatch(/اتضافت: 1/);
    expect(view.text).not.toMatch(/name="rows"/);
    const again = await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=3");
    expect(again.status).toBe(409);
    // New units are found by WhatsApp search.
    h.AI.respond(() => new Error("503"));
    expect(textOf(await h.text("broker", "ميفيدا فيلا"))).toMatch(/NEW-9/);
  });

  test("a unit changed after the preview is not overwritten (reported as a conflict)", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "broker");
    const id = importId(await upload(agent, csrf, await workbook(rows)));
    await h.text("broker", "سعر HP-1 11 مليون");
    await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=2");
    expect((await unit("HP-1")).price_value).toBe(11e6);
    const [{ result }] = await h.query("SELECT result FROM web_imports WHERE id = $1", [id]);
    expect(result.conflicts).toEqual(["HP-1"]);
  });

  test("the bot's own export re-imports with nothing changed (diff, not overwrite)", async () => {
    await h.insertListing({ code: "EX-1", compound: "ميفيدا", compound_en: "Mivida", price_value: 7e6, area_value: 140, bedrooms: 2, bathrooms: 2, raw_text: "شقة حلوة" });
    await h.insertListing({ code: "EX-2", property_type: "villa", compound: "Villette", price_value: 2e7, area_value: 300, bedrooms: 4 });
    const listings = await h.query("SELECT * FROM listings WHERE agency_id = $1", [h.AGENCY_A]);
    const exported = await Excel.buildAgencyInventoryWorkbook({ listings, agency: { name: "Agency Alpha" }, broker: { name: "B" } });
    const { agent, csrf } = await signIn(h, "broker");
    const page = await agent.get((await upload(agent, csrf, exported, "Inventory.xlsx")).headers.location);
    const [{ payload }] = await h.query("SELECT payload FROM web_imports ORDER BY created_at DESC LIMIT 1");
    expect(payload.items.map((i) => [i.code, i.kind])).toEqual([["EX-1", "unchanged"], ["EX-2", "unchanged"]]);
    expect(page.text).toMatch(/data-kind="unchanged"/);
    expect(page.text).not.toMatch(/data-kind="(changed|new|invalid)"/);
  });

  test("units missing from a full inventory sheet are offered for archiving, never archived on their own", async () => {
    await seed();
    await h.insertListing({ code: "GONE-1" });
    const { agent, csrf } = await signIn(h, "broker");
    const res = await upload(agent, csrf, await workbook(rows.slice(0, 3)));
    const page = await agent.get(res.headers.location);
    expect(page.text).toMatch(/data-kind="missing"[\s\S]*GONE-1/);
    expect(page.text).not.toMatch(/value="COL-1"/); // a colleague's unit is not offered
    await agent.post(`/app/import/${importId(res)}/apply`).set("X-CSRF-Token", csrf).type("form").send("archive=GONE-1&archive=COL-1");
    expect((await unit("GONE-1")).status).toBe("archived");
    expect((await unit("COL-1")).status).toBe("active");
    expect((await unit("HP-2")).status).toBe("active");
  });

  test("the header row is found below banner rows; formula cells give their value", async () => {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet("x");
    s.addRow(["My agency"]);
    s.addRow([]);
    s.addRow(["Code", "Compound", "Property Type", "Purpose", "Price", "Area (sqm)", "Bedrooms"]);
    s.addRow(["F-1", "Hyde Park", "Apartment", "Sale", { formula: "4000000*2", result: 8000000 }, 150, 3]);
    const { agent, csrf } = await signIn(h, "broker");
    const res = await upload(agent, csrf, Buffer.from(await wb.xlsx.writeBuffer()));
    const [{ payload }] = await h.query("SELECT payload FROM web_imports WHERE id = $1", [importId(res)]);
    expect(payload.items).toEqual([expect.objectContaining({ row: 4, kind: "new", code: "F-1", fields: expect.objectContaining({ price_value: 8000000 }) })]);
  });

  test("files that are not inventory workbooks are refused with a reason", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const notXlsx = await upload(agent, csrf, Buffer.from("PK\x03\x04garbage"));
    expect(notXlsx.status).toBe(422);
    expect(notXlsx.text).toMatch(/xlsx/);
    const noHeader = await upload(agent, csrf, await workbook([["a", "b"], [1, 2]]));
    expect(noHeader.status).toBe(422);
    expect(noHeader.text).toMatch(/صف العناوين/);
    expect((await agent.get("/app/import/template.xlsx")).headers["content-type"]).toMatch(/spreadsheetml/);
  });

  test("another broker cannot open or apply my import", async () => {
    await seed();
    const me = await signIn(h, "broker");
    const id = importId(await upload(me.agent, me.csrf, await workbook(rows)));
    const other = await signIn(h, "colleague");
    expect((await other.agent.get(`/app/import/${id}`)).status).toBe(404);
    expect((await other.agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", other.csrf).type("form").send("rows=4")).status).toBe(404);
    expect(await unit("NEW-9")).toBeUndefined();
  });
});

describe("group import (forwarded posts and chat exports)", () => {
  const POSTS = {
    mivida: { listing_type: "sale", market: "resale", property_type: "apartment", compound: "ميفيدا", area_value: 200, bedrooms: 3, price_value: 12e6, features: ["north_facing"] },
    hp: { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8.5e6 },
    noPrice: { listing_type: "sale", property_type: "apartment", compound: "الرحاب", area_value: 120, bedrooms: 2 }
  };
  function scripted() {
    h.AI.respond((c) => {
      const t = JSON.stringify(c.contents);
      if (c.operation !== "listing_extraction") return null;
      return t.includes("ميفيدا") ? POSTS.mivida : t.includes("هايد") ? POSTS.hp : POSTS.noPrice;
    });
  }

  test("pasted posts: listings are read, chatter skipped, duplicates of existing units flagged; selected ones are added", async () => {
    await h.insertListing({ code: "HP-OLD", compound: "Hyde Park", area_value: 152, bedrooms: 3, price_value: 8.4e6 });
    scripted();
    const { agent, csrf } = await signIn(h, "broker");
    const text = ["شقة للبيع في ميفيدا 200 متر 3 غرف بحري السعر 12 مليون", "شقة في هايد بارك 150م 3 غرف السعر 8.5 مليون", "صباح الخير يا جماعة", "شقة في الرحاب 120 متر غرفتين مقدم مليون"].join("\n\n\n");
    const r = await agent.post("/app/import/group").field("_csrf", csrf).field("text", text);
    expect(r.status).toBe(303);
    const id = importId(r);
    await Imports.waitForGroupImport(id);
    const page = await agent.get(`/app/import/${id}`);
    expect(page.text).toMatch(/data-post="0" data-state="ok"/);
    expect(page.text).toMatch(/data-post="1" data-state="duplicate"[\s\S]*HP-OLD/);
    expect(page.text).toMatch(/data-post="2" data-state="incomplete"/);
    expect(page.text).not.toMatch(/صباح الخير/);
    // Defaults: complete and not a duplicate → ticked.
    expect(page.text).toMatch(/name="rows" value="0" checked/);
    expect(page.text).toMatch(/name="rows" value="1">/);

    await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=0&rows=2");
    const created = await h.query("SELECT * FROM listings WHERE details->>'source' = 'group_import'");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ compound: "ميفيدا", price_value: 12e6, feature_keys: ["north_facing"], broker_id: h.BROKERS.broker.id });
  });

  test("a zipped WhatsApp chat export: the poster is kept as internal co-broker, never in client copy", async () => {
    scripted();
    const zip = new JSZip();
    zip.file("WhatsApp Chat with Brokers.txt", "[24/10/2026, 10:15:32] Ahmed Broker: شقة للبيع في ميفيدا 200 متر 3 غرف\nالسعر 12 مليون\n[24/10/2026, 10:16:01] Sara: تمام");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/import/group").field("_csrf", csrf).attach("chat", buf, { filename: "chat.zip", contentType: "application/zip" });
    const id = importId(r);
    await Imports.waitForGroupImport(id);
    expect((await agent.get(`/app/import/${id}`)).text).toMatch(/Ahmed Broker/);
    await agent.post(`/app/import/${id}/apply`).set("X-CSRF-Token", csrf).type("form").send("rows=0");
    const [l] = await h.query("SELECT * FROM listings");
    expect(l.details).toMatchObject({ co_broker: "Ahmed Broker", source: "group_import" });
    expect(Describe.clientCopy(l, h.BROKERS.broker)).not.toMatch(/Ahmed/);
    expect(Describe.brokerCard(l)).toMatch(/Ahmed Broker/);
  });

  test("while posts are read the page polls; the AI quota running out is reported per post", async () => {
    h.AI.respond(() => Object.assign(new Error("quota"), { code: "AGENCY_QUOTA_EXCEEDED" }));
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/import/group").field("_csrf", csrf).field("text", "شقة للبيع في ميفيدا 200 متر 3 غرف السعر 12 مليون");
    const id = importId(r);
    await Imports.waitForGroupImport(id);
    expect((await agent.get(`/app/import/${id}`)).text).toMatch(/data-state="error"[\s\S]*حد الذكاء الاصطناعي اليومي خلص/);
    await h.query("UPDATE web_imports SET status = 'processing' WHERE id = $1", [id]);
    expect((await agent.get(`/app/import/${id}`)).text).toMatch(/hx-trigger="every 2s"/);
  });

  test("nothing that looks like a unit → told so, no AI call", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/import/group").field("_csrf", csrf).field("text", "صباح الخير\n\n\nمطلوب شقة في التجمع 3 غرف تحت 8 مليون");
    expect(r.status).toBe(422);
    expect(h.AI.calls).toHaveLength(0);
  });
});

describe("bulk edit", () => {
  async function seed() {
    await h.insertListing({ code: "B-1", price_value: 1e6 });
    await h.insertListing({ code: "B-2", price_value: 2_345_000 });
    await h.insertListing({ code: "B-COL", broker_id: h.BROKERS.colleague.id });
    await h.insertListing({ code: "B-DEV", is_primary_developer: true, market: "primary", price_value: 5e6 });
  }
  const bulk = (agent, csrf, body) => agent.post("/app/units/bulk").set("X-CSRF-Token", csrf).type("form").send(body);

  test("status for several units at once; a colleague's unit is refused", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "broker");
    const list = await agent.get("/app/units");
    expect(list.text).toMatch(/name="code" value="B-1" form="bulk"/);
    const r = await bulk(agent, csrf, "action=sold&code=B-1&code=B-2&code=B-COL&code=NOPE");
    expect(r.text).toMatch(/اتعدلت: 2/);
    expect(r.text).toMatch(/مش من حقك تعدلها: 1/);
    expect(r.text).toMatch(/مش موجودة: 1/);
    expect((await h.query("SELECT code, status FROM listings ORDER BY code")).map((x) => `${x.code}:${x.status}`)).toEqual(["B-1:sold", "B-2:sold", "B-COL:active", "B-DEV:active"]);
  });

  test("price by percent rounds to the nearest thousand; developer prices are left to the price sheet", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "admin");
    const r = await bulk(agent, csrf, "action=price_pct&pct=10&code=B-1&code=B-2&code=B-DEV");
    expect(r.text).toMatch(/اتعدلت: 2|Updated: 2/);
    expect((await h.query("SELECT code, price_value FROM listings WHERE code LIKE 'B-%' ORDER BY code")).map((x) => x.price_value)).toEqual([1.1e6, 2_580_000, 8.5e6, 5e6]);
  });

  test("an unknown action or an out-of-range percent is refused", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "broker");
    expect((await bulk(agent, csrf, "action=delete&code=B-1")).status).toBe(422);
    expect((await bulk(agent, csrf, "action=price_pct&pct=500&code=B-1")).status).toBe(422);
    expect((await bulk(agent, "nope", "action=sold&code=B-1")).status).toBe(403);
  });
});
