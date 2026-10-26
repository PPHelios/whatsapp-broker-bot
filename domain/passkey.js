// domain/passkey.js — WebAuthn checks for passkey sign-in (Release B, R6), pure and with no dependency. Registration
// uses what browsers hand over directly (response.getPublicKey() as SPKI, getAuthenticatorData(), clientDataJSON), so
// no CBOR is parsed; attestation is "none". Both steps check the client data (type, one-time challenge, our origin),
// the relying-party id hash and the user-present flag; sign-in verifies the signature over authenticatorData ‖
// sha256(clientDataJSON) with the stored key (ES256 or RS256) and a signature counter that must grow when used.
"use strict";

const crypto = require("crypto");

const ALGS = { "-7": "ES256", "-257": "RS256" };
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => {
  const t = String(s || "");
  if (!/^[A-Za-z0-9_-]*$/.test(t)) return null;
  return Buffer.from(t, "base64url");
};
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();

/** A fresh challenge (base64url, 32 bytes). */
const newChallenge = () => b64u(crypto.randomBytes(32));

/** authenticatorData → { rpIdHash, flags, signCount, credentialId? } | null. */
function parseAuthData(buf) {
  if (!buf || buf.length < 37) return null;
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & FLAG_AT) {
    if (buf.length < 55) return null;
    const len = buf.readUInt16BE(53);
    if (buf.length < 55 + len) return null;
    out.credentialId = buf.subarray(55, 55 + len);
  }
  return out;
}

function checkClientData(clientDataB64, { type, challenge, origin }) {
  const raw = fromB64u(clientDataB64);
  if (!raw) return { error: "client_data" };
  let cd;
  try {
    cd = JSON.parse(raw.toString("utf8"));
  } catch {
    return { error: "client_data" };
  }
  if (cd.type !== type) return { error: "type" };
  if (cd.challenge !== challenge) return { error: "challenge" };
  if (cd.origin !== origin) return { error: "origin" };
  return { raw, challenge: cd.challenge };
}

/** The challenge a client data carries (to look it up before verifying), or null. */
function challengeOf(clientDataB64) {
  try {
    return JSON.parse(fromB64u(clientDataB64).toString("utf8")).challenge || null;
  } catch {
    return null;
  }
}

function checkAuthData(authB64, rpId) {
  const buf = fromB64u(authB64);
  const ad = parseAuthData(buf);
  if (!ad) return { error: "auth_data" };
  if (!sha256(Buffer.from(rpId)).equals(ad.rpIdHash)) return { error: "rp_id" };
  if (!(ad.flags & FLAG_UP)) return { error: "user_presence" };
  return { buf, ad };
}

/**
 * Registration: { credentialId, clientDataJSON, authenticatorData, publicKey (SPKI), alg } (base64url) →
 * { credentialId, publicKey, alg, signCount } | { error }.
 */
function verifyRegistration(input, { challenge, origin, rpId }) {
  const alg = Number(input.alg);
  if (!ALGS[String(alg)]) return { error: "alg" };
  const cd = checkClientData(input.clientDataJSON, { type: "webauthn.create", challenge, origin });
  if (cd.error) return cd;
  const a = checkAuthData(input.authenticatorData, rpId);
  if (a.error) return a;
  if (!a.ad.credentialId) return { error: "auth_data" };
  const credentialId = b64u(a.ad.credentialId);
  if (input.credentialId && input.credentialId !== credentialId) return { error: "credential" };
  const spki = fromB64u(input.publicKey);
  try {
    const key = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    if ((alg === -7) !== (key.asymmetricKeyType === "ec")) return { error: "alg" };
  } catch {
    return { error: "public_key" };
  }
  return { credentialId, publicKey: b64u(spki), alg, signCount: a.ad.signCount, verified: Boolean(a.ad.flags & FLAG_UV) };
}

/**
 * Sign-in: { clientDataJSON, authenticatorData, signature } (base64url) with the stored { public_key, alg, sign_count }
 * → { signCount } | { error }.
 */
function verifyAssertion(input, stored, { challenge, origin, rpId }) {
  const cd = checkClientData(input.clientDataJSON, { type: "webauthn.get", challenge, origin });
  if (cd.error) return cd;
  const a = checkAuthData(input.authenticatorData, rpId);
  if (a.error) return a;
  const sig = fromB64u(input.signature);
  if (!sig || !sig.length) return { error: "signature" };
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: fromB64u(stored.public_key), format: "der", type: "spki" });
    ok = crypto.verify("sha256", Buffer.concat([a.buf, sha256(cd.raw)]), key, sig);
  } catch {
    ok = false;
  }
  if (!ok) return { error: "signature" };
  const before = Number(stored.sign_count) || 0;
  // A counter that stops growing means a copied key (authenticators that always send 0 are fine).
  if ((a.ad.signCount || before) && a.ad.signCount <= before) return { error: "counter" };
  return { signCount: a.ad.signCount };
}

module.exports = { ALGS, b64u, fromB64u, newChallenge, parseAuthData, challengeOf, verifyRegistration, verifyAssertion };
