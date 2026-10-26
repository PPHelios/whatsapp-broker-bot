// tests/web/win-loss.test.js — Release B N7: the win and loss report for managers. Lost reasons from the bot's list
// and from free text are grouped; win rate and top loss reason per broker and per source; undone closes and leads
// closed before the period are left out; brokers can't open it.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");
const WinLoss = require("../../services/winLoss");
const W = require("../../domain/winLoss");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
let n = 0;
async function closed(who, stage, { reason = null, source = null } = {}) {
  const b = await row(who);
  const l = (await Leads.captureLead(h.pool, b, { phones: `0101111${String(++n).padStart(4, "0")}`, name: `Client ${n}`, source })).lead;
  const r = await Leads.setStage(h.pool, b, l.id, { stage, lostReason: reason });
  expect(r.ok).toBe(true);
  return { lead: l, eventId: r.eventId };
}

test("rules: reasons from the list and from free text", () => {
  expect(W.classify("Price")).toBe("price");
  expect(W.classify("المكان")).toBe("location");
  expect(W.classify("غالية عليه شوية")).toBe("price");
  expect(W.classify("اشترى من بروكر تاني عشان السعر")).toBe("elsewhere");
  expect(W.classify("المقدم كبير")).toBe("financing");
  expect(W.classify("too far from work")).toBe("location");
  expect(W.classify("")).toBe("other");
  expect(W.winRate(1, 3)).toBe(25);
});

test("report: totals, reasons, per broker and source; managers only", async () => {
  await closed("broker", "won", { source: "facebook" });
  await closed("broker", "lost", { reason: "السعر", source: "facebook" });
  await closed("broker", "lost", { reason: "too expensive" });
  await closed("colleague", "lost", { reason: "بعيد عن شغله", source: "facebook" });
  const undone = await closed("colleague", "lost", { reason: "مش بيرد" });
  await Leads.undo(h.pool, await row("colleague"), undone.eventId);
  const old = await closed("colleague", "won");
  await h.query("UPDATE lead_events SET created_at = now() - interval '200 days' WHERE lead_id = $1", [old.lead.id]);

  const r = await WinLoss.report(h.pool, await row("admin"), { days: 90 });
  expect(r).toMatchObject({ won: 1, lost: 3, rate: 25 });
  expect(r.reasons.map((x) => [x.key, x.n])).toEqual([["price", 2], ["location", 1]]);
  const broker = r.brokers.find((g) => g.key === h.BROKERS.broker.id);
  expect(broker).toMatchObject({ won: 1, lost: 2, rate: 33, top: "price" });
  expect(r.sources.find((g) => g.key === "facebook")).toMatchObject({ won: 1, lost: 2 });
  expect((await WinLoss.report(h.pool, await row("admin"), { days: 365 })).won).toBe(2);
  expect(await WinLoss.report(h.pool, await row("broker"))).toBeNull();

  const admin = await signIn(h, "admin");
  const page = await admin.agent.get("/app/winloss");
  expect(page.status).toBe(200);
  expect(page.text).toContain('data-reason="price"');
  expect(page.text).toContain("too expensive");
  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/winloss")).status).toBe(403);
});
