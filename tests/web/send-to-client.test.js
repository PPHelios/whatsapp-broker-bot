// tests/web/send-to-client.test.js — Step 7, the wow loop: "🔥 N clients want this unit" on the saved card and the unit
// page (count right, private to the agency), the no-results search saved as a client's request (WhatsApp and web),
// "send to client" (a share link with lead_id, a wa.me link, a match_sent event; the public page shows nothing of the
// lead) and the hot-client signal (once).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Requests = require("../../services/leadRequests");
const SearchLink = require("../../domain/searchLink");
const Q = require("../../domain/searchQuery");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const HP = { listing_type: "sale", property_types: ["apartment"], places: [{ kind: "compound", key: "hyde_park" }], price_max: 9000000 };
const SENTINEL = "Zebulon Sentinelson";
async function lead(who = "broker", phones = "01012345678", name = SENTINEL) {
  const l = (await Leads.captureLead(h.pool, await row(who), { phones, name })).lead;
  await Requests.saveRequest(h.pool, await row(who), l.id, HP);
  return l;
}
const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const ids = (r) => (r.buttons || []).map((b) => b.id).concat((r.sections || []).flatMap((s) => s.rows.map((x) => x.id)));

describe("wow 1: clients who want the unit", () => {
  test("the WhatsApp saved card counts the agency's clients; the button lists mine and sends", async () => {
    await lead("broker", "01012345678");
    await lead("colleague", "01112345678", "Their Client");
    await lead("rival", "01212345678", "Rival Client");
    h.AI.respond((c) =>
      c.operation === "listing_extraction"
        ? { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8500000, delivery: {}, features: [], features_other: [], resale: {}, primary: {} }
        : null
    );
    await h.text("broker", "اضافة");
    await h.send("broker", { type: "contacts", contacts: [{ name: { formatted_name: "Mr Owner" }, phones: [{ phone: "01012345678", type: "CELL" }] }] });
    await h.text("broker", "شقة هايد بارك 150 متر 3 غرف 8.5 مليون كود HP-77");
    await h.text("broker", "تم");
    await h.tap("broker", "draft_owner_keep");
    const saved = to("broker", await h.tap("broker", "draft_confirm"));
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toMatch(/🔥 2 عملاء عايزين الوحدة دي/);
    const code = (await h.query("SELECT code FROM listings"))[0].code;
    expect(ids(saved[0])).toContain(`ld:wants:${code}`);
    const list = to("broker", await h.tap("broker", `ld:wants:${code}`))[0];
    expect(ids(list)).toEqual([`ld:send:L-0001:${code}`]);
    expect(list.text).toMatch(/و1 مع زملائك/);
    expect(JSON.stringify(list)).not.toContain("Their Client");
    const sent = to("broker", await h.tap("broker", `ld:send:L-0001:${code}`))[0];
    expect(sent.text).toMatch(/https:\/\/wa\.me\/201012345678\?text=/);
    const link = await h.query("SELECT lead_id FROM share_links");
    expect(link[0].lead_id).toBeTruthy();
    expect(await h.query("SELECT 1 FROM lead_events WHERE kind = 'match_sent'")).toHaveLength(1);
  });

  test("the unit page shows the count and my clients with Send; the rival agency sees nothing", async () => {
    await h.insertListing({ code: "HP-1", compound: "Hyde Park" });
    await lead();
    await lead("rival", "01212345678", "Rival Client");
    const b = await signIn(h, "broker");
    const page = await b.agent.get("/app/units/HP-1");
    expect(page.text).toMatch(/id="wanted"[\s\S]*🔥 1 عملاء/);
    expect(page.text).toContain('action="/app/leads/L-0001/send"');
    const send = await b.agent.post("/app/leads/L-0001/send").type("form").send({ _csrf: b.csrf, code: "HP-1" });
    expect(send.status).toBe(303);
    expect(send.headers.location).toMatch(/^https:\/\/wa\.me\/201012345678\?text=/);
    const c = await signIn(h, "colleague");
    expect((await c.agent.get("/app/units/HP-1")).text).toMatch(/و1 مع زملائك|And 1 with your colleagues/);
    expect((await c.agent.post("/app/leads/L-0001/send").type("form").send({ _csrf: c.csrf, code: "HP-1" })).status).toBe(404);
  });
});

describe("wow 2: a search with no results becomes a client's request", () => {
  test("WhatsApp: the button asks for the number; Confirm saves the lead and the request", async () => {
    h.AI.respond((c) => {
      if (c.operation === "search_parse") return { intent: "search", filters: { property_types: ["villa"], compound: "Hyde Park", price_max: 5000000 } };
      if (c.operation === "lead_extraction") return { name: null, phones: ["01012345678"], kind: null, request: null };
      return null;
    });
    const none = to("broker", await h.text("broker", "فيلا في هايد بارك تحت 5 مليون"))[0];
    const btn = ids(none).find((x) => x.startsWith("ld:reqsave:"));
    expect(btn).toBeTruthy();
    expect(to("broker", await h.tap("broker", btn))[0].text).toMatch(/ابعت رقم العميل/);
    const understood = to("broker", await h.text("broker", "01012345678"))[0];
    const ok = ids(understood).find((x) => x.startsWith("ld:ok:"));
    await h.tap("broker", ok);
    const reqs = await h.query("SELECT filters FROM saved_searches WHERE lead_id IS NOT NULL");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].filters.property_types).toEqual(["villa"]);
  });

  test("web: the no-results page links to the add form with the request; saving creates both", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const token = SearchLink.encodeFilters({ ...Q.emptyFilters(), property_types: ["villa"], places: [{ kind: "compound", key: "hyde_park" }] });
    const none = await agent.get(`/app/search?f=${token}`);
    expect(none.text).toContain(`/app/leads/new?request=${token}`);
    const form = await agent.get(`/app/leads/new?request=${token}`);
    expect(form.text).toContain(`name="request" value="${token}"`);
    const r = await agent.post("/app/leads/new").type("form").send({ _csrf: csrf, phone1: "01012345678", lawful_basis: "client_request", request: token });
    expect(r.status).toBe(303);
    expect(await h.query("SELECT 1 FROM saved_searches WHERE lead_id IS NOT NULL")).toHaveLength(1);
  });
});

describe("send to client and the hot signal", () => {
  test("the public page shows nothing of the lead; 3 opens in 48h make the lead hot once, with one notification", async () => {
    await h.insertListing({ code: "HP-1", compound: "Hyde Park" });
    const l = await lead();
    const r = await Requests.sendToClient(h.pool, await row("broker"), l.id, (await h.query("SELECT * FROM listings"))[0]);
    const shareUrl = decodeURIComponent(r.url).match(/https?:\/\/\S+\/HP-1\?s=[\w-]+/)[0];
    const path = new URL(shareUrl).pathname + new URL(shareUrl).search;
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
    for (let i = 0; i < 4; i++) {
      const page = await request(h.app.app).get(path).set("User-Agent", ua);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain(SENTINEL);
      expect(page.text).not.toContain("01012345678");
      expect(page.text).not.toContain("L-0001");
    }
    const lead1 = (await h.query("SELECT hot_at FROM leads WHERE id = $1", [l.id]))[0];
    expect(lead1.hot_at).toBeTruthy();
    expect(await h.query("SELECT 1 FROM notifications WHERE kind = 'hot_client'")).toHaveLength(1);
    expect(await h.query("SELECT 1 FROM lead_events WHERE kind = 'share_opened'")).toHaveLength(4);
  });
});
