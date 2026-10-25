// tests/web/units.test.js — Release 2 step 5: add/edit form with photos and a voice button, on the same
// field rules, extraction and write path as WhatsApp
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const sharp = require("sharp");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(90000);

let h;
let jpeg;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 10, g: 90, b: 160 } } }).png().toBuffer();
});
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const FULL = {
  listing_type: "sale",
  market: "resale",
  property_type: "apartment",
  compound: "Hyde Park",
  price_value: "8.5 مليون",
  area_value: "150",
  bedrooms: "3",
  bathrooms: "2",
  floor_level: "4",
  finishing: "fully_finished",
  feature: ["north_facing", "corner"],
  features_other: "قريبة من النادي",
  down_payment_value: "3,000,000",
  remaining_amount: "5.5 مليون",
  installment_value: "250000",
  payment_frequency: "quarterly",
  installments_end: "2030-06",
  delivery_year: "2027",
  delivery_quarter: "3",
  owner_name: "Mr Owner",
  owner_phone: "01011112222"
};

/** Multipart POST with fields (arrays repeat) and optional files. */
function post(agent, url, csrf, fields = {}, { photos = [], voice = null, header = false } = {}) {
  let r = agent.post(url);
  if (header) r = r.set("X-CSRF-Token", csrf);
  else r = r.field("_csrf", csrf);
  for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) r = r.field(k, String(one));
  photos.forEach((buf, i) => (r = r.attach("photos", buf, { filename: `p${i}.png`, contentType: "image/png" })));
  if (voice) r = r.attach("voice", voice, { filename: "note.webm", contentType: "audio/webm;codecs=opus" });
  return r;
}

const unit = async (code) => (await h.query("SELECT * FROM listings WHERE code_norm = upper($1)", [code]))[0];

