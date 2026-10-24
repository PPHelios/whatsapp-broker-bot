// tests/router/edits.test.js — Release 1 step 6: quick updates (text, voice, button) and staged edits
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf, FALLBACK_AR } = require("../harness/app");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const OLD = "2026-01-01T00:00:00.000Z";
const row = async (code) => (await h.query("SELECT * FROM listings WHERE code = $1", [code]))[0];
const ids = (replies) => replies.flatMap((r) => r.buttons || []).map((b) => b.id);

describe("Quick updates by text (plan verification #3)", () => {
  test("'اتباعت VIL-08' marks the unit sold, sets confirmed_at and removes it from search", async () => {
    await h.insertListing({ code: "VIL-08", compound: "Villette", property_type: "villa", confirmed_at: OLD });
    const out = await h.text("broker", "اتباعت VIL-08");
    expect(textOf(out)).toMatch(/VIL-08 اتسجلت \*مباعة\*/);
    expect(out).toHaveLength(1);
    const l = await row("VIL-08");
    expect(l.status).toBe("sold");
    expect(new Date(l.confirmed_at).getTime()).toBeGreaterThan(new Date(OLD).getTime());
    expect(l.version).toBe(2);

    h.AI.respond(() => ({ intent: "search", filters: { compound: "Villette" } }));
    expect(textOf(await h.text("broker", "فيليت"))).not.toMatch(/VIL-08/);
  });

  test.each([["VIL-08 اتباعت"], ["sold vil-08"], ["تم البيع VIL-08"], ["مباعة #VIL-08"]])("'%s' also sells", async (msg) => {
    await h.insertListing({ code: "VIL-08" });
    await h.text("broker", msg);
    expect((await row("VIL-08")).status).toBe("sold");
  });

  test("without a code, the unit looked at last is updated", async () => {
    await h.insertListing({ code: "VIL-08" });
    await h.text("broker", "#VIL-08");
    await h.text("broker", "اتباعت");
    expect((await row("VIL-08")).status).toBe("sold");
  });

  test("archive and 'still available' (confirms availability)", async () => {
    await h.insertListing({ code: "A-1", confirmed_at: OLD });
    await h.text("broker", "أرشفة A-1");
    expect((await row("A-1")).status).toBe("archived");
    const out = textOf(await h.text("broker", "لسه متاحة A-1"));
    expect(out).toMatch(/متاحة/);
    const l = await row("A-1");
    expect(l.status).toBe("active");
    expect(l.version).toBe(3);
  });

  test("price: 'سعر CODE X', 'تعديل سعر CODE إلى X' (A5), 'price CODE to X'", async () => {
    await h.insertListing({ code: "HP-201", price_value: 8.5e6 });
    await h.text("broker", "سعر HP-201 9 مليون");
    expect((await row("HP-201")).price_value).toBe(9e6);
    await h.text("broker", "تعديل سعر HP-201 إلى 9.5 مليون");
    expect((await row("HP-201")).price_value).toBe(9.5e6);
    const out = await h.text("admin", "price HP-201 to 10M");
    expect((await row("HP-201")).price_value).toBe(10e6);
    expect(ids(out)).toContain("client:HP-201");
  });

  test("an unknown code says so; no fallback bubble", async () => {
    const out = textOf(await h.text("broker", "اتباعت NOPE-1"));
    expect(out).toMatch(/غير موجودة/);
    expect(out).not.toMatch(FALLBACK_AR);
  });
});

describe("Quick updates by voice and by button", () => {
  test("a spoken 'اتباعت VIL-08' sells without running a search", async () => {
    await h.insertListing({ code: "VIL-08" });
    h.AI.respond((c) => (c.operation === "transcribe" ? "اتباعت VIL-08" : { intent: "search", filters: {} }));
    const out = await h.voice("broker");
    expect((await row("VIL-08")).status).toBe("sold");
    expect(h.AI.calls.filter((c) => c.operation === "search_parse")).toHaveLength(0);
    expect(textOf(out)).toMatch(/مباعة/);
  });

  test("card → Update menu → Sold", async () => {
    await h.insertListing({ code: "HP-201" });
    const card = await h.text("broker", "#HP-201");
    expect(ids(card)).toEqual(["client:HP-201", "flyer:en:dark:HP-201", "qu_menu:HP-201"]);
    const menu = await h.tap("broker", "qu_menu:HP-201");
    expect(menu[0].type).toBe("list");
    expect(menu[0].sections[0].rows.map((r) => r.id)).toEqual(["qu:available:HP-201", "qu:sold:HP-201", "qu:archive:HP-201", "qu:edit:HP-201"]);
    await h.pick("broker", "qu:sold:HP-201");
    expect((await row("HP-201")).status).toBe("sold");
  });
});

describe("Authorization (lib/authz.js)", () => {
  test("a broker cannot change a colleague's unit; an admin can", async () => {
    await h.insertListing({ code: "C-1", broker_id: h.BROKERS.colleague.id });
    expect(textOf(await h.text("broker", "اتباعت C-1"))).toMatch(/صلاحية/);
    expect((await row("C-1")).status).toBe("active");
    await h.text("admin", "sold C-1");
    expect((await row("C-1")).status).toBe("sold");
  });

  test("another agency's unit is not found", async () => {
    await h.insertListing({ code: "C-1" });
    expect(textOf(await h.text("rival", "اتباعت C-1"))).toMatch(/غير موجودة/);
    expect((await row("C-1")).status).toBe("active");
  });
});

