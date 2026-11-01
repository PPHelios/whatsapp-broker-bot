// tests/unit/search-scripts.test.js — the local search parser on invented search scripts: spoken Egyptian with fillers,
// typos, mixed Arabic and English, spoken numbers, budgets written in several ways. Each row is a query and the filters
// a correct parse gives. Added when the parser was extended; new scripts go here first.
"use strict";

const Q = require("../../domain/searchQuery");

const SCRIPTS = [
  ["يعني عايز شقة اتنين غرف في التجمع الخامس ميزانيتي حوالي خمسة مليون", { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: null, price_max: 5000000 }],
  ["ممكن تبعتلي فيلا في الشيخ زايد من 20 لـ 30 مليون", { property_types: ["villa"], price_min: 20000000, price_max: 30000000 }],
  ["شقة 120 متر في مدينتي", { property_types: ["apartment"], area_min: 120, area_max: null }],
  ["اي شقة استلام فوري في مدينة نصر", { property_types: ["apartment"], delivery_ready: true }],
  ["studio furnished for rent in zamalek", { listing_type: "rent", property_types: ["studio"], furnishing: "furnished" }],
  ["need a 3 bedroom apt in new cairo under 12m", { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null, price_max: 12000000 }],
  ["دوبلكس في الشروق تحت 15 مليون", { property_types: ["duplex"], price_max: 15000000 }],
  ["تاون هاوس للبيع في الساحل", { property_types: ["townhouse"] }],
  ["شاليه في العين السخنة", { property_types: ["chalet"] }],
  ["أرض في أكتوبر", { property_types: ["land"] }],
  ["شقة بسعر ٣ مليون", { property_types: ["apartment"], price_max: 3000000 }],
  ["عايز شقة تشطيب كامل في التجمع", { property_types: ["apartment"], finishing: ["fully_finished"] }],
  ["شقة تشطيب سوبر لوكس فوق 8 مليون", { property_types: ["apartment"], finishing: ["super_lux"], price_min: 8000000 }],
  ["apartment 3 beds 2 baths madinaty", { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null, bathrooms_min: 2 }],
  ["شقة مقدم 300 الف وقسط شهري 10 الف", { property_types: ["apartment"], max_down_payment: 300000, max_installment: 10000 }],
  ["شقة بالدور التالت", { property_types: ["apartment"], floor_min: 3, floor_max: 3 }],
  ["شقة في الدور الاول", { property_types: ["apartment"], floor_min: 1, floor_max: 1 }],
  ["شقة كاش بحري", { property_types: ["apartment"], payment_cash: true }],
  ["شقة في زايد الجديدة 2 غرف بالتقسيط", { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: null, payment_installments: true }],
  ["مكتب للايجار في وسط البلد", { listing_type: "rent", property_types: ["office"] }],
  ["محل تجاري للبيع في التجمع", { property_types: ["shop"] }],
  ["عايز شقه ٤ غرف", { property_types: ["apartment"], bedrooms_min: 4, bedrooms_max: null }],
  ["اه شقة تلاتة اوض في مدينتي", { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null }],
  ["vila 4 rooms new cairo", { property_types: ["villa"], bedrooms_min: 4, bedrooms_max: null }],
  ["penthouse in mivida 3 bedroom", { property_types: ["penthouse"], bedrooms_min: 3, bedrooms_max: null }],
  ["شقة 90 متر فى الرحاب بحدود 4 مليون", { property_types: ["apartment"], area_min: 90, area_max: null, price_max: 4000000 }],
  ["ستوديو في الجونة ببلاش", { property_types: ["studio"] }],
  ["شقة في المعادي 4 غرف مش عايز اكتر من 9 مليون", { property_types: ["apartment"], bedrooms_min: 4, bedrooms_max: null, price_max: 9000000 }],
  ["شقه للايجار مفروشه 2 غرف", { listing_type: "rent", property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: null, furnishing: "furnished" }],
  ["villa for sale sheikh zayed 400 sqm", { property_types: ["villa"], area_min: 400, area_max: null }],
  ["شقه تحت 2 مليون في المقطم", { property_types: ["apartment"], price_max: 2000000 }],
  ["شقة من 3 لـ 5 غرف", { property_types: ["apartment"] }],
  ["شقة 3 غرف و صالة في مدينة نصر", { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null }],
  ["الوحدة كود NH-V12", { code: "NH-V12" }],
  ["شقة قيمتها ٥ مليون ونص", { property_types: ["apartment"], price_max: 5500000 }],
  ["شقة سعرها اكتر من 15 مليون في التجمع", { property_types: ["apartment"], price_min: 15000000 }],
  ["فيلا 350 متر", { property_types: ["villa"], area_min: 350, area_max: null }]
];

describe("local search parser on invented scripts", () => {
  test.each(SCRIPTS)("%s", (q, want) => {
    const { filters } = Q.fallbackParse(q);
    for (const [key, value] of Object.entries(want)) {
      if (Array.isArray(value)) expect(filters[key]).toEqual(expect.arrayContaining(value));
      else expect(filters[key]).toEqual(value);
    }
  });
});
