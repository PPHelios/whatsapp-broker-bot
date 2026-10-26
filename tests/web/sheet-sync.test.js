// tests/web/sheet-sync.test.js — Release B C9: a project linked to the developer's shared Google Sheet, read as CSV
// once a day: unchanged sheets do nothing, changes become a preview the managers are told about (or apply at once
// with auto-apply, never marking missing units sold), a sheet that is not shared is reported once.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const SheetSync = require("../../services/sheetSync");
const S = require("../../domain/sheetSync");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const LINK = "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=42";
const SHEET_1 = "Unit Code,Type,Area,Bedrooms,Price,Status\nB-1,Apartment,165,3,9200000,Available\nB-2,Apartment,180,3,9900000,Available\n";
const SHEET_2 = "Unit Code,Type,Area,Bedrooms,Price,Status\nB-1,Apartment,165,3,9500000,Available\nB-3,Villa,300,4,25000000,Available\n";

const csvResponse = (text) => ({ ok: true, status: 200, headers: { get: () => "text/csv" }, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
const htmlResponse = () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" }, arrayBuffer: async () => new TextEncoder().encode("<!doctype html><html>Sign in</html>").buffer });
const fetcher = (fn) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return fn(url);
  };
  impl.calls = calls;
  return impl;
};
const projectRow = async (id) => (await h.query("SELECT * FROM projects WHERE id = $1", [id]))[0];
const notes = (like) => h.query("SELECT title, body FROM notifications WHERE broker_id = $1 AND dedupe_key LIKE $2 ORDER BY id", [h.BROKERS.admin.id, like]);

test("links: only Google Sheets, export address built by the app", () => {
  expect(S.parseLink(LINK)).toEqual({ id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", gid: "42" });
  expect(S.parseLink("https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toEqual({ error: "sheet_link" });
  expect(S.parseLink("http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toEqual({ error: "sheet_link" });
  expect(S.exportUrl({ id: "abc", gid: "0" })).toBe("https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=0");
  expect(S.isDue({ id: "x" })).toBe(true);
  expect(S.isDue({ id: "x", checked_at: new Date().toISOString() })).toBe(false);
});

test("daily check: preview and review, unchanged does nothing, auto-apply, broken link reported once", async () => {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya" })).project;
  expect((await SheetSync.setLink(h.pool, await row("broker"), project.id, { url: LINK })).error).toBe("forbidden");
  expect((await SheetSync.setLink(h.pool, admin, project.id, { url: "https://example.com/x" })).error).toBe("sheet_link");
  expect((await SheetSync.setLink(h.pool, admin, project.id, { url: LINK })).ok).toBe(true);

  let sheet = SHEET_1;
  const f = fetcher(() => csvResponse(sheet));
  const t0 = new Date();
  expect(await SheetSync.checkDue(h.pool, { now: t0, fetchImpl: f })).toEqual({ checked: 1, changed: 1, errors: 0 });
  expect(f.calls[0]).toBe("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/export?format=csv&gid=42");
  let p = await projectRow(project.id);
  expect(p.sheet_sync).toMatchObject({ status: "preview" });
  expect((await notes("sheet_sync:%"))[0].title).toContain("review and apply");
  const [preview] = await h.query("SELECT status, summary FROM price_sheets WHERE id = $1", [p.sheet_sync.sheet_id]);
  expect(preview).toMatchObject({ status: "preview", summary: { new: 2 } });

  // Not due again within the day; the next day the unchanged sheet does nothing.
  expect(await SheetSync.checkDue(h.pool, { now: new Date(t0.getTime() + 3600 * 1000), fetchImpl: f })).toEqual({ checked: 0, changed: 0, errors: 0 });
  const t1 = new Date(t0.getTime() + 25 * 3600 * 1000);
  expect(await SheetSync.checkDue(h.pool, { now: t1, fetchImpl: f })).toEqual({ checked: 1, changed: 0, errors: 0 });
  expect((await projectRow(project.id)).sheet_sync.status).toBe("same");

  // Apply the first preview by hand, then switch auto-apply on: the next change applies itself.
  const PriceSheets = require("../../services/priceSheets");
  expect((await PriceSheets.apply(h.pool, admin, project.id, p.sheet_sync.sheet_id)).ok).toBe(true);
  await SheetSync.setLink(h.pool, admin, project.id, { url: LINK, autoApply: true });
  sheet = SHEET_2;
  const t2 = new Date(t1.getTime() + 25 * 3600 * 1000);
  expect(await SheetSync.checkDue(h.pool, { now: t2, fetchImpl: f })).toEqual({ checked: 1, changed: 1, errors: 0 });
  const units = await h.query("SELECT developer_unit_code, price_value, status FROM listings WHERE project_id = $1 ORDER BY developer_unit_code", [project.id]);
  expect(units.map((u) => [u.developer_unit_code, Number(u.price_value), u.status])).toEqual([
    ["B-1", 9500000, "active"],
    ["B-2", 9900000, "active"], // missing from the sheet: never marked sold automatically
    ["B-3", 25000000, "active"]
  ]);
  expect((await notes("sheet_sync:%")).pop().body).toContain("1 no longer listed");

  // The sheet stops being shared: one alert, not one a day.
  const broken = fetcher(() => htmlResponse());
  const t3 = new Date(t2.getTime() + 25 * 3600 * 1000);
  expect(await SheetSync.checkDue(h.pool, { now: t3, fetchImpl: broken })).toEqual({ checked: 1, changed: 0, errors: 1 });
  await SheetSync.checkDue(h.pool, { now: new Date(t3.getTime() + 25 * 3600 * 1000), fetchImpl: broken });
  expect(await notes("sheet_sync_error:%")).toHaveLength(1);
  expect((await projectRow(project.id)).sheet_sync).toMatchObject({ status: "error", error: "sheet_not_shared" });
});

test("the project page: link, check now, remove", async () => {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Mivida" })).project;
  const spy = jest.spyOn(global, "fetch").mockImplementation(async () => csvResponse(SHEET_1));
  try {
    const { agent, csrf } = await signIn(h, "admin");
    const page = await agent.get(`/app/catalogue/projects/${project.id}`);
    expect(page.text).toContain("data-sheet-sync");
    const bad = await agent.post(`/app/catalogue/projects/${project.id}/sheet-sync`).type("form").send({ _csrf: csrf, url: "https://example.com" });
    expect(bad.headers.location).toContain("sync_error=sheet_link");
    const ok = await agent.post(`/app/catalogue/projects/${project.id}/sheet-sync`).type("form").send({ _csrf: csrf, url: LINK });
    expect(ok.headers.location).toContain("sync=preview");
    const again = await agent.post(`/app/catalogue/projects/${project.id}/sheet-sync/check`).type("form").send({ _csrf: csrf });
    expect(again.headers.location).toContain("sync=same");
    const shown = await agent.get(`/app/catalogue/projects/${project.id}`);
    expect(shown.text).toContain('data-sync-status="same"');
    const removed = await agent.post(`/app/catalogue/projects/${project.id}/sheet-sync`).type("form").send({ _csrf: csrf, url: "" });
    expect(removed.headers.location).toContain("sync=removed");
    expect((await projectRow(project.id)).sheet_sync).toEqual({});
  } finally {
    spy.mockRestore();
  }
});