describe("P13: a unit that looks like one already listed", () => {
  test("the review panel and the save warn once; Save anyway saves", async () => {
    await h.insertListing({ code: "HP-OLD", compound: "Hyde Park", area_value: 152, bedrooms: 3, price_value: 8.4e6 });
    const { agent, csrf } = await signIn(h, "broker");
    const review = await post(agent, "/app/units/review", csrf, FULL, { header: true });
    expect(review.text).toMatch(/data-duplicate="HP-OLD"/);
    const first = await post(agent, "/app/units/new", csrf, { ...FULL, code: "HP-NEW" });
    expect(first.status).toBe(409);
    expect(first.text).toMatch(/href="\/app\/units\/HP-OLD"/);
    expect(first.text).toMatch(/name="force" value="1"/);
    expect(await unit("HP-NEW")).toBeUndefined();
    const anyway = await post(agent, "/app/units/new", csrf, { ...FULL, code: "HP-NEW", force: "1" });
    expect(anyway.status).toBe(303);
    expect(await unit("HP-NEW")).toBeTruthy();
  });

  test("another agency's unit is never a duplicate", async () => {
    await h.insertListing({ code: "RIVAL-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8.5e6 });
    const { agent, csrf } = await signIn(h, "broker");
    expect((await post(agent, "/app/units/new", csrf, { ...FULL, code: "HP-NEW" })).status).toBe(303);
  });
});

describe("add a unit on the web", () => {
  test("the form lists every field, feature and the CSRF token", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.get("/app/units/new");
    expect(r.status).toBe(200);
    expect(r.text).toContain(`name="_csrf" value="${csrf}"`);
    for (const name of ["listing_type", "property_type", "compound", "price_value", "area_value", "bedrooms", "is_ready", "delivery_year", "remaining_amount", "plan_down_1", "owner_name", "photos"]) {
      expect(r.text).toContain(`name="${name}"`);
    }
    expect(r.text).toMatch(/name="feature" value="nanny_room"/);
    expect(r.text).toMatch(/data-voice-url="\/app\/units\/extract"/);
  });

  test("review shows blockers and warnings (only here); saving is refused while something mandatory is missing", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const review = await post(agent, "/app/units/review", csrf, { listing_type: "sale", property_type: "apartment", area_value: "120" }, { header: true });
    expect(review.text).toMatch(/data-review="blocked"/);
    expect(review.text).toMatch(/data-blocker="location"/);
    expect(review.text).toMatch(/data-blocker="price_value"/);
    expect(review.text).toMatch(/data-blocker="bedrooms"/);
    expect(review.text).toMatch(/data-warning="photos"/);
    const save = await post(agent, "/app/units/new", csrf, { listing_type: "sale", property_type: "apartment", area_value: "120" });
    expect(save.status).toBe(422);
    expect(save.text).toMatch(/في بيانات ناقصة/);
    expect(await h.query("SELECT * FROM listings")).toHaveLength(0);
  });

  test("a complete unit with photos is saved like a WhatsApp draft: columns, features, schedule, photos; no warnings after", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const ok = await post(agent, "/app/units/review", csrf, FULL, { header: true });
    expect(ok.text).toMatch(/data-review="ok"/);
    const r = await post(agent, "/app/units/new", csrf, { ...FULL, code: "hp-77" }, { photos: [jpeg, jpeg] });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/app/units/HP-77?saved=1");
    const row = await unit("HP-77");
    expect(row).toMatchObject({
      broker_id: h.BROKERS.broker.id,
      agency_id: h.AGENCY_A,
      status: "active",
      market: "resale",
      price_value: 8500000,
      area_value: 150,
      bedrooms: 3,
      bathrooms: 2,
      floor_level: 4,
      finishing: "fully_finished",
      down_payment_value: 3000000,
      remaining_amount: 5500000,
      installment_value: 250000,
      payment_frequency: "quarterly",
      delivery_year: 2027,
      delivery_quarter: 3,
      feature_keys: ["north_facing", "corner"],
      features_other: ["قريبة من النادي"],
      inventory_type: "resale_unit"
    });
    expect(row.confirmed_at).toBeTruthy();
    expect(row.details).toMatchObject({ owner_name: "Mr Owner", owner_phone: "01011112222" });
    expect(new Date(row.installments_end).toISOString().slice(0, 7)).toBe("2030-06");
    expect(row.search_text_normalized).toMatch(/north facing|بحري/);

    const imgs = await h.query("SELECT position, url FROM listing_images WHERE listing_id = $1 ORDER BY position", [row.id]);
    expect(imgs.map((i) => i.position)).toEqual([0, 1]);
    for (const i of imgs) {
      const stored = h.Storage.objects.get(i.url.replace(h.Storage.BASE, ""));
      const meta = await sharp(stored).metadata();
      expect([meta.format, meta.width <= 1600]).toEqual(["jpeg", true]);
    }

    const page = await agent.get(r.headers.location);
    expect(page.text).toMatch(/تم الحفظ/);
    expect(page.text).toMatch(/ناصية/);
    expect(page.text).not.toMatch(/غير مسجل/);
    // Found by WhatsApp search too.
    h.AI.respond(() => new Error("503"));
    expect(textOf(await h.text("broker", "hyde park"))).toMatch(/HP-77/);
  });

  test("a used code (any case) is refused, the existing unit is untouched and the uploaded photos are removed", async () => {
    await h.insertListing({ code: "HP-77", price_value: 1e6 });
    const { agent, csrf } = await signIn(h, "broker");
    const r = await post(agent, "/app/units/new", csrf, { ...FULL, code: "hp-77" }, { photos: [jpeg] });
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/الكود #HP-77 مستخدم/);
    expect(r.text).toMatch(/value="Hyde Park"/); // the form keeps what was typed
    expect(await h.query("SELECT price_value FROM listings")).toEqual([{ price_value: 1e6 }]);
    expect(h.Storage.objects.size).toBe(0);
  });

  test("a studio gets 0 bedrooms; a villa keeps the area as BUA and no floor", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    await post(agent, "/app/units/new", csrf, { ...FULL, code: "ST-1", property_type: "studio", bedrooms: "" });
    expect((await unit("ST-1")).bedrooms).toBe(0);
    await post(agent, "/app/units/new", csrf, { ...FULL, code: "VL-1", property_type: "villa", bedrooms: "4", land_area: "400" });
    const v = await unit("VL-1");
    expect([v.floor_level, v.details.bua, v.details.land_area]).toEqual([null, 150, 400]);
  });

  test("multipart writes need the form's CSRF token; other routes never take it from a multipart body", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    expect((await post(agent, "/app/units/new", "forged-token-forged-token-x", FULL)).status).toBe(403);
    expect((await agent.post("/app/logout").field("_csrf", csrf)).status).toBe(403);
    expect(await h.query("SELECT * FROM listings")).toHaveLength(0);
  });

  test("only images are accepted as photos", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/units/new").field("_csrf", csrf).attach("photos", Buffer.from("MZ"), { filename: "x.exe", contentType: "application/x-msdownload" });
    expect(r.status).toBe(415);
  });
});

