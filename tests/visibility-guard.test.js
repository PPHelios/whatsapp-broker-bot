// tests/visibility-guard.test.js — Every read of units (listings) or leads goes through lib/visibility, so a hidden item
// can't leak from a query that forgot the rule. Reads that predate the helper are in visibility-baseline.json; that list
// may only shrink: a new read without the helper, or an old one that changed, fails here.
"use strict";

const { scan, uncovered, readBaseline } = require("../scripts/visibility-scan");

describe("visibility guard", () => {
  const skipping = uncovered(scan());
  const baseline = readBaseline();

  test("no new read of listings or leads skips lib/visibility", () => {
    const fresh = Object.entries(skipping)
      .filter(([key, n]) => n > (baseline[key] || 0))
      .map(([key]) => key);
    expect(fresh).toEqual([]);
  });

  test("the baseline lists only reads that still exist and still skip the helper (delete converted ones)", () => {
    const stale = Object.keys(baseline).filter((key) => !(key in skipping));
    expect(stale).toEqual([]);
  });

  test("the helper's conditions carry the marker the guard looks for", () => {
    const Vis = require("../lib/visibility");
    expect(Vis.units("l")).toMatch(/vis:units/);
    expect(Vis.leads("l")).toMatch(/vis:leads/);
  });
});
