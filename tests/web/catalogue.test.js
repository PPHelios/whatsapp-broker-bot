// tests/web/catalogue.test.js — Release A C1: developers, projects, phases, payment plans, materials, linked units
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Catalogue = require("../../services/catalogue");
const Financials = require("../../lib/financials");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

async function seedProject() {
  const admin = await row("admin");
  const dev = await Catalogue.saveDeveloper(h.pool, admin, { name: "بالم هيلز", name_en: "Palm Hills", contact_name: "Omar Sales", contact_phone: "01099998888" });
  expect(dev.ok).toBe(true);
  const p = await Catalogue.saveProject(h.pool, admin, { name: "Badya", developer_id: dev.developer.id, delivery_year: "٢٠٢٨", delivery_quarter: "2", maintenance_pct: "8", notes: "commission 3% from unit 5" });
  expect(p.ok).toBe(true);
  return { admin, developer: dev.developer, project: p.project };
}

describe("projects and plans", () => {
  test("a plan follows every unit of the project (phase plans only that phase's units); a unit's own plans stay; the worked example holds", async () => {
    const { admin, project } = await seedProject();
    const ph = (await Catalogue.savePhase(h.pool, admin, project.id, { name: "Phase 2", delivery_year: "2029" })).phase;
    await h.insertListing({ code: "BD-1", property_type: "apartment", price_value: 10000000 });
    await h.insertListing({ code: "BD-2", property_type: "apartment", price_value: 10000000 });
    await h.insertListing({ code: "BD-3", property_type: "apartment", price_value: 10000000 });
    await h.query(`UPDATE listings SET payment_terms = '{"plans_own": true, "plans": [{"name": "Special", "down_payment_pct": 0, "years": 1}]}'::jsonb WHERE code = 'BD-3'`);
    expect(await Catalogue.linkUnits(h.pool, admin, project.id, { codes: "bd-1 #BD-3, NOPE-9" })).toMatchObject({ ok: true, linked: 2, missing: ["NOPE-9"] });
    expect((await Catalogue.linkUnits(h.pool, admin, project.id, { codes: "BD-2", phaseId: ph.id })).linked).toBe(1);

    const r = await Catalogue.savePlan(h.pool, admin, project.id, { name: "10% / 8y", down_payment_pct: "10", years: "8", frequency: "quarterly", maintenance_pct: "8", maintenance_due: "delivery", fee_label: ["Club", ""], fee_amount: ["150,000", ""] });
    expect(r.ok).toBe(true);
    await Catalogue.savePlan(h.pool, admin, project.id, { name: "5+5 / 7y", phase_id: ph.id, down_payment_pct: "5", years: "7", milestone_pct: ["5"], milestone_months: ["12"], milestone_label: ["after a year"] });

    const plansOf = async (code) => (await h.query("SELECT payment_terms FROM listings WHERE code = $1", [code]))[0].payment_terms.plans;
    const one = await plansOf("BD-1");
    expect(one.map((p) => p.name)).toEqual(["10% / 8y"]);
    expect(one[0]).toMatchObject({ source: "project", extra_fees: [{ label: "Club", amount: 150000 }] });
    expect((await plansOf("BD-2")).map((p) => p.name)).toEqual(["10% / 8y", "5+5 / 7y"]);
    expect((await plansOf("BD-3")).map((p) => p.name)).toEqual(["Special"]);

    // The design's worked example: 10,000,000, 10% down, 8 years quarterly, 8% maintenance.
    const s = Financials.calculatePlanSummary(10000000, one[0]);
    expect(s).toMatchObject({ down_payment: 1000000, total_installments_count: 32, installment_amount: 281250, total_maintenance: 800000 });
    const s2 = Financials.calculatePlanSummary(10000000, { ...(await plansOf("BD-2"))[1], maintenance_pct: 8 });
    expect(s2).toMatchObject({ down_payment: 500000, total_milestones_amount: 500000, total_installments_count: 28, installment_amount: 321429 });

    // Deleting the plan takes it off the units; unlinking a unit removes the project's plans only.
    await Catalogue.deletePlan(h.pool, admin, project.id, r.plan.id);
    expect(await plansOf("BD-1")).toEqual([]);
    const bd2 = (await h.query("SELECT id FROM listings WHERE code = 'BD-2'"))[0];
    expect((await Catalogue.unlinkUnit(h.pool, admin, project.id, bd2.id)).ok).toBe(true);
    expect(await plansOf("BD-2")).toEqual([]);
  });

  test("bad values are refused with the field; nothing is invented (no maintenance stays blank)", async () => {
    const { admin, project } = await seedProject();
    expect(await Catalogue.savePlan(h.pool, admin, project.id, { name: "x", down_payment_pct: "" })).toMatchObject({ error: "invalid", field: "down_payment_pct" });
    expect(await Catalogue.savePlan(h.pool, admin, project.id, { name: "x", down_payment_pct: "60", milestone_pct: ["50"], milestone_months: ["6"] })).toMatchObject({ field: "milestones" });
    expect(await Catalogue.savePlan(h.pool, admin, project.id, { name: "x", down_payment_pct: "10", fee_label: ["Club"], fee_amount: [""] })).toMatchObject({ field: "extra_fees" });
    expect(await Catalogue.saveProject(h.pool, admin, { name: "Y", delivery_year: "28" })).toMatchObject({ field: "delivery_year" });
    expect(await Catalogue.saveProject(h.pool, admin, { name: "badya" })).toMatchObject({ error: "duplicate" });
    const p = (await Catalogue.savePlan(h.pool, admin, project.id, { name: "Cash 25%", down_payment_pct: "100", discount_pct: "25" })).plan;
    expect(p.maintenance_pct).toBeNull();
    const fresh = (await Catalogue.saveProject(h.pool, admin, { name: "No maintenance" })).project;
    expect(fresh.maintenance_pct).toBeNull();
  });

  test("brokers read the catalogue but never edit it and never see the developer contact or notes; agencies are separate", async () => {
    const { project, developer } = await seedProject();
    const broker = await row("broker");
    expect((await Catalogue.saveProject(h.pool, broker, { name: "Mine" })).error).toBe("forbidden");
    expect((await Catalogue.savePlan(h.pool, broker, project.id, { name: "x", down_payment_pct: "10" })).error).toBe("forbidden");
    const seen = await Catalogue.getProject(h.pool, broker, project.id);
    expect(seen.developer).not.toHaveProperty("contact_phone");
    expect(seen.project.notes).toBeNull();
    expect((await Catalogue.listDevelopers(h.pool, broker))[0]).not.toHaveProperty("contact_name");
    const rival = { ...(await row("rival")), role: "admin" };
    expect(await Catalogue.getProject(h.pool, rival, project.id)).toBeNull();
    expect(await Catalogue.getDeveloper(h.pool, rival, developer.id)).toBeNull();
    expect((await Catalogue.linkUnits(h.pool, rival, project.id, { codes: "X" })).error).toBe("not_found");
  });
});

