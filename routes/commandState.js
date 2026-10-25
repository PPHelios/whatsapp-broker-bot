// routes/commandState.js — Command telemetry and per-broker command state (last unit used, cooldowns),
// kept in broker_sessions with an in-memory fallback map. Split out of routes/commands.js.
"use strict";

/**
 * Asynchronous, non-blocking operational telemetry logging helper.
 */
async function logCommandOp(
  pool,
  {
    agency_id,
    broker_id,
    listing_code = null,
    operation_type,
    status = "success",
    error_code = null,
    total_duration_ms = 0,
    metadata = {}
  }
) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO operation_logs (
        agency_id, broker_id, listing_code, operation_type,
        status, error_code, total_duration_ms, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        agency_id || null,
        broker_id || null,
        listing_code || null,
        operation_type,
        status,
        error_code,
        Math.round(total_duration_ms),
        JSON.stringify(metadata)
      ]
    );
  } catch (e) {
    console.warn("Operation telemetry log warning:", e.message);
  }
}

/**
 * Distributed Session State: Retrieves broker's most recently accessed listing code.
 */
async function getRecentBrokerListing(pool, brokerId, fallbackMap) {
  if (pool && brokerId) {
    try {
      const { rows } = await pool.query(
        `SELECT session_data->>'recent_code' AS code
         FROM broker_sessions
         WHERE broker_id = $1 AND session_type = 'session_context' AND expires_at > NOW()`,
        [brokerId]
      );
      if (rows.length && rows[0].code) return rows[0].code;
    } catch (e) {
      console.warn(
        "Failed to read recent listing from broker_sessions:",
        e.message
      );
    }
  }
  return fallbackMap?.get?.(brokerId) || null;
}

/**
 * Distributed Session State: Persists broker's most recently accessed listing code.
 */
async function setRecentBrokerListing(pool, brokerId, code, fallbackMap) {
  if (fallbackMap?.set) fallbackMap.set(brokerId, code);
  if (!pool || !brokerId || !code) return;
  try {
    await pool.query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1, 'session_context', jsonb_build_object('recent_code', $2::text), NOW() + INTERVAL '1 hour')
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         session_data = jsonb_build_object('recent_code', $2::text),
         expires_at = NOW() + INTERVAL '1 hour'`,
      [brokerId, code]
    );
  } catch (e) {
    console.warn("Failed to set recent listing in broker_sessions:", e.message);
  }
}

/**
 * Distributed Cooldown: Checks remaining cooldown in seconds.
 */
async function checkBrokerCooldown(pool, brokerId, action, fallbackMap) {
  const now = Date.now();
  if (fallbackMap) {
    const memExp = fallbackMap.get(`${action}:${brokerId}`);
    if (memExp && memExp > now) return Math.ceil((memExp - now) / 1000);
  }
  if (!pool || !brokerId) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT expires_at FROM broker_sessions
       WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()`,
      [brokerId, `cooldown_${action}`]
    );
    if (rows.length > 0) {
      return Math.ceil((new Date(rows[0].expires_at).getTime() - now) / 1000);
    }
  } catch (e) {
    console.warn("Failed to check cooldown in DB:", e.message);
  }
  return 0;
}

/**
 * Distributed Cooldown: Persists cooldown expiration timestamp.
 */
async function setBrokerCooldown(
  pool,
  brokerId,
  action,
  windowMs,
  fallbackMap
) {
  const now = Date.now();
  if (fallbackMap) fallbackMap.set(`${action}:${brokerId}`, now + windowMs);
  if (!pool || !brokerId) return;
  try {
    await pool.query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1, $2, '{}'::jsonb, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         expires_at = NOW() + ($3 || ' milliseconds')::interval`,
      [brokerId, `cooldown_${action}`, String(windowMs)]
    );
  } catch (e) {
    console.warn("Failed to set cooldown in DB:", e.message);
  }
}

/**
 * Distributed Cooldown: Releases active cooldown early (e.g. on execution crash).
 */
async function releaseBrokerCooldown(pool, brokerId, action, fallbackMap) {
  if (fallbackMap) fallbackMap.delete(`${action}:${brokerId}`);
  if (!pool || !brokerId) return;
  try {
    await pool.query(
      `DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2`,
      [brokerId, `cooldown_${action}`]
    );
  } catch (e) {}
}

module.exports = {
  logCommandOp,
  getRecentBrokerListing,
  setRecentBrokerListing,
  checkBrokerCooldown,
  setBrokerCooldown,
  releaseBrokerCooldown
};
