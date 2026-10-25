// tests/unit/channels.test.js — lib/channels/*: one interface; push payloads carry nothing personal
"use strict";

const WhatsApp = require("../../lib/channels/whatsapp");
const WebPush = require("../../lib/channels/webpush");
const Telegram = require("../../lib/channels/telegram");

test("every channel has the same interface: name + send(broker, message, deps) → { ok }", async () => {
  for (const ch of [WhatsApp, WebPush, Telegram]) {
    expect(typeof ch.name).toBe("string");
    expect(typeof ch.send).toBe("function");
    expect(ch.send.length).toBe(3);
  }
  expect(await Telegram.send({ id: "b" }, { title: "x" }, {})).toEqual({ ok: false, error: "not_linked" }); // bot off in unit tests
});

test("push payload: exactly title, body and an /app/ URL; phone numbers scrubbed; lengths capped", () => {
  const p = JSON.parse(
    WebPush.payloadOf({
      title: "عميل جديد 01012345678",
      url: "/app/leads/L-0001",
      push: { title: "New lead +20 101 234 5678", body: "call ٠١٠١٢٣٤٥٦٧٨ now " + "x".repeat(300) }
    })
  );
  expect(Object.keys(p).sort()).toEqual(["body", "title", "url"]);
  expect(p.title).toBe("New lead ••");
  expect(p.body).not.toMatch(/\d{6,}|[٠-٩]{6,}/);
  expect(p.body.length).toBeLessThanOrEqual(140);
  expect(p.url).toBe("/app/leads/L-0001");
  expect(JSON.parse(WebPush.payloadOf({ title: "x", url: "https://evil.example/" })).url).toBe("/app/notifications");
  expect(JSON.parse(WebPush.payloadOf({ title: "x", url: "//evil.example/app/" })).url).toBe("/app/notifications");
});

test("WhatsApp text of a notification: title, body, the website link", () => {
  expect(WhatsApp.textOf({ title: "🔔 T", body: "B", url: "/app/notifications" })).toBe("🔔 T\nB\n🌐 http://localhost:3000/app/notifications");
  expect(WhatsApp.textOf({ title: "only" })).toBe("only");
});
