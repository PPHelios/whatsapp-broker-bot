// tests/router/webhook-security.test.js — Real HTTP layer: signature (SEC-01), verify handshake, drain (503)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const request = require("supertest");

const SECRET = "test-app-secret";
process.env.WHATSAPP_APP_SECRET = SECRET; // read by server.js at load time
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(30000);

const sign = (raw) => "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
const body = JSON.stringify({
  entry: [{ changes: [{ value: { messages: [{ from: "201000000001", id: "wamid.sec.1", type: "text", text: { body: "help" } }] } }] }]
});

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

test("valid X-Hub-Signature-256 is accepted (SEC-01)", async () => {
  await request(h.app.app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", sign(body))
    .send(body)
    .expect(200);
});

test("invalid signature is rejected with 401 and not processed (SEC-01)", async () => {
  await request(h.app.app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", "sha256=" + "0".repeat(64))
    .send(body)
    .expect(401);
  expect(await h.query("SELECT 1 FROM inbound_messages")).toHaveLength(0);
});

test("missing signature is rejected with 401 (SEC-01)", async () => {
  await request(h.app.app).post("/webhook").set("Content-Type", "application/json").send(body).expect(401);
});

test("Meta verification handshake echoes the challenge only with the right token", async () => {
  await request(h.app.app)
    .get("/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42")
    .expect(200, "42");
  await request(h.app.app)
    .get("/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42")
    .expect(403);
});

test("while draining, webhooks get 503 so Meta retries", async () => {
  h.app.state.isDraining = true;
  await request(h.app.app)
    .post("/webhook")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", sign(body))
    .send(body)
    .expect(503);
});
