// tests/router/telegram-photos.test.js — 6.4: unit photos on Telegram. A unit card gets its photos as an album above
// it (hero first, documents left out, at most 10); search results carry a numbered button per unit that opens its album and card (F5); units
// without photos send no album; WhatsApp brokers get no photos (each would cost a credit).
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/telegram", () => require("../harness/fake-telegram"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness } = require("../harness/app");

jest.setTimeout(60000);

let h;
beforeEach(async () => {
  h = await createHarness();
  await h.tgLink("broker");
  h.AI.respond(() => ({ intent: "search", filters: { compound: "Hyde Park" } }));
});
afterAll(closeHarness);

async function photos(listing, n, { documentAt = null } = {}) {
  for (let i = 0; i < n; i++) {
    await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url, role) VALUES ($1, $2, $3, $4, $5)", [
      listing.id,
      listing.agency_id,
      i,
      `https://cdn.example.com/${listing.code}/${i}.jpg`,
      i === documentAt ? "document" : null
    ]);
  }
}
const albums = (out) => out.filter((e) => e.method === "sendMediaGroup" || e.method === "sendPhoto");

test("a unit card on Telegram comes with its photos as one album, documents left out, at most 10", async () => {
  const u = await h.insertListing({ code: "HP-1" });
  await photos(u, 12, { documentAt: 1 });
  const out = await h.tgText("broker", "HP-1");
  const [album] = albums(out);
  expect(album.method).toBe("sendMediaGroup");
  expect(album.urls).toHaveLength(10);
  expect(album.urls[0]).toMatchObject({ url: "https://cdn.example.com/HP-1/0.jpg", caption: "#HP-1" });
  expect(album.urls.map((i) => i.url)).not.toContain("https://cdn.example.com/HP-1/1.jpg");
  // The album comes before the card with its buttons.
  const card = out.findIndex((e) => e.method === "sendMessage" && e.keyboard);
  expect(out.indexOf(album)).toBeLessThan(card);
});

test("one photo goes as a photo; no photos sends no album", async () => {
  const one = await h.insertListing({ code: "HP-2" });
  await photos(one, 1);
  expect(albums(await h.tgText("broker", "HP-2")).map((e) => e.method)).toEqual(["sendPhoto"]);
  await h.insertListing({ code: "HP-3" });
  expect(albums(await h.tgText("broker", "HP-3"))).toEqual([]);
});

test("F5: search results carry no photos; a numbered button per result opens that unit's album and card", async () => {
  const a = await h.insertListing({ code: "HP-10", price_value: 9000000 });
  await h.insertListing({ code: "HP-11", price_value: 8000000 });
  await photos(a, 3);
  const out = await h.tgText("broker", "هايد بارك");
  expect(albums(out)).toEqual([]);
  const list = out.find((e) => e.method === "sendMessage" && /وحدة مطابقة/.test(e.text || ""));
  const buttons = list.keyboard.flat();
  const lines = String(list.text).split("\n");
  const n = lines.find((l) => l.includes("HP-10")).match(/^(\d+)\./)[1];
  const btn = buttons.find((b) => b.text === `${n}. HP-10`);
  expect(btn).toBeDefined();
  const opened = await h.tgTap("broker", btn.callback_data);
  expect(albums(opened)[0].urls[0]).toMatchObject({ caption: "#HP-10" });
  expect(opened.some((e) => e.method === "sendMessage" && /HP-10/.test(e.text || "") && e.keyboard)).toBe(true);
});

test("WhatsApp brokers get no photos with cards or results", async () => {
  const u = await h.insertListing({ code: "HP-1" });
  await photos(u, 3);
  const out = [...(await h.text("colleague", "HP-1")), ...(await h.text("colleague", "هايد بارك"))];
  expect(out.some((r) => r.type === "image")).toBe(false);
  expect(h.TG.outbox.filter((e) => e.method === "sendMediaGroup")).toEqual([]);
});
