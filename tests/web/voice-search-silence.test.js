// tests/web/voice-search-silence.test.js — Voice search on the website never fills the box with text the model made up
// from silence: an empty transcript, or a long one (a search is a few words), gives "couldn't hear you" and no query.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const AI = require("../../lib/ai");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  AI.reset();
});
afterAll(closeHarness);

const clip = () => Buffer.from("OggS\0\0silence");
const MADE_UP = "بص يا فندم، عندي لُقطة في التجمع الخامس في كمبوند مميز جداً، وحدة أرضي بحديقة، كود الوحدة VIL-08، السعر المطلوب 10.5 مليون كاش، شامل وديعة الصيانة، وبدون أي أوفر، الاستلام فوري، والفيو مفتوح على لاند سكيب.";

async function voice(agent, csrf) {
  return agent.post("/app/search/voice").set("X-CSRF-Token", csrf).attach("voice", clip(), { filename: "v.ogg", contentType: "audio/ogg" });
}

test("silent audio that the model answers with made-up speech gives no search text", async () => {
  AI.respond((c) => (c.operation === "transcribe" ? MADE_UP : "{}"));
  const { agent, csrf } = await signIn(h, "admin");
  const r = await voice(agent, csrf);
  expect(r.status).toBe(422);
  expect(r.body.q).toBeUndefined();
});

test("silent audio that comes back empty gives no search text", async () => {
  AI.respond((c) => (c.operation === "transcribe" ? "" : "{}"));
  const { agent, csrf } = await signIn(h, "admin");
  const r = await voice(agent, csrf);
  expect(r.status).toBe(422);
});

test("a short spoken search still becomes the query", async () => {
  AI.respond((c) => (c.operation === "transcribe" ? "شقة 3 غرف في التجمع تحت 9 مليون" : "{}"));
  const { agent, csrf } = await signIn(h, "admin");
  const r = await voice(agent, csrf);
  expect(r.status).toBe(200);
  expect(r.body.q).toBe("شقة 3 غرف في التجمع تحت 9 مليون");
});
