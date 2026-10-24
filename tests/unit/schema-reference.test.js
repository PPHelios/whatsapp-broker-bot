// tests/unit/schema-reference.test.js — SCHEMA_REFERENCE.sql is the schema after every migration
"use strict";

const fs = require("fs");
const { buildReference, OUT } = require("../../scripts/schema-reference");

jest.setTimeout(60000);

test("SCHEMA_REFERENCE.sql is current (run `npm run schema:reference` after adding a migration)", async () => {
  const expected = await buildReference();
  expect(fs.readFileSync(OUT, "utf8")).toBe(expected);
});

test("the reference carries the migrated objects and the outbound counter view", () => {
  const ref = fs.readFileSync(OUT, "utf8");
  expect(ref).toMatch(/CREATE TABLE IF NOT EXISTS public\.schema_migrations/);
  expect(ref).toMatch(/code_norm text GENERATED ALWAYS AS/);
  expect(ref).toMatch(/CREATE TABLE IF NOT EXISTS public\.compound_synonyms/);
  expect(ref).toMatch(/CREATE OR REPLACE VIEW public\.agency_outbound_daily AS/);
});
