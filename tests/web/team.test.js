// tests/web/team.test.js — 5.5 managers invite brokers from the website: a new broker in the manager's agency with a
// one-time Telegram start link (and a wa.me button to send it), the link links their Telegram once, a mobile of another
// agency is refused, managers only, new link for an unlinked broker, deactivate (not self) returns leads, bring back.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const { signIn } = require("../harness/web");
const { resetConfig } = require("../../config");
const TgLink = require("../../lib/tgLink");
const Leads = require("../../services/leads");

jest.setTimeout(90000);

let h;
beforeAll(() => {
  process.env.TELEGRAM_BOT_USERNAME = "Wehdat_Hub_bot";
  resetConfig();
});
beforeEach(async () => {
  h = await createHarness();
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_USERNAME;
  resetConfig();
  await closeHarness();
});

const startToken = (text) => (String(text).match(/https:\/\/t\.me\/Wehdat_Hub_bot\?start=([A-Za-z0-9_-]+)/) || [])[1];

test("a manager invites a broker: added to their agency, a one-time start link that links Telegram once", async () => {
  const a = await signIn(h, "admin");
  const page = await a.agent.post("/app/team/invite").type("form").send({ _csrf: a.csrf, name: "Nour", phone: "01099887766", role: "broker", lang: "ar" });
  expect(page.status).toBe(200);
  const token = startToken(page.text);
  expect(token).toBeDefined();
  expect(page.text).toMatch(/https:\/\/wa\.me\/201099887766\?text=/);
  const [b] = await h.query("SELECT id, agency_id, role, is_active, preferred_lang FROM brokers WHERE phone_normalized = '201099887766'");
  expect(b).toMatchObject({ agency_id: h.AGENCY_A, role: "broker", is_active: true });
  // Only the hash is stored.
  expect(JSON.stringify(await h.query("SELECT * FROM telegram_link_tokens"))).not.toContain(token);

  const linked = await TgLink.linkByToken(h.pool, token, { userId: 991, chatId: 991 });
  expect(linked.broker.id).toBe(b.id);
  expect((await TgLink.linkByToken(h.pool, token, { userId: 992, chatId: 992 })).error).toBe("invalid");
  expect((await a.agent.get("/app/team?lang=en")).text).toMatch(new RegExp(`data-broker="${b.id}"[\\s\\S]*?✅`));
});

test("bad input, another agency's mobile and non-managers are refused", async () => {
  const a = await signIn(h, "admin");
  const post = (body) => a.agent.post("/app/team/invite").type("form").send({ _csrf: a.csrf, ...body });
  expect((await post({ name: "", phone: "01099887766" })).status).toBe(400);
  expect((await post({ name: "X", phone: "12345" })).status).toBe(400);
  expect((await post({ name: "X", phone: "01099887766", role: "owner" })).status).toBe(400);
  const taken = await post({ name: "Stolen", phone: `0${h.BROKERS.rival.phone.slice(2)}`, role: "broker" });
  expect(taken.status).toBe(400);
  expect(taken.text).toMatch(/وكالة تانية|another agency/);
  const [rival] = await h.query("SELECT agency_id, name FROM brokers WHERE id = $1", [h.BROKERS.rival.id]);
  expect(rival).toEqual({ agency_id: h.AGENCY_B, name: "Rival Broker" });

  const b = await signIn(h, "broker");
  expect((await b.agent.get("/app/team")).status).toBe(403);
  expect((await b.agent.post("/app/team/invite").type("form").send({ _csrf: b.csrf, name: "X", phone: "01099887766" })).status).toBe(403);
  expect(await h.query("SELECT 1 FROM brokers WHERE phone_normalized = '201099887766'")).toEqual([]);
});

