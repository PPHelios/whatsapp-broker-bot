// tests/unit/chat-match.test.js — Which photos of a WhatsApp chat export belong to which unit (domain/chatMatch.js, pure)
"use strict";

const { match, codeFinder, normCode } = require("../../domain/chatMatch");
const Parse = require("../../domain/chatParse");

const T = (hh, mm) => `24/10/2026, ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
const photo = (n, who = "Ahmed", at = T(10, 14)) => `${at} - ${who}: IMG-${n}.jpg (file attached)`;
const say = (text, who = "Ahmed", at = T(10, 15)) => `${at} - ${who}: ${text}`;
const post = (code, extra = "") => `شقة ${code} للبيع 200 متر 3 غرف السعر 12 مليون ${extra}`.trim();
const CODES = Array.from({ length: 30 }, (_, i) => `NH-V${i + 1}`);
const names = (u) => u.files.map((f) => f.name);
const unit = (r, code) => (r.units || []).find((u) => u.code === code);

describe("a forwarded batch: many units sent in the same minute", () => {
  test("photos first, then text: order decides, a whole run goes to its own unit", () => {
    const lines = [];
    for (let k = 1; k <= 20; k++) lines.push(photo(`${k}a`), photo(`${k}b`), say(post(`NH-V${k}`)));
    const r = match(lines.join("\n"), { codes: CODES });
    expect(r.pattern).toBe("photos_first");
    expect(r.tray).toEqual([]);
    for (let k = 1; k <= 20; k++) expect(names(unit(r, `NH-V${k}`))).toEqual([`IMG-${k}a.jpg`, `IMG-${k}b.jpg`]);
  });

  test("text first, then photos: the last photos of a unit are not taken by the next unit", () => {
    const lines = [];
    for (let k = 1; k <= 10; k++) {
      lines.push(say(post(`NH-V${k}`)));
      for (let n = 1; n <= 4; n++) lines.push(photo(`${k}-${n}`));
    }
    const r = match(lines.join("\n"), { codes: CODES });
    expect(r.pattern).toBe("text_first");
    expect(r.tray).toEqual([]);
    for (let k = 1; k <= 10; k++) expect(names(unit(r, `NH-V${k}`))).toEqual([1, 2, 3, 4].map((n) => `IMG-${k}-${n}.jpg`));
  });

  test("a run between two descriptions with no clue is not guessed: tray, with both units as candidates", () => {
    const text = [say(post("NH-V1")), photo("x"), say(post("NH-V2"))].join("\n");
    const r = match(text, { codes: CODES });
    expect(r.detected).toBe("unknown");
    expect(r.tray).toHaveLength(1);
    expect(r.tray[0].reason).toBe("ambiguous");
    expect(r.tray[0].candidates).toEqual([{ codes: ["NH-V1"] }, { codes: ["NH-V2"] }]);
    // The person chooses the order and the run is placed.
    expect(names(unit(match(text, { codes: CODES, pattern: "text_first" }), "NH-V1"))).toEqual(["IMG-x.jpg"]);
    expect(names(unit(match(text, { codes: CODES, pattern: "photos_first" }), "NH-V2"))).toEqual(["IMG-x.jpg"]);
  });

  test("a chat that mixes both orders is reported as mixed; single-neighbour runs are still placed", () => {
    const text = [
      photo("a", "Ahmed", T(9, 0)), say(post("NH-V1"), "Ahmed", T(9, 1)),
      say(post("NH-V2"), "Ahmed", T(11, 0)), photo("b", "Ahmed", T(11, 1))
    ].join("\n");
    const r = match(text, { codes: CODES });
    expect(r.pattern).toBe("mixed");
    expect(names(unit(r, "NH-V1"))).toEqual(["IMG-a.jpg"]);
    expect(names(unit(r, "NH-V2"))).toEqual(["IMG-b.jpg"]);
  });

  test("a forced order that the chat contradicts sends the run to the tray, never to the wrong unit", () => {
    const text = [photo("a"), say(post("NH-V1")), photo("tail")].join("\n");
    const r = match(text, { codes: CODES, pattern: "photos_first" });
    expect(names(unit(r, "NH-V1"))).toEqual(["IMG-a.jpg"]);
    expect(r.tray.map((g) => g.reason)).toEqual(["against_pattern"]);
  });
});

describe("edge cases", () => {
  test("a description with no photos: the unit is listed as having none; the chat's other units are untouched", () => {
    const r = match([photo("1"), say(post("NH-V1")), say(post("NH-V2"), "Ahmed", T(10, 40))].join("\n"), { codes: CODES.slice(0, 3) });
    expect(unit(r, "NH-V2").files).toEqual([]);
    expect(r.noPhotos).toEqual(expect.arrayContaining(["NH-V2", "NH-V3"]));
    expect(r.noPhotos).not.toContain("NH-V1");
  });

  test("photos with no description at all, or sent by somebody else, go to the tray as orphans", () => {
    const r = match([photo("1", "Sara"), say(post("NH-V1")), photo("2", "Ahmed", T(10, 14))].join("\n"), { codes: CODES });
    expect(r.tray.map((g) => [g.reason, g.sender, g.files[0].name])).toEqual([["orphan", "Sara", "IMG-1.jpg"]]);
    // "Ignore who sent it" places the run by position and time instead.
    expect(names(unit(match([photo("1", "Sara"), say(post("NH-V1"))].join("\n"), { codes: CODES, sameSender: false }), "NH-V1"))).toEqual(["IMG-1.jpg"]);
  });

  test("photos far from the description (more than the window) are not pulled in", () => {
    const text = [photo("old", "Ahmed", T(8, 0)), say(post("NH-V1"), "Ahmed", T(10, 15))].join("\n");
    expect(match(text, { codes: CODES }).tray[0].reason).toBe("orphan");
    expect(names(unit(match(text, { codes: CODES, windowMin: 180 }), "NH-V1"))).toEqual(["IMG-old.jpg"]);
  });

  test("a caption with the code under its own photo wins; a description with several codes places nothing by itself", () => {
    const caption = [`${T(10, 14)} - Ahmed: IMG-c.jpg (file attached)`, `NH-V3 المطبخ`].join("\n");
    expect(names(unit(match(caption, { codes: CODES }), "NH-V3"))).toEqual(["IMG-c.jpg"]);
    const many = [photo("m"), say("NH-V1 و NH-V2 للبيع")].join("\n");
    const r = match(many, { codes: CODES });
    expect(r.tray[0].reason).toBe("multi_code");
    expect(r.tray[0].candidates).toEqual([{ codes: ["NH-V1", "NH-V2"] }]);
  });

  test("the same code in several messages merges its photos once; at most 15 a unit, the rest counted", () => {
    const lines = [];
    for (let n = 1; n <= 12; n++) lines.push(photo(`a${n}`));
    lines.push(say(post("NH-V5")));
    for (let n = 1; n <= 8; n++) lines.push(photo(`b${n}`, "Ahmed", T(14, 0)));
    lines.push(say(post("nh v5 تاني"), "Ahmed", T(14, 1)));
    const u = unit(match(lines.join("\n"), { codes: CODES }), "NH-V5");
    expect(u.messages).toBe(2);
    expect(u.files).toHaveLength(15);
    expect(u.over).toBe(5);
    expect(new Set(names(u)).size).toBe(15);
  });

  test("codes are found with spaces, dashes, case and Arabic digits; a bare number only after «كود»", () => {
    const find = codeFinder(["NH-V12", "A-101", "1001"]);
    expect(find("شقة nh v 12 للبيع")).toEqual(["NH-V12"]);
    expect(find("الكود NH–V١٢")).toEqual(["NH-V12"]); // en dash and Arabic digits
    expect(find("a 101 ممتاز")).toEqual(["A-101"]);
    expect(find("السعر 1001 جنيه")).toEqual([]);
    expect(find("كود 1001")).toEqual(["1001"]);
    expect(find("NH-V123")).toEqual([]);
    expect(normCode("nh v-١٢")).toBe("NHV12");
  });

  test("a code that is not in the app is listed with the close one; choosing it (alias) matches it", () => {
    const text = [photo("1"), say("شقة NH-V13 للبيع 200 متر 3 غرف السعر 12 مليون")].join("\n");
    const r = match(text, { codes: ["NH-V12", "NH-V99"] });
    expect(r.units).toEqual([]);
    expect(r.unknownCodes).toEqual([expect.objectContaining({ token: "NH-V13", suggestions: ["NH-V12"] })]);
    const again = match(text, { codes: ["NH-V12", "NH-V99"], aliases: { [normCode("NH-V13")]: "NH-V12" } });
    expect(names(unit(again, "NH-V12"))).toEqual(["IMG-1.jpg"]);
  });

  test("the start date drops old messages and their photos; videos, stickers and omitted media are counted", () => {
    const text = [
      `01/01/2026, 09:00 - Ahmed: IMG-old.jpg (file attached)`,
      `01/01/2026, 09:01 - Ahmed: ${post("NH-V1")}`,
      `${T(10, 0)} - Ahmed: VID-1.mp4 (file attached)`,
      `${T(10, 1)} - Ahmed: <Media omitted>`,
      photo("new", "Ahmed", T(10, 2)),
      say(post("NH-V2"), "Ahmed", T(10, 3))
    ].join("\n");
    const r = match(text, { codes: CODES, since: "2026-10-01" });
    expect(r.units.map((u) => u.code)).toEqual(["NH-V2"]);
    expect(names(r.units[0])).toEqual(["IMG-new.jpg"]);
    expect(r.stats).toMatchObject({ skippedMedia: 1, omittedMedia: 1 });
  });

  test("iOS exports: the time is read from the line, Arabic AM/PM included", () => {
    const text = [
      "[24/10/2026, 10:14:02 م] Ahmed: <attached: 00000012-PHOTO-2026-10-24-22-14-02.jpg>",
      `[24/10/2026, 10:15:32 م] Ahmed: ${post("NH-V1")}`,
      "[24/10/2026, 11:40:00 م] Ahmed: <attached: 00000013-PHOTO-2026-10-24-23-40-00.jpg>"
    ].join("\n");
    const r = match(text, { codes: CODES });
    expect(names(unit(r, "NH-V1"))).toEqual(["00000012-PHOTO-2026-10-24-22-14-02.jpg"]);
    expect(r.tray).toHaveLength(1); // 85 minutes later
    expect(Parse.atMs("24/10/2026 10:15 م")).toBe(Date.UTC(2026, 9, 24, 22, 15));
  });
});

describe("no codes: the posts that look like units", () => {
  const listing = (name, extra = "") => `فيلا في ${name} 300 متر 4 غرف السعر 25 مليون ${extra}`;

  test("photos follow their post; repeated posts and chatter are not posts; the cap is 40", () => {
    const lines = [photo("1"), photo("2"), say(listing("هايد بارك")), say(listing("هايد بارك")), say("تمام شكرا"), say(listing("ميفيدا"), "Ahmed", T(11, 0)), photo("3", "Ahmed", T(11, 1))];
    const r = match(lines.join("\n"));
    expect(r.mode).toBe("posts");
    expect(r.posts.map((p) => p.files.map((f) => f.name))).toEqual([["IMG-1.jpg", "IMG-2.jpg"], ["IMG-3.jpg"]]);
    expect(r.stats.duplicates).toBe(1);

    const many = Array.from({ length: 45 }, (_, k) => say(listing(`مشروع ${k}`), "Ahmed", T(10, k % 60))).join("\n");
    const big = match(many);
    expect(big.posts).toHaveLength(40);
    expect(big.stats.truncated).toBe(5);
  });
});
