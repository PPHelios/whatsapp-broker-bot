// lib/scheduler.js — In-process job scheduler (P5): one tick a minute, each job run by one instance
"use strict";

const crypto = require("crypto");

/**
 * Jobs: { name, everyMs, run({ pool, now, watermark, log }) → { counts?, watermark? } }.
 *
 * Every instance ticks; a job runs on exactly one of them. The claim is one short transaction:
 * pg_try_advisory_xact_lock on the job's key, then the crm_jobs row is checked (due? not already
 * running?) and stamped with the start time before anything runs. A second instance, or a second
 * tick in the same instance, finds the row stamped and skips. The job itself runs outside that
 * transaction and records its outcome, watermark and a `crm_job_<name>` telemetry row (counts only).
 *
 * Jobs read their watermark and catch up on everything since, so a sleeping instance (Render Free)
 * runs late after waking, never twice and never skipping work.
 */

// A row left 'running' longer than this (crashed instance) may be claimed again.
const STALE_RUNNING_MS = 10 * 60 * 1000;

/** Stable 48-bit advisory lock key per job name. */
function lockKey(name) {
  const h = crypto.createHash("sha1").update(`crm_job:${name}`).digest();
  return Number(h.readUIntBE(0, 6));
}

const toMs = (v) => (v ? new Date(v).getTime() : 0);

function createScheduler({ pool, jobs = [], tickMs = 60000, enabled = false, log = console, onError = null } = {}) {
  let timer = null;
  let first = null; // the first tick, shortly after start
  let current = null; // the tick in progress

  /** Claims a due job; returns its crm_jobs row, or null when it isn't this instance's to run. */
  async function claim(job, now) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lock = await client.query("SELECT pg_try_advisory_xact_lock($1) AS ok", [lockKey(job.name)]);
      if (!lock.rows[0].ok) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query("INSERT INTO crm_jobs (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [job.name]);
      const { rows } = await client.query("SELECT * FROM crm_jobs WHERE name = $1 FOR UPDATE", [job.name]);
      const row = rows[0];
      const sinceStart = now - toMs(row.last_started_at);
      const busy = row.last_status === "running" && sinceStart < Math.max(job.everyMs, STALE_RUNNING_MS);
      if (busy || (row.last_started_at && sinceStart < job.everyMs)) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE crm_jobs SET last_started_at = $2, last_status = 'running', run_count = run_count + 1 WHERE name = $1`,
        [job.name, new Date(now).toISOString()]
      );
      await client.query("COMMIT");
      return row;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function finish(job, { status, error, watermark, counts, ms, now }) {
    await pool.query(
      `UPDATE crm_jobs SET last_finished_at = $2, last_status = $3, last_error = $4,
              watermark = COALESCE($5::jsonb, watermark)
        WHERE name = $1`,
      [job.name, new Date(now).toISOString(), status, error, watermark ? JSON.stringify(watermark) : null]
    );
    await pool
      .query(
        `INSERT INTO operation_logs (operation_type, status, error_code, total_duration_ms, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [`crm_job_${job.name}`, status, status === "failed" ? "JOB_FAILED" : null, ms, JSON.stringify({ counts: counts || {} })]
      )
      .catch(() => {});
  }

  async function runJob(job, now) {
    const row = await claim(job, now);
    if (!row) return { name: job.name, ran: false };
    const t0 = Date.now();
    try {
      const out = (await job.run({ pool, now: new Date(now), watermark: row.watermark || {}, log })) || {};
      await finish(job, { status: "success", error: null, watermark: out.watermark, counts: out.counts, ms: Date.now() - t0, now });
      return { name: job.name, ran: true, status: "success", counts: out.counts || {} };
    } catch (err) {
      // Error text only: jobs must never put personal data into errors (P3).
      const error = String(err && err.message ? err.message : err).slice(0, 300);
      log.error?.(`[SCHEDULER] job ${job.name} failed: ${error}`);
      if (onError) await Promise.resolve(onError(err, job)).catch(() => {});
      await finish(job, { status: "failed", error, ms: Date.now() - t0, now }).catch(() => {});
      return { name: job.name, ran: true, status: "failed", error };
    }
  }

  /** Runs every due job once, in order; a failing job doesn't stop the others. */
  async function tick({ now = Date.now() } = {}) {
    const at = now instanceof Date ? now.getTime() : now;
    const results = [];
    for (const job of jobs) {
      try {
        results.push(await runJob(job, at));
      } catch (err) {
        log.error?.(`[SCHEDULER] claim for ${job.name} failed: ${err.message}`);
        results.push({ name: job.name, ran: false, error: err.message });
      }
    }
    return results;
  }

  function start() {
    if (!enabled || timer || !jobs.length) return false;
    const loop = () => {
      if (current) return; // the previous tick is still running
      current = tick().finally(() => (current = null));
    };
    timer = setInterval(loop, tickMs);
    timer.unref?.();
    first = setTimeout(loop, 5000);
    first.unref?.();
    return true;
  }

  /** Stops ticking and waits for the tick in progress (called first on drain). */
  async function stop() {
    if (timer) clearInterval(timer);
    if (first) clearTimeout(first);
    timer = first = null;
    if (current) await current.catch(() => {});
  }

  return { tick, start, stop, jobs };
}

module.exports = { createScheduler, lockKey, STALE_RUNNING_MS };