test("new link for an unlinked broker; deactivate (not self) returns their leads; bring back", async () => {
  const admin = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0];
  const broker = (await h.query("SELECT * FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0];
  await Leads.captureLead(h.pool, broker, { phones: "01012345678", name: "Sara" });
  const a = await signIn(h, "admin");
  const link = await a.agent.post(`/app/team/${h.BROKERS.broker.id}/link`).type("form").send({ _csrf: a.csrf });
  expect(startToken(link.text)).toBeDefined();
  // Another agency's broker id is "not found".
  expect((await a.agent.post(`/app/team/${h.BROKERS.rival.id}/link`).type("form").send({ _csrf: a.csrf })).status).toBe(400);

  expect((await a.agent.post(`/app/team/${admin.id}/deactivate`).type("form").send({ _csrf: a.csrf })).status).toBe(400);
  const off = await a.agent.post(`/app/team/${h.BROKERS.broker.id}/deactivate`).type("form").send({ _csrf: a.csrf, lang: "en" });
  expect(off.status).toBe(200);
  expect((await h.query("SELECT is_active FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0].is_active).toBe(false);
  expect((await h.query("SELECT assigned_broker_id FROM leads"))[0].assigned_broker_id).toBeNull();

  const back = await a.agent.post("/app/team/invite").type("form").send({ _csrf: a.csrf, name: "Broker One", phone: `0${h.BROKERS.broker.phone.slice(2)}`, role: "broker" });
  expect(back.status).toBe(200);
  expect((await h.query("SELECT is_active FROM brokers WHERE id = $1", [h.BROKERS.broker.id]))[0].is_active).toBe(true);
});

test("4.7: a manager can't deactivate, re-invite or take a link for an admin; no link for someone already on Telegram; links are rate-limited", async () => {
  await h.query("UPDATE brokers SET role = 'manager' WHERE id = $1", [h.BROKERS.colleague.id]);
  const m = await signIn(h, "colleague");
  const send = (path, body = {}) => m.agent.post(path).type("form").send({ _csrf: m.csrf, ...body });
  const off = await send(`/app/team/${h.BROKERS.admin.id}/deactivate`);
  expect(off.status).toBe(403);
  expect((await h.query("SELECT is_active FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0].is_active).toBe(true);
  expect((await send(`/app/team/${h.BROKERS.admin.id}/link`)).status).toBe(403);
  const again = await send("/app/team/invite", { name: "Hijack", phone: `0${h.BROKERS.admin.phone.slice(2)}`, role: "broker" });
  expect(again.status).toBe(403);
  expect(startToken(again.text)).toBeUndefined();
  expect((await h.query("SELECT name, role FROM brokers WHERE id = $1", [h.BROKERS.admin.id]))[0]).toEqual({ name: "Agency Admin", role: "admin" });
  expect(await h.query("SELECT 1 FROM telegram_link_tokens WHERE broker_id = $1", [h.BROKERS.admin.id])).toEqual([]);

  // Already on Telegram: a new link would move the account to whoever taps it.
  await h.query("UPDATE brokers SET telegram_user_id = 5, telegram_chat_id = 5 WHERE id = $1", [h.BROKERS.broker.id]);
  const linked = await send(`/app/team/${h.BROKERS.broker.id}/link`);
  expect(linked.status).toBe(400);
  expect(startToken(linked.text)).toBeUndefined();

  // A manager still manages a broker; the link button is capped at 30 a day per agency (two used above).
  await h.query("UPDATE brokers SET telegram_user_id = NULL, telegram_chat_id = NULL WHERE id = $1", [h.BROKERS.broker.id]);
  for (let i = 0; i < 28; i++) expect((await send(`/app/team/${h.BROKERS.broker.id}/link`)).status).toBe(200);
  expect((await send(`/app/team/${h.BROKERS.broker.id}/link`)).status).toBe(429);
});

describe("agency owner: managers and role changes", () => {
  const Team = require("../../services/team");
  const role = async (id) => (await h.pool.query("SELECT role FROM brokers WHERE id = $1", [id])).rows[0].role;

  test("only the agency owner invites a manager; a manager can still invite a broker", async () => {
    await h.seedBroker("manager");
    await h.seedBroker("owner");
    await h.pool.query("UPDATE brokers SET is_active = false WHERE id = ANY($1)", [[h.BROKERS.colleague.id, h.BROKERS.admin.id]]); // frees seats on the Office plan
    const manager = await signIn(h, "manager");
    const asManager = (role) => manager.agent.post("/app/team/invite").set("X-CSRF-Token", manager.csrf).type("form").send({ name: "New One", phone: "01011112222", role });
    expect((await asManager("manager")).status).toBe(403);
    expect((await asManager("broker")).status).toBe(200);
    const owner = await signIn(h, "owner");
    const res = await owner.agent.post("/app/team/invite").set("X-CSRF-Token", owner.csrf).type("form").send({ name: "Other One", phone: "01033334444", role: "manager" });
    expect(res.status).toBe(200);
  });

  test("the agency owner moves a broker to manager and back; managers and brokers cannot; never their own role", async () => {
    await h.seedBroker("manager");
    await h.seedBroker("owner");
    const change = (who, id, to) => who.agent.post(`/app/team/${id}/role`).set("X-CSRF-Token", who.csrf).type("form").send({ role: to });
    const owner = await signIn(h, "owner");
    expect((await change(owner, h.BROKERS.colleague.id, "manager")).status).toBe(200);
    expect(await role(h.BROKERS.colleague.id)).toBe("manager");
    expect((await change(owner, h.BROKERS.colleague.id, "broker")).status).toBe(200);
    expect(await role(h.BROKERS.colleague.id)).toBe("broker");
    expect((await change(owner, h.BROKERS.owner.id, "broker")).status).toBe(400);
    expect(await role(h.BROKERS.owner.id)).toBe("owner");
    const manager = await signIn(h, "manager");
    expect((await change(manager, h.BROKERS.colleague.id, "manager")).status).toBe(403);
    const broker = await signIn(h, "broker");
    expect((await change(broker, h.BROKERS.colleague.id, "manager")).status).toBe(403);
    expect(await role(h.BROKERS.colleague.id)).toBe("broker");
  });

  test("changeRole refuses other agencies' people and the admin/owner roles", async () => {
    await h.seedBroker("owner");
    const owner = h.BROKERS.owner;
    expect(await Team.changeRole(h.pool, owner, h.BROKERS.rival.id, "manager")).toEqual({ error: "not_found" });
    expect(await Team.changeRole(h.pool, owner, h.BROKERS.admin.id, "broker")).toEqual({ error: "rank" });
    expect(await Team.changeRole(h.pool, owner, h.BROKERS.colleague.id, "boss")).toEqual({ error: "role" });
  });
});
