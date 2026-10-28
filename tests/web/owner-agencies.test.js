// tests/web/owner-agencies.test.js — The owner's agency controls: list, one agency's page, plan change, suspend and
// resume (the same brokers come back), announcements to managers, and the owner's action log.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterEach(() => {
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
});
afterAll(closeHarness);

test("only the owner sees and uses the agency controls", async () => {
  const b = await signIn(h, "broker");
  expect((await b.agent.get(`/app/owner/agencies/${h.AGENCY_B}`)).status).toBe(404);
  expect((await b.agent.post(`/app/owner/agencies/${h.AGENCY_B}/suspend`).type("form").send({ _csrf: b.csrf })).status).toBe(404);
  const { agent, csrf } = await signIn(h, "admin");
  const home = await agent.get("/app/owner");
  expect(home.text).toContain(`/app/owner/agencies/${h.AGENCY_B}`);
  expect(home.text).toContain('id="announce"');

  // Plan: Agency plan for 3 months, logged.
  const plan = await agent.post(`/app/owner/agencies/${h.AGENCY_B}/plan`).type("form").send({ _csrf: csrf, plan: "agency", months: "3" });
  expect(plan.status).toBe(200);
  const [a] = await h.query("SELECT plan, paid_until > now() + interval '80 days' AS long FROM agencies WHERE id = $1", [h.AGENCY_B]);
  expect(a).toEqual({ plan: "agency", long: true });
  expect((await agent.post(`/app/owner/agencies/${h.AGENCY_B}/plan`).type("form").send({ _csrf: csrf, plan: "gold" })).status).toBe(422);

  // Suspend: the rival broker stops; resume brings them back.
  await agent.post(`/app/owner/agencies/${h.AGENCY_B}/suspend`).type("form").send({ _csrf: csrf });
  expect((await h.query("SELECT is_active FROM brokers WHERE id = $1", [h.BROKERS.rival.id]))[0].is_active).toBe(false);
  expect((await agent.get(`/app/owner/agencies/${h.AGENCY_B}`)).text).toContain(`/app/owner/agencies/${h.AGENCY_B}/resume`);
  await agent.post(`/app/owner/agencies/${h.AGENCY_B}/resume`).type("form").send({ _csrf: csrf });
  expect((await h.query("SELECT is_active FROM brokers WHERE id = $1", [h.BROKERS.rival.id]))[0].is_active).toBe(true);

  // Announcement reaches every manager; the log lists the owner's actions.
  const sent = await agent.post("/app/owner/announce").type("form").send({ _csrf: csrf, title: "New feature" });
  expect(sent.text).toMatch(/Sent to \d+ managers/);
  expect((await h.query("SELECT count(*)::int AS n FROM notifications WHERE title LIKE '%New feature%'"))[0].n).toBeGreaterThan(0);
  const log = await h.query("SELECT operation_type FROM operation_logs WHERE operation_type LIKE 'owner_%' ORDER BY created_at");
  expect(log.map((l) => l.operation_type)).toEqual(["owner_plan", "owner_suspend", "owner_resume", "owner_announcement"]);
});
