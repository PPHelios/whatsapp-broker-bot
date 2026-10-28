// tests/web/plan-reading.test.js — F21: a developer's payment plans file (PDF, photos or Excel/CSV) read by AI into a
// preview on the project; the manager ticks, edits and saves ordinary plans; the file is kept under Materials.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const FakeAI = require("../harness/fake-ai");
const Catalogue = require("../../services/catalogue");
const PriceReading = require("../../services/priceReading");
const PlanReading = require("../../services/planReading");
const P = require("../../domain/planReading");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const CSV = "Plan,Down,Years\n10% / 8 years,10%,8\nCash,100%,0\n";

test("rules: plans from the answer", () => {
  const r = P.plansFromAnswer('{"plans":[{"name":" 5% over 7 ","down_payment_pct":5,"years":7,"frequency":"weird","milestones":[{"pct":5,"due_after_months":12}],"extra_fees":[{"label":"Club","amount":"150000"},{"label":"","amount":5}]},{"name":"no down"}]}');
  expect(r.result).toEqual([{ name: "5% over 7", down_payment_pct: 5, years: 7, frequency: "quarterly", discount_pct: 0, milestones: [{ pct: 5, due_after_months: 12, label: null }], maintenance_pct: null, maintenance_due: "delivery", extra_fees: [{ label: "Club", amount: 150000 }] }]);
  expect(P.plansFromAnswer("nope")).toEqual({ error: "AI_BAD_JSON" });
  expect(P.mergePlans([r.result, r.result])).toHaveLength(1);
});

test("a CSV plans file: preview, edit, save ticked plans; the file is kept internal; brokers can't", async () => {
  const admin = await row("admin");
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "Badya" })).project;
  FakeAI.respond((call) => {
    expect(call.operation).toBe("plans_read");
    expect(Buffer.from(call.contents[0].parts[1].inlineData.data, "base64").toString("utf8")).toContain("10% / 8 years\t10%\t8");
    return { plans: [{ name: "10% / 8 years", down_payment_pct: 10, years: 8, frequency: "quarterly", maintenance_pct: 8, extra_fees: [{ label: "Club", amount: 150000 }] }, { name: "Cash", down_payment_pct: 100, years: 0 }] };
  });
  const file = { buffer: Buffer.from(CSV), mimetype: "text/csv", originalname: "plans.csv" };
  expect((await PlanReading.read(h.pool, admin, project.id, { files: [file] })).error).toBe("OFF");
  await PriceReading.setForAgency(h.pool, admin.agency_id, { enabled: "on", pages_month: "10" });
  expect((await PlanReading.read(h.pool, await row("broker"), project.id, { files: [file] })).error).toBe("forbidden");

  const { agent, csrf } = await signIn(h, "admin");
  const url = `/app/catalogue/projects/${project.id}`;
  const up = await agent.post(`${url}/plans/read`).field("_csrf", csrf).attach("doc", Buffer.from(CSV), { filename: "plans.csv", contentType: "text/csv" });
  expect(up.status).toBe(303);
  const page = await agent.get(url);
  expect(page.text).toContain("data-plans-draft");
  expect(page.text).toContain('name="name_1"');
  expect((await PriceReading.usage(h.pool, admin.agency_id)).used).toBe(1);
  const [mat] = await h.query("SELECT * FROM project_materials WHERE project_id = $1", [project.id]);
  expect(mat).toMatchObject({ label: "💳 plans.csv", client_visible: false });
  expect(mat.storage_path).toMatch(/\.csv$/);

  // Tick the first only, renamed; the second is left out.
  const saved = await agent.post(`${url}/plans/draft/apply`).set("X-CSRF-Token", csrf).type("form").send("pick=0&name_0=Ten+over+eight&down_0=10&years_0=8&frequency_0=monthly&discount_0=0&maintenance_0=8");
  expect(saved.headers.location).toContain("plans_saved=1");
  const plans = await h.query("SELECT * FROM project_plans WHERE project_id = $1", [project.id]);
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({ name: "Ten over eight", frequency: "monthly" });
  expect(plans[0].extra_fees).toEqual([{ label: "Club", amount: 150000 }]);
  expect((await h.query("SELECT plans_draft FROM projects WHERE id = $1", [project.id]))[0].plans_draft).toMatchObject({ plans: [], applied: { file_name: "plans.csv" } });
  // F22: the assistant's context names the file and its date.
  const ctx = await require("../../services/projectContext").contextFor(h.pool, admin.agency_id, project.id);
  expect(ctx.summary).toMatch(/Payment plans were read from the file plans\.csv on \d{4}-\d{2}-\d{2}\./);
  expect(ctx.summary).toMatch(/Uploaded files: 💳 plans\.csv \(other, \d{4}-\d{2}-\d{2}\)\./);
  expect(ctx.summary).toContain("Payment plans: Ten over eight");

  // The same sheet again is read from the cache (not counted); discard clears it.
  expect((await PlanReading.read(h.pool, admin, project.id, { files: [file] })).reused).toBe(1);
  expect((await PriceReading.usage(h.pool, admin.agency_id)).used).toBe(1);
  expect((await agent.get(url)).text).toContain("data-plans-draft");
  await agent.post(`${url}/plans/draft/discard`).set("X-CSRF-Token", csrf).type("form").send("");
  expect((await agent.get(url)).text).not.toContain("data-plans-draft");
  expect((await h.query("SELECT plans_draft FROM projects WHERE id = $1", [project.id]))[0].plans_draft.applied.file_name).toBe("plans.csv");
});
