// tests/unit/whatsapp-client.test.js — lib/whatsapp.js transport rules and the outbound-path guard
"use strict";

const fs = require("fs");
const path = require("path");

describe("Graph API retry policy (plan Part 2 D)", () => {
  const realFetch = global.fetch;
  let calls;
  let WA;

  beforeEach(() => {
    jest.resetModules();
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    WA = require("../../lib/whatsapp");
    calls = 0;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  test("a message POST that times out is not re-sent (would duplicate the message)", async () => {
    global.fetch = async () => {
      calls++;
      throw new Error("The operation was aborted due to timeout");
    };
    await expect(WA.sendWhatsAppText("201000000001", "hi")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("a message POST rejected with HTTP 503 is retried", async () => {
    global.fetch = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, headers: { get: () => "0.01" }, json: async () => ({}) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: [{ id: "w1" }] }) };
    };
    const res = await WA.sendWhatsAppText("201000000001", "hi");
    expect(res.messages[0].id).toBe("w1");
    expect(calls).toBe(2);
  });

  test("error 131047 (24h window closed) is dropped without retries", async () => {
    global.fetch = async () => {
      calls++;
      return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { code: 131047 } }) };
    };
    expect(await WA.sendWhatsAppText("201000000001", "hi")).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("Single outbound path (plan #7)", () => {
  test("handlers send only through lib/dispatcher (no direct WA.send* outside it)", () => {
    const root = path.join(__dirname, "..", "..");
    const files = [
      ...fs.readdirSync(path.join(root, "routes")).map((f) => `routes/${f}`),
      ...fs.readdirSync(path.join(root, "lib")).map((f) => `lib/${f}`)
    ].filter((f) => f.endsWith(".js") && !["lib/whatsapp.js", "lib/dispatcher.js"].includes(f));
    const offenders = files.filter((f) =>
      /WA\.send[A-Za-z]+\(/.test(fs.readFileSync(path.join(root, f), "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
