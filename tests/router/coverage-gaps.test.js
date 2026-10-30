// tests/router/coverage-gaps.test.js — P9 (Release 3 step 12): bootRecovery replays only fresh `new` rows, once and in
// order; the inventory summary (STATS-01).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const ExcelJS = require("exceljs");
const { createHarness, closeHarness, settle, textOf } = require("../harness/app");
const Excel = require("../../lib/excel");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const to = (who, replies) => replies.filter((r) => r.to === h.BROKERS[who].phone);

describe("bootRecovery (P9)", () => {
  const add = (id, status, ago, body = "مساعدة") =>
    h.query(`INSERT INTO inbound_messages (msg_id, phone_key, payload, status, received_at) VALUES ($1, $2, $3, $4, NOW() - $5::interval)`, [
      id,
      h.BROKERS.broker.phone,
      JSON.stringify({ from: h.BROKERS.broker.phone, id, type: "text", text: { body } }),
      status,
      ago
    ]);
  const statuses = async () => Object.fromEntries((await h.query("SELECT msg_id, status, attempts FROM inbound_messages")).map((r) => [r.msg_id, r]));

  test("replays recent new rows only (not batched, handled or stale), and a second boot replays nothing", async () => {
    await add("fresh", "new", "2 minutes");
    await add("stale", "new", "20 minutes");
    await add("running", "batched", "1 minute");
    await add("done", "completed", "1 minute");
    await add("failed", "failed", "1 minute");
    const start = h.WA.outbox.length;
    await h.app.bootRecovery();
    await settle(10);
    const s = await statuses();
    expect(s.fresh.status).not.toBe("new");
    expect(s.fresh.attempts).toBe(1);
    expect(s.stale.status).toBe("new");
    expect(s.running).toMatchObject({ status: "batched", attempts: 0 });
    expect(s.done.status).toBe("completed");
    expect(s.failed.status).toBe("failed");
    // One reply: the help text for the fresh row.
    expect(to("broker", h.WA.outbox.slice(start)).length).toBeGreaterThan(0);

    const again = h.WA.outbox.length;
    await Promise.all([h.app.bootRecovery(), h.app.bootRecovery()]);
    await settle(10);
    expect(h.WA.outbox.length).toBe(again);
    expect((await statuses()).fresh.attempts).toBe(1);
  });
});

describe("inventory summary (STATS-01)", () => {
  test("counts, value and top places for the broker's agency only, in the broker's language, with Export and Add", async () => {
    await h.insertListing({ code: "A-1", compound: "Hyde Park", price_value: 8e6 });
    await h.insertListing({ code: "A-2", compound: "Hyde Park", price_value: 10e6, inventory_type: "developer_model" });
    await h.insertListing({ code: "A-3", compound: "Mivida", status: "sold" });
    await h.insertListing({ code: "A-4", compound: "Mivida", status: "archived" });
    await h.insertListing({ code: "B-1", agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id, compound: "Rival Park" });

    const [ar] = to("broker", await h.text("broker", "احصائيات"));
    expect(ar.text).toContain("إجمالي الوحدات المسجلة:* 4");
    expect(ar.text).toContain("نشط ومتاح للبحث:* 2");
    expect(ar.text).toContain("تم البيع:* 1");
    expect(ar.text).toContain("مؤرشف:* 1");
    expect(ar.text).toContain("مشاريع المطورين:* 1");
    expect(ar.text).toMatch(/1\. \*Hyde Park\*: 2 وحدة/);
    expect(ar.text).not.toContain("Rival Park");
    // Export is for managers only (the whole inventory in one file).
    expect(ar.buttons.map((b) => b.id)).toEqual(["cmd:add"]);

    const [en] = to("admin", await h.text("admin", "stats"));
    expect(en.text).toContain("*Total Units:* 4");
    expect(en.text).toMatch(/Average Unit Price:\* .*9/);
    expect(en.buttons.map((b) => b.title)).toEqual(["Export Excel 📊", "New Unit 📝"]);
    expect((await h.query("SELECT COUNT(*)::int AS n FROM operation_logs WHERE operation_type = 'command_inventory_stats'"))[0].n).toBe(2);
  });
});
