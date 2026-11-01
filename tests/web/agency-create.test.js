// tests/web/agency-create.test.js — The CRM owner adds an agency by hand (/app/owner). Only the CRM owner sees and
// posts the form; the agency is created approved (pilot or trial), its owner is an active `owner` broker, and the
// one-time Telegram start link comes back for the CRM owner to send. A mobile of another agency is refused.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const AgencyCreate = require("../../services/agencyCreate");

jest.setTimeout(90000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  resetConfig();
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_USERNAME;
  delete process.env.OWNER_BROKER_IDS;
  resetConfig();
  await closeHarness();
});

const form = (over = {}) => ({ agency: "Nile Homes", logo: "https://example.com/logo.png", ownerName: "Sara Adel", ownerPhone: "01022223333", plan: "pilot", ...over });

test("only the CRM owner sees the new-agency form; others get the 404 page", async () => {
  const crm = await signIn(h, "admin");
  expect((await crm.agent.get("/app/owner")).text).toContain('data-new-agency');
  await h.seedBroker("manager");
  const mgr = await signIn(h, "manager");
  expect((await mgr.agent.get("/app/owner")).status).toBe(404);
  expect((await mgr.agent.post("/app/owner/agencies").type("form").send({ ...form(), _csrf: mgr.csrf })).status).toBe(404);
});

test("creates an approved pilot agency with an active owner and a Telegram link", async () => {
  const crm = await signIn(h, "admin");
  const r = await crm.agent.post("/app/owner/agencies").type("form").send({ ...form(), _csrf: crm.csrf });
  expect(r.status).toBe(200);
  expect(r.text).toContain("Nile Homes");
  expect(r.text).toContain("https://t.me/Wehdat_Hub_bot?start=");
  const [a] = await h.query("SELECT name, slug, pilot, approval, plan, logo_url, trial_ends_at FROM agencies WHERE name = 'Nile Homes'");
  expect(a).toMatchObject({ pilot: true, approval: "approved", plan: "office", logo_url: "https://example.com/logo.png", slug: "nile-homes" });
  expect(a.trial_ends_at).toBeNull();
  const [b] = await h.query("SELECT role, is_active, phone_number FROM brokers WHERE phone_number = '201022223333'");
  expect(b).toMatchObject({ role: "owner", is_active: true });
});

test("a trial creates an approved agency with a 14-day trial end", async () => {
  const r = await AgencyCreate.createAgency(h.pool, h.BROKERS.admin, form({ agency: "Delta Trial", ownerPhone: "01033334444", plan: "trial", logo: "" }), { now: new Date(), username: "Wehdat_Hub_bot", issueToken: async () => "x".repeat(24) });
  expect(r.ok).toBe(true);
  const [a] = await h.query("SELECT pilot, approval, trial_ends_at FROM agencies WHERE name = 'Delta Trial'");
  expect(a.pilot).toBe(false);
  expect(a.approval).toBe("approved");
  const days = Math.round((new Date(a.trial_ends_at) - Date.now()) / 86400000);
  expect(days).toBeGreaterThanOrEqual(13);
  expect(days).toBeLessThanOrEqual(14);
});

test("refuses a mobile already used by another agency, bad logos and bad plans", async () => {
  const crm = h.BROKERS.admin;
  const taken = await AgencyCreate.createAgency(h.pool, crm, form({ ownerPhone: h.BROKERS.broker.phone.replace(/^20/, "0") }));
  expect(taken.error).toBe("phone_taken");
  expect((await AgencyCreate.createAgency(h.pool, crm, form({ logo: "http://insecure.example/x.png" }))).error).toBe("logo");
  expect((await AgencyCreate.createAgency(h.pool, crm, form({ plan: "free" }))).error).toBe("plan");
  expect((await AgencyCreate.createAgency(h.pool, crm, form({ ownerPhone: "0123" }))).error).toBe("phone");
});

test("the service itself refuses anyone who is not the CRM owner", async () => {
  const r = await AgencyCreate.createAgency(h.pool, h.BROKERS.broker, form({ agency: "Sneaky" }));
  expect(r.error).toBe("forbidden");
  const rows = await h.query("SELECT 1 FROM agencies WHERE name = 'Sneaky'");
  expect(rows.length).toBe(0);
});

test("the same agency name twice gets a unique slug", async () => {
  const crm = h.BROKERS.admin;
  const one = await AgencyCreate.createAgency(h.pool, crm, form({ agency: "Twin Agency", ownerPhone: "01055556666" }));
  const two = await AgencyCreate.createAgency(h.pool, crm, form({ agency: "Twin Agency", ownerPhone: "01055557777" }));
  expect(one.agency.slug).not.toBe(two.agency.slug);
});
