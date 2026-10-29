// tests/web/price-reading.test.js — Release B C5: a PDF or photographed price list read by AI into the usual
// price-sheet preview: off until the owner switches it on, the manager picks pages, a monthly page allowance checked
// before any call, pages read once reused silently across agencies (no AI call, not counted), and the rows never
// invented (only what the model copied).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { PDFDocument, StandardFonts } = require("pdf-lib");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const FakeAI = require("../harness/fake-ai");
const Catalogue = require("../../services/catalogue");
const PriceReading = require("../../services/priceReading");
const Credits = require("../../services/credits");
const R = require("../../domain/priceReading");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

async function pdf(pages) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  // Each page gets its own width, so the fake model can tell which page it was shown.
  pages.forEach((t, i) => d.addPage([600 + i, 800]).drawText(t, { x: 50, y: 700, font: f, size: 12 }));
  return Buffer.from(await d.save());
}

// The fake model answers by the page it is shown (read from the one-page PDF's width).
const PAGES = {
  601: { rows: [{ dev_code: "B12-304", building: "B12", property_type: "Apartment", area: 165, bedrooms: 3, price: "9.2M", status: "available" }] },
  602: { rows: [{ property_type: "Villa", area: "250", area_to: 280, bedrooms: 4, price: 18500000, price_from: true }, { note: "total" }] }
};
function answerByPage() {
  FakeAI.respond((call) => {
    const part = call.contents[0].parts[1].inlineData;
    if (part.mimeType !== "application/pdf") return { rows: [{ dev_code: "PH-1", property_type: "Apartment", area: 120, price: 6000000 }] };
    const text = Buffer.from(part.data, "base64").toString("latin1");
    const width = (text.match(/MediaBox\s*\[\s*0\s+0\s+(\d+)/) || [])[1];
    return PAGES[width] || { rows: [] };
  });
}

describe("rules", () => {
  test("pages, settings and the model's answer", () => {
    expect(R.parsePages("2-4, 7", 10)).toEqual([2, 3, 4, 7]);
    expect(R.parsePages("٢ إلى ٣", 5)).toEqual([2, 3]);
    expect(R.parsePages("", 1)).toEqual([1]);
    expect(R.parsePages("", 4)).toEqual({ error: "pages_required" });
    expect(R.parsePages("3-9", 5)).toEqual({ error: "pages_invalid" });
    expect(R.parsePages("1-11", 20)).toEqual({ error: "too_many_pages" });
    expect(R.settingOf({})).toEqual({ enabled: false, pages_month: 30 });
    expect(R.settingFields({ enabled: "on", pages_month: "50" })).toEqual({ fields: { enabled: true, pages_month: 50 } });
    expect(R.rowsFromAnswer("not json")).toEqual({ error: "AI_BAD_JSON" });
    expect(R.rowsFromAnswer('```json\n{"rows":[{"dev_code":"A1","price":"9.2 مليون","area":null}]}\n```').rows).toEqual([{ cells: { dev_code: "A1", price: 9200000 } }]);
    expect(R.monthStart(new Date("2026-12-15T10:00:00Z")).toISOString()).toBe("2026-11-30T22:00:00.000Z");
  });
});

describe("reading a PDF", () => {
  test("off until switched on; picked pages only; allowance; reuse across agencies is free and silent", async () => {
    const admin = await row("admin");
    const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya" })).project;
    const file = await pdf(["Cover page", "Units page one", "Units page two"]);
    const files = [{ buffer: file, mimetype: "application/pdf", originalname: "badya.pdf" }];
    answerByPage();

    expect((await PriceReading.read(h.pool, admin, project.id, { files, pages: "2-3" })).error).toBe("OFF");
    expect((await PriceReading.read(h.pool, await row("broker"), project.id, { files, pages: "2" })).error).toBe("forbidden");
    await PriceReading.setForAgency(h.pool, admin.agency_id, { enabled: "on" });
    // A Free-plan pool (80 credits) with 7 pages already paid (70 credits) leaves room for one page of 10 credits.
    await h.query("UPDATE agencies SET pilot = false WHERE id = $1", [admin.agency_id]);
    await h.query("INSERT INTO price_read_log (agency_id, fingerprint, reused) SELECT $1, 'old' || g, false FROM generate_series(1, 7) g", [admin.agency_id]);
    expect(await PriceReading.read(h.pool, admin, project.id, { files, pages: "2-3" })).toEqual({ error: "ALLOWANCE", left: 1, needed: 2 });
    expect(FakeAI.calls).toHaveLength(0);
    expect((await PriceReading.read(h.pool, admin, project.id, { files, pages: "" })).error).toBe("pages_required");

    await Credits.grant(h.pool, admin.agency_id, 40);
    const r = await PriceReading.read(h.pool, admin, project.id, { files, pages: "2-3" });
    expect(r).toMatchObject({ ok: true, read: 2, reused: 0 });
    expect(FakeAI.calls.map((c) => c.operation)).toEqual(["price_list_read", "price_list_read"]);
    expect(r.sheet).toMatchObject({ source: "ai", status: "preview" });
    expect(r.sheet.summary).toMatchObject({ new: 2, ai: { pages: [2, 3], read: 2, reused: 0 } });
    const unit = r.sheet.entries.find((e) => e.dev_code === "B12-304");
    expect(unit).toMatchObject({ action: "new", price: 9200000, area: 165, rowNumber: 2001 });
    expect(r.sheet.entries.find((e) => e.kind === "model")).toMatchObject({ property_type: "villa", price: 18500000, price_from: true, area_to: 280 });
    expect((await PriceReading.usage(h.pool, admin.agency_id)).left).toBe(3);

    // Another agency uploads the same list: no AI call, nothing counted, same rows.
    const rivalAdmin = { ...(await row("rival")), role: "admin" };
    await h.query("UPDATE brokers SET role = 'admin' WHERE id = $1", [rivalAdmin.id]);
    const theirs = (await Catalogue.saveProject(h.pool, rivalAdmin, { name: "Badya" })).project;
    await PriceReading.setForAgency(h.pool, rivalAdmin.agency_id, { enabled: "on", pages_month: "0" });
    const again = await PriceReading.read(h.pool, rivalAdmin, theirs.id, { files, pages: "3, 2" });
    expect(again).toMatchObject({ ok: true, read: 0, reused: 2 });
    expect(FakeAI.calls).toHaveLength(2);
    expect((await PriceReading.usage(h.pool, rivalAdmin.agency_id)).used).toBe(0);
  });

  test("photos; a failed page is reported; the web form and the owner's switch", async () => {
    const admin = await row("admin");
    const project = (await Catalogue.saveProject(h.pool, admin, { name: "Mivida" })).project;
    answerByPage();
    const { agent, csrf } = await signIn(h, "admin");

    let pageHtml = (await agent.get(`/app/catalogue/projects/${project.id}`)).text;
    expect(pageHtml).not.toContain("data-ai-read");
    const owner = await agent.get("/app/owner");
    expect(owner.text).toContain("price-reading");
    const sw = await agent.post(`/app/owner/price-reading/${admin.agency_id}`).type("form").send({ _csrf: csrf, enabled: "on", pages_month: "10" });
    expect(sw.status).toBe(200);
    pageHtml = (await agent.get(`/app/catalogue/projects/${project.id}`)).text;
    expect(pageHtml).toContain("data-ai-read");
    expect(pageHtml).toContain('data-pages-left="200"');

    const photo = Buffer.from("fake-jpeg-bytes");
    const up = await agent.post(`/app/catalogue/projects/${project.id}/sheets/read`).field("_csrf", csrf).attach("doc", photo, { filename: "p1.jpg", contentType: "image/jpeg" });
    expect(up.status).toBe(303);
    const preview = await agent.get(up.headers.location);
    expect(preview.text).toContain("data-ai-sheet");
    expect(preview.text).toContain("PH-1");

    FakeAI.respond(() => new Error("overloaded"));
    const failed = await agent.post(`/app/catalogue/projects/${project.id}/sheets/read`).field("_csrf", csrf).attach("doc", Buffer.from("other"), { filename: "p2.jpg", contentType: "image/jpeg" });
    expect(failed.headers.location).toContain("sheet_error=AI_FAILED");
    // A failed read costs nothing.
    expect((await PriceReading.usage(h.pool, admin.agency_id)).used).toBe(1);
  });
});
