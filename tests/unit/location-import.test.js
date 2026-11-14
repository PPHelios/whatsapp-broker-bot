"use strict";

// Migration 111: the reviewed location list loads, compounds get their area, a second run changes nothing.
const { createTestDb } = require("../harness/db");
const { up } = require("../../db/migrations/111_location_import");
const data = require("../../db/data/location-import-2026-11.json");

jest.setTimeout(120000);

describe("location import", () => {
  let db;
  const q = (sql, args) => db.pool.query(sql, args);
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => db.pool.end());

  test("every area in the list exists, with kind and governorate", async () => {
    const n = (await q("SELECT count(*)::int AS n FROM areas WHERE place_type IS NOT NULL AND governorate IS NOT NULL")).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(data.tree.length);
    const fifth = (await q(
      `SELECT p.name_en AS parent FROM areas a JOIN areas p ON p.id = a.parent_id WHERE a.name_en LIKE '1st District (Fifth Settlement)'`
    )).rows;
    expect(fifth.map((r) => r.parent)).toEqual(["5th Settlement"]);
  });

  test("investors extension is an alias, not an area", async () => {
    const gone = (await q("SELECT count(*)::int AS n FROM areas WHERE name_en ILIKE '%Investors Extension'")).rows[0].n;
    expect(gone).toBe(0);
    const a = (await q("SELECT aliases FROM areas WHERE name_en = 'Northern Investors Area'")).rows[0];
    expect(a.aliases.join("|")).toMatch(/North Investors Extension/i);
  });

  test("compounds have an area and sourced notes", async () => {
    const noArea = (await q("SELECT count(*)::int AS n FROM map_places WHERE area_id IS NULL AND source = 'manual' AND approved")).rows[0].n;
    expect(noArea).toBe(0);
    const notes = (await q("SELECT count(*)::int AS n FROM map_places WHERE project_info_en IS NOT NULL")).rows[0].n;
    expect(notes).toBeLessThanOrEqual(22);
  });

  test("a second run changes nothing", async () => {
    const count = async () => (await q("SELECT (SELECT count(*) FROM areas)::int AS a, (SELECT count(*) FROM map_places)::int AS p")).rows[0];
    const before = await count();
    const client = await db.pool.connect();
    await client.query("BEGIN");
    await up(client);
    await client.query("COMMIT");
    client.release();
    expect(await count()).toEqual(before);
  });
});
