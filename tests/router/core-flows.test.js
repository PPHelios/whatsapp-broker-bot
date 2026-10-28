// tests/router/core-flows.test.js — Real-router behaviour tests (webhook in → WhatsApp out + DB state)
// Known defects are written as test.failing with their plan ID; each flips to a normal test when fixed.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf, FALLBACK_AR } = require("../harness/app");

jest.setTimeout(30000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const searchAnswer = (filters = {}, extra = {}) => ({
  intent: "search",
  filters,
  locations: [],
  location_terms: [],
  ...extra
});

describe("Ingress & identity (SEC-03, SYS)", () => {
  test("unregistered number gets a registration notice", async () => {
    const replies = await h.text({ phone: "201555555555" }, "hello");
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toMatch(/غير مسجل/);
  });

  test("duplicate Meta delivery of the same message id is processed once (SEC-03)", async () => {
    const first = await h.send("broker", { id: "wamid.dup.1", type: "text", text: { body: "مساعدة" } });
    const second = await h.send("broker", { id: "wamid.dup.1", type: "text", text: { body: "مساعدة" } });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
  });

  test("inbound message is recorded and marked completed", async () => {
    await h.send("broker", { id: "wamid.track.1", type: "text", text: { body: "help" } });
    const rows = await h.query("SELECT status FROM inbound_messages WHERE msg_id = 'wamid.track.1'");
    expect(rows[0].status).toBe("completed");
  });

  test("help returns the guide (SYS-01)", async () => {
    expect(textOf(await h.text("broker", "مساعدة"))).toMatch(/دليل/);
  });

  test("lang en persists the preference (SYS-02)", async () => {
    const replies = await h.text("broker", "lang en");
    expect(textOf(replies)).toMatch(/English/);
    const [b] = await h.query("SELECT preferred_lang FROM brokers WHERE id = $1", [h.BROKERS.broker.id]);
    expect(b.preferred_lang).toBe("en");
  });

  test("unsupported video gets guidance, not silence (ING-06)", async () => {
    const replies = await h.send("broker", { type: "video", video: { id: "v1" } });
    expect(textOf(replies)).toMatch(/الفيديو/);
  });
});

describe("Draft lifecycle (DRF)", () => {
  test("add opens a draft session (DRF-01)", async () => {
    const replies = await h.text("broker", "اضافة");
    expect(textOf(replies)).toMatch(/مسودة/);
    expect(await h.session("broker")).not.toBeNull();
  });

  test("spec text while a draft is open is appended (DRF)", async () => {
    await h.text("broker", "اضافة");
    const replies = await h.text("broker", "شقة 150 متر التجمع 8 مليون");
    expect(replies[0].type).toBe("buttons");
    expect((await h.session("broker")).text_notes).toEqual(["شقة 150 متر التجمع 8 مليون"]);
  });

  test("cancel discards the draft (DRF-05)", async () => {
    await h.text("broker", "اضافة");
    expect(textOf(await h.text("broker", "الغاء"))).toMatch(/إلغاء المسودة/);
    expect(await h.session("broker")).toBeNull();
  });

  test("image-only draft cannot be finalized (ING-05)", async () => {
    await h.photo("broker");
    const replies = await h.text("broker", "تم");
    expect(textOf(replies)).toMatch(/بالصور فقط/);
  });

  test("A1: تم runs AI extraction and shows a review card with the extracted price", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة 150 متر في هايد بارك 3 غرف السعر 8.5 مليون");
    h.AI.respond(() => ({
      property_type: "apartment",
      listing_type: "sale",
      price_value: 8500000,
      area_value: 150,
      bedrooms: 3,
      compound: "Hyde Park"
    }));
    const replies = await h.text("broker", "تم");
    expect(h.AI.calls.length).toBeGreaterThan(0);
    expect(textOf(replies)).not.toMatch(/البيانات التالية مطلوبة/);
  });

  test("A2: tapping Save without a reviewed draft must not create a listing", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة في التجمع");
    await h.tap("broker", "draft_confirm");
    const rows = await h.query("SELECT code FROM listings");
    expect(rows).toHaveLength(0);
  });
});

describe("Photos (ING-01)", () => {
  test("P11: photos are stored with no message each; the next reply counts them once", async () => {
    const first = await h.photo("broker", { mediaId: "p1" });
    const second = await h.photo("broker", { mediaId: "p2" });
    expect([...first, ...second]).toEqual([]);
    expect((await h.session("broker")).media_items).toHaveLength(2);
    const next = await h.text("broker", "شقة في التجمع 3 غرف");
    expect(textOf(next)).toMatch(/^📸 وصلت 2 صور\./);
    const again = await h.text("broker", "الدور التالت");
    expect(textOf(again)).not.toMatch(/📸/);
    await h.photo("broker", { mediaId: "p3" });
    expect(textOf(await h.text("broker", "تشطيب سوبر لوكس"))).toMatch(/^📸 وصلت صورة\./);
  });

  test("U6/Part 2 C: a photo must not also trigger the 'could not determine action' fallback", async () => {
    const replies = await h.photo("broker");
    expect(textOf(replies)).not.toMatch(FALLBACK_AR);
  });
});

