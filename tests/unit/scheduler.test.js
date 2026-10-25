// tests/unit/scheduler.test.js — lib/scheduler.js: each due job runs once, on one instance, with a fixed clock
"use strict";

const { createTestDb } = require("../harness/db");
const { createScheduler, STALE_RUNNING_MS } = require("../../lib/scheduler");

jest.setTimeout(60000);

let db;
const q = (sql, p) => db.pool.query(sql, p);
const T0 = Date.parse("2026-11-01T08:00:00Z");
const quiet = { error: () => {} };

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.pool.end());
beforeEach(() => q("TRUNCATE crm_jobs; DELETE FROM operation_logs WHERE operation_type LIKE 'crm_job_%'"));

function counter(name, everyMs = 60000, body) {
  const job = {
    name,
    everyMs,
    runs: [],
    async run(ctx) {
      job.runs.push(ctx);
      return body ? body(ctx) : { counts: { seen: 1 } };
    }
  };
  return job;
}

test("a due job runs, records its outcome, watermark and a counts-only telemetry row", async () => {
  const job = counter("sweep", 60000, ({ watermark }) => ({ counts: { done: 3 }, watermark: { upTo: (watermark.upTo || 0) + 1 } }));
  const s = createScheduler({ pool: db.pool, jobs: [job], log: quiet });

  const [r] = await s.tick({ now: T0 });
  expect(r).toMatchObject({ name: "sweep", ran: true, status: "success", counts: { done: 3 } });
  expect(job.runs[0].now.toISOString()).toBe("2026-11-01T08:00:00.000Z");

  const { rows } = await q("SELECT * FROM crm_jobs WHERE name = 'sweep'");
  expect(rows[0]).toMatchObject({ last_status: "success", run_count: 1, watermark: { upTo: 1 } });
  const log = await q("SELECT status, metadata FROM operation_logs WHERE operation_type = 'crm_job_sweep'");
  expect(log.rows).toEqual([{ status: "success", metadata: { counts: { done: 3 } } }]);

  // The next run gets the stored watermark.
  await s.tick({ now: T0 + 60000 });
  expect(job.runs[1].watermark).toEqual({ upTo: 1 });
});

test("a job runs again only after everyMs", async () => {
  const job = counter("five-min", 5 * 60000);
  const s = createScheduler({ pool: db.pool, jobs: [job], log: quiet });
  await s.tick({ now: T0 });
  await s.tick({ now: T0 + 60000 });
  await s.tick({ now: T0 + 4 * 60000 });
  expect(job.runs).toHaveLength(1);
  await s.tick({ now: T0 + 5 * 60000 });
  expect(job.runs).toHaveLength(2);
});

test("two concurrent ticks (two instances) run each job once", async () => {
  const a = counter("alpha");
  const b = counter("beta");
  const s1 = createScheduler({ pool: db.pool, jobs: [a, b], log: quiet });
  const s2 = createScheduler({ pool: db.pool, jobs: [a, b], log: quiet });
  const [r1, r2] = await Promise.all([s1.tick({ now: T0 }), s2.tick({ now: T0 })]);
  expect(a.runs).toHaveLength(1);
  expect(b.runs).toHaveLength(1);
  const ran = [...r1, ...r2].filter((r) => r.ran).map((r) => r.name).sort();
  expect(ran).toEqual(["alpha", "beta"]);
});

test("a failing job doesn't stop the others and is retried when due", async () => {
  const bad = counter("bad", 60000, () => {
    throw new Error("boom");
  });
  const good = counter("good");
  const s = createScheduler({ pool: db.pool, jobs: [bad, good], log: quiet });
  const res = await s.tick({ now: T0 });
  expect(res).toEqual([
    { name: "bad", ran: true, status: "failed", error: "boom" },
    expect.objectContaining({ name: "good", ran: true, status: "success" })
  ]);
  const { rows } = await q("SELECT name, last_status, last_error FROM crm_jobs ORDER BY name");
  expect(rows).toEqual([
    { name: "bad", last_status: "failed", last_error: "boom" },
    { name: "good", last_status: "success", last_error: null }
  ]);
  const log = await q("SELECT status, error_code FROM operation_logs WHERE operation_type = 'crm_job_bad'");
  expect(log.rows).toEqual([{ status: "failed", error_code: "JOB_FAILED" }]);
  await s.tick({ now: T0 + 60000 });
  expect(bad.runs).toHaveLength(2);
});

test("a job left running by a crashed instance is reclaimed only after it goes stale", async () => {
  await q("INSERT INTO crm_jobs (name, last_started_at, last_status) VALUES ('stuck', $1, 'running')", [new Date(T0).toISOString()]);
  const job = counter("stuck");
  const s = createScheduler({ pool: db.pool, jobs: [job], log: quiet });
  await s.tick({ now: T0 + 2 * 60000 });
  expect(job.runs).toHaveLength(0);
  await s.tick({ now: T0 + STALE_RUNNING_MS });
  expect(job.runs).toHaveLength(1);
});

test("waking after a long sleep runs each job once, late, with its watermark (Render Free)", async () => {
  const job = counter("catch-up", 60000, ({ watermark, now }) => ({ watermark: { since: watermark.until || null, until: now.toISOString() } }));
  const s = createScheduler({ pool: db.pool, jobs: [job], log: quiet });
  await s.tick({ now: T0 });
  await s.tick({ now: T0 + 3 * 3600 * 1000 }); // three hours asleep
  expect(job.runs).toHaveLength(2);
  expect(job.runs[1].watermark.until).toBe("2026-11-01T08:00:00.000Z");
});

test("start() is a no-op when disabled (tests) or without jobs; stop() is safe", async () => {
  expect(createScheduler({ pool: db.pool, jobs: [counter("x")], enabled: false }).start()).toBe(false);
  expect(createScheduler({ pool: db.pool, jobs: [], enabled: true }).start()).toBe(false);
  const s = createScheduler({ pool: db.pool, jobs: [counter("y")], enabled: true, tickMs: 60000 });
  expect(s.start()).toBe(true);
  await s.stop();
});

test("createApp builds a disabled scheduler under tests", () => {
  const { loadConfig } = require("../../config");
  expect(loadConfig({ NODE_ENV: "test" }).scheduler).toEqual({ enabled: false, tickMs: 60000 });
  expect(loadConfig({ NODE_ENV: "development" }).scheduler.enabled).toBe(true);
  expect(loadConfig({ NODE_ENV: "development", SCHEDULER_ENABLED: "false" }).scheduler.enabled).toBe(false);
});
