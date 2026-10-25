// tests/web/leads.test.js — The web CRM pages (Release 3 step 5): role scoping by list, URL and phone search,
// create with dedupe, stage/follow-up/note round trips, a conflict with a WhatsApp tap, assignment, the
// managers' pipeline, CSRF, tenant isolation, no-store, escaping, English pages, extraction and the share target.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const capture = async (who, input) => Leads.captureLead(h.pool, await row(who), { phones: "01012345678", ...input });
const form = (agent, url, csrf, fields) => agent.post(url).type("form").send({ _csrf: csrf, ...fields });
const leadRow = async (ref = 1) => (await h.query("SELECT * FROM leads WHERE ref = $1 ORDER BY agency_id LIMIT 1", [ref]))[0];
const versionOf = (text) => Number((text.match(/name="version" value="(\d+)"/) || [])[1]);

describe("the list", () => {
  test("brokers see their own leads, managers all with the pipeline; the other agency nothing", async () => {
    await capture("broker", { name: "Sara Mine" });
    await capture("colleague", { phones: "01112345678", name: "Omar Theirs" });
    await capture("rival", { phones: "01212345678", name: "Rival Client" });
    const b = await signIn(h, "broker");
    const mine = await b.agent.get("/app/leads");
    expect(mine.status).toBe(200);
    expect(mine.headers["cache-control"]).toMatch(/no-store/);
    expect(mine.text).toContain("Sara Mine");
    expect(mine.text).not.toContain("Omar Theirs");
    expect(mine.text).not.toContain('id="pipeline"');
    const a = await signIn(h, "admin");
    const all = await a.agent.get("/app/leads");
    expect(all.text).toContain("Sara Mine");
    expect(all.text).toContain("Omar Theirs");
    expect(all.text).not.toContain("Rival Client");
    expect(all.text).toMatch(/data-stage="new"><a[^>]*>🆕 New: 2/);
    const r = await signIn(h, "rival");
    expect((await r.agent.get("/app/leads")).text).not.toContain("Sara Mine");
  });

  test("search by name, phone or reference; tabs; English page", async () => {
    await capture("broker", { name: "Sara Ali" });
    await capture("broker", { phones: "01112345679", name: "Omar" });
    await Leads.setStage(h.pool, await row("broker"), "L-0002", { stage: "viewing" });
    const { agent } = await signIn(h, "broker");
    const names = async (url) => [...(await agent.get(url)).text.matchAll(/data-lead="(L-\d+)"/g)].map((m) => m[1]);
    expect(await names("/app/leads?q=sara")).toEqual(["L-0001"]);
    expect(await names("/app/leads?q=0101%20234")).toEqual(["L-0001"]);
    expect(await names("/app/leads?q=L-0002")).toEqual(["L-0002"]);
    expect(await names("/app/leads?tab=viewing")).toEqual(["L-0002"]);
    expect(await names("/app/leads?tab=no_next_step")).toHaveLength(2);
    const admin = await signIn(h, "admin");
    const en = await admin.agent.get("/app/leads");
    expect(en.text).toContain('lang="en"');
    expect(en.text).toContain("New lead");
  });

  test("an empty list offers the first action", async () => {
    const { agent } = await signIn(h, "broker");
    expect((await agent.get("/app/leads")).text).toMatch(/حوّل رسالة عميل للبوت/);
  });
});

