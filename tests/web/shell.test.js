// tests/web/shell.test.js — Release 2 step 2: web shell (RTL, htmx, PWA, service worker scoped to /app/)
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness } = require("../harness/app");
const { html, raw, escapeHtml } = require("../../web/html");

jest.setTimeout(60000);

let h;
let web;
beforeAll(async () => {
  h = await createHarness();
  web = h.app.app;
});
afterAll(closeHarness);

test("/app redirects into the service worker scope; /app/ is an Arabic RTL page with htmx and the manifest", async () => {
  const r = await request(web).get("/app");
  expect(r.status).toBe(301);
  expect(r.headers.location).toBe("/app/");
  const page = await request(web).get("/app/");
  expect(page.status).toBe(200);
  expect(page.text).toMatch(/<html lang="ar" dir="rtl">/);
  expect(page.text).toMatch(/<script src="\/app\/static\/htmx\.min\.js\?v=[0-9a-f]{10}" defer><\/script>/);
  expect(page.text).toMatch(/<link rel="manifest" href="\/app\/manifest\.webmanifest">/);
  expect(page.text).toMatch(/<meta name="robots" content="noindex, nofollow">/);
  expect(page.text).toMatch(/<meta name="htmx-config" content="\{&quot;includeIndicatorStyles&quot;:false,&quot;allowEval&quot;:false,/);
});

test("pages carry a strict CSP (no inline script), no framing, nosniff and a same-origin referrer policy", async () => {
  const r = await request(web).get("/app/");
  const csp = r.headers["content-security-policy"];
  expect(csp).toMatch(/script-src 'self'(;|$)/);
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(csp).toMatch(/frame-ancestors 'none'/);
  expect(r.headers["x-frame-options"]).toBe("DENY");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["referrer-policy"]).toBe("same-origin");
  expect(r.text).not.toMatch(/<script>(?!<\/script>)/); // no inline scripts
});

test("the manifest is scoped to /app/ and every icon it lists is served", async () => {
  const r = await request(web).get("/app/manifest.webmanifest");
  expect(r.headers["content-type"]).toMatch(/application\/manifest\+json/);
  const m = JSON.parse(r.text);
  expect(m).toMatchObject({ scope: "/app/", start_url: "/app/", display: "standalone", dir: "rtl", lang: "ar" });
  expect(m.icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  for (const icon of m.icons) expect((await request(web).get(icon.src)).status).toBe(200);
});

test("the service worker is served from /app/ with its scope, never cached, and only handles /app/ GETs", async () => {
  const r = await request(web).get("/app/sw.js");
  expect(r.status).toBe(200);
  expect(r.headers["content-type"]).toMatch(/javascript/);
  expect(r.headers["service-worker-allowed"]).toBe("/app/");
  expect(r.headers["cache-control"]).toBe("no-cache");
  expect(r.text).not.toMatch(/__VERSION__|__ASSETS__/);
  expect(r.text).toMatch(/req\.method !== "GET"/);
  expect(r.text).toMatch(/url\.pathname\.startsWith\("\/app\/"\)/);
  const assets = JSON.parse(r.text.match(/const ASSETS = (\[.*?\]);/)[1]);
  expect(assets.some((a) => a.startsWith("/app/static/htmx.min.js?v="))).toBe(true);
  for (const a of assets) {
    const res = await request(web).get(a);
    expect([a, res.status]).toEqual([a, 200]);
    expect(res.headers["cache-control"]).toMatch(/immutable/);
  }
  // The client registers it with the /app/ scope.
  const app = await request(web).get(assets.find((a) => a.startsWith("/app/static/app.js")));
  expect(app.text).toMatch(/register\("\/app\/sw\.js", \{ scope: "\/app\/" \}\)/);
});

test("the htmx served is the pinned package", async () => {
  const pinned = require("../../package.json").dependencies["htmx.org"];
  const res = await request(web).get("/app/static/htmx.min.js");
  expect(res.headers["cache-control"]).toBe("no-cache"); // unversioned URL
  expect(res.text).toContain(`version:"${pinned}"`);
});

test("unknown static files and pages are 404; the offline page exists", async () => {
  expect((await request(web).get("/app/static/nope.js")).status).toBe(404);
  expect((await request(web).get("/app/no-such-page")).status).toBe(404);
  const off = await request(web).get("/app/offline");
  expect(off.status).toBe(200);
  expect(off.text).toMatch(/مفيش اتصال/);
});

test("cross-site form posts are refused before any handler runs", async () => {
  expect((await request(web).post("/app/").set("Sec-Fetch-Site", "cross-site").send("a=1")).status).toBe(403);
  expect((await request(web).post("/app/").set("Origin", "https://evil.example").send("a=1")).status).toBe(403);
});

test("the webhook, health check and robots.txt still work next to the web app", async () => {
  expect((await request(web).get("/health")).status).toBe(200);
  expect((await request(web).get("/webhook")).status).toBe(403);
  const robots = await request(web).get("/robots.txt");
  expect(robots.text).toMatch(/Disallow: \/app\//);
});

test("html escapes every interpolated value unless it is trusted markup", () => {
  const evil = `<script>alert("x")</script>`;
  expect(String(html`<p title="${evil}">${evil}</p>`)).toBe(
    "<p title=\"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;\">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>"
  );
  expect(String(html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`)).toBe("<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  expect(String(html`${raw("<b>ok</b>")}${null}${false}${0}`)).toBe("<b>ok</b>0");
  expect(escapeHtml("`'")).toBe("&#96;&#39;");
});
