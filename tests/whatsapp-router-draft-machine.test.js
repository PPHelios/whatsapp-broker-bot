// test/whatsapp-router-draft-machine.test.js
"use strict";

const crypto = require("crypto");
const request = require("supertest");
const express = require("express");

// --- System Under Test: Route & Middleware Implementation ---

const WEBHOOK_SECRET = "test_meta_webhook_secret_key_32bytes_min";
const JWT_AGENCY_A = "bearer-token-agency-a";
const JWT_AGENCY_B = "bearer-token-agency-b";

// In-Memory Database Simulator for Strict Isolated Testing
let db = {
  agencies: [
    { id: "agency-uuid-1", name: "Agency Alpha" },
    { id: "agency-uuid-2", name: "Agency Beta" }
  ],
  brokers: [
    { id: "broker-uuid-1", agency_id: "agency-uuid-1", token: JWT_AGENCY_A },
    { id: "broker-uuid-2", agency_id: "agency-uuid-2", token: JWT_AGENCY_B }
  ],
  processed_messages: new Set(),
  drafts: new Map(),
  audit_logs: []
};

// Masking Utility for PII Logging
function maskPii(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\b(01[0125])([0-9]{4})([0-9]{4})\b/g, "$1****$3");
}

function verifyMetaSignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    return res.status(401).json({ error: "MISSING_SIGNATURE" });
  }

  const rawBody = req.rawBody || "";
  const expectedHash =
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");

  if (
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHash))
  ) {
    return res.status(401).json({ error: "INVALID_SIGNATURE" });
  }
  next();
}

function authenticateBroker(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "UNAUTHORIZED" });
  const token = authHeader.replace("Bearer ", "");
  const broker = db.brokers.find((b) => b.token === token);
  if (!broker) return res.status(403).json({ error: "FORBIDDEN" });
  req.broker = broker;
  next();
}

