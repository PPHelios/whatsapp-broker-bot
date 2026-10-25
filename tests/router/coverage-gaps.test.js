// tests/router/coverage-gaps.test.js — P9 (Release 3 step 12): bootRecovery replays only fresh `new` rows, once and in
// order; the WhatsApp Excel upload (XLS-01…04); the inventory summary (STATS-01).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness, settle, textOf } = require("../harness/app");
const Excel = require("../../lib/excel");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);

describe("bootRecovery (P9)", () => {
  const add = (id, status, ago, body = "مساعدة") =>
    h.query(`INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, $3, $4, NOW() - $5::interval)`, [
      id,
      h.BROKERS.broker.phone,
      JSON.stringify({ from: h.BROKERS.broker.phone, id, type: "text", text: { body } }),
      status,
      ago
    ]);
  const statuses = async () => Object.fromEntries((await h.query("SELECT msg_id, status, attempts FROM inbound_messages")).map((r) => [r.msg_id, r]));

  test("replays recent new rows only (not batched, handled or stale), and a second boot replays nothing", async () => {
    await add("fresh", "new", "2 minutes");
    await add("stale", "new", "20 minutes");
    await add("running", "batched", "1 minute");
    await add("done", "completed", "1 minute");
    await add("failed", "failed", "1 minute");
    const start = h.WA.outbox.length;
    await h.app.bootRecovery();
    await settle(10);
    const s = await statuses();
    expect(s.fresh.status).not.toBe("new");
    expect(s.fresh.attempts).toBe(1);
    expect(s.stale.status).toBe("new");
    expect(s.running).toMatchObject({ status: "batched", attempts: 0 });
    expect(s.done.status).toBe("completed");
    expect(s.failed.status).toBe("failed");
    // One reply: the help text for the fresh row.
    expect(to("broker", h.WA.outbox.slice(start)).length).toBeGreaterThan(0);

    const again = h.WA.outbox.length;
    await Promise.all([h.app.bootRecovery(), h.app.bootRecovery()]);
    await settle(10);
    expect(h.WA.outbox.length).toBe(again);
    expect((await statuses()).fresh.attempts).toBe(1);
  });
});

