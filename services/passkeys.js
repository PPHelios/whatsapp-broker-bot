// services/passkeys.js — Passkey sign-in (Release B, R6). Each user switches it on or off in Settings (off by
// default; off removes their passkeys). With it on they add a passkey on a device and later sign in on the sign-in
// page with the device's fingerprint, face or screen lock, no bot link needed. Challenges are one-time and last 5
// minutes; the relying party is this site's host (Links.siteOrigin). The checks are in domain/passkey.js.
"use strict";

const P = require("../domain/passkey");
const Links = require("../lib/links");

const CHALLENGE_MIN = 5;
const MAX_PER_BROKER = 10;
const RP_NAME = "WehdatHub";

function rp() {
  const origin = Links.siteOrigin();
  return { origin, rpId: new URL(origin).hostname };
}

async function newChallenge(db, kind, brokerId = null) {
  await db.query("DELETE FROM passkey_challenges WHERE expires_at < NOW()");
  const challenge = P.newChallenge();
  await db.query("INSERT INTO passkey_challenges (challenge, kind, broker_id, expires_at) VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))", [challenge, kind, brokerId, CHALLENGE_MIN]);
  return challenge;
}

/** Uses a challenge once: true when it was ours, of this kind (and this broker), and not expired. */
async function takeChallenge(db, challenge, kind, brokerId = null) {
  if (!challenge) return false;
  const { rows } = await db.query(
    "DELETE FROM passkey_challenges WHERE challenge = $1 AND kind = $2 AND expires_at > NOW() AND broker_id IS NOT DISTINCT FROM $3 RETURNING challenge",
    [challenge, kind, brokerId]
  );
  return Boolean(rows[0]);
}

async function isEnabled(db, broker) {
  const { rows } = await db.query("SELECT passkey_enabled FROM brokers WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id]);
  return rows[0]?.passkey_enabled === true;
}

/** The user's switch. Off removes every passkey of theirs. */
async function setEnabled(db, broker, on) {
  await db.query("UPDATE brokers SET passkey_enabled = $3 WHERE id = $1 AND agency_id = $2", [broker.id, broker.agency_id, Boolean(on)]);
  if (!on) await db.query("DELETE FROM broker_passkeys WHERE broker_id = $1", [broker.id]);
  return { ok: true, enabled: Boolean(on) };
}

async function list(db, broker) {
  const { rows } = await db.query("SELECT id, label, created_at, last_used_at FROM broker_passkeys WHERE broker_id = $1 ORDER BY created_at", [broker.id]);
  return rows;
}

async function remove(db, broker, id) {
  const { rowCount } = await db.query("DELETE FROM broker_passkeys WHERE id = $1 AND broker_id = $2", [Number(id) || 0, broker.id]);
  return rowCount ? { ok: true } : { error: "not_found" };
}

/** Options for navigator.credentials.create (the browser turns the base64url fields into bytes). */
async function registerOptions(db, broker) {
  if (!(await isEnabled(db, broker))) return { error: "off" };
  const { rows } = await db.query("SELECT credential_id FROM broker_passkeys WHERE broker_id = $1", [broker.id]);
  if (rows.length >= MAX_PER_BROKER) return { error: "too_many" };
  const challenge = await newChallenge(db, "register", broker.id);
  return {
    challenge,
    rp: { id: rp().rpId, name: RP_NAME },
    user: { id: P.b64u(Buffer.from(broker.id)), name: broker.phone_normalized || broker.phone_number || broker.name || broker.id, displayName: broker.name || RP_NAME },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    excludeCredentials: rows.map((r) => ({ type: "public-key", id: r.credential_id })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    attestation: "none",
    timeout: 120000
  };
}

/** Saves the new passkey after checking it. */
async function register(db, broker, input, { label = null } = {}) {
  if (!(await isEnabled(db, broker))) return { error: "off" };
  const challenge = P.challengeOf(input.clientDataJSON);
  if (!(await takeChallenge(db, challenge, "register", broker.id))) return { error: "challenge" };
  const v = P.verifyRegistration(input, { challenge, ...rp() });
  if (v.error) return v;
  const { rows } = await db.query(
    `INSERT INTO broker_passkeys (broker_id, agency_id, credential_id, public_key, alg, sign_count, label) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (credential_id) DO NOTHING RETURNING id`,
    [broker.id, broker.agency_id, v.credentialId, v.publicKey, v.alg, v.signCount, label ? String(label).slice(0, 120) : null]
  );
  return rows[0] ? { ok: true, id: rows[0].id } : { error: "exists" };
}

/** Options for navigator.credentials.get (any passkey of this site: the browser offers the user's). */
async function loginOptions(db) {
  return { challenge: await newChallenge(db, "login"), rpId: rp().rpId, userVerification: "preferred", timeout: 120000 };
}

/** Checks a sign-in; returns the broker (for WebAuth.createSession) or { error }. */
async function login(db, input) {
  const challenge = P.challengeOf(input.clientDataJSON);
  if (!(await takeChallenge(db, challenge, "login"))) return { error: "challenge" };
  const { rows } = await db.query(
    `SELECT k.id AS passkey_id, k.public_key, k.alg, k.sign_count, b.id, b.agency_id, b.name, b.role, b.preferred_lang
       FROM broker_passkeys k JOIN brokers b ON b.id = k.broker_id AND b.agency_id = k.agency_id
      WHERE k.credential_id = $1 AND b.passkey_enabled AND b.is_active AND b.deactivated_at IS NULL`,
    [String(input.credentialId || "")]
  );
  const row = rows[0];
  if (!row) return { error: "unknown" };
  if (input.userHandle && input.userHandle !== P.b64u(Buffer.from(row.id))) return { error: "unknown" };
  const v = P.verifyAssertion(input, row, { challenge, ...rp() });
  if (v.error) return v;
  await db.query("UPDATE broker_passkeys SET sign_count = $2, last_used_at = NOW() WHERE id = $1", [row.passkey_id, v.signCount]);
  const { passkey_id, public_key, alg, sign_count, ...broker } = row;
  return { ok: true, broker };
}

module.exports = { CHALLENGE_MIN, MAX_PER_BROKER, rp, isEnabled, setEnabled, list, remove, registerOptions, register, loginOptions, login };