describe("Staged edits (A3, A4, optimistic locking)", () => {
  const extraction = (over) => ({ code: null, features: [], features_other: [], delivery: {}, resale: {}, primary: {}, ...over });

  test("A3: 'تعديل CODE <instructions>' reviews the change, then saves it", async () => {
    await h.insertListing({ code: "HP-201", price_value: 8.5e6, bedrooms: 3 });
    h.AI.respond(() => extraction({ price_value: 9e6 }));
    const review = await h.text("broker", "تعديل HP-201 السعر 9 مليون");
    expect(textOf(review)).toMatch(/التعديلات: السعر/);
    expect(textOf(review)).toMatch(/9 مليون/);
    expect(ids(review)).toEqual(["edit_confirm", "edit_cancel"]);
    expect((await row("HP-201")).price_value).toBe(8.5e6); // nothing saved before confirm

    const saved = await h.tap("broker", "edit_confirm");
    expect(textOf(saved)).toMatch(/تم حفظ التعديل/);
    expect(textOf(saved)).not.toMatch(/⚠️/);
    const l = await row("HP-201");
    expect(l).toMatchObject({ price_value: 9e6, bedrooms: 3, version: 2 });
  });

  test("A4: multi-turn edit — text and voice join the edit; unstated fields stay as they were", async () => {
    await h.insertListing({ code: "HP-201", bedrooms: 3, area_value: 150, feature_keys: ["corner"] });
    await h.text("broker", "تعديل HP-201");
    await h.text("broker", "بقت بحري");
    await h.voice("broker");
    expect(h.AI.calls.filter((c) => c.operation === "search_parse")).toHaveLength(0);
    h.AI.respond(() => extraction({ features: ["north_facing"], delivery: { year: 2027 } }));
    const review = await h.text("broker", "تم");
    const call = h.AI.calls.find((c) => c.operation === "listing_extraction");
    expect(JSON.stringify(call.contents)).toContain("بقت بحري");
    expect(JSON.stringify(call.contents)).toContain("inlineData");
    expect(textOf(review)).toMatch(/التعديلات: .*التسليم/);
    await h.tap("broker", "edit_confirm");
    const l = await row("HP-201");
    expect(l).toMatchObject({ bedrooms: 3, area_value: 150, delivery_year: 2027, feature_keys: ["north_facing", "corner"], market: "resale" });
  });

  test("a change made meanwhile is never overwritten: confirm reports a conflict, review again works", async () => {
    await h.insertListing({ code: "HP-201", price_value: 8.5e6, bedrooms: 3 });
    h.AI.respond(() => extraction({ bedrooms: 4 }));
    await h.text("broker", "تعديل HP-201 4 غرف");
    await h.text("admin", "price HP-201 9M"); // another person changes the unit
    const conflict = await h.tap("broker", "edit_confirm");
    expect(textOf(conflict)).toMatch(/اتعدلت من شخص تاني/);
    expect(await row("HP-201")).toMatchObject({ price_value: 9e6, bedrooms: 3 });

    await h.tap("broker", "edit_review");
    await h.tap("broker", "edit_confirm");
    expect(await row("HP-201")).toMatchObject({ price_value: 9e6, bedrooms: 4, version: 3 });
  });

  test("a primary unit stays primary when edited", async () => {
    await h.insertListing({ code: "DEV-9", market: "primary", inventory_type: "primary_unit", payment_terms: { plans: [{ plan_id: "p1", years: 8, down_payment_pct: 10 }] } });
    h.AI.respond(() => extraction({ features: ["corner"] }));
    await h.text("broker", "تعديل DEV-9 ناصية");
    await h.tap("broker", "edit_confirm");
    const l = await row("DEV-9");
    expect(l.market).toBe("primary");
    expect(l.payment_terms.plans).toHaveLength(1);
    expect(l.feature_keys).toEqual(["corner"]);
  });

  test("with the AI down, a price edit still works through the local parser", async () => {
    await h.insertListing({ code: "HP-201", price_value: 8.5e6 });
    h.AI.respond(() => new Error("503 UNAVAILABLE"));
    await h.text("broker", "تعديل HP-201");
    await h.text("broker", "السعر بقى 9 مليون");
    await h.text("broker", "تم");
    await h.tap("broker", "edit_confirm");
    expect((await row("HP-201")).price_value).toBe(9e6);
  });

  test("cancel leaves the unit unchanged and ends the session", async () => {
    await h.insertListing({ code: "HP-201", price_value: 8.5e6 });
    h.AI.respond(() => extraction({ price_value: 1e6 }));
    await h.text("broker", "تعديل HP-201 السعر مليون");
    expect(textOf(await h.tap("broker", "edit_cancel"))).toMatch(/تم إلغاء التعديل/);
    expect((await row("HP-201")).price_value).toBe(8.5e6);
    expect(await h.session("broker", "edit")).toBeNull();
  });

  test("a colleague cannot open an edit on someone else's unit", async () => {
    await h.insertListing({ code: "C-1", broker_id: h.BROKERS.colleague.id });
    expect(textOf(await h.text("broker", "تعديل C-1"))).toMatch(/صلاحية/);
    expect(await h.session("broker", "edit")).toBeNull();
  });
});
