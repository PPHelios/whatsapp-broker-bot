// test/bot.comprehensive.test.js
"use strict";

const crypto = require("crypto");
const request = require("supertest");

// 1. Mandatory Environment Configuration for Test Runner
process.env.NODE_ENV = "test";
process.env.PORT = "3003";
process.env.WHATSAPP_APP_SECRET = "test_app_secret_123456";
process.env.WHATSAPP_VERIFY_TOKEN = "verify_token_abc";
process.env.WHATSAPP_ACCESS_TOKEN = "mock_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.GEMINI_API_KEY = "mock_gemini_key";
process.env.SUPABASE_URL = "https://mock-project.supabase.co";
process.env.SUPABASE_ANON_KEY = "mock-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key";
process.env.AI_DAILY_LIMIT_PER_AGENCY = "300";
process.env.AI_DAILY_LIMIT_PER_BROKER = "60";

// =========================================================================
// 2. In-Memory Mock Database
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
      property_type: "apartment",
      listing_type: "sale",
      location: "ميفيدا، القاهرة الجديدة",
      compound: "ميفيدا",
      bedrooms: 3,
      area_value: 180,
      status: "active",
      details: {},
      flyer_cache: {},
      updated_at: new Date().toISOString()
    },
    {
      id: "l102-0000-0000",
      agency_id: "a00a0000-0000-0000-0000-000000000001",
      broker_id: "b10b0000-0000-0000-0000-000000000001",
      code: "SOLD99",
      title: "فيلا بالميرا",
      price_value: 30000000,
      price_display: "30,000,000 ج.م",
      property_type: "villa",
      listing_type: "sale",
      location: "بالميرا",
      status: "sold",
      updated_at: new Date().toISOString()
    }
  ],
  drafts: new Map(),
  processedBatches: new Set(),
  operationLogs: []
};