describe("fill from a description or a voice note (same extraction as WhatsApp)", () => {
  const extraction = {
    listing_type: "sale",
    market: "resale",
    property_type: "apartment",
    compound: "ميفيدا",
    area_value: 200,
    bedrooms: 3,
    price_value: 10000000,
    features: ["north_facing", "nanny_room"],
    resale: { cash_paid: 4000000, remaining_amount: 6000000 }
  };

  test("text: the form comes back filled; what the broker had typed stays", async () => {
    h.AI.respond((c) => (c.operation === "listing_extraction" ? extraction : null));
    const { agent, csrf } = await signIn(h, "broker");
    const r = await post(agent, "/app/units/extract", csrf, { describe: "شقة في ميفيدا 200 متر 3 غرف بحري", owner_name: "Typed Owner", bathrooms: "2" }, { header: true });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^<form id="unit-form"/);
    expect(r.text).toMatch(/name="compound" type="text" value="ميفيدا"/);
    expect(r.text).toMatch(/name="price_value" type="text" value="10000000"/);
    expect(r.text).toMatch(/name="feature" value="nanny_room" checked/);
    expect(r.text).toMatch(/name="remaining_amount" type="text" value="6000000"/);
    expect(r.text).toMatch(/name="owner_name" type="text" value="Typed Owner"/);
    expect(r.text).toMatch(/name="bathrooms" type="number" value="2"/);
    const call = h.AI.calls.find((c) => c.operation === "listing_extraction");
    expect(JSON.stringify(call.contents)).toContain("شقة في ميفيدا");
  });

  test("voice: the recording goes to the same extraction as inline audio", async () => {
    h.AI.respond((c) => (c.operation === "listing_extraction" ? extraction : null));
    const { agent, csrf } = await signIn(h, "broker");
    const r = await post(agent, "/app/units/extract", csrf, {}, { header: true, voice: Buffer.from("webm-audio-bytes") });
    expect(r.text).toMatch(/value="ميفيدا"/);
    const parts = h.AI.calls.find((c) => c.operation === "listing_extraction").contents[0].parts;
    expect(parts.find((p) => p.inlineData)).toEqual({ inlineData: { mimeType: "audio/webm", data: Buffer.from("webm-audio-bytes").toString("base64") } });
  });

  test("the AI down: the broker is told and keeps the form", async () => {
    h.AI.respond(() => new Error("503 UNAVAILABLE"));
    const { agent, csrf } = await signIn(h, "broker");
    const r = await post(agent, "/app/units/extract", csrf, { describe: "x", compound: "Kept" }, { header: true });
    expect(r.text).toMatch(/تعذر قراءة الوصف/);
    expect(r.text).toMatch(/value="Kept"/);
  });
});

