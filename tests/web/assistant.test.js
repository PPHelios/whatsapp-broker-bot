// tests/web/assistant.test.js — Release B C10 + N1: the assistant answers only from the agency's data (the project's
// stored context, rebuilt when its prices change; the broker's own clients; follow-ups; units) with the data dates,
// says "not in our data" otherwise, logs the question for managers, and only with the owner's switch adds a web
// answer, always labelled unverified with its sources (never shown without one).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const FakeAI = require("../harness/fake-ai");
const Catalogue = require("../../services/catalogue");
const Leads = require("../../services/leads");
const Assistant = require("../../services/assistant");
const ProjectContext = require("../../services/projectContext");
const A = require("../../domain/assistant");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const GROUNDING = { groundingChunks: [{ web: { uri: "https://news.example/badya", title: "Badya news" } }, { web: { uri: "http://insecure.example" } }] };

async function seed() {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya", city: "6th of October", delivery_year: "2028" })).project;
  await h.query("UPDATE projects SET prices_updated_at = '2026-10-01T10:00:00Z' WHERE id = $1", [project.id]);
  await h.insertListing({ code: "BD-1", project_id: project.id, property_type: "apartment", price_value: 9000000, area_value: 160, bedrooms: 3 });
  await Leads.captureLead(h.pool, await row("broker"), { phones: ["01011112222"], name: "Mona Saeed" });
  await Leads.captureLead(h.pool, await row("colleague"), { phones: ["01033334444"], name: "Karim Adel" });
  return { admin, project };
}

// The model: answers from the DATA when the fact is there; otherwise "not found".
function fakeModel({ web = null } = {}) {
  FakeAI.respond((call) => {
    if (call.operation === "assistant") {
      const prompt = String(call.contents);
      if (/QUESTION: .*(delivery|استلام)/i.test(prompt) && /Delivery: 2028/.test(prompt)) return { answer: "Badya delivery is 2028 (price sheet of 2026-10-01).", found: true };
      if (/QUESTION: .*clients/i.test(prompt)) return { answer: prompt.includes("Karim") ? "Mona and Karim" : "Mona", found: true };
      return { answer: "That's not in our data.", found: false };
    }
    if (call.operation === "assistant_web") return web || { __text: "", __grounding: null };
    throw new Error(`unexpected ${call.operation}`);
  });
}

test("rules: the ask command, project and client matching, answers that can't be read", () => {
  expect(A.matchAsk("اسأل امتى استلام بادية؟")).toBe("امتى استلام بادية؟");
  expect(A.matchAsk("ask: when is delivery?")).toBe("when is delivery?");
  expect(A.matchAsk("شقة في زايد")).toBeNull();
  expect(A.matchProjects("when is Badya delivery", [{ name: "Badya" }, { name: "Mivida" }]).map((p) => p.name)).toEqual(["Badya"]);
  expect(A.parseAnswer("not json", "en")).toEqual({ answer: A.NOT_FOUND.en, found: false });
  expect(A.webSources(GROUNDING)).toEqual([{ title: "Badya news", url: "https://news.example/badya" }]);
});

test("stored context: built once, reused, rebuilt when prices change", async () => {
  const { admin, project } = await seed();
  const first = await ProjectContext.contextFor(h.pool, admin.agency_id, project.id);
  expect(first.fresh).toBe(true);
  expect(first.summary).toContain("Delivery: 2028");
  expect(first.summary).toContain("price sheet of 2026-10-01");
  expect(first.facts.prices.ranges[0]).toMatchObject({ type: "apartment", min: 9000000, units: 1 });
  expect((await ProjectContext.contextFor(h.pool, admin.agency_id, project.id)).fresh).toBe(false);
  await h.query("UPDATE listings SET price_value = 9500000, updated_at = now() + interval '1 second' WHERE code = 'BD-1'");
  const again = await ProjectContext.contextFor(h.pool, admin.agency_id, project.id);
  expect(again.fresh).toBe(true);
  expect(again.facts.prices.ranges[0].min).toBe(9500000);
  // Another agency never sees it.
  expect(await ProjectContext.contextFor(h.pool, h.BROKERS.rival.agency_id, project.id)).toBeNull();
});

