// lib/rateLimit.js — Fixed-window rate limits stored in Postgres (shared by every pod and deploy)
"use strict";

/**
 * Counts one hit in the current window of a bucket and says whether it is allowed.
 * @param {Object} pool
 * @param {string} bucket - e.g. "login_request:ip:1.2.3.4"
 * @param {Object} opts - { limit, windowSec }
 * @returns {Promise<{ allowed: boolean, hits: number, retryAfterSec: number }>}
 */
async function hit(pool, bucket, { limit, windowSec }) {
  const now = Date.now();
  const start = Math.floor(now / (windowSec * 1000)) * windowSec * 1000;
  const { rows } = await pool.query(
    `INSERT INTO web_rate_limits (bucket, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = web_rate_limits.hits + 1
     RETURNING hits`,
    [bucket, new Date(start).toISOString()]
  );
  // Old windows are swept now and then; nothing reads them.
  if (Math.random() < 0.02) {
    pool.query("DELETE FROM web_rate_limits WHERE window_start < NOW() - INTERVAL '2 days'").catch(() => {});
  }
  const hits = Number(rows[0].hits);
  return { allowed: hits <= limit, hits, retryAfterSec: Math.max(1, Math.ceil((start + windowSec * 1000 - now) / 1000)) };
}

// Limits of the web app (per bucket key).
const LIMITS = {
  loginRequestIp: { limit: 20, windowSec: 3600 },
  loginRequestPhone: { limit: 5, windowSec: 3600 },
  loginLinkBroker: { limit: 6, windowSec: 3600 },
  loginConfirmIp: { limit: 30, windowSec: 600 },
  searchBroker: { limit: 60, windowSec: 60 },
  extractBroker: { limit: 20, windowSec: 600 },
  publicPageIp: { limit: 120, windowSec: 60 },
  uploadBroker: { limit: 30, windowSec: 600 },
  crmWriteBroker: { limit: 120, windowSec: 60 }
};

module.exports = { hit, LIMITS };
