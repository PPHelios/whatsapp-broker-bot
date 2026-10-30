// tests/router/voice-cap.test.js — a voice note over 60 seconds is refused before any download or AI call.
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

test("over a minute is refused with the short-note message; a short one goes on", async () => {
  await h.text("broker", "اضافه");
  const long = await h.voice("broker", { duration: 90 });
  expect(textOf(long)).toContain("أقل من دقيقة");
  expect(h.AI.calls).toHaveLength(0);
  const short = await h.voice("broker", { duration: 20 });
  expect(textOf(short)).not.toContain("أقل من دقيقة");
});
