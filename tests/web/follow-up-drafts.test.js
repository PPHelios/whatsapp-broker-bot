// tests/web/follow-up-drafts.test.js — Release B N2: after a call or viewing, the next WhatsApp message to the client
// is drafted from the lead's own record (name, request, notes, the call or viewing) in the broker's tone (their sample
// in Settings). On the bot it comes after "Called" / "Follow-up done" with Send on WhatsApp; on the lead page with a
// wa.me link to the client's number. A colleague's client can't be drafted for.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const FakeAI = require("../harness/fake-ai");
const Leads = require("../../services/leads");
const Drafts = require("../../services/followUpDrafts");
const D = require("../../domain/followUpDraft");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  FakeAI.reset();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const ids = (r) => (r.buttons || []).map((b) => b.id);

function fakeModel() {
  FakeAI.respond((call) => {
    if (call.operation !== "follow_up_draft") throw new Error(`unexpected ${call.operation}`);
    const p = String(call.contents);
    expect(p).toContain("Client first name: Sara");
    expect(p).toContain("broker's note: liked the garden");
    return { text: p.includes("يا باشا") ? "أهلاً يا سارة يا باشا، نحدد معاينة تانية؟" : "أهلاً يا سارة، نحدد معاينة تانية؟" };
  });
}

async function lead(who = "broker") {
  const l = (await Leads.captureLead(h.pool, await row(who), { phones: ["01012345678"], name: "Sara Ali" })).lead;
  await Leads.addNote(h.pool, await row(who), l.id, "liked the garden");
  return l;
}

test("rules: facts from the record only, the reply read safely", () => {
  const facts = D.factsOf({ lead: { name: "Sara Ali", kind: "buyer", stage: "contacted" }, events: [{ kind: "follow_up_done", data: { kind: "viewing", note: "unit BD-1" }, created_at: "2026-10-20T10:00:00Z" }], broker: { name: "Mona" }, agencyName: "Alpha" });
  expect(facts).toContain("2026-10-20 viewing done: unit BD-1");
  expect(D.prompt(facts, { lang: "ar", style: "يا باشا" })).toContain('"""يا باشا"""');
  expect(D.parse("nope")).toEqual({ error: "empty" });
});

test("drafts for own clients only, in the broker's tone; lead page shows it with a WhatsApp link", async () => {
  const l = await lead();
  fakeModel();
  const out = await Drafts.draft(h.pool, await row("broker"), l.id);
  expect(out.text).toBe("أهلاً يا سارة، نحدد معاينة تانية؟");
  expect(out.wa).toContain("https://wa.me/201012345678?text=");
  expect((await Drafts.draft(h.pool, await row("colleague"), l.id)).error).toBe("not_found");

  await Drafts.saveStyle(h.pool, await row("broker"), "يا باشا");
  const { agent, csrf } = await signIn(h, "broker");
  expect((await agent.get("/app/settings")).text).toContain("يا باشا");
  const page = await agent.post("/app/leads/L-0001/draft").type("form").send({ _csrf: csrf });
  expect(page.status).toBe(200);
  expect(page.text).toContain("data-follow-up-draft");
  expect(page.text).toContain("سارة يا باشا");
  expect(page.text).toContain("data-draft-send");
});

test("bot: Called offers ✍️ Draft message; the draft comes back for the client", async () => {
  await lead();
  fakeModel();
  const called = to("broker", await h.tap("broker", "ld:called:L-0001"))[0];
  expect(ids(called)).toContain("ld:draft:L-0001");
  const draft = to("broker", await h.tap("broker", "ld:draft:L-0001"));
  expect(draft.map((r) => r.text).join("\n")).toContain("أهلاً يا سارة، نحدد معاينة تانية؟");
});
