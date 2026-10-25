// tests/web/interest-form.test.js — Phase 2 step 2: the "I'm interested" form on a public unit page makes a lead for
// the broker who shared the link (source "Unit link", consent recorded) and alerts them; consent is required, the
// honeypot keeps nothing, a cross-site post is refused, and it is rate-limited.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness, textOf } = require("../harness/app");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const linkIn = (text) => (String(text).match(/http:\/\/localhost:3000(\/agency-alpha\/[^?\s]+\?s=[A-Za-z0-9_-]+)/) || [])[1];
async function sharedLink() {
  await h.insertListing({ code: "PUB-1", compound: "Hyde Park", price_value: 8.5e6, area_value: 150, bedrooms: 3 });
  const path = linkIn(textOf(await h.text("broker", "عميل PUB-1")));
  if (!path) throw new Error("no link in the client copy");
  return path;
}
const post = (path, body, headers = {}) => request(h.app.app).post(path).set(headers).type("form").send(body);

test("the form shows on an active unit and a submission becomes the sharing broker's lead, with an alert", async () => {
  const path = await sharedLink();
  const page = await request(h.app.app).get(path);
  expect(page.text).toContain('id="interest"');
  expect(page.text).toContain('name="consent"');

  const res = await post(path, { name: "Mona", phone: "01011112222", message: "Is it still available?", consent: "1" });
  expect(res.status).toBe(303);
  expect(res.headers.location).toMatch(/sent=1#interest$/);
  const [lead] = await h.query("SELECT * FROM leads WHERE agency_id = $1", [h.AGENCY_A]);
  expect(lead).toMatchObject({ name: "Mona", phone_e164: "+201011112222", source: "Unit link", lawful_basis: "consent", assigned_broker_id: h.BROKERS.broker.id });
  expect(lead.consent_at).not.toBeNull();
  expect(lead.notes).toContain("PUB-1");
  const [alert] = await h.query("SELECT kind, title FROM notifications WHERE broker_id = $1 AND kind = 'hot_client'", [h.BROKERS.broker.id]);
  expect(alert.title).toContain("PUB-1");

  const thanks = await request(h.app.app).get(res.headers.location.replace(/#.*$/, ""));
  expect(thanks.text).toMatch(/وصلنا طلبك|We got your request/);
  expect(thanks.text).not.toContain('name="consent"');
});

test("no consent, no name or a bad phone keep nothing; the honeypot looks fine but keeps nothing", async () => {
  const path = await sharedLink();
  expect((await post(path, { name: "Mona", phone: "01011112222" })).status).toBe(400);
  expect((await post(path, { name: "", phone: "01011112222", consent: "1" })).status).toBe(400);
  expect((await post(path, { name: "Mona", phone: "123", consent: "1" })).status).toBe(400);
  const bot = await post(path, { name: "Spam", phone: "01011112222", consent: "1", website: "http://spam" });
  expect(bot.status).toBe(303);
  expect(await h.query("SELECT 1 FROM leads")).toEqual([]);
});

test("a cross-site post is refused and the form is rate-limited per visitor", async () => {
  const path = await sharedLink();
  expect((await post(path, { name: "Mona", phone: "01011112222", consent: "1" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  for (let i = 0; i < 5; i++) expect((await post(path, { name: `C${i}`, phone: `0101111222${i}`, consent: "1" })).status).toBe(303);
  expect((await post(path, { name: "C9", phone: "01011112229", consent: "1" })).status).toBe(429);
  expect((await h.query("SELECT count(*)::int AS n FROM leads"))[0].n).toBe(5);
});

test("a sold unit shows no form and refuses a post", async () => {
  const path = await sharedLink();
  await h.query("UPDATE listings SET status = 'sold' WHERE code = 'PUB-1'");
  expect((await request(h.app.app).get(path)).text).not.toContain('id="interest"');
  expect((await post(path, { name: "Mona", phone: "01011112222", consent: "1" })).status).toBe(410);
  expect(await h.query("SELECT 1 FROM leads")).toEqual([]);
});
