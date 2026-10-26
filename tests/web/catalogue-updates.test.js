// tests/web/catalogue-updates.test.js — Release A C4: smart quick updates to the catalogue (rules first, AI fallback),
// a preview with the unit count and an example, apply, Undo within 24 hours; website and Telegram; managers only
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const Updates = require("../../services/catalogueUpdates");
const U = require("../../domain/catalogueUpdate");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  h = await createHarness();
  h.AI.reset();
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  await closeHarness();
});

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code = $1", [code]))[0];

async function seed() {
  const admin = await row("admin");
  const p = (await Catalogue.saveProject(h.pool, admin, { name: "بادية", name_en: "Badya", delivery_year: "2028" })).project;
  const ph = (await Catalogue.savePhase(h.pool, admin, p.id, { name: "Phase 2" })).phase;
  const cat = { broker_id: null, market: "primary", details: { catalogue: true }, project_id: p.id, inventory_type: "primary_unit", compound: "Badya" };
  await h.insertListing({ ...cat, code: "BD-1", developer_unit_code: "B12-304", price_value: 9200000 });
  await h.insertListing({ ...cat, code: "BD-2", developer_unit_code: "B12-404", price_value: 9300000, phase_id: ph.id });
  await h.insertListing({ code: "HP-9", price_value: 5000000, project_id: p.id, payment_terms: { plans_own: true, plans: [] } }); // a broker's resale unit, linked
  return { admin, project: p, phase: ph };
}

describe("reading the sentence", () => {
  test("plain sentences are read by rules (no AI call); dates come from Cairo's today", () => {
    const t = "2026-10-26";
    expect(U.parseRules("زيادة ٧٪ على بادية من الشهر الجاي", t)).toMatchObject({ action: "increase", pct: 7, effective_on: "2026-11-01", date_given: true });
    expect(U.parseRules("5% cut on Badya Phase 2 from 1/12", t)).toMatchObject({ action: "increase", pct: -5, effective_on: "2026-12-01" });
    expect(U.parseRules("B12-304 و B12-404 اتباعت", t)).toMatchObject({ action: "status", status: "sold", codes: ["B12-304", "B12-404"] });
    expect(U.parseRules("سعر B12-304 9.5 مليون", t)).toMatchObject({ action: "price", codes: ["B12-304"], price: 9500000 });
    expect(U.parseRules("خطة جديدة 5% مقدم 8 سنين على بادية", t)).toMatchObject({ action: "plan", plan: { down_payment_pct: 5, years: 8, name: "5% / 8y" } });
    expect(U.parseRules("ابعتلي الأسعار", t)).toBeNull();
    expect(U.parseDate("15 مارس", t)).toBe("2027-03-15");
  });
});

describe("preview, apply, undo", () => {
  test("an increase today: the card counts catalogue units only with an example; apply moves them; undo restores them", async () => {
    const { admin } = await seed();
    const out = await Updates.interpret(h.pool, admin, { text: "زيادة 10% على بادية" });
    expect(out.ok).toBe(true);
    expect(h.AI.calls).toHaveLength(0);
    expect(out.update).toMatchObject({ action: "increase", units: 2, example: { code: "BD-1", before: 9200000, after: 10120000 } });
    expect(Updates.card(out.update, "en").lines.join("\n")).toMatch(/no date was said, so from today/);
    expect(Number((await unit("BD-1")).price_value)).toBe(9200000); // nothing changes before Apply

    const applied = await Updates.apply(h.pool, admin, out.update.id);
    expect(applied).toMatchObject({ ok: true, changed: 2 });
    expect(Number((await unit("BD-1")).price_value)).toBe(10120000);
    expect(Number((await unit("HP-9")).price_value)).toBe(5000000);
    expect((await Updates.apply(h.pool, admin, out.update.id)).error).toBe("not_found"); // once

    // BD-2 is changed by hand after the increase: Undo leaves it alone.
    await h.query("UPDATE listings SET price_value = 9999000 WHERE code = 'BD-2'");
    expect(await Updates.undo(h.pool, admin, out.update.id)).toEqual({ ok: true, restored: 1, skipped: 1 });
    expect(Number((await unit("BD-1")).price_value)).toBe(9200000);
    expect(Number((await unit("BD-2")).price_value)).toBe(9999000);
    expect((await Updates.undo(h.pool, admin, out.update.id)).error).toBe("too_late");
  });

  test("a later increase waits for its date; undo cancels it; a phase narrows it", async () => {
    const { admin, project } = await seed();
    const out = await Updates.interpret(h.pool, admin, { text: "7% increase on Badya Phase 2 from next month", now: new Date("2026-10-26T10:00:00Z") });
    expect(out.update).toMatchObject({ units: 1, payload: { effective_on: "2026-11-01", phase_name: "Phase 2" } });
    await Updates.apply(h.pool, admin, out.update.id, { now: new Date("2026-10-26T10:00:00Z") });
    const inc = (await h.query("SELECT * FROM price_increases WHERE project_id = $1", [project.id]))[0];
    expect(inc).toMatchObject({ status: "scheduled", effective_on: expect.anything() });
    await Updates.undo(h.pool, admin, out.update.id, { now: new Date("2026-10-26T11:00:00Z") });
    expect((await h.query("SELECT status FROM price_increases WHERE id = $1", [inc.id]))[0].status).toBe("cancelled");
  });

  test("sold by developer code, a price, and a plan; undo of each; nothing guessed", async () => {
    const { admin } = await seed();
    const sold = await Updates.interpret(h.pool, admin, { text: "B12-304 sold" });
    expect(sold.update).toMatchObject({ action: "status", units: 1, payload: { codes: ["BD-1"] } });
    await Updates.apply(h.pool, admin, sold.update.id);
    expect((await unit("BD-1")).status).toBe("sold");
    await Updates.undo(h.pool, admin, sold.update.id);
    expect((await unit("BD-1")).status).toBe("active");

    const price = await Updates.interpret(h.pool, admin, { text: "سعر B12-404 9.6 مليون" });
    await Updates.apply(h.pool, admin, price.update.id);
    expect(Number((await unit("BD-2")).price_value)).toBe(9600000);
    expect((await h.query("SELECT source FROM listing_prices WHERE listing_id = $1 ORDER BY id DESC LIMIT 1", [(await unit("BD-2")).id]))[0].source).toBe("quick");

    const plan = await Updates.interpret(h.pool, admin, { text: "new plan 10% down 8 years on Badya" });
    expect(plan.update).toMatchObject({ action: "plan", units: 2, example: { code: "BD-1", down_payment: 920000, installments: 32 } });
    await Updates.apply(h.pool, admin, plan.update.id);
    expect((await unit("BD-1")).payment_terms.plans.map((p) => p.name)).toEqual(["10% / 8y"]);
    await Updates.undo(h.pool, admin, plan.update.id);
    expect((await unit("BD-1")).payment_terms.plans).toEqual([]);

    expect((await Updates.interpret(h.pool, admin, { text: "زيادة 5%" })).error).toBe("no_project");
    expect(await Updates.interpret(h.pool, admin, { text: "ZZ-1 sold" })).toMatchObject({ error: "codes", missing: ["ZZ-1"] });
    expect((await Updates.interpret(h.pool, await row("broker"), { text: "زيادة 5% على بادية" })).error).toBe("forbidden");
  });

  test("other sentences go to one AI call (counted); its JSON is checked, never trusted blindly", async () => {
    const { admin } = await seed();
    h.AI.respond((call) => (call.operation === "catalogue_update" ? { action: "increase", project: "Badya", phase: null, codes: [], status: null, pct: 4, effective_on: "2026-13-40", price: null, plan: null } : null));
    const out = await Updates.interpret(h.pool, admin, { text: "المطور رافع الأسعار أربعة في المية في بادية", now: new Date("2026-10-26T10:00:00Z") });
    expect(h.AI.calls.map((c) => c.operation)).toEqual(["catalogue_update"]);
    expect(out.update).toMatchObject({ action: "increase", payload: { pct: 4, effective_on: "2026-10-26", date_given: false } });
    h.AI.respond(() => ({ action: "unknown" }));
    expect((await Updates.interpret(h.pool, admin, { text: "شكرا" })).error).toBe("not_understood");
  });
});

