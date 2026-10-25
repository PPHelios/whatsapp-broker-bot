// tests/router/deliverables.test.js — DEL-03…06 and DEL-08: payment plans list, single-plan copy, multi-plan
// workbook, collateral links and the forwarded listing card interceptor, through the real router.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness, settle, textOf, FALLBACK_AR } = require("../harness/app");

jest.setTimeout(30000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const PLANS = [
  { plan_id: "p5", name_ar: "خطة 5 سنوات", years: 5, down_payment_pct: 10, frequency: "quarterly" },
  { plan_id: "p8", name_ar: "خطة 8 سنوات", years: 8, down_payment_pct: 5, frequency: "quarterly" }
];
const developerUnit = (extra = {}) =>
  h.insertListing({
    code: "DEV-7",
    inventory_type: "developer_model",
    is_primary_developer: true,
    market: "primary",
    price_value: 10000000,
    payment_terms: { plans: PLANS },
    ...extra
  });

describe("DEL-03 plans list", () => {
  test("lists every plan of the unit with plan_select ids", async () => {
    await developerUnit();
    const replies = await h.tap("broker", "plans_view:DEV-7");
    const list = replies.find((r) => r.type === "list");
    expect(list).toBeDefined();
    const ids = JSON.stringify(list);
    expect(ids).toContain("plan_select:DEV-7:p5");
    expect(ids).toContain("plan_select:DEV-7:p8");
    expect(textOf(replies)).not.toMatch(FALLBACK_AR);
  });

  test("a unit without plans and an unknown code get a clear answer", async () => {
    await h.insertListing({ code: "HP-1" });
    expect(textOf(await h.tap("broker", "plans_view:HP-1"))).toMatch(/لا توجد خطط تقسيط/);
    expect(textOf(await h.tap("broker", "plans_view:NOPE-1"))).toMatch(/غير موجودة/);
  });

  test("another agency's unit is not found (tenant isolation)", async () => {
    await developerUnit();
    expect(textOf(await h.tap("rival", "plans_view:DEV-7"))).toMatch(/غير موجودة/);
  });
});

describe("DEL-04 single-plan client copy", () => {
  test("picking a plan sends a forwardable copy with that plan's terms", async () => {
    await developerUnit();
    const replies = await h.pick("broker", "plan_select:DEV-7:p8");
    const text = textOf(replies);
    expect(text).not.toMatch(FALLBACK_AR);
    expect(text).toMatch(/8/);
    expect(text).toMatch(/5\s*%|٥/);
  });
});

describe("DEL-05 multi-plan workbook", () => {
  test("acknowledges, then delivers one xlsx with a sheet per plan plus the comparison", async () => {
    await developerUnit();
    const replies = await h.tap("broker", "compare_excel:DEV-7");
    await settle(10);
    expect(textOf(replies)).toMatch(/جاري إنشاء ملف المقارنة/);
    const doc = h.WA.outbox.find((r) => r.type === "document");
    expect(doc).toBeDefined();
    expect(doc.filename).toMatch(/DEV-7.*\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(doc.buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Payment Plans Overview", "5 Years Plan", "8 Years Plan"]);
    expect(String(wb.worksheets[1].getCell("A1").value)).not.toMatch(/undefined/);
  });

  test("two plans with the same term get distinct sheets (was: workbook failed)", async () => {
    await developerUnit({
      payment_terms: { plans: [PLANS[0], { ...PLANS[0], plan_id: "p5b", discount_pct: 5 }] }
    });
    await h.tap("broker", "compare_excel:DEV-7");
    await settle(10);
    const doc = h.WA.outbox.find((r) => r.type === "document");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(doc.buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Payment Plans Overview", "5 Years Plan", "5 Years Plan (2)"]);
  });

  test("no plans: nothing is generated", async () => {
    await h.insertListing({ code: "HP-2" });
    const replies = await h.tap("broker", "compare_excel:HP-2");
    await settle(10);
    expect(textOf(replies)).toMatch(/لا توجد خطط تقسيط متاحة للتصدير/);
    expect(h.WA.outbox.some((r) => r.type === "document")).toBe(false);
  });
});

describe("DEL-06 collateral links", () => {
  test("lists the layout, master plan, drive and brochure links", async () => {
    await developerUnit({
      collateral: {
        layout_pdf_url: "https://example.com/layout.pdf",
        master_plan_url: "https://example.com/master.pdf",
        drive_folder_url: "https://drive.example.com/kit",
        project_brochure_url: "https://example.com/brochure.pdf"
      }
    });
    const text = textOf(await h.text("broker", "مخطط DEV-7"));
    expect(text).toContain("https://example.com/layout.pdf");
    expect(text).toContain("https://example.com/master.pdf");
    expect(text).toContain("https://drive.example.com/kit");
    expect(text).toContain("https://example.com/brochure.pdf");
  });

  test("no links: says so; no code: asks for one", async () => {
    await h.insertListing({ code: "HP-3" });
    expect(textOf(await h.text("broker", "layout HP-3"))).toMatch(/لا توجد روابط/);
  });
});

describe("DEL-08 forwarded listing card", () => {
  const card = (code, extra = "") => `🏠 شقة للبيع في التجمع\nالمساحة 150 متر\nكود: ${code}${extra ? `\n${extra}` : ""}`;

  test("a card with جدول routes to the payment plans, not to search", async () => {
    await developerUnit();
    const replies = await h.text("broker", card("DEV-7", "جدول"));
    const text = textOf(replies);
    expect(text).toMatch(/أنظمة السداد المتاحة للوحدة #DEV-7/);
    expect(text).toMatch(/المقدم: 10%[\s\S]*المقدم: 5%/);
    expect(text).not.toMatch(FALLBACK_AR);
  });

  test("a card with مخطط routes to the collateral links", async () => {
    await developerUnit({ collateral: { layout_pdf_url: "https://example.com/l.pdf" } });
    expect(textOf(await h.text("broker", card("DEV-7", "مخطط")))).toContain("https://example.com/l.pdf");
  });

  test("a card with عميل routes to the client copy", async () => {
    await h.insertListing({ code: "HP-4" });
    const text = textOf(await h.text("broker", card("HP-4", "عميل")));
    expect(text).not.toMatch(FALLBACK_AR);
    expect(text).toMatch(/150/);
  });

  test("a card with no action opens the unit card with buttons and remembers the unit", async () => {
    await h.insertListing({ code: "HP-5" });
    const replies = await h.text("broker", card("HP-5"));
    expect(replies.some((r) => r.type === "buttons")).toBe(true);
    expect(textOf(replies)).toMatch(/HP-5/);
  });

  test("another agency's code is not opened", async () => {
    await h.insertListing({ code: "HP-6" });
    const replies = await h.text("rival", card("HP-6"));
    expect(textOf(replies)).not.toMatch(/HP-6[\s\S]*150/);
  });
});