describe("WhatsApp Excel upload (XLS-01…04)", () => {
  async function sheet(rows, headers = ["Code", "Price", "Area", "Compound", "Type", "Beds"]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Units");
    ws.addRow(headers);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  async function upload(who, buffer, filename = "inventory.xlsx", mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const id = `media.doc.${Math.random().toString(36).slice(2)}`;
    h.WA.media.set(id, { buffer, mimeType: mime });
    return h.send(who, { type: "document", document: { id, filename, mime_type: mime } });
  }

  test("XLS-01/02: acknowledged, committed atomically, formulas neutralised, idempotent per file, cooldown per broker", async () => {
    const buf = await sheet([
      ["HP-101", "8.5 مليون", 150, "Hyde Park", "شقة", 3],
      ["HP-102", 9000000, 200, "=HYPERLINK(\"http://x\")", "villa", 4],
      ["ST-1", 2500000, 60, "Mivida", "studio", 0]
    ]);
    const replies = to("broker", await upload("broker", buf));
    expect(replies[0].text).toMatch(/📥 تم استلام الملف \*inventory\.xlsx\*/);
    expect(textOf(replies)).toMatch(/✅ \*تم استيراد المخزون بنجاح:\*[\s\S]*تم الاعتماد والتحديث: 3 وحدة/);
    const units = Object.fromEntries((await h.query("SELECT code, price_value, compound, property_type, bedrooms, inventory_type, broker_id FROM listings")).map((r) => [r.code, r]));
    expect(Number(units["HP-101"].price_value)).toBe(8500000);
    expect(units["HP-102"]).toMatchObject({ compound: "'=HYPERLINK(\"http://x\")", property_type: "villa" });
    expect(units["ST-1"]).toMatchObject({ property_type: "studio", bedrooms: 0, inventory_type: "resale_unit" });
    expect(units["HP-101"].broker_id).toBe(h.BROKERS.broker.id);

    // Within 45 s the same broker waits; after it, the same file is ignored as a duplicate (agency-wide).
    expect(textOf(to("broker", await upload("broker", buf)))).toMatch(/يرجى الانتظار \d+ ثانية/);
    expect(textOf(to("colleague", await upload("colleague", buf)))).toMatch(/تم استيراد ملف المخزون هذا مسبقاً/);
    expect(await h.query("SELECT COUNT(*)::int AS n FROM listings")).toEqual([{ n: 3 }]);
    const [log] = await h.query("SELECT status, metadata FROM operation_logs WHERE operation_type = 'bulk_excel_import'");
    expect(log).toMatchObject({ status: "success", metadata: expect.objectContaining({ committedCount: 3, rejectedCount: 0 }) });
  });

  test("XLS-02: a developer sheet is flagged as developer models", async () => {
    const buf = await sheet([["MV-A1", 12000000, 180, "Mountain View iCity", "apartment", 3]]);
    await upload("broker", buf, "developer_project.xlsx");
    expect((await h.query("SELECT inventory_type, is_primary_developer FROM listings"))[0]).toEqual({ inventory_type: "developer_model", is_primary_developer: true });
  });

  test("XLS-03/04: rejected rows come back as a workbook (Arabic reasons right to left in an LTR sheet); good rows are saved", async () => {
    const buf = await sheet([
      ["HP-101", 8500000, 150, "Hyde Park", "apartment", 3],
      ["كود-1", 8500000, 150, "Hyde Park", "apartment", 3],
      ["HP-103", "", 150, "Hyde Park", "apartment", 3],
      ["HP-104", 8500000, 5, "Hyde Park", "apartment", 3],
      ["HP-105", 8500000, 150, "", "apartment", 3]
    ]);
    const replies = to("broker", await upload("broker", buf, "stock.xlsx"));
    expect(textOf(replies)).toMatch(/✅ تم الاعتماد والتحديث: 1 وحدة\n• ❌ تم الاستبعاد: 4 وحدة/);
    const doc = replies.find((r) => r.type === "document");
    expect(doc.filename).toBe("مرفوضات_stock.xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(doc.buffer);
    const ws = wb.worksheets[0];
    expect(ws.views[0].rightToLeft).toBeFalsy();
    const reasons = [4, 5, 6, 7].map((r) => ws.getRow(r).getCell(1));
    expect(reasons.map((c) => c.value)).toEqual([
      expect.stringMatching(/حروف وأرقام إنجليزية/),
      "السعر مفقود أو غير صحيح",
      expect.stringMatching(/المساحة/),
      "اسم الكمبوند أو المشروع مفقود"
    ]);
    expect(reasons[0].alignment).toMatchObject({ readingOrder: "rtl" });
    expect((await h.query("SELECT code FROM listings")).map((r) => r.code)).toEqual(["HP-101"]);
    const [log] = await h.query("SELECT status FROM operation_logs WHERE operation_type = 'bulk_excel_import'");
    expect(log.status).toBe("partial_success");
  });

  test("XLS-01: wrong format, fake xlsx, empty sheet and a failed download are refused with nothing written and the cooldown released", async () => {
    expect(textOf(to("broker", await upload("broker", Buffer.from("a,b"), "units.csv", "text/csv")))).toMatch(/صيغة الملف غير مدعومة/);
    expect(textOf(to("broker", await upload("broker", Buffer.from("not a zip"))))).toMatch(/الملف تالف أو مشفر/);
    expect(textOf(to("broker", await upload("broker", await sheet([]))))).toMatch(/فارغ/);
    const id = "media.missing";
    expect(textOf(to("broker", await h.send("broker", { type: "document", document: { id, filename: "x.xlsx" } })))).toMatch(/تعذر تحميل ملف الإكسيل/);
    expect(await h.query("SELECT COUNT(*)::int AS n FROM listings")).toEqual([{ n: 0 }]);
    expect(await h.query("SELECT 1 FROM broker_sessions WHERE session_type = 'cooldown_bulk_excel' AND expires_at > NOW()")).toEqual([]);
  });

  test("XLS-04: the export keeps an LTR sheet with the Arabic description right to left", async () => {
    const unit = await h.insertListing({ code: "VIL-08", raw_text: "فيلا مستقلة بحديقة" });
    const buf = await Excel.buildAgencyInventoryWorkbook({ listings: [unit], agency: { name: "Agency Alpha" }, lang: "ar" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws.views[0].rightToLeft).toBeFalsy();
    let found = null;
    ws.eachRow((row) => row.eachCell((c) => {
      if (c.value === "فيلا مستقلة بحديقة") found = c;
    }));
    expect(found).not.toBeNull();
    expect(found.alignment).toMatchObject({ horizontal: "right", readingOrder: "rtl" });
  });
});

describe("inventory summary (STATS-01)", () => {
  test("counts, value and top places for the broker's agency only, in the broker's language, with Export and Add", async () => {
    await h.insertListing({ code: "A-1", compound: "Hyde Park", price_value: 8e6 });
    await h.insertListing({ code: "A-2", compound: "Hyde Park", price_value: 10e6, inventory_type: "developer_model" });
    await h.insertListing({ code: "A-3", compound: "Mivida", status: "sold" });
    await h.insertListing({ code: "A-4", compound: "Mivida", status: "archived" });
    await h.insertListing({ code: "B-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: "Rival Park" });

    const [ar] = to("broker", await h.text("broker", "احصائيات"));
    expect(ar.text).toContain("إجمالي الوحدات المسجلة:* 4");
    expect(ar.text).toContain("نشط ومتاح للبحث:* 2");
    expect(ar.text).toContain("تم البيع:* 1");
    expect(ar.text).toContain("مؤرشف:* 1");
    expect(ar.text).toContain("مشاريع المطورين:* 1");
    expect(ar.text).toMatch(/1\. \*Hyde Park\*: 2 وحدة/);
    expect(ar.text).not.toContain("Rival Park");
    expect(ar.buttons.map((b) => b.id)).toEqual(["cmd:export", "cmd:add"]);

    const [en] = to("admin", await h.text("admin", "stats"));
    expect(en.text).toContain("*Total Units:* 4");
    expect(en.text).toMatch(/Average Unit Price:\* .*9/);
    expect(en.buttons.map((b) => b.title)).toEqual(["Export Excel 📊", "New Unit 📝"]);
    expect((await h.query("SELECT COUNT(*)::int AS n FROM operation_logs WHERE operation_type = 'command_inventory_stats'"))[0].n).toBe(2);
  });
});
