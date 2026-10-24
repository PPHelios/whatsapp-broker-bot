// lib/webAuth.js — Magic-link sign-in and 30-day web sessions. Tokens and session ids are random,
// sent once, and stored only as SHA-256 hashes; a leaked database row cannot sign anyone in.
"use strict";

const crypto = require("crypto");

const LOGIN_TOKEN_TTL_MINUTES = 15;
const SESSION_DAYS = 30;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const looksLikeToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(t);

/** Constant-time string comparison (false for different lengths). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * New one-time login token for an active broker (valid 15 minutes). Returns the token itself;
 * only its hash is stored.
 * @param {"whatsapp"|"web"} channel - where the link was asked for
 */
async function issueLoginToken(pool, broker, { channel = "whatsapp" } = {}) {
  const token = randomToken();
  await pool.query("DELETE FROM web_login_tokens WHERE broker_id = $1 AND (expires_at < NOW() OR used_at IS NOT NULL)", [broker.id]);
  await pool.query(
    `INSERT INTO web_login_tokens (token_hash, broker_id, agency_id, channel, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(mins => $5))`,
    [sha256(token), broker.id, broker.agency_id, channel, LOGIN_TOKEN_TTL_MINUTES]
  );
  return token;
}

const BROKER_COLS = "b.id, b.agency_id, b.name, b.phone_number, b.phone_normalized, b.contact_phone, b.role, b.preferred_lang, b.is_active";

/** The broker a still-valid token belongs to, without using it (the confirm page). */
async function peekLoginToken(pool, token) {
  if (!looksLikeToken(token)) return null;
  const { rows } = await pool.query(
    `SELECT ${BROKER_COLS} FROM web_login_tokens t JOIN brokers b ON b.id = t.broker_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW() AND b.is_active`,
    [sha256(token)]
  );
  return rows[0] || null;
}

/** Uses a token (once, atomically). Returns the active broker, or null. */
async function consumeLoginToken(pool, token) {
  if (!looksLikeToken(token)) return null;
  const { rows } = await pool.query(
    `UPDATE web_login_tokens t SET used_at = NOW()
     FROM brokers b
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > NOW()
       AND b.id = t.broker_id AND b.is_active AND b.agency_id = t.agency_id
     RETURNING ${BROKER_COLS}`,
    [sha256(token)]
  );
  return rows[0] || null;
}

/** Starts a 30-day session. Returns { sid, csrf, expiresAt }; the sid goes only into the cookie. */
async function createSession(pool, broker, { userAgent = null } = {}) {
  const sid = randomToken();
  const csrf = randomToken(24);
  const { rows } = await pool.query(
    `INSERT INTO web_sessions (id_hash, broker_id, agency_id, csrf_token, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(days => $6)) RETURNING expires_at`,
    [sha256(sid), broker.id, broker.agency_id, csrf, userAgent ? String(userAgent).slice(0, 200) : null, SESSION_DAYS]
  );
  return { sid, csrf, expiresAt: rows[0].expires_at };
}

/**
 * The signed-in broker for a session id: { broker, agency, csrf, expiresAt } or null when the
 * session is unknown, expired or revoked, or the broker was deactivated.
 */
async function getSession(pool, sid) {
  if (!looksLikeToken(sid)) return null;
  const { rows } = await pool.query(
    `SELECT s.csrf_token, s.expires_at, s.last_seen_at, ${BROKER_COLS},
            a.name AS agency_name, a.slug AS agency_slug, a.logo_url AS agency_logo_url, a.phone AS agency_phone
     FROM web_sessions s
     JOIN brokers b ON b.id = s.broker_id AND b.agency_id = s.agency_id
     JOIN agencies a ON a.id = b.agency_id
     WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND b.is_active`,
    [sha256(sid)]
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.last_seen_at).getTime() > TOUCH_EVERY_MS) {
    pool.query("UPDATE web_sessions SET last_seen_at = NOW() WHERE id_hash = $1", [sha256(sid)]).catch(() => {});
  }
  const { csrf_token, expires_at, last_seen_at, agency_name, agency_slug, agency_logo_url, agency_phone, ...broker } = r;
  return {
    broker,
    agency: { id: broker.agency_id, name: agency_name, slug: agency_slug, logo_url: agency_logo_url, phone: agency_phone },
    csrf: csrf_token,
    expiresAt: expires_at
  };
}

async function revokeSession(pool, sid) {
  if (!looksLikeToken(sid)) return;
  await pool.query("UPDATE web_sessions SET revoked_at = NOW() WHERE id_hash = $1 AND revoked_at IS NULL", [sha256(sid)]);
}

/** Signs a broker out everywhere (e.g. a lost phone). */
async function revokeAllSessions(pool, brokerId) {
  const { rowCount } = await pool.query("UPDATE web_sessions SET revoked_at = NOW() WHERE broker_id = $1 AND revoked_at IS NULL", [brokerId]);
  return rowCount;
}

module.exports = {
  LOGIN_TOKEN_TTL_MINUTES,
  SESSION_DAYS,
  sha256,
  randomToken,
  safeEqual,
  issueLoginToken,
  peekLoginToken,
  consumeLoginToken,
  createSession,
  getSession,
  revokeSession,
  revokeAllSessions
};
