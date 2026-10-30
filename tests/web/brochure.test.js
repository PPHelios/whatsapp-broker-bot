// tests/web/brochure.test.js — Release B C6: a project's brochure read into stored facts (same switch, allowance and
// shared page cache as price lists) and 3 to 5 suggested highlight lines that clients never see until a manager saves
// them; typed lines need no AI; the saved lines show on the client's unit page.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { PDFDocument } = require("pdf-lib");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const FakeAI = require("../harness/fake-ai");
const Share = require("../../lib/shareLinks");
const Catalogue = require("../../services/catalogue");
const Brochure = require("../../services/brochure");
const PriceReading = require("../../services/priceReading");
const B = require("../../domain/brochure");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

async function pdf(n) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage([700 + i, 900]);
  return Buffer.from(await d.save());
}

function fakeModel() {
  FakeAI.respond((call) => {
    if (call.operation === "brochure_read") {
      const text = Buffer.from(call.contents[0].parts[1].inlineData.data, "base64").toString("latin1");
      const width = (text.match(/MediaBox\s*\[\s*0\s+0\s+(\d+)/) || [])[1];
      if (width === "700") return { facts: [{ topic: "location", text: "10 minutes from the Ring Road" }, { topic: "amenities", text: "Club house and 3 pools" }] };
      return { facts: [{ topic: "delivery", text: "Delivery in 2028" }, { topic: "amenities", text: "Club house and 3 pools" }, { topic: "nonsense", text: "Green spaces 70%" }] };
    }
    if (call.operation === "brochure_highlights") {
      expect(call.contents).toContain("Club house and 3 pools");
      return { ar: ["على بعد 10 دقايق من الدائري", "كلوب هاوس و3 حمامات سباحة", "استلام 2028"], en: ["10 minutes from the Ring Road", "Club house and 3 pools", "Delivery in 2028"] };
    }
    throw new Error(`unexpected ${call.operation}`);
  });
}

test("rules: facts, lines, the manager's text", () => {
  expect(B.factsFromAnswer('{"facts":[{"topic":"x","text":" A  fact "},{"text":""}]}')).toEqual({ result: [{ topic: "other", text: "A fact" }] });
  expect(B.linesFromAnswer('{"ar":["1","2","3","4","5","6"]}').ar).toHaveLength(5);
  expect(B.linesFromText("• first\n\n2. second\n- third")).toEqual(["first", "second", "third"]);
  expect(B.linesFromText("1\n2\n3\n4\n5\n6")).toEqual({ error: "too_many_lines" });
  expect(B.highlightsFor({ ar: ["أ"], en: [] }, "en")).toEqual(["أ"]);
  expect(B.mergeFacts([[{ topic: "a", text: "X" }], [{ topic: "a", text: "x" }, { topic: "b", text: "Y" }]])).toHaveLength(2);
});

test("read the brochure: facts stored, lines suggested, nothing public until saved; typed lines need no AI", async () => {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya" })).project;
  const l = await h.insertListing({ code: "BD-1", project_id: project.id, price_value: 10000000 });
  const { token } = await Share.createShareLink(h.pool, await row("broker"), l, { channel: "web", lang: "en" });
  const publicPage = () => request(h.app.app).get(`/agency-alpha/BD-1?s=${token}`).set("User-Agent", BROWSER);
  const files = [{ buffer: await pdf(3), mimetype: "application/pdf", originalname: "badya.pdf" }];
  fakeModel();

  expect((await Brochure.read(h.pool, admin, project.id, { files, pages: "1-2" })).error).toBe("OFF");
  // Typing lines needs no switch and no AI.
  expect((await Brochure.saveHighlights(h.pool, admin, project.id, { ar: "سطر يدوي", en: "" })).ok).toBe(true);
  expect(FakeAI.calls).toHaveLength(0);
  expect((await Brochure.saveHighlights(h.pool, await row("broker"), project.id, { ar: "x" })).error).toBe("forbidden");

  await PriceReading.setForAgency(h.pool, admin.agency_id, { enabled: "on", pages_month: "10" });
  const r = await Brochure.read(h.pool, admin, project.id, { files, pages: "1-2" });
  expect(r).toMatchObject({ ok: true, read: 2, reused: 0 });
  expect(r.facts.map((f) => f.text)).toEqual(["10 minutes from the Ring Road", "Club house and 3 pools", "Delivery in 2028", "Green spaces 70%"]);
  expect(r.facts[3].topic).toBe("other");
  const [p] = await h.query("SELECT brochure, highlights FROM projects WHERE id = $1", [project.id]);
  expect(p.brochure).toMatchObject({ pages: [1, 2], file_name: "badya.pdf", suggested: { en: ["10 minutes from the Ring Road", "Club house and 3 pools", "Delivery in 2028"] } });
  expect(p.highlights).toEqual({ ar: ["سطر يدوي"], en: [] }); // the saved lines stay until the manager saves new ones
  expect((await PriceReading.usage(h.pool, admin.agency_id)).used).toBe(2);

  // Same pages again: no page reads (cache), only the lines call; the agency is charged for them all the same.
  await Brochure.read(h.pool, admin, project.id, { files, pages: "2, 1" });
  expect(FakeAI.calls.filter((c) => c.operation === "brochure_read")).toHaveLength(2);
  expect((await PriceReading.usage(h.pool, admin.agency_id)).used).toBe(4);

  // Before saving, the client page shows only the manager's typed line.
  let page = await publicPage();
  expect(page.text).toContain("سطر يدوي");
  expect(page.text).not.toContain("Ring Road");

  const { agent, csrf } = await signIn(h, "admin");
  await h.query("UPDATE projects SET highlights = '{}'::jsonb WHERE id = $1", [project.id]);
  const projectPage = await agent.get(`/app/catalogue/projects/${project.id}`);
  expect(projectPage.text).toContain("data-suggested");
  expect(projectPage.text).toContain("data-brochure-read");
  expect(projectPage.text).toContain("Club house and 3 pools");
  const save = await agent.post(`/app/catalogue/projects/${project.id}/highlights`).type("form").send({ _csrf: csrf, ar: "كلوب هاوس و3 حمامات سباحة\nاستلام 2028", en: "Club house and 3 pools\nDelivery in 2028" });
  expect(save.status).toBe(303);
  page = await publicPage();
  expect(page.text).toContain("data-public-highlights");
  expect(page.text).toContain("Delivery in 2028");
  expect(page.text).not.toContain("Ring Road"); // facts never reach the client page

  const tooMany = await agent.post(`/app/catalogue/projects/${project.id}/highlights`).type("form").send({ _csrf: csrf, ar: "1\n2\n3\n4\n5\n6" });
  expect(tooMany.headers.location).toContain("brochure_error=too_many_lines");
});
