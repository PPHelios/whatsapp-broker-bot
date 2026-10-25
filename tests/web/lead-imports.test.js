// tests/web/lead-imports.test.js — Importing clients from a file (Release 3 step 6): preview before any write, dedupe
// within the file and against the database, colleague rows never reassigned, erased phones flagged, the lawful-basis
// tick, one apply (a second is 409), round-robin, .xlsx with a formula cell, a 2,000-row file in the background with
// progress, one summary notification, tenant isolation and the upload rate limit.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const LeadImports = require("../../services/leadImports");
const RateLimit = require("../../lib/rateLimit");

jest.setTimeout(180000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const send = (agent, csrf, buf, { name = "clients.csv", type = "text/csv", basis = "client_request", confirm = "1", roundRobin = null } = {}) => {
  let r = agent.post("/app/leads/import").field("_csrf", csrf).field("basis", basis);
  if (confirm) r = r.field("confirm", confirm);
  if (roundRobin) r = r.field("round_robin", "1");
  return r.attach("file", Buffer.isBuffer(buf) ? buf : Buffer.from(buf), { filename: name, contentType: type });
};
const idOf = (res) => res.headers.location.split("/").pop();
const leadCount = async () => Number((await h.query("SELECT count(*)::int AS n FROM leads"))[0].n);
const apply = async (agent, csrf, id) => {
  const r = await agent.post(`/app/leads/import/${id}/apply`).type("form").send({ _csrf: csrf });
  await LeadImports.waitForApply(id);
  return r;
};

const CSV = [
  "﻿الاسم;الموبايل;رقم تاني;نوع العميل;المصدر;الميزانية;المنطقة;نوع العقار;الغرف;ملاحظات;المرحلة",
  "سارة;01012345678;;مشتري;فيسبوك;7-9 مليون;التجمع;شقة;3;عايزة تسليم قريب;مهتم",
  "عمر;0111 111 1111;;مستأجر;;25 ألف;;;;;",
  "سارة تاني;+20 101 234 5678;;;;;;;;;", // the same number as row 2
  "مين;123;;;;;;;;;",
  "قديم;01222222222;01099999999;;OLX;;;;;ملاحظة جديدة;", // already saved, without a source
  "زميل;01033333333;;;;;;;;;", // a colleague's client
  "ممسوح;01044444444;;;;;;;;;" // erased before
].join("\r\n");

async function seed() {
  await Leads.captureLead(h.pool, await row("broker"), { phones: "01222222222", name: "Old Client" });
  await Leads.captureLead(h.pool, await row("colleague"), { phones: "01033333333", name: "Their Client" });
  await h.query("INSERT INTO lead_erasures (agency_id, phone_hash) VALUES ($1, $2)", [h.BROKERS.broker.agency_id, Leads.phoneHash("+201044444444")]);
}

describe("preview", () => {
  test("Arabic headers, a BOM and semicolons; every row kind; nothing is written before apply", async () => {
    await seed();
    const before = await leadCount();
    const { agent, csrf } = await signIn(h, "broker");
    const r = await send(agent, csrf, CSV);
    expect(r.status).toBe(303);
    const page = await agent.get(r.headers.location);
    expect(page.status).toBe(200);
    const kindOf = (n) => (page.text.match(new RegExp(`data-kind="(\\w+)"(?:(?!data-kind).)*?data-row="${n}"`, "s")) || [])[1];
    expect([2, 3, 4, 5, 6, 7, 8].map(kindOf)).toEqual(["new", "new", "repeated", "invalid", "merge", "colleague", "erased_before"]);
    expect(page.text).toContain("زي صف 2");
    expect(page.text).toMatch(/L-0001[^<]*هيتكمّل: المصدر، الملاحظات، رقم جديد/);
    expect(page.text).not.toContain("Their Client");
    expect(await leadCount()).toBe(before);
    const ops = await h.query("SELECT metadata FROM operation_logs WHERE operation_type = 'web_import_plan'");
    expect(JSON.stringify(ops)).not.toMatch(/01012345678|سارة/);
  });

  test("the lawful-basis tick is required; a file without a phone column is refused", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const r = await send(agent, csrf, "name,phone\nSara,01012345678\n", { confirm: null });
    expect(r.status).toBe(422);
    expect(r.text).toMatch(/لازم تختار الأساس القانوني/);
    const bad = await send(agent, csrf, "name,city\nSara,Cairo\n");
    expect(bad.status).toBe(422);
    expect(bad.text).toMatch(/مش لاقيين عمود الموبايل/);
    expect(await h.query("SELECT 1 FROM web_imports")).toHaveLength(0);
  });

  test("CSRF is required", async () => {
    const { agent } = await signIn(h, "broker");
    const r = await agent.post("/app/leads/import").field("basis", "consent").field("confirm", "1").attach("file", Buffer.from("name,phone\nx,01012345678"), { filename: "a.csv", contentType: "text/csv" });
    expect(r.status).toBe(403);
  });
});

