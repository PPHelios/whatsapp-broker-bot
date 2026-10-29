// tests/web/public.test.js — Release 2 step 7: public unit pages /<agency-slug>/<unit-code>?s=<token>:
// OG tags, noindex, opened alerts, the allowlist serializer
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const request = require("supertest");
const { createHarness, closeHarness, textOf } = require("../harness/app");
const { signIn } = require("../harness/web");
const PublicUnit = require("../../domain/publicUnit");
const Share = require("../../lib/shareLinks");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
});
afterAll(closeHarness);

const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const PREVIEW = "WhatsApp/2.24.20.89 A";
const linkIn = (text) => (String(text).match(/http:\/\/localhost:3000(\/agency-alpha\/[^?\s]+\?s=[A-Za-z0-9_-]+)/) || [])[1];
const open = (path, ua = BROWSER) => request(h.app.app).get(path).set("User-Agent", ua);

// Every internal field filled with a sentinel that must never reach a public page.
const SECRET = {
  owner_name: "SENTINEL_OWNER",
  owner_phone: "01999999999",
  notes: "SENTINEL_NOTES",
  commission: "SENTINEL_COMMISSION",
  co_broker: "SENTINEL_COBROKER",
  title_en: "Nice flat"
};
async function seedUnit(extra = {}) {
  const l = await h.insertListing({
    code: "PUB-1",
    compound: "Hyde Park",
    price_value: 8.5e6,
    area_value: 150,
    bedrooms: 3,
    bathrooms: 2,
    feature_keys: ["north_facing", "corner"],
    raw_text: "SENTINEL_RAW 01999999999",
    developer_unit_code: "SENTINEL_DEVCODE",
    details: { ...SECRET, clean_summary: "شقة واسعة على حديقة" },
    ...extra
  });
  await h.query("INSERT INTO listing_images (listing_id, agency_id, position, url) VALUES ($1, $2, 0, 'https://storage.test/listing-images/a.jpg')", [l.id, h.AGENCY_A]);
  return l;
}
async function sharedLink(code = "PUB-1", who = "broker") {
  const path = linkIn(textOf(await h.text(who, `عميل ${code}`)));
  if (!path) throw new Error("no link in the client copy");
  return path;
}

describe("the client copy carries a share link", () => {
  test("'عميل CODE' adds /<agency-slug>/<code>?s=<token> in the same message; the token is stored hashed", async () => {
    await seedUnit();
    const replies = await h.text("broker", "عميل PUB-1");
    expect(replies).toHaveLength(1);
    const path = linkIn(textOf(replies));
    expect(path).toMatch(/^\/agency-alpha\/PUB-1\?s=[A-Za-z0-9_-]{22}$/);
    const token = path.split("s=")[1];
    const [row] = await h.query("SELECT token_hash, broker_id, channel FROM share_links");
    expect(row).toEqual({ token_hash: require("crypto").createHash("sha256").update(token).digest("hex"), broker_id: h.BROKERS.broker.id, channel: "whatsapp" });
    // Button path too, in English.
    expect(linkIn(textOf(await h.tap("admin", "client:PUB-1")))).toBeTruthy();
  });

  test("a sold unit's client copy has no link", async () => {
    await seedUnit({ status: "sold" });
    expect(linkIn(textOf(await h.text("broker", "عميل PUB-1")))).toBeUndefined();
  });
});

