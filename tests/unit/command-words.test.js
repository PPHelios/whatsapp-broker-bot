// tests/unit/command-words.test.js — F4: bot command words in any common Arabic spelling
"use strict";

const { canonicalCommand, arabicKey } = require("../../domain/commandWords");

describe("command spelling", () => {
  test("ة/ه, hamza forms, ى/ي and extra spaces don't matter for the command word", () => {
    expect(canonicalCommand("اضافه")).toBe("اضافة");
    expect(canonicalCommand("الغاء")).toBe("إلغاء");
    expect(canonicalCommand("مساعده")).toBe("مساعدة");
    expect(canonicalCommand("اسال  مواعيد النهارده")).toBe("اسأل  مواعيد النهارده");
    expect(canonicalCommand("تحديث  مشروع زيادة 5%")).toBe("تحديث مشروع زيادة 5%");
    expect(arabicKey("إضافـة")).toBe(arabicKey("اضافه"));
  });
  test("only a leading command word is touched", () => {
    expect(canonicalCommand("عميله عايزه شقه")).toBe("عميله عايزه شقه");
    expect(canonicalCommand("شقة في التجمع اضافه")).toBe("شقة في التجمع اضافه");
    expect(canonicalCommand("add")).toBe("add");
    expect(canonicalCommand("ليد: احمد 010")).toBe("ليد: احمد 010");
  });
});
