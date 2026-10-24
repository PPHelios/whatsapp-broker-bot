// tests/unit/data-model.test.js — migration 002/003: structured columns and backfill from legacy rows
"use strict";

const { createTestDb } = require("../harness/db");
const { runMigrations } = require("../../lib/migrate");

jest.setTimeout(60000);

const A = "a0000000-0000-0000-0000-00000000000a";
let db;

beforeAll(async () => {
  // A database as it was before Release 1, with legacy rows, then migrated.
  db = await createTestDb({ migrate: false });
  const q = (sql, p) => db.pool.query(sql, p);
  await q("INSERT INTO agencies (id, name) VALUES ($1, 'A')", [A]);
  const ins = (code, cols) =>
    q(
      `INSERT INTO listings (agency_id, code, ${Object.keys(cols).join(", ")})
       VALUES ($1, $2, ${Object.keys(cols).map((_, i) => `$${i + 3}`).join(", ")})`,
      [A, code, ...Object.values(cols)]
    );
  await ins("L-COL", { delivery_date: "Q3 2027" });
  await ins("L-JSON", { details: JSON.stringify({ delivery_date: "2028" }) });
  await ins("L-READY", { details: JSON.stringify({ ready_to_move: true }) });
  await ins("L-FUZZY", { delivery_date: "بعد سنتين" });
  await ins("L-FEAT", {
    features: ["ناصية", "جاكوزي"],
    details: JSON.stringify({ has_nanny_room: true, orientation: "بحري", features: ["Garden View"] })
  });
  await ins("L-RESALE", {
    details: JSON.stringify({ remaining_balance: 1200000, installment_amount: 50000, installment_years: 6 })
  });
  await ins("L-DEV", { inventory_type: "developer_model" });
  await runMigrations(db.pool);
});
afterAll(() => db.pool.end());

const row = async (code) => (await db.pool.query("SELECT * FROM listings WHERE code = $1", [code])).rows[0];

test("delivery backfill reads the column and the details JSON", async () => {
  expect(await row("L-COL")).toMatchObject({ delivery_year: 2027, delivery_quarter: 3, delivery_raw: "Q3 2027" });
  expect(await row("L-JSON")).toMatchObject({ delivery_year: 2028, delivery_quarter: null });
  expect(await row("L-READY")).toMatchObject({ is_ready: true, delivery_year: null });
  expect(await row("L-FUZZY")).toMatchObject({ delivery_year: null, is_ready: null, delivery_raw: "بعد سنتين" });
});

test("feature keys come from flags and free text; unknown extras stay free text", async () => {
  const r = await row("L-FEAT");
  expect(r.feature_keys).toEqual(["north_facing", "corner", "nanny_room", "view_garden"]);
  expect(r.features_other).toEqual(["جاكوزي"]);
});

test("resale schedule backfill", async () => {
  expect(await row("L-RESALE")).toMatchObject({ remaining_amount: 1200000, installment_value: 50000, installment_years: 6 });
});

test("market: developer inventory is primary, the rest resale", async () => {
  expect((await row("L-DEV")).market).toBe("primary");
  expect((await row("L-COL")).market).toBe("resale");
});

test("confirmed_at is set on existing rows", async () => {
  expect((await row("L-COL")).confirmed_at).not.toBeNull();
});

test("new rows have no invented payment frequency or maintenance %", async () => {
  await db.pool.query("INSERT INTO listings (agency_id, code) VALUES ($1, 'NEW-1')", [A]);
  expect(await row("NEW-1")).toMatchObject({ payment_frequency: null, maintenance_pct: null });
});

test("code_norm is unique per agency (case and Arabic digits folded)", async () => {
  await db.pool.query("INSERT INTO listings (agency_id, code) VALUES ($1, 'vil-08')", [A]);
  expect((await row("vil-08")).code_norm).toBe("VIL-08");
  await expect(db.pool.query("INSERT INTO listings (agency_id, code) VALUES ($1, 'VIL-08')", [A])).rejects.toMatchObject({
    code: "23505"
  });
  await expect(db.pool.query("INSERT INTO listings (agency_id, code) VALUES ($1, 'VIL-٠٨')", [A])).rejects.toThrow();
});
