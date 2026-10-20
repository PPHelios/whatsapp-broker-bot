// test/whatsapp.unit.test.js
"use strict";

process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "test_token";

global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ messages: [{ id: "wamid.123" }] })
});

const WA = require("../lib/whatsapp");

describe("lib/whatsapp.js Internal Integrity", () => {
  beforeEach(() => jest.clearAllMocks());

  test("sendWhatsAppButtons executes internal functions without ReferenceError", async () => {
    await expect(
      WA.sendWhatsAppButtons("201011111111", "Menu", [
        { id: "1", title: "Option" }
      ])
    ).resolves.not.toThrow();
  });

  test("sendWhatsAppList executes without ReferenceError", async () => {
    await expect(
      WA.sendWhatsAppList("201011111111", "Header", "Body", "Btn", [])
    ).resolves.not.toThrow();
  });
});
