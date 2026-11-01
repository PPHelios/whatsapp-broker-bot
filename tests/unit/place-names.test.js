"use strict";

// New English compound names: keys, which names count as new, search widening, and that a new name alerts once.
const PN = require("../../domain/placeNames");
const LIB = require("../../lib/placeNames");

describe("place names: rules", () => {
  test("El Rehab-Phase 1 and el rehab phase 1 share one key", () => {
    expect(PN.nameKey("El Rehab-Phase 1")).toBe(PN.nameKey("el rehab phase 1"));
  });
  test("only English names with no Arabic letters are new", () => {
    expect(PN.isNewEnglishName("Sun Valley")).toBe(true);
    expect(PN.isNewEnglishName("هايد بارك")).toBe(false);
    expect(PN.isNewEnglishName("ab")).toBe(false);
  });
  test("an approved name widens a search term to both languages", () => {
    const approved = [{ name_en: "Sun Valley", name_ar: "صن فالي" }];
    expect(PN.widenTerms(["sun valley"], approved)).toEqual(["sun valley", "صن فالي"]);
    expect(PN.widenTerms(["صن فالي"], approved)).toEqual(["sun valley", "صن فالي"]);
    expect(PN.widenTerms(["المعادي"], approved)).toEqual(["المعادي"]);
  });
});

describe("place names: noting a unit's compound", () => {
  function fakePool() {
    const rows = new Map();
    return {
      rows,
      query: async (sql, params) => {
        if (/SELECT name_en, name_ar FROM place_names/.test(sql)) return { rows: [...rows.values()].filter((r) => r.status === "approved") };
        if (/INSERT INTO place_names/.test(sql)) {
          const [key, name] = params;
          const existing = rows.get(key);
          if (existing) {
            existing.times_seen += 1;
            return { rows: [{ status: existing.status, times_seen: existing.times_seen, inserted: false }] };
          }
          rows.set(key, { name_en: name, name_ar: null, status: "pending", times_seen: 1 });
          return { rows: [{ status: "pending", times_seen: 1, inserted: true }] };
        }
        if (/UPDATE place_names/.test(sql)) return { rows: [] };
        return { rows: [] };
      }
    };
  }

  test("a new name alerts once, then only counts", async () => {
    const pool = fakePool();
    const alerts = [];
    const alert = async (t) => alerts.push(t);
    expect((await LIB.noteUnknown(pool, "Sun Valley", { alert })).status).toBe("new");
    expect((await LIB.noteUnknown(pool, "Sun Valley", { alert })).status).toBe("pending");
    expect(alerts.length).toBe(1);
    expect(pool.rows.get("sun valley").times_seen).toBe(2);
  });
  test("a known compound is not saved", async () => {
    const pool = fakePool();
    expect((await LIB.noteUnknown(pool, "Hyde Park Compound", { alert: async () => {} })).status).toBe("known");
    expect(pool.rows.size).toBe(0);
  });
  test("an Arabic-only name is not saved", async () => {
    const pool = fakePool();
    expect((await LIB.noteUnknown(pool, "صن فالي", { alert: async () => {} })).status).toBe("ignored");
  });
  test("approve needs an Arabic name", async () => {
    expect((await LIB.approve(fakePool(), "id", "Sun Valley")).error).toBe("bad_arabic");
  });
});