describe("apply", () => {
  test("creates and merges once; merge fills blanks only; colleague not reassigned; a second apply is 409", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "broker");
    const id = idOf(await send(agent, csrf, CSV, { basis: "consent" }));
    const r = await apply(agent, csrf, id);
    expect(r.status).toBe(303);
    const done = await agent.get(`/app/leads/import/${id}`);
    expect(done.text).toContain("data-result");
    expect(done.text).toMatch(/عملاء جداد: 2/);
    expect(done.text).toMatch(/اتحدّثوا: 1/);

    const sara = (await h.query("SELECT * FROM leads WHERE phone_e164 = '+201012345678'"))[0];
    expect(sara).toMatchObject({ name: "سارة", kind: "buyer", source: "فيسبوك", stage: "interested", lawful_basis: "consent", assigned_broker_id: h.BROKERS.broker.id, notes: "عايزة تسليم قريب" });
    const req = await h.query("SELECT data FROM lead_events WHERE lead_id = $1 AND kind = 'request_set'", [sara.id]);
    expect(req[0].data.filters).toMatchObject({ property_types: ["apartment"], price_min: 7000000, price_max: 9000000, bedrooms_min: 3 });
    expect((await h.query("SELECT kind FROM leads WHERE phone_e164 = '+201111111111'"))[0].kind).toBe("tenant");

    const old = (await h.query("SELECT * FROM leads WHERE phone_e164 = '+201222222222'"))[0];
    expect(old).toMatchObject({ name: "Old Client", source: "OLX", notes: "ملاحظة جديدة", phones: ["+201222222222", "+201099999999"] });
    const theirs = (await h.query("SELECT * FROM leads WHERE phone_e164 = '+201033333333'"))[0];
    expect(theirs).toMatchObject({ assigned_broker_id: h.BROKERS.colleague.id, name: "Their Client" });
    expect(await h.query("SELECT 1 FROM leads WHERE phones @> ARRAY['+201044444444']")).toHaveLength(0);

    const again = await agent.post(`/app/leads/import/${id}/apply`).type("form").send({ _csrf: csrf });
    expect(again.status).toBe(409);
    // The file's names and phones are dropped once applied.
    const stored = await h.query("SELECT payload FROM web_imports WHERE id = $1", [id]);
    expect(JSON.stringify(stored[0].payload)).not.toMatch(/0101|سارة/);
    // One log line for the import (no per-row lines), with counts only.
    const ops = await h.query("SELECT operation_type, metadata FROM operation_logs WHERE operation_type IN ('lead_import', 'lead_capture') AND broker_id = $1 ORDER BY id", [h.BROKERS.broker.id]);
    expect(ops.map((o) => o.operation_type)).toEqual(["lead_capture", "lead_import"]); // the seed's own capture, then the import
    expect(ops[1].metadata).toMatchObject({ created: 2, merged: 1, colleague: 0, erased_before: 0, failed: 0 }); // colleague rows are left out of the apply
    expect(JSON.stringify(ops)).not.toMatch(/0101|سارة/);
  });

  test("a manager's import: the assigned column, round-robin for the rest (even), one notification per assignee", async () => {
    const { agent, csrf } = await signIn(h, "admin");
    const lines = ["Name,Phone,Assigned to"];
    lines.push("Fixed,01055555550,Broker Two");
    for (let i = 1; i <= 6; i++) lines.push(`Client ${i},0105555555${i},`);
    const id = idOf(await send(agent, csrf, lines.join("\n"), { roundRobin: true }));
    const page = await agent.get(`/app/leads/import/${id}`);
    expect(page.text).toContain("🧑‍💼 Broker Two");
    await apply(agent, csrf, id);
    const counts = await h.query("SELECT assigned_broker_id AS b, count(*)::int AS n FROM leads GROUP BY 1 ORDER BY 1");
    expect(counts).toEqual([
      { b: h.BROKERS.broker.id, n: 3 },
      { b: h.BROKERS.colleague.id, n: 4 }
    ]);
    const notes = await h.query("SELECT broker_id, kind FROM notifications WHERE kind = 'assignment' ORDER BY broker_id");
    expect(notes).toEqual([
      { broker_id: h.BROKERS.broker.id, kind: "assignment" },
      { broker_id: h.BROKERS.colleague.id, kind: "assignment" }
    ]);
  });

  test("a broker's import never assigns to someone else", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const id = idOf(await send(agent, csrf, "Name,Phone,Assigned to\nX,01066666666,Broker Two\n", { roundRobin: true }));
    await apply(agent, csrf, id);
    expect((await h.query("SELECT assigned_broker_id FROM leads"))[0].assigned_broker_id).toBe(h.BROKERS.broker.id);
  });

  test(".xlsx with English headers; a formula cell gives its value, never the formula", async () => {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet("Leads");
    s.addRow(["Name", "Phone", "Lead type", "Notes"]);
    s.addRow(["Sara", "01012345678", "Tenant", { formula: 'HYPERLINK("http://evil","x")', result: "x" }]);
    s.addRow(["=cmd|' /C calc'!A0", 1112345678, "", ""]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const { agent, csrf } = await signIn(h, "broker");
    const id = idOf(await send(agent, csrf, buf, { name: "c.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    await apply(agent, csrf, id);
    const leads = await h.query("SELECT name, phone_e164, kind, notes FROM leads ORDER BY ref");
    expect(leads).toEqual([
      { name: "Sara", phone_e164: "+201012345678", kind: "tenant", notes: "x" },
      { name: "=cmd|' /C calc'!A0", phone_e164: "+201112345678", kind: "buyer", notes: null }
    ]);
  });

  test("2,000 rows run in the background with progress", async () => {
    const lines = ["name,phone"];
    for (let i = 0; i < 2000; i++) lines.push(`Client ${i},010${String(10000000 + i)}`);
    const { agent, csrf } = await signIn(h, "admin");
    const id = idOf(await send(agent, csrf, lines.join("\n")));
    // Hold the job after 50 rows so the page can be seen mid-way.
    const real = Leads.captureLead;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let n = 0;
    let reached;
    const atFifty = new Promise((resolve) => (reached = resolve));
    const spy = jest.spyOn(Leads, "captureLead").mockImplementation(async (...args) => {
      if (++n === 51) {
        reached();
        await gate;
      }
      return real(...args);
    });
    try {
      const r = await agent.post(`/app/leads/import/${id}/apply`).type("form").send({ _csrf: csrf });
      expect(r.status).toBe(303);
      await atFifty;
      const running = await agent.get(`/app/leads/import/${id}`);
      expect(running.text).toMatch(/<progress max="2000" value="50">/);
      expect(running.text).toContain('hx-trigger="every 2s"');
      expect((await agent.post(`/app/leads/import/${id}/apply`).type("form").send({ _csrf: csrf })).status).toBe(409);
      release();
      await LeadImports.waitForApply(id);
    } finally {
      spy.mockRestore();
    }
    expect(await leadCount()).toBe(2000);
    expect((await agent.get(`/app/leads/import/${id}`)).text).toMatch(/New leads: 2000/);
  });
});

describe("isolation and limits", () => {
  test("another broker or agency can't see or apply a plan", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const id = idOf(await send(agent, csrf, "name,phone\nSara,01012345678\n"));
    for (const who of ["colleague", "rival"]) {
      const o = await signIn(h, who);
      expect((await o.agent.get(`/app/leads/import/${id}`)).status).toBe(404);
      expect((await o.agent.post(`/app/leads/import/${id}/apply`).type("form").send({ _csrf: o.csrf })).status).toBe(404);
    }
    expect(await leadCount()).toBe(0);
  });

  test("the rival agency's leads are not merged into", async () => {
    await Leads.captureLead(h.pool, await row("rival"), { phones: "01012345678", name: "Rival Client" });
    const { agent, csrf } = await signIn(h, "broker");
    const id = idOf(await send(agent, csrf, "name,phone\nSara,01012345678\n"));
    expect((await agent.get(`/app/leads/import/${id}`)).text).toMatch(/data-kind="new"/);
  });

  test("the upload rate limit", async () => {
    for (let i = 0; i < RateLimit.LIMITS.uploadBroker.limit; i++) await RateLimit.hit(h.pool, `upload:broker:${h.BROKERS.broker.id}`, RateLimit.LIMITS.uploadBroker);
    const { agent, csrf } = await signIn(h, "broker");
    expect((await send(agent, csrf, "name,phone\nSara,01012345678\n")).status).toBe(429);
  });

  test("the template downloads", async () => {
    const { agent } = await signIn(h, "broker");
    const r = await agent.get("/app/leads/import/template.xlsx").buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    expect(wb.worksheets[0].getRow(1).getCell(2).text).toBe("Phone / الموبايل");
  });
});
