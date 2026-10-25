// tests/web/billing.test.js — Phase 2 step 4: plans, allowances, manual payments and self sign-up.
// effectivePlan (pilot → Office free, paid, trial, Free); monthly text/voice allowance counted from operation_logs and
// enforced before an AI call (PLAN_QUOTA_EXCEEDED, voice packs add 100); seats cap invites; a manager announces a
// payment (amount + reference + where to pay), the owner confirms and the period is extended; sign-up switch, waiting
// request, approve (trial + start link) and reject; reminders 3 days before the end, once.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Signup = require("../../services/signup");
const Plans = require("../../domain/plans");

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

const DAY = 86400000;
const NOW = new Date();
const useAi = async (n, { audio = false, agency = h.AGENCY_A } = {}) => {
  for (let i = 0; i < n; i++) {
    await h.query(
      `INSERT INTO operation_logs (agency_id, broker_id, operation_type, status, model_used, gemini_ms, metadata, created_at)
       VALUES ($1, $2, 'listing_extraction', 'success', 'gemini-x', 10, $3, NOW())`,
      [agency, h.BROKERS.broker.id, JSON.stringify(audio ? { media: "audio" } : {})]
    );
  }
};
const notPilot = (extra = "") => h.query(`UPDATE agencies SET pilot = false ${extra} WHERE id = $1`, [h.AGENCY_A]);

test("effectivePlan: pilot is Office for free, then paid, trial, and Free when nothing is running", () => {
  const future = new Date(NOW.getTime() + DAY);
  const past = new Date(NOW.getTime() - DAY);
  expect(Billing.effectivePlan({ pilot: true, plan: "solo" }, NOW)).toMatchObject({ source: "pilot", plan: { id: "office" } });
  expect(Billing.effectivePlan({ plan: "agency", paid_until: future }, NOW)).toMatchObject({ source: "paid", plan: { id: "agency" } });
  expect(Billing.effectivePlan({ plan: "agency", paid_until: past, trial_ends_at: future }, NOW)).toMatchObject({ source: "trial", plan: { id: "office" } });
  expect(Billing.effectivePlan({ plan: "agency", paid_until: past, trial_ends_at: past }, NOW)).toMatchObject({ source: "free", plan: { id: "free" } });
});

test("existing agencies are pilots; the monthly allowance counts text and voice apart and blocks at the limit", async () => {
  expect((await h.query("SELECT pilot FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].pilot).toBe(true);
  await notPilot();
  await useAi(Plans.FREE.text - 1);
  await useAi(Plans.FREE.voice, { audio: true });
  const a = await Billing.allowance(h.pool, h.AGENCY_A);
  expect(a).toMatchObject({ source: "free", text: { used: Plans.FREE.text - 1, limit: Plans.FREE.text }, voice: { used: Plans.FREE.voice, limit: Plans.FREE.voice } });
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A, { audio: false })).resolves.toBeTruthy();
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A, { audio: true })).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED", kind: "voice" });
  await useAi(1);
  await expect(Billing.checkAllowance(h.pool, h.AGENCY_A, { audio: false })).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED", kind: "text" });
  // Another agency's use never counts here.
  expect((await Billing.allowance(h.pool, h.AGENCY_B)).text.used).toBe(0);
});

test("the AI gateway checks the plan before calling and records voice notes as audio", async () => {
  const AI = jest.requireActual("../../lib/ai");
  AI._setClientForTests({ models: { generateContent: async () => ({ text: "ok", usageMetadata: {} }) } });
  try {
    const broker = { id: h.BROKERS.broker.id, agency_id: h.AGENCY_A };
    const audio = [{ parts: [{ inlineData: { mimeType: "audio/ogg", data: "AA" } }, { text: "transcribe" }] }];
    await AI.generateWithCascade({ contents: audio, operationType: "listing_extraction", ctx: { pool: h.pool, broker } });
    await new Promise((r) => setTimeout(r, 50));
    const [row] = await h.query("SELECT metadata->>'media' AS media FROM operation_logs WHERE operation_type = 'listing_extraction'");
    expect(row.media).toBe("audio");
    await notPilot();
    await useAi(Plans.FREE.text);
    await expect(AI.generateWithCascade({ contents: "hello", operationType: "listing_extraction", ctx: { pool: h.pool, broker } })).rejects.toMatchObject({ code: "PLAN_QUOTA_EXCEEDED" });
  } finally {
    AI._setClientForTests(null);
  }
});

