// tests/unit/commission.test.js — Deal commission (Release 3 step 10, Q10): reference cases. The total from a % or an
// amount, the external share off the top, colleagues' shares rounded down to whole EGP, the remainder to the closing
// broker, so the shares always add up exactly; validation; the % and split parsers.
"use strict";

const C = require("../../domain/commission");

const A = "closer";
const B = "colleague";
const D = "third";
const sum = (r) => r.shares.reduce((s, x) => s + x.amount, 0);

describe("reference cases", () => {
  const cases = [
    // [name, input, total, external, shares by broker]
    ["2% of 8.5M, no split", { price: 8500000, mode: "pct", pct: 2 }, 170000, 0, { [A]: 170000 }],
    ["2% of 8.5M split 60/40", { price: 8500000, mode: "pct", pct: 2, splits: [{ brokerId: B, pct: 40 }] }, 170000, 0, { [A]: 102000, [B]: 68000 }],
    ["2.5% of 3,333,333 rounds the total to whole EGP", { price: 3333333, mode: "pct", pct: 2.5 }, 83333, 0, { [A]: 83333 }],
    ["an amount of 60,000", { price: 3000000, mode: "amount", amount: 60000 }, 60000, 0, { [A]: 60000 }],
    ["external 10% off the top, then 70/30", { price: 3000000, mode: "amount", amount: 60000, external: { pct: 10 }, splits: [{ brokerId: B, pct: 30 }] }, 60000, 6000, { [A]: 37800, [B]: 16200 }],
    ["external as an amount", { price: 5000000, mode: "pct", pct: 2, external: { amount: 25000 } }, 100000, 25000, { [A]: 75000 }],
    ["thirds: the colleagues round down, the closer gets the remainder", { price: 1000000, mode: "amount", amount: 10000, splits: [{ brokerId: B, pct: 33.333 }, { brokerId: D, pct: 33.333 }] }, 10000, 0, { [A]: 3334, [B]: 3333, [D]: 3333 }],
    ["1% of 1,000,001 rounds to 10,000", { price: 1000001, mode: "pct", pct: 1 }, 10000, 0, { [A]: 10000 }],
    ["1% of 1,000,001 split 50/50: 10,000 → 5,000 each", { price: 1000001, mode: "pct", pct: 1, splits: [{ brokerId: B, pct: 50 }] }, 10000, 0, { [A]: 5000, [B]: 5000 }],
    ["an odd amount split 50/50: the closer gets the extra pound", { price: 900000, mode: "amount", amount: 9001, splits: [{ brokerId: B, pct: 50 }] }, 9001, 0, { [A]: 4501, [B]: 4500 }],
    ["rent: one month's 25,000 as the commission", { price: 25000, mode: "amount", amount: 25000 }, 25000, 0, { [A]: 25000 }],
    ["external takes all", { price: 2000000, mode: "pct", pct: 1, external: { pct: 100 } }, 20000, 20000, { [A]: 0 }],
    ["the closer listed in the splits is ignored (gets the remainder)", { price: 1000000, mode: "pct", pct: 3, splits: [{ brokerId: A, pct: 90 }, { brokerId: B, pct: 20 }] }, 30000, 0, { [A]: 24000, [B]: 6000 }]
  ];
  test.each(cases)("%s", (_name, input, total, external, shares) => {
    const r = C.compute({ closingBrokerId: A, ...input });
    expect(r.errors).toEqual([]);
    expect(r.total).toBe(total);
    expect(r.external).toBe(external);
    expect(Object.fromEntries(r.shares.map((s) => [s.brokerId, s.amount]))).toEqual(shares);
    expect(sum(r)).toBe(total - external);
    expect(r.shares.every((s) => Number.isInteger(s.amount))).toBe(true);
    expect(r.shares[0].brokerId).toBe(A);
  });
});

test("validation", () => {
  const err = (input) => C.compute({ closingBrokerId: A, ...input }).errors;
  expect(err({ price: 0, mode: "pct", pct: 2 })).toContain("price");
  expect(err({ price: 1e6 })).toContain("commission_missing");
  expect(err({ price: 1e6, mode: "pct", pct: 0 })).toContain("commission_pct");
  expect(err({ price: 1e6, mode: "pct", pct: 120 })).toContain("commission_pct");
  expect(err({ price: 1e6, mode: "amount", amount: 2e6 })).toContain("commission_over_price");
  expect(err({ price: 1e6, mode: "amount", amount: 1e4, external: { amount: 2e4 } })).toContain("external_over_total");
  expect(err({ price: 1e6, mode: "pct", pct: 2, splits: [{ brokerId: B, pct: 60 }, { brokerId: D, pct: 40 }] })).toContain("split_total");
  expect(err({ price: 1e6, mode: "pct", pct: 2, splits: [{ brokerId: B, pct: 0 }] })).toContain("split_pct");
  expect(err({ price: 1e6, mode: "pct", pct: 2, splits: [{ brokerId: B, pct: 10 }, { brokerId: B, pct: 10 }] })).toContain("split_duplicate");
});

test("parsers: % in both scripts, splits that add up to 100", () => {
  expect(C.parsePct("2%")).toEqual({ mode: "pct", pct: 2 });
  expect(C.parsePct("٢٫٥٪")).toEqual({ mode: "pct", pct: 2.5 });
  expect(C.parsePct("2 في المية")).toEqual({ mode: "pct", pct: 2 });
  expect(C.parsePct("170 ألف")).toBeNull();
  expect(C.parseSplit("60/40")).toEqual([60, 40]);
  expect(C.parseSplit("٧٠/٣٠")).toEqual([70, 30]);
  expect(C.parseSplit("60/50")).toBeNull();
  expect(C.money(170000, "en")).toBe("170,000 EGP");
});

// Q13: «صفقة …» ↔ `deal …` read the same.
test.each([
  ["صفقة L-0042 VIL-08 8.5 مليون عمولة 2%", "deal L-0042 VIL-08 8.5M commission 2%"],
  ["صفقة L-7 RK-APT-48213 3 مليون عمولة 60 ألف خارجي 10% تقسيم 70/30 مع عمر", "deal L-7 RK-APT-48213 3m commission 60k external 10% split 70/30 with عمر"],
  ["صفقه L-3 عمولة ٢٫٥٪", "deal L-3 commission 2.5%"]
])("%s ↔ %s", (ar, en) => {
  const { parseDealCommand } = require("../../lib/deals");
  const a = parseDealCommand(ar);
  const b = parseDealCommand(en);
  expect(a.leadRef).not.toBeNull();
  expect({ ...a, splitText: null }).toEqual({ ...b, splitText: null });
});