describe("the public page", () => {
  test("OG tags for the link preview, noindex everywhere, no scripts, no referrer", async () => {
    await seedUnit();
    const r = await open(await sharedLink(), PREVIEW);
    expect(r.status).toBe(200);
    expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.headers["content-security-policy"]).toMatch(/script-src 'self'/);
    expect(r.text).toMatch(/<meta name="robots" content="noindex, nofollow">/);
    expect(r.text).toMatch(/<meta property="og:title" content="شقة للبيع في Hyde Park · 8.5 مليون ج.م">/);
    expect(r.text).toMatch(/<meta property="og:image" content="https:\/\/storage.test\/listing-images\/a.jpg">/);
    expect(r.text).toMatch(/<meta property="og:url" content="http:\/\/localhost:3000\/agency-alpha\/PUB-1\?s=/);
    expect(r.text).toMatch(/<meta property="og:description" content="[^"]*150م/);
    expect(r.text).not.toMatch(/<script/);
    expect(r.text).not.toMatch(/rel="manifest"/);
  });

  test("the allowlist: no internal field, raw text, id or developer code ever appears", async () => {
    const l = await seedUnit();
    const r = await open(await sharedLink());
    for (const bad of [...Object.values(SECRET).filter((v) => v !== "Nice flat"), "SENTINEL_RAW", "SENTINEL_DEVCODE", l.id, h.AGENCY_A, h.BROKERS.broker.id]) {
      expect([bad, r.text.includes(bad)]).toEqual([bad, false]);
    }
    // What a client should see is there.
    expect(r.text).toMatch(/بحري/);
    expect(r.text).toMatch(/شقة واسعة على حديقة/);
    expect(r.text).toMatch(/Broker One/);
    expect(r.text).toMatch(/\+201000000001/);

    const u = PublicUnit.toPublicUnit({ ...l, details: { ...l.details, ...SECRET } }, { agency: { name: "A", secret: "x" }, broker: { ...h.BROKERS.broker, id: "x", role: "admin" }, images: [{ url: "https://x/y.jpg", id: "img" }, { url: "javascript:alert(1)" }] });
    expect(Object.keys(u).sort()).toEqual([...PublicUnit.PUBLIC_FIELDS].sort());
    expect(Object.keys(u.agency).sort()).toEqual(["logo_url", "name", "phone"]);
    expect(Object.keys(u.contact).sort()).toEqual(["name", "phone"]);
    expect(u.images).toEqual(["https://x/y.jpg"]);
    expect(JSON.stringify(u)).not.toMatch(/SENTINEL|01999999999|admin/);
  });

  test("English: ?lang=en shows the English copy with no Arabic script in the facts", async () => {
    await seedUnit();
    const path = await sharedLink();
    const r = await open(`${path}&lang=en`);
    expect(r.text).toMatch(/<html lang="en" dir="ltr">/);
    expect(r.text).toMatch(/Apartment for sale in Hyde Park/);
    const facts = r.text.match(/<ul class="facts">([\s\S]*?)<\/ul>/)[1];
    expect(facts).not.toMatch(/[؀-ۿ]/);
  });

  test("a wrong token, slug or code — or another agency's slug — is the same 404", async () => {
    await seedUnit();
    await h.query("UPDATE agencies SET slug = 'beta' WHERE id = $1", [h.AGENCY_B]);
    const path = await sharedLink();
    const token = path.split("s=")[1];
    const bodies = [];
    for (const p of [`/agency-alpha/PUB-1?s=${"x".repeat(22)}`, `/beta/PUB-1?s=${token}`, `/agency-alpha/PUB-2?s=${token}`, "/agency-alpha/PUB-1", `/agency-alpha/PUB-1?s=${token}'--`]) {
      const r = await open(p);
      expect([p, r.status]).toEqual([p, 404]);
      bodies.push(r.text);
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await open(path.replace("PUB-1", "pub-1"))).status).toBe(200); // codes are case-folded
    await h.query("UPDATE share_links SET revoked_at = NOW()");
    expect((await open(path)).status).toBe(404);
  });

  test("a sold unit says it is no longer available and shows nothing else", async () => {
    await seedUnit();
    const path = await sharedLink();
    await h.text("broker", "اتباعت PUB-1");
    const r = await open(path);
    expect(r.status).toBe(410);
    expect(r.text).toMatch(/مبقتش متاحة/);
    expect(r.text).not.toMatch(/8.5 مليون|Hyde Park|بحري|Broker One/);
    expect(r.text).not.toMatch(/og:title/);
  });

  test("the app's own paths are never taken for an agency", async () => {
    expect((await request(h.app.app).get("/app/login")).status).toBe(200);
    expect((await request(h.app.app).get("/health")).status).toBe(200);
    expect((await request(h.app.app).get("/app/static/nope")).status).toBe(404);
    expect((await request(h.app.app).get("/webhook/x")).status).toBe(404);
  });

  test("public pages are rate limited per IP", async () => {
    await seedUnit();
    const path = await sharedLink();
    expect((await open(path)).status).toBe(200);
    await h.query("UPDATE web_rate_limits SET hits = 120 WHERE bucket LIKE 'public:ip:%'");
    expect((await open(path)).status).toBe(429);
  });
});

