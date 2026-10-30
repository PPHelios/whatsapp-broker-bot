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

describe("F15 the owner's words", () => {
  const { helpText, markdown, COMMANDS } = require("../../domain/commandWords");
  test("new words reach the matchers' spelling; code commands only before a code", () => {
    expect(canonicalCommand("بيع NH-V12")).toBe("تم البيع NH-V12");
    expect(canonicalCommand("بيع شقة في التجمع")).toBe("بيع شقة في التجمع");
    expect(canonicalCommand("ارشيف NH-V12")).toBe("ارشفة NH-V12");
    expect(canonicalCommand("فلاير NH-V12")).toBe("flyer NH-V12");
    expect(canonicalCommand("فلاير بروكر NH-V12")).toBe("unbranded NH-V12");
    expect(canonicalCommand("Broker Flyer NH-V12")).toBe("unbranded NH-V12");
    expect(canonicalCommand("انظمه NH-V12")).toBe("انظمة السداد NH-V12");
    expect(canonicalCommand("عطل: البحث واقف")).toBe("بلاغ: البحث واقف");
    expect(canonicalCommand("عربى")).toBe("العربية");
    expect(canonicalCommand("English")).toBe("lang en");
    expect(canonicalCommand("اكسيل")).toBe("اكسيل");
    expect(canonicalCommand("إكسيل،")).toBe("اكسيل،");
    expect(canonicalCommand("add")).toBe("add");
  });
  test("help and docs list every word", () => {
    const words = COMMANDS.flatMap((c) => [...c.ar, ...c.en]);
    for (const w of words) {
      expect(helpText("ar")).toContain(`*${w}*`);
      expect(helpText("en")).toContain(`*${w}*`);
    }
    expect(require("fs").readFileSync(require("path").join(__dirname, "../../docs/commands.md"), "utf8")).toBe(`${markdown()}\n`);
  });
});
