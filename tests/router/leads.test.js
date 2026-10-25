// tests/router/leads.test.js — Leads on WhatsApp (Release 3 step 4): contact cards and bare numbers
// ("who is calling?"), «ليد»/lead intake with "I understood" → Confirm, voice, several or no phones,
// forwarded client texts, Q2 duplicates, the AI down, the card buttons and undo, seller → add their unit,
// and the English and Arabic forms of every command. One message per turn throughout.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);
const ids = (r) => (r.buttons || []).map((b) => b.id).concat((r.sections || []).flatMap((s) => s.rows.map((x) => x.id)));
const one = (who, replies) => {
  const mine = to(who, replies);
  expect(mine).toHaveLength(1);
  return mine[0];
};
const contact = (who, name, ...phones) =>
  h.send(who, { type: "contacts", contacts: [{ name: { formatted_name: name }, phones: phones.map((p) => ({ phone: p, type: "CELL" })) }] });
const leads = () => h.query("SELECT * FROM leads ORDER BY ref");
const aiCalls = (op) => h.AI.calls.filter((c) => c.operation === op).length;
const extraction = (over = {}) => ({ name: "Ahmed Samir", phones: ["01012345678"], kind: "buyer", source: null, note: null, request: null, ...over });
const tapId = (who, replies, prefix) => {
  const id = ids(one(who, replies)).find((x) => x.startsWith(prefix));
  expect(id).toBeTruthy();
  return id;
};

describe("contact cards and bare numbers (no AI)", () => {
  test("a new contact card offers Save; Save stores every number and shows the card", async () => {
    const offer = one("broker", await contact("broker", "Sara Ali", "+20 101 234 5678", "0225551234"));
    expect(offer.text).toContain("Sara Ali");
    const saved = one("broker", await h.tap("broker", tapId("broker", [offer], "ld:save:")));
    expect(saved.text).toContain("L-0001");
    expect(saved.text).toContain("https://wa.me/201012345678");
    expect(ids(saved)).toEqual(["ld:called:L-0001", "ld:fu:L-0001", "ld:stage:L-0001"]);
    const [lead] = await leads();
    expect(lead).toMatchObject({ name: "Sara Ali", phones: ["+201012345678", "+20225551234"], assigned_broker_id: h.BROKERS.broker.id, source: "WhatsApp" });
    expect(aiCalls("lead_extraction")).toBe(0);
    // The same card again: who is calling? — the card at once.
    const again = one("broker", await contact("broker", "S", "02 2555 1234"));
    expect(again.text).toContain("Sara Ali · L-0001");
    expect(h.AI.calls).toHaveLength(0);
  });

  test("a bare number: own lead → card; a colleague's → only the Q2 copy; unknown → the offer", async () => {
    await h.tap("broker", tapId("broker", await contact("broker", "Sara Ali", "01012345678"), "ld:save:"));
    expect(one("broker", await h.text("broker", "٠١٠١ ٢٣٤ ٥٦٧٨")).text).toContain("Sara Ali");
    const colleague = one("colleague", await h.text("colleague", "+201012345678"));
    expect(colleague.text).toMatch(/زميل/);
    expect(colleague.text).not.toContain("Sara");
    expect(ids(colleague)).toEqual([]);
    expect(ids(one("colleague", await h.text("colleague", "01112345678"))).some((x) => x.startsWith("ld:save:"))).toBe(true);
    expect(h.AI.calls).toHaveLength(0);
  });

  test("a stale or someone else's pending button says it expired", async () => {
    const offer = await contact("broker", "Sara", "01012345678");
    const id = tapId("broker", offer, "ld:save:");
    await contact("broker", "Other", "01112345678");
    expect(one("broker", await h.tap("broker", id)).text).toMatch(/انتهى/);
    expect(await leads()).toHaveLength(0);
  });
});

