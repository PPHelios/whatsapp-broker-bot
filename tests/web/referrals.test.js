// tests/web/referrals.test.js — Release B N9: agency referral program. Managers see their agency's invite code and
// link on /app/plan; sign-up takes the code (prefilled from ?ref=, unknown codes refused); the invited agency's first
// confirmed plan payment adds a free month for it and one for the inviter (on its paid period, or as a credit added
// to its next payment), once; the owner sees referrals and can link an agency that hasn't paid yet.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const Billing = require("../../services/billing");
const Referrals = require("../../services/referrals");

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
const daysLeft = async (agencyId) => {
  const [a] = await h.query("SELECT paid_until FROM agencies WHERE id = $1", [agencyId]);
  return Math.round((new Date(a.paid_until) - Date.now()) / DAY);
};
const pay = async (manager, months = 1) => {
  const r = await Billing.requestPayment(h.pool, manager, { kind: "plan", plan: "solo", months });
  expect(r.ok).toBe(true);
  return r.payment;
};

test("managers get a stable invite code and link on /app/plan; brokers don't", async () => {
  const a = await signIn(h, "admin");
  const page = await a.agent.get("/app/plan?lang=en");
  const code = (page.text.match(/data-referral="([A-Z0-9]{6})"/) || [])[1];
  expect(code).toBeDefined();
  expect(page.text).toContain(`/app/signup?ref=${code}`);
  expect(page.text).toContain("https://wa.me/?text=");
  expect((await a.agent.get("/app/plan?lang=en")).text).toContain(`data-referral="${code}"`);
  expect(await Referrals.codeOf(h.pool, h.AGENCY_A)).toBe(code);
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/plan")).text).not.toContain("data-referral=");
});

test("sign-up with an invite code; the first payment gives both agencies a free month, once; credits wait for the next payment", async () => {
  const code = await Referrals.codeOf(h.pool, h.AGENCY_A);
  const a = await signIn(h, "admin");
  await a.agent.post("/app/owner/signup").type("form").send({ _csrf: a.csrf, open: "1" });
  const anon = request.agent(h.app.app);
  const form = await anon.get(`/app/signup?lang=en&ref=${code.toLowerCase()}`);
  expect(form.text).toContain(`value="${code}"`);
  expect(form.text).toMatch(/free month/);
  expect((await anon.post("/app/signup").type("form").send({ agency: "Nile Homes", name: "Mona", phone: "01055556666", consent: "1", referral: "NOPE99" })).status).toBe(400);
  expect((await anon.post("/app/signup").type("form").send({ agency: "Nile Homes", name: "Mona", phone: "01055556666", consent: "1", referral: code })).status).toBe(303);
  const [nile] = await h.query("SELECT id, referred_by FROM agencies WHERE name = 'Nile Homes'");
  expect(nile.referred_by).toBe(h.AGENCY_A);
  await a.agent.post(`/app/owner/signups/${nile.id}/approve`).type("form").send({ _csrf: a.csrf });
  const [mona] = await h.query("SELECT * FROM brokers WHERE agency_id = $1", [nile.id]);

  // Agency A is a pilot (not paying), so its month waits as a credit.
  const first = await pay(mona, 1);
  expect((await a.agent.post(`/app/owner/payments/${first.id}/confirm`).type("form").send({ _csrf: a.csrf })).status).toBe(200);
  expect(await daysLeft(nile.id)).toBeGreaterThanOrEqual(59);
  expect((await h.query("SELECT referral_credit_months FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].referral_credit_months).toBe(1);
  expect(await h.query("SELECT 1 FROM notifications WHERE dedupe_key = $1", [`referral_ok:${nile.id}`])).not.toEqual([]);
  expect(await h.query("SELECT 1 FROM notifications WHERE title LIKE '%free month%' AND title LIKE $1", [`%${first.reference}%`])).not.toEqual([]);
  const plan = await a.agent.get("/app/plan?lang=en");
  expect(plan.text).toContain("1 free month(s) that will be added");
  expect(plan.text).toContain("Nile Homes");
  expect(plan.text).toContain("free month earned");
  const owner = await a.agent.get("/app/owner?lang=en");
  expect(owner.text).toContain(`data-referral-row="${nile.id}"`);
  expect(owner.text).toContain("Both months given");

  // A second payment by the invited agency earns nothing more.
  const before = await daysLeft(nile.id);
  const second = await pay(mona, 1);
  await Billing.confirmPayment(h.pool, second.id);
  const after = await daysLeft(nile.id);
  expect(after - before).toBeGreaterThanOrEqual(28);
  expect(after - before).toBeLessThanOrEqual(31);
  expect((await h.query("SELECT referral_credit_months FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].referral_credit_months).toBe(1);

  // The inviter's next payment uses up its credit: 1 month paid + 1 free.
  const own = await pay(h.BROKERS.admin, 1);
  const r = await Billing.confirmPayment(h.pool, own.id);
  expect(r.referral.bonus).toBe(1);
  expect(await daysLeft(h.AGENCY_A)).toBeGreaterThanOrEqual(59);
  expect((await h.query("SELECT referral_credit_months FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].referral_credit_months).toBe(0);
});

test("an inviter that is paying gets its month on its paid period; the owner links agencies, with refusals", async () => {
  const code = await Referrals.codeOf(h.pool, h.AGENCY_A);
  await h.query("UPDATE agencies SET pilot = false, plan = 'office', paid_until = NOW() + interval '10 days' WHERE id = $1", [h.AGENCY_A]);
  await h.query("UPDATE agencies SET pilot = false WHERE id = $1", [h.AGENCY_B]);
  await h.query("UPDATE brokers SET role = 'admin' WHERE id = $1", [h.BROKERS.rival.id]);
  const a = await signIn(h, "admin");
  const link = (agency, c) => a.agent.post("/app/owner/referrals").type("form").send({ _csrf: a.csrf, agency, code: c });
  expect((await link(h.AGENCY_B, "WRONG1")).status).toBe(400);
  expect((await link(h.AGENCY_A, code)).status).toBe(400);
  const ok = await link(h.AGENCY_B, code.toLowerCase());
  expect(ok.status).toBe(200);
  expect(ok.text).toContain("Linked to");
  expect((await link(h.AGENCY_B, code)).status).toBe(400);
  expect(await Referrals.link(h.pool, h.AGENCY_B, code)).toEqual({ error: "already" });

  const p = await pay({ ...h.BROKERS.rival, role: "admin" }, 1);
  const r = await Billing.confirmPayment(h.pool, p.id);
  expect(r.referral).toMatchObject({ bonus: 1, referrer: { id: h.AGENCY_A, credited: false } });
  expect(await daysLeft(h.AGENCY_A)).toBeGreaterThanOrEqual(39);
  expect((await h.query("SELECT referral_credit_months FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].referral_credit_months).toBe(0);
  // An agency that has already paid can't be linked any more.
  await h.query("UPDATE agencies SET referred_by = NULL, referral_rewarded_at = NULL WHERE id = $1", [h.AGENCY_B]);
  expect(await Referrals.link(h.pool, h.AGENCY_B, code)).toEqual({ error: "paid" });
});
