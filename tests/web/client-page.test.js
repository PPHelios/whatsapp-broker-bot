// tests/web/client-page.test.js — Release A C7: the client page's payment plans, dated schedule and PDF, the project's
// client links (never developer contacts, notes or internal links), the agency logo, and comparisons of up to 3 units
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const sharp = require("sharp");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Share = require("../../lib/shareLinks");
const Catalogue = require("../../services/catalogue");
const ClientPlans = require("../../domain/clientPlans");

jest.setTimeout(120000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const open = (path) => request(h.app.app).get(path).set("User-Agent", BROWSER);
const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const PLANS = { plans: [{ name: "10% / 8y", down_payment_pct: 10, years: 8, frequency: "quarterly", maintenance_pct: 8, extra_fees: [{ label: "Club", amount: 150000 }], source: "project", plan_id: "project:x", notes: "SENTINEL_PLAN_NOTE" }] };

async function seed() {
  const admin = await row("admin");
  const dev = (await Catalogue.saveDeveloper(h.pool, admin, { name: "Palm Hills", contact_name: "SENTINEL_DEVCONTACT", contact_phone: "01088887777" })).developer;
  const project = (await Catalogue.saveProject(h.pool, admin, { name: "بادية", name_en: "Badya", developer_id: dev.id, delivery_year: "2028", delivery_quarter: "2", notes: "SENTINEL_PROJECT_NOTE" })).project;
  await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "Brochure", url: "https://example.com/brochure.pdf", kind: "brochure", client_visible: "1" });
  await Catalogue.saveMaterial(h.pool, admin, project.id, { label: "SENTINEL_INTERNAL", url: "https://example.com/internal", kind: "other" });
  const l = await h.insertListing({ code: "BD-1", project_id: project.id, price_value: 10000000, area_value: 160, payment_terms: PLANS, details: { notes: "SENTINEL_NOTES" } });
  const broker = await row("broker");
  const { token } = await Share.createShareLink(h.pool, broker, l, { channel: "web", lang: "en" });
  return { admin, project, listing: l, path: `/agency-alpha/BD-1?s=${token}` };
}

const NEVER = /SENTINEL|01088887777|Palm Hills/;

describe("plans, schedule and PDF", () => {
  test("the page shows the plans with their numbers and the project's client links, nothing internal", async () => {
    const { path } = await seed();
    const page = await open(path);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/data-plan="0"/);
    expect(page.text).toMatch(/1,000,000/); // 10% down
    expect(page.text).toMatch(/281,250/); // 32 quarterly installments
    expect(page.text).toMatch(/Brochure/);
    expect(page.text).toMatch(/Q2 2028/);
    expect(page.text).not.toMatch(NEVER);

    const sched = await open(`${path}&lang=en&plan=0`);
    expect(sched.text).toMatch(/data-schedule="0"/);
    expect(sched.text).toMatch(/Installment 32/);
    expect(sched.text).not.toMatch(NEVER);
  });

  test("the schedule PDF renders, a page per 20 rows; an unknown plan is not found", async () => {
    const { path } = await seed();
    const pdf = await open(path.replace("?", "/schedule.pdf?") + "&plan=0&lang=ar").buffer(true).parse((res, cb) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toMatch(/application\/pdf/);
    expect(pdf.body.slice(0, 5).toString()).toBe("%PDF-");
    expect(pdf.body.toString("latin1")).toMatch(/\/Count 2/); // 33 rows: 13 on the first page, 20 on the next
    expect((await open(path.replace("?", "/schedule.pdf?") + "&plan=5")).status).toBe(404);
  });

  test("clientPlans keeps only the client's terms", () => {
    const [p] = ClientPlans.clientPlans({ listing_type: "sale", price_value: 10000000, payment_terms: PLANS }, "en");
    expect(Object.keys(p).sort()).toEqual(["discount_pct", "down_payment_pct", "fees", "frequency", "frequency_label", "index", "name", "summary", "years"]);
    expect(JSON.stringify(p)).not.toMatch(/SENTINEL|project:x/);
    expect(ClientPlans.clientPlans({ listing_type: "rent", price_value: 30000, payment_terms: PLANS })).toEqual([]);
  });
});

describe("agency logo", () => {
  test("a manager uploads the logo; the client page shows it; brokers can't", async () => {
    const { path } = await seed();
    const png = await sharp({ create: { width: 900, height: 300, channels: 4, background: { r: 0, g: 80, b: 160, alpha: 1 } } }).png().toBuffer();
    const { agent, csrf } = await signIn(h, "admin");
    expect((await agent.get("/app/settings")).text).toMatch(/id="brand"/);
    const up = await agent.post("/app/settings/logo").field("_csrf", csrf).attach("logo", png, { filename: "logo.png", contentType: "image/png" });
    expect(up.headers.location).toMatch(/logo=saved/);
    const url = (await h.query("SELECT logo_url FROM agencies WHERE id = $1", [h.AGENCY_A]))[0].logo_url;
    expect(url).toMatch(/^https:\/\/storage\.test\/listing-images\/.+\/brand\/logo-[0-9a-f]{12}\.png$/);
    expect((await open(path)).text).toContain(`src="${url}"`);
    const bad = await agent.post("/app/settings/logo").field("_csrf", csrf).attach("logo", Buffer.from("not an image"), { filename: "x.png", contentType: "image/png" });
    expect(bad.headers.location).toMatch(/logo=bad/);

    const b = await signIn(h, "broker");
    expect((await b.agent.get("/app/settings")).text).not.toMatch(/id="brand"/);
    expect((await b.agent.post("/app/settings/logo").field("_csrf", b.csrf).attach("logo", png, { filename: "l.png", contentType: "image/png" })).status).toBe(403);
  });
});

describe("compare up to 3", () => {
  test("a broker sends one link for 2 units; the client sees them side by side; opens alert the broker", async () => {
    await seed();
    await h.insertListing({ code: "HP-2", price_value: 8000000, area_value: 100, details: { notes: "SENTINEL_NOTES_2" } });
    const { agent, csrf } = await signIn(h, "broker");
    expect((await agent.get("/app/units/BD-1")).text).toMatch(/data-compare-start/);
    const one = await agent.post("/app/compare").type("form").send({ _csrf: csrf, code: ["BD-1"] });
    expect(one.text).toMatch(/data-compare-error="count"/);
    const missing = await agent.post("/app/compare").type("form").send({ _csrf: csrf, code: ["BD-1", "NOPE-1"] });
    expect(missing.text).toMatch(/NOPE-1/);
    const made = await agent.post("/app/compare").type("form").send({ _csrf: csrf, code: ["bd-1", "HP-2", ""], lang: "en" });
    const url = made.text.match(/data-compare-url>([^<]+)</)[1];
    const path = new URL(url).pathname;
    expect(path).toMatch(/^\/agency-alpha\/compare\/[A-Za-z0-9_-]{16,}$/);

    const page = await open(path);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/data-compare="BD-1,HP-2"/);
    expect(page.text).toMatch(/62,500/); // 10,000,000 / 160 m²
    expect(page.text).toMatch(/80,000/); // 8,000,000 / 100 m²
    expect(page.text).not.toMatch(NEVER);
    const opens = await h.query("SELECT open_count FROM compare_links");
    expect(opens[0].open_count).toBe(1);
    expect((await h.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'share_opened'"))[0].n).toBe(1);
    expect((await open("/agency-alpha/compare/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });
});
