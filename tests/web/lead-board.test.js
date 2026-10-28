// tests/web/lead-board.test.js — The lead board: a column per stage; moving a card saves the stage and comes back.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const Leads = require("../../services/leads");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const broker = async (who) => (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS[who].id]))[0];

test("brokers see their own leads in stage columns and move one; managers see everyone's", async () => {
  await Leads.captureLead(h.pool, await broker("broker"), { phones: "01012345678", name: "Sara Board" });
  await Leads.captureLead(h.pool, await broker("colleague"), { phones: "01112345678", name: "Omar Other" });
  const { agent, csrf } = await signIn(h, "broker");
  const page = await agent.get("/app/leads/board");
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/id="col-new"[\s\S]*Sara Board/);
  expect(page.text).not.toContain("Omar Other");
  const [{ version }] = await h.query("SELECT version FROM leads WHERE name = 'Sara Board'");
  const moved = await agent.post("/app/leads/L-0001/stage").type("form").send({ _csrf: csrf, version, stage: "viewing", back: "board" });
  expect(moved.status).toBe(303);
  expect(moved.headers.location).toMatch(/^\/app\/leads\/board\?moved=L-0001/);
  expect((await h.query("SELECT stage FROM leads WHERE name = 'Sara Board'"))[0].stage).toBe("viewing");
  expect((await agent.get("/app/leads/board")).text).toMatch(/id="col-viewing"[\s\S]*Sara Board/);
  const admin = await signIn(h, "admin");
  expect((await admin.agent.get("/app/leads/board")).text).toContain("Omar Other");
});
