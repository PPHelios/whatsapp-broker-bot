// tests/router/deals.test.js — Deals (Release 3 step 10): «صفقة …» / `deal …` → review → Confirm records the deal, the
// lead won and the unit sold together; a unit changed since the review refuses the whole deal; a double tap saves
// once; a missing commission is asked for; split with the unit's broker or a named colleague; visibility per role
// (WhatsApp and web); a manager corrects; commission never reaches a client copy.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const Deals = require("../../services/deals");
const Describe = require("../../domain/describe");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const ids = (r) => (r.buttons || []).map((b) => b.id);
const one = (who, replies) => {
  const mine = to(who, replies);
  expect(mine).toHaveLength(1);
  return mine[0];
};
const lead = async (who = "broker", phones = "01012345678", name = "Sara") => (await Leads.captureLead(h.pool, await row(who), { phones, name })).lead;
const deals = () => h.query("SELECT * FROM deals ORDER BY ref");
const splits = () => h.query("SELECT b.name, s.pct, s.amount FROM deal_splits s JOIN brokers b ON b.id = s.broker_id ORDER BY s.amount DESC");

describe("WhatsApp", () => {
  test("the Arabic command → review → Confirm: the deal, the lead won and the unit sold together", async () => {
    const l = await lead();
    await h.insertListing({ code: "VIL-08", property_type: "villa", price_value: 9e6 });
    const review = one("broker", await h.text("broker", "صفقة L-0001 VIL-08 8.5 مليون عمولة 2%"));
    expect(review.text).toContain("Sara · L-0001");
    expect(review.text).toContain("8,500,000 ج.م");
    expect(review.text).toContain("2% = 170,000 ج.م");
    expect(review.text).toMatch(/VIL-08 هتتعلم اتباعت/);
    expect(ids(review).map((x) => x.split(":")[1])).toEqual(["ok", "edit", "no"]);
    expect(await deals()).toHaveLength(0);

    const saved = one("broker", await h.tap("broker", ids(review)[0]));
    expect(saved.text).toMatch(/✅ اتسجلت الصفقة D-0001\. العمولة 170,000 ج\.م، نصيبك 170,000 ج\.م/);
    const [d] = await deals();
    expect(d).toMatchObject({ ref: 1, unit_code: "VIL-08", deal_type: "sale", commission_mode: "pct", status: "pending", client_name: "Sara", client_phone: "+201012345678" });
    expect(Number(d.commission_total)).toBe(170000);
    expect((await h.query("SELECT stage FROM leads WHERE id = $1", [l.id]))[0].stage).toBe("won");
    expect((await h.query("SELECT status FROM listings WHERE code = 'VIL-08'"))[0].status).toBe("sold");
    expect((await h.query("SELECT data FROM lead_events WHERE kind = 'deal'"))[0].data).toMatchObject({ ref: 1, unit_code: "VIL-08" });

    // A second tap on the same Confirm saves nothing more.
    const again = one("broker", await h.tap("broker", ids(review)[0]));
    expect(again.text).toMatch(/D-0001 اتسجلت خلاص/);
    expect(await deals()).toHaveLength(1);
  });

  test("the English command with a split: 60/40 with the unit's broker, whole EGP that add up", async () => {
    await lead();
    await h.insertListing({ code: "VIL-08", broker_id: h.BROKERS.colleague.id });
    const review = one("broker", await h.text("broker", "deal L-0001 VIL-08 8.5M commission 2% split 60/40"));
    expect(review.text).toContain("Broker One 60% = 102,000");
    expect(review.text).toContain("Broker Two 40% = 68,000");
    // Not the broker's unit: it stays as it is.
    expect(review.text).toMatch(/VIL-08 هتفضل زي ما هي/);
    await h.tap("broker", ids(review)[0]);
    expect((await splits()).map((s) => [s.name, Number(s.amount)])).toEqual([["Broker One", 102000], ["Broker Two", 68000]]);
    expect((await h.query("SELECT status FROM listings WHERE code = 'VIL-08'"))[0].status).toBe("active");
  });

  test("a missing commission is asked for; the next message completes the review; Cancel saves nothing", async () => {
    await lead();
    await h.insertListing({ code: "VIL-08" });
    expect(one("broker", await h.text("broker", "deal L-0001 VIL-08 8.5M")).text).toMatch(/العمولة كام/);
    const review = one("broker", await h.text("broker", "170 ألف"));
    expect(review.text).toContain("170,000 ج.م");
    const cancel = ids(review).find((x) => x.startsWith("dl:no:"));
    expect(one("broker", await h.tap("broker", cancel)).text).toMatch(/اتلغت/);
    expect(await deals()).toHaveLength(0);
    expect((await h.query("SELECT stage FROM leads"))[0].stage).toBe("new");
  });

  test("a unit changed after the review refuses the whole deal (nothing saved, lead not won)", async () => {
    await lead();
    await h.insertListing({ code: "VIL-08" });
    const review = one("broker", await h.text("broker", "صفقة L-0001 VIL-08 8.5 مليون عمولة 2%"));
    await h.text("broker", "سعر VIL-08 9 مليون");
    const r = one("broker", await h.tap("broker", ids(review)[0]));
    expect(r.text).toMatch(/الوحدة اتعدلت من مكان تاني/);
    expect(await deals()).toHaveLength(0);
    expect((await h.query("SELECT stage FROM leads"))[0].stage).toBe("new");
    expect((await h.query("SELECT status FROM listings"))[0].status).toBe("active");
  });

  test("a colleague's lead and bad input are refused before any review", async () => {
    await lead("colleague");
    expect(one("broker", await h.text("broker", "deal L-0001 8.5M commission 2%")).text).toMatch(/مش معاك/);
    await lead("broker", "01112345678", "Mine");
    expect(one("broker", await h.text("broker", "deal L-0002 8.5M commission 120%")).text).toMatch(/بين 0 و 100/);
    expect(one("broker", await h.text("broker", "صفقة")).text).toMatch(/صفقة L-0042/);
    expect(await deals()).toHaveLength(0);
  });
});

