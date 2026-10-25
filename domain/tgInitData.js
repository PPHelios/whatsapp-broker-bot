// domain/tgInitData.js — Checks Telegram Mini App initData (Release 3T step 4): the website opened from the bot signs
// in by the data Telegram signs with the bot token. secret = HMAC_SHA256("WebAppData", token); the hash is
// HMAC_SHA256(secret, the other fields as sorted "key=value" lines), hex.
"use strict";

const crypto = require("crypto");

const MAX_AGE_SEC = 3600;

/**
 * @param {string} initData - Telegram.WebApp.initData (the query string from #tgWebAppData)
 * @param {string} botToken
 * @param {{ now?: number, maxAgeSec?: number }} [opts] - now in ms
 * @returns {null | { userId: number, user: Object, authDate: number, hash: string }}
 */
function verify(initData, botToken, { now = Date.now(), maxAgeSec = MAX_AGE_SEC } = {}) {
  if (!botToken || typeof initData !== "string" || !initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const lines = [];
  for (const [k, v] of params) if (k !== "hash") lines.push(`${k}=${v}`);
  lines.sort();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(lines.join("\n")).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, "hex"))) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate * 1000 > now + 60000 || now - authDate * 1000 > maxAgeSec * 1000) return null;
  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  return { userId: user.id, user, authDate, hash };
}

/** Signs initData the way Telegram does (tests and local tools). */
function sign(fields, botToken) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(lines.join("\n")).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

module.exports = { MAX_AGE_SEC, verify, sign };
