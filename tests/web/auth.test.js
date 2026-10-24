// tests/web/auth.test.js — Release 2 step 3: magic-link sign-in (GET→POST), hashed tokens, 30-day
// sessions, CSRF and rate limits
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn, csrfOf, preOf } = require("../harness/web");
const WebAuth = require("../../lib/webAuth");
const S = require("../../web/session");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const linkIn = (text) => (String(text).match(/(http\S+\/app\/login\/confirm\?t=([A-Za-z0-9_-]+))/) || []).slice(1);
const web = () => h.app.app;

async function linkFromWhatsApp(who = "broker") {
  const [url, token] = linkIn(textOf(await h.text(who, "دخول")));
  return { url, token };
}

describe("the link comes from WhatsApp and opens a confirm page", () => {
  test("'دخول' replies with a one-time link built from PUBLIC_BASE_URL; only its hash is stored", async () => {
    const { url, token } = await linkFromWhatsApp();
    expect(url).toBe(`http://localhost:3000/app/login/confirm?t=${token}`);
    const rows = await h.query("SELECT token_hash, channel, broker_id, expires_at > NOW() + INTERVAL '14 minutes' AS fresh FROM web_login_tokens");
    expect(rows).toEqual([{ token_hash: WebAuth.sha256(token), channel: "whatsapp", broker_id: h.BROKERS.broker.id, fresh: true }]);
    expect(JSON.stringify(rows)).not.toContain(token);
    // English brokers get English copy; "login" works too.
    expect(textOf(await h.text("admin", "login"))).toMatch(/Your AqarChat sign-in link/);
    // The help menu lists it (U1: help shows only working commands).
    expect(textOf(await h.text("broker", "مساعدة"))).toMatch(/\*دخول\*/);
  });

  test("opening the link (GET, e.g. a WhatsApp link preview) never uses it; the page posts to sign in", async () => {
    const { token } = await linkFromWhatsApp();
    for (let i = 0; i < 3; i++) {
      const r = await request(web()).get(`/app/login/confirm?t=${token}`);
      expect(r.status).toBe(200);
      expect(r.text).toMatch(/أهلاً Broker One/);
      expect(r.text).toMatch(/<form method="post" action="\/app\/login\/confirm">/);
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    const [{ used }] = await h.query("SELECT used_at IS NOT NULL AS used FROM web_login_tokens");
    expect(used).toBe(false);
  });

  test("the POST signs in once: 30-day HttpOnly cookie, a hashed session; the link cannot be used again", async () => {
    const { token } = await linkFromWhatsApp();
    const agent = request.agent(web());
    const page = await agent.get(`/app/login/confirm?t=${token}`);
    const res = await agent.post("/app/login/confirm").type("form").send({ t: token, _csrf: preOf(page.text) });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/app/");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("aq_sid="));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=2592000/);
    const sid = cookie.match(/^aq_sid=([^;]+)/)[1];
    const [s] = await h.query("SELECT id_hash, round(extract(epoch FROM expires_at - created_at) / 86400) AS days FROM web_sessions");
    expect(s).toEqual({ id_hash: WebAuth.sha256(sid), days: 30 });

    const home = await agent.get("/app/");
    expect(home.status).toBe(200);
    expect(home.text).toMatch(/أهلاً Broker One/);
    expect(home.text).toMatch(/Agency Alpha/);
    expect(csrfOf(home.text)).toBeTruthy();

    const again = await request(web()).post("/app/login/confirm").set("Cookie", `aq_pre=${preOf(page.text)}`).type("form").send({ t: token, _csrf: preOf(page.text) });
    expect(again.status).toBe(410);
    expect((await h.query("SELECT operation_type FROM operation_logs WHERE operation_type = 'web_login'"))).toHaveLength(1);
  });

  test("the confirm POST needs the page's own CSRF token", async () => {
    const { token } = await linkFromWhatsApp();
    const r = await request(web()).post("/app/login/confirm").type("form").send({ t: token, _csrf: "forged-token-forged-token" });
    expect(r.status).toBe(403);
    const [{ used }] = await h.query("SELECT used_at IS NOT NULL AS used FROM web_login_tokens");
    expect(used).toBe(false);
  });

  test("an expired or unknown link says so (410) and points back to WhatsApp", async () => {
    const { token } = await linkFromWhatsApp();
    await h.query("UPDATE web_login_tokens SET expires_at = NOW() - INTERVAL '1 minute'");
    const r = await request(web()).get(`/app/login/confirm?t=${token}`);
    expect(r.status).toBe(410);
    expect(r.text).toMatch(/الرابط ده انتهى/);
    expect((await request(web()).get("/app/login/confirm?t=nope")).status).toBe(410);
  });
});

describe("sessions and CSRF", () => {
  test("signed-out visitors are sent to the sign-in page (htmx requests get HX-Redirect)", async () => {
    const r = await request(web()).get("/app/");
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/app/login?next=%2Fapp%2F");
    const hx = await request(web()).get("/app/").set("HX-Request", "true");
    expect(hx.status).toBe(401);
    expect(hx.headers["hx-redirect"]).toBe("/app/login?next=%2Fapp%2F");
  });

  test("private pages are never cached and carry the CSRF token for htmx", async () => {
    const { agent } = await signIn(h, "broker");
    const r = await agent.get("/app/");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.text).toMatch(/<meta name="csrf-token" content="[A-Za-z0-9_-]{30,}">/);
  });

  test("writes without the session's CSRF token are refused; sign-out with it ends the session", async () => {
    const { agent, csrf } = await signIn(h, "broker");
    expect((await agent.post("/app/logout")).status).toBe(403);
    expect((await agent.post("/app/logout").set("X-CSRF-Token", "x".repeat(32))).status).toBe(403);
    const out = await agent.post("/app/logout").set("X-CSRF-Token", csrf);
    expect(out.status).toBe(303);
    expect(out.headers["set-cookie"].join(";")).toMatch(/aq_sid=;/);
    const [{ revoked }] = await h.query("SELECT revoked_at IS NOT NULL AS revoked FROM web_sessions");
    expect(revoked).toBe(true);
    expect((await agent.get("/app/")).status).toBe(303);
  });

  test("a deactivated broker's session stops working at once", async () => {
    const { agent } = await signIn(h, "broker");
    await h.query("UPDATE brokers SET is_active = false WHERE id = $1", [h.BROKERS.broker.id]);
    expect((await agent.get("/app/")).status).toBe(303);
  });

  test("an expired session is gone", async () => {
    const { agent } = await signIn(h, "broker");
    await h.query("UPDATE web_sessions SET expires_at = NOW() - INTERVAL '1 second'");
    expect((await agent.get("/app/")).status).toBe(303);
  });

  test("after sign-in only same-site /app/ paths are followed", () => {
    expect(S.safeNext("/app/search?q=1")).toBe("/app/search?q=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "/app/logout", "/other", "javascript:alert(1)", null]) {
      expect(S.safeNext(bad)).toBe("/app/");
    }
  });
});