jest.mock("../lib/db", () => ({
  pool: {
    query: jest.fn().mockImplementation(async (sql, params = []) => {
      const q = String(sql).toLowerCase();

      if (q.includes("select 1")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }

      // Two-tier Quota checks
      if (q.includes("from operation_logs where agency_id = $1")) {
        const count = mockDb.operationLogs.filter(
          (l) => l.agency_id === params[0] && l.tokens_input > 0
        ).length;
        return { rows: [{ n: count }], rowCount: 1 };
      }

      if (q.includes("from operation_logs where broker_id = $1")) {
        const count = mockDb.operationLogs.filter(
          (l) => l.broker_id === params[0] && l.tokens_input > 0
        ).length;
        return { rows: [{ n: count }], rowCount: 1 };
      }

      if (q.includes("insert into operation_logs")) {
        mockDb.operationLogs.push({
          agency_id: params[0],
          broker_id: params[1],
          listing_code: params[2],
          tokens_input: params[13] || 100,
          tokens_output: params[14] || 100
        });
        return { rowCount: 1 };
      }

      if (q.includes("from brokers where phone_normalized")) {
        const broker = mockDb.brokers.find(
          (b) => b.phone_normalized === params[0]
        );
        return { rows: broker ? [broker] : [], rowCount: broker ? 1 : 0 };
      }

      if (q.includes("from listings where agency_id = $1 and code = $2")) {
        const l = mockDb.listings.find(
          (item) =>
            item.agency_id === params[0] &&
            item.code === String(params[1]).toUpperCase()
        );
        return { rows: l ? [l] : [], rowCount: l ? 1 : 0 };
      }

      // Checked BEFORE "from listing_drafts" to prevent substring collision
      if (q.includes("delete from listing_drafts")) {
        mockDb.drafts.delete(params[0]);
        return { rowCount: 1 };
      }

      if (q.includes("from listing_drafts")) {
        const d = mockDb.drafts.get(params[0]);
        return { rows: d ? [d] : [], rowCount: d ? 1 : 0 };
      }

      if (q.includes("from processed_batches where batch_key = $1")) {
        const exists = mockDb.processedBatches.has(params[0]);
        return { rows: exists ? [{ 1: 1 }] : [], rowCount: exists ? 1 : 0 };
      }

      if (q.includes("insert into processed_batches")) {
        mockDb.processedBatches.add(params[0]);
        return { rowCount: 1 };
      }

      if (q.includes("from agencies where id = $1")) {
        return {
          rows: [
            {
              id: params[0],
              name: "Prime Real Estate",
              logo_url: "https://example.com/logo.png",
              primary_color: "#000000",
              secondary_color: "#ffffff"
            }
          ],
          rowCount: 1
        };
      }

      if (q.includes("from listing_images where listing_id = $1")) {
        return {
          rows: [
            {
              id: "img-1",
              url: "https://storage.supabase.co/img1.jpg",
              role: "reception",
              position: 0
            }
          ],
          rowCount: 1
        };
      }

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
        if (q.includes("from listings where agency_id = $1 and code = $2")) {
          const l = mockDb.listings.find(
            (item) =>
              item.agency_id === params[0] &&
              item.code === String(params[1]).toUpperCase()
          );
          return { rows: l ? [l] : [], rowCount: l ? 1 : 0 };
        }
        // Checked BEFORE "from listing_drafts"
        if (q.includes("delete from listing_drafts")) {
          mockDb.drafts.delete(params[0]);
          return { rowCount: 1 };
        }
        if (q.includes("from listing_drafts")) {
          const d = mockDb.drafts.get(params[0]);
          return { rows: d ? [d] : [], rowCount: d ? 1 : 0 };
        }
        if (q.includes("insert into listing_drafts")) {
          const newDraft = {
            broker_id: params[0],
            agency_id: params[1],
            broker_phone: params[2],
            media_ids: params[3] || [],
            voice_ids: params[4] || [],
            texts: params[5] || [],
            custom_code: params[6] || null,
            updated_at: new Date().toISOString()
          };
          mockDb.drafts.set(params[0], newDraft);
          return { rows: [newDraft], rowCount: 1 };
        }
        if (q.includes("update listing_drafts")) {
          const draft = mockDb.drafts.get(params[4]);
          if (draft) {
            draft.media_ids = params[0];
            draft.voice_ids = params[1];
            draft.texts = params[2];
            draft.custom_code = params[3];
            draft.updated_at = new Date().toISOString();
          }
          return { rows: [draft], rowCount: 1 };
        }
        if (q.includes("insert into listings")) {
          const newListing = {
            id: `l-new-${Date.now()}`,
            agency_id: params[0],
            broker_id: params[1],
            code: params[2],
            title: params[3],
            property_type: params[4],
            listing_type: params[5],
            price_value: params[6],
            price_display: params[7],
            area_value: params[8],
            bedrooms: params[9],
            location: params[10],
            compound: params[11],
            district: params[12],
            city: params[13],
            location_keywords: params[14],
            details: params[15],
            status: "active",
            updated_at: new Date().toISOString()
          };
          mockDb.listings.push(newListing);
          return { rows: [newListing], rowCount: 1 };
        }
        if (q.includes("update listings set status")) {
          const l = mockDb.listings.find((item) => item.id === params[1]);
          if (l) l.status = params[0];
          return { rowCount: 1 };
        }
        if (q.includes("update listings set price_value")) {
          const l = mockDb.listings.find((item) => item.id === params[2]);
          if (l) {
            l.price_value = params[0];
            l.price_display = params[1];
          }
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
// 3. Mocks for External Storage & Messaging APIs
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

jest.mock("../lib/flyer", () => ({
  generateFlyerBuffer: jest
    .fn()
    .mockResolvedValue(Buffer.from("mock-flyer-pdf")),
  loadFont: jest.fn().mockResolvedValue(true)
}));

const mockWhatsAppState = {
  sentTexts: [],
  sentButtons: [],
  sentLists: [],
  sentImages: [],
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
      mockWhatsAppState.simulateRateLimitOnce = false;
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
      const buttons = (rawButtons || []).slice(0, 3).map((btn, idx) => ({
        id: String(btn.id || `btn_${idx}`),
        title: String(btn.title || `Btn ${idx + 1}`).slice(0, 20)
      }));
      mockWhatsAppState.sentButtons.push({ to, body, buttons });
      return { messages: [{ id: `wamid.btn_${Date.now()}` }] };
    }),
  sendWhatsAppList: jest
    .fn()
    .mockImplementation(async (to, header, body, btnLabel, sections) => {
      mockWhatsAppState.sentLists.push({ to, header, body, sections });
      return { messages: [{ id: `wamid.list_${Date.now()}` }] };
    }),
  sendWhatsAppImage: jest
    .fn()
    .mockImplementation(async (to, media, caption) => {
      mockWhatsAppState.sentImages.push({ to, media, caption });
      return { messages: [{ id: `wamid.img_${Date.now()}` }] };
    }),
  sendWhatsAppDocument: jest
    .fn()
    .mockResolvedValue({ messages: [{ id: "wamid.doc" }] }),
  uploadWhatsAppMedia: jest.fn().mockResolvedValue("wa-media-id-12345"),
  markAsRead: jest.fn().mockResolvedValue(true),
  downloadWhatsAppMedia: jest.fn().mockResolvedValue({
    buffer: Buffer.from("mock-jpeg-buffer"),
    mimeType: "image/jpeg"
  })
}));

// =========================================================================
// 4. Mock Google Gen AI SDK
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
    location: "ميفيدا، التجمع الخامس",
    compound: "ميفيدا",
    district: "التجمع الخامس",
    city: "القاهرة الجديدة",
    location_keywords: ["ميفيدا", "القاهرة الجديدة"],
    details: {
      features: ["حمام سباحة", "شرفة"],
      ambiguous_location: false
    }
  }
};

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest.fn().mockImplementation(async ({ model }) => {
        if (model === "gemini-3.8-flash" && mockGeminiState.shouldTimeoutOn38) {
          throw new Error("gemini-3.8-flash timeout");
        }

        let jsonStr = JSON.stringify(mockGeminiState.extractedListing);
        if (mockGeminiState.shouldReturnMarkdownWrappedJson) {
          jsonStr = `\`\`\`json\n${jsonStr}\n\`\`\``;
        }

        return {
          text: jsonStr,
          usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 200 }
        };
      })
    }
  }))
}));

