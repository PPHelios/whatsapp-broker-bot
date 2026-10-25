// tests/unit/public-api-lockdown.test.js — migration 010: Supabase's Data API roles reach nothing in public
"use strict";

const { createTestDb } = require("../harness/db");
const { runMigrations } = require("../../lib/migrate");

jest.setTimeout(60000);

let db;
const q = (sql, p) => db.pool.query(sql, p);

beforeAll(async () => {
  // The baseline as Supabase serves it: anon and authenticated hold grants on every table.
  db = await createTestDb({ migrate: false });
  await q(`DO $$ BEGIN
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await q("GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated");
  await q("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated");
  await runMigrations(db.pool);
});

afterAll(() => db.pool.end());

test("every table in public has row-level security on", async () => {
  const { rows } = await q(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity ORDER BY 1`);
  expect(rows.map((r) => r.relname)).toEqual([]);
});

test("anon and authenticated hold no table grants, including on tables created later", async () => {
  await q("CREATE TABLE lockdown_probe (id int)");
  const { rows } = await q(`SELECT c.relname, r.rolname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(rolname)
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
      AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE')`);
  expect(rows).toEqual([]);
  await q("DROP TABLE lockdown_probe");
});

test("the outbound counter view runs with the caller's rights", async () => {
  const { rows } = await q(
    "SELECT reloptions FROM pg_class WHERE relname = 'agency_outbound_daily'"
  );
  expect(String(rows[0].reloptions)).toMatch(/security_invoker=(true|on)/);
});

test("the app (table owner) still reads and writes", async () => {
  const { rows } = await q("INSERT INTO agencies (name) VALUES ('Lockdown') RETURNING id");
  const read = await q("SELECT count(*)::int AS n FROM agencies WHERE id = $1", [rows[0].id]);
  expect(read.rows[0].n).toBe(1);
  await q("SELECT * FROM agency_outbound_daily");
});
