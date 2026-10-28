// tests/unit/compound-snap.test.js — F6: a compound name heard slightly wrong snaps to a known one
"use strict";

const { snapCompound } = require("../../domain/places");

test("close misspellings snap; exact names, unknown names and ties don't", () => {
  expect(snapCompound("هاييد بارك")).toEqual({ name: "هايد بارك", changed: true });
  expect(snapCompound("hide park")).toEqual({ name: "Hyde Park", changed: true });
  expect(snapCompound("هايد بارك").changed).toBe(false);
  expect(snapCompound("كمبوند الريحان").changed).toBe(false);
  expect(snapCompound("زد").changed).toBe(false);
});

test("the agency's own names count first", () => {
  expect(snapCompound("سولانا وست", ["سولانا ويست"])).toEqual({ name: "سولانا ويست", changed: true });
  expect(snapCompound("سولانا", ["سولانا ويست"]).changed).toBe(false);
});
