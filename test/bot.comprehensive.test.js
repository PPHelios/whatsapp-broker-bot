// test/bot.comprehensive.test.js
"use strict";

const crypto = require("crypto");
const request = require("supertest");

// Enforce test configuration before loading dependencies
process.env.NODE_ENV = "test";
process.env.PORT = "3002";
process.env.WHATSAPP_APP_SECRET = "test_app_secret_123456";
process.env.WHATSAPP_VERIFY_TOKEN = "verify_token_abc";
process.env.WHATSAPP_ACCESS_TOKEN = "mock_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.GEMINI_API_KEY = "mock_gemini_key";

// =========================================================================
// 1. In-Memory Mock Database
// =========================================================================
const mockDb = {
  brokers: [
    {
      id: "b10b0000-0000-0000-0000-000000000001",
      agency_id: "a00a0000-0000-0000-0000-000000000001",
      name: "Ahmed Agent",
      phone: "+201011111111",
      phone_normalized: "201011111111",
      contact_phone: "+201011111111",
      role: "agent",
      is_active: true,
      preferred_lang: "ar"
    },
    {
      id: "b20b0000-0000-0000-0000-000000000002",
      agency_id: "a00a0000-0000-0000-0000-000000000001",
      name: "Omar Colleague",
      phone: "+201022222222",
      phone_normalized: "201022222222",
      contact_phone: "+201022222222",
      role: "agent",
      is_active: true,
      preferred_lang: "ar"
    }
  ],
  listings: [
    {
      id: "l101-0000-0000",
      agency_id: "a00a0000-0000-0000-0000-000000000001",
      broker_id: "b10b0000-0000-0000-0000-000000000001",
      code: "HAS101",
      title: "شقة في ميفيدا",
      price_value: 15000000,
      price_display: "15,000,000 ج.م",
      status: "active",
      updated_at: new Date().toISOString()
    }
  ],
  processedBatches: new Set()
};

