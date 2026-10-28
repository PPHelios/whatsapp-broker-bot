// tests/router/draft-pipeline.test.js — Release 1 step 3: add by voice/text → review → confirm → stored row
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf, FALLBACK_AR, settle } = require("../harness/app");

jest.setTimeout(30000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

// Extraction answer in the new prompt shape (see lib/listing.js buildListingPrompt).
const extraction = (over = {}) => ({
  code: null,
  listing_type: "sale",
  market: "resale",
  property_type: "apartment",
  compound: "ميفيدا",
  compound_en: "Mivida",
  area_value: 200,
  bedrooms: 3,
  bathrooms: null,
  price_value: 10000000,
  delivery: { ready: null, year: null, quarter: null, month: null, raw: null },
  features: ["north_facing", "corner", "nanny_room"],
  features_other: [],
  resale: { cash_paid: 4000000, remaining_amount: 6000000, installment_amount: 250000, installment_frequency: "quarterly", installment_years: 6 },
  primary: {},
  ...over
});

function answerExtraction(fields) {
  h.AI.respond((call) => {
    if (call.operation === "listing_extraction") return fields;
    return { intent: "search", filters: {}, locations: [], location_terms: [] };
  });
}

const buttonsOf = (replies) => replies.flatMap((r) => r.buttons || []).map((b) => b.id);
const listings = () => h.query("SELECT * FROM listings ORDER BY created_at");

describe("P13: the review card flags a unit already listed", () => {
  test("a warning with the unit's link on the same card; Confirm becomes Save anyway and saves", async () => {
    await h.insertListing({ code: "MV-OLD", compound: "ميفيدا", area_value: 205, bedrooms: 3, price_value: 9.8e6 });
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة في ميفيدا 200 متر 3 غرف 10 مليون");
    answerExtraction(extraction());
    const [working, ...review] = await h.text("broker", "تم");
    expect(working.text).toMatch(/بنراجع بيانات الوحدة/); // the working-on-it line, then the one card
    expect(review).toHaveLength(1);
    expect(textOf(review)).toMatch(/شكلها نفس الوحدة MV-OLD[\s\S]*\/app\/units\/MV-OLD/);
    expect(review[0].buttons.find((b) => b.id === "draft_confirm").title).toBe("احفظ برضه ✅");
    await h.tap("broker", "draft_confirm");
    expect(await listings()).toHaveLength(2);
  });
});

describe("Add by voice → review → confirm (plan verification #1)", () => {
  test("resale installment unit 'بحري ناصية فيها غرفة مربية', no delivery", async () => {
    await h.text("broker", "اضافه") // F4: spelling-blind command;
    await h.voice("broker");
    answerExtraction(extraction());

    const review = await h.text("broker", "تم");
    const call = h.AI.calls.find((c) => c.operation === "listing_extraction");
    expect(JSON.stringify(call.contents)).toContain("inlineData"); // the voice note went to the model
    const card = textOf(review);
    expect(card).toMatch(/بحري/);
    expect(card).toMatch(/ناصية/);
    expect(card).toMatch(/غرفة مربية/);
    // Review is the only place warnings appear.
    expect(card).toMatch(/⚠️ موعد التسليم \(أو استلام فوري\) غير مسجل/);
    expect(buttonsOf(review)).toEqual(["draft_confirm", "draft_edit", "draft_cancel"]);

    const saved = await h.tap("broker", "draft_confirm");
    const out = textOf(saved);
    expect(out).toMatch(/تم الحفظ/);
    expect(out).toMatch(/بحري · ناصية · غرفة مربية/);
    expect(out).not.toMatch(/⚠️/);
    expect(out).not.toMatch(/تسليم/);
    expect(out).not.toMatch(FALLBACK_AR);

    const [row] = await listings();
    expect(row).toMatchObject({
      agency_id: h.AGENCY_A,
      broker_id: h.BROKERS.broker.id,
      status: "active",
      property_type: "apartment",
      listing_type: "sale",
      market: "resale",
      compound: "ميفيدا",
      compound_en: "Mivida",
      area_value: 200,
      bedrooms: 3,
      price_value: 10000000,
      down_payment_value: 4000000,
      remaining_amount: 6000000,
      installment_value: 250000,
      payment_frequency: "quarterly",
      installment_years: 6,
      delivery_year: null,
      is_ready: null,
      feature_keys: ["north_facing", "corner", "nanny_room"]
    });
    expect(row.confirmed_at).not.toBeNull();
    expect(row.installments_end).not.toBeNull();
    expect(row.code).toBe("AL-A1"); // Agency Alpha: initials AL, A for apartment, the agency's first auto code
    expect(await h.session("broker")).toBeNull();
  });
});

describe("Add by text", () => {
  test("delivery and features are stored in top-level columns", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة في هايد بارك 150 متر 3 غرف 2 حمام الدور الرابع تشطيب كامل تسليم 2027 Q3 فيو جاردن 8.5 مليون كاش");
    answerExtraction(
      extraction({
        compound: "هايد بارك",
        compound_en: "Hyde Park",
        area_value: 150,
        bathrooms: 2,
        floor: "الرابع",
        floor_level: 4,
        finishing: "fully_finished",
        price_value: 8500000,
        delivery: { year: 2027, quarter: 3, raw: "2027 Q3" },
        features: ["view_garden"],
        resale: {}
      })
    );
    const review = await h.text("broker", "تم");
    expect(textOf(review)).toMatch(/🗓 تسليم 2027 Q3/);
    // Only the photos warning: every other field was stated.
    expect(textOf(review).match(/⚠️.*/g)).toEqual(["⚠️ الصور غير مسجل"]);
    await h.tap("broker", "draft_confirm");
    const [row] = await listings();
    expect(row).toMatchObject({
      delivery_year: 2027,
      delivery_quarter: 3,
      floor_level: 4,
      finishing: "fully_finished",
      bathrooms: 2,
      feature_keys: ["view_garden"],
      remaining_amount: null
    });
  });

  test("a code stated in the text is used", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "كود VIL-08 فيلا");
    answerExtraction(extraction({ property_type: "villa", bedrooms: 5, resale: {} }));
    await h.text("broker", "تم");
    await h.tap("broker", "draft_confirm");
    const [row] = await listings();
    expect(row.code).toBe("VIL-08");
  });

  test("a studio gets 0 bedrooms automatically; an office has none", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "استوديو");
    answerExtraction(extraction({ property_type: "studio", bedrooms: null, resale: {} }));
    await h.text("broker", "تم");
    await h.tap("broker", "draft_confirm");
    await h.text("broker", "اضافة");
    await h.text("broker", "مكتب");
    answerExtraction(extraction({ property_type: "office", bedrooms: 2, resale: {} }));
    await h.text("broker", "تم");
    await h.tap("broker", "draft_confirm");
    const rows = await listings();
    expect(rows.map((r) => [r.property_type, r.bedrooms])).toEqual([
      ["studio", 0],
      ["office", null]
    ]);
  });
});