test("seats: on the Free plan (1 seat) a manager can't add another broker; nobody is removed", async () => {
  await notPilot();
  const a = await signIn(h, "admin");
  const res = await a.agent.post("/app/team/invite").type("form").send({ _csrf: a.csrf, name: "Nour", phone: "01099887766", role: "broker" });
  expect(res.status).toBe(400);
  expect(res.text).toMatch(/seat|مقاعد/i);
  expect(await h.query("SELECT 1 FROM brokers WHERE phone_normalized = '201099887766'")).toEqual([]);
  expect((await h.query("SELECT count(*)::int AS n FROM brokers WHERE agency_id = $1 AND is_active", [h.AGENCY_A]))[0].n).toBeGreaterThan(1);
});

test("a manager announces a payment, the owner confirms it and the paid period starts; brokers can't pay", async () => {
  await Billing.savePayTo(h.pool, { instapay: "wehdat@instapay", bank: "" });
  const a = await signIn(h, "admin");
  const page = await a.agent.get("/app/plan?lang=en");
  expect(page.status).toBe(200);
  expect(page.text).toContain('data-source="pilot"');
  const pay = await a.agent.post("/app/plan/pay").type("form").send({ _csrf: a.csrf, kind: "plan", plan: "agency", months: "3" });
  expect(pay.status).toBe(200);
  const ref = (pay.text.match(/data-payment="(WH-[A-Z0-9]{6})"/) || [])[1];
  expect(ref).toBeDefined();
  expect(pay.text).toContain("6,270 EGP");
  expect(pay.text).toContain("wehdat@instapay");
  expect((await a.agent.post("/app/plan/pay").type("form").send({ _csrf: a.csrf, kind: "plan", plan: "gold", months: "3" })).status).toBe(400);

  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/plan")).status).toBe(200);
  expect((await b.agent.post("/app/plan/pay").type("form").send({ _csrf: b.csrf, kind: "plan", plan: "solo", months: "1" })).status).toBe(403);

  const owner = await a.agent.get("/app/owner?lang=en");
  expect(owner.text).toContain(`data-payment="${ref}"`);
  const [p] = await h.query("SELECT id FROM payments WHERE reference = $1", [ref]);
  expect((await a.agent.post(`/app/owner/payments/${p.id}/confirm`).type("form").send({ _csrf: a.csrf })).status).toBe(200);
  const [agency] = await h.query("SELECT plan, pilot, paid_until FROM agencies WHERE id = $1", [h.AGENCY_A]);
  expect(agency).toMatchObject({ plan: "agency", pilot: false });
  const days = (new Date(agency.paid_until) - Date.now()) / DAY;
  expect(days).toBeGreaterThan(88);
  expect(days).toBeLessThan(93);
  expect((await a.agent.post(`/app/owner/payments/${p.id}/confirm`).type("form").send({ _csrf: a.csrf })).status).toBe(400);
  expect(await h.query("SELECT 1 FROM notifications WHERE kind = 'manager_alert' AND title LIKE $1", [`%${ref}%`])).not.toEqual([]);
  // A voice pack adds 100 voice notes this month.
  await a.agent.post("/app/plan/pay").type("form").send({ _csrf: a.csrf, kind: "voice_pack" });
  const [vp] = await h.query("SELECT id FROM payments WHERE kind = 'voice_pack'");
  await Billing.confirmPayment(h.pool, vp.id);
  expect((await Billing.allowance(h.pool, h.AGENCY_A)).voice.limit).toBe(Plans.planById("agency").voice + Plans.VOICE_PACK.notes);
  // Owner controls are 404 for everyone else.
  expect((await b.agent.post(`/app/owner/payments/${p.id}/cancel`).type("form").send({ _csrf: b.csrf })).status).toBe(404);
});