describe("add a lead", () => {
  test("create → the lead page; the same number again merges; a colleague's number tells the manager", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    const r = await form(agent, "/app/leads/new", csrf, { name: "Sara", phone1: "0101 234 5678", kind: "tenant", source: "other", source_other: "Instagram", lawful_basis: "consent" });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/app/leads/L-0001?saved=1");
    expect(await leadRow()).toMatchObject({ name: "Sara", kind: "tenant", source: "Instagram", lawful_basis: "consent", assigned_broker_id: h.BROKERS.broker.id });
    expect((await leadRow()).consent_at).toBeTruthy();
    const again = await form(agent, "/app/leads/new", csrf, { phone1: "+201012345678", lawful_basis: "client_request" });
    expect(again.headers.location).toBe("/app/leads/L-0001?known=1");
    const c = await signIn(h, "colleague");
    const dup = await form(c.agent, "/app/leads/new", c.csrf, { phone1: "01012345678", name: "Not Sara", lawful_basis: "client_request" });
    expect(dup.status).toBe(409);
    expect(dup.text).toMatch(/زميل/);
    expect(dup.text).not.toContain("Sara ·");
    expect((await h.query("SELECT count(*)::int AS n FROM leads"))[0].n).toBe(1);
  });

  test("the duplicate notice shows before saving", async () => {
    await capture("broker", { name: "Sara" });
    const b = await signIn(h, "broker");
    expect((await form(b.agent, "/app/leads/check", b.csrf, { phone1: "01012345678" })).text).toContain("L-0001");
    const c = await signIn(h, "colleague");
    const n = await form(c.agent, "/app/leads/check", c.csrf, { phone1: "01012345678" });
    expect(n.text).toMatch(/زميل/);
    expect(n.text).not.toContain("Sara");
    expect((await form(c.agent, "/app/leads/check", c.csrf, { phone1: "12" })).text).toMatch(/مش مظبوط/);
  });

  test("validation: phone required, lawful basis required, at most one manager-only assignment", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    expect((await form(agent, "/app/leads/new", csrf, { name: "x", lawful_basis: "consent" })).status).toBe(422);
    expect((await form(agent, "/app/leads/new", csrf, { phone1: "01012345678", lawful_basis: "nope" })).status).toBe(422);
    await form(agent, "/app/leads/new", csrf, { phone1: "01012345678", lawful_basis: "consent", assign_to: h.BROKERS.colleague.id });
    expect((await leadRow()).assigned_broker_id).toBe(h.BROKERS.broker.id);
    const a = await signIn(h, "admin");
    await form(a.agent, "/app/leads/new", a.csrf, { phone1: "01112345678", lawful_basis: "consent", assign_to: h.BROKERS.colleague.id });
    expect((await leadRow(2)).assigned_broker_id).toBe(h.BROKERS.colleague.id);
  });

  test("✨ fill from the message keeps what the AI left empty; the AI down leaves the form usable", async () => {
    h.AI.respond(() => ({ name: "Ahmed", phones: ["01012345678"], kind: "tenant", source: "فيسبوك", note: null, request: { listing_type: "rent", price_max: 25000 } }));
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/leads/extract").set("X-CSRF-Token", csrf).field("message", "أحمد 01012345678 عايز إيجار لحد 25 ألف").field("name", "Typed Name");
    expect(r.status).toBe(200);
    expect(r.text).toContain('value="Typed Name"');
    expect(r.text).toContain('value="0101 234 5678"');
    expect(r.text).toMatch(/<option value="tenant" selected>/);
    expect(r.text).toMatch(/<option value="Facebook" selected>/);
    expect(r.text).toContain("25 ألف");
    expect(h.AI.calls[0].operation).toBe("lead_extraction");
    h.AI.respond(() => new Error("down"));
    const down = await agent.post("/app/leads/extract").set("X-CSRF-Token", csrf).field("message", "x 01012345678");
    expect(down.text).toMatch(/املأ الخانات بإيدك/);
  });

  test("the share target opens the form with the shared text and its numbers (nothing saved)", async () => {
    const { agent } = await signIn(h, "broker");
    const r = await agent.get(`/app/share?text=${encodeURIComponent("Mona 01112345678 wants a villa")}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("Mona 01112345678 wants a villa");
    expect(r.text).toContain('value="0111 234 5678"');
    expect((await h.query("SELECT count(*)::int AS n FROM leads"))[0].n).toBe(0);
    const manifest = JSON.parse((await agent.get("/app/manifest.webmanifest")).text);
    expect(manifest.share_target).toMatchObject({ action: "/app/share", method: "GET" });
  });
});

describe("the lead page", () => {
  test("real Call and WhatsApp buttons; escaping; another broker or agency gets 404", async () => {
    await capture("broker", { name: "<script>alert(1)</script>" });
    const { agent } = await signIn(h, "broker");
    const r = await agent.get("/app/leads/L-0001");
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="tel:+201012345678"');
    expect(r.text).toMatch(/href="https:\/\/wa\.me\/201012345678\?text=/);
    expect(r.text).not.toContain("<script>alert(1)</script>");
    expect(r.text).toContain("&lt;script&gt;");
    expect((await (await signIn(h, "colleague")).agent.get("/app/leads/L-0001")).status).toBe(404);
    expect((await (await signIn(h, "rival")).agent.get("/app/leads/L-0001")).status).toBe(404);
  });

  test("stage, follow-up and note round trips with Undo; lost needs a reason", async () => {
    await capture("broker", { name: "Sara" });
    const unit = await h.insertListing({ code: "VIL-08" });
    const { agent, csrf } = await signIn(h, "broker");
    let v = versionOf((await agent.get("/app/leads/L-0001")).text);
    expect((await form(agent, "/app/leads/L-0001/stage", csrf, { version: v, stage: "lost" })).status).toBe(422);
    const s = await form(agent, "/app/leads/L-0001/stage", csrf, { version: v, stage: "viewing" });
    expect(s.status).toBe(303);
    expect(s.headers.location).toMatch(/done=stage&undo=\d+/);
    v = versionOf((await agent.get(s.headers.location)).text);
    const f = await form(agent, "/app/leads/L-0001/follow-up", csrf, { version: v, at: "2026-11-02T15:00", kind: "viewing", unit: "vil-08", note: "keys" });
    expect(f.status).toBe(303);
    const lead = await leadRow();
    expect(lead).toMatchObject({ stage: "viewing", follow_up_kind: "viewing", follow_up_listing_id: unit.id, follow_up_note: "keys", follow_up_status: "open" });
    expect(new Date(lead.next_follow_up_at).toISOString()).toBe("2026-11-02T13:00:00.000Z");
    const page = await agent.get(f.headers.location);
    expect(page.text).toContain('value="2026-11-02T15:00"');
    expect(page.text).toContain('value="VIL-08"');
    const undoId = f.headers.location.match(/undo=(\d+)/)[1];
    expect((await form(agent, "/app/leads/L-0001/undo", csrf, { event: undoId })).status).toBe(303);
    expect((await leadRow()).follow_up_status).toBeNull();
    v = versionOf((await agent.get("/app/leads/L-0001")).text);
    await form(agent, "/app/leads/L-0001/note", csrf, { version: v, text: "prefers ground floor" });
    const tl = await agent.get("/app/leads/L-0001");
    expect(tl.text).toContain("prefers ground floor");
    expect(tl.text).toMatch(/data-event="note"/);
  });

  test("a WhatsApp tap after the page opened makes the web save a 409, never an overwrite", async () => {
    await capture("broker", { name: "Sara" });
    const { agent, csrf } = await signIn(h, "broker");
    const v = versionOf((await agent.get("/app/leads/L-0001")).text);
    await h.tap("broker", "ld:called:L-0001");
    const r = await form(agent, "/app/leads/L-0001/stage", csrf, { version: v, stage: "won" });
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/اتعدل من مكان تاني/);
    expect((await leadRow()).stage).toBe("contacted");
  });

  test("assignment: managers only; the assignee gets the card", async () => {
    await capture("broker", { name: "Sara" });
    const b = await signIn(h, "broker");
    const page = await b.agent.get("/app/leads/L-0001");
    expect(page.text).not.toContain('id="assign"');
    expect((await form(b.agent, "/app/leads/L-0001/assign", b.csrf, { broker: h.BROKERS.colleague.id })).status).toBe(403);
    const a = await signIn(h, "admin");
    const v = versionOf((await a.agent.get("/app/leads/L-0001")).text);
    expect((await form(a.agent, "/app/leads/L-0001/assign", a.csrf, { version: v, broker: h.BROKERS.colleague.id })).status).toBe(303);
    expect((await leadRow()).assigned_broker_id).toBe(h.BROKERS.colleague.id);
    expect((await h.query("SELECT kind FROM notifications WHERE broker_id = $1", [h.BROKERS.colleague.id])).map((n) => n.kind)).toEqual(["assignment"]);
  });

  test("CSRF: a write without the token is refused", async () => {
    await capture("broker", { name: "Sara" });
    const { agent } = await signIn(h, "broker");
    expect((await agent.post("/app/leads/L-0001/stage").type("form").send({ stage: "won" })).status).toBe(403);
    expect((await agent.post("/app/leads/new").type("form").send({ phone1: "01112345678", lawful_basis: "consent" })).status).toBe(403);
    expect((await leadRow()).stage).toBe("new");
  });

  test("the nav and home link to the leads", async () => {
    const { agent } = await signIn(h, "broker");
    const home = await agent.get("/app/");
    expect(home.text).toContain('href="/app/leads"');
  });
});

describe("requests on the lead page (step 7)", () => {
  test("add a request with several places, see what fits, remove it; at most 3", async () => {
    await h.insertListing({ code: "HP-1", compound: "Hyde Park", price_value: 8.5e6 });
    await capture("broker", { name: "Sara" });
    const { agent, csrf } = await signIn(h, "broker");
    const page = await agent.get("/app/leads/L-0001");
    expect(page.text).toMatch(/id="requests"[\s\S]*action="\/app\/leads\/L-0001\/requests"/);
    const r = await agent.post("/app/leads/L-0001/requests").type("form").send({ _csrf: csrf, type: "apartment", place: "Hyde Park، الشيخ زايد", price_max: "9000000" });
    expect(r.status).toBe(303);
    const after = await agent.get(r.headers.location);
    expect(after.text).toMatch(/data-request="[0-9a-f-]{36}"[\s\S]*🏠 1 /);
    const [req] = await h.query("SELECT id, filters FROM saved_searches WHERE lead_id IS NOT NULL");
    expect(req.filters.places).toHaveLength(2);
    const empty = await agent.post("/app/leads/L-0001/requests").type("form").send({ _csrf: csrf });
    expect(empty.status).toBe(422);
    const del = await agent.post("/app/leads/L-0001/requests/delete").type("form").send({ _csrf: csrf, request: req.id });
    expect(del.status).toBe(303);
    expect(await h.query("SELECT 1 FROM saved_searches")).toHaveLength(0);
    for (let i = 1; i <= 3; i++) await agent.post("/app/leads/L-0001/requests").type("form").send({ _csrf: csrf, bedrooms_min: String(i) });
    expect((await agent.post("/app/leads/L-0001/requests").type("form").send({ _csrf: csrf, bedrooms_min: "4" })).status).toBe(422);
    expect((await agent.get("/app/leads/L-0001")).text).not.toMatch(/action="\/app\/leads\/L-0001\/requests"/);
  });

  test("a colleague can't add a request to my lead", async () => {
    await capture("broker", { name: "Sara" });
    const { agent, csrf } = await signIn(h, "colleague");
    expect((await agent.post("/app/leads/L-0001/requests").type("form").send({ _csrf: csrf, type: "villa" })).status).toBe(404);
  });
});
