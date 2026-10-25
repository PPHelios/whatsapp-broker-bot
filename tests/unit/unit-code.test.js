// tests/unit/unit-code.test.js — Auto unit codes NH-V12 (Release 3 follow-up): initials from the agency's name, a type
// letter, one running number per agency; managers edit the initials; typed codes stay; agencies don't share numbers.
"use strict";

const { createTestDb } = require("../harness/db");
const UnitCode = require("../../domain/unitCode");
const Store = require("../../lib/listingStore");

jest.setTimeout(60000);

test("initials from English, Arabic and one-word names; filler words left out", () => {
  expect(UnitCode.prefixFrom("Nile Homes")).toBe("NH");
  expect(UnitCode.prefixFrom("Nile Homes Real Estate")).toBe("NH");
  expect(UnitCode.prefixFrom("Agency Alpha")).toBe("AL");
  expect(UnitCode.prefixFrom("Remax")).toBe("RE");
  expect(UnitCode.prefixFrom("شركة النيل للعقارات")).toBe("N");
  expect(UnitCode.prefixFrom("أحمد جمال")).toBe("AG");
  expect(UnitCode.prefixFrom("Coldwell Banker New Cairo")).toBe("CBN");
  expect(UnitCode.prefixFrom("")).toBe("U");
  expect(UnitCode.format("NH", "villa", 12)).toBe("NH-V12");
  expect(UnitCode.format("NH", "something", 3)).toBe("NH-U3");
  expect(UnitCode.cleanPrefix(" nh ")).toBe("NH");
  for (const bad of ["", "NH1", "ABCDE", "نه", null]) expect(UnitCode.cleanPrefix(bad)).toBeNull();
});

describe("allocation", () => {
  let db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(() => db.pool.end());

  test("one running number per agency across types; typed codes are skipped; a manager's prefix is used; agencies are separate", async () => {
    const { rows: [a] } = await db.pool.query("INSERT INTO agencies (name) VALUES ('Nile Homes') RETURNING id");
    const { rows: [b] } = await db.pool.query("INSERT INTO agencies (name) VALUES ('Remax') RETURNING id");
    const next = (agency, type) => Store.nextUnitCode(db.pool, agency, type);
    expect(await next(a.id, "apartment")).toBe("NH-A1");
    expect(await next(a.id, "villa")).toBe("NH-V2");
    expect(await next(b.id, "villa")).toBe("RE-V1");
    // A broker typed NH-A3 by hand: the counter steps over it.
    const { rows: [br] } = await db.pool.query("INSERT INTO brokers (agency_id, phone_number, name, role, is_active) VALUES ($1, '201000000077', 'B', 'broker', true) RETURNING id", [a.id]);
    await db.pool.query("INSERT INTO listings (agency_id, broker_id, code, property_type, listing_type, status) VALUES ($1, $2, 'NH-A3', 'apartment', 'sale', 'active')", [a.id, br.id]);
    expect(await next(a.id, "apartment")).toBe("NH-A4");
    await db.pool.query("UPDATE agencies SET code_prefix = 'NHG' WHERE id = $1", [a.id]);
    expect(await next(a.id, "land")).toBe("NHG-L5");
    await expect(db.pool.query("UPDATE agencies SET code_prefix = 'nh1' WHERE id = $1", [a.id])).rejects.toThrow();
  });
});
