// tests/unit/onboarding.test.js — Pilot onboarding (lib/onboarding.js, scripts/onboard.js)
"use strict";

const { createTestDb } = require("../harness/db");
const O = require("../../lib/onboarding");
const example = require("../../docs/pilot/agency.example.json");

jest.setTimeout(60000);

let db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.pool.end());

test("Egyptian mobiles in any common form normalize to 2010…", () => {
  for (const p of ["01012345678", "+20 101 234 5678", "00201012345678", "٠١٠١٢٣٤٥٦٧٨"]) expect(O.normalizeEgyptMobile(p)).toBe("201012345678");
  expect(O.normalizeEgyptMobile("0221234567")).toBeNull();
});

test("validation lists every problem and requires a manager", () => {
  const { errors } = O.validate({ agency: { primary_color: "blue" }, brokers: [{ name: "", phone: "123", role: "boss" }] });
  expect(errors).toEqual(
    expect.arrayContaining([
      "agency.name is required",
      "agency.primary_color must be a #RRGGBB colour",
      "brokers[0].name is required",
      expect.stringMatching(/not an Egyptian mobile/),
      expect.stringMatching(/role must be one of/),
      "at least one broker must be admin, owner or manager"
    ])
  );
  expect(O.validate(example).errors).toEqual([]);
});

test("onboarding creates the agency and brokers, and re-running updates in place", async () => {
  const first = await O.onboard(db.pool, example);
  expect(first.created).toHaveLength(3);
  const again = await O.onboard(db.pool, { ...example, brokers: example.brokers.map((b) => ({ ...b, lang: "en" })) });
  expect(again.agencyId).toBe(first.agencyId);
  expect(again.updated).toHaveLength(3);
  const { rows } = await db.pool.query("SELECT phone_normalized, role, preferred_lang FROM brokers ORDER BY phone_normalized");
  expect(rows).toEqual([
    { phone_normalized: "201000000001", role: "owner", preferred_lang: "en" },
    { phone_normalized: "201000000002", role: "broker", preferred_lang: "en" },
    { phone_normalized: "201000000003", role: "broker", preferred_lang: "en" }
  ]);
  const { rows: agencies } = await db.pool.query("SELECT name, primary_color, flyer_theme FROM agencies");
  expect(agencies).toEqual([{ name: "Pilot Agency", primary_color: "#0B132B", flyer_theme: "dark" }]);
});

test("a phone registered with another agency is refused, nothing half-written", async () => {
  const other = { agency: { name: "Other" }, brokers: [{ name: "X", phone: "01000000001", role: "owner" }] };
  await expect(O.onboard(db.pool, other)).rejects.toMatchObject({ code: "PHONE_TAKEN" });
  const { rows } = await db.pool.query("SELECT count(*) AS n FROM agencies WHERE name = 'Other'");
  expect(rows[0].n).toBe(0);
});
