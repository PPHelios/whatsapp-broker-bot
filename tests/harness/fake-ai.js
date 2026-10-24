// tests/harness/fake-ai.js — Scripted stand-in for lib/ai.js (same exports)
"use strict";

const calls = []; // { operation, model, contents, config }
let responder = null; // (call) => string | object | Error

function answer(call) {
  calls.push(call);
  if (!responder) {
    throw new Error(`fake-ai: no responder set for ${call.operation}`);
  }
  const out = responder(call);
  if (out instanceof Error) throw out;
  return typeof out === "string" ? out : JSON.stringify(out);
}

const genAI = {
  models: {
    // Direct SDK calls (only the unused lib/search.js enrichLocation still calls the SDK directly)
    generateContent: async ({ model, contents, config }) => {
      const text = answer({ operation: "sdk", model, contents, config });
      return { text, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } };
    }
  }
};

module.exports = {
  // --- lib/ai.js API ---
  getGenAI: async () => genAI,
  generateWithCascade: async ({ contents, config = {}, operationType = "ai_generation" }) => {
    const text = answer({ operation: operationType, model: "fake-model", contents, config });
    return {
      text,
      modelUsed: "fake-model",
      usage: { promptTokenCount: 100, candidatesTokenCount: 20 },
      totalDurationMs: 1
    };
  },
  transcribeAudio: async (buffer, mimeType) =>
    answer({ operation: "transcribe", model: "fake-model", contents: [{ mimeType }], config: {} }),

  // --- test controls ---
  calls,
  respond(fn) {
    responder = fn;
  },
  reset() {
    calls.length = 0;
    responder = null;
  }
};
