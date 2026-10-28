// tests/web/ai-usage-log.test.js — F24: the agency's AI use line by line (text, voice, document pages; reused pages
// free), filtered by month, user and feature, exported to Excel; managers see their agency, the owner any agency.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const AiLog = require("../../services/aiUsageLog");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

async function seed() {
  const B = h.BROKERS;
  const op = (broker, type, media, at, status = "success", model = "gemini-x") =>
    h.query("INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)", [h.AGENCY_A, broker, type, status, model, JSON.stringify(media ? { media } : {}), at]);
  await op(B.broker.id, "search_parse", null, "2026-10-05T10:00:00Z");
  await op(B.broker.id, "audio_transcription", "audio", "2026-10-05T11:00:00Z");
  await op(B.admin.id, "price_list_read", null, "2026-10-06T09:00:00Z");
  await op(B.admin.id, "search_parse", null, "2026-10-06T09:30:00Z", "failed");
  await op(B.admin.id, "search_parse", null, "2026-09-30T23:30:00Z"); // 1 Oct in Cairo
  await op(B.admin.id, "search_parse", null, "2026-09-30T20:00:00Z"); // September
  for (const reused of [false, true]) {
    await h.query("INSERT INTO price_read_log (agency_id, broker_id, fingerprint, reused, created_at) VALUES ($1, $2, 'v1:x', $3, '2026-10-06T09:00:00Z')", [h.AGENCY_A, B.admin.id, reused]);
  }
}

test("the log: month in Cairo time, filters, totals", async () => {
  await seed();
  const log = await AiLog.list(h.pool, h.AGENCY_A, { month: "2026-10" });
  expect(log.totals).toEqual({ text: 3, voice: 1, page: 1, free: 1 });
  expect(log.rows).toHaveLength(6);
  const mine = await AiLog.list(h.pool, h.AGENCY_A, { month: "2026-10", brokerId: h.BROKERS.broker.id });
  expect(mine.rows.map((r) => r.feature).sort()).toEqual(["audio_transcription", "search_parse"]);
  expect((await AiLog.list(h.pool, h.AGENCY_A, { month: "2026-10", feature: "page_read" })).totals).toEqual({ text: 0, voice: 0, page: 1, free: 1 });
  expect((await AiLog.list(h.pool, h.AGENCY_A, { month: "2026-09" })).rows).toHaveLength(1);
});

test("managers see and export; brokers can't; the owner sees any agency", async () => {
  await seed();
  const { agent } = await signIn(h, "admin");
  const page = await agent.get("/app/usage/log?month=2026-10&lang=en");
  expect(page.status).toBe(200);
  expect(page.text).toContain("Text: 3 · Voice: 1 · Pages: 1 · Free pages: 1");
  expect(page.text).toContain("Price list reading");
  expect((await agent.get("/app/usage")).text).toContain("data-ai-log-link");

  const xlsx = await agent.get("/app/usage/log.xlsx?month=2026-10&lang=en").buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.body);
  expect(wb.worksheets[0].rowCount).toBe(7);

  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/usage/log")).status).toBe(403);
  expect((await agent.get(`/app/owner/agencies/${h.AGENCY_A}/ai-log`)).status).toBe(404);

  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  require("../../config").resetConfig();
  try {
    const owner = await agent.get(`/app/owner/agencies/${h.AGENCY_A}/ai-log?month=2026-10`);
    expect(owner.status).toBe(200);
    expect(owner.text).toContain("data-ai-log-totals");
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  }
});
