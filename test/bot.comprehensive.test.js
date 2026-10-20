// test/bot.comprehensive.test.js
"use strict";

const crypto = require("crypto");
const request = require("supertest");

process.env.NODE_ENV = "test";
process.env.PORT = "3003";
process.env.WHATSAPP_APP_SECRET = "test_app_secret_123456";
process.env.WHATSAPP_VERIFY_TOKEN = "verify_token_abc";
process.env.WHATSAPP_ACCESS_TOKEN = "mock_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.GEMINI_API_KEY = "mock_gemini_key";

const mockDbState = {
  drafts: new Map(),
  listings: []
};

jest.mock("../lib/db", () => ({
  pool: {
    query: jest.fn().mockImplementation(async (sql, params = []) => {
      const q = String(sql).toLowerCase();
      if (q.includes("select 1")) return { rows: [{ 1: 1 }], rowCount: 1 };

      // Broker lookup
      if (q.includes("from brokers where phone_normalized")) {
        return {
          rows: [
            {
              id: "b10b0000-0000-0000-0000-000000000001",
              agency_id: "a00a0000-0000-0000-0000-000000000001",
              name: "Ahmed Agent",
              phone: "+201011111111",
              phone_normalized: "201011111111",
              is_active: true,
              preferred_lang: "ar"
            }
          ],
          rowCount: 1
        };
      }

      // Draft lookups
      if (q.includes("from listing_drafts where broker_id = $1")) {
        const d = mockDbState.drafts.get(params[0]);
        return { rows: d ? [d] : [], rowCount: d ? 1 : 0 };
      }

      if (q.includes("delete from listing_drafts")) {
        mockDbState.drafts.delete(params[0]);
        return { rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockImplementation(async (sql, params = []) => {
        const q = String(sql).toLowerCase();
        if (
          q.includes("begin") ||
          q.includes("commit") ||
          q.includes("rollback")
        )
          return {};

        if (q.includes("select * from listing_drafts where broker_id")) {
          const d = mockDbState.drafts.get(params[0]);
          return { rows: d ? [d] : [], rowCount: d ? 1 : 0 };
        }

        if (q.includes("insert into listing_drafts")) {
          const newDraft = {
            broker_id: params[0],
            agency_id: params[1],
            broker_phone: params[2],
            media_ids: params[3],
            voice_ids: params[4],
            texts: params[5],
            custom_code: params[6]
          };
          mockDbState.drafts.set(params[0], newDraft);
          return { rows: [newDraft], rowCount: 1 };
        }

        if (q.includes("update listing_drafts")) {
          const draft = mockDbState.drafts.get(params[4]);
          if (draft) {
            draft.media_ids = params[0];
            draft.voice_ids = params[1];
            draft.texts = params[2];
            draft.custom_code = params[3];
          }
          return { rows: [draft], rowCount: 1 };
        }

        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn()
    })
  }
}));

const mockWA = {
  sentTexts: [],
  sentButtons: []
};

jest.mock("../lib/whatsapp", () => ({
  sendWhatsAppText: jest.fn().mockImplementation((to, text) => {
    mockWA.sentTexts.push({ to, text });
    return Promise.resolve({ messages: [{ id: "wamid.text" }] });
  }),
  sendWhatsAppButtons: jest.fn().mockImplementation((to, body, buttons) => {
    mockWA.sentButtons.push({ to, body, buttons });
    return Promise.resolve({ messages: [{ id: "wamid.btn" }] });
  }),
  downloadWhatsAppMedia: jest.fn().mockResolvedValue({
    buffer: Buffer.from("fake-img"),
    mimeType: "image/jpeg"
  })
}));

const { app } = require("../server");

function signPayload(body) {
  const json = JSON.stringify(body);
  const signature = crypto
    .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
    .update(json)
    .digest("hex");
  return `sha256=${signature}`;
}

function sendMsg(type, payloadData) {
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "201000000000" },
              contacts: [{ wa_id: "201011111111" }],
              messages: [
                {
                  from: "201011111111",
                  id: `wamid.${Date.now()}`,
                  type,
                  ...(type === "text" ? { text: { body: payloadData } } : {}),
                  ...(type === "image" ? { image: { id: payloadData } } : {}),
                  ...(type === "interactive"
                    ? { interactive: { button_reply: { id: payloadData } } }
                    : {})
                }
              ]
            },
            field: "messages"
          }
        ]
      }
    ]
  };

  return request(app)
    .post("/webhook")
    .set("x-hub-signature-256", signPayload(body))
    .send(body);
}

describe("State Machine Ingestion and Search Segregation", () => {
  beforeEach(() => {
    mockDbState.drafts.clear();
    mockWA.sentTexts = [];
    mockWA.sentButtons = [];
    jest.clearAllMocks();
  });

  test("Inbound image opens DRAFTING mode and sends Save/Cancel buttons", async () => {
    const res = await sendMsg("image", "wamid.media_001");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    // Draft created in DB
    expect(mockDbState.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
      true
    );
    // Button prompt dispatched
    expect(mockWA.sentButtons.length).toBe(1);
    expect(
      mockWA.sentButtons[0].buttons.some((b) => b.id === "DRAFT_SAVE")
    ).toBe(true);
  });

  test("Subsequent photos accumulate without re-triggering new prompts", async () => {
    // 1st photo
    await sendMsg("image", "wamid.media_001");
    // 2nd photo
    await sendMsg("image", "wamid.media_002");
    await new Promise((r) => setTimeout(r, 100));

    const draft = mockDbState.drafts.get(
      "b10b0000-0000-0000-0000-000000000001"
    );
    expect(draft.media_ids).toEqual(["wamid.media_001", "wamid.media_002"]);
    expect(mockWA.sentButtons.length).toBe(1); // Only 1 prompt sent on start
  });

  test("Bare-bones 'تم' with photos only is rejected with instructions", async () => {
    // Photo arrives
    await sendMsg("image", "wamid.media_001");
    // Broker texts 'تم' without sending text or voice
    await sendMsg("text", "تم");
    await new Promise((r) => setTimeout(r, 100));

    expect(
      mockWA.sentButtons.some((b) =>
        b.body.includes("لا يمكن تسجيل الوحدة بالصور فقط")
      )
    ).toBe(true);
    // Draft remains open
    expect(mockDbState.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
      true
    );
  });

  test("Search query during open draft asks user to confirm swap or keep draft", async () => {
    // Draft open with 1 photo
    await sendMsg("image", "wamid.media_001");
    // Broker sends search query
    await sendMsg("text", "دورلي على شقة في ميفيدا تحت 15 مليون");
    await new Promise((r) => setTimeout(r, 100));

    expect(
      mockWA.sentButtons.some((b) =>
        b.body.includes("لديك مسودة وحدة قيد الإضافة حالياً")
      )
    ).toBe(true);
  });

  test("Cancel button discards the draft immediately", async () => {
    await sendMsg("image", "wamid.media_001");
    await sendMsg("interactive", "DRAFT_CANCEL");
    await new Promise((r) => setTimeout(r, 100));

    expect(mockDbState.drafts.has("b10b0000-0000-0000-0000-000000000001")).toBe(
      false
    );
    expect(
      mockWA.sentTexts.some((t) => t.text.includes("تم إلغاء المسودة"))
    ).toBe(true);
  });
});
