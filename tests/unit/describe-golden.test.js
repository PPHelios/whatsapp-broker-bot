// tests/unit/describe-golden.test.js — Golden descriptions: 7 unit cases × every surface (domain/describe.js)
// Every captured field appears; nothing internal reaches a client surface; warnings appear only in add/edit review.
"use strict";

const D = require("../../domain/describe");
const R = require("../../domain/fieldRules");

const NOW = new Date("2026-10-24T10:00:00Z");
const broker = { name: "Mona", phone_normalized: "201000000001" };
const INTERNAL = { owner_name: "OWNER-X", owner_phone: "01099998888", notes: "NOTE-X", commission: "COMM-X", co_broker: "CB-X" };
const INTERNAL_RE = /OWNER-X|01099998888|NOTE-X|COMM-X|CB-X/;
const WARNING_RE = /⚠️|غير مسجل|not recorded/;
const ARABIC_RE = /[؀-ۿ]/;

// Each case: the listing, and the fragments that must appear per language (every captured field).
const CASES = {
  resale_cash: {
    l: {
      code: "APT-1", property_type: "apartment", listing_type: "sale", market: "resale", compound: "مدينتي", compound_en: "Madinaty",
      price_value: 8500000, area_value: 150, bedrooms: 3, bathrooms: 2, floor_level: 4, finishing: "fully_finished", is_ready: true,
      feature_keys: ["north_facing", "view_garden", "elevator"], features_other: ["جاكوزي"], confirmed_at: NOW.toISOString(), details: { ...INTERNAL }
    },
    ar: ["شقة للبيع في مدينتي", "8.5 مليون", "150م", "3 غرف", "حمامين", "الدور 4", "تشطيب كامل", "🔑 استلام فوري", "بحري", "فيو جاردن", "أسانسير", "جاكوزي"],
    en: ["Apartment for sale in Madinaty", "8.5M EGP", "150m²", "3 beds", "2 baths", "Floor 4", "Fully finished", "Ready to move", "North facing", "Garden view", "Elevator"],
    hint: "كاش"
  },
  resale_installments: {
    l: {
      code: "MV-7", property_type: "apartment", listing_type: "sale", market: "resale", compound: "ميفيدا", compound_en: "Mivida",
      price_value: 10000000, down_payment_value: 4000000, remaining_amount: 6000000, installment_value: 250000, payment_frequency: "quarterly",
      installments_end: "2032-10-01", area_value: 200, bedrooms: 3, feature_keys: ["corner", "nanny_room"], details: { over_price: 500000, ...INTERNAL }
    },
    ar: ["10 مليون", "المدفوع (كاش مطلوب): 4 مليون", "المتبقي أقساط: 6 مليون", "قسط ربع سنوي 250 ألف", "باقي 6 سنين", "الأوفر: 500 ألف", "ناصية", "غرفة مربية"],
    en: ["10M EGP", "Paid / cash required: 4M EGP", "Remaining installments: 6M EGP", "installment quarterly 250K EGP", "6 years left", "Over price: 500K EGP", "Corner unit", "Nanny room"],
    hint: "متبقي 6M"
  },
  primary: {
    l: {
      code: "ZED-3", property_type: "apartment", listing_type: "sale", market: "primary", compound: "زد", compound_en: "ZED", price_value: 11000000,
      area_value: 135, bedrooms: 2, delivery_year: 2028, delivery_quarter: 2,
      payment_terms: { plans: [{ plan_id: "p8", down_payment_pct: 10, years: 8, frequency: "quarterly" }], cash_price: 9000000 },
      maintenance_pct: 8, details: { project: "ZED West", developer: "Ora", ...INTERNAL }
    },
    ar: ["المشروع: ZED West", "المطور: Ora", "11 مليون", "سعر الكاش: 9 مليون", "مقدم 10% · 8 سنين", "الصيانة: 8%", "🗓 تسليم 2028 Q2", "غرفتين"],
    en: ["Project: ZED West", "Developer: Ora", "11M EGP", "Cash price: 9M EGP", "10% down · 8 years", "Maintenance: 8%", "Delivery 2028 Q2", "2 beds"],
    hint: "مقدم 10% · 8 سنين"
  },
  villa: {
    l: {
      code: "VIL-08", property_type: "townhouse", listing_type: "sale", compound: "فيليت", compound_en: "Villette", price_value: 19500000,
      area_value: 260, bedrooms: 3, bathrooms: 4, finishing: "semi_finished", details: { land_area: 310, garden_area: 120, ...INTERNAL },
      feature_keys: ["north_facing", "private_garden"]
    },
    ar: ["تاون هاوس للبيع في فيليت", "260م مباني", "الأرض 310م", "جنينة 120م", "3 غرف", "4 حمامات", "نصف تشطيب", "بحري", "جنينة خاصة"],
    en: ["Townhouse for sale in Villette", "260m² BUA", "Land 310m²", "Garden 120m²", "3 beds", "4 baths", "Semi-finished", "Private garden"],
    hint: "كاش",
    absent: [/الدور|Floor/]
  },
  studio: {
    l: { code: "STU-1", property_type: "studio", listing_type: "sale", compound: "الرحاب", compound_en: "Al Rehab", price_value: 1250000, area_value: 65, bedrooms: 0, bathrooms: 1, furnishing: "furnished", details: { ...INTERNAL } },
    ar: ["استوديو للبيع في الرحاب", "65م", "حمام واحد", "مفروشة"],
    en: ["Studio for sale in Al Rehab", "65m²", "1 bath", "Furnished"],
    hint: "كاش",
    absent: [/0 غرف|0 beds|غرفة واحدة/]
  },
  rent: {
    l: {
      code: "RNT-1", property_type: "apartment", listing_type: "rent", compound: "بيفرلي هيلز", compound_en: "Beverly Hills", price_value: 45000,
      area_value: 160, bedrooms: 3, furnishing: "furnished", feature_keys: ["appliances", "ac_installed"], details: { ...INTERNAL }
    },
    ar: ["شقة للإيجار في بيفرلي هيلز", "45 ألف ج.م شهرياً", "مفروشة", "بالأجهزة", "تكييفات"],
    en: ["Apartment for rent in Beverly Hills", "45K EGP / month", "Furnished", "With appliances", "ACs installed"],
    hint: null,
    absent: [/شهر.*شهرياً|month.*month/]
  },
  office: {
    l: { code: "OFF-1", property_type: "office", listing_type: "sale", compound: "مول العرب", district: "الشيخ زايد", price_value: 8750000, area_value: 60, bedrooms: 0, floor_level: 2, details: { ...INTERNAL } },
    ar: ["مكتب للبيع في مول العرب", "60م", "الدور 2"],
    en: ["Office for sale", "60m²", "Floor 2"],
    hint: "كاش",
    absent: [/استوديو|Studio|غرف|beds/]
  }
};

