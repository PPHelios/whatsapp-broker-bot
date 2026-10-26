// tests/web/passkeys.test.js — Release B R6: passkey sign-in, off per user until they switch it on in Settings. A
// software authenticator (node crypto, ES256 and RS256) registers through the real routes and signs in on the sign-in
// page. Checked: one-time challenges, origin, rp id hash, signature, counter, the user's switch (off removes the keys
// and refuses sign-in) and deactivated brokers.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const crypto = require("crypto");
const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { signIn, preOf } = require("../harness/web");
const Links = require("../../lib/links");
const P = require("../../domain/passkey");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const ORIGIN = () => Links.siteOrigin();
const RP_ID = () => new URL(ORIGIN()).hostname;
const b64u = (b) => Buffer.from(b).toString("base64url");
const sha = (b) => crypto.createHash("sha256").update(b).digest();

/** A software authenticator holding one key. */
function authenticator(alg = -7) {
  const { publicKey, privateKey } = alg === -7 ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }) : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credId = crypto.randomBytes(32);
  let count = 0;
  const authData = ({ attested = false, rpId = RP_ID(), flags = 0x05 } = {}) => {
    const head = Buffer.alloc(37);
    sha(rpId).copy(head, 0);
    head[32] = flags | (attested ? 0x40 : 0);
    head.writeUInt32BE(++count, 33);
    if (!attested) return head;
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credId]);
  };
  const clientData = (type, challenge, origin = ORIGIN()) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    credentialId: b64u(credId),
    create(challenge, opts = {}) {
      return { credentialId: b64u(credId), clientDataJSON: b64u(clientData("webauthn.create", challenge, opts.origin)), authenticatorData: b64u(authData({ attested: true, rpId: opts.rpId })), publicKey: b64u(publicKey.export({ type: "spki", format: "der" })), alg: String(alg) };
    },
    get(challenge, { userHandle = null, origin, rpId, counter = null } = {}) {
      if (counter !== null) count = counter - 1;
      const ad = authData({ rpId });
      const cd = clientData("webauthn.get", challenge, origin);
      const signature = crypto.sign("sha256", Buffer.concat([ad, sha(cd)]), privateKey);
      return { credentialId: b64u(credId), clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(signature), userHandle: userHandle || "" };
    }
  };
}

async function addPasskey(agent, csrf, auth) {
  const opts = await agent.post("/app/passkey/register/options").set("X-CSRF-Token", csrf).type("form").send({});
  expect(opts.status).toBe(200);
  expect(opts.body.rp.id).toBe(RP_ID());
  const res = await agent.post("/app/passkey/register").set("X-CSRF-Token", csrf).type("form").send(auth.create(opts.body.challenge));
  return { opts: opts.body, res };
}

async function passkeyLogin(auth, opts = {}) {
  const agent = request.agent(h.app.app);
  const form = await agent.get("/app/login");
  expect(form.text).toContain('id="passkey-login"');
  const pre = preOf(form.text);
  const o = await agent.post("/app/passkey/login/options").type("form").send({ _csrf: pre });
  expect(o.status).toBe(200);
  const res = await agent.post("/app/passkey/login").type("form").send({ _csrf: pre, next: "/app/leads", ...auth.get(opts.challenge || o.body.challenge, opts) });
  return { agent, res, challenge: o.body.challenge, pre };
}

