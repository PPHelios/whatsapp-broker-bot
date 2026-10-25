// tests/crm/privacy.test.js — The PDPL duties (Release 3 step 11): export (a zip with .json and .txt, nothing about
// other people, managers only, 10 an hour), erase (the last 4 digits; every CRM row gone, the deal kept without the
// client, a re-capture warns), retention (18 months, warned 30 days before, fixed clock), the payload purge (recent and
// pending rows spared, bootRecovery still works) and P3: no client name or phone in operation_logs, log lines, push
// payloads or wa_outbound metadata after the full flow.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const JSZip = require("jszip");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Requests = require("../../services/leadRequests");
const Deals = require("../../services/deals");
const Privacy = require("../../services/privacy");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const NAME = "Zebulon Sentinelson";
const PHONE = "01098761234";
const E164 = "+201098761234";
const HP = { listing_type: "sale", property_types: ["apartment"], places: [{ kind: "compound", key: "hyde_park" }], price_max: 9000000 };

async function fullClient() {
  const broker = await row("broker");
  const l = (await Leads.captureLead(h.pool, broker, { phones: PHONE, name: NAME, notes: "wants a garden" })).lead;
  await Requests.saveRequest(h.pool, broker, l.id, HP);
  await Leads.addNote(h.pool, broker, l.id, "called twice");
  await h.insertListing({ code: "HP-1" });
  await Deals.createDeal(h.pool, broker, { leadKey: l.id, unitCode: "HP-1", price: 8500000, mode: "pct", pct: 2 });
  // Someone else, who must never appear in the export.
  await Leads.captureLead(h.pool, await row("colleague"), { phones: "01155550000", name: "Other Person" });
  return l;
}

const unzip = async (buffer) => {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  return { names, json: JSON.parse(await zip.file(names.find((n) => n.endsWith(".json"))).async("string")), txt: await zip.file(names.find((n) => n.endsWith(".txt"))).async("string") };
};