describe("Only the staged review is committed (A2)", () => {
  test("missing mandatory fields: no confirm button and confirm does not save", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة في التجمع");
    answerExtraction(extraction({ compound: null, district: null, price_value: null, resale: {} }));
    const review = await h.text("broker", "تم");
    expect(textOf(review)).toMatch(/ناقص لإتمام الحفظ/);
    expect(textOf(review)).toMatch(/السعر/);
    expect(buttonsOf(review)).toEqual(["DRAFT_SAVE", "draft_cancel"]);
    await h.tap("broker", "draft_confirm");
    expect(await listings()).toHaveLength(0);
  });

  test("new input after the review invalidates it: confirm re-reviews instead of saving", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة");
    answerExtraction(extraction({ resale: {} }));
    await h.text("broker", "تم");
    await h.text("broker", "والسعر بقى 9 مليون");
    const before = h.AI.calls.length;
    const replies = await h.tap("broker", "draft_confirm");
    expect(h.AI.calls.length).toBe(before + 1);
    expect(textOf(replies)).toMatch(/مراجعة قبل الحفظ/);
    expect(await listings()).toHaveLength(0);
    await h.tap("broker", "draft_confirm");
    expect(await listings()).toHaveLength(1);
  });

  test("a double tap saves once", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة");
    answerExtraction(extraction({ resale: {} }));
    await h.text("broker", "تم");
    await h.tap("broker", "draft_confirm", "تأكيد");
    const second = await h.send("broker", {
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "draft_confirm", title: "x" } }
    });
    expect(await listings()).toHaveLength(1);
    expect(textOf(second)).toMatch(/انتهت صلاحية|مسبقاً/);
  });

  test("taps in quick succession: the repeat is dropped silently and recorded as ignored", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة");
    answerExtraction(extraction({ resale: {} }));
    await h.text("broker", "تم");
    await h.tap("broker", "draft_confirm", "تأكيد");
    h.sameMoment();
    const second = await h.tap("broker", "draft_confirm", "تأكيد");
    expect(second).toEqual([]);
    expect(await listings()).toHaveLength(1);
    const statuses = (await h.query("SELECT status FROM inbound_messages ORDER BY received_at")).map((r) => r.status);
    expect(statuses.filter((x) => x === "ignored")).toHaveLength(1);
  });

  test("two taps at once (the second arrives while the first runs): only the first runs", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة");
    answerExtraction(extraction({ resale: {} }));
    await h.text("broker", "تم");
    const tap = () =>
      h.app.handleWebhookBody({
        entry: [{ changes: [{ value: { messages: [{ from: h.BROKERS.broker.phone, id: `wamid.dbl.${Math.random()}`, timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "draft_confirm", title: "x" } } }] } }] }]
      });
    await Promise.all([tap(), tap()]);
    await settle();
    expect(await listings()).toHaveLength(1);
    expect((await h.query("SELECT count(*)::int AS n FROM inbound_messages WHERE status = 'ignored'"))[0].n).toBe(1);
  });
});

