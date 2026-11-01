// tests/unit/search-installment-words.test.js — Haytham's rule (2026-11-01): a budget is a price ceiling.
// An installment cap is kept only when the message says installment or قسط. The AI reading is checked against the text.
"use strict";

const Q = require("../../domain/searchQuery");

const aiReading = (payment) => Q.normalizeAiSearch({ filters: { bedrooms_min: 2, price_max: null, payment } });
const apply = (text, payment) => Q.enforceInstallmentWords(aiReading(payment), text).filters;

describe("budget numbers are not installments unless said", () => {
  test.each([
    ["azad 2 br budget 70k", "70k"],
    ["azad 2 bedrooms budget 70k", "70k"],
    ["عايز شقة في عزبة 2 غرف ميزانية 70 ألف", "70 ألف"],
    ["عايز شقة 2 غرف تحت 70 ألف", "70 ألف"]
  ])("%s goes to the price ceiling", (text, _label) => {
    const f = apply(text, { max_installment: 70000, installments: true });
    expect(f.price_max).toBe(70000);
    expect(f.max_installment).toBeNull();
    expect(f.payment_installments).toBeNull();
  });

  test.each([
    ["azad 2 br installment 70k", 70000],
    ["azad 2 br 70k installment", 70000],
    ["شقة 2 غرف قسط 70 ألف", 70000],
    ["شقة 2 غرف أقساط 70 ألف", 70000],
    ["شقة 2 غرف تقسيط قسط شهري 70 ألف", 70000]
  ])("%s keeps the installment cap", (text, want) => {
    const f = apply(text, { max_installment: want, installments: true });
    expect(f.max_installment).toBe(want);
    expect(f.payment_installments).toBe(true);
  });

  test("an installment cap never overrides a stated price ceiling", () => {
    const f = Q.enforceInstallmentWords(
      Q.normalizeAiSearch({ filters: { price_max: 9000000, payment: { max_installment: 70000 } } }),
      "شقة تحت 9 مليون 70 ألف"
    ).filters;
    expect(f.price_max).toBe(9000000);
    expect(f.max_installment).toBeNull();
  });

  test("the local reader gives the same answer for the same message", () => {
    const f = Q.fallbackParse("azad 2 br budget 70k").filters;
    expect(f.price_max).toBe(70000);
    expect(f.max_installment).toBeNull();
  });
});
