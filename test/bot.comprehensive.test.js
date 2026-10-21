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
function getInitialListings() {
  return [
    {
      id: "l101-0000-0000",
      agency_id: "a00a0000-0000-0000-0000-000000000001",
      broker_id: "b10b0000-0000-0000-0000-000000000001",
      code: "HAS101",
      title: "شقة في ميفيدا",
      price_value: 15000000,
      price_display: "15M EGP",
      property_type: "apartment",
      listing_type: "sale",
      location: "ميفيدا، القاهرة الجديدة",
      compound: "ميفيدا",
      bedrooms: 3,
      area_value: 180,
      status: "active",
      details: {
        currency: "EGP",
        bathrooms: 2,
        floor: "الدور الثالث",
        floor_en: "3rd Floor",
        finishing: "الترا سوبر لوكس",
        finishing_en: "Ultra Super Lux",
        has_master_bedroom: true,
        has_dressing_room: true,
        nanny_room: true
      },
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
      price_display: "30M EGP",
      property_type: "villa",
      listing_type: "sale",
      location: "بالميرا",
      compound: "بالميرا",
      status: "sold",
      details: {},
      updated_at: new Date().toISOString()
    },
    // Seed 5 additional active units to ensure 6 total matching units (5 on page 1 + 1 on page 2)
    ...[2, 3, 4, 5, 6].map((i) => ({
      id: `l10${i}-0000-0000`,
      agency_id: "a00a0000-0000-0000-0000-000000000001",
      broker_id: "b10b0000-0000-0000-0000-000000000001",
      code: `HAS10${i}`,
      title: `شقة ${i} في ميفيدا`,
      price_value: 15000000 + i * 500000,
      price_display: `${15 + i * 0.5}M EGP`,
      property_type: "apartment",
      listing_type: "sale",
      location: "ميفيدا، القاهرة الجديدة",
      compound: "ميفيدا",
      bedrooms: 3,
      area_value: 180 + i * 10,
      status: "active",
      details: {
        currency: "EGP",
        bathrooms: 2,
        floor: "الدور الثاني",
        floor_en: "2nd Floor",
        finishing: "تشطيب كامل",
        finishing_en: "Fully Finished",
        has_master_bedroom: true,
        has_dressing_room: false,
        nanny_room: true
      },
      flyer_cache: {},
      updated_at: new Date().toISOString()
    }))
  ];
}

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
  listings: getInitialListings(),
  drafts: new Map(),
  searchState: new Map(),
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

      // Search State Retrieval & Upsert
      if (q.includes("from broker_search_state where phone_key = $1")) {
        const st = mockDb.searchState.get(params[0]);
        return { rows: st ? [st] : [], rowCount: st ? 1 : 0 };
      }
      if (q.includes("insert into broker_search_state")) {
        mockDb.searchState.set(params[0], {
          phone_key: params[0],
          parsed: params[1],
          next_offset: params[2]
        });
        return { rowCount: 1 };
      }

      // Search Query Mock (5 units per page)
      if (
        q.includes("from listings l") &&
        q.includes("where l.agency_id = $1 and l.status = 'active'")
      ) {
        const activeListings = mockDb.listings.filter(
          (l) => l.agency_id === params[0] && l.status === "active"
        );
        const limit =
          typeof params[params.length - 2] === "number"
            ? params[params.length - 2]
            : 5;
        const offset =
          typeof params[params.length - 1] === "number"
            ? params[params.length - 1]
            : 0;
        const paged = activeListings
          .slice(offset, offset + limit)
          .map((row) => ({
            ...row,
            total_count: activeListings.length
          }));
        return { rows: paged, rowCount: paged.length };
      }

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
              url: "https://storage.supabase.co/listing-images/agency_a00a0000-0000-0000-0000-000000000001/listing_HAS101/HAS101-tag-1.jpg",
              role: "reception",
              position: 0
            }
          ],
          rowCount: 1
        };
      }

      if (q.includes("delete from listings where id = $1")) {
        const idx = mockDb.listings.findIndex((l) => l.id === params[0]);
        if (idx !== -1) mockDb.listings.splice(idx, 1);
        return { rowCount: 1 };
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
        if (
          q.includes("update listings set") &&
          q.includes("price_value = $1")
        ) {
          const l = mockDb.listings.find(
            (item) => item.id === params[params.length - 1]
          );
          if (l) {
            l.price_value = params[0];
            l.price_display = params[1];
            if (params[6]) l.details = params[6];
          }
          return { rowCount: 1 };
        }
        if (q.includes("from listing_images where listing_id = $1")) {
          return {
            rows: [
              {
                url: "https://storage.supabase.co/listing-images/agency_a00a0000-0000-0000-0000-000000000001/listing_HAS101/HAS101-tag-1.jpg"
              }
            ],
            rowCount: 1
          };
        }
        if (q.includes("delete from listings where id = $1")) {
          const idx = mockDb.listings.findIndex((l) => l.id === params[0]);
          if (idx !== -1) mockDb.listings.splice(idx, 1);
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
    .mockResolvedValue(Buffer.from("mock-flyer-jpg")),
  loadFont: jest.fn().mockResolvedValue(true)
}));