describe("edit a unit on the web", () => {
  async function seed() {
    return h.insertListing({
      code: "ED-1",
      price_value: 9e6,
      bathrooms: 2,
      feature_keys: ["corner", "north_facing"],
      finishing: "fully_finished",
      details: { title_en: "Kept title", owner_name: "Owner A" },
      confirmed_at: "2026-01-01T00:00:00Z"
    });
  }
  const editFields = async (agent) => {
    const page = await agent.get("/app/units/ED-1/edit");
    return { page, version: page.text.match(/name="version" value="(\d+)"/)[1] };
  };

  test("the form is prefilled; a save applies exactly the form (cleared fields, unticked features) and keeps the rest", async () => {
    const l = await seed();
    const { agent, csrf } = await signIn(h, "broker");
    const { page, version } = await editFields(agent);
    expect(page.text).toMatch(/name="feature" value="corner" checked/);
    expect(page.text).toMatch(/name="owner_name" type="text" value="Owner A"/);
    const r = await post(agent, "/app/units/ED-1/edit", csrf, {
      version,
      code: "ED-1",
      listing_type: "sale",
      market: "resale",
      property_type: "apartment",
      compound: "Hyde Park",
      price_value: "9.5 مليون",
      area_value: "150",
      bedrooms: "3",
      bathrooms: "",
      finishing: "fully_finished",
      feature: "north_facing",
      owner_name: "Owner A"
    });
    expect(r.status).toBe(303);
    const row = await unit("ED-1");
    expect(row).toMatchObject({ price_value: 9500000, bathrooms: null, feature_keys: ["north_facing"], version: l.version + 1 });
    expect(row.details.title_en).toBe("Kept title");
    expect(new Date(row.confirmed_at) > new Date("2026-06-01")).toBe(true);
    expect((await h.query("SELECT metadata FROM operation_logs WHERE operation_type = 'web_unit_edit'"))[0].metadata.columns).toEqual(
      expect.arrayContaining(["price_value", "bathrooms", "feature_keys"])
    );
  });

  test("a change made meanwhile (e.g. on WhatsApp) is never overwritten: the save reports a conflict", async () => {
    await seed();
    const { agent, csrf } = await signIn(h, "broker");
    const { version } = await editFields(agent);
    await h.text("broker", "سعر ED-1 11 مليون");
    const r = await post(agent, "/app/units/ED-1/edit", csrf, { version, listing_type: "sale", property_type: "apartment", compound: "Hyde Park", price_value: "9.5 مليون", area_value: "150", bedrooms: "3" });
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/اتعدلت من شخص تاني/);
    expect((await unit("ED-1")).price_value).toBe(11e6);
  });

  test("photos: remove one and add one in the same save; the removed file leaves storage", async () => {
    const l = await seed();
    await h.Storage.uploadListingImage(h.AGENCY_A, "old/a.jpg", Buffer.from("a"));
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, $3)", [l.id, h.AGENCY_A, `${h.Storage.BASE}old/a.jpg`]);
    const [{ id }] = await h.query("SELECT id FROM listing_images");
    const { agent, csrf } = await signIn(h, "broker");
    const { version } = await editFields(agent);
    const r = await post(
      agent,
      "/app/units/ED-1/edit",
      csrf,
      { version, listing_type: "sale", property_type: "apartment", compound: "Hyde Park", price_value: "9000000", area_value: "150", bedrooms: "3", remove_photo: id },
      { photos: [jpeg] }
    );
    expect(r.status).toBe(303);
    const imgs = await h.query("SELECT url FROM listing_images");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toMatch(/\/web\//);
    expect(h.Storage.objects.has("old/a.jpg")).toBe(false);
  });

  test("only the owner or a manager may edit; another agency's unit does not exist", async () => {
    await seed();
    const colleague = await signIn(h, "colleague");
    expect((await colleague.agent.get("/app/units/ED-1/edit")).status).toBe(404);
    expect((await post(colleague.agent, "/app/units/ED-1/edit", colleague.csrf, { version: "1", price_value: "1" })).status).toBe(404);
    expect((await colleague.agent.get("/app/units/ED-1")).text).not.toMatch(/\/edit"/);
    const admin = await signIn(h, "admin");
    expect((await admin.agent.get("/app/units/ED-1/edit")).status).toBe(200);
    const rival = await signIn(h, "rival");
    expect((await rival.agent.get("/app/units/ED-1/edit")).status).toBe(404);
    expect((await unit("ED-1")).price_value).toBe(9e6);
  });
});

describe("auto unit codes (NH-V12)", () => {
  test("managers set the code letters on My usage; brokers can't; bad letters keep the current ones", async () => {
    const a = await signIn(h, "admin");
    const page = await a.agent.get("/app/usage");
    expect(page.text).toContain('name="code_prefix"');
    expect(page.text).toContain('value="AL"');
    const save = (agent, csrf, code_prefix) => agent.post("/app/usage/agency").type("form").send({ _csrf: csrf, monthly: "4000", code_prefix });
    expect((await save(a.agent, a.csrf, "nh")).status).toBe(303);
    expect((await h.query("SELECT code_prefix FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].code_prefix).toBe("NH");
    await save(a.agent, a.csrf, "N1!");
    expect((await h.query("SELECT code_prefix FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].code_prefix).toBe("NH");
    const b = await signIn(h, "broker");
    expect((await b.agent.get("/app/usage")).text).not.toContain('name="code_prefix"');
    expect((await save(b.agent, b.csrf, "XX")).status).toBe(403);
  });
});