test("rules: authenticator data, registration and assertion checks", () => {
  const a = authenticator();
  const challenge = P.newChallenge();
  const rp = { challenge, origin: ORIGIN(), rpId: RP_ID() };
  const reg = P.verifyRegistration(a.create(challenge), rp);
  expect(reg).toMatchObject({ credentialId: a.credentialId, alg: -7, signCount: 1 });
  expect(P.verifyRegistration(a.create(challenge, { origin: "https://evil.example" }), rp)).toEqual({ error: "origin" });
  expect(P.verifyRegistration(a.create(challenge, { rpId: "evil.example" }), rp)).toEqual({ error: "rp_id" });
  expect(P.verifyRegistration(a.create("other"), rp)).toEqual({ error: "challenge" });
  expect(P.verifyRegistration({ ...a.create(challenge), alg: "-257" }, rp)).toEqual({ error: "alg" });
  const stored = { public_key: reg.publicKey, alg: -7, sign_count: reg.signCount };
  expect(P.verifyAssertion(a.get(challenge), stored, rp).signCount).toBeGreaterThan(reg.signCount);
  const forged = { ...a.get(challenge), signature: b64u(crypto.randomBytes(70)) };
  expect(P.verifyAssertion(forged, stored, rp)).toEqual({ error: "signature" });
  expect(P.verifyAssertion(a.get(challenge), { ...stored, sign_count: 99 }, rp)).toEqual({ error: "counter" });
  const rsa = authenticator(-257);
  const r2 = P.verifyRegistration(rsa.create(challenge), rp);
  expect(P.verifyAssertion(rsa.get(challenge), { public_key: r2.publicKey, alg: -257, sign_count: 1 }, rp)).toEqual({ signCount: 2 });
});

test("off by default; switch on, add a passkey, sign in with it; challenges are one-time", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const auth = authenticator();
  let settings = await agent.get("/app/settings");
  expect(settings.text).toContain('data-passkeys-enabled="no"');
  expect((await agent.post("/app/passkey/register/options").set("X-CSRF-Token", csrf).type("form").send({})).body).toEqual({ error: "off" });

  expect((await agent.post("/app/settings/passkey").type("form").send({ _csrf: csrf, enabled: "on" })).status).toBe(303);
  const { res } = await addPasskey(agent, csrf, auth);
  expect(res.status).toBe(200);
  settings = await agent.get("/app/settings");
  expect(settings.text).toContain('data-passkeys-enabled="yes"');
  expect(settings.text).toMatch(/data-passkey="\d+"/);

  const ok = await passkeyLogin(auth, { userHandle: b64u(Buffer.from(h.BROKERS.broker.id)) });
  expect(ok.res.status).toBe(200);
  expect(ok.res.body).toEqual({ next: "/app/leads" });
  expect((await ok.agent.get("/app/settings")).status).toBe(200);

  // The same challenge can't be used again; nor can a wrong user handle or a stale counter.
  const again = await ok.agent.post("/app/passkey/login").type("form").send({ _csrf: ok.pre, ...auth.get(ok.challenge) });
  expect(again.status).toBe(403);
  expect((await passkeyLogin(auth, { userHandle: b64u(Buffer.from(h.BROKERS.colleague.id)) })).res.status).toBe(403);
  expect((await passkeyLogin(auth, { counter: 1 })).res.body.error).toBe("counter");
  // Without the sign-in form's token nothing happens.
  expect((await request(h.app.app).post("/app/passkey/login/options").type("form").send({ _csrf: "forged-token-forged-token" })).status).toBe(403);
});

test("switching off removes the passkeys; a deactivated broker can't sign in", async () => {
  const { agent, csrf } = await signIn(h, "broker");
  const auth = authenticator();
  await agent.post("/app/settings/passkey").type("form").send({ _csrf: csrf, enabled: "on" });
  await addPasskey(agent, csrf, auth);
  await h.query("UPDATE brokers SET deactivated_at = now() WHERE id = $1", [h.BROKERS.broker.id]);
  expect((await passkeyLogin(auth)).res.status).toBe(403);
  await h.query("UPDATE brokers SET deactivated_at = NULL WHERE id = $1", [h.BROKERS.broker.id]);
  expect((await passkeyLogin(auth)).res.status).toBe(200);

  await agent.post("/app/settings/passkey").type("form").send({ _csrf: csrf, enabled: "" });
  expect((await h.query("SELECT count(*)::int AS n FROM broker_passkeys"))[0].n).toBe(0);
  expect((await passkeyLogin(auth)).res.body.error).toBe("unknown");
});