describe("the website and Telegram", () => {
  test("a manager reads, applies and undoes on the page; brokers can't open it", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "admin");
    expect((await agent.get("/app/catalogue")).text).toMatch(/data-quick-updates/);
    const r = await agent.post("/app/catalogue/updates").type("form").send({ _csrf: csrf, text: "B12-304 اتباعت" });
    expect(r.status).toBe(303);
    const card = (await agent.get(r.headers.location)).text;
    expect(card).toMatch(/data-update-status="preview"/);
    expect(card).toMatch(/data-cu-apply/);
    const applied = await agent.post(`${r.headers.location}/apply`).type("form").send({ _csrf: csrf });
    expect(applied.headers.location).toMatch(/changed=1/);
    expect((await agent.get(applied.headers.location)).text).toMatch(/data-cu-undo/);
    const undone = await agent.post(`${r.headers.location}/undo`).type("form").send({ _csrf: csrf });
    expect((await agent.get(undone.headers.location)).text).toMatch(/data-cu-undone="1"/);
    expect((await unit("BD-1")).status).toBe("active");

    const bad = await agent.post("/app/catalogue/updates").type("form").send({ _csrf: csrf, text: "زيادة 5%" });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/data-cu-error="no_project"/);

    // A voice note (the record button posts it with htmx): transcribed, then read by the same rules.
    h.AI.respond((call) => (call.operation === "transcribe" ? "تحديث B12-404 اتباعت" : null));
    const voice = await agent.post("/app/catalogue/updates").set("X-CSRF-Token", csrf).set("HX-Request", "true").attach("voice", Buffer.from("OggS fake"), { filename: "note", contentType: "audio/ogg" });
    expect(voice.status).toBe(200);
    expect(voice.text).toMatch(/id="cu-result"/);
    expect(voice.text).toMatch(/BD-2/);

    const broker = await signIn(h, "broker");
    expect((await broker.agent.get("/app/catalogue/updates")).status).toBe(403);
  });

  test("Telegram: «تحديث …» shows the card; Apply, then Undo; a broker's «تحديث» is not taken", async () => {
    await seed();
    await h.tgLink("admin", "broker");
    const card = await h.tgText("admin", "تحديث B12-304 اتباعت");
    const msg = card.find((m) => m.keyboard);
    expect(textOf(card)).toMatch(/BD-1/);
    const ok = msg.keyboard.flat().find((b) => b.callback_data.startsWith("cu:ok:"));
    const done = await h.tgTap("admin", ok.callback_data);
    expect(textOf(done)).toMatch(/1/);
    expect((await unit("BD-1")).status).toBe("sold");
    const undo = done.find((m) => m.keyboard).keyboard.flat().find((b) => b.callback_data.startsWith("cu:undo:"));
    await h.tgTap("admin", undo.callback_data);
    expect((await unit("BD-1")).status).toBe("active");
    expect(textOf(await h.tgTap("broker", ok.callback_data))).toMatch(/managers|للمديرين/);
  });
});
