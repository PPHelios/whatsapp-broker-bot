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
    // These tests cover the transport (retries, drops), not who may be messaged: the owner-only check has its own tests.
    process.env.WHATSAPP_OWNER_ONLY = "false";
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
      // routes/turns.js: the unregistered-number notice, sent outside any broker turn (moved there from server.js).
    ].filter((f) => f.endsWith(".js") && !["lib/whatsapp.js", "lib/dispatcher.js", "routes/turns.js"].includes(f));
    const offenders = files.filter((f) =>
      /WA\.send[A-Za-z]+\(/.test(fs.readFileSync(path.join(root, f), "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});

describe("owner-only outbound guard (lib/waOwnerOnly.js)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.WHATSAPP_OWNER_ONLY;
    delete process.env.WHATSAPP_ALLOWED_NUMBER;
  });

  test("nothing reaches the Graph API for a number other than the owner's", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    process.env.WHATSAPP_OWNER_ONLY = "true";
    process.env.WHATSAPP_ALLOWED_NUMBER = "201055881114";
    jest.resetModules();
    const WA = require("../../lib/whatsapp");
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "w" }] }) }));
    expect(await WA.sendWhatsAppText("201000000001", "hi")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await WA.sendWhatsAppText("+20 105 588 1114", "hi"))).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
