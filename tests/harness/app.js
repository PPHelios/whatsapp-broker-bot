// tests/harness/app.js — Drives the real router (server.js createApp) end to end.
// Test files must mock the external edges before requiring this module:
//   jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
//   jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
//   jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));
"use strict";

const sharp = require("sharp");
const { createTestDb } = require("./db");
const WA = require("./fake-whatsapp");
const AI = require("./fake-ai");
const Storage = require("./fake-supabase");

const AGENCY_A = "a0000000-0000-0000-0000-00000000000a";
const AGENCY_B = "b0000000-0000-0000-0000-00000000000b";

const BROKERS = {
  broker: { id: "10000000-0000-0000-0000-000000000001", agency_id: AGENCY_A, phone: "201000000001", role: "broker", name: "Broker One", lang: "ar" },
  colleague: { id: "10000000-0000-0000-0000-000000000002", agency_id: AGENCY_A, phone: "201000000002", role: "broker", name: "Broker Two", lang: "ar" },
  admin: { id: "10000000-0000-0000-0000-000000000003", agency_id: AGENCY_A, phone: "201000000003", role: "admin", name: "Agency Admin", lang: "en" },
  rival: { id: "20000000-0000-0000-0000-000000000001", agency_id: AGENCY_B, phone: "201000000009", role: "broker", name: "Rival Broker", lang: "ar" }
};

async function seed(pool) {
  await pool.query(
    `INSERT INTO agencies (id, name, phone) VALUES ($1, 'Agency Alpha', '0221111111'), ($2, 'Agency Beta', '0222222222')`,
    [AGENCY_A, AGENCY_B]
  );
  for (const b of Object.values(BROKERS)) {
    await pool.query(
      `INSERT INTO brokers (id, agency_id, phone_number, name, role, is_active, preferred_lang)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [b.id, b.agency_id, b.phone, b.name, b.role, b.lang]
    );
  }
}

/** Inserts a listing directly (fixture), bypassing the bot. Returns the row. */
async function insertListing(pool, fields) {
  const row = {
    agency_id: AGENCY_A,
    broker_id: BROKERS.broker.id,
    title: "شقة 150م في التجمع",
    property_type: "apartment",
    listing_type: "sale",
    price_value: 8500000,
    area_value: 150,
    bedrooms: 3,
    compound: "Hyde Park",
    status: "active",
    details: {},
    ...fields
  };
  const cols = Object.keys(row);
  const vals = cols.map((c) => (c === "details" || c === "payment_terms" ? JSON.stringify(row[c]) : row[c]));
  const { rows } = await pool.query(
    `INSERT INTO listings (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    vals
  );
  return rows[0];
}

let jpegCache = null;
async function sampleJpeg() {
  if (!jpegCache) {
    jpegCache = await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 140, b: 160 } }
    })
      .jpeg()
      .toBuffer();
  }
  return jpegCache;
}

/** Lets setImmediate/background work (flyers, exports) run to completion. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
  }
}

// One database per test file (Jest isolates modules per file); tests reset it via TRUNCATE.
let shared = null;

async function freshDb() {
  if (!shared) {
    shared = await createTestDb();
  } else {
    const { rows } = await shared.pool.query(
      "SELECT string_agg(format('public.%I', tablename), ', ') AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"
    );
    await shared.pool.query(`TRUNCATE ${rows[0].t} RESTART IDENTITY CASCADE`);
  }
  return shared.pool;
}

/** Closes the shared database; call from afterAll. */
async function closeHarness() {
  if (shared) {
    await shared.pool.end();
    shared = null;
  }
}

async function createHarness() {
  WA.reset();
  AI.reset();
  Storage.reset();
  const pool = await freshDb();
  await seed(pool);
  const { createApp } = require("../../server");
  const app = createApp({ pool });
  let seq = 0;

  /** Sends one inbound WhatsApp message through the real webhook pipeline; returns the replies. */
  async function send(who, message) {
    const broker = typeof who === "string" ? BROKERS[who] : who;
    const id = message.id || `wamid.in.${++seq}`;
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ from: broker.phone, id, timestamp: `${Date.now()}`, ...message, id }]
              }
            }
          ]
        }
      ]
    };
    const start = WA.outbox.length;
    await app.handleWebhookBody(body);
    await settle();
    return WA.outbox.slice(start);
  }

  const h = {
    pool,
    app,
    WA,
    AI,
    Storage,
    BROKERS,
    AGENCY_A,
    AGENCY_B,
    send,
    text: (who, body) => send(who, { type: "text", text: { body } }),
    tap: (who, id, title = id) =>
      send(who, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } }),
    pick: (who, id, title = id) =>
      send(who, { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } } }),
    async photo(who, { mediaId, caption } = {}) {
      const id = mediaId || `media.img.${++seq}`;
      WA.media.set(id, { buffer: await sampleJpeg(), mimeType: "image/jpeg" });
      return send(who, { type: "image", image: { id, mime_type: "image/jpeg", ...(caption ? { caption } : {}) } });
    },
    async voice(who, { mediaId, duration = 10 } = {}) {
      const id = mediaId || `media.ogg.${++seq}`;
      WA.media.set(id, { buffer: Buffer.from("OggS-fake-audio"), mimeType: "audio/ogg; codecs=opus" });
      return send(who, { type: "audio", audio: { id, mime_type: "audio/ogg; codecs=opus", voice: true, duration } });
    },
    insertListing: (fields) => insertListing(pool, fields),
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    session: async (who, type = "draft") =>
      (
        await pool.query(
          "SELECT session_data FROM broker_sessions WHERE broker_id = $1 AND session_type = $2",
          [BROKERS[who].id, type]
        )
      ).rows[0]?.session_data || null
  };
  return h;
}

/** Concatenated text of a set of replies, for loose assertions. */
const textOf = (replies) => replies.map((r) => r.text || r.caption || "").join("\n");

const FALLBACK_AR = "تعذر تحديد الإجراء";

module.exports = {
  createHarness,
  closeHarness,
  textOf,
  settle,
  FALLBACK_AR,
  BROKERS,
  AGENCY_A,
  AGENCY_B
};