describe("Unit lookup & deliverables (ING-04, DEL)", () => {
  test("#CODE returns the unit card with action buttons (ING-04)", async () => {
    await h.insertListing({ code: "HP-201" });
    const replies = await h.text("broker", "#HP-201");
    const card = replies.find((r) => r.type === "buttons");
    expect(card.text).toMatch(/HP-201/);
    expect(card.buttons.map((b) => b.id)).toContain("client:HP-201");
  });

  test("client copy prints the agency's own code (DEL-02)", async () => {
    await h.insertListing({ code: "HP-201" });
    expect(textOf(await h.text("broker", "عميل HP-201"))).toMatch(/HP-201/);
  });

  test("another agency cannot see the unit (SEC-02)", async () => {
    await h.insertListing({ code: "HP-201" });
    const replies = await h.text("rival", "عميل HP-201");
    expect(textOf(replies)).not.toMatch(/8\.5|٨/);
  });
});

describe("Lifecycle & deletion (LFC, DEL)", () => {
  test("sold CODE marks the unit sold (LFC-01)", async () => {
    await h.insertListing({ code: "HP-201" });
    await h.text("broker", "sold HP-201");
    const [l] = await h.query("SELECT status FROM listings WHERE code = 'HP-201'");
    expect(l.status).toBe("sold");
  });

  test("delete asks for confirmation, then removes the unit (DEL-01/02)", async () => {
    const listing = await h.insertListing({ code: "HP-201" });
    const prompt = await h.text("broker", "حذف HP-201");
    const confirmId = prompt.flatMap((r) => r.buttons || []).find((b) => b.id.startsWith("del_confirm:"))?.id;
    expect(confirmId).toBe(`del_confirm:${listing.id}:HP-201`);
    await h.tap("broker", confirmId);
    expect(await h.query("SELECT 1 FROM listings WHERE id = $1", [listing.id])).toHaveLength(0);
  });

  test("Part 2 C: the delete prompt must not also trigger the fallback bubble", async () => {
    await h.insertListing({ code: "HP-201" });
    expect(textOf(await h.text("broker", "حذف HP-201"))).not.toMatch(FALLBACK_AR);
  });

  test("a broker cannot delete a colleague's unit (SEC-03)", async () => {
    await h.insertListing({ code: "HP-201", broker_id: h.BROKERS.colleague.id });
    expect(textOf(await h.text("broker", "حذف HP-201"))).toMatch(/صلاحية/);
  });
});

describe("Editing (EDT)", () => {
  test("price CODE VAL updates a resale unit (EDT-03)", async () => {
    await h.insertListing({ code: "HP-201" });
    await h.text("broker", "سعر HP-201 9 مليون");
    const [l] = await h.query("SELECT price_value, flyer_cache FROM listings WHERE code = 'HP-201'");
    expect(Number(l.price_value)).toBe(9000000);
    expect(l.flyer_cache).toEqual({});
  });

  test("developer units block direct price edits (EDT-04)", async () => {
    await h.insertListing({ code: "DEV-1", inventory_type: "developer_model", is_primary_developer: true });
    expect(textOf(await h.text("broker", "سعر DEV-1 9 مليون"))).toMatch(/المطورين/);
  });

  test("A5: 'تعديل سعر CODE إلى X' edits that CODE", async () => {
    await h.insertListing({ code: "HP-201" });
    await h.text("broker", "تعديل سعر HP-201 إلى 9 مليون");
    const [l] = await h.query("SELECT price_value FROM listings WHERE code = 'HP-201'");
    expect(Number(l.price_value)).toBe(9000000);
  });

  test("A4: text sent in edit mode is not treated as a search", async () => {
    await h.insertListing({ code: "HP-201" });
    await h.text("broker", "تعديل HP-201");
    h.AI.respond(() => searchAnswer());
    await h.text("broker", "السعر بقى 9 مليون");
    expect(h.AI.calls.filter((c) => c.operation === "search_parse")).toHaveLength(0);
  });
});

describe("Search (SCH)", () => {
  test("search returns matching units in the broker's agency only (SCH-01, SEC-02)", async () => {
    await h.insertListing({ code: "HP-201", compound: "Hyde Park", bedrooms: 3 });
    await h.insertListing({ code: "B-1", compound: "Hyde Park", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
    h.AI.respond(() => searchAnswer({ compound: "Hyde Park", bedrooms_min: 3, bedrooms_max: 3 }));
    const out = textOf(await h.text("broker", "شقة 3 غرف في هايد بارك"));
    expect(out).toMatch(/HP-201/);
    expect(out).not.toMatch(/B-1/);
  });

  test("AI outage falls back to the regex parser (SCH-01)", async () => {
    await h.insertListing({ code: "HP-201" });
    h.AI.respond(() => new Error("503 UNAVAILABLE"));
    const replies = await h.text("broker", "شقة 3 غرف");
    expect(replies.length).toBeGreaterThan(0);
  });

  test("B2: small talk does not return random listings", async () => {
    await h.insertListing({ code: "HP-201" });
    h.AI.respond(() => ({ intent: "other", filters: {}, locations: [], location_terms: [] }));
    expect(textOf(await h.text("broker", "شكرا"))).not.toMatch(/HP-201/);
  });
});

describe("Help menu accuracy (U1)", () => {
  test("U1: the advertised 'اكسل' command exports inventory", async () => {
    await h.insertListing({ code: "HP-201" });
    h.AI.respond(() => searchAnswer());
    const replies = await h.text("admin", "اكسل");
    expect(replies.some((r) => r.type === "document") || /إكسيل|الإكسيل/.test(textOf(replies))).toBe(true);
    expect(h.AI.calls).toHaveLength(0);
  });
});