test("grounded answers with dates; not in our data; web only when switched on, labelled, with sources", async () => {
  const { admin } = await seed();
  fakeModel();
  const broker = await row("broker");
  const found = await Assistant.ask(h.pool, broker, "When is Badya delivery?");
  expect(found).toMatchObject({ found: true, lang: "en", web: null });
  expect(found.dates).toEqual([{ project: "Badya", prices: "2026-10-01", brochure: null, plans: null }]);
  expect(Assistant.datesLine(found.dates, "en")).toBe("📅 Data: Badya: prices 2026-10-01");

  // Not in our data, web off: no web call at all.
  const missing = await Assistant.ask(h.pool, broker, "What is the club membership fee at Badya?");
  expect(missing).toMatchObject({ found: false, webOff: true, web: null });
  expect(FakeAI.calls.filter((c) => c.operation === "assistant_web")).toHaveLength(0);

  // The owner switches web on: an answer without a source is not shown; with one it is, labelled.
  await Assistant.setWeb(h.pool, admin.agency_id, { enabled: true, webMonth: "2" });
  expect((await Assistant.ask(h.pool, broker, "What is the club fee at Badya?")).web).toBeNull();
  fakeModel({ web: { __text: "Reports say about 300,000 EGP.", __grounding: GROUNDING } });
  const web = await Assistant.ask(h.pool, broker, "What is the club fee at Badya?");
  expect(web.web).toEqual({ answer: "Reports say about 300,000 EGP.", sources: [{ title: "Badya news", url: "https://news.example/badya" }] });
  expect(FakeAI.calls.find((c) => c.operation === "assistant_web").config.tools).toEqual([{ googleSearch: {} }]);
  // Two web answers a month: the next is refused, said plainly.
  await Assistant.ask(h.pool, broker, "Club fee at Badya again?");
  expect((await Assistant.ask(h.pool, broker, "Club fee at Badya once more?")).webLimit).toBe(true);

  // Managers see the questions our data could not answer.
  const missed = await Assistant.unanswered(h.pool, admin);
  expect(missed.map((m) => m.question)).toContain("What is the club membership fee at Badya?");
  expect(await Assistant.unanswered(h.pool, broker)).toBeNull();
});

test("own data: a broker sees only their clients, a manager sees the agency's", async () => {
  await seed();
  fakeModel();
  expect((await Assistant.ask(h.pool, await row("broker"), "Which of my clients are new?")).answer).toBe("Mona");
  expect((await Assistant.ask(h.pool, await row("admin"), "Which clients are new?")).answer).toBe("Mona and Karim");
});

test("website: ask, Send on WhatsApp, unanswered list; owner switch", async () => {
  const { admin } = await seed();
  fakeModel();
  process.env.OWNER_BROKER_IDS = h.BROKERS.admin.id;
  require("../../config").resetConfig();
  try {
    const { agent, csrf } = await signIn(h, "admin");
    const page = await agent.post("/app/ask").type("form").send({ _csrf: csrf, q: "When is Badya delivery?" });
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-found="yes"');
    expect(page.text).toContain("data-send-whatsapp");
    expect(page.text).toContain("prices 2026-10-01");
    const miss = await agent.post("/app/ask").type("form").send({ _csrf: csrf, q: "Badya club fee?" });
    expect(miss.text).toContain('data-found="no"');
    expect(miss.text).not.toContain("data-send-whatsapp");
    expect(miss.text).toContain("data-unanswered");
    expect(miss.text).toContain("Badya club fee?");

    const owner = await agent.get("/app/owner");
    expect(owner.text).toContain(`data-assistant-web="${admin.agency_id}"`);
    const on = await agent.post(`/app/owner/assistant/${admin.agency_id}`).type("form").send({ _csrf: csrf, enabled: "on", web_month: "20" });
    expect(on.status).toBe(200);
    expect(await Assistant.webSetting(h.pool, admin.agency_id)).toEqual({ web: true, web_month: 20 });
  } finally {
    delete process.env.OWNER_BROKER_IDS;
    require("../../config").resetConfig();
  }
});

test("Telegram: «اسأل …» answers with the dates and a Send on WhatsApp button; the web answer is labelled", async () => {
  const { admin } = await seed();
  await h.tgLink("broker");
  fakeModel();
  const out = await h.tgText("broker", "اسأل Badya delivery استلام امتى؟");
  expect(textOf(out)).toContain("2028");
  expect(textOf(out)).toContain("الأسعار 2026-10-01");
  expect(out.some((m) => m.keyboard)).toBe(true);
  await Assistant.setWeb(h.pool, admin.agency_id, { enabled: true });
  fakeModel({ web: { __text: "حوالي 300 ألف.", __grounding: GROUNDING } });
  const web = await h.tgText("broker", "اسأل رسوم النادي في Badya كام؟");
  expect(textOf(web)).toContain("غير مؤكد");
  expect(textOf(web)).toContain("https://news.example/badya");
});