describe("Code collision never overwrites", () => {
  test("a used code replies 'الكود مستخدم', keeps the existing unit and the draft", async () => {
    const existing = await h.insertListing({ code: "HP-201", price_value: 7000000 });
    await h.text("broker", "اضافة");
    await h.text("broker", "كود HP-201 شقة");
    answerExtraction(extraction({ resale: {} }));
    await h.text("broker", "تم");
    const replies = await h.tap("broker", "draft_confirm");
    expect(textOf(replies)).toMatch(/مستخدم/);
    const rows = await listings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: existing.id, price_value: 7000000 });
    expect(await h.session("broker")).not.toBeNull();
  });

  test("lower-case and Arabic-digit variants of a used code also collide", async () => {
    await h.insertListing({ code: "VIL-08" });
    await h.text("broker", "اضافة");
    await h.text("broker", "كود vil-٠٨ فيلا");
    answerExtraction(extraction({ property_type: "villa", resale: {} }));
    await h.text("broker", "تم");
    expect(textOf(await h.tap("broker", "draft_confirm"))).toMatch(/مستخدم/);
    expect(await listings()).toHaveLength(1);
  });
});

describe("Photos go to storage at ingest", () => {
  test("the draft keeps a URL, not the image bytes; the listing links the photos", async () => {
    await h.text("broker", "اضافة");
    await h.photo("broker");
    await h.photo("broker");
    const session = await h.session("broker");
    expect(session.media_items).toHaveLength(2);
    expect(session.media_items.every((m) => m.url && !m.base64)).toBe(true);
    expect(h.Storage.objects.size).toBe(2);

    await h.text("broker", "شقة");
    answerExtraction(extraction({ resale: {} }));
    await h.text("broker", "تم");
    await h.tap("broker", "draft_confirm");
    const imgs = await h.query("SELECT position, url FROM listing_images ORDER BY position");
    expect(imgs.map((i) => i.position)).toEqual([0, 1]);
    expect(imgs.map((i) => i.url)).toEqual(session.media_items.map((m) => m.url));
  });

  test("no photos: the review warns, the saved card does not", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة");
    answerExtraction(extraction({ resale: {} }));
    expect(textOf(await h.text("broker", "تم"))).toMatch(/⚠️ الصور غير مسجل/);
  });
});