test("sign-up: closed by default; open → waiting request (inactive admin) → approve starts the trial with a start link; reject", async () => {
  const anon = request.agent(h.app.app);
  expect((await anon.get("/app/signup?lang=en")).text).toMatch(/closed/i);
  expect((await anon.post("/app/signup").type("form").send({ agency: "X", name: "Y", phone: "01055556666", consent: "1" })).status).toBe(403);

  const a = await signIn(h, "admin");
  await a.agent.post("/app/owner/signup").type("form").send({ _csrf: a.csrf, open: "1" });
  expect(await Signup.isOpen(h.pool)).toBe(true);
  expect((await request(h.app.app).get("/?lang=en")).text).toContain("/app/signup");
  expect((await anon.post("/app/signup").type("form").send({ agency: "Delta Homes", name: "Omar", phone: "01055556666" })).status).toBe(400);
  expect((await anon.post("/app/signup").type("form").send({ agency: "Taken", name: "T", phone: `0${h.BROKERS.rival.phone.slice(2)}`, consent: "1" })).status).toBe(400);
  const sent = await anon.post("/app/signup").type("form").send({ agency: "Delta Homes", name: "Omar", phone: "01055556666", consent: "1" });
  expect(sent.status).toBe(303);
  const [ag] = await h.query("SELECT id, approval, pilot FROM agencies WHERE name = 'Delta Homes'");
  expect(ag).toMatchObject({ approval: "pending", pilot: false });
  expect((await h.query("SELECT is_active, role FROM brokers WHERE agency_id = $1", [ag.id]))[0]).toEqual({ is_active: false, role: "admin" });

  const approved = await a.agent.post(`/app/owner/signups/${ag.id}/approve`).type("form").send({ _csrf: a.csrf });
  expect(approved.status).toBe(200);
  expect(approved.text).toMatch(/https:\/\/t\.me\/Wehdat_Hub_bot\?start=[A-Za-z0-9_-]+/);
  expect(approved.text).toMatch(/https:\/\/wa\.me\/201055556666\?text=/);
  const [after] = await h.query("SELECT approval, plan, trial_ends_at FROM agencies WHERE id = $1", [ag.id]);
  expect(after).toMatchObject({ approval: "approved", plan: "office" });
  expect(Math.round((new Date(after.trial_ends_at) - Date.now()) / DAY)).toBe(Plans.TRIAL.days);
  expect((await Billing.allowance(h.pool, ag.id)).source).toBe("trial");
  expect((await h.query("SELECT is_active FROM brokers WHERE agency_id = $1", [ag.id]))[0].is_active).toBe(true);

  await anon.post("/app/signup").type("form").send({ agency: "Spam Co", name: "S", phone: "01077778888", consent: "1" });
  const [spam] = await h.query("SELECT id FROM agencies WHERE name = 'Spam Co'");
  await a.agent.post(`/app/owner/signups/${spam.id}/reject`).type("form").send({ _csrf: a.csrf });
  expect((await h.query("SELECT approval FROM agencies WHERE id = $1", [spam.id]))[0].approval).toBe("rejected");
  expect((await h.query("SELECT is_active FROM brokers WHERE agency_id = $1", [spam.id]))[0].is_active).toBe(false);
});

test("managers hear once, 3 days before the trial ends", async () => {
  await notPilot(", trial_ends_at = NOW() + INTERVAL '2 days'");
  expect((await BillingNotices.remindEnding(h.pool)).sent).toBeGreaterThan(0);
  await BillingNotices.remindEnding(h.pool);
  const rows = await h.query("SELECT broker_id FROM notifications WHERE dedupe_key LIKE 'plan_end:%'");
  expect(new Set(rows.map((r) => r.broker_id)).size).toBe(rows.length);
});
