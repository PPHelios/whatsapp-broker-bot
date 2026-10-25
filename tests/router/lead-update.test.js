// tests/router/lead-update.test.js — The voice CRM update (Release 3 step 9, wow 3): a text or voice note about one of
// the broker's clients → one lead_update call → "I understood" → Confirm applies contacted, stage, a viewing with the
// unit and a note as one set of events (Undo reverts them all). An ambiguous name → a list, an unknown one → a list
// with the name, a past time asks again, a colleague's lead is refused, nothing is written before Confirm, Cancel
// writes nothing, and with the AI down the reply offers the card buttons.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const Leads = require("../../services/leads");
const Stages = require("../../domain/leadStages");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const row = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];
const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const ids = (r) => (r.buttons || []).map((b) => b.id).concat((r.sections || []).flatMap((s) => s.rows.map((x) => x.id)));
const one = (who, replies) => {
  const mine = to(who, replies);
  expect(mine).toHaveLength(1);
  return mine[0];
};
const aiCalls = (op) => h.AI.calls.filter((c) => c.operation === op).length;
const lead = async (who, phones, name) => (await Leads.captureLead(h.pool, await row(who), { phones, name })).lead;
const fresh = async (id) => (await h.query("SELECT * FROM leads WHERE id = $1", [id]))[0];
const events = async (id) => (await h.query("SELECT kind, undone_at FROM lead_events WHERE lead_id = $1 AND kind <> 'created' ORDER BY id", [id])).map((e) => e.kind);
// Friday next week, 17:00 Cairo, as the AI would resolve «الجمعة الجاية الساعة ٥».
const friday = () => {
  const d = Stages.cairoDayAt(new Date(), 7, 17);
  return { date: Stages.toCairoLocal(d).slice(0, 10), time: "17:00", at: d };
};
const UPDATE = (over = {}) => ({ lead_name: "أحمد", contacted: true, stage: "viewing", lost_reason: null, follow_up: { date: friday().date, time: "17:00", kind: "viewing", unit_code: "VIL-08" }, note: "عايز دور أرضي", ...over });

test("a voice note updates the CRM after Confirm: contacted, viewing, a Friday 17:00 viewing with the unit, a note; Undo reverts all", async () => {
  const unit = await h.insertListing({ code: "VIL-08", property_type: "villa" });
  const ahmed = await lead("broker", "01012345678", "أحمد سمير");
  await lead("broker", "01112345678", "Sara");
  h.AI.respond((c) => (c.operation === "transcribe" ? "كلمت احمد، عايز يعاين VIL-08 الجمعة الجاية الساعة ٥، وعايز دور أرضي" : c.operation === "lead_update" ? UPDATE() : null));

  const ask = one("broker", await h.voice("broker"));
  expect(aiCalls("lead_update")).toBe(1);
  expect(ask.text).toContain("أحمد سمير · L-0001");
  expect(ask.text).toMatch(/📞/);
  expect(ask.text).toMatch(/🏠 معاينة .* · VIL-08/);
  expect(ask.text).toContain("📝 عايز دور أرضي");
  expect(ids(ask).map((x) => x.split(":")[1])).toEqual(["uok", "uedit", "no"]);
  // Nothing written yet.
  expect(await events(ahmed.id)).toEqual([]);
  expect((await fresh(ahmed.id)).stage).toBe("new");

  // The prompt carries today's Cairo date and the text inside the fence.
  const prompt = JSON.stringify(h.AI.calls.find((c) => c.operation === "lead_update").contents);
  expect(prompt).toContain(`Today in Cairo is`);
  expect(prompt).toContain("عايز يعاين VIL-08");

  const done = one("broker", await h.tap("broker", ids(ask)[0]));
  expect(done.text).toMatch(/^✅ اتسجل/);
  const l = await fresh(ahmed.id);
  expect(l).toMatchObject({ stage: "viewing", follow_up_kind: "viewing", follow_up_listing_id: unit.id, follow_up_status: "open" });
  expect(new Date(l.next_follow_up_at).toISOString()).toBe(friday().at.toISOString());
  expect(l.last_contact_at).toBeTruthy();
  expect(await events(ahmed.id)).toEqual(["contacted", "stage", "follow_up_set", "note"]);

  const undo = ids(done).find((x) => x.startsWith("ld:undoset:"));
  expect(one("broker", await h.tap("broker", undo)).text).toMatch(/↩️/);
  const back = await fresh(ahmed.id);
  expect(back).toMatchObject({ stage: "new", follow_up_status: null, last_contact_at: null });
});

test("a typed update with an L- reference works the same; Cancel writes nothing", async () => {
  const sara = await lead("broker", "01012345678", "Sara");
  h.AI.respond((c) => (c.operation === "lead_update" ? UPDATE({ lead_name: null, stage: "interested", follow_up: null, note: null }) : null));
  const ask = one("broker", await h.text("broker", "L-0001 كلمتها ومهتمة"));
  expect(ask.text).toMatch(/👍 مهتم/);
  const cancel = ids(ask).find((x) => x.startsWith("ld:no:"));
  expect(one("broker", await h.tap("broker", cancel)).text).toMatch(/اتلغى/);
  expect(await events(sara.id)).toEqual([]);
  expect((await fresh(sara.id)).stage).toBe("new");
});