describe("«ليد» / lead intake (one AI call, confirm before saving)", () => {
  test("«ليد» + text → I understood → Confirm saves with the request", async () => {
    h.AI.respond((c) => (c.operation === "lead_extraction" ? extraction({ request: { listing_type: "sale", property_types: ["villa"], locations: ["التجمع"], price_max: 9000000 } }) : null));
    const understood = one("broker", await h.text("broker", "ليد أحمد سمير 01012345678 عايز فيلا في التجمع لحد 9 مليون"));
    expect(understood.text).toContain("Ahmed Samir");
    expect(understood.text).toContain("0101 234 5678");
    expect(understood.text).toContain("9 مليون");
    expect(await leads()).toHaveLength(0);
    const saved = one("broker", await h.tap("broker", tapId("broker", [understood], "ld:ok:")));
    expect(saved.text).toContain("✅");
    expect(saved.text).toContain("L-0001");
    expect(aiCalls("lead_extraction")).toBe(1);
    const [lead] = await leads();
    const events = await h.query("SELECT kind, data FROM lead_events WHERE lead_id = $1 ORDER BY id", [lead.id]);
    expect(events.map((e) => e.kind)).toEqual(["created", "request_set"]);
    expect(events[1].data.filters.price_max).toBe(9000000);
    // The prompt fences the client's words.
    const prompt = JSON.stringify(h.AI.calls.find((c) => c.operation === "lead_extraction").contents);
    expect(prompt).toMatch(/===[0-9A-F]{8}===/);
  });

  test("lead alone opens a draft; the next forward is read; Edit re-reads with the correction; Cancel saves nothing", async () => {
    let n = 0;
    h.AI.respond((c) => (c.operation === "lead_extraction" ? extraction(++n === 1 ? {} : { kind: "tenant" }) : null));
    expect(one("broker", await h.text("broker", "lead")).text).toMatch(/forward|فوروارد/);
    const first = one("broker", await h.text("broker", "Ahmed Samir 01012345678 wants an apartment"));
    expect(first.text).toContain("Ahmed Samir");
    expect(one("broker", await h.tap("broker", tapId("broker", [first], "ld:edit:"))).text).toMatch(/التصحيح|correction/);
    const second = one("broker", await h.text("broker", "مستأجر"));
    expect(second.text).toMatch(/مستأجر/);
    expect(JSON.stringify(h.AI.calls[1].contents)).toContain("مستأجر");
    expect(one("broker", await h.tap("broker", tapId("broker", [second], "ld:no:"))).text).toMatch(/اتلغى/);
    expect(await leads()).toHaveLength(0);
  });

  test("a voice note «ليد …» is the same intake as the text", async () => {
    h.AI.respond((c) => (c.operation === "transcribe" ? "ليد أحمد سمير صفر واحد صفر واحد" : c.operation === "lead_extraction" ? extraction() : null));
    const understood = one("broker", await h.voice("broker"));
    expect(understood.text).toContain("Ahmed Samir");
    expect(ids(understood).some((x) => x.startsWith("ld:ok:"))).toBe(true);
    expect(aiCalls("transcribe")).toBe(1);
    expect(aiCalls("lead_extraction")).toBe(1);
  });

  test("several phones → which one?; no phone → send the number, then confirm without another AI call", async () => {
    h.AI.respond(() => extraction({ phones: ["01012345678", "01112345678"] }));
    const list = one("broker", await h.text("broker", "ليد احمد 01012345678 او 01112345678"));
    expect(list.type).toBe("list");
    const pick = one("broker", await h.pick("broker", ids(list)[1]));
    expect(pick.text).toContain("0111 234 5678");
    expect(pick.text).not.toContain("0101 234 5678");

    h.AI.respond(() => extraction({ phones: [] }));
    const ask = one("colleague", await h.text("colleague", "ليد أحمد عايز شقة"));
    expect(ask.text).toMatch(/رقم العميل/);
    const calls = h.AI.calls.length;
    const confirm = one("colleague", await h.text("colleague", "رقمه 01212345678"));
    expect(confirm.text).toContain("0121 234 5678");
    expect(confirm.text).toContain("Ahmed Samir");
    expect(h.AI.calls.length).toBe(calls);
  });

  test("Q2: confirming a colleague's client tells the broker their manager knows; the owner hears nothing", async () => {
    await h.tap("broker", tapId("broker", await contact("broker", "Sara", "01012345678"), "ld:save:"));
    h.AI.respond(() => extraction({ name: "Sara again" }));
    const understood = await h.text("colleague", "ليد سارة 01012345678");
    const res = await h.tap("colleague", tapId("colleague", understood, "ld:ok:"));
    expect(one("colleague", res).text).toMatch(/زميل/);
    expect(to("broker", res)).toEqual([]);
    const alerts = await h.query("SELECT broker_id, kind FROM notifications WHERE kind = 'manager_alert' AND dedupe_key LIKE 'lead_dup:%'");
    expect(alerts.map((a) => a.broker_id)).toEqual([h.BROKERS.admin.id]);
    expect((await leads())[0].name).toBe("Sara");
  });

  test("the AI down: save the number alone", async () => {
    h.AI.respond(() => new Error("model down"));
    const offer = one("broker", await h.text("broker", "ليد أحمد 01012345678 عايز شقة"));
    expect(offer.text).toContain("0101 234 5678");
    const saved = one("broker", await h.tap("broker", tapId("broker", [offer], "ld:save:")));
    expect(saved.text).toContain("L-0001");
    expect((await leads())[0].name).toBeNull();
  });
});