describe("materials", () => {
  test("client-visible or internal; a price sheet is always internal; clients get only visible links", async () => {
    const { admin, project } = await seedProject();
    await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Brochure", kind: "brochure", url: "https://example.com/b.pdf", client_visible: "1" });
    await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Prices", kind: "price_sheet", url: "https://example.com/p.xlsx", client_visible: "1" });
    await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Commission letter", kind: "other", url: "https://example.com/c.pdf" });
    expect(await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "x", url: "javascript:alert(1)" })).toMatchObject({ field: "url" });
    const listing = await h.insertListing({ code: "BD-9" });
    await h.query("UPDATE listings SET project_id = $1 WHERE code = 'BD-9'", [project.id]);
    const unit = (await h.query("SELECT * FROM listings WHERE code = 'BD-9'"))[0];
    expect((await Catalogue.clientMaterials(h.pool, unit)).map((m) => m.label)).toEqual(["Brochure"]);
    expect((await Catalogue.projectForUnit(h.pool, unit)).materials).toHaveLength(3);
    expect(listing).toBeDefined();
  });

  test("the weekly check marks broken links once and alerts the managers once; a fixed link clears", async () => {
    const { admin, project } = await seedProject();
    const m = (await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Master plan", kind: "master_plan", url: "https://example.com/mp" })).material;
    const alerts = [];
    const now = new Date("2026-11-01T08:00:00Z");
    expect(await Catalogue.checkLinks(h.pool, { now, opens: async () => false, notify: async (x) => alerts.push(x.id) })).toEqual({ checked: 1, broken: 1 });
    // Not again within the week.
    expect((await Catalogue.checkLinks(h.pool, { now: new Date(now.getTime() + 3600e3), opens: async () => false, notify: async (x) => alerts.push(x.id) })).checked).toBe(0);
    const later = new Date(now.getTime() + 8 * 24 * 3600e3);
    await Catalogue.checkLinks(h.pool, { now: later, opens: async () => false, notify: async (x) => alerts.push(x.id) });
    expect(alerts).toEqual([m.id]);
    await Catalogue.checkLinks(h.pool, { now: new Date(later.getTime() + 8 * 24 * 3600e3), opens: async () => true });
    expect((await h.query("SELECT check_status, broken_since FROM project_materials WHERE id = $1", [m.id]))[0]).toEqual({ check_status: "ok", broken_since: null });
  });

  test("a private address is never fetched", async () => {
    const fetchImpl = jest.fn();
    expect(await Catalogue.linkOpens("http://127.0.0.1/admin", { fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await Catalogue.linkOpens("https://example.com/x", { fetchImpl: async () => ({ status: 200 }), safe: async () => true })).toBe(true);
    expect(await Catalogue.linkOpens("https://example.com/x", { fetchImpl: async (_u, o) => ({ status: o.method === "HEAD" ? 405 : 206 }), safe: async () => true })).toBe(true);
  });
});

describe("the pages", () => {
  test("a manager adds a developer, a project, a plan and a link on the website; a broker reads without forms or contact", async () => {
    const { agent, csrf } = await signIn(h, "admin");
    const post = (url, body) => agent.post(url).set("X-CSRF-Token", csrf).type("form").send(body);
    expect((await post("/app/catalogue/developers", "name=Mountain+View&contact_phone=01011112222")).status).toBe(303);
    const created = await post("/app/catalogue/projects", "name=iCity&developer_name=Mountain+View&delivery_year=2027");
    expect(created.status).toBe(303);
    const url = created.headers.location.split("?")[0];
    expect((await h.query("SELECT count(*)::int AS n FROM developers"))[0].n).toBe(1);
    expect((await post(`${url}/plans`, "name=Cash&down_payment_pct=100&discount_pct=20")).status).toBe(303);
    expect((await post(`${url}/materials`, "label=Brochure&kind=brochure&url=https%3A%2F%2Fexample.com%2Fb.pdf&client_visible=1")).status).toBe(303);
    expect((await post(`${url}/plans`, "name=Bad&down_payment_pct=abc")).status).toBe(400);
    const page = (await agent.get(url)).text;
    expect(page).toMatch(/data-plan=/);
    expect(page).toMatch(/data-material=[^>]*data-client-visible="1"/);
    expect(page).toMatch(/data-developer-contact>01011112222/);

    const b = await signIn(h, "broker");
    const seen = await b.agent.get(url);
    expect(seen.status).toBe(200);
    expect(seen.text).not.toMatch(/01011112222|data-plan-form|data-material-form/);
    expect((await b.agent.post(`${url}/plans`).set("X-CSRF-Token", b.csrf).type("form").send("name=x&down_payment_pct=10")).status).toBe(403);
    expect((await b.agent.get("/app/catalogue")).text).toMatch(/iCity/);
    const rival = await signIn(h, "rival");
    expect((await rival.agent.get(url)).status).toBe(404);
    expect((await agent.get("/app/more")).text).toMatch(/href="\/app\/catalogue"/);
  });

  test("a linked unit's page names its project and links (internal ones marked); the bot's collateral lists them", async () => {
    const { admin, project } = await seedProject();
    await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Brochure", kind: "brochure", url: "https://example.com/b.pdf", client_visible: "1" });
    await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Commission letter", url: "https://example.com/c.pdf" });
    await h.insertListing({ code: "BD-5" });
    await Catalogue.linkUnits(h.pool, admin, project.id, { codes: "BD-5" });
    const { agent } = await signIn(h, "broker");
    const unit = (await agent.get("/app/units/BD-5")).text;
    expect(unit).toMatch(new RegExp(`data-project="${project.id}"`));
    expect(unit).toMatch(/Commission letter<\/a> 🔒/);
    const sent = (await h.text("broker", "layout BD-5")).map((r) => JSON.stringify(r));
    expect(sent.join("\n")).toMatch(/Brochure\*: https:\/\/example.com\/b.pdf/);
    expect(sent.join("\n")).toMatch(/Commission letter\* 🔒/);
  });
});

describe("F20 uploaded files", () => {
  test("new project with a brochure file and a link; upload on the project page; broker cannot upload; delete removes the file", async () => {
    const Storage = require("../harness/fake-supabase");
    const { agent, csrf } = await signIn(h, "admin");
    const pdf = Buffer.from("%PDF-1.4 fake");
    const created = await agent.post("/app/catalogue/projects").field("_csrf", csrf).field("name", "Zed").field("material_url", "https://example.com/zed").attach("file", pdf, { filename: "Zed Brochure.pdf", contentType: "application/pdf" });
    expect(created.status).toBe(303);
    expect(created.headers.location).toMatch(/saved=1$/);
    const url = created.headers.location.split("?")[0];
    const [project] = await h.query("SELECT id FROM projects WHERE name = 'Zed'");
    let mats = await h.query("SELECT * FROM project_materials WHERE project_id = $1 ORDER BY created_at", [project.id]);
    expect(mats.map((m) => [m.kind, m.label, Boolean(m.storage_path), m.client_visible])).toEqual([["brochure", "Zed Brochure", true, false], ["other", "Link", false, false]]);
    expect(mats[0].storage_path).toMatch(new RegExp(`^${h.AGENCY_A}/projects/${project.id}/[0-9a-f]{24}-zed-brochure\\.pdf$`));
    expect(mats[0].url).toContain(mats[0].storage_path);

    const up = await agent.post(`${url}/materials/upload`).field("_csrf", csrf).field("kind", "layout").field("unit_type", "3BR").field("client_visible", "1").attach("file", Buffer.from("\x89PNG"), { filename: "a.png", contentType: "image/png" });
    expect(up.status).toBe(303);
    const page = await agent.get(url);
    expect(page.text).toContain("data-material-upload");
    expect(page.text).toContain("📎 Zed Brochure");
    mats = await h.query("SELECT * FROM project_materials WHERE project_id = $1 AND kind = 'layout'", [project.id]);
    expect(mats[0]).toMatchObject({ unit_type: "3BR", client_visible: true });

    const bad = await agent.post(`${url}/materials/upload`).field("_csrf", csrf).attach("file", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" });
    expect(bad.status).toBe(415);

    const b = await signIn(h, "broker");
    expect((await b.agent.post(`${url}/materials/upload`).field("_csrf", b.csrf).attach("file", pdf, { filename: "x.pdf", contentType: "application/pdf" })).status).toBe(403);

    const [brochure] = await h.query("SELECT * FROM project_materials WHERE project_id = $1 AND kind = 'brochure'", [project.id]);
    expect((await Storage.downloadListingImage(brochure.url))).not.toBeNull();
    expect((await agent.post(`${url}/materials/${brochure.id}/delete`).set("X-CSRF-Token", csrf).type("form").send("")).status).toBe(303);
    expect(await Storage.downloadListingImage(brochure.url)).toBeNull();
    // Uploaded files are not link-checked.
    const checked = [];
    await Catalogue.checkLinks(h.pool, { opens: async (u) => (checked.push(u), true), notify: async () => {} });
    expect(checked.some((u) => u.startsWith("https://storage.test/"))).toBe(false);
  });
});