test("two clients with the name → a list; picking one asks to confirm", async () => {
  await lead("broker", "01012345678", "أحمد سمير");
  const second = await lead("broker", "01112345678", "أحمد علي");
  h.AI.respond((c) => (c.operation === "lead_update" ? UPDATE({ follow_up: null, stage: null, note: null }) : null));
  const list = one("broker", await h.text("broker", "كلمت أحمد النهارده"));
  expect(list.text).toMatch(/أنهي عميل/);
  const rows = list.sections[0].rows;
  expect(rows).toHaveLength(2);
  const ask = one("broker", await h.pick("broker", rows.find((r) => r.title.includes("أحمد علي")).id));
  expect(ask.text).toContain("أحمد علي · L-0002");
  await h.tap("broker", ids(ask)[0]);
  expect(await events(second.id)).toEqual(["contacted"]);
});

test("a name the AI read that isn't a client of mine → a list with the name; no update without a client named or open", async () => {
  await lead("broker", "01012345678", "Sara");
  h.AI.respond((c) => (c.operation === "lead_update" ? UPDATE({ lead_name: "كريم", follow_up: null }) : c.operation === "search_parse" ? { intent: "search", filters: {}, locations: [] } : null));
  // No client named and no card open: not an update (no AI call for it).
  await h.text("broker", "كلمت كريم النهارده");
  expect(aiCalls("lead_update")).toBe(0);
  // With Sara's card open, a different name asks which client.
  await h.text("broker", "L-0001");
  const list = one("broker", await h.text("broker", "كلمت كريم النهارده"));
  expect(list.text).toContain("«كريم»");
  expect(ids(list)[0]).toMatch(/^ld:upick:/);
});

test("a time in the past asks again; the next message is read with the first", async () => {
  const sara = await lead("broker", "01012345678", "Sara");
  let n = 0;
  h.AI.respond((c) => {
    if (c.operation !== "lead_update") return null;
    return ++n === 1 ? UPDATE({ lead_name: "Sara", follow_up: { date: "2020-01-03", time: "17:00", kind: "call", unit_code: null } }) : UPDATE({ lead_name: "Sara", follow_up: { date: friday().date, time: "17:00", kind: "call", unit_code: null } });
  });
  const again = one("broker", await h.text("broker", "كلمت Sara هكلمها الجمعة"));
  expect(again.text).toMatch(/الميعاد ده فات/);
  expect(await events(sara.id)).toEqual([]);
  const ask = one("broker", await h.text("broker", "الجمعة الجاية الساعة ٥"));
  expect(ask.text).toMatch(/📅 متابعة/);
  const second = JSON.stringify(h.AI.calls.filter((c) => c.operation === "lead_update")[1].contents);
  expect(second).toContain("هكلمها الجمعة");
  expect(second).toContain("الجمعة الجاية الساعة ٥");
});

test("an unknown unit code asks again", async () => {
  await lead("broker", "01012345678", "Sara");
  h.AI.respond((c) => (c.operation === "lead_update" ? UPDATE({ lead_name: "Sara", follow_up: { date: friday().date, time: "17:00", kind: "viewing", unit_code: "NOPE-1" } }) : null));
  expect(one("broker", await h.text("broker", "Sara هتعاين NOPE-1 الجمعة")).text).toMatch(/NOPE-1 مش موجود/);
});

test("a colleague's lead is refused, by reference and by name", async () => {
  await lead("colleague", "01012345678", "Mona");
  h.AI.respond((c) => (c.operation === "lead_update" ? UPDATE({ lead_name: "Mona" }) : c.operation === "search_parse" ? { intent: "search", filters: {}, locations: [] } : null));
  expect(one("broker", await h.text("broker", "L-0001 كلمتها")).text).toMatch(/مع زميل/);
  await h.text("broker", "كلمت Mona");
  expect(aiCalls("lead_update")).toBe(0);
  expect((await h.query("SELECT count(*)::int AS n FROM lead_events WHERE kind <> 'created'"))[0].n).toBe(0);
});

test("the AI down → couldn't read it, use the buttons", async () => {
  await lead("broker", "01012345678", "Sara");
  h.AI.respond((c) => (c.operation === "lead_update" ? new Error("503 UNAVAILABLE") : null));
  const r = one("broker", await h.text("broker", "كلمت Sara"));
  expect(r.text).toMatch(/استخدم الأزرار/);
  expect(ids(r)).toEqual(["ld:called:L-0001", "ld:fu:L-0001", "ld:stage:L-0001"]);
});

test("Edit asks for the correction and reads it with the first message", async () => {
  const sara = await lead("broker", "01012345678", "Sara");
  h.AI.respond((c) => (c.operation === "lead_update" ? UPDATE({ lead_name: "Sara", follow_up: null, stage: "lost", lost_reason: "السعر", note: null, contacted: true }) : null));
  const ask = one("broker", await h.text("broker", "كلمت Sara مش مهتمة"));
  expect(ask.text).toContain("(السعر)");
  const edit = ids(ask).find((x) => x.startsWith("ld:uedit:"));
  expect(one("broker", await h.tap("broker", edit)).text).toMatch(/ابعت التصحيح/);
  const again = one("broker", await h.text("broker", "لأ هي مهتمة بس السعر عالي"));
  expect(ids(again)[0]).toMatch(/^ld:uok:/);
  expect(aiCalls("lead_update")).toBe(2);
  expect(await events(sara.id)).toEqual([]);
});
