// tests/unit/search-fallback.test.js — the local search parser (used when AI credits run out) on a mixed set of
// Arabic, English, mixed and voice-style queries. Each case lists the filters a correct parse must give.
"use strict";

const Q = require("../../domain/searchQuery");

const CASES = [
  { q: "شقة 3 غرف في التجمع تحت 9 مليون", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, price_max: 9000000 } },
  { q: "villa for sale in new cairo under 15 million", want: { property_types: ["villa"], price_max: 15000000 } },
  { q: "شقة للإيجار في مدينة نصر", want: { listing_type: "rent", property_types: ["apartment"] } },
  { q: "استوديو للايجار", want: { listing_type: "rent", property_types: ["studio"] } },
  { q: "دوبلكس 4 غرف", want: { property_types: ["duplex"], bedrooms_min: 4, bedrooms_max: 4 } },
  { q: "penthouse 3 bedrooms", want: { property_types: ["penthouse"], bedrooms_min: 3, bedrooms_max: 3 } },
  { q: "شقة من 120 لـ 150 متر", want: { property_types: ["apartment"], area_min: 120, area_max: 150 } },
  { q: "apartment 100 to 130 sqm", want: { property_types: ["apartment"], area_min: 100, area_max: 130 } },
  { q: "شقة تشطيب سوبر لوكس", want: { property_types: ["apartment"], finishing: ["super_lux"] } },
  { q: "شقة فرش كامل", want: { property_types: ["apartment"], furnishing: "furnished" } },
  { q: "شقة مدفوعة كاش", want: { payment_cash: true } },
  { q: "أرض للبيع في الشيخ زايد", want: { property_types: ["land"] } },
  { q: "شقة بحري في التجمع", want: { property_types: ["apartment"] } },
  { q: "تحت 5 مليون", want: { price_max: 5000000 } },
  { q: "من 3 مليون لـ 6 مليون", want: { price_min: 3000000, price_max: 6000000 } },
  { q: "شقة 2 حمام 3 غرف", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, bathrooms_min: 2 } },
  { q: "شقة مقدم 500 الف", want: { property_types: ["apartment"], max_down_payment: 500000 } },
  { q: "شقة قسط شهري تحت 20 الف", want: { property_types: ["apartment"], max_installment: 20000 } },
  { q: "apartment in madinaty 3 bedrooms", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3 } },
  { q: "شقة في الشروق بالتقسيط", want: { property_types: ["apartment"], payment_installments: true } },
  { q: "ابيع شقة", want: { property_types: ["apartment"] } },
  { q: "شقة 3 غرف و جراج", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3 } },
  { q: "هات 5 شقق في الرحاب", want: { property_types: ["apartment"] } },
  { q: "شقة استلام فوري", want: { property_types: ["apartment"], delivery_ready: true } },
  { q: "شقة تسليم 2027", want: { property_types: ["apartment"], delivery_by_year: 2027 } },
  { q: "unit code NH-V12", want: { code: "NH-V12" } },
  { q: "NH-V12", want: { code: "NH-V12" } },
  { q: "شقة بالدور الخامس", want: { property_types: ["apartment"], floor_min: 5, floor_max: 5 } },
  { q: "شقة 3 غرف بالقطامية هايتس تحت 7.5 مليون", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, price_max: 7500000 } },
  { q: "villa 4 bedrooms 300 sqm under 30m", want: { property_types: ["villa"], bedrooms_min: 4, bedrooms_max: 4, area_min: 270, area_max: 330, price_max: 30000000 } },
  { q: "شقة 3 غرف 150 متر في التجمع الخامس", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, area_min: 135, area_max: 165 } },
  { q: "شقة 1 غرفة", want: { property_types: ["apartment"], bedrooms_min: 1, bedrooms_max: 1 } },
  { q: "شقة اقل من 2 مليون", want: { property_types: ["apartment"], price_max: 2000000 } },
  { q: "شقة فوق 10 مليون", want: { property_types: ["apartment"], price_min: 10000000 } },
  { q: "townhouse in sheikh zayed for sale", want: { property_types: ["townhouse"] } },
  { q: "شاليه في الساحل للبيع", want: { property_types: ["chalet"] } },
  { q: "محل للايجار في مول", want: { listing_type: "rent", property_types: ["shop"] } },
  { q: "مكتب للإيجار 50 متر", want: { listing_type: "rent", property_types: ["office"], area_min: 45, area_max: 55 } },
  { q: "شقة للبيع في القاهرة الجديدة 3 غرف مع حديقة", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3 } },
  { q: "شقة 3 غرف تحت 9 مليون في التجمع مفروشة", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, price_max: 9000000, furnishing: "furnished" } },
  // Typos, "م" for million, and "rooms" (typed and mixed-language).
  { q: "شقه 3 غرف فى التجمع تحت 9 مليون", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: 3, price_max: 9000000 } },
  { q: "vilal for sale in new cairo", want: { property_types: ["villa"] } },
  { q: "appartment 2 rooms madinaty", want: { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: 2 } },
  { q: "شقة بالتجمع تحت 9م", want: { property_types: ["apartment"], price_max: 9000000 } },
  { q: "2 rooms apartment", want: { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: 2 } },
  { q: "2 bathrooms apartment", want: { property_types: ["apartment"], bathrooms_min: 2 } },
  { q: "شقة واوضتين", want: { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: 2 } },
  { q: "hi", want: { intent: "other" } },
  { q: "مرحبا", want: { intent: "other" } }
];

// KNOWN_GAPS: cases the parser still gets wrong. They run as "known gap" tests that pass while the parser is wrong; once fixed they fail, and the name moves out of this set. A single stated area is a +-10% band; "من X ل Y متر" is the exact range.
const KNOWN_GAPS = new Set([]);

describe("local search parser (fallback when AI credits run out)", () => {
  const run = (q, want) => {
    const { filters, intent } = Q.fallbackParse(q);
    for (const [key, value] of Object.entries(want)) {
      if (key === "intent") {
        expect(intent).toBe(value);
        continue;
      }
      const got = key in filters ? filters[key] : undefined;
      if (Array.isArray(value)) {
        expect(got).toEqual(expect.arrayContaining(value));
      } else {
        expect(got).toEqual(value);
      }
    }
  };
  test.each(CASES.filter((c) => !KNOWN_GAPS.has(c.q)).map((c) => [c.q, c.want]))("%s", run);
  if (KNOWN_GAPS.size) {
    test.each(CASES.filter((c) => KNOWN_GAPS.has(c.q)).map((c) => [c.q, c.want]))("known gap: %s", (q, want) => {
      expect(() => run(q, want)).toThrow();
    });
  }
});
