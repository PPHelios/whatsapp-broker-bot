// tests/router/foundation.test.js — Release 1 step 1: migrations, telemetry IDs, outbound counter, webhook hardening
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { loadConfig } = require("../../config");
const { listMigrations, runMigrations } = require("../../lib/migrate");
const { TYPE_OVERRIDES } = require("../../lib/db");

jest.setTimeout(30000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

describe("Migrations", () => {
  test("the harness database has every migration recorded", async () => {
    const rows = await h.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((r) => r.version)).toEqual(listMigrations().map((m) => m.version));
  });

  test("re-running migrations is a no-op", async () => {
    expect(await runMigrations(h.pool)).toEqual([]);
  });
});

describe("Number parsing", () => {
  test("NUMERIC and BIGINT come back as numbers", async () => {
    const [r] = await h.query("SELECT 8500000::numeric AS price, count(*) AS n FROM agencies");
    expect(r).toEqual({ price: 8500000, n: 2 });
  });

  test("the production pool uses the same number parsers", () => {
    expect(TYPE_OVERRIDES.getTypeParser(1700)("12.5")).toBe(12.5);
    expect(TYPE_OVERRIDES.getTypeParser(20)("42")).toBe(42);
    expect(TYPE_OVERRIDES.getTypeParser(25)("text")).toBe("text");
  });
});

describe("Turn context and telemetry", () => {
  test("the AI gateway receives broker and agency in ctx", async () => {
    await h.insertListing({ code: "HP-201" });
    let seenCtx = null;
    h.AI.respond((call) => {
      seenCtx = call;
      return { intent: "search", filters: {}, locations: [], location_terms: [] };
    });
    // fake-ai records the call; the real gateway reads ctx.broker for telemetry
    const spy = jest.spyOn(h.AI, "generateWithCascade");
    await h.text("broker", "شقة في التجمع");
    const ctx = spy.mock.calls[0][0].ctx;
    expect(ctx.broker.agency_id).toBe(h.AGENCY_A);
    expect(ctx.agency.id).toBe(h.AGENCY_A);
    spy.mockRestore();
    expect(seenCtx).not.toBeNull();
  });

  test("operation_logs written during a turn never have a null agency_id", async () => {
    await h.insertListing({ code: "HP-201" });
    h.AI.respond(() => ({ intent: "search", filters: {}, locations: [], location_terms: [] }));
    await h.text("broker", "شقة في التجمع");
    await h.text("broker", "مساعدة");
    const rows = await h.query("SELECT operation_type, agency_id FROM operation_logs");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.agency_id)).toEqual([]);
  });
});

describe("Outbound message counter", () => {
  test("every delivered message is counted per agency", async () => {
    await h.text("broker", "مساعدة");
    await h.text("admin", "help");
    const rows = await h.query(
      "SELECT agency_id, status, metadata->>'kind' AS kind FROM operation_logs WHERE operation_type = 'wa_outbound'"
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.agency_id === h.AGENCY_A && r.status === "success" && r.kind === "reply")).toBe(true);
    const [day] = await h.query("SELECT sent, failed FROM agency_outbound_daily WHERE agency_id = $1", [h.AGENCY_A]);
    expect(day).toEqual({ sent: 2, failed: 0 });
  });

  test("a failed send is counted as failed", async () => {
    h.WA.failNext("text");
    await h.text("broker", "مساعدة");
    const rows = await h.query(
      "SELECT status FROM operation_logs WHERE operation_type = 'wa_outbound' ORDER BY id"
    );
    // the failed help reply, then the safety-net fallback
    expect(rows.map((r) => r.status)).toEqual(["failed", "success"]);
  });
});

describe("Webhook hardening", () => {
  const { createApp } = require("../../server");
  const body = JSON.stringify({ entry: [] });

  test("fail-closed: no app secret means every webhook is rejected", async () => {
    const app = createApp({ pool: h.pool, config: loadConfig({}) });
    await request(app.app).post("/webhook").set("Content-Type", "application/json").send(body).expect(401);
  });

  test("unsigned webhooks are accepted only with the explicit dev opt-in", async () => {
    const app = createApp({ pool: h.pool, config: loadConfig({ WEBHOOK_ALLOW_UNSIGNED: "true" }) });
    await request(app.app).post("/webhook").set("Content-Type", "application/json").send(body).expect(200);
  });

  test("bodies over the limit are rejected with 413", async () => {
    const app = createApp({ pool: h.pool, config: loadConfig({ WEBHOOK_ALLOW_UNSIGNED: "true", BODY_LIMIT: "1kb" }) });
    const big = JSON.stringify({ entry: [], pad: "x".repeat(4000) });
    await request(app.app).post("/webhook").set("Content-Type", "application/json").send(big).expect(413);
  });

  test("the verify handshake fails when no verify token is configured", async () => {
    const app = createApp({ pool: h.pool, config: loadConfig({}) });
    await request(app.app).get("/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1").expect(403);
  });
});
