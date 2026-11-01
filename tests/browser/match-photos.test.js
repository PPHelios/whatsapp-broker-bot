// tests/browser/match-photos.test.js — The Match photos page in a real browser: a WhatsApp export zip is read, matched and
// its photos shrunk and sent, with no zip ever reaching the server. Fake data, fake AI, no outside network.
// Needs Chromium and Playwright. Run: npm run test:browser
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const JSZip = require("jszip");
const { createHarness, closeHarness } = require("../harness/app");
const WebAuth = require("../../lib/webAuth");
const Imports = require("../../services/imports");

process.env.PUBLIC_BASE_URL = "http://127.0.0.1:4573";
jest.setTimeout(240000);

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
let h, browser, server, dir;

/** Picture k: a random 9×8 brightness grid blown up (never a duplicate of another) at a camera-like size. */
async function distinct(k, size = 2400) {
  let a = 0x9e3779b9 + k * 7919;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const grid = Buffer.from(Array.from({ length: 72 }, () => Math.floor(rnd() * 256)));
  return sharp(grid, { raw: { width: 9, height: 8, channels: 1 } }).resize(size, size, { kernel: "nearest" }).jpeg().toBuffer();
}

const T = (hh, mm) => `24/10/2026, ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
const photo = (n, who = "Ahmed", at = T(10, 14)) => `${at} - ${who}: IMG-${n}.jpg (file attached)`;
const say = (text, who = "Ahmed", at = T(10, 15)) => `${at} - ${who}: ${text}`;

async function makeZip() {
  const chat = [
    photo(1), photo(2), say("شقة NH-V1 للبيع 200 متر 3 غرف السعر 12 مليون"),
    photo(3, "Ahmed", T(10, 29)), say("فيلا NH-V2 للبيع 300 متر 4 غرف السعر 25 مليون", "Ahmed", T(10, 30)),
    photo(4, "Sara", T(10, 40)), // nobody's description: the tray
    photo(5, "Ahmed", T(11, 29)), // named in the chat but missing from the zip
    say("شقة NH-V3 للبيع 120 متر 2 غرف السعر 6 مليون", "Ahmed", T(11, 30))
  ].join("\n");
  const zip = new JSZip();
  zip.file("WhatsApp Chat with Brokers.txt", chat);
  for (const k of [1, 2, 3, 4]) zip.file(`IMG-${k}.jpg`, await distinct(k), { compression: "STORE" });
  const file = path.join(dir, "export.zip");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "match-photos-"));
  h = await createHarness();
  await h.seedBroker("manager");
  h.AI.respond((c) => (c.operation === "listing_extraction" ? { listing_type: "sale", market: "resale", property_type: "villa", compound: "Hyde Park", area_value: 300, bedrooms: 4, price_value: 25e6 } : null));
  const { chromium } = require("playwright");
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  server = h.app.app.listen(4573);
});

afterAll(async () => {
  if (browser) await browser.close();
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await closeHarness();
});

async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: "block" });
  await ctx.route(/.*/, (route) => (LOCAL.test(route.request().url()) ? route.continue() : route.abort()));
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(20000);
  const errors = [];
  pg.on("pageerror", (e) => errors.push(e.message));
  const zipUploads = [];
  pg.on("request", (r) => { if (r.method() === "POST" && /application\/zip|\.zip/.test(`${r.headers()["content-type"] || ""}${r.postData() || ""}`.slice(0, 400))) zipUploads.push(r.url()); });
  const br = h.BROKERS.manager;
  const token = await WebAuth.issueLoginToken(h.pool, { id: br.id, agency_id: br.agency_id });
  await pg.goto(`http://127.0.0.1:4573/app/login/confirm?t=${token}`);
  await pg.click("form button[type=submit], form input[type=submit]");
  await pg.waitForURL((u) => !u.pathname.includes("login"));
  await pg.goto("http://127.0.0.1:4573/app/import", { waitUntil: "networkidle" });
  await pg.click("label[for=import_tab-3]");
  return { ctx, pg, errors, zipUploads };
}

test("with unit codes: the zip is read in the browser, photos are placed, the tray is filled by hand, then shrunk and sent", async () => {
  for (const code of ["NH-V1", "NH-V2", "NH-V3", "NH-V4"]) await h.insertListing({ code });
  const { ctx, pg, errors, zipUploads } = await openPage();
  await pg.setInputFiles("[data-cp-file]", await makeZip());
  await pg.fill("[data-cp-since]", "2026-01-01");
  await pg.click("[data-cp-read]");
  await pg.waitForSelector("[data-cp-unit]");
  const summary = await pg.textContent("[data-cp-summary]");
  expect(summary).toMatch(/3 وحدة|3 units/);
  const text = await pg.textContent("[data-cp-list]");
  expect(text).toContain("NH-V1");
  expect(await pg.$$("[data-cp-unit]")).toHaveLength(3);
  // Ahmed's photo 5 is named in the chat but missing from the zip; Sara's photo 4 has no description: the tray.
  expect(await pg.$$("[data-cp-group]")).toHaveLength(1);
  await pg.fill("[data-cp-code]", "NH-V4");
  await pg.dispatchEvent("[data-cp-code]", "change");
  await pg.waitForSelector("[data-cp-unit='NH-V4']");

  await pg.click("[data-cp-apply]");
  await pg.waitForSelector("[data-cp-done]");
  const photos = async (code) => (await h.query("SELECT i.url FROM listing_images i JOIN listings l ON l.id = i.listing_id WHERE l.code = $1", [code])).length;
  expect([await photos("NH-V1"), await photos("NH-V2"), await photos("NH-V3"), await photos("NH-V4")]).toEqual([2, 1, 0, 1]);
  // 2400 px camera photos were shrunk before they left the browser.
  const sizes = await Promise.all([...h.Storage.objects.values()].map(async (b) => (await sharp(b).metadata()).width));
  expect(Math.max(...sizes)).toBeLessThanOrEqual(1600);
  expect(zipUploads).toEqual([]);
  expect(errors).toEqual([]);

  // Running the same export again adds nothing: the duplicates are recognised.
  await pg.reload({ waitUntil: "networkidle" });
  await pg.click("label[for=import_tab-3]");
  await pg.setInputFiles("[data-cp-file]", path.join(dir, "export.zip"));
  await pg.fill("[data-cp-since]", "2026-01-01");
  await pg.click("[data-cp-read]");
  await pg.waitForSelector("[data-cp-unit]");
  await pg.click("[data-cp-apply]");
  await pg.waitForSelector("[data-cp-done]");
  expect(await photos("NH-V1")).toBe(2);
  await ctx.close();
});

test("with no codes: the posts and their photos become a group import for review", async () => {
  const { ctx, pg, errors } = await openPage();
  await pg.setInputFiles("[data-cp-file]", path.join(dir, "export.zip"));
  await pg.selectOption("[data-cp-mode]", "posts");
  await pg.fill("[data-cp-since]", "2026-01-01");
  await pg.click("[data-cp-read]");
  await pg.waitForSelector("[data-cp-unit]");
  await pg.click("[data-cp-apply]");
  await pg.waitForURL(/\/app\/import\/[0-9a-f-]{36}$/);
  const id = pg.url().split("/").pop();
  await Imports.waitForGroupImport(id);
  await pg.reload({ waitUntil: "networkidle" });
  const page = await pg.content();
  expect(page).toMatch(/data-post="0"[\s\S]*data-photos="2"/);
  expect(errors).toEqual([]);
  await ctx.close();
});
