// tests/web/search.test.js — Release 2 step 4: web search on services/search.js, "refine and see all"
// from WhatsApp, saved searches
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const SearchLink = require("../../domain/searchLink");
const Q = require("../../domain/searchQuery");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const at = (min) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
const waCodes = (text) => [...String(text).matchAll(/`([A-Z0-9-]+)`/g)].map((m) => m[1]);
const webCodes = (htmlText) => [...String(htmlText).matchAll(/data-code="([^"]+)"/g)].map((m) => m[1]);
const linkOf = (text) => (String(text).match(/http:\/\/localhost:3000(\/app\/search\?f=[A-Za-z0-9_-]+)/) || [])[1];

const MV3 = { intent: "search", language: "en", filters: { compound: "Mountain View", bedrooms_min: 3, bedrooms_max: 3 } };

async function seedInventory() {
  await h.insertListing({ code: "MV-3A", compound: "ماونتن فيو آي سيتي", bedrooms: 3, area_value: 160, price_value: 9e6, feature_keys: ["north_facing"], confirmed_at: at(1) });
  await h.insertListing({ code: "MV-3B", compound: "Mountain View iCity", bedrooms: 3, area_value: 175, price_value: 9.8e6, feature_keys: ["corner", "north_facing", "nanny_room", "roof", "elevator"], confirmed_at: at(2) });
  await h.insertListing({ code: "MV-2", compound: "ماونتن فيو آي سيتي", bedrooms: 2, area_value: 120, price_value: 6e6, confirmed_at: at(3) });
  await h.insertListing({ code: "HP-3", compound: "Hyde Park", bedrooms: 3, area_value: 150, price_value: 8.5e6, confirmed_at: at(4) });
  await h.insertListing({ code: "MV-SOLD", compound: "ماونتن فيو آي سيتي", bedrooms: 3, status: "sold", confirmed_at: at(7) });
  await h.insertListing({ code: "B-MV", compound: "Mountain View iCity", bedrooms: 3, agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
}

describe("same filters, same units, same order as WhatsApp", () => {
  test("the WhatsApp result links to the web with the same filters; opening it needs no AI call", async () => {
    await seedInventory();
    h.AI.respond((c) => (c.operation === "search_parse" ? MV3 : null));
    const reply = textOf(await h.text("broker", "Mountain View 3 bedrooms"));
    const link = linkOf(reply);
    expect(link).toBeTruthy();
    const calls = h.AI.calls.length;

    const { agent } = await signIn(h, "broker");
    const page = await agent.get(link);
    expect(page.status).toBe(200);
    expect(webCodes(page.text)).toEqual(waCodes(reply));
    expect(webCodes(page.text)).toEqual(["MV-3B", "MV-3A"]);
    expect(h.AI.calls.length).toBe(calls);
  });

  test("typing the same request on the web gives the WhatsApp ids in the WhatsApp order", async () => {
    await seedInventory();
    h.AI.respond((c) => (c.operation === "search_parse" ? MV3 : null));
    const wa = waCodes(textOf(await h.text("broker", "Mountain View 3 bedrooms")));
    const { agent } = await signIn(h, "broker");
    const web = await agent.get("/app/search").query({ q: "Mountain View 3 bedrooms" });
    expect(webCodes(web.text)).toEqual(wa);
    const logged = await h.query("SELECT metadata->>'channel' AS channel FROM operation_logs WHERE operation_type = 'search_query' ORDER BY id");
    expect(logged.map((r) => r.channel)).toEqual(["text", "web"]);
  });

  test("the AI down: the local parser gives the same result on both channels", async () => {
    await seedInventory();
    h.AI.respond(() => new Error("503 UNAVAILABLE"));
    const wa = waCodes(textOf(await h.text("broker", "ماونتن فيو 3 غرف")));
    const { agent } = await signIn(h, "broker");
    expect(webCodes((await agent.get("/app/search").query({ q: "ماونتن فيو 3 غرف" })).text)).toEqual(wa);
  });

  test("the refine form shows the parsed filters, and submitting it gives the same results", async () => {
    await seedInventory();
    h.AI.respond(() => ({ intent: "search", filters: { compound: "ماونتن فيو", bedrooms_min: 3, bedrooms_max: 3, features: ["corner"] } }));
    const { agent } = await signIn(h, "broker");
    const first = await agent.get("/app/search").query({ q: "ماونتن فيو 3 غرف ناصية" });
    expect(webCodes(first.text)).toEqual(["MV-3B"]);
    expect(first.text).toMatch(/name="feature" value="corner" checked/);
    expect(first.text).toMatch(/name="place" value="ماونتن فيو"/);
    // The same filters typed in the form, the place in English this time.
    const form = await agent.get("/app/search").query({ place: "Mountain View", bedrooms_min: 3, bedrooms_max: 3, feature: "corner" });
    expect(webCodes(form.text)).toEqual(["MV-3B"]);
  });

  test("every feature is shown as a tag (WhatsApp cuts the line with +N)", async () => {
    await seedInventory();
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Mountain View iCity", features: ["corner"] } }));
    const wa = textOf(await h.text("broker", "icity corner"));
    expect(wa).toMatch(/\+1/);
    const { agent } = await signIn(h, "broker");
    const web = await agent.get("/app/search").query({ q: "icity corner" });
    const tags = [...web.text.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
    expect(tags).toEqual(expect.arrayContaining(["بحري", "ناصية", "غرفة مربية", "روف", "أسانسير"]));
  });
});

describe("see all", () => {
  test("WhatsApp shows 5, the web shows 20 a page from the same snapshot", async () => {
    for (let i = 0; i < 25; i++) await h.insertListing({ code: `HP-${100 + i}`, compound: "Hyde Park", confirmed_at: at(i) });
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Hyde Park" } }));
    const reply = textOf(await h.text("broker", "hyde park"));
    expect(waCodes(reply)).toHaveLength(5);
    const { agent } = await signIn(h, "broker");
    const p1 = await agent.get(linkOf(reply));
    const p2 = await agent.get(`${linkOf(reply)}&page=2`);
    expect(webCodes(p1.text)).toHaveLength(20);
    expect(webCodes(p2.text)).toHaveLength(5);
    expect(webCodes(p1.text).slice(0, 5)).toEqual(waCodes(reply));
    expect(new Set([...webCodes(p1.text), ...webCodes(p2.text)]).size).toBe(25);
    expect(p1.text).toMatch(/1 \/ 2/);
  });
});

describe("safety", () => {
  test("another agency's units never appear, whatever the link says", async () => {
    await seedInventory();
    const { agent } = await signIn(h, "rival");
    const token = SearchLink.encodeFilters(Q.normalizeAiSearch(MV3).filters);
    expect(webCodes((await agent.get(`/app/search?f=${token}`)).text)).toEqual(["B-MV"]);
  });

  test("a broken or tampered token is refused or reduced to known filters", async () => {
    const { agent } = await signIn(h, "broker");
    const bad = await agent.get("/app/search?f=%27%3B--");
    expect(bad.text).toMatch(/رابط البحث ده مش صحيح/);
    const tampered = Buffer.from(JSON.stringify({ price_max: "1; DROP TABLE listings", features: ["corner", "x'or'1"], places: [{ kind: "compound", key: "nope" }], agency_id: "b0000000-0000-0000-0000-00000000000b" })).toString("base64url");
    expect(SearchLink.decodeFilters(tampered)).toEqual(Q.canonical({ ...Q.emptyFilters(), features: ["corner"] }));
    expect((await agent.get(`/app/search?f=${tampered}`)).status).toBe(200);
  });

  test("small talk is not a search", async () => {
    await seedInventory();
    h.AI.respond(() => ({ intent: "other", filters: {} }));
    const { agent } = await signIn(h, "broker");
    const r = await agent.get("/app/search").query({ q: "شكرا" });
    expect(webCodes(r.text)).toEqual([]);
    expect(r.text).toMatch(/اكتب مواصفات اللي بتدور عليه/);
  });

  test("free-text searches are rate limited per broker (AI cost)", async () => {
    h.AI.respond(() => new Error("503"));
    const { agent } = await signIn(h, "broker");
    await h.query("INSERT INTO web_rate_limits (bucket, window_start, hits) VALUES ($1, date_trunc('minute', NOW()), 60)", [`search:broker:${h.BROKERS.broker.id}`]);
    const r = await agent.get("/app/search").query({ q: "hyde park" });
    expect(r.status).toBe(429);
  });
});

describe("saved searches", () => {
  async function save(agent, csrf, filters, name = "MV 3") {
    return agent.post("/app/searches").set("X-CSRF-Token", csrf).type("form").send({ f: SearchLink.encodeFilters(filters), name });
  }

  test("save, see how many units are new, open (resets), delete", async () => {
    await seedInventory();
    const filters = Q.normalizeAiSearch(MV3).filters;
    const { agent, csrf } = await signIn(h, "broker");
    expect((await save(agent, csrf, filters)).status).toBe(303);
    let list = await agent.get("/app/searches");
    expect(list.text).toMatch(/MV 3/);
    expect(list.text).not.toMatch(/data-new=/);

    await h.insertListing({ code: "MV-3C", compound: "Mountain View iCity", bedrooms: 3, confirmed_at: at(9) });
    list = await agent.get("/app/searches");
    expect(list.text).toMatch(/data-new="1"/);

    const id = list.text.match(/data-saved="([^"]+)"/)[1];
    const run = await agent.get(`/app/searches/${id}`);
    expect(webCodes(run.text)).toEqual(["MV-3C", "MV-3B", "MV-3A"]);
    expect((await agent.get("/app/searches")).text).not.toMatch(/data-new=/);

    expect((await agent.post(`/app/searches/${id}/delete`).set("X-CSRF-Token", csrf)).status).toBe(303);
    expect((await h.query("SELECT count(*)::int AS n FROM saved_searches"))[0].n).toBe(0);
  });

  test("saved searches are private: a colleague can neither open nor delete them", async () => {
    const me = await signIn(h, "broker");
    await save(me.agent, me.csrf, Q.normalizeAiSearch(MV3).filters);
    const [{ id }] = await h.query("SELECT id FROM saved_searches");
    const other = await signIn(h, "colleague");
    expect((await other.agent.get(`/app/searches/${id}`)).status).toBe(404);
    expect((await other.agent.get("/app/searches")).text).not.toMatch(/MV 3/);
    await other.agent.post(`/app/searches/${id}/delete`).set("X-CSRF-Token", other.csrf);
    expect((await h.query("SELECT count(*)::int AS n FROM saved_searches"))[0].n).toBe(1);
  });

  test("saving needs the CSRF token, a name and a real filter", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const token = SearchLink.encodeFilters(Q.normalizeAiSearch(MV3).filters);
    expect((await agent.post("/app/searches").type("form").send({ f: token, name: "x" })).status).toBe(403);
    expect((await agent.post("/app/searches").set("X-CSRF-Token", csrf).type("form").send({ f: token, name: " " })).status).toBe(400);
    expect((await agent.post("/app/searches").set("X-CSRF-Token", csrf).type("form").send({ f: SearchLink.encodeFilters({}), name: "x" })).status).toBe(400);
  });
});

describe("unit pages in the web app", () => {
  test("a unit's page shows every fact and the internal lines; another agency's code is not found", async () => {
    await h.insertListing({ code: "VIL-08", property_type: "villa", bedrooms: 4, area_value: 300, compound: "بالم هيلز أكتوبر", feature_keys: ["corner"], details: { owner_name: "Mr Owner" } });
    await h.insertListing({ code: "B-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
    const { agent } = await signIn(h, "broker");
    const r = await agent.get("/app/units/vil-08");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/فيلا للبيع في بالم هيلز أكتوبر/);
    expect(r.text).toMatch(/ناصية/);
    expect(r.text).toMatch(/Mr Owner/);
    expect(r.text).toMatch(/\/app\/units\/VIL-08\/edit/);
    expect((await agent.get("/app/units/B-1")).status).toBe(404);
  });

  test("the units list is agency-scoped with status tabs", async () => {
    await seedInventory();
    const { agent } = await signIn(h, "broker");
    expect(webCodes((await agent.get("/app/units")).text).sort()).toEqual(["HP-3", "MV-2", "MV-3A", "MV-3B"]);
    expect(webCodes((await agent.get("/app/units?status=sold")).text)).toEqual(["MV-SOLD"]);
  });
});

describe("filters ⇄ link ⇄ form (domain/searchLink.js)", () => {
  test("encode/decode keeps canonical filters; the form round-trips; Arabic and English places agree", () => {
    const f = Q.normalizeAiSearch({ filters: { compound: "هايد بارك", price_max: 9e6, finishing: ["super_lux"], delivery: { ready: true }, payment: { max_installment: 150000 }, features: ["بحري"] } }).filters;
    expect(SearchLink.decodeFilters(SearchLink.encodeFilters(f))).toEqual(f);
    const form = SearchLink.formFromFilters(f, "ar");
    expect(SearchLink.filtersFromForm({ ...form, ready: form.ready ? "1" : "" })).toEqual(f);
    const en = SearchLink.formFromFilters(f, "en");
    expect(en.place).toBe("hyde park");
    expect(SearchLink.filtersFromForm({ place: en.place }).places).toEqual(f.places);
  });
});