describe("Photo ceiling and items WhatsApp can't pass on", () => {
  test("17 photos: 15 kept and one limit warning, not one per extra photo", async () => {
    await h.text("broker", "add");
    const warnings = [];
    for (let i = 0; i < 17; i++) warnings.push(...(await h.photo("broker")));
    expect((await h.session("broker")).media_items).toHaveLength(15);
    const limit = warnings.filter((r) => /15/.test(textOf([r])));
    expect(limit).toHaveLength(1);
  });

  test("an unsupported item inside a draft says it wasn't added, not the welcome", async () => {
    await h.text("broker", "add");
    const replies = await h.send("broker", {
      type: "unsupported",
      errors: [{ code: 131051, title: "Message type unknown" }]
    });
    expect(textOf(replies)).toMatch(/مسودة|draft/);
    expect(textOf(replies)).not.toMatch(/أهلاً|Welcome/);
  });

  test("an unsupported item outside a draft gets a generic notice", async () => {
    const replies = await h.send("broker", { type: "unsupported", errors: [{ code: 131051 }] });
    expect(textOf(replies)).toMatch(/غير مدعوم|not supported/);
  });
});

describe("Installments are asked, not assumed", () => {
  const gapOnly = () =>
    extraction({ property_type: "townhouse", area_value: 300, bedrooms: 4, price_value: 15e6, resale: { cash_paid: 13e6 } });

  test("total 15M, cash 13M: the review asks; Yes stores 2M remaining without another AI call", async () => {
    await h.text("broker", "add");
    await h.text("broker", "townhouse hyde park 15M requested 13M");
    answerExtraction(gapOnly());
    const review = await h.text("broker", "done");
    expect(textOf(review)).toMatch(/الباقي 2 مليون أقساط/);
    expect(buttonsOf(review)).toEqual(["draft_inst_yes", "draft_inst_no", "draft_cancel"]);

    const calls = h.AI.calls.length;
    const answered = await h.tap("broker", "draft_inst_yes");
    expect(h.AI.calls.length).toBe(calls);
    expect(textOf(answered)).toMatch(/تفاصيل الأقساط/);
    expect(buttonsOf(answered)).toEqual(["draft_confirm", "draft_edit", "draft_cancel"]);
    await h.tap("broker", "draft_confirm");
    const [row] = await listings();
    expect(Number(row.remaining_amount)).toBe(2e6);
    expect(Number(row.price_value)).toBe(15e6);
  });

  test("No: 13M is the cash price, no installment lines", async () => {
    await h.text("broker", "add");
    await h.text("broker", "townhouse hyde park 15M requested 13M");
    answerExtraction(gapOnly());
    await h.text("broker", "done");
    const answered = await h.tap("broker", "draft_inst_no");
    expect(textOf(answered)).not.toMatch(/أقساط/);
    await h.tap("broker", "draft_confirm");
    const [row] = await listings();
    expect(Number(row.price_value)).toBe(13e6);
    expect(row.remaining_amount === null || Number(row.remaining_amount) === 0).toBe(true);
  });
});

describe("Extraction failure keeps the draft", () => {
  test("AI outage: the broker is told, the draft survives, retry works", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة");
    h.AI.respond(() => new Error("503 UNAVAILABLE"));
    const replies = await h.text("broker", "تم");
    expect(textOf(replies)).toMatch(/المسودة محفوظة/);
    expect(await h.session("broker")).not.toBeNull();
    answerExtraction(extraction({ resale: {} }));
    await h.tap("broker", "DRAFT_SAVE");
    await h.tap("broker", "draft_confirm");
    expect(await listings()).toHaveLength(1);
  });
});

describe("F6: compound names snap to known ones", () => {
  test("«هاييد بارك» as the AI heard it is saved as «هايد بارك» and the card says so", async () => {
    await h.text("broker", "اضافة");
    await h.text("broker", "شقة في هاييد بارك 200 متر 3 غرف 10 مليون");
    answerExtraction(extraction({ compound: "هاييد بارك", compound_en: "Hyde Park" }));
    const review = await h.text("broker", "تم");
    expect(textOf(review)).toContain("اسم الكمبوند اتصحح: هاييد بارك ← هايد بارك");
    await h.tap("broker", "draft_confirm");
    expect((await listings())[0].compound).toBe("هايد بارك");
  });
});
