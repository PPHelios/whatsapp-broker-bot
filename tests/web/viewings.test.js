// tests/web/viewings.test.js — Phase 2 step 6: viewing scheduler (client confirm page, broker alert, calendar links)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Viewings = require("../../services/viewings");
const Stages = require("../../domain/leadStages");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const broker = () => h.BROKERS.broker;
const future = (days = 2, hour = 15) => Stages.cairoDayAt(new Date(), days, hour);

async function lead(fields = {}) {
  const r = await Leads.captureLead(h.pool, broker(), { name: "Mona Adel", phone: "01001234567", lawfulBasis: "client_request", ...fields }, { quiet: true });
  return r.lead;
}

async function scheduleOnPage(agent, csrf, l, body = {}) {
  return agent
    .post(`/app/leads/L-${String(l.ref).padStart(4, "0")}/viewing`)
    .set("X-CSRF-Token", csrf)
    .type("form")
    .send({ version: l.version, at: Stages.toCairoLocal(future()), unit: "HP-7", place: "بوابة 3", ...body });
}

const tokenOf = (wa) => decodeURIComponent(wa).match(/\/app\/v\/([A-Za-z0-9_-]+)/)[1];

describe("scheduling a viewing", () => {
  test("the broker sets it on the lead page → the follow-up becomes the viewing and WhatsApp opens with the confirm link", async () => {
    await h.insertListing({ code: "HP-7", compound: "Hyde Park", property_type: "apartment", area_value: 150 });
    const l = await lead();
    const { agent, csrf } = await signIn(h, "broker");
    const r = await scheduleOnPage(agent, csrf, l);
    expect(r.status).toBe(303);
    expect(r.headers.location).toMatch(/^https:\/\/wa\.me\/201001234567\?text=/);
    const text = decodeURIComponent(r.headers.location);
    expect(text).toMatch(/أهلاً Mona/);
    expect(text).toMatch(/Hyde Park/);
    expect(text).toMatch(/بوابة 3/);
    const [after] = await h.query("SELECT * FROM leads WHERE id = $1", [l.id]);
    expect(after).toMatchObject({ follow_up_kind: "viewing", follow_up_status: "open" });
    const [v] = await h.query("SELECT * FROM viewings WHERE lead_id = $1", [l.id]);
    expect(v).toMatchObject({ status: "proposed", place: "بوابة 3" });
    // Only the hash of the link's token is kept.
    expect(v.token_hash).not.toBe(tokenOf(r.headers.location));

    const page = await agent.get(`/app/leads/L-${String(l.ref).padStart(4, "0")}`);
    expect(page.text).toMatch(/id="viewing"[\s\S]*data-viewing-status="proposed"/);
    expect(page.text).toMatch(/calendar\.google\.com/);
  });

  test("a new viewing replaces the open one (its old link stops working); a past time or another agency's unit is refused", async () => {
    const l = await lead();
    const a = await Viewings.schedule(h.pool, broker(), l.id, { at: future() });
    const b = await Viewings.schedule(h.pool, broker(), l.id, { at: future(3) });
    expect(b.ok).toBe(true);
    expect((await Viewings.byToken(h.pool, tokenOf(a.url))).status).toBe("cancelled");
    expect((await request(h.app.app).get(new URL(a.url).pathname)).status).toBe(410);
    expect((await Viewings.schedule(h.pool, broker(), l.id, { at: new Date(Date.now() - 3 * 3600 * 1000) })).error).toBe("past");
    const rival = await h.insertListing({ code: "R-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
    expect((await Viewings.schedule(h.pool, broker(), l.id, { at: future(), listing: rival })).error).toBe("unit_not_found");
    expect((await Viewings.schedule(h.pool, h.BROKERS.rival, l.id, { at: future() })).error).toBe("not_found");
  });
});

describe("the client's page", () => {
  test("shows the agency, broker, time, unit and place but nothing about the client; confirm alerts the broker", async () => {
    await h.insertListing({ code: "HP-7", compound: "Hyde Park", property_type: "apartment", area_value: 150 });
    const [unit] = await h.query("SELECT * FROM listings WHERE code = 'HP-7'");
    const l = await lead({ notes: "سري جداً" });
    const s = await Viewings.schedule(h.pool, broker(), l.id, { at: future(), listing: unit, place: "بوابة 3" });
    const path = new URL(s.url).pathname;
    const page = await request(h.app.app).get(path);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/Hyde Park/);
    expect(page.text).toMatch(/بوابة 3/);
    expect(page.text).toMatch(new RegExp(broker().name));
    expect(page.text).not.toMatch(/Mona|01001234567|سري جداً/);
    expect(page.headers["x-robots-tag"] || page.text).toMatch(/noindex/);

    const r = await request(h.app.app).post(path).type("form").send({ action: "confirm" });
    expect(r.status).toBe(303);
    expect((await request(h.app.app).get(path)).text).toMatch(/data-status="confirmed"/);
    const [n] = await h.query("SELECT * FROM notifications WHERE broker_id = $1 AND lead_id = $2 ORDER BY created_at DESC LIMIT 1", [broker().id, l.id]);
    expect(n.title).toMatch(/أكّد المعاينة|confirmed the viewing/);
  });

  test("asking for another time stores the suggestion and note and tells the broker; a past suggestion is refused", async () => {
    const l = await lead({ lang: "en" });
    const s = await Viewings.schedule(h.pool, broker(), l.id, { at: future() });
    const path = new URL(s.url).pathname;
    expect((await request(h.app.app).get(path)).text).toMatch(/Your viewing/);
    const bad = await request(h.app.app).post(path).type("form").send({ action: "reschedule", at: "2020-01-01T10:00" });
    expect(bad.status).toBe(400);
    const ok = await request(h.app.app).post(path).type("form").send({ action: "reschedule", at: Stages.toCairoLocal(future(4, 18)), note: "after work please" });
    expect(ok.status).toBe(303);
    const [v] = await h.query("SELECT * FROM viewings WHERE lead_id = $1", [l.id]);
    expect(v).toMatchObject({ status: "reschedule", client_note: "after work please" });
    expect(new Date(v.client_proposed_at).getTime()).toBe(future(4, 18).getTime());
    const [n] = await h.query("SELECT * FROM notifications WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1", [l.id]);
    expect(n.body).toMatch(/after work please/);
  });

  test("the calendar file is a valid one-hour event in UTC; Google Calendar gets the same times", async () => {
    const l = await lead();
    const at = future();
    const s = await Viewings.schedule(h.pool, broker(), l.id, { at, place: "Gate 3, Hyde Park; New Cairo" });
    const r = await request(h.app.app).get(`${new URL(s.url).pathname}/calendar.ics`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/calendar/);
    const ics = r.text;
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    expect(ics).toContain(`DTSTART:${stamp(at)}`);
    expect(ics).toContain(`DTEND:${stamp(new Date(at.getTime() + 3600000))}`);
    expect(ics).toContain("LOCATION:Gate 3\\, Hyde Park\\; New Cairo");
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    const g = new URL(Viewings.googleCalendarUrl(Viewings.calendarEntry({ ...s.viewing, agency_name: "X" })));
    expect(g.searchParams.get("dates")).toBe(`${stamp(at)}/${stamp(new Date(at.getTime() + 3600000))}`);
  });

  test("unknown or malformed links are 404; a link more than a day past is gone", async () => {
    expect((await request(h.app.app).get("/app/v/nope")).status).toBe(404);
    expect((await request(h.app.app).get("/app/v/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    const l = await lead();
    const s = await Viewings.schedule(h.pool, broker(), l.id, { at: future() });
    await h.query("UPDATE viewings SET starts_at = now() - interval '2 days'");
    expect((await request(h.app.app).get(new URL(s.url).pathname)).status).toBe(410);
    expect((await request(h.app.app).post(new URL(s.url).pathname).type("form").send({ action: "confirm" })).status).toBe(410);
  });

  test("erasing the lead deletes its viewings", async () => {
    const l = await lead();
    await Viewings.schedule(h.pool, broker(), l.id, { at: future() });
    await h.query("DELETE FROM leads WHERE id = $1", [l.id]);
    expect(await h.query("SELECT * FROM viewings")).toHaveLength(0);
  });
});
