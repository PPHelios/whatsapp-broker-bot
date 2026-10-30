// tests/unit/lead-update.test.js — The voice CRM update's pure parts (Release 3 step 9): which messages describe an
// outcome, references and names in the text (Arabic letter forms folded), the AI answer normalized, the checks
// (a future time, a unit found) and the summary lines in both languages.
"use strict";

const U = require("../../domain/leadUpdate");
const Stages = require("../../domain/leadStages");

test("outcomes are recognized in Egyptian Arabic and English; searches and commands are not", () => {
  for (const s of ["كلمت أحمد، عايز يعاين VIL-08 الجمعة الساعة ٥", "سارة مردش", "اتكلمت مع منى ومش مهتمة", "Called Ahmed, he wants to view VIL-08 Friday at 5", "Sara no answer, call back tomorrow", "L-0042 اشترى"]) {
    expect(U.looksLikeUpdate(s)).toBe(true);
  }
  for (const s of ["عايز شقة في التجمع 3 غرف", "سعر VIL-08 9 مليون", "L-0042", "اتباعت VIL-08", "villa in zayed under 20m", "متابعات"]) {
    expect(U.looksLikeUpdate(s)).toBe(false);
  }
});

test("an L- reference anywhere in the text", () => {
  expect(U.refIn("L-0042 كلمته")).toBe(42);
  expect(U.refIn("كلمت l-7 النهارده")).toBe(7);
  expect(U.refIn("VIL-08 الجمعة")).toBeNull();
});

test("names in the text match leads with Arabic letter forms folded; the whole name ranks first", () => {
  const leads = [{ id: 1, name: "أحمد سمير" }, { id: 2, name: "احمد علي" }, { id: 3, name: "مروة" }, { id: 4, name: null }];
  expect(U.namesIn("كلمت احمد", leads).map((l) => l.id)).toEqual([1, 2]);
  expect(U.namesIn("كلمت احمد علي", leads).map((l) => l.id)).toEqual([2, 1]);
  expect(U.namesIn("مروه مردتش", leads).map((l) => l.id)).toEqual([3]);
  expect(U.matchName("أحمد علي", leads).map((l) => l.id)).toEqual([2]);
  expect(U.matchName("أحمد", leads).map((l) => l.id)).toEqual([1, 2]);
  expect(U.matchName("كريم", leads)).toEqual([]);
});

test("the AI answer is normalized; nothing is invented", () => {
  expect(U.normalizeUpdate({ lead_name: "أحمد", contacted: true, stage: "viewing", follow_up: { date: "2026-10-30", time: "5:00", kind: "viewing", unit_code: "vil-08" }, note: " عايز دور أرضي " })).toEqual({
    leadName: "أحمد",
    contacted: true,
    stage: "viewing",
    lostReason: null,
    followUp: { date: "2026-10-30", time: "05:00", kind: "viewing", unitCode: "VIL-08" },
    note: "عايز دور أرضي"
  });
  expect(U.normalizeUpdate({ contacted: "yes", stage: "new", follow_up: { date: "Friday" }, note: "null" })).toEqual({ leadName: null, contacted: false, stage: null, lostReason: null, followUp: null, note: null });
});

test("checks: something must change, the time must be ahead, a named unit must exist; a date alone means 10:00", () => {
  const now = new Date("2026-10-25T08:00:00Z");
  const base = { contacted: false, stage: null, followUp: null, note: null };
  expect(U.checkUpdate(base, { now })).toBe("nothing");
  expect(U.checkUpdate({ ...base, followUp: { date: "2026-10-24", time: "17:00", kind: "call" } }, { now })).toBe("follow_up_past");
  expect(U.checkUpdate({ ...base, followUp: { date: "2026-10-30", time: null, kind: "viewing", unitCode: "X-1" } }, { now })).toBe("unit_not_found");
  expect(U.checkUpdate({ ...base, followUp: { date: "2026-10-30", time: null, kind: "viewing", unitCode: "X-1" } }, { now, unit: { id: 1 } })).toBeNull();
  expect(U.followUpAt({ date: "2026-10-30", time: null }).toISOString()).toBe(Stages.fromCairoLocal("2026-10-30T10:00").toISOString());
});

test("today in Cairo goes into the prompt, with the fence", () => {
  expect(U.cairoToday(new Date("2026-10-25T22:30:00Z"))).toEqual({ date: "2026-10-26", weekday: "Monday", time: "01:30" });
  const p = U.buildUpdatePrompt("ar", "F00D", { now: new Date("2026-10-25T08:00:00Z"), focusName: "Sara" });
  expect(p).toContain("Today in Cairo is Sunday 2026-10-25, 11:00");
  expect(p).toContain("===F00D===");
  expect(p).toContain('"Sara"');
});

test("summary lines in both languages", () => {
  const u = { contacted: true, stage: "lost", lostReason: "Price", followUp: null, note: "x" };
  const lead = { ref: 3, name: "Sara", stage: "contacted" };
  expect(U.summaryLines(u, lead, "en")).toBe("👤 Sara · L-0003 · not contacted yet\n📞 Contacted\n🔄 📞 Contacted → ❌ Lost (Price)\n📝 x");
  expect(U.summaryLines(u, lead, "ar")).toContain("❌ ضاعت (Price)");
});
