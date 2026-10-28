// tests/crm/lead-intake.test.js — L1/L7/L8: per-agency intake URL (Make.com lead ads, forms): source, round robin,
// dedupe by phone and by the sender's lead id, test mode, log without phones, quiet alert, revoke
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const Intake = require("../../services/leadIntake");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const post = (url, body) => request(h.app.app).post(new URL(url, "http://local").pathname).send(body);
const metaLead = (over = {}) => ({
  id: "l:111",
  created_time: "2026-10-28T10:00:00+0200",
  platform: "ig",
  campaign_name: "Hyde Park Oct",
  field_data: [
    { name: "full_name", values: ["Mona Adel"] },
    { name: "phone_number", values: ["p:+201011112222"] },
    { name: "متى_تريد_الشراء؟", values: ["خلال 3 شهور"] }
  ],
  ...over
});

test("a Meta lead through Make: Instagram source, campaign and answers in notes, next broker in the round robin; a retry is taken once", async () => {
  const { url } = await Intake.create(h.pool, h.AGENCY_A, { name: "Facebook ads (Make)", source: "Facebook" });
  const r = await post(url, metaLead());
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, outcome: "created" });
  const [lead] = await h.query("SELECT * FROM leads WHERE phone_e164 = '+201011112222'");
  expect(lead).toMatchObject({ name: "Mona Adel", source: "Instagram", stage: "new", created_by_broker_id: null });
  expect(lead.notes).toContain("Campaign: Hyde Park Oct");
  expect(lead.notes).toContain("خلال 3 شهور");
  expect(lead.assigned_broker_id).toBeTruthy();
  const again = await post(url, metaLead());
  expect(again.body.outcome).toBe("repeat");
  expect(await h.query("SELECT 1 FROM leads")).toHaveLength(1);
  const log = await Intake.log(h.pool, h.AGENCY_A);
  expect(log.map((g) => g.outcome)).toEqual(["repeat", "created"]);
  expect(log[1].phone_tail).toBe("2222");
  expect(JSON.stringify(log)).not.toContain("1011112222");
});

test("the same phone again (a new form fill) merges into the lead and tells its broker; the intake source fills a missing platform", async () => {
  const { url } = await Intake.create(h.pool, h.AGENCY_A, { name: "Website form", source: "Website" });
  await post(url, { name: "Karim", phone: "01022223333" });
  const second = await post(url, { name: "Karim F", phone: "+201022223333", message: "Still available?" });
  expect(second.body.outcome).toBe("merged");
  const [lead] = await h.query("SELECT source, assigned_broker_id FROM leads");
  expect(lead.source).toBe("Website");
  const notes = await h.query("SELECT title FROM notifications WHERE broker_id = $1 AND title LIKE '%🔁%'", [lead.assigned_broker_id]);
  expect(notes).toHaveLength(1);
  expect(await Intake.sourcesFor(h.pool, h.AGENCY_A)).toContain("Website");
});

test("test mode keeps nothing; a bad phone is logged; a wrong or revoked URL is 404", async () => {
  const { url, intake } = await Intake.create(h.pool, h.AGENCY_A, { name: "Make", source: "Facebook" });
  expect((await post(url, { ...metaLead(), test: true })).body).toMatchObject({ ok: true, outcome: "test" });
  expect((await post(url, { name: "x", phone: "123" })).body).toMatchObject({ ok: false, outcome: "invalid" });
  expect(await h.query("SELECT 1 FROM leads")).toHaveLength(0);
  expect((await post(`${url}x`, metaLead())).status).toBe(404);
  await Intake.revoke(h.pool, intake.id);
  expect((await post(url, metaLead())).status).toBe(404);
});

test("a quiet intake alerts the managers once until a lead arrives", async () => {
  const { intake } = await Intake.create(h.pool, h.AGENCY_A, { name: "Make", source: "Facebook", quietDays: 2 });
  const later = new Date(Date.now() + 3 * 86400000);
  expect((await Intake.quietCheck(h.pool, { now: later })).counts.quiet).toBe(1);
  expect((await Intake.quietCheck(h.pool, { now: new Date(later.getTime() + 3600000) })).counts.quiet).toBe(0);
  const alerts = await h.query("SELECT 1 FROM notifications WHERE dedupe_key LIKE $1", [`intake_quiet:${intake.id}:%`]);
  expect(alerts.length).toBeGreaterThan(0);
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("intake_quiet");
});

describe("pages", () => {
  const { signIn } = require("../harness/web");
  const { resetConfig } = require("../../config");
  afterEach(() => {
    delete process.env.OWNER_BROKER_IDS;
    resetConfig();
  });

  test("the owner makes a URL (shown once, with Copy), tests it and stops it; managers see the source, its log and the filter", async () => {
    process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
    resetConfig();
    const { agent, csrf } = await signIn(h, "admin");
    const made = await agent.post("/app/owner/intake").type("form").send({ _csrf: csrf, agency: h.AGENCY_A, name: "Facebook ads (Make)", source: "Facebook", quiet_days: "3" });
    expect(made.status).toBe(200);
    const url = made.text.match(/value="([^"]*\/intake\/[A-Za-z0-9_-]+)"/)[1];
    expect(made.text).toContain("data-copy");
    const [intake] = await h.query("SELECT id FROM lead_intakes");
    expect((await agent.post(`/app/owner/intake/${intake.id}/test`).type("form").send({ _csrf: csrf })).text).toMatch(/Test passed|التجربة نجحت/);
    await post(url, { full_name: "Hany", phone_number: "01033334444", platform: "fb" });
    const sources = await agent.get("/app/sources");
    expect(sources.text).toContain('id="intake"');
    expect(sources.text).toMatch(/data-intake-log/);
    expect(sources.text).not.toContain("01033334444");
    await agent.post(`/app/owner/intake/${intake.id}/revoke`).type("form").send({ _csrf: csrf });
    expect((await post(url, { phone: "01033335555" })).status).toBe(404);
  });

  test("an agency's own sources show in the leads filter", async () => {
    await Intake.create(h.pool, h.AGENCY_A, { name: "Site", source: "Website form" });
    const { agent } = await signIn(h, "admin");
    expect((await agent.get("/app/leads")).text).toContain('<option value="Website form"');
    expect((await agent.get("/app/leads/new")).text).toContain('<option value="Website form"');
  });
});
