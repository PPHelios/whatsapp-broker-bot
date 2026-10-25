// tests/unit/phone.test.js — domain/phone.js: the one phone rule (P1)
"use strict";

const P = require("../../domain/phone");
const U = require("../../lib/util");
const O = require("../../lib/onboarding");

describe("normalizePhone", () => {
  const cases = [
    // Egyptian mobiles in every spelling
    ["01012345678", "201012345678"],
    ["0101 234 5678", "201012345678"],
    ["010-1234-5678", "201012345678"],
    ["(010) 1234 5678", "201012345678"],
    ["+20 101 234 5678", "201012345678"],
    ["+201012345678", "201012345678"],
    ["00201012345678", "201012345678"],
    ["201012345678", "201012345678"],
    ["1012345678", "201012345678"],
    ["+20 0101 234 5678", "201012345678"],
    ["٠١٠١٢٣٤٥٦٧٨", "201012345678"],
    ["۰۱۱۱۲۳۴۵۶۷۸", "201112345678"],
    ["+٢٠١٢٢٣٤٥٦٧٨٩", "201223456789"],
    ["01512345678", "201512345678"],
    ["201012345678@s.whatsapp.net", "201012345678"],
    ["‎+20 100 000 0000", "201000000000"],
    // Landlines
    ["0221234567", "20221234567"],
    ["02 2123 4567", "20221234567"],
    ["0403123456", "20403123456"],
    ["+20 2 2123 4567", "20221234567"],
    // Foreign numbers
    ["+966 51 234 5678", "966512345678"],
    ["00971501234567", "971501234567"],
    ["+44 20 7946 0958", "442079460958"],
    ["966512345678", "966512345678"],
    // Junk
    ["", null],
    [null, null],
    ["hello", null],
    ["0101234", null],
    ["12345", null],
    ["01312345678", null],
    ["+20 999", null],
    ["VIL-08", null],
    ["3 غرف", null],
    ["+1234567890123456", null]
  ];
  test.each(cases)("%p → %p", (input, expected) => {
    expect(P.normalizePhone(input)).toBe(expected);
  });
});

describe("kinds, display and links", () => {
  test("mobile / landline / foreign", () => {
    expect(P.isEgyptMobile("201012345678")).toBe(true);
    expect(P.isEgyptMobile("20221234567")).toBe(false);
    expect(P.isLandline("20221234567")).toBe(true);
    expect(P.isLandline("201012345678")).toBe(false);
    expect(P.isForeign("966512345678")).toBe(true);
    expect(P.isForeign("201012345678")).toBe(false);
  });

  test("displayPhone", () => {
    expect(P.displayPhone("+201012345678")).toBe("0101 234 5678");
    expect(P.displayPhone("0221234567")).toBe("02 2123 4567");
    expect(P.displayPhone("0403123456")).toBe("040 3123456");
    expect(P.displayPhone("966512345678")).toBe("+966512345678");
    expect(P.displayPhone("junk")).toBe("junk");
  });

  test("waMeUrl, telUrl, toE164, last4", () => {
    expect(P.waMeUrl("01012345678")).toBe("https://wa.me/201012345678");
    expect(P.waMeUrl("01012345678", "أهلاً أحمد")).toBe(`https://wa.me/201012345678?text=${encodeURIComponent("أهلاً أحمد")}`);
    expect(P.waMeUrl("0221234567")).toBeNull();
    expect(P.waMeUrl("nope")).toBeNull();
    expect(P.telUrl("01012345678")).toBe("tel:+201012345678");
    expect(P.toE164("٠١٠١٢٣٤٥٦٧٨")).toBe("+201012345678");
    expect(P.last4("0101 234 5678")).toBe("5678");
  });
});

describe("existing callers delegate and keep their results", () => {
  test("WhatsApp ids (broker lookups) are unchanged", () => {
    for (const id of ["201012345678", "966512345678", "447911123456", "201012345678@s.whatsapp.net"]) {
      expect(U.normalizePhone(id)).toBe(id.replace(/@.*$/, ""));
    }
    expect(U.normalizePhone("")).toBe("");
    expect(U.normalizePhone(null)).toBe("");
    // Not a phone: the old digits-only fallback.
    expect(U.normalizePhone("12345")).toBe("12345");
  });

  test("onboarding accepts mobiles only", () => {
    expect(O.normalizeEgyptMobile("0101 234 5678")).toBe("201012345678");
    expect(O.normalizeEgyptMobile("0221234567")).toBeNull();
    expect(O.normalizeEgyptMobile("+966512345678")).toBeNull();
  });
});
