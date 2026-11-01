// tests/router/search.test.js — Release 1 step 5: one search for text and voice, bilingual parity, paging
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf, FALLBACK_AR } = require("../harness/app");
const Search = require("../../services/search");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const codesIn = (text) => [...String(text).matchAll(/`([A-Z0-9-]+)`/g)].map((m) => m[1]);
const aiDown = () => h.AI.respond(() => new Error("503 UNAVAILABLE"));

async function seedInventory() {
  const at = (min) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
  await h.insertListing({ code: "MV-3A", compound: "ماونتن فيو آي سيتي", bedrooms: 3, area_value: 160, price_value: 9e6, district: "التجمع الخامس", feature_keys: ["north_facing"], confirmed_at: at(1) });
  await h.insertListing({ code: "MV-3B", compound: "Mountain View iCity", bedrooms: 3, area_value: 175, price_value: 9.8e6, feature_keys: ["corner", "north_facing"], confirmed_at: at(2) });
  await h.insertListing({ code: "MV-2", compound: "ماونتن فيو آي سيتي", bedrooms: 2, area_value: 120, price_value: 6e6, confirmed_at: at(3) });
  await h.insertListing({ code: "HP-3", compound: "Hyde Park", bedrooms: 3, area_value: 150, price_value: 8.5e6, is_ready: true, confirmed_at: at(4) });
  await h.insertListing({ code: "VIL-08", compound: "بالم هيلز أكتوبر", property_type: "villa", bedrooms: 4, area_value: 300, price_value: 2e7, feature_keys: ["north_facing", "corner"], confirmed_at: at(5) });
  await h.insertListing({ code: "STU-1", compound: "الرحاب", property_type: "studio", bedrooms: 0, area_value: 60, price_value: 2e6, confirmed_at: at(6) });
  await h.insertListing({ code: "MV-SOLD", compound: "ماونتن فيو آي سيتي", bedrooms: 3, status: "sold", confirmed_at: at(7) });
  await h.insertListing({ code: "B-MV", compound: "Mountain View iCity", bedrooms: 3, agency_id: h.AGENCY_B, broker_id: h.BROKERS.rival.id });
}

describe("Text and voice give the same units in the same order (plan verification #2)", () => {
  test("'Mountain View 3 bedrooms' typed vs 'ماونتن فيو ٣ غرف' spoken", async () => {
    await seedInventory();
    h.AI.respond((c) =>
      c.operation === "search_parse"
        ? { intent: "search", language: "en", filters: { compound: "Mountain View", bedrooms_min: 3, bedrooms_max: 3 } }
        : null
    );
    const typed = codesIn(textOf(await h.text("broker", "Mountain View 3 bedrooms")));

    h.AI.respond((c) => {
      if (c.operation === "transcribe") return "ماونتن فيو ٣ غرف";
      return { intent: "search", language: "ar", filters: { compound: "ماونتن فيو", bedrooms_min: 3, bedrooms_max: 3 } };
    });
    const spoken = await h.voice("broker");
    expect(spoken.filter((r) => r.type !== "reaction")).toHaveLength(1); // one message per task
    const voiced = codesIn(textOf(spoken));

    expect(typed).toEqual(["MV-3B", "MV-3A"]);
    expect(voiced).toEqual(typed);
  });

  test("the same holds with the AI down (local parser)", async () => {
    await seedInventory();
    aiDown();
    const typed = codesIn(textOf(await h.text("broker", "Mountain View 3 bedrooms")));
    h.AI.respond((c) => (c.operation === "transcribe" ? "ماونتن فيو ٣ غرف" : new Error("503")));
    const voiced = codesIn(textOf(await h.voice("broker")));
    expect(typed).toEqual(["MV-3B", "MV-3A"]);
    expect(voiced).toEqual(typed);
  });
});

