// tests/web/import-rows.test.js — The unified import's rows: pages per tab, ticks, editing, cascade on delete.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");
const ImportRows = require("../../lib/importRows");

jest.setTimeout(60000);
let h;
let importId;
beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.query("DELETE FROM web_imports");
  const [imp] = await h.query(
    "INSERT INTO web_imports (agency_id, broker_id, kind, status, payload) VALUES ($1, $2, 'excel', 'ready', '{}'::jsonb) RETURNING id",
    [h.AGENCY_A, h.BROKERS.broker.id]
  );
  importId = imp.id;
});
afterAll(closeHarness);

const row = (i, kind, extra = {}) => ({ source: "excel", code: `C-${i}`, kind, ticked: kind === "new", data: { i }, reasons: [], ...extra });

test("rows are stored per tab; counts and pages come from their own kind", async () => {
  const rows = [];
  for (let i = 1; i <= 120; i++) rows.push(row(i, i % 3 === 0 ? "changed" : "new"));
  for (let i = 121; i <= 130; i++) rows.push(row(i, "duplicate_code"));
  await ImportRows.replaceRows(h.pool, importId, h.AGENCY_A, rows);
  const c = await ImportRows.counts(h.pool, importId, h.AGENCY_A);
  expect(c.new + c.changed).toBe(120);
  expect(c.duplicate_code).toBe(10);
  // ready = ticked new and changed rows: the 80 new rows (changed rows are unticked by default)
  expect(c.ready).toBe(80);
  const p1 = await ImportRows.page(h.pool, importId, h.AGENCY_A, "new", { offset: 0 });
  expect(p1.rows).toHaveLength(50);
  expect(p1.total).toBe(80);
  const p2 = await ImportRows.page(h.pool, importId, h.AGENCY_A, "new", { offset: 50 });
  expect(p2.rows).toHaveLength(30);
  await expect(ImportRows.page(h.pool, importId, h.AGENCY_A, "nope")).rejects.toMatchObject({ code: "BAD_TAB" });
});

test("ticks change only this import's rows; a row can be read for editing; Apply reads the ticked rows in order", async () => {
  await ImportRows.replaceRows(h.pool, importId, h.AGENCY_A, [row(1, "new"), row(2, "new"), row(3, "changed")]);
  expect(await ImportRows.setTicked(h.pool, importId, h.AGENCY_A, [2], false)).toBe(1);
  // Row 3 is a change, unticked by default; row 1 stays ticked.
  expect((await ImportRows.tickedRows(h.pool, importId, h.AGENCY_A)).map((r) => r.seq)).toEqual([1]);
  expect(await ImportRows.setTicked(h.pool, importId, h.AGENCY_A, [1, 2, 3], true)).toBe(3);
  const r = await ImportRows.getRow(h.pool, importId, h.AGENCY_A, 2);
  expect(r.code).toBe("C-2");
  expect(await ImportRows.getRow(h.pool, importId, h.AGENCY_B, 2)).toBeNull();
});

test("another agency cannot read or tick these rows; deleting the import deletes its rows", async () => {
  await ImportRows.replaceRows(h.pool, importId, h.AGENCY_A, [row(1, "new")]);
  expect(await ImportRows.setTicked(h.pool, importId, h.AGENCY_B, [1], false)).toBe(0);
  expect(await ImportRows.getRow(h.pool, importId, h.AGENCY_B, 1)).toBeNull();
  await h.query("DELETE FROM web_imports WHERE id = $1", [importId]);
  expect(await h.query("SELECT count(*)::int AS n FROM import_rows WHERE import_id = $1", [importId])).toEqual([{ n: 0 }]);
});
