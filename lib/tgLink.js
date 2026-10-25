// lib/tgLink.js — Linking a broker's Telegram account (Release 3T) and short callback tokens for long button ids.
// A broker links by the one-time start link onboarding prints (t.me/<bot>?start=<token>, 7 days) or by sharing
// their own number from Telegram (the contact must be the sender's own, so nobody can claim another's number).
"use strict";

const crypto = require("crypto");
const Phone = require("../domain/phone");

const LINK_TOKEN_DAYS = 7;
const CALLBACK_MAX_BYTES = 64;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const looksLikeToken = (t) => typeof t === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(t);

const BROKER_COLS =
  "id, agency_id, name, phone_number, phone_normalized, contact_phone, role, preferred_lang, is_active, telegram_user_id, telegram_chat_id";

/** A new start-link token for a broker (only its hash is stored; earlier unused ones stay valid until they expire). */
async function issueLinkToken(pool, broker) {
  const token = crypto.randomBytes(24).toString("base64url"); // 32 characters, within /start's 64
  await pool.query("DELETE FROM telegram_link_tokens WHERE broker_id = $1 AND (expires_at < NOW() OR used_at IS NOT NULL)", [broker.id]);
  await pool.query(
    `INSERT INTO telegram_link_tokens (token_hash, broker_id, agency_id, expires_at) VALUES ($1, $2, $3, NOW() + make_interval(days => $4))`,
    [sha256(token), broker.id, broker.agency_id, LINK_TOKEN_DAYS]
  );
  return token;
}

/** The start link a broker taps (null without TELEGRAM_BOT_USERNAME). */
function startLink(username, token) {
  const u = String(username || "").replace(/^@/, "").trim();
  return /^[A-Za-z0-9_]{5,32}$/.test(u) ? `https://t.me/${u}?start=${token}` : null;
}

/** Ties a Telegram user and chat to a broker; a Telegram account already tied to someone else moves here. */
async function attach(client, brokerId, { userId, chatId }) {
  await client.query("UPDATE brokers SET telegram_user_id = NULL, telegram_chat_id = NULL WHERE telegram_user_id = $1 AND id <> $2", [userId, brokerId]);
  const { rows } = await client.query(
    `UPDATE brokers SET telegram_user_id = $2, telegram_chat_id = $3, telegram_linked_at = NOW() WHERE id = $1 RETURNING ${BROKER_COLS}`,
    [brokerId, userId, chatId]
  );
  return rows[0] || null;
}

/** /start <token>: uses the token once and links. { broker } or { error: invalid | inactive }. */
async function linkByToken(pool, token, ids) {
  if (!looksLikeToken(token)) return { error: "invalid" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE telegram_link_tokens SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING broker_id`,
      [sha256(token)]
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return { error: "invalid" };
    }
    const { rows: b } = await client.query("SELECT is_active FROM brokers WHERE id = $1", [rows[0].broker_id]);
    if (!b[0]?.is_active) {
      await client.query("ROLLBACK");
      return { error: "inactive" };
    }
    const broker = await attach(client, rows[0].broker_id, ids);
    await client.query("COMMIT");
    return { broker };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A contact shared from Telegram: links only when it is the sender's own (contact.user_id = from.id) and the number
 * is an active broker's. { broker } or { error: not_own | unknown }.
 */
async function linkByContact(pool, contact, ids) {
  if (!contact || Number(contact.user_id) !== Number(ids.userId)) return { error: "not_own" };
  const phone = Phone.normalizePhone(contact.phone_number);
  if (!phone) return { error: "unknown" };
  const { rows } = await pool.query("SELECT id FROM brokers WHERE phone_normalized = $1 AND is_active = true LIMIT 1", [phone]);
  if (!rows.length) return { error: "unknown" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const broker = await attach(client, rows[0].id, ids);
    await client.query("COMMIT");
    return { broker };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The active broker linked to a Telegram user (or null). */
async function findBroker(pool, userId) {
  const { rows } = await pool.query(`SELECT ${BROKER_COLS} FROM brokers WHERE telegram_user_id = $1 AND is_active = true LIMIT 1`, [userId]);
  return rows[0] || null;
}

/** callback_data for a button id: the id itself when it fits 64 bytes, else "~" + a short stored token. */
async function encodeCallback(pool, id) {
  const s = String(id);
  if (Buffer.byteLength(s, "utf8") <= CALLBACK_MAX_BYTES && !s.startsWith("~")) return s;
  const token = `~${crypto.randomBytes(12).toString("base64url")}`;
  await pool.query("INSERT INTO telegram_callbacks (token, data) VALUES ($1, $2)", [token, s]);
  return token;
}

/** The button id behind callback_data (null for an unknown or purged token). */
async function decodeCallback(pool, data) {
  const s = String(data || "");
  if (!s.startsWith("~")) return s || null;
  const { rows } = await pool.query("SELECT data FROM telegram_callbacks WHERE token = $1", [s]);
  return rows[0]?.data || null;
}

/** A long wa.me link kept under a short token for GET /go/wa/<token> (same table, purged with the callbacks). */
async function storeWaLink(pool, url) {
  const token = crypto.randomBytes(12).toString("base64url");
  await pool.query("INSERT INTO telegram_callbacks (token, data) VALUES ($1, $2)", [`w${token}`, `wa:${url}`]);
  return token;
}

/** The wa.me link behind a /go/wa token (null when unknown, purged, or not a wa.me link). */
async function waLinkOf(pool, token) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(String(token || ""))) return null;
  const { rows } = await pool.query("SELECT data FROM telegram_callbacks WHERE token = $1", [`w${token}`]);
  const url = rows[0]?.data?.startsWith("wa:") ? rows[0].data.slice(3) : null;
  return url && url.startsWith("https://wa.me/") ? url : null;
}

/** Drops callback tokens older than 30 days (privacy job). */
async function purgeCallbacks(pool) {
  const { rowCount } = await pool.query("DELETE FROM telegram_callbacks WHERE created_at < NOW() - INTERVAL '30 days'");
  return rowCount || 0;
}

module.exports = {
  LINK_TOKEN_DAYS,
  issueLinkToken,
  startLink,
  linkByToken,
  linkByContact,
  findBroker,
  encodeCallback,
  decodeCallback,
  purgeCallbacks,
  storeWaLink,
  waLinkOf
};