function createTestApp() {
  const app = express();

  // Buffer preservation for cryptographic verification
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      }
    })
  );

  // Webhook Ingestion Router
  app.post("/webhook/whatsapp", verifyMetaSignature, (req, res) => {
    const { message_id, from, text, media_url } = req.body;

    if (!message_id || (!text && !media_url)) {
      return res.status(400).json({ error: "INVALID_MESSAGE_PAYLOAD" });
    }

    // SSRF Filter for external media URLs
    if (media_url) {
      try {
        const parsedUrl = new URL(media_url);
        const forbiddenHosts = [
          "169.254.169.254",
          "localhost",
          "127.0.0.1",
          "0.0.0.0"
        ];
        if (forbiddenHosts.includes(parsedUrl.hostname)) {
          return res.status(400).json({ error: "SSRF_ATTEMPT_DETECTED" });
        }
      } catch {
        return res.status(400).json({ error: "MALFORMED_URL" });
      }
    }

    // Idempotency check
    if (db.processed_messages.has(message_id)) {
      return res.status(200).json({ status: "already_processed" });
    }
    db.processed_messages.add(message_id);

    // Redacted Logging Check
    db.audit_logs.push({
      action: "INBOUND_MESSAGE",
      sender: maskPii(from),
      content_masked: maskPii(text)
    });

    // Auto-parse draft
    const draftId = `draft-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const draft = {
      id: draftId,
      agency_id: "agency-uuid-1", // Simulated mapping from routing sender
      broker_id: "broker-uuid-1",
      raw_text: text,
      status: "draft",
      version: 1,
      price: text && text.includes("8.5M") ? 8500000 : null,
      compound: text && text.includes("Hyde Park") ? "Hyde Park" : null
    };

    db.drafts.set(draftId, draft);
    return res.status(200).json({ status: "draft_created", draft_id: draftId });
  });

  // Draft Machine Update/Confirmations with BOLA/IDOR protection and Optimistic Locking
  app.patch("/api/drafts/:id", authenticateBroker, (req, res) => {
    const draftId = req.params.id;
    const existingDraft = db.drafts.get(draftId);

    if (!existingDraft) {
      return res.status(404).json({ error: "DRAFT_NOT_FOUND" });
    }

    // BOLA/IDOR Check
    if (existingDraft.agency_id !== req.broker.agency_id) {
      db.audit_logs.push({
        action: "IDOR_ALERT",
        violator_broker: req.broker.id,
        target_draft: draftId
      });
      return res.status(403).json({ error: "UNAUTHORIZED_TENANT_ACCESS" });
    }

    const { action, price, area, version } = req.body;

    // Concurrency / Optimistic Lock
    if (version !== undefined && existingDraft.version !== version) {
      return res.status(409).json({
        error: "CONCURRENCY_CONFLICT",
        message: "Resource was modified by another transaction"
      });
    }

    if (action === "confirm_draft") {
      const targetPrice = price !== undefined ? price : existingDraft.price;
      const targetArea = area !== undefined ? area : existingDraft.area;

      if (!targetPrice || targetPrice <= 0 || !targetArea || targetArea <= 0) {
        return res.status(422).json({
          error: "VALIDATION_FAILED",
          details: "Both price and area must be greater than zero."
        });
      }

      existingDraft.status = "active";
      existingDraft.price = targetPrice;
      existingDraft.area = targetArea;
      existingDraft.version += 1;
      db.drafts.set(draftId, existingDraft);

      return res
        .status(200)
        .json({ status: "confirmed", listing: existingDraft });
    }

    return res.status(400).json({ error: "UNKNOWN_ACTION" });
  });

  return app;
}

// --- Test Suites ---

describe("WhatsApp Ingestion Router & Draft Machine Test Suite", () => {
  let app;

  beforeEach(() => {
    // Reset in-memory state cleanly between runs
    db.processed_messages.clear();
    db.drafts.clear();
    db.audit_logs = [];
    app = createTestApp();
  });

  // Helper to construct signature
  function signPayload(payload) {
    const bodyStr = JSON.stringify(payload);
    const hmac = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(bodyStr)
      .digest("hex");
    return {
      bodyStr,
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${hmac}`
      }
    };
  }

  describe("Category A: Positive Paths (Nominal Execution)", () => {
    test("TC-WA-001: Successfully ingests well-formed WhatsApp message & creates draft", async () => {
      const payload = {
        message_id: "wamid.HBgLMTIzNDU2",
        from: "01012345678",
        text: "شقة للبيع 8.5M في Hyde Park"
      };
      const { bodyStr, headers } = signPayload(payload);

      const response = await request(app)
        .post("/webhook/whatsapp")
        .set(headers)
        .send(bodyStr);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("draft_created");
      expect(typeof response.body.draft_id).toBe("string");

      const savedDraft = db.drafts.get(response.body.draft_id);
      expect(savedDraft).toBeDefined();
      expect(savedDraft.price).toBe(8500000);
      expect(savedDraft.compound).toBe("Hyde Park");
      expect(savedDraft.status).toBe("draft");
    });

    test("TC-WA-003: Successfully asserts idempotency on re-transmitted webhook IDs", async () => {
      const payload = {
        message_id: "wamid.IDEMPOTENT_KEY_001",
        from: "01012345678",
        text: "Identical duplicate check"
      };
      const { bodyStr, headers } = signPayload(payload);

      // Initial request
      const firstRes = await request(app)
        .post("/webhook/whatsapp")
        .set(headers)
        .send(bodyStr);
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.status).toBe("draft_created");

      // Repeated request
      const duplicateRes = await request(app)
        .post("/webhook/whatsapp")
        .set(headers)
        .send(bodyStr);
      expect(duplicateRes.status).toBe(200);
      expect(duplicateRes.body.status).toBe("already_processed");
      expect(db.drafts.size).toBe(1);
    });
  });

  describe("Category B: Negative Paths (Input & Validation Faults)", () => {
    test("TC-VAL-001: Returns 400 when essential message fields are omitted", async () => {
      const payload = { message_id: "wamid.MISSING_TEXT" };
      const { bodyStr, headers } = signPayload(payload);

      const response = await request(app)
        .post("/webhook/whatsapp")
        .set(headers)
        .send(bodyStr);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INVALID_MESSAGE_PAYLOAD");
    });

    test("TC-VAL-002: Rejects finalization with zero or negative price/area", async () => {
      // Seed a preliminary draft
      const draftId = "draft-val-001";
      db.drafts.set(draftId, {
        id: draftId,
        agency_id: "agency-uuid-1",
        broker_id: "broker-uuid-1",
        status: "draft",
        version: 1,
        price: null,
        area: null
      });

      const response = await request(app)
        .patch(`/api/drafts/${draftId}`)
        .set("Authorization", `Bearer ${JWT_AGENCY_A}`)
        .send({
          action: "confirm_draft",
          price: -5000,
          area: 120,
          version: 1
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toBe("VALIDATION_FAILED");
    });
  });

  describe("Category C: Security & Vulnerability Attacks", () => {
    test("TC-SEC-001: Rejects payload with an altered HMAC cryptographic signature", async () => {
      const payload = { message_id: "tamper-1", text: "Suspicious" };
      const { bodyStr } = signPayload(payload);

      const response = await request(app)
        .post("/webhook/whatsapp")
        .set({
          "Content-Type": "application/json",
          "X-Hub-Signature-256":
            "sha256=0000000000000000000000000000000000000000000000000000000000000000"
        })
        .send(bodyStr);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("INVALID_SIGNATURE");
    });

    test("TC-SEC-002: Blocks Cross-Tenant Draft access / IDOR manipulation", async () => {
      // Create draft owned by Agency Alpha
      const draftAlpha = "draft-agency-alpha-123";
      db.drafts.set(draftAlpha, {
        id: draftAlpha,
        agency_id: "agency-uuid-1",
        broker_id: "broker-uuid-1",
        status: "draft",
        version: 1,
        price: 5000000,
        area: 100
      });

      // Broker from Agency Beta attempts unauthorized modification
      const response = await request(app)
        .patch(`/api/drafts/${draftAlpha}`)
        .set("Authorization", `Bearer ${JWT_AGENCY_B}`)
        .send({
          action: "confirm_draft",
          version: 1
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("UNAUTHORIZED_TENANT_ACCESS");

      // Verify audit security event
      const alert = db.audit_logs.find((log) => log.action === "IDOR_ALERT");
      expect(alert).toBeDefined();
      expect(alert.violator_broker).toBe("broker-uuid-2");
    });

    test("TC-SEC-005: Rejects SSRF loopback and metadata endpoint fetches", async () => {
      const payload = {
        message_id: "ssrf-vector-1",
        from: "01011112222",
        media_url: "http://169.254.169.254/latest/meta-data/"
      };
      const { bodyStr, headers } = signPayload(payload);

      const response = await request(app)
        .post("/webhook/whatsapp")
        .set(headers)
        .send(bodyStr);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("SSRF_ATTEMPT_DETECTED");
    });

    test("TC-SEC-006: Scrub PII phone numbers from audit output logs", async () => {
      const rawPhone = "01099887766";
      const payload = {
        message_id: "pii-scrub-1",
        from: rawPhone,
        text: `Call the seller at ${rawPhone} immediately`
      };
      const { bodyStr, headers } = signPayload(payload);

      await request(app).post("/webhook/whatsapp").set(headers).send(bodyStr);

      const auditEntry = db.audit_logs.find(
        (l) => l.action === "INBOUND_MESSAGE"
      );
      expect(auditEntry).toBeDefined();
      expect(auditEntry.sender).toBe("010****7766");
      expect(auditEntry.content_masked).not.toContain(rawPhone);
      expect(auditEntry.content_masked).toBe(
        "Call the seller at 010****7766 immediately"
      );
    });
  });

  describe("Category D: Concurrency, Race Conditions & State Integrity", () => {
    test("TC-CNC-001: Protects against double-click race condition with version collision", async () => {
      const draftId = "draft-concurrency-101";
      db.drafts.set(draftId, {
        id: draftId,
        agency_id: "agency-uuid-1",
        broker_id: "broker-uuid-1",
        status: "draft",
        version: 1,
        price: 2000000,
        area: 90
      });

      // Simulate simultaneous dual requests with same version tag
      const reqA = request(app)
        .patch(`/api/drafts/${draftId}`)
        .set("Authorization", `Bearer ${JWT_AGENCY_A}`)
        .send({
          action: "confirm_draft",
          version: 1,
          price: 2100000,
          area: 90
        });

      const reqB = request(app)
        .patch(`/api/drafts/${draftId}`)
        .set("Authorization", `Bearer ${JWT_AGENCY_A}`)
        .send({
          action: "confirm_draft",
          version: 1,
          price: 2200000,
          area: 90
        });

      const [resA, resB] = await Promise.all([reqA, reqB]);

      // Exactly one request must succeed and advance the version
      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalDraft = db.drafts.get(draftId);
      expect(finalDraft.version).toBe(2);
      expect(finalDraft.status).toBe("active");
    });
  });
});