describe("visibility, corrections and client copies", () => {
  async function seedDeal() {
    await lead();
    const unit = await h.insertListing({ code: "VIL-08" });
    const r = await Deals.createDeal(h.pool, await row("broker"), { leadKey: 1, unitCode: "VIL-08", price: 8500000, mode: "pct", pct: 2, splits: [{ brokerId: h.BROKERS.colleague.id, pct: 40 }] });
    expect(r.ok).toBe(true);
    return { deal: r.deal, unit };
  }

  test("a broker sees their deals and only their share; a colleague with a share sees theirs; the rival nothing; managers all", async () => {
    const { deal } = await seedDeal();
    const mine = await Deals.getDeal(h.pool, await row("broker"), "D-0001");
    expect(mine.shares.map((s) => Number(s.amount))).toEqual([102000]);
    const theirs = await Deals.getDeal(h.pool, await row("colleague"), deal.id);
    expect(theirs.shares.map((s) => Number(s.amount))).toEqual([68000]);
    expect(await Deals.getDeal(h.pool, await row("rival"), deal.id)).toBeNull();
    const admin = await Deals.getDeal(h.pool, await row("admin"), deal.id);
    expect(admin.shares).toHaveLength(2);
    expect((await Deals.listDeals(h.pool, await row("colleague"))).rows[0].my_share).toBe(68000);
    expect(await Deals.monthlyTotals(h.pool, await row("admin"))).toEqual([expect.objectContaining({ deals: 1, commission: 170000, agency: 170000, volume: 8500000 })]);
    expect(await Deals.monthlyTotals(h.pool, await row("colleague"))).toEqual([expect.objectContaining({ deals: 1, mine: 68000 })]);

    const b = await signIn(h, "colleague");
    const page = await b.agent.get("/app/deals/D-0001");
    expect(page.status).toBe(200);
    expect(page.text).toContain("68,000");
    expect(page.text).not.toContain("102,000");
    expect(page.text).not.toContain("170,000");
    const r = await signIn(h, "rival");
    expect((await r.agent.get("/app/deals/D-0001")).status).toBe(404);
  });

  test("a manager corrects the money (shares worked out again); a broker can move the status but not the money; stale versions conflict", async () => {
    const { deal } = await seedDeal();
    expect((await Deals.updateDeal(h.pool, await row("broker"), deal.id, { mode: "pct", pct: 3 })).error).toBe("forbidden");
    expect((await Deals.updateDeal(h.pool, await row("broker"), deal.id, { status: "signed" }, { version: 1 })).ok).toBe(true);
    expect((await Deals.updateDeal(h.pool, await row("admin"), deal.id, { status: "paid" }, { version: 1 })).conflict).toBe(true);

    const a = await signIn(h, "admin");
    const res = await a.agent.post("/app/deals/D-0001").type("form").send({ _csrf: a.csrf, version: 2, price: "8500000", commission: "3%", external: "10%" });
    expect(res.status).toBe(303);
    const [d] = await deals();
    expect(Number(d.commission_total)).toBe(255000);
    expect(Number(d.external_share)).toBe(25500);
    expect((await splits()).map((s) => Number(s.amount))).toEqual([137700, 91800]);
  });

  test("the web form records a deal once (double submit), and the lead page links to it", async () => {
    await lead();
    await h.insertListing({ code: "VIL-08" });
    const b = await signIn(h, "broker");
    const leadPage = await b.agent.get("/app/leads/L-0001");
    expect(leadPage.text).toContain('href="/app/deals/new?lead=L-0001"');
    const form = await b.agent.get("/app/deals/new?lead=L-0001");
    const idem = form.text.match(/name="idem" value="([0-9a-f]{16})"/)[1];
    const body = { _csrf: b.csrf, idem, lead: "L-0001", unit: "VIL-08", price: "8.5 مليون", commission: "2%", mark_sold: "1", status: "signed" };
    const first = await b.agent.post("/app/deals/new").type("form").send(body);
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe("/app/deals/D-0001?saved=1");
    const second = await b.agent.post("/app/deals/new").type("form").send(body);
    expect(second.headers.location).toBe("/app/deals/D-0001?saved=1");
    expect(await deals()).toHaveLength(1);
    expect((await h.query("SELECT status FROM listings"))[0].status).toBe("sold");
    const list = await b.agent.get("/app/deals");
    expect(list.text).toContain("D-0001");
    expect(list.text).toContain("170,000");
    // A missing commission is a 422 that keeps what was typed.
    const bad = await b.agent.post("/app/deals/new").type("form").send({ ...body, idem: "0123456789abcdef", commission: "" });
    expect(bad.status).toBe(422);
    expect(bad.text).toContain('value="8.5 مليون"');
  });

  test("commission never appears in a client copy or the public unit page", async () => {
    const { unit } = await seedDeal();
    const fresh = (await h.query("SELECT * FROM listings WHERE id = $1", [unit.id]))[0];
    const copy = Describe.clientCopy(fresh, await row("broker"), { lang: "ar" }) + Describe.clientCopy(fresh, await row("broker"), { lang: "en" });
    for (const s of ["170,000", "170000", "102,000", "عمولة", "ommission", "D-0001"]) expect(copy).not.toContain(s);
    const replies = await h.text("broker", "عميل VIL-08");
    const text = to("broker", replies).map((r) => r.text || r.caption || "").join("\n");
    for (const s of ["170,000", "عمولة", "D-0001"]) expect(text).not.toContain(s);
  });
});