const surfaces = (l) => ({
  brokerAr: D.brokerCard(l, { lang: "ar" }),
  brokerEn: D.brokerCard(l, { lang: "en" }),
  clientAr: D.clientCopy(l, broker, { lang: "ar" }),
  clientEn: D.clientCopy(l, broker, { lang: "en" }),
  searchAr: D.searchResult(l, "ar"),
  searchEn: D.searchResult(l, "en"),
  flyer: JSON.stringify(D.flyerModel(l, { broker, lang: "en" })),
  plan: l.payment_terms?.plans?.length ? D.planCopy(l, broker, null, { lang: "ar" }) : null
});

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["setImmediate", "nextTick"] });
});
afterAll(() => jest.useRealTimers());

describe.each(Object.entries(CASES))("%s", (name, c) => {
  const s = () => surfaces(c.l);

  test("every captured field appears in the broker card and the client copy (ar)", () => {
    for (const frag of c.ar) {
      expect(s().brokerAr).toContain(frag);
      expect(s().clientAr).toContain(frag);
    }
  });

  test("every captured field appears in the English client copy, with no Arabic script", () => {
    for (const frag of c.en) expect(s().clientEn).toContain(frag);
    expect(s().clientEn.replace(/Mona/, "")).not.toMatch(ARABIC_RE);
    expect(s().searchEn).not.toMatch(ARABIC_RE);
  });

  test("nothing internal outside the broker card", () => {
    const x = s();
    expect(x.brokerAr).toMatch(INTERNAL_RE);
    for (const k of ["clientAr", "clientEn", "searchAr", "searchEn", "flyer", "plan"]) {
      if (x[k]) expect(x[k]).not.toMatch(INTERNAL_RE);
    }
  });

  test("no field warnings outside add/edit review", () => {
    const x = s();
    for (const v of Object.values(x)) if (v) expect(v).not.toMatch(WARNING_RE);
    const ev = R.evaluate(c.l, { photoCount: 0 });
    const review = D.reviewCard(c.l, { warnings: ev.warnings, blockers: ev.blockers });
    expect(review).toMatch(/⚠️ الصور غير مسجل/);
  });

  test("search result: compact line, payment hint, features line", () => {
    const [line1, line2] = s().searchAr.split("\n");
    expect(line1.startsWith(`\`${c.l.code}\``)).toBe(true);
    if (c.hint) expect(line1).toContain(c.hint);
    if ((c.l.feature_keys || []).length) expect(line2).toMatch(/✨/);
    else expect(line2).toBeUndefined();
  });

  test("things that must not appear", () => {
    for (const re of c.absent || []) {
      for (const v of [s().clientAr, s().clientEn, s().searchAr]) expect(v).not.toMatch(re);
    }
  });

  test("client copy snapshot (ar)", () => {
    expect(s().clientAr).toMatchSnapshot();
  });
});

test("features line is cut with +N", () => {
  const l = { code: "X", property_type: "apartment", feature_keys: ["north_facing", "corner", "nanny_room", "view_garden", "roof", "elevator"] };
  expect(D.featuresLine(l)).toBe("بحري · ناصية · غرفة مربية · فيو جاردن +2");
});

test("years left is computed when shown", () => {
  expect(D.yearsLeft({ installments_end: "2032-10-01" }, NOW)).toBe(6);
  expect(D.yearsLeft({ installments_end: "2027-04-01" }, NOW)).toBe(0.5);
});

test("the primary plan copy carries the plan, delivery and maintenance terms", () => {
  const p = surfaces(CASES.primary.l).plan;
  expect(p).toMatch(/نظام السداد: 8 سنين/);
  expect(p).toMatch(/المقدم \(10%\): 1,100,000 ج.م/);
  expect(p).toMatch(/القسط ربع سنوي: 309,375 ج.م × 32/);
  expect(p).toMatch(/الصيانة \(8%\): 880,000 ج.م \(عند الاستلام\)/);
  expect(p).toMatch(/🗓 تسليم 2028 Q2/);
});