describe("Arabic, English and mixed requests return identical id lists", () => {
  const PAIRS = [
    ["شقة 3 غرف في التجمع", "apartment 3 bedrooms in new cairo", "شقة 3 bedrooms في New Cairo"],
    ["فيلا بحري ناصية في أكتوبر", "villa north facing corner in october", "villa بحري corner in أكتوبر"],
    ["استوديو في الرحاب", "studio in Al Rehab", "studio في الرحاب"],
    ["شقة استلام فوري تحت 10 مليون", "apartment ready to move under 10 million", "apartment استلام فوري under 10 million"],
    ["هايد بارك", "Hyde Park", "hydepark"]
  ];

  test.each(PAIRS)("%s | %s | %s", async (...queries) => {
    await seedInventory();
    const results = [];
    for (const q of queries) {
      const r = await Search.search({ pool: h.pool, AI: { generateWithCascade: async () => { throw new Error("down"); } }, agencyId: h.AGENCY_A, text: q });
      results.push(r.ids);
    }
    expect(results[0].length).toBeGreaterThan(0);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  test("AI answers in either language normalize to the same filters", async () => {
    const Q = require("../../domain/searchQuery");
    const ar = Q.normalizeAiSearch({ filters: { compound: "ماونتن فيو", locations: ["التجمع"], features: ["بحري", "ناصية"], property_types: ["apartment"] } });
    const en = Q.normalizeAiSearch({ filters: { compound: "Mountain View", locations: ["New Cairo"], features: ["north_facing", "corner"], property_types: ["Apartment"] } });
    expect(en.filters).toEqual(ar.filters);
  });
});

describe("Relaxed pass, then 'more' from an id snapshot (B1)", () => {
  async function sevenAt9M() {
    for (let i = 1; i <= 7; i++) {
      await h.insertListing({ code: `R-${i}`, compound: "Hyde Park", price_value: 9e6, confirmed_at: new Date(Date.UTC(2026, 9, i)).toISOString() });
    }
  }

  test("nothing under 8M strictly → close alternatives, 5 + more → 2 → end", async () => {
    await sevenAt9M();
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Hyde Park", price_max: 8e6 } }));
    const first = await h.text("broker", "هايد بارك تحت 8 مليون");
    expect(textOf(first)).toMatch(/أقرب النتائج/);
    expect(codesIn(textOf(first))).toEqual(["R-7", "R-6", "R-5", "R-4", "R-3"]);
    expect(first[0].buttons.map((b) => b.id)).toEqual(["MORE_SEARCH"]);

    const second = await h.tap("broker", "MORE_SEARCH");
    expect(codesIn(textOf(second))).toEqual(["R-2", "R-1"]);
    expect(second[0].type).toBe("text"); // no more button at the end
    expect(textOf(second)).toMatch(/^6\. /m); // numbering continues

    expect(textOf(await h.text("broker", "المزيد"))).toMatch(/دي كل الوحدات/);
  });

  test("new or sold inventory between pages neither repeats nor shifts results", async () => {
    await sevenAt9M();
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Hyde Park" } }));
    const first = codesIn(textOf(await h.text("broker", "هايد بارك")));
    await h.insertListing({ code: "R-NEW", compound: "Hyde Park", price_value: 9e6, confirmed_at: new Date().toISOString() });
    await h.query("UPDATE listings SET status = 'sold' WHERE code = 'R-2'");
    const second = codesIn(textOf(await h.tap("broker", "MORE_SEARCH")));
    expect(first).toEqual(["R-7", "R-6", "R-5", "R-4", "R-3"]);
    expect(second).toEqual(["R-1"]);
  });

  test("'المزيد' typed inside an open draft pages the search instead of joining the draft (B4)", async () => {
    await sevenAt9M();
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Hyde Park" } }));
    await h.text("broker", "هايد بارك");
    await h.text("broker", "اضافة");
    const more = await h.text("broker", "المزيد");
    expect(codesIn(textOf(more))).toEqual(["R-2", "R-1"]);
    expect((await h.session("broker")).text_notes).toEqual([]);
  });
});

describe("Filters", () => {
  test("features, delivery and payment are language-neutral filters", async () => {
    await seedInventory();
    await h.insertListing({ code: "RS-1", compound: "Hyde Park", remaining_amount: 5e6, down_payment_value: 3e6, installment_value: 200000, price_value: 8e6 });
    const ids = async (filters, msg = "x") => {
      h.AI.respond(() => ({ intent: "search", filters }));
      return codesIn(textOf(await h.text("broker", msg)));
    };
    expect(await ids({ features: ["north_facing", "corner"] })).toEqual(["VIL-08", "MV-3B"]);
    expect(await ids({ delivery: { ready: true } })).toEqual(["HP-3"]);
    expect(await ids({ compound: "Hyde Park", payment: { installments: true } }, "hyde park installment")).toEqual(["RS-1"]);
    // The installment cap counts only when the message says installment or قسط (Haytham, 2026-11-01).
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Hyde Park", payment: { max_installment: 250000 } } }));
    expect(codesIn(textOf(await h.text("broker", "hyde park قسط 250 ألف")))).toEqual(["RS-1"]);
    expect(await ids({ compound: "Hyde Park", payment: { cash: true } })).toEqual(["HP-3"]);
  });

  test("sold units never appear; another agency's units never appear", async () => {
    await seedInventory();
    h.AI.respond(() => ({ intent: "search", filters: { compound: "Mountain View" } }));
    const mine = codesIn(textOf(await h.text("broker", "mountain view")));
    expect(mine).not.toContain("MV-SOLD");
    expect(mine).not.toContain("B-MV");
    const theirs = codesIn(textOf(await h.text("rival", "mountain view")));
    expect(theirs).toEqual(["B-MV"]);
  });

  test("a code in any case finds the unit (B6); the lookup uses code_norm (B7)", async () => {
    await seedInventory();
    h.AI.respond(() => ({ intent: "search", filters: { code: "vil-08" } }));
    expect(codesIn(textOf(await h.text("broker", "عايز vil-08")))).toEqual(["VIL-08"]);
    expect(textOf(await h.text("broker", "#vil-٠٨"))).toMatch(/VIL-08/);
    const { sql } = Search.buildSearchQuery(h.AGENCY_A, { filters: { code: "VIL-08" } });
    expect(sql).toMatch(/l\.code_norm = \$2/);
  });

  test("an English-named compound is found by its Arabic name and vice versa", async () => {
    await seedInventory();
    aiDown();
    expect(codesIn(textOf(await h.text("broker", "هايد بارك")))).toEqual(["HP-3"]);
    expect(codesIn(textOf(await h.text("broker", "palm hills october")))).toEqual(["VIL-08"]);
  });
});

describe("Intent guard (B2)", () => {
  test("small talk with the AI down does not search either", async () => {
    await seedInventory();
    aiDown();
    const out = textOf(await h.text("broker", "شكرا"));
    expect(codesIn(out)).toEqual([]);
    expect(out).toMatch(/ابعت مواصفات/);
    expect(out).not.toMatch(FALLBACK_AR);
  });

  test("a described unit (intent listing) points to 'اضافة'", async () => {
    h.AI.respond(() => ({ intent: "listing", filters: { property_types: ["apartment"] } }));
    expect(textOf(await h.text("broker", "عندي شقة للبيع 150 متر"))).toMatch(/إضافة/);
  });
});

describe("Search document (one trigger, one normalizer)", () => {
  test("JS and SQL normalizers agree", async () => {
    const { normalizeSearch } = require("../../domain/searchText");
    const samples = ["ماونتن فيو آي سيتي", "غرفةٌ مربيّة", "Hyde-Park, 5th!", "٣ غرف", "۴ حمام", "الإسكندرية/ مؤمن ـ شيء", "  مسافات   كثيرة "];
    for (const s of samples) {
      const [r] = await h.query("SELECT normalize_search($1) AS n, clean_arabic_text($1) AS c, normalize_arabic($1) AS a", [s]);
      expect(r.n).toBe(normalizeSearch(s));
      expect(r.c).toBe(r.n);
      expect(r.a).toBe(r.n);
    }
  });

  test("the document carries both languages for places, type and features", async () => {
    const l = await h.insertListing({ code: "DOC-1", compound: "ماونتن فيو آي سيتي", feature_keys: ["corner"], features_other: ["جاكوزي"] });
    const [r] = await h.query("SELECT search_text_normalized s, compound_key, developer_key, area_key FROM listings WHERE id = $1", [l.id]);
    expect(r).toMatchObject({ compound_key: "mv_icity", developer_key: "mountain_view", area_key: "new_cairo" });
    for (const w of ["mountain view", "icity", "new cairo", "التجمع", "apartment", "شقه", "corner", "ناصيه", "جاكوزي", "doc-1"]) {
      expect(r.s).toContain(w);
    }
  });

  test("the vocabulary in the database matches the domain dictionaries", async () => {
    const { vocabularyRows } = require("../../domain/vocabulary");
    const Places = require("../../domain/places");
    const vocab = await h.query("SELECT kind, key, terms FROM search_vocabulary ORDER BY kind, key");
    expect(vocab).toEqual([...vocabularyRows()].sort((a, b) => (a.kind + a.key).localeCompare(b.kind + b.key)));
    const [{ n }] = await h.query("SELECT count(*) AS n FROM compound_synonyms");
    expect(n).toBe(new Set(Places.synonymRows().map((r) => `${r.kind}|${r.key}|${r.synonym}`)).size);
  });
});