test("export: the client's data in a zip (.json and .txt), nothing about other people; managers only, 10 an hour", async () => {
  const l = await fullClient();
  expect((await Privacy.exportLead(h.pool, await row("broker"), l.id)).error).toBe("forbidden");
  const r = await Privacy.exportLead(h.pool, await row("admin"), l.id);
  const { names, json, txt } = await unzip(r.zip);
  expect(names.sort()).toEqual(["client-L-0001.json", "client-L-0001.txt"]);
  expect(json.client).toMatchObject({ reference: "L-0001", name: NAME, phones: [E164], notes: "wants a garden", stage: "won" });
  expect(json.requests).toHaveLength(1);
  expect(json.deals).toEqual([expect.objectContaining({ reference: "D-0001", unit: "HP-1", price: 8500000 })]);
  expect(json.history.map((x) => x.what)).toEqual(expect.arrayContaining(["created", "note", "deal"]));
  const all = JSON.stringify(json) + txt;
  for (const other of ["Other Person", "01155550000", "Broker One", "Broker Two", "Agency Admin", h.BROKERS.broker.id, "commission", "170000"]) expect(all).not.toContain(other);
  expect(txt).toContain(NAME);
  expect(txt).toContain("called twice");
  expect((await h.query("SELECT 1 FROM lead_events WHERE kind = 'exported'")).length).toBe(1);

  // Web: no-store zip for a manager, 403 for a broker, 429 after 10 an hour.
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/leads/L-0001/export")).status).toBe(403);
  const a = await signIn(h, "admin");
  const res = await a.agent.get("/app/leads/L-0001/export").buffer(true).parse((resp, cb) => {
    const chunks = [];
    resp.on("data", (c) => chunks.push(c));
    resp.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  expect(res.status).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["content-type"]).toMatch(/application\/zip/);
  expect((await unzip(res.body)).json.client.name).toBe(NAME);
  for (let i = 0; i < 9; i++) await a.agent.get("/app/leads/L-0001/export");
  expect((await a.agent.get("/app/leads/L-0001/export")).status).toBe(429);
});

test("erase: the last 4 digits; every CRM row gone, the deal kept without the client, a re-capture warns; managers only", async () => {
  const l = await fullClient();
  await h.query("INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, body, lead_id) VALUES ($1, $2, 'follow_up', 'x1', $3, '', $4)", [h.AGENCY_A, h.BROKERS.broker.id, `📅 ${NAME}`, l.id]);
  await h.query("INSERT INTO notifications (agency_id, broker_id, kind, dedupe_key, title, body) VALUES ($1, $2, 'follow_up', 'x2', '📅 2 follow-ups', $3)", [h.AGENCY_A, h.BROKERS.broker.id, `• 10:00 · L-0001 ${NAME}\n• 11:00 · L-0002 Other Person`]);

  expect((await Privacy.eraseLead(h.pool, await row("broker"), l.id, { confirm: "1234" })).error).toBe("forbidden");
  expect((await Privacy.eraseLead(h.pool, await row("admin"), l.id, { confirm: "9999" })).error).toBe("confirm");
  expect(await h.query("SELECT 1 FROM leads WHERE id = $1", [l.id])).toHaveLength(1);

  const b = await signIn(h, "broker");
  expect((await b.agent.post("/app/leads/L-0001/erase").type("form").send({ _csrf: b.csrf, confirm: "1234" })).status).toBe(403);
  const a = await signIn(h, "admin");
  const res = await a.agent.post("/app/leads/L-0001/erase").type("form").send({ _csrf: a.csrf, confirm: "١٢٣٤" });
  expect(res.status).toBe(303);
  expect(res.headers.location).toBe("/app/leads?erased=L-0001");

  for (const table of ["leads", "lead_events", "saved_searches", "lead_matches"]) {
    expect(await h.query(`SELECT 1 FROM ${table} WHERE ${table === "leads" ? "id" : "lead_id"} = $1`, [l.id])).toHaveLength(0);
  }
  const [deal] = await h.query("SELECT * FROM deals");
  expect(deal).toMatchObject({ client_name: null, client_phone: null, lead_id: null, unit_code: "HP-1" });
  expect(await h.query("SELECT 1 FROM deal_splits")).toHaveLength(1);
  const notes = await h.query("SELECT title, body FROM notifications ORDER BY id");
  expect(JSON.stringify(notes)).not.toContain(NAME);
  expect(await h.query("SELECT 1 FROM lead_erasures")).toHaveLength(1);
  // A re-capture says the client asked to be deleted.
  expect((await Leads.captureLead(h.pool, await row("broker"), { phones: PHONE, name: NAME })).outcome).toBe("erased_before");
  // The other client is untouched.
  expect(await h.query("SELECT name FROM leads")).toEqual([{ name: "Other Person" }]);
});

test("retention: 18 months without activity erases (deal kept); 30 days before, managers are warned once a day", async () => {
  const now = new Date("2026-10-25T08:00:00Z");
  const old = await fullClient();
  const soon = (await Leads.captureLead(h.pool, await row("broker"), { phones: "01212345678", name: "Soon Gone" })).lead;
  const fresh = (await Leads.captureLead(h.pool, await row("broker"), { phones: "01512345678", name: "Fresh" })).lead;
  await h.query("UPDATE leads SET last_activity_at = '2025-04-01T00:00:00Z' WHERE id = $1", [old.id]);
  await h.query("UPDATE leads SET last_activity_at = '2025-05-10T00:00:00Z' WHERE id = $1", [soon.id]);
  await h.query("UPDATE leads SET last_activity_at = '2026-10-01T00:00:00Z' WHERE id = $1", [fresh.id]);

  const r = await Privacy.retentionSweep(h.pool, { now });
  expect(r).toMatchObject({ erased: 1, warned: 1, more: false });
  expect((await h.query("SELECT name FROM leads ORDER BY name")).map((x) => x.name)).toEqual(["Fresh", "Other Person", "Soon Gone"]);
  expect((await h.query("SELECT client_name FROM deals"))[0].client_name).toBeNull();
  const [warn] = await h.query("SELECT title FROM notifications WHERE kind = 'manager_alert' AND dedupe_key LIKE 'retention:%'");
  expect(warn.title).toMatch(/^🔒 1 clients will be erased within 30 days/);
  expect((await Privacy.retentionSweep(h.pool, { now: new Date(now.getTime() + 3600 * 1000) })).warned).toBe(0);
});

test("the payload purge clears handled rows after 7 days, spares recent and pending rows; bootRecovery still replays", async () => {
  const add = (id, status, ago) =>
    h.query(`INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, $3, $4, NOW() - $5::interval)`, [
      id,
      h.BROKERS.broker.phone,
      JSON.stringify({ from: h.BROKERS.broker.phone, id, type: "text", text: { body: "مساعدة" } }),
      status,
      ago
    ]);
  await add("old-done", "completed", "8 days");
  await add("old-failed", "failed", "9 days");
  await add("recent-done", "completed", "2 days");
  await add("pending", "new", "1 minute");
  expect((await Privacy.purgeInboundPayloads(h.pool)).purged).toBe(2);
  const rows = Object.fromEntries((await h.query("SELECT msg_id, payload FROM inbound_messages")).map((r) => [r.msg_id, r.payload]));
  expect(rows["old-done"]).toEqual({ purged: true });
  expect(rows["old-failed"]).toEqual({ purged: true });
  expect(rows["recent-done"].text.body).toBe("مساعدة");
  expect(rows.pending.text.body).toBe("مساعدة");
  await h.app.bootRecovery();
  const [p] = await h.query("SELECT status FROM inbound_messages WHERE msg_id = 'pending'");
  expect(p.status).not.toBe("new");
  expect(require("../../lib/jobs").buildJobs().map((j) => j.name)).toContain("privacy");
});

test("P3: after the full flow, no client name or phone in operation_logs, log lines, push payloads or wa_outbound metadata", async () => {
  const logs = [];
  const spies = ["log", "info", "warn", "error"].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.map(String).join(" "))));
  try {
    await h.Push.subscribe(h.pool, await row("broker"));
    // Alerts go to web push, so their payloads are checked too.
    await h.query(`UPDATE brokers SET notify_prefs = '{"quiet":{"enabled":false},"channels":{"match":"web","follow_up":"web","hot_client":"web","assignment":"web"}}' WHERE id = $1`, [h.BROKERS.broker.id]);
    await h.text("broker", "مساعدة");
    // Save by contact card, open, call, follow-up, request, a match alert, send to client, a deal, export and erase.
    const card = await h.send("broker", { type: "contacts", contacts: [{ name: { formatted_name: NAME }, phones: [{ phone: PHONE, type: "CELL" }] }] });
    const save = card.find((m) => m.to === h.BROKERS.broker.phone).buttons.find((b) => b.id.startsWith("ld:save:")).id;
    await h.tap("broker", save);
    await h.tap("broker", "ld:called:L-0001");
    await h.tap("broker", "ld:fuset:L-0001:1d");
    await Requests.saveRequest(h.pool, await row("broker"), 1, HP);
    await h.insertListing({ code: "HP-9" });
    await require("../../services/matchSweep").sweep(h.pool, { now: new Date(Date.now() + 2000), watermark: { at: new Date(Date.now() - 60000).toISOString() } });
    await h.tap("broker", "ld:send:L-0001:HP-9");
    await h.text("broker", "deal L-0001 HP-9 8.5M commission 2%");
    await Privacy.exportLead(h.pool, await row("admin"), 1);
    await Privacy.eraseLead(h.pool, await row("admin"), 1, { confirm: "1234" });
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  const digits = PHONE.slice(1);
  const bad = (s) => s.includes(NAME) || s.includes("Zebulon") || s.includes(digits) || s.includes(E164);
  const ops = await h.query("SELECT * FROM operation_logs");
  expect(ops.length).toBeGreaterThan(0);
  expect(ops.filter((o) => bad(JSON.stringify(o)))).toEqual([]);
  expect(logs.filter(bad)).toEqual([]);
  expect(h.Push.sent.length).toBeGreaterThan(0);
  expect(h.Push.sent.filter((p) => bad(p.raw))).toEqual([]);
});
