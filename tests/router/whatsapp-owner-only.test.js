// tests/router/whatsapp-owner-only.test.js — WhatsApp serves the CRM owner's number only, and only "login" and help.
// Any other sender gets no reply, and nothing is sent on WhatsApp to any other number.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { resetConfig } = require("../../config");
const { createHarness, closeHarness } = require("../harness/app");
const WaOwnerOnly = require("../../lib/waOwnerOnly");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  process.env.WHATSAPP_OWNER_ONLY = "true";
  process.env.WHATSAPP_ALLOWED_NUMBER = "201000000003"; // the harness's agency admin plays the CRM owner
  resetConfig();
  h = await createHarness();
});
afterEach(async () => {
  delete process.env.WHATSAPP_ALLOWED_NUMBER;
  delete process.env.WHATSAPP_OWNER_ONLY;
  resetConfig();
  await closeHarness();
});

test("the owner's number gets a sign-in link for login, and help", async () => {
  const login = await h.text("admin", "login");
  expect(JSON.stringify(login)).toMatch(/https?:\/\//);
  expect((await h.text("admin", "مساعدة")).length).toBeGreaterThan(0);
});

test("the owner's number gets nothing for any other command", async () => {
  expect(await h.text("admin", "أضف وحدة جديدة")).toEqual([]);
  expect(await h.text("admin", "search 3 bedroom")).toEqual([]);
});

test("any other number gets no reply, not even for login or help", async () => {
  expect(await h.text("broker", "login")).toEqual([]);
  expect(await h.text("broker", "مساعدة")).toEqual([]);
  expect(h.WA.outbox).toEqual([]);
});

test("the switch off (WHATSAPP_OWNER_ONLY=false) lets every sender through", () => {
  process.env.WHATSAPP_OWNER_ONLY = "false";
  resetConfig();
  expect(WaOwnerOnly.inboundAllowed({ from: "201000000001", type: "text", text: { body: "add" } })).toBe(true);
  expect(WaOwnerOnly.outboundAllowed("201000000001")).toBe(true);
  delete process.env.WHATSAPP_OWNER_ONLY;
  resetConfig();
});

test("the allowlist: national and international forms match; other numbers and non-text messages do not", () => {
  process.env.WHATSAPP_ALLOWED_NUMBER = "01055881114";
  resetConfig();
  const { isOwnerNumber, inboundAllowed, outboundAllowed } = WaOwnerOnly;
  expect(isOwnerNumber("201055881114")).toBe(true);
  expect(isOwnerNumber("+20 105 588 1114")).toBe(true);
  expect(outboundAllowed("201055881114")).toBe(true);
  expect(outboundAllowed("201000000001")).toBe(false);
  const msg = (from, body, type = "text") => ({ from, type, text: { body } });
  expect(inboundAllowed(msg("201055881114", "login"))).toBe(true);
  expect(inboundAllowed(msg("201055881114", "help"))).toBe(true);
  expect(inboundAllowed(msg("201055881114", "add"))).toBe(false);
  expect(inboundAllowed(msg("201000000001", "login"))).toBe(false);
  expect(inboundAllowed({ from: "201055881114", type: "image", image: {} })).toBe(false);
});
