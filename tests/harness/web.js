// tests/harness/web.js — Web app helpers: sign a broker in through the real magic-link flow.
"use strict";

const request = require("supertest");
const WebAuth = require("../../lib/webAuth");

const csrfOf = (htmlText) => (String(htmlText).match(/name="csrf-token" content="([^"]+)"/) || [])[1] || null;
const preOf = (htmlText) => (String(htmlText).match(/name="_csrf" value="([^"]+)"/) || [])[1] || null;

/**
 * Signs `who` in (token → confirm page → POST) and returns { agent, csrf, broker }.
 * agent keeps the session cookie; csrf is the session token for writes.
 */
async function signIn(h, who) {
  const broker = typeof who === "string" ? h.BROKERS[who] : who;
  const token = await WebAuth.issueLoginToken(h.pool, { id: broker.id, agency_id: broker.agency_id });
  const agent = request.agent(h.app.app);
  const confirm = await agent.get(`/app/login/confirm?t=${token}`);
  const res = await agent.post("/app/login/confirm").type("form").send({ t: token, _csrf: preOf(confirm.text) });
  if (res.status !== 303) throw new Error(`sign-in failed: ${res.status}`);
  const home = await agent.get("/app/");
  return { agent, csrf: csrfOf(home.text), broker };
}

module.exports = { signIn, csrfOf, preOf };
