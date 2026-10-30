// tests/router/reply-delivery.test.js — Batch 2a: honest reply tracking, no silent drops, batching, COL-01 token
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf, FALLBACK_AR } = require("../harness/app");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const textMsg = (from, id, body) => ({ from, id, type: "text", text: { body } });

describe("Reply truth (plan #7, Part 2 C)", () => {
  test("a failed send does not count as a reply: the safety net still answers", async () => {
    h.WA.failNext("text"); // the help reply fails at the WhatsApp API
    const replies = await h.text("broker", "مساعدة");
    expect(textOf(replies)).toMatch(FALLBACK_AR);
  });

  test("the payment-plans list menu is a reply (no fallback bubble)", async () => {
    await h.insertListing({
      code: "DEV-1",
      inventory_type: "developer_model",
      payment_terms: { plans: [{ plan_id: "p1", years: 5, down_payment_pct: 10 }] }
    });
    const replies = await h.tap("broker", "plans_view:DEV-1");
    expect(replies.some((r) => r.type === "list")).toBe(true);
    expect(textOf(replies)).not.toMatch(FALLBACK_AR);
  });

  test("the image-only blocker button prompt is a reply (no fallback bubble)", async () => {
    await h.photo("broker");
    const replies = await h.tap("broker", "draft_confirm");
    expect(textOf(replies)).toMatch(/بالصور فقط/);
    expect(textOf(replies)).not.toMatch(FALLBACK_AR);
  });

  test("a failed inventory workbook delivery tells the broker instead of going silent", async () => {
    await h.insertListing({ code: "HP-201" });
    h.WA.failNext("document");
    const replies = await h.text("admin", "excel");
    expect(textOf(replies)).toMatch(/Failed to generate the inventory spreadsheet/);
  });

  test("the inventory workbook is delivered as a document when sending works", async () => {
    await h.insertListing({ code: "HP-201" });
    const replies = await h.text("admin", "excel");
    expect(replies.some((r) => r.type === "document" && /^Inventory_/.test(r.filename))).toBe(true);
  });
});

describe("Perceived latency (plan L8)", () => {
  test("every inbound message gets a read receipt with the typing indicator", async () => {
    await h.send("broker", { id: "wamid.typing.1", type: "text", text: { body: "مساعدة" } });
    expect(h.WA.receipts).toContainEqual({ msgId: "wamid.typing.1", typing: true });
  });
});

describe("Photo ceiling (ING-01 / TC-ING-02)", () => {
  test("the 16th photo is dropped with a warning and Save/Cancel buttons", async () => {
    for (let i = 0; i < 15; i++) await h.photo("broker");
    const replies = await h.photo("broker");
    const warning = replies.find((r) => r.type === "buttons");
    expect(warning.text).toMatch(/15 صورة/);
    expect(warning.buttons.map((b) => b.id)).toEqual(["DRAFT_SAVE", "DRAFT_CANCEL"]);
    expect((await h.session("broker")).media_items).toHaveLength(15);
  });
});

describe("Webhook batching (plan #24)", () => {
  test("every message in a batched webhook is processed", async () => {
    const phone = h.BROKERS.broker.phone;
    await h.app.handleWebhookBody({
      entry: [
        { changes: [{ value: { messages: [textMsg(phone, "wamid.b.1", "مساعدة"), textMsg(phone, "wamid.b.2", "مساعدة")] } }] },
        { changes: [{ value: { messages: [textMsg(phone, "wamid.b.3", "مساعدة")] } }] }
      ]
    });
    const rows = await h.query("SELECT msg_id, status FROM inbound_messages ORDER BY msg_id");
    expect(rows).toEqual([
      { msg_id: "wamid.b.1", status: "completed" },
      { msg_id: "wamid.b.2", status: "completed" },
      { msg_id: "wamid.b.3", status: "completed" }
    ]);
  });

  test("status-only webhooks (no messages) are ignored", async () => {
    await h.app.handleWebhookBody({ entry: [{ changes: [{ value: { statuses: [{ id: "x", status: "read" }] } }] }] });
    expect(h.WA.outbox).toHaveLength(0);
  });
});

describe("Unregistered numbers (plan P4)", () => {
  test("an unknown number gets the registration notice once per 24h", async () => {
    const stranger = { phone: "201555000111" };
    const first = await h.text(stranger, "hi");
    const second = await h.text(stranger, "hello?");
    expect(first).toHaveLength(1);
    expect(first[0].text).toMatch(/not registered/);
    expect(second).toHaveLength(0);
  });
});

describe("Draft vs search collision (COL-01)", () => {
  const longQuery =
    "عايز شقة 3 غرف في التجمع الخامس قريبة من الجامعة الأمريكية بحري تشطيب كامل استلام فوري بسعر حدود 9 مليون";

  test("a long Arabic query survives the cancel-and-search round trip (button id stays short)", async () => {
    await h.text("broker", "اضافة");
    const prompt = await h.text("broker", longQuery);
    const ids = prompt.flatMap((r) => r.buttons || []).map((b) => b.id);
    expect(ids).toContain("cancel_and_search");
    expect(ids.every((id) => id.length <= 128)).toBe(true);

    h.AI.respond(() => ({ intent: "search", filters: {}, locations: [], location_terms: [] }));
    await h.tap("broker", "cancel_and_search");
    const sent = JSON.stringify(h.AI.calls[0].contents);
    expect(sent).toContain(longQuery);
    expect(await h.session("broker")).toBeNull();
  });

  test("legacy base64 buttons already sent to brokers still work", async () => {
    await h.text("broker", "اضافة");
    h.AI.respond(() => ({ intent: "search", filters: {}, locations: [], location_terms: [] }));
    const legacy = `cancel_and_search:${Buffer.from("شقة في الرحاب").toString("base64")}`;
    await h.tap("broker", legacy);
    expect(JSON.stringify(h.AI.calls[0].contents)).toContain("شقة في الرحاب");
  });
});
