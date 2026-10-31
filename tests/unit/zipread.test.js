// tests/unit/zipread.test.js — The browser zip reader (web/static/zipread.js) on zips made by the same tool WhatsApp users get from phones
"use strict";

const JSZip = require("jszip");
const ZipRead = require("../../web/static/zipread");

const make = async (compression) => {
  const zip = new JSZip();
  zip.file("WhatsApp Chat with Brokers.txt", "24/10/2026, 10:15 - Ahmed: مرحبا\n".repeat(200));
  zip.file("IMG-1.jpg", Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)));
  zip.file("صورة-٢.jpg", Buffer.from("small"));
  zip.folder("media").file("IMG-3.jpg", Buffer.alloc(300, 7));
  return zip.generateAsync({ type: "nodebuffer", compression });
};

describe.each([["STORE"], ["DEFLATE"]])("%s zip", (compression) => {
  test("lists entries, reads text and bytes of one entry at a time", async () => {
    const z = await ZipRead.open(new Blob([await make(compression)]));
    expect(z.entries.map((e) => e.name).sort()).toEqual(["IMG-1.jpg", "WhatsApp Chat with Brokers.txt", "media/IMG-3.jpg", "صورة-٢.jpg"]);
    const chat = z.entries.find((e) => /\.txt$/.test(e.name));
    expect((await z.text(chat)).startsWith("24/10/2026, 10:15 - Ahmed: مرحبا")).toBe(true);
    const img = Buffer.from(await (await z.blob(z.entries.find((e) => e.name === "IMG-1.jpg"))).arrayBuffer());
    expect(img.equals(Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)))).toBe(true);
    expect((await z.text(z.entries.find((e) => e.name === "صورة-٢.jpg")))).toBe("small");
    expect(z.entries.find((e) => e.name === "IMG-1.jpg")).toMatchObject({ size: 5000, method: compression === "STORE" ? 0 : 8 });
  });
});

test("a file that is not a zip, or is cut short, is refused with NOT_ZIP", async () => {
  await expect(ZipRead.open(new Blob([Buffer.from("just some text, not a zip")]))).rejects.toMatchObject({ code: "NOT_ZIP" });
  const cut = (await make("DEFLATE")).subarray(0, 200);
  await expect(ZipRead.open(new Blob([cut]))).rejects.toMatchObject({ code: "NOT_ZIP" });
});

test("a zip with thousands of entries opens", async () => {
  const zip = new JSZip();
  for (let i = 0; i < 3000; i++) zip.file(`IMG-${i}.jpg`, "x");
  const z = await ZipRead.open(new Blob([await zip.generateAsync({ type: "nodebuffer" })]));
  expect(z.entries).toHaveLength(3000);
});