describe("opened alerts", () => {
  const alerts = () => h.WA.outbox.filter((m) => /فتح رابط الوحدة|opened the link/.test(m.text || ""));

  test("a client's open alerts the broker who shared it, once per 6 hours; previews and colleagues do not count", async () => {
    await seedUnit();
    const path = await sharedLink();
    h.WA.outbox.length = 0;

    await open(path, PREVIEW); // WhatsApp builds the link preview when the broker sends it
    await open(path, "facebookexternalhit/1.1");
    expect(alerts()).toHaveLength(0);

    await open(path);
    expect(alerts()).toEqual([expect.objectContaining({ to: "201000000001", text: expect.stringMatching(/العميل فتح رابط الوحدة #PUB-1/) })]);
    await open(path);
    expect(alerts()).toHaveLength(1);

    const colleague = await signIn(h, "colleague");
    await colleague.agent.get(path).set("User-Agent", BROWSER);
    const [{ open_count }] = await h.query("SELECT open_count FROM share_links");
    expect(open_count).toBe(2);

    // Seven hours later (the alert throttle and the notification centre's 2-minute merge window have passed).
    await h.query("UPDATE share_links SET last_alert_at = NOW() - INTERVAL '7 hours'");
    await h.query("UPDATE notifications SET delivered_at = NOW() - INTERVAL '7 hours' WHERE kind = 'share_opened'");
    await open(path);
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1].text).toMatch(/\(3 مرات\)/);
    const counted = await h.query("SELECT status, metadata->>'kind' AS kind FROM operation_logs WHERE operation_type = 'wa_outbound' AND metadata->>'kind' = 'notify_share_opened'");
    expect(counted).toHaveLength(2);
    expect(await h.query("SELECT count(*)::int AS n FROM operation_logs WHERE operation_type = 'share_opened'")).toEqual([{ n: 3 }]);
  });

  test("an English broker gets the alert in English; bot detection covers common previewers", async () => {
    await seedUnit({ broker_id: h.BROKERS.admin.id });
    const path = await sharedLink("PUB-1", "admin");
    h.WA.outbox.length = 0;
    await open(path);
    expect(alerts()[0].text).toMatch(/Your client opened the link for #PUB-1/);
    for (const ua of ["TelegramBot (like TwitterBot)", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "", "curl/8.0"]) expect([ua, Share.isBot(ua)]).toEqual([ua, true]);
    expect(Share.isBot(BROWSER)).toBe(false);
  });
});

describe("sharing from the web app", () => {
  test("the unit page makes a link (and a WhatsApp share) and lists the broker's links with their opens", async () => {
    await seedUnit();
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/units/PUB-1/share").set("X-CSRF-Token", csrf).type("form").send({ lang: "en" });
    const url = r.text.match(/data-share-url>([^<]+)</)[1];
    expect(url).toMatch(/^http:\/\/localhost:3000\/agency-alpha\/PUB-1\?s=/);
    expect(r.text).toMatch(/https:\/\/wa\.me\/\?text=/);
    await open(url.replace("http://localhost:3000", ""));
    const page = await agent.get("/app/units/PUB-1");
    expect(page.text).toMatch(/data-link-opens="1"/);
    const [link] = await h.query("SELECT channel, lang FROM share_links");
    expect(link).toEqual({ channel: "web", lang: "en" });
  });

  test("the broker opening their own link while signed in is told it isn't counted; a client's open counts and alerts", async () => {
    await seedUnit();
    const { agent, csrf } = await signIn(h, "broker");
    const r = await agent.post("/app/units/PUB-1/share").set("X-CSRF-Token", csrf).type("form").send({ lang: "en" });
    const path = r.text.match(/data-share-url>([^<]+)</)[1].replace("http://localhost:3000", "");
    h.WA.outbox.length = 0;

    const own = await agent.get(path).set("User-Agent", BROWSER);
    expect(own.status).toBe(200);
    expect(own.text).toMatch(/data-team-view/);
    expect(own.text).toMatch(/is not counted/);
    expect((await h.query("SELECT open_count FROM share_links"))[0].open_count).toBe(0);
    expect(await h.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'share_opened'")).toEqual([{ n: 0 }]);

    const client = await open(path);
    expect(client.text).not.toMatch(/data-team-view/);
    expect((await h.query("SELECT open_count FROM share_links"))[0].open_count).toBe(1);
    expect(await h.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'share_opened'")).toEqual([{ n: 1 }]);
    expect((await agent.get("/app/units/PUB-1")).text).toMatch(/data-link-opens="1"/);
  });
});