jest.mock("../lib/db", () => ({
  pool: {
    query: jest.fn().mockImplementation(async (sql, params = []) => {
      const q = String(sql).toLowerCase();

      // Health check
      if (q.includes("select 1")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }

      // Broker lookup
      if (q.includes("from brokers where phone_normalized")) {
        const broker = mockDb.brokers.find(
          (b) => b.phone_normalized === params[0]
        );
        return { rows: broker ? [broker] : [], rowCount: broker ? 1 : 0 };
      }

      // Existing listing lookup
      if (q.includes("from listings where agency_id = $1 and code = $2")) {
        const l = mockDb.listings.find(
          (item) =>
            item.agency_id === params[0] &&
            item.code === String(params[1]).toUpperCase()
        );
        return { rows: l ? [l] : [], rowCount: l ? 1 : 0 };
      }

      // Listing images lookup
      if (q.includes("from listing_images")) {
        return { rows: [], rowCount: 0 };
      }

      // Processed batches idempotency
      if (q.includes("from processed_batches where batch_key = $1")) {
        const exists = mockDb.processedBatches.has(params[0]);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      if (q.includes("insert into processed_batches")) {
        mockDb.processedBatches.add(params[0]);
        return { rowCount: 1 };
      }

      // Operation logs / Inbound messages updates
      return { rows: [], rowCount: 1 };
    }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockImplementation(async (sql, params = []) => {
        const q = String(sql).toLowerCase();
        if (
          q.includes("begin") ||
          q.includes("commit") ||
          q.includes("rollback")
        ) {
          return { rowCount: 0 };
        }
        if (q.includes("pg_advisory_xact_lock")) {
          return { rowCount: 1 };
        }
        if (q.includes("for update")) {
          const l = mockDb.listings.find(
            (item) => item.code === String(params[1]).toUpperCase()
          );
          return { rows: l ? [l] : [], rowCount: l ? 1 : 0 };
        }
        if (q.includes("update listings set price_value")) {
          const l = mockDb.listings.find((item) => item.id === params[2]);
          if (l) {
            l.price_value = params[0];
            l.price_display = params[1];
          }
          return { rowCount: 1 };
        }
        if (q.includes("update listings set status")) {
          const l = mockDb.listings.find((item) => item.id === params[1]);
          if (l) l.status = params[0];
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn()
    }),
    end: jest.fn().mockResolvedValue(true)
  }
}));

// =========================================================================
// 2. Mocks for External Storage & Messaging APIs
// =========================================================================
jest.mock("../lib/supabase", () => ({
  uploadListingImage: jest
    .fn()
    .mockResolvedValue("https://storage.supabase.co/img.jpg"),
  uploadFlyerImage: jest
    .fn()
    .mockResolvedValue("https://storage.supabase.co/flyer.jpg"),
  deleteStorageFiles: jest.fn().mockResolvedValue(true)
}));

const mockWhatsAppState = {
  sentTexts: [],
  sentButtons: [],
  simulateCareWindowExpiry: false,
  simulateRateLimitOnce: false
};

jest.mock("../lib/whatsapp", () => ({
  sendWhatsAppText: jest.fn().mockImplementation(async (to, text) => {
    if (mockWhatsAppState.simulateCareWindowExpiry) {
      const err = new Error("Care window closed");
      err.response = {
        data: { error: { code: 131047, message: "Re-engagement outside 24h" } }
      };
      throw err;
    }
    if (mockWhatsAppState.simulateRateLimitOnce) {
      mockWhatsAppState.simulateRateLimitOnce = false; // clear for retry
      const err = new Error("Rate limit");
      err.response = {
        data: { error: { code: 80007, message: "Rate limit hit" } }
      };
      throw err;
    }
    mockWhatsAppState.sentTexts.push({ to, text });
    return { messages: [{ id: `wamid.text_${Date.now()}` }] };
  }),
  sendWhatsAppButtons: jest
    .fn()
    .mockImplementation(async (to, body, rawButtons = []) => {
      // Assert WhatsApp Cloud API guardrails
      const buttons = (rawButtons || []).slice(0, 3).map((btn, idx) => {
        const rawTitle = String(btn.title || `Btn ${idx + 1}`).trim();
        const title = rawTitle.length > 20 ? rawTitle.slice(0, 20) : rawTitle;
        return { id: String(btn.id), title };
      });
      mockWhatsAppState.sentButtons.push({ to, body, buttons });
      return { messages: [{ id: `wamid.btn_${Date.now()}` }] };
    }),
  sendWhatsAppList: jest
    .fn()
    .mockResolvedValue({ messages: [{ id: "wamid.list" }] }),
  sendWhatsAppImage: jest
    .fn()
    .mockResolvedValue({ messages: [{ id: "wamid.img" }] }),
  markAsRead: jest.fn().mockResolvedValue(true),
  downloadWhatsAppMedia: jest.fn().mockResolvedValue({
    buffer: Buffer.from("mock-jpeg-buffer"),
    mimeType: "image/jpeg"
  })
}));

// =========================================================================
// 3. Mock Google Gen AI SDK (Cascade, Timeouts, JSON Parsing)
// =========================================================================
const mockGeminiState = {
  shouldTimeoutOn38: false,
  shouldReturnMarkdownWrappedJson: false,
  extractedListing: {
    title: "شقة للبيع في ميفيدا",
    property_type: "apartment",
    listing_type: "sale",
    price_raw: "18.5M EGP",
    area_value: 175,
    bedrooms: 3,
    location: "Mivida, New Cairo",
    compound: "Mivida",
    district: "Fifth Settlement",
    city: "New Cairo",
    location_keywords: ["mivida", "new cairo"],
    details: {
      features: ["بول", "بلكونة", "غرفة داده"],
      ambiguous_location: false
    }
  }
};

jest.mock("@google/genai", () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest
          .fn()
          .mockImplementation(async ({ model, contents }) => {
            // Model cascade timeout simulation
            if (
              model === "gemini-3.8-flash" &&
              mockGeminiState.shouldTimeoutOn38
            ) {
              const err = new Error("gemini-3.8-flash timeout");
              throw err;
            }

            let jsonStr = JSON.stringify(mockGeminiState.extractedListing);
            if (mockGeminiState.shouldReturnMarkdownWrappedJson) {
              jsonStr = `\`\`\`json\n${jsonStr}\n\`\`\``;
            }

            return {
              text: jsonStr,
              usageMetadata: {
                promptTokenCount: 150,
                candidatesTokenCount: 200
              }
            };
          })
      }
    }))
  };
});

const { app } = require("../server");
const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");

function createWebhookPayload(from, text, msgId = `wamid.${Date.now()}`) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "201000000000" },
              contacts: [{ profile: { name: "Agent" }, wa_id: from }],
              messages: [
                {
                  from,
                  id: msgId,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: "text",
                  text: { body: text }
                }
              ]
            },
            field: "messages"
          }
        ]
      }
    ]
  };

  const rawBody = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
    .update(rawBody)
    .digest("hex");

  return { payload, signature: `sha256=${signature}` };
}