describe("forwards and units", () => {
  test("a forwarded client text with a phone: Is this a client? → Save → AI → Confirm; Search runs the search", async () => {
    h.AI.respond((c) => (c.operation === "lead_extraction" ? extraction() : { intent: "search", filters: {}, locations: [] }));
    const offer = one("broker", await h.send("broker", { type: "text", context: { forwarded: true }, text: { body: "السلام عليكم انا احمد سمير رقمي 01012345678 عايز شقة في التجمع" } }));
    expect(ids(offer).map((x) => x.split(":")[1])).toEqual(["read", "search"]);
    expect(h.AI.calls).toHaveLength(0);
    const understood = one("broker", await h.tap("broker", tapId("broker", [offer], "ld:read:")));
    expect(understood.text).toContain("Ahmed Samir");
    const offer2 = await h.send("broker", { type: "text", text: { body: "عميلة اسمها منى 01112345678 عايزة فيلا" } });
    await h.tap("broker", tapId("broker", offer2, "ld:search:"));
    expect(aiCalls("search_parse")).toBe(1);
  });

  test("a forwarded unit still goes to the listing flow; «عميل CODE» / client CODE are unchanged", async () => {
    await h.insertListing({ code: "VIL-08" });
    const unit = one("broker", await h.text("broker", "فيلا للبيع في التجمع\nكود VIL-08\nللتواصل 01012345678"));
    expect(ids(unit).some((x) => x.startsWith("ld:"))).toBe(false);
    for (const cmd of ["عميل VIL-08", "client VIL-08"]) {
      const r = one("broker", await h.text("broker", cmd));
      expect(ids(r).some((x) => x.startsWith("ld:"))).toBe(false);
      expect(r.text).toMatch(/VIL-08|التجمع|New Cairo|Hyde Park/);
    }
    expect(await leads()).toHaveLength(0);
  });

  test("inside a unit draft a phone is the owner's (draft details), not a lead", async () => {
    await h.text("broker", "اضافة");
    const r = one("broker", await h.text("broker", "01012345678"));
    expect(ids(r).some((x) => x.startsWith("ld:"))).toBe(false);
  });
});

describe("the card buttons and undo", () => {
  async function savedLead(who = "broker", name = "Sara") {
    const offer = await contact(who, name, "01012345678");
    return one(who, await h.tap(who, tapId(who, offer, "ld:save:")));
  }

  test("Called → contacted, suggests a follow-up in 2 days; Undo restores", async () => {
    await savedLead();
    const called = one("broker", await h.tap("broker", "ld:called:L-0001"));
    expect(called.text).toMatch(/L-0001/);
    expect(ids(called)[0]).toBe("ld:fuset:L-0001:2d");
    expect((await leads())[0].stage).toBe("contacted");
    const fu = one("broker", await h.tap("broker", "ld:fuset:L-0001:2d"));
    expect(fu.text).toMatch(/10:00|١٠:٠٠/);
    const lead = (await leads())[0];
    expect(lead.follow_up_status).toBe("open");
    const undoFu = ids(fu).find((x) => x.startsWith("ld:undo:"));
    expect(one("broker", await h.tap("broker", undoFu)).text).toMatch(/↩️/);
    expect((await leads())[0].follow_up_status).toBeNull();
    expect(one("broker", await h.tap("broker", ids(called).find((x) => x.startsWith("ld:undo:")))).text).toMatch(/↩️/);
    expect((await leads())[0].stage).toBe("new");
  });

  test("Stage → list → Lost → reason list → saved with the reason", async () => {
    await savedLead();
    const list = one("broker", await h.tap("broker", "ld:stage:L-0001"));
    expect(ids(list)).toContain("ld:st:L-0001:lost");
    expect(ids(list)).not.toContain("ld:st:L-0001:new");
    const reasons = one("broker", await h.pick("broker", "ld:st:L-0001:lost"));
    expect(ids(reasons)).toContain("ld:lost:L-0001:price");
    await h.pick("broker", "ld:lost:L-0001:price");
    expect((await leads())[0]).toMatchObject({ stage: "lost", lost_reason: "السعر" });
    await h.pick("broker", "ld:st:L-0001:viewing");
    expect((await leads())[0].stage).toBe("viewing");
  });

  test("old buttons days later still work; after reassignment they say why they can't", async () => {
    await savedLead();
    await h.query("UPDATE leads SET created_at = NOW() - interval '5 days'");
    expect(one("broker", await h.tap("broker", "ld:called:L-0001")).text).toMatch(/L-0001/);
    expect(one("admin", await h.text("admin", "assign L-0001 to Two")).text).toMatch(/Broker Two/);
    const gone = one("broker", await h.tap("broker", "ld:fu:L-0001"));
    expect(gone.text).toMatch(/مبقاش معاك/);
    const card = await h.query("SELECT kind FROM notifications WHERE broker_id = $1", [h.BROKERS.colleague.id]);
    expect(card.map((c) => c.kind)).toEqual(["assignment"]);
  });

  test("a seller lead's first card offers Add their unit; it opens a draft with the owner prefilled", async () => {
    h.AI.respond(() => extraction({ name: "Owner Omar", kind: "seller" }));
    const understood = await h.text("broker", "ليد عمر عايز يبيع شقته 01012345678");
    const card = one("broker", await h.tap("broker", tapId("broker", understood, "ld:ok:")));
    expect(ids(card)).toContain("ld:unit:L-0001");
    expect(one("broker", await h.tap("broker", "ld:unit:L-0001")).text).toMatch(/Owner Omar/);
    const draft = await h.session("broker", "draft");
    expect(draft.prefill.details).toEqual({ owner_name: "Owner Omar", owner_phone: "0101 234 5678" });
    // Later cards show Stage again.
    expect(ids(one("broker", await h.text("broker", "L-0001")))).toContain("ld:stage:L-0001");
  });
});

