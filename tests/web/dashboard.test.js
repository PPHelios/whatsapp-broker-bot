// tests/web/dashboard.test.js — 7.2 agency dashboard + leaderboard (managers only, own agency only, no client names or
// phones, ranked by deals then commission) and 5.4 owner dashboard (OWNER_BROKER_IDS only; 404 for everyone else,
// managers included; weekly activity, AI cost per agency, open errors).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Leads = require("../../services/leads");
const Deals = require("../../services/deals");
const Dash = require("../../services/dashboards");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(async () => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

async function seedActivity() {
  const admin = await row("admin");
  const broker = await row("broker");
  await h.insertListing({ code: "VIL-08", property_type: "villa", broker_id: h.BROKERS.colleague.id });
  const a = (await Leads.captureLead(h.pool, broker, { phones: "01012345678", name: "Sara Secret" })).lead;
  await Leads.captureLead(h.pool, await row("colleague"), { phones: "01112345678", name: "Omar Secret" });
  await Leads.markContacted(h.pool, broker, a.id);
  const r = await Deals.createDeal(h.pool, admin, { leadKey: a.ref, unitCode: "VIL-08", price: 8500000, mode: "pct", pct: 2, closingBrokerId: h.BROKERS.broker.id });
  expect(r.ok).toBe(true);
  // Another agency's numbers never show.
  await h.insertListing({ code: "B-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
  await Leads.captureLead(h.pool, await row("rival"), { phones: "01212345678", name: "Rival Client" });
}

describe("agency dashboard (7.2)", () => {
  test("managers see the pipeline, totals and leaderboard of their own agency, without client names or phones", async () => {
    await seedActivity();
    const d = await Dash.agencyDashboard(h.pool, await row("admin"), { days: 30 });
    expect(d.leads).toBe(2);
    expect(d.deals.n).toBe(1);
    expect(d.board[0].name).toBe("Broker One"); // the deal ranks first
    expect(d.board[0]).toMatchObject({ deals: 1, leads: 1, contacted: 1 });
    expect(d.board[0].responseMin).not.toBeNull();
    expect(d.board.map((b) => b.name)).not.toContain("Rival Broker");

    const a = await signIn(h, "admin");
    const page = await a.agent.get("/app/dashboard?days=7&lang=en");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Leaderboard (last 7 days)");
    expect(page.text).toMatch(/data-kpi="deals"[\s\S]*?<strong>1<\/strong>/);
    expect(page.text).not.toMatch(/Secret|01012345678|\+2010/);
    expect(page.text).not.toContain("Rival");
  });

  test("a broker can't open it; an unknown period falls back to 30 days", async () => {
    const b = await signIn(h, "broker");
    expect((await b.agent.get("/app/dashboard")).status).toBe(403);
    expect((await Dash.agencyDashboard(h.pool, await row("admin"), { days: "999" })).days).toBe(30);
  });
});

describe("owner dashboard (5.4)", () => {
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
  });

  test("404 for everyone (managers too) until OWNER_BROKER_IDS names the broker", async () => {
    const a = await signIn(h, "admin");
    expect((await a.agent.get("/app/owner")).status).toBe(404);
    expect((await a.agent.get("/app/")).text).not.toContain("/app/owner");
  });

  test("the owner sees weekly activity, AI cost per agency, open errors and jobs", async () => {
    process.env.OWNER_BROKER_IDS = `${h.BROKERS.admin.id}, not-a-uuid`;
    resetConfig();
    await seedActivity();
    await h.query(
      `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, estimated_cost_usd, created_at)
       VALUES ($1, $2, 'listing_extraction', 'success', 'gemini-3.5-flash-lite', 0.0022, NOW()), ($1, $2, 'search_parse', 'failed', 'gemini-3.5-flash-lite', 0, NOW()),
              ($3, $4, 'audio_transcription', 'success', 'gemini-3.6-flash', 0.004, NOW())`,
      [h.AGENCY_A, h.BROKERS.broker.id, h.AGENCY_B, h.BROKERS.rival.id]
    );
    await h.query("INSERT INTO error_events (kind, source, fingerprint, message) VALUES ('error', 'turn', 'fp1', 'boom'), ('report', 'telegram', 'fp2', 'button does nothing')");

    const d = await Dash.ownerDashboard(h.pool, await row("admin"), { weeks: 4 });
    expect(d.weeks).toHaveLength(4);
    const thisWeek = d.weeks[3];
    expect(thisWeek).toMatchObject({ agencies: 2, leads: 3, deals: 1, errors: 1, reports: 1 });
    expect(thisWeek.brokers).toBeGreaterThanOrEqual(2);
    const alpha = d.agencies.find((x) => x.name === "Agency Alpha");
    expect(alpha).toMatchObject({ calls: 2, failed: 1 });
    expect(alpha.usd).toBeCloseTo(0.0022, 6);
    expect(d.totalUsd).toBeCloseTo(0.0062, 6);
    expect(d.topErrors.map((e) => e.fingerprint).sort()).toEqual(["fp1", "fp2"]);

    const a = await signIn(h, "admin");
    const page = await a.agent.get("/app/owner?lang=en");
    expect(page.status).toBe(200);
    expect(page.text).toContain("AI per agency (last 30 days)");
    expect(page.text).toContain("Agency Beta");
    expect(page.text).not.toMatch(/Secret|Rival Client/);
    expect((await a.agent.get("/app/")).text).toContain("/app/owner");
    // Not the owner: still a 404.
    const b = await signIn(h, "broker");
    expect((await b.agent.get("/app/owner")).status).toBe(404);
  });
});
