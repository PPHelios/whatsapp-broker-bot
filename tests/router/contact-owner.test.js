// tests/router/contact-owner.test.js — A shared contact while a unit is being added is the unit's owner (never a lead);
// without an open draft it is still the lead lookup.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const contact = (who, name, ...phones) =>
  h.send(who, { type: "contacts", contacts: [{ name: { formatted_name: name }, phones: phones.map((p) => ({ phone: p, type: "CELL" })) }] });

test("an open unit draft takes a shared contact as the owner; no lead is created", async () => {
  await h.text("broker", "add");
  const out = await contact("broker", "Mr Owner", "01012345678");
  expect(textOf(out)).toMatch(/Mr Owner|المالك/);
  const draft = await h.session("broker", "draft");
  expect(draft.prefill.details).toMatchObject({ owner_name: "Mr Owner" });
  expect(draft.prefill.details.owner_phone.replace(/\D/g, "")).toMatch(/1012345678$/);
  expect(await h.query("SELECT 1 FROM leads")).toEqual([]);
});

test("a second contact replaces the owner; a draft keeps its other prefill", async () => {
  await h.text("broker", "add");
  await contact("broker", "First", "01012345678");
  await contact("broker", "Second", "01112345678");
  const draft = await h.session("broker", "draft");
  expect(draft.prefill.details.owner_name).toBe("Second");
});

test("with no draft open, a shared contact is still the lead lookup", async () => {
  const out = await contact("broker", "Someone", "01012345678");
  expect(out.some((r) => (r.buttons || []).some((b) => /^ld:save:/.test(b.id)))).toBe(true);
  expect(await h.session("broker", "draft")).toBeNull();
});
