// tests/unit/ai-gateway.test.js — Hedged multi-model gateway: routing, thinking per model, deadlines, telemetry
"use strict";

const AI = require("../../lib/ai");
const { estimateCostUsd } = require("../../config");
const [M1, M2, M3] = AI.TIERS;

// Fake SDK client: behaviour per model is "ok", "fail", "hang" or a delay in ms before answering.
function fakeClient(behaviour) {
  const calls = [];
  return {
    calls,
    models: {
      generateContent: ({ model, config }) => {
        calls.push({ model, config });
        const b = behaviour[model] ?? "ok";
        return new Promise((resolve, reject) => {
          const answer = () =>
            resolve({ text: `from ${model}`, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 } });
          config.abortSignal.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
          if (b === "ok") answer();
          else if (b === "fail") reject(Object.assign(new Error("503 UNAVAILABLE high demand"), { status: 503 }));
          else if (typeof b === "number") setTimeout(answer, b);
          // "hang": never settles unless aborted
        });
      }
    }
  };
}

// Fast test route so hedging/deadline behaviour runs in milliseconds.
AI.ROUTES.test_fast = { deadlineMs: 600, hedgeAfterMs: 100, thinking: "fast" };
AI.ROUTES.test_default = { deadlineMs: 600, hedgeAfterMs: 100, thinking: "default" };

const logged = [];
const quotaChecks = [];
const ctx = {
  pool: {
    query: async (sql, params) => {
      if (/^\s*INSERT/i.test(sql)) logged.push(params);
      else quotaChecks.push(params);
      return { rows: [{ broker_count: 0, agency_count: 0 }] };
    }
  },
  broker: { id: "b1", agency_id: "a1" }
};
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(async () => {
  await flush(); // telemetry from a previous test is written asynchronously
  logged.length = 0;
});
afterEach(() => AI._setClientForTests(null));

test("primary answers: one attempt, model-specific fast thinking applied", async () => {
  const client = fakeClient({});
  AI._setClientForTests(client);
  const r = await AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx });
  expect(r.modelUsed).toBe(M1);
  expect(client.calls).toHaveLength(1);
  expect(client.calls[0].config.thinkingConfig).toEqual(AI.FAST_THINKING[M1]);
});

test("default route sends no thinkingConfig (model keeps its own setting)", async () => {
  const client = fakeClient({});
  AI._setClientForTests(client);
  await AI.generateWithCascade({ contents: "q", operationType: "test_default", ctx });
  expect(client.calls[0].config.thinkingConfig).toBeUndefined();
});

test("slow primary: the next tier is hedged in parallel and wins; the slow one is aborted", async () => {
  AI._setClientForTests(fakeClient({ [M1]: "hang", [M2]: "ok" }));
  const t0 = Date.now();
  const r = await AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx });
  expect(r.modelUsed).toBe(M2);
  expect(Date.now() - t0).toBeLessThan(400);
  expect(r.attempts.map((a) => [a.model, a.outcome])).toEqual([
    [M1, "aborted"],
    [M2, "ok"]
  ]);
});

test("hard failure moves to the next tier immediately (no hedge wait)", async () => {
  AI._setClientForTests(fakeClient({ [M1]: "fail", [M2]: "ok" }));
  const t0 = Date.now();
  const r = await AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx });
  expect(r.modelUsed).toBe(M2);
  expect(Date.now() - t0).toBeLessThan(80);
  expect(r.attempts[0].outcome).toBe("overloaded");
});

test("all tiers fail: throws and logs a failed call with every attempt", async () => {
  AI._setClientForTests(fakeClient({ [M1]: "fail", [M2]: "fail", [M3]: "fail" }));
  await expect(AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx })).rejects.toThrow(/503/);
  await flush();
  const [row] = logged;
  expect(row[3]).toBe("failed");
  expect(JSON.parse(row[11]).attempts).toHaveLength(3);
});

test("everything hangs: the call fails at the route deadline", async () => {
  AI._setClientForTests(fakeClient({ [M1]: "hang", [M2]: "hang", [M3]: "hang" }));
  const t0 = Date.now();
  await expect(AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx })).rejects.toMatchObject({
    code: "AI_DEADLINE"
  });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(590);
  expect(Date.now() - t0).toBeLessThan(900);
});

test("success telemetry records model, tokens (thinking billed as output) and attempts", async () => {
  AI._setClientForTests(fakeClient({}));
  await AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx });
  await flush();
  const [agency, broker, op, status, errorCode, , , tokIn, tokOut, model, cost, meta] = logged[0];
  expect([agency, broker, op, status, errorCode]).toEqual(["a1", "b1", "test_fast", "success", null]);
  expect([tokIn, tokOut, model]).toEqual([10, 8, M1]);
  // Cost comes from config prices for the winning model.
  expect(cost).toBe(estimateCostUsd(M1, 10, 8));
  expect(JSON.parse(meta)).toMatchObject({ thoughts_tokens: 3, attempts: [{ model: M1, outcome: "ok" }] });
});

test("the daily AI quota is checked before calling Gemini and blocks when exhausted", async () => {
  AI._setClientForTests(fakeClient({}));
  quotaChecks.length = 0;
  await AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx });
  expect(quotaChecks[0].slice(0, 2)).toEqual(["a1", "b1"]);

  const client = fakeClient({});
  AI._setClientForTests(client);
  const exhausted = {
    ...ctx,
    pool: { query: async () => ({ rows: [{ broker_count: 1e6, agency_count: 1e6 }] }) }
  };
  await expect(
    AI.generateWithCascade({ contents: "q", operationType: "test_fast", ctx: exhausted })
  ).rejects.toMatchObject({ code: "BROKER_QUOTA_EXCEEDED" });
  expect(client.calls).toHaveLength(0);
});

test("every model has a fast-thinking setting it accepts (MINIMAL is not valid on gemini-3.8-flash)", () => {
  for (const m of AI.TIERS) expect(AI.FAST_THINKING[m]).toBeDefined();
  expect(AI.FAST_THINKING["gemini-3.8-flash"].thinkingLevel).not.toBe("MINIMAL");
});

test("routing: text-only calls start on Flash-Lite, audio and images on 3.6 Flash", async () => {
  expect(AI.TEXT_TIERS[0]).toBe("gemini-3.5-flash-lite");
  expect(AI.MEDIA_TIERS[0]).toBe("gemini-3.6-flash");
  const audio = [{ role: "user", parts: [{ text: "p" }, { inlineData: { mimeType: "audio/ogg", data: "x" } }] }];
  const image = [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: "x" } }] }];
  const text = [{ role: "user", parts: [{ text: "p" }] }];
  expect(AI.hasMedia(audio)).toBe(true);
  expect(AI.hasMedia(image)).toBe(true);
  expect(AI.hasMedia(text)).toBe(false);
  expect(AI.hasMedia("plain prompt")).toBe(false);

  const client = fakeClient({});
  AI._setClientForTests(client);
  await AI.generateWithCascade({ contents: audio, operationType: "listing_extraction", ctx });
  await AI.generateWithCascade({ contents: text, operationType: "listing_extraction", ctx });
  await AI.generateWithCascade({ contents: text, operationType: "search_parse", ctx });
  expect(client.calls.map((c) => c.model)).toEqual([
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash-lite"
  ]);
  // Draft extraction now uses the per-model fast thinking the eval measured.
  expect(client.calls[0].config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
});

test("routing: a route can pin its own chain", () => {
  const route = { tiers: ["gemini-3.8-flash"] };
  expect(AI.tiersFor(route, "q")).toEqual(["gemini-3.8-flash"]);
});