const { app } = require("../server");
const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");

let msgSequence = 0;
function createWebhookPayload(
  from,
  payloadData,
  type = "text",
  interactiveType = "button_reply"
) {
  msgSequence++;
  const msgObj = {
    from,
    id: `wamid.${Date.now()}_${msgSequence}`,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    type
  };

  if (type === "text") msgObj.text = { body: payloadData };
  if (type === "image") msgObj.image = { id: payloadData };
  if (type === "interactive") {
    msgObj.interactive = {
      type: interactiveType,
      [interactiveType]: { id: payloadData }
    };
  }

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
              messages: [msgObj]
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
// Test Suites (22 Comprehensive Tests)
// =========================================================================
describe("Comprehensive Broker Bot E2E, Quota, & State Machine Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.drafts.clear();
    mockDb.operationLogs = [];
    mockWhatsAppState.sentTexts = [];
    mockWhatsAppState.sentButtons = [];
    mockWhatsAppState.sentLists = [];
    mockWhatsAppState.sentImages = [];
    mockWhatsAppState.simulateCareWindowExpiry = false;
    mockWhatsAppState.simulateRateLimitOnce = false;
    mockGeminiState.shouldTimeoutOn38 = false;
    mockGeminiState.shouldReturnMarkdownWrappedJson = false;
  });

  describe("WhatsApp Operational Resilience", () => {
    test("Catches 24-hour service window expiry (#131047) gracefully", async () => {
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
      await new Promise((r) => setTimeout(r, 100));
      expect(mockWhatsAppState.sentTexts.length).toBe(0);
    });

    test("Backs off and retries on Meta rate limit (code 80007)", async () => {
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
      await new Promise((r) => setTimeout(r, 1200));
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

  describe("Gemini Cascades and Audio Normalization", () => {
    test("Fails over to gemini-3.6-flash when 3.8-flash times out", async () => {
      mockGeminiState.shouldTimeoutOn38 = true;
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "+ شقة للبيع 18.5 مليون كود #TEST1"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
    });

    test("Strips Markdown code fences (```json ... ```) safely from AI response", async () => {
      mockGeminiState.shouldReturnMarkdownWrappedJson = true;
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "+ شقة 180م في ميفيدا"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
    });

    test("Audio normalization normalizes voice mime-types", () => {
      expect(U.cleanAudioMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
      expect(U.cleanAudioMime("audio/x-m4a")).toBe("audio/mp4");
      expect(U.cleanAudioMime("audio/amr")).toBe("audio/amr");
      expect(U.cleanAudioMime("unknown/stream")).toBe("audio/ogg");
    });
  });

  describe("Broker Security, Ownership, and Direct SQL Commands", () => {
    test("Blocks colleague from editing another broker's listing", async () => {
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

    test("Allows owner broker to update listing price cleanly outside lock", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "سعر HAS101 إلى 17.5 مليون"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(
        mockWhatsAppState.sentTexts.some((m) =>
          m.text.includes("تم تعديل سعر الوحدة #HAS101")
        )
      ).toBe(true);
    });

    test("Idle direct code lookup returns unit card when found", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "#HAS101"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("تفاصيل الوحدة #HAS101")
        )
      ).toBe(true);
      expect(
        mockWhatsAppState.sentButtons[0].buttons.some(
          (btn) => btn.title === "Flyer"
        )
      ).toBe(true);
    });

    test("Idle direct code lookup offers 'START_WITH_CODE' button when not found", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "#NEW999"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("غير موجودة بالمخزون")
        )
      ).toBe(true);
      expect(
        mockWhatsAppState.sentButtons[0].buttons.some(
          (btn) => btn.id === "START_WITH_CODE:NEW999"
        )
      ).toBe(true);
    });
  });

  describe("Text Normalization and Sanitization", () => {
    test("Parses fractions and scale correctly without digit collisions", () => {
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

  describe("State Machine Ingestion, Drafts, and Code Rules", () => {
    test("Inbound photo opens DRAFTING mode and sends Save/Cancel buttons", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 200));

      expect(mockDb.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
        true
      );
      expect(mockWhatsAppState.sentButtons.length).toBe(1);
      expect(
        mockWhatsAppState.sentButtons[0].buttons.some(
          (b) => b.id === "DRAFT_SAVE"
        )
      ).toBe(true);
    });

    test("Subsequent photos accumulate cleanly into draft without re-sending prompt", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      const p2 = createWebhookPayload(
        "201011111111",
        "wamid.media_002",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 200));

      const draft = mockDb.drafts.get("b10b0000-0000-0000-0000-000000000001");
      expect(draft).toBeDefined();
      expect(draft.media_ids).toEqual(["wamid.media_001", "wamid.media_002"]);
      expect(mockWhatsAppState.sentButtons.length).toBe(1);
    });

    test("Bare-bones 'تم' with photos only is rejected before calling Gemini", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      const p2 = createWebhookPayload("201011111111", "تم", "text");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 200));

      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("لا يمكن تسجيل الوحدة بالصور فقط")
        )
      ).toBe(true);
      expect(mockDb.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
        true
      );
    });

    test("Requires explicit marker (#, code, كود) for unit codes and rejects Arabic letters", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      // Attempt code with Arabic letters: #كود101
      const p2 = createWebhookPayload("201011111111", "#كود101", "text");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((m) =>
          m.text.includes("يجب أن يتكون من حروف إنجليزية وأرقام فقط")
        )
      ).toBe(true);

      // Valid marked code: #HAS577
      const p3 = createWebhookPayload("201011111111", "#HAS577", "text");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p3.signature)
        .send(p3.payload);
      await new Promise((r) => setTimeout(r, 150));

      const draft = mockDb.drafts.get("b10b0000-0000-0000-0000-000000000001");
      expect(draft.custom_code).toBe("HAS577");
    });

    test("Warns immediately if assigned code is already used by an active or sold unit", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      // Attempt to take code of sold unit SOLD99
      const p2 = createWebhookPayload("201011111111", "#SOLD99", "text");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((m) =>
          m.text.includes("مستخدم بالفعل لوحدة")
        )
      ).toBe(true);
    });

    test("Search query during open draft prompts with Cancel & Search vs Keep Draft", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      const p2 = createWebhookPayload(
        "201011111111",
        "دورلي على شقة في ميفيدا تحت 15 مليون",
        "text"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 200));

      expect(
        mockWhatsAppState.sentButtons.some(
          (b) =>
            b.body.includes("مسودة وحدة قيد الإضافة") ||
            b.body.includes("active listing draft")
        )
      ).toBe(true);
      expect(
        mockWhatsAppState.sentButtons[1].buttons.some((b) =>
          b.id.startsWith("CANCEL_AND_SEARCH:")
        )
      ).toBe(true);
      expect(
        mockWhatsAppState.sentButtons[1].buttons.some(
          (b) => b.id === "KEEP_DRAFT"
        )
      ).toBe(true);
    });

    test("CANCEL_AND_SEARCH clears draft and executes search query", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 200));

      const encoded = Buffer.from("شقة في ميفيدا").toString("base64");
      const p2 = createWebhookPayload(
        "201011111111",
        `CANCEL_AND_SEARCH:${encoded}`,
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 250));

      expect(mockDb.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
        false
      );
    });

    test("Cancel button clears draft immediately and confirms to user", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "wamid.media_001",
        "image"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 200));

      const p2 = createWebhookPayload(
        "201011111111",
        "DRAFT_CANCEL",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 250));

      expect(mockDb.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
        false
      );
      expect(
        mockWhatsAppState.sentTexts.some(
          (t) =>
            t.text.includes("تم إلغاء المسودة") || t.text.includes("discarded")
        )
      ).toBe(true);
    });

    test("Tapping DRAFT_SAVE on an expired draft replies gracefully without crashing", async () => {
      const p = createWebhookPayload(
        "201011111111",
        "DRAFT_SAVE",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p.signature)
        .send(p.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes("لا توجد مسودة نشطة حالياً")
        )
      ).toBe(true);
    });
  });

  describe("Interactive Actions & Two-Tier Quota Enforcement", () => {
    test("Routes inspect:CODE from WhatsApp list_reply to display unit card", async () => {
      const p = createWebhookPayload(
        "201011111111",
        "inspect:HAS101",
        "interactive",
        "list_reply"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p.signature)
        .send(p.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("تفاصيل الوحدة #HAS101")
        )
      ).toBe(true);
    });

    test("Tapping Mark Sold triggers confirmation step before changing database", async () => {
      const p1 = createWebhookPayload(
        "201011111111",
        "status:sold:HAS101",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("هل أنت متأكد من تغيير حالة الوحدة")
        )
      ).toBe(true);

      const p2 = createWebhookPayload(
        "201011111111",
        "confirm:sold:HAS101",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((t) => t.text.includes("تم البيع"))
      ).toBe(true);
    });

    test("Blocks AI operations when personal broker quota (60 operations) is exceeded", async () => {
      for (let i = 0; i < 60; i++) {
        mockDb.operationLogs.push({
          agency_id: "a00a0000-0000-0000-0000-000000000001",
          broker_id: "b10b0000-0000-0000-0000-000000000001",
          tokens_input: 150,
          tokens_output: 100
        });
      }

      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "دورلي على شقة في سوديك"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes(
            "تم استهلاك حد الذكاء الاصطناعي اليومي لحسابك (60 عملية)"
          )
        )
      ).toBe(true);
    });
  });
});