describe("commands in both languages", () => {
  test.each([["عملائي"], ["my leads"], ["leads"]])("%s lists my leads with the web link", async (cmd) => {
    await h.tap("broker", tapId("broker", await contact("broker", "Sara", "01012345678"), "ld:save:"));
    const r = one("broker", await h.text("broker", cmd));
    expect(r.text).toContain("L-0001 · Sara");
    expect(r.text).toContain("/app/leads");
  });

  test.each([["متابعات"], ["followups"]])("%s lists open follow-ups", async (cmd) => {
    await h.tap("broker", tapId("broker", await contact("broker", "Sara", "01012345678"), "ld:save:"));
    expect(one("broker", await h.text("broker", cmd)).text).toMatch(/مفيش متابعات/);
    await h.tap("broker", "ld:fuset:L-0001:1d");
    expect(one("broker", await h.text("broker", cmd)).text).toContain("L-0001 · Sara");
  });

  test("L-0001 opens the card; a colleague gets 'not yours'; an unknown reference falls through", async () => {
    await h.tap("broker", tapId("broker", await contact("broker", "Sara", "01012345678"), "ld:save:"));
    expect(one("broker", await h.text("broker", "l-1")).text).toContain("Sara · L-0001");
    expect(one("colleague", await h.text("colleague", "L-0001")).text).toMatch(/مبقاش معاك/);
    h.AI.respond(() => ({ intent: "search", filters: { code: "L-0099" }, locations: [] }));
    expect(textOf(await h.text("broker", "L-0099"))).not.toMatch(/مبقاش معاك/);
  });

  test("«حول L-0001 لـ …» / assign: managers only; ambiguous names give a list", async () => {
    await h.tap("broker", tapId("broker", await contact("broker", "Sara", "01012345678"), "ld:save:"));
    expect(one("broker", await h.text("broker", "حول L-0001 لـ Two")).text).toMatch(/للمديرين/);
    const list = one("admin", await h.text("admin", "assign L-0001 to Broker"));
    expect(list.type).toBe("list");
    const done = one("admin", await h.pick("admin", ids(list).find((x) => x.endsWith(h.BROKERS.colleague.id))));
    expect(done.text).toContain("Broker Two");
    expect((await leads())[0].assigned_broker_id).toBe(h.BROKERS.colleague.id);
    expect(one("admin", await h.text("admin", "assign L-0001 to Nobody")).text).toMatch(/Nobody/);
  });

  test("help lists the CRM commands in both languages", async () => {
    const ar = one("broker", await h.text("broker", "مساعدة")).text;
    expect(ar).toContain("عملائي");
    expect(ar).toContain("my leads");
    const en = one("admin", await h.text("admin", "help")).text;
    expect(en).toContain("assign L-0042 to Sara");
    expect(en).toContain("حول L-0042 لـ سارة");
  });

  test("cancel clears a lead draft", async () => {
    await h.text("broker", "ليد");
    await h.text("broker", "إلغاء");
    expect(await h.session("broker", "lead_draft")).toBeNull();
  });
});
