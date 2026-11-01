"use strict";
const { runSearch } = require("../../services/search");
const Q = require("../../domain/searchQuery");

// A fake pool: the first query (with the unknown word) finds nothing, the next one finds a unit.
function pool(rowsByCall) {
  let i = 0;
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: rowsByCall[Math.min(i++, rowsByCall.length - 1)] }; } };
}
const row = { id: "00000000-0000-0000-0000-000000000001", total_count: "1" };

describe("soft place words", () => {
  test("an unknown place word is dropped when nothing matches, and reported", async () => {
    const parsed = Q.fallbackParse("شقة تلات غرف في المعادي");
    expect(parsed.filters.place_terms.length).toBe(1);
    const p = pool([[], [], [row]]);
    const res = await runSearch(p, "agency", parsed);
    expect(res.rows.length).toBe(1);
    expect(res.ignoredTerms).toEqual(["المعادي"]);
    expect(parsed.filters.place_terms).toEqual([]);
  });
  test("a match with the word keeps it", async () => {
    const parsed = Q.fallbackParse("شقة تلات غرف في المعادي");
    const res = await runSearch(pool([[row]]), "agency", parsed);
    expect(res.ignoredTerms).toEqual([]);
    expect(parsed.filters.place_terms.length).toBe(1);
  });
  test("a search with only the unknown word is not widened to everything", async () => {
    const parsed = Q.fallbackParse("المعادي");
    const res = await runSearch(pool([[], [], [row]]), "agency", parsed);
    expect(res.rows.length).toBe(0);
  });
});