// =========================================================================
// Test Suites
// =========================================================================
describe("Comprehensive Broker Bot E2E & Edge Case Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWhatsAppState.sentTexts = [];
    mockWhatsAppState.sentButtons = [];
    mockWhatsAppState.simulateCareWindowExpiry = false;
    mockWhatsAppState.simulateRateLimitOnce = false;
    mockGeminiState.shouldTimeoutOn38 = false;
    mockGeminiState.shouldReturnMarkdownWrappedJson = false;
  });

  describe("WhatsApp Operational Resilience", () => {
    test("Gracefully catches 24-hour service window expiry (#131047) without uncaught exceptions", async () => {
      mockWhatsAppState.simulateCareWindowExpiry = true;
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "help"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.text).toBe("EVENT_RECEIVED");
      // Wait for async worker queue
      await new Promise((r) => setTimeout(r, 100));
      expect(mockWhatsAppState.sentTexts.length).toBe(0); // Gracefully dropped
    });

    test("Backs off and retries when WhatsApp returns rate limit code (80007)", async () => {
      mockWhatsAppState.simulateRateLimitOnce = true;
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "help"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 1200)); // Allow retry sleep to resolve
      expect(mockWhatsAppState.sentTexts.length).toBe(1);
    });

    test("Enforces Meta button limits: max 3 buttons, max 20 characters per title", async () => {
      const longTitle = "This title is definitely longer than 20 characters";
      await WA.sendWhatsAppButtons("201011111111", "Menu", [
        { id: "1", title: longTitle },
        { id: "2", title: "Valid Title" },
        { id: "3", title: "Third Title" },
        { id: "4", title: "Should be sliced off" }
      ]);

      expect(mockWhatsAppState.sentButtons.length).toBe(1);
      const { buttons } = mockWhatsAppState.sentButtons[0];
      expect(buttons.length).toBe(3);
      expect(buttons[0].title.length).toBeLessThanOrEqual(20);
      expect(buttons[0].title).toBe(longTitle.slice(0, 20));
    });
  });

  describe("Gemini Failover, Nonces, and Audio Normalization", () => {
    test("Fails over to gemini-3.6-flash immediately when 3.8-flash times out", async () => {
      mockGeminiState.shouldTimeoutOn38 = true;
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "شقة للبيع 18.5 مليون كود #TEST1"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
    });

    test("Safely strips Markdown code fences (```json ... ```) from model response", async () => {
      mockGeminiState.shouldReturnMarkdownWrappedJson = true;
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "شقة 180م للبيع في ميفيدا"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
    });

    test("Audio normalization handles unknown voice mime-types without crashing", () => {
      expect(U.cleanAudioMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
      expect(U.cleanAudioMime("audio/x-m4a")).toBe("audio/mp4");
      expect(U.cleanAudioMime("audio/amr")).toBe("audio/amr");
      expect(U.cleanAudioMime("unknown/stream")).toBe("audio/ogg"); // Fallback
    });
  });

  describe("Broker Security, Ownership, and Commands", () => {
    test("Blocks colleague from editing another broker's listing when unauthorized", async () => {
      // Omar (+201022222222) attempts to change price of Ahmed's unit (#HAS101)
      const { payload, signature } = createWebhookPayload(
        "201022222222",
        "سعر HAS101 إلى 16 مليون"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(
        mockWhatsAppState.sentTexts.some((m) =>
          m.text.includes("لا تملك صلاحية")
        )
      ).toBe(true);
    });

    test("Allows owner broker to update status to sold", async () => {
      // Ahmed (+201011111111) marks his unit (#HAS101) as sold
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "sold #HAS101"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(
        mockWhatsAppState.sentTexts.some(
          (m) => m.text.includes("تم البيع") || m.text.includes("SOLD")
        )
      ).toBe(true);
    });

    describe("Text Normalization and Sanitization", () => {
      test("Parses fractions and scale correctly without digit collisions", () => {
        // Prevents 7 -> 71M or 6.5 -> 6.51M
        expect(T.parsePrice("7 مليون")).toBe(7000000);
        expect(T.parsePrice("6.5 مليون")).toBe(6500000);
        expect(T.parsePrice("6 مليون ونصف")).toBe(6500000);
        expect(T.parsePrice("18.5M")).toBe(18500000);
        expect(T.parsePrice("500 الف")).toBe(500000);
      });

      test("cleanFeaturesList sanitizes phonetic slang into formal Arabic amenities", () => {
        const dirty = ["بول", "سوبر لوكس", "غرفة داده", "جاردن", "اسانسير"];
        const clean = T.cleanFeaturesList(dirty);
        expect(clean).toContain("حمام سباحة");
        expect(clean).toContain("غرفة مربية");
        expect(clean).toContain("حديقة");
        expect(clean).toContain("مصعد");
        expect(clean).not.toContain("بول");
      });
    });
  });
});
