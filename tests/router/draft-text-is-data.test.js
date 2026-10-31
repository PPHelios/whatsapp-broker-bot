// tests/router/draft-text-is-data.test.js — While a unit draft is open, every text is unit data (never a search guess).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(30000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

// The exact text the broker sent during a draft (it contains «مطلوب», a word that used to offer a search).
const EXACT = "شقه للايجار ١٢٥م للبيع في اي سيتي ٢ نوم ٢ حمام بحديقه خاصه ٦٠م بالمطبخ و التكييفات مطلوب ٣٠الف شهريا و شهرين مقدم";

const buttonsOf = (replies) => replies.flatMap((r) => r.buttons || []).map((b) => b.id);
const draftNotes = async () => {
  const rows = await h.query("SELECT session_data FROM broker_sessions WHERE session_type = 'draft'");
  return JSON.stringify(rows[0]?.session_data?.text_notes || []);
};

describe("draft text is unit data, never a search guess", () => {
  test("the exact description during a draft is added to the draft and offers no discard-and-search", async () => {
    await h.text("broker", "اضافة");
    const replies = await h.text("broker", EXACT);
    expect(buttonsOf(replies)).not.toContain("cancel_and_search");
    expect(replies.map((r) => r.text || "").join("\n")).not.toMatch(/لديك مسودة|discard it/);
    expect(await draftNotes()).toContain("شقه للايجار");
    expect(await h.query("SELECT 1 FROM broker_sessions WHERE session_type = 'pending_search'")).toHaveLength(0);
  });

  test("a search verb during a draft is still added to the draft", async () => {
    await h.text("broker", "اضافة");
    const replies = await h.text("broker", "عايز شقة في التجمع");
    expect(buttonsOf(replies)).not.toContain("cancel_and_search");
    expect(await draftNotes()).toContain("عايز شقة في التجمع");
  });
});