const mockWhatsAppState = {
  sentTexts: [],
  sentButtons: [],
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
      currency: "EGP",
      bathrooms: 2,
      floor: "الدور الثاني",
      floor_en: "2nd Floor",
      finishing: "الترا سوبر لوكس",
      finishing_en: "Ultra Super Lux",
      has_master_bedroom: true,
      has_dressing_room: true,
      nanny_room: true,
      features: ["حمام سباحة", "شرفة"],
      features_en: ["Swimming Pool", "Balcony", "Nanny Room"],
      ambiguous_location: false
    }
  },
  patchEdit: {
    price_value: 16000000,
    currency: "EGP",
    area_value: 190,
    bedrooms: 4,
    details: {
      floor: "الدور الرابع",
      floor_en: "4th Floor"
    }
  }
};

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContent: jest
        .fn()
        .mockImplementation(async ({ model, contents }) => {
          if (
            model === "gemini-3.8-flash" &&
            mockGeminiState.shouldTimeoutOn38
          ) {
            throw new Error("gemini-3.8-flash timeout");
          }

          const promptText = JSON.stringify(contents);
          let outObj = mockGeminiState.extractedListing;

          if (promptText.includes("real estate database updater")) {
            outObj = mockGeminiState.patchEdit;
          } else if (promptText.includes("search-understanding layer")) {
            outObj = {
              intent: "search",
              filters: {
                property_types: ["apartment"],
                bedrooms_min: 3
              },
              locations: ["ميفيدا"],
              location_terms: ["ميفيدا"]
            };
          }

          let jsonStr = JSON.stringify(outObj);
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

const { app, brokerEditSessions, recentBrokerListings } = require("../server");
const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");
const { deleteStorageFiles } = require("../lib/supabase");

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
// Test Suites
// =========================================================================
describe("Comprehensive Broker Bot E2E, Quota, & State Machine Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.listings = getInitialListings(); // Full isolation across tests
    mockDb.drafts.clear();
    mockDb.searchState.clear();
    mockDb.operationLogs = [];
    mockWhatsAppState.sentTexts = [];
    mockWhatsAppState.sentButtons = [];
    mockWhatsAppState.sentImages = [];
    mockWhatsAppState.simulateCareWindowExpiry = false;
    mockWhatsAppState.simulateRateLimitOnce = false;
    mockGeminiState.shouldTimeoutOn38 = false;
    mockGeminiState.shouldReturnMarkdownWrappedJson = false;
    if (brokerEditSessions) brokerEditSessions.clear();
    if (recentBrokerListings) recentBrokerListings.clear();
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

  describe("Security, Ownership & Permissions", () => {
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
  });

  describe("Elevated Specifications & Clean Terminology", () => {
    test("Enforces 'غرفة ناني' and forbids 'خادمة' or 'maid' in feature sanitizer", () => {
      const rawFeatures = [
        "غرفة داده",
        "غرفة شغالة",
        "maid room",
        "حمام سباحة"
      ];
      const cleaned = T.cleanFeaturesList(rawFeatures);
      expect(cleaned).toContain("غرفة ناني");
      expect(cleaned).toContain("حمام سباحة");
      expect(
        cleaned.some((f) => f.includes("خادمة") || f.includes("maid"))
      ).toBe(false);
    });

    test("Formats prices compactly (e.g. 15M EGP) and supports multi-currency", () => {
      expect(T.formatAbbreviatedPrice(15000000, "EGP", "en")).toBe("15M EGP");
      expect(T.formatAbbreviatedPrice(15000000, "EGP", "ar")).toBe(
        "15 مليون ج.م"
      );
      expect(T.formatAbbreviatedPrice(1500000, "USD", "en")).toBe("1.5M USD");
      expect(T.formatAbbreviatedPrice(500000, "EUR", "en")).toBe("500K EUR");
    });
  });

  describe("Idle Code Lookups & Reserved Words", () => {
    test("Idle direct code lookup with space (e.g. 'كود HAS101' or 'code HAS101') pulls unit card", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "كود HAS101"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));

      const card = mockWhatsAppState.sentButtons.find((b) =>
        b.body.includes("تفاصيل الوحدة #HAS101")
      );
      expect(card).toBeDefined();
      expect(card.buttons.map((b) => b.title)).toEqual([
        "📄 بروشور",
        "📋 نص العميل",
        "✏️ تعديل"
      ]);
    });

    test("Standalone 'add' or 'اضافة' opens draft without treating 'add' as unit code", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "اضافة"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("تم فتح مسودة وحدة جديدة")
        )
      ).toBe(true);
      expect(
        mockWhatsAppState.sentButtons.some((b) =>
          b.body.includes("الوحدة #ADD غير موجودة")
        )
      ).toBe(false);
    });
  });

  describe("Interactive Edit Mode Session", () => {
    test("Entering edit mode via 'تعديل #HAS101' locks code and updates on follow-up message", async () => {
      const p1 = createWebhookPayload("201011111111", "تعديل #HAS101");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes("وضع التعديل نشط للوحدة #HAS101")
        )
      ).toBe(true);

      const p2 = createWebhookPayload(
        "201011111111",
        "السعر 16 مليون والمساحة 190م والدور الرابع"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 300));

      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes("تم تعديل بيانات الوحدة #HAS101 بنجاح")
        )
      ).toBe(true);
    });

    test("Entering edit mode via interactive button 'edit_btn:HAS101'", async () => {
      const p = createWebhookPayload(
        "201011111111",
        "edit_btn:HAS101",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p.signature)
        .send(p.payload);
      await new Promise((r) => setTimeout(r, 150));

      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes("وضع التعديل نشط للوحدة #HAS101")
        )
      ).toBe(true);
    });
  });

  describe("Two-Step Deletion Flow", () => {
    test("Prompt deletion requires confirmation dialog before erasing listing", async () => {
      const p1 = createWebhookPayload("201011111111", "حذف #HAS101");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p1.signature)
        .send(p1.payload);
      await new Promise((r) => setTimeout(r, 150));

      const confirmPrompt = mockWhatsAppState.sentButtons.find((b) =>
        b.buttons.some((btn) => btn.id === "confirm:delete:HAS101")
      );
      expect(confirmPrompt).toBeDefined();
      expect(confirmPrompt.body).toContain("HAS101");
      expect(confirmPrompt.body).toContain("هل أنت متأكد من حذف الوحدة");

      // Confirm deletion
      const p2 = createWebhookPayload(
        "201011111111",
        "confirm:delete:HAS101",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 200));

      expect(deleteStorageFiles).toHaveBeenCalled();
      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes("تم حذف الوحدة #HAS101 نهائياً")
        )
      ).toBe(true);
    });
  });

  describe("Search Execution: 5-Unit Card Stream & Pagination", () => {
    test("Streams 5 unit cards directly with action buttons and sends 'MORE_SEARCH' button", async () => {
      const { payload, signature } = createWebhookPayload(
        "201011111111",
        "عايز شقة 3 غرف في ميفيدا"
      );

      const res = await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", signature)
        .send(payload);

      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 2800)); // Allow 5 streamed unit cards (5 x 400ms sleep) to finish

      expect(
        mockWhatsAppState.sentTexts.some((t) =>
          t.text.includes("🔍 جاري البحث...")
        )
      ).toBe(true);
      expect(
        mockWhatsAppState.sentTexts.some((t) => t.text.includes("المخزون"))
      ).toBe(false);

      const unitCards = mockWhatsAppState.sentButtons.filter((b) =>
        b.body.includes("تفاصيل الوحدة #HAS10")
      );
      expect(unitCards.length).toBe(5);

      const moreBtnMsg = mockWhatsAppState.sentButtons.find((b) =>
        b.buttons.some((btn) => btn.id === "MORE_SEARCH")
      );
      expect(moreBtnMsg).toBeDefined();
      expect(moreBtnMsg.body).toContain("تم عرض 5 من إجمالي 6");
    });

    test("Tapping 'MORE_SEARCH' loads the next batch of units cleanly", async () => {
      mockDb.searchState.set("201011111111", {
        phone_key: "201011111111",
        parsed: {
          intent: "search",
          filters: { property_types: ["apartment"] },
          location_terms: ["ميفيدا"]
        },
        next_offset: 5
      });

      const p = createWebhookPayload(
        "201011111111",
        "MORE_SEARCH",
        "interactive"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p.signature)
        .send(p.payload);
      await new Promise((r) => setTimeout(r, 1000));

      expect(
        mockWhatsAppState.sentButtons.some((b) => b.body.includes("#HAS106"))
      ).toBe(true);
    });
  });

  describe("Finalization 3-Button Suite", () => {
    test("Finalizing listing offers Brochure, Client Text, and Edit (No 'Sold' button)", async () => {
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
        "شقة 180م في ميفيدا السعر 18.5 مليون كود #MIV77",
        "text"
      );
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p2.signature)
        .send(p2.payload);
      await new Promise((r) => setTimeout(r, 150));

      const p3 = createWebhookPayload("201011111111", "تم", "text");
      await request(app)
        .post("/webhook")
        .set("x-hub-signature-256", p3.signature)
        .send(p3.payload);
      await new Promise((r) => setTimeout(r, 400));

      const confirmMsg = mockWhatsAppState.sentButtons.find((b) =>
        b.body.includes("تم حفظ الوحدة بنجاح #MIV77")
      );
      expect(confirmMsg).toBeDefined();

      const buttonTitles = confirmMsg.buttons.map((b) => b.title);
      expect(buttonTitles).toEqual(["📄 بروشور", "📋 نص العميل", "✏️ تعديل"]);
      expect(buttonTitles).not.toContain("تم البيع");
    });
  });
});