describe("asking for a link on the web", () => {
  async function ask(phone, agent = request.agent(web())) {
    const form = await agent.get("/app/login");
    return agent.post("/app/login").type("form").send({ phone, _csrf: preOf(form.text) });
  }

  test("a registered number gets the link on WhatsApp (counted); any number gets the same answer", async () => {
    const r = await ask("01000000001");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/لو الرقم ده مسجل/);
    const sent = h.WA.outbox.filter((m) => m.to === "201000000001");
    expect(sent).toHaveLength(1);
    expect(linkIn(sent[0].text)[0]).toMatch(/^http:\/\/localhost:3000\/app\/login\/confirm\?t=/);
    const [row] = await h.query("SELECT channel FROM web_login_tokens");
    expect(row.channel).toBe("web");
    const counted = await h.query("SELECT status, metadata->>'kind' AS kind FROM operation_logs WHERE operation_type = 'wa_outbound'");
    expect(counted).toEqual([{ status: "success", kind: "web_login_link" }]);

    h.WA.outbox.length = 0;
    const unknown = await ask("01099999999");
    expect(unknown.text).toMatch(/لو الرقم ده مسجل/);
    expect(h.WA.outbox).toHaveLength(0);
  });

  test("the request form needs its CSRF token", async () => {
    const r = await request(web()).post("/app/login").type("form").send({ phone: "01000000001" });
    expect(r.status).toBe(403);
  });

  test("rate limits: 5 links per number per hour on the web, 6 per broker per hour on WhatsApp", async () => {
    for (let i = 0; i < 5; i++) expect((await ask("01000000001")).status).toBe(200);
    const limited = await ask("01000000001");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();

    for (let i = 0; i < 6; i++) expect(linkIn(textOf(await h.text("colleague", "دخول")))[0]).toBeTruthy();
    expect(textOf(await h.text("colleague", "دخول"))).toMatch(/طلبت روابط دخول كتير/);
  });
});
