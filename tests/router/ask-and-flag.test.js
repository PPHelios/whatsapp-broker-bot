// tests/router/ask-and-flag.test.js — Asking for a unit's private details from a search result (web) and a unit card (bot),
// "Needs manager" as a lead status (web form, bot list, voice update), the first sign-up user as agency owner, and the
// retired WhatsApp spreadsheet import.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Update = require("../../domain/leadUpdate");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.tgLink("colleague");
});
afterAll(closeHarness);

const SECRET = { owner_name: "Mr Secret", owner_phone: "01099998888" };

test("a search result hides the owner and offers an ask button; asking from there goes back to the results and shows 'requested'", async () => {
  await h.insertListing({ code: "HP-1", details: SECRET });
  const s = await signIn(h, "colleague");
  const path = "/app/search?code=HP-1";
  const before = (await s.agent.get(path)).text;
  expect(before).toContain("data-ask-details");
  expect(before).not.toContain("Mr Secret");
  const f = before.match(/name="back" value="([^"]+)"/)[1];
  const ask = await s.agent.post("/app/units/HP-1/access").type("form").send({ _csrf: s.csrf, back: f });
  expect(ask.status).toBe(303);
  expect(ask.headers.location).toBe(f.replace(/&amp;/g, "&"));
  const after = (await s.agent.get(path)).text;
  expect(after).toContain("data-ask-pending");
  expect(after).not.toContain("data-ask-details");
  // The unit's own broker and managers never see the button.
  const own = await signIn(h, "broker");
  expect((await own.agent.get(path)).text).not.toContain("data-ask-details");
  // A back link that leaves the app is ignored.
  const evil = await s.agent.post("/app/units/HP-1/access").type("form").send({ _csrf: s.csrf, back: "//evil.example/x" });
  expect(evil.headers.location).toContain("/app/units/HP-1");
});

test("the bot's unit card swaps the third button for 'Ask details' when secrets are hidden; tapping sends the ask", async () => {
  await h.insertListing({ code: "HP-2", details: SECRET });
  const out = await h.tgText("colleague", "HP-2");
  const card = out.find((e) => e.method === "sendMessage" && e.keyboard);
  const btn = card.keyboard.flat().find((b) => /^unitask:/.test(b.callback_data));
  expect(btn).toBeDefined();
  const tapped = await h.tgTap("colleague", btn.callback_data);
  expect(tapped.some((e) => /HP-2/.test(e.text || ""))).toBe(true);
  const rows = await h.query("SELECT status FROM unit_access_requests");
  expect(rows.map((r) => r.status)).toEqual(["pending"]);
  // The unit's own broker has no such button.
  await h.tgLink("broker");
  const own = (await h.tgText("broker", "HP-2")).find((e) => e.method === "sendMessage" && e.keyboard);
  expect(own.keyboard.flat().some((b) => /^unitask:/.test(b.callback_data))).toBe(false);
});

test("the voice update understands 'need the manager' and the confirmed update flags the lead", async () => {
  expect(Update.looksLikeUpdate("محتاج المدير في ليد أحمد")).toBe(true);
  expect(Update.looksLikeUpdate("I need my manager on Ahmed")).toBe(true);
  const u = Update.normalizeUpdate({ lead_name: "أحمد", needs_manager: true, note: "خصم" });
  expect(u).toMatchObject({ needsManager: true, note: "خصم" });
  expect(Update.hasChange(u)).toBe(true);
  expect(Update.summaryLines(u, { name: "أحمد", ref: 1 }, "en")).toContain("Tell the manager");
});

test("the web stage form can also flag the lead for a manager, once", async () => {
  await h.seedBroker("manager");
  const brokerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  await Leads.captureLead(h.pool, brokerRow, { phones: "01012345678", name: "Sara Flag" });
  const s = await signIn(h, "broker");
  const r = await s.agent.post("/app/leads/L-0001/stage").set("X-CSRF-Token", s.csrf).type("form").send({ stage: "interested", needs_manager: "1", flag_text: "Wants a discount" });
  expect(r.status).toBe(303);
  const [lead] = await h.query("SELECT stage, flagged_at, flag_note FROM leads");
  expect(lead.stage).toBe("interested");
  expect(lead.flagged_at).not.toBeNull();
  expect(lead.flag_note).toBe("Wants a discount");
  expect((await s.agent.get("/app/leads/L-0001")).text).not.toContain('name="needs_manager"');
});

test("the first user of a new agency is its agency owner", async () => {
  const Signup = require("../../services/signup");
  await Signup.setOpen(h.pool, true);
  const out = await Signup.submit(h.pool, { agency: "Nile Homes", name: "Hala", phone: "01055550001", lang: "en" });
  expect(out.ok).toBe(true);
  const [b] = await h.query("SELECT role FROM brokers WHERE id = $1", [out.broker.id]);
  expect(b.role).toBe("owner");
});

test("a spreadsheet sent in chat is not imported; the broker is pointed to the app", async () => {
  const { handleDocument } = require("../../routes/documents");
  const brokerRow = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  expect(await handleDocument(brokerRow, { document: { id: "x", filename: "units.xlsx" } }, { pool: h.pool, lang: "en" })).toBe("done");
  expect(await h.query("SELECT 1 FROM listings")).toEqual([]);
});
