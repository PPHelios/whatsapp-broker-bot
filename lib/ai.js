// lib/ai.js — 3-Tier Gemini Gateway, Dynamic ESM Singleton & Audio Transcription
"use strict";

const U = require("./util");
const { estimateCostUsd } = require("../config");
const Db = require("./db");
const Billing = require("../services/billing");

// Model chains (ARCHITECTURE_MANIFEST.md §AI routing, model eval 2026-10-25):
// text-only calls start on Flash-Lite (same accuracy, ~45% cheaper, price fixed in 2027);
// audio and image calls start on 3.6 Flash (Flash-Lite misses fields on voice notes).
const TEXT_TIERS = [
  "gemini-3.5-flash-lite", // Tier 1 (Primary)
  "gemini-3.6-flash", // Tier 2 (Fallback 1)
  "gemini-3.8-flash" // Tier 3 (Fallback 2)
];
const MEDIA_TIERS = [
  "gemini-3.6-flash", // Tier 1 (Primary)
  "gemini-3.8-flash", // Tier 2 (Fallback 1)
  "gemini-3.5-flash-lite" // Tier 3 (Fallback 2)
];
// Kept for callers that need "the default text model" (eval script, search telemetry).
const TIERS = TEXT_TIERS;

/** True when any part of the request carries audio, image or video bytes. */
function hasMedia(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  return list.some((c) =>
    (c?.parts || []).some((p) => /^(audio|image|video)\//.test(p?.inlineData?.mimeType || "") || p?.fileData)
  );
}

/** Whether a request carries a voice note (it counts against the plan's voice allowance, not the text one). */
function hasAudio(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  const audio = (p) => /^audio\//.test(p?.inlineData?.mimeType || p?.fileData?.mimeType || "");
  return list.some((c) => audio(c) || (c?.parts || []).some(audio));
}

/** The model chain for one request: a route may pin its own, otherwise media decides. */
function tiersFor(route, contents) {
  if (route.tiers) return route.tiers;
  return hasMedia(contents) ? MEDIA_TIERS : TEXT_TIERS;
}

// In-process rate gate (60 RPM ceiling per container)
const rateGate = U.createRateGate(60);

// Cached GoogleGenAI SDK instance (Dynamic ESM singleton)
let genAIInstance = null;

/**
 * Dynamically loads @google/genai as an ESM module to avoid CommonJS require crashes.
 * Returns the resolved GoogleGenAI singleton instance.
 */
async function getGenAI() {
  if (genAIInstance) return genAIInstance;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not set");
  }
  const { GoogleGenAI } = await import("@google/genai");
  genAIInstance = new GoogleGenAI({ apiKey });
  return genAIInstance;
}

/**
 * Thinking setting per model for latency-sensitive tasks. Settings are not portable:
 * gemini-3.8-flash rejects MINIMAL and flash-lite rejects thinkingBudget 0 (probed 2026-10-24).
 */
const FAST_THINKING = {
  "gemini-3.8-flash": { thinkingLevel: "LOW" },
  "gemini-3.6-flash": { thinkingLevel: "MINIMAL" },
  "gemini-3.5-flash-lite": { thinkingLevel: "MINIMAL" }
};

/**
 * Per-task routing. deadlineMs bounds the whole call; after hedgeAfterMs without an answer the
 * next model starts in parallel (first answer wins). thinking: "fast" uses FAST_THINKING,
 * "default" keeps the model's own setting (draft extraction stays here until the quality eval decides).
 */
const ROUTES = {
  search_parse: { deadlineMs: 8000, hedgeAfterMs: 3500, thinking: "fast" },
  vision_curation: { deadlineMs: 45000, hedgeAfterMs: 15000, thinking: "fast" },
  audio_transcription: { deadlineMs: 25000, hedgeAfterMs: 8000, thinking: "fast" },
  lead_extraction: { deadlineMs: 15000, hedgeAfterMs: 5000, thinking: "fast" },
  lead_update: { deadlineMs: 15000, hedgeAfterMs: 5000, thinking: "fast" },
  // Eval 2026-10-25: MINIMAL (LOW on 3.8) matched default thinking on text and voice drafts.
  listing_extraction: { deadlineMs: 40000, hedgeAfterMs: 12000, thinking: "fast" },
  default: { deadlineMs: 40000, hedgeAfterMs: 12000, thinking: "default" }
};

/** Classifies an SDK error for telemetry: aborted, timeout, quota, overloaded, invalid or other. */
function classifyError(err) {
  const status = err?.status || err?.statusCode || 0;
  const msg = String(err?.message || "").toLowerCase();
  if (err?.name === "AbortError" || msg.includes("abort")) return "aborted";
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  if (status === 429 || msg.includes("resource_exhausted") || msg.includes("quota")) return "quota";
  if (
    status === 503 ||
    status === 500 ||
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded")
  ) {
    return "overloaded";
  }
  if (status === 400 || msg.includes("invalid")) return "invalid";
  return "other";
}

let testClient = null;
/** Test hook: replaces the Gemini SDK client (pass null to restore). */
function _setClientForTests(client) {
  testClient = client;
}

/**
 * Runs one Gemini request across the model tiers with hedging and a hard deadline,
 * and writes one operation_logs row (success or failure) with per-attempt detail.
 *
 * @param {Object} params
 * @param {Array|string} params.contents - Prompt or multimodal parts
 * @param {Object} [params.config] - Generation config (temperature, responseMimeType, etc.)
 * @param {string} [params.operationType] - Route and telemetry label (search_parse, vision_curation, ...)
 * @param {Object} [params.ctx] - { pool, broker } for telemetry
 * @returns {Promise<{text, modelUsed, usage, totalDurationMs, attempts}>}
 */
async function generateWithCascade({
  contents,
  config = {},
  operationType = "ai_generation",
  ctx = {}
}) {
  const route = ROUTES[operationType] || ROUTES.default;
  const tiers = tiersFor(route, contents);
  // Daily per-broker / per-agency AI quota (config.ai.quotas); throws QUOTA_EXCEEDED codes.
  const audio = hasAudio(contents);
  if (ctx?.pool && ctx?.broker?.agency_id) {
    await Db.checkAiQuota(ctx.pool, ctx.broker.agency_id, ctx.broker.id);
    // The plan's monthly text / voice allowance (services/billing.js); throws PLAN_QUOTA_EXCEEDED.
    await Billing.checkAllowance(ctx.pool, ctx.broker.agency_id, { audio });
  }
  await rateGate();
  const ai = testClient || (await getGenAI());
  const startTime = Date.now();
  const attempts = [];
  const controllers = [];

  const runAttempt = (model) => {
    const controller = new AbortController();
    controllers.push(controller);
    const attempt = { model, startedMs: Date.now() - startTime };
    attempts.push(attempt);
    const thinking = route.thinking === "fast" ? FAST_THINKING[model] : null;
    const t0 = Date.now();
    return ai.models
      .generateContent({
        model,
        contents,
        config: {
          ...config,
          ...(thinking ? { thinkingConfig: thinking } : {}),
          abortSignal: controller.signal
        }
      })
      .then((response) => {
        attempt.ms = Date.now() - t0;
        attempt.outcome = "ok";
        return { response, model, latencyMs: attempt.ms };
      })
      .catch((err) => {
        attempt.ms = Date.now() - t0;
        attempt.outcome = controller.signal.aborted ? "aborted" : classifyError(err);
        attempt.error = String(err?.message || err).slice(0, 200);
        throw err;
      });
  };

  let winner = null;
  let lastError = null;
  try {
    winner = await new Promise((resolve, reject) => {
      let next = 0;
      let pending = 0;
      let hedgeTimer = null;
      const deadline = setTimeout(() => {
        const err = new Error(
          `AI deadline of ${route.deadlineMs}ms exceeded (${operationType})`
        );
        err.code = "AI_DEADLINE";
        finish(reject, err);
      }, route.deadlineMs);
      function finish(fn, value) {
        clearTimeout(deadline);
        clearTimeout(hedgeTimer);
        fn(value);
      }
      function launch() {
        if (next >= tiers.length) return false;
        const model = tiers[next++];
        pending++;
        clearTimeout(hedgeTimer);
        // Slow answer: start the next tier in parallel instead of waiting out the deadline.
        hedgeTimer = setTimeout(launch, route.hedgeAfterMs);
        runAttempt(model).then(
          (win) => finish(resolve, win),
          (err) => {
            pending--;
            lastError = err;
            // Hard failure: move on immediately; give up when nothing is running or left to try.
            if (!launch() && pending === 0) finish(reject, err);
          }
        );
        return true;
      }
      launch();
    });
  } catch (err) {
    lastError = err.code === "AI_DEADLINE" ? err : lastError || err;
  } finally {
    // Stop losing or unfinished attempts and record them now (their rejections arrive later).
    controllers.forEach((c) => c.abort());
    for (const a of attempts) {
      if (!a.outcome) {
        a.outcome = "aborted";
        a.ms = Date.now() - startTime - a.startedMs;
      }
    }
  }

  const totalDurationMs = Date.now() - startTime;
  const usage = winner?.response?.usageMetadata || {};
  logAiCall(ctx, {
    operationType,
    status: winner ? "success" : "failed",
    errorCode: winner ? null : lastError?.code || classifyError(lastError),
    totalDurationMs,
    geminiMs: winner?.latencyMs || 0,
    usage,
    model: winner?.model || null,
    attempts,
    media: audio ? "audio" : hasMedia(contents) ? "image" : null
  });

  if (!winner) {
    console.error(
      `[AI_GATEWAY] ${operationType} failed after ${attempts.length} attempt(s):`,
      lastError?.message
    );
    throw lastError;
  }
  return {
    text: winner.response.text || "",
    modelUsed: winner.model,
    usage,
    totalDurationMs,
    attempts
  };
}

/** Non-blocking telemetry: one operation_logs row per AI call, success or failure. */
function logAiCall(
  ctx,
  { operationType, status, errorCode, totalDurationMs, geminiMs, usage, model, attempts, media = null }
) {
  if (!ctx?.pool) return;
  const tokensOut = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  setImmediate(() => {
    ctx.pool
      .query(
        `INSERT INTO operation_logs (
           agency_id, broker_id, operation_type, status, error_code, total_duration_ms,
           gemini_ms, tokens_input, tokens_output, model_used, estimated_cost_usd, metadata, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
        [
          ctx.broker?.agency_id || null,
          ctx.broker?.id || null,
          operationType,
          status,
          errorCode,
          totalDurationMs,
          geminiMs,
          usage.promptTokenCount || 0,
          // Thinking tokens are billed as output.
          tokensOut,
          model,
          model ? estimateCostUsd(model, usage.promptTokenCount || 0, tokensOut) : 0,
          JSON.stringify({ thoughts_tokens: usage.thoughtsTokenCount || 0, attempts, ...(media ? { media } : {}) })
        ]
      )
      .catch((logErr) =>
        console.warn("Operation telemetry log error:", logErr.message)
      );
  });
}

// Shared with scripts/eval-ai.js so the quality eval measures the production prompt.
const TRANSCRIPTION_PROMPT = `أنت مساعد ذكي متخصص في الاستماع للرسائل الصوتية لوسطاء العقارات في مصر.
مهمتك: تفريغ التسجيل الصوتي بدقة تامة وباللهجة المصرية الدارجة مع التركيز على المصطلحات العقارية:
(المناطق: التجمع، زايد، أكتوبر، الشروق، المستقبل، الساحل، العاصمة، مدينتي...
أنواع الوحدات: شقة، دوبلكس، بنتهاوس، تاون هاوس، توين هاوس، ستاند ألون، أرضي بحديقة...
التشطيب والماليات: استلام فوري، ريدي تو موف، نصف تشطيب، محارة وحلوق، الترا سوبر لوكس، أوفر، كاش، أقساط، وديعة صيانة).

تعليمات مهمة:
- اكتب الكلمات العقارية والأرقام بدقة.
- حول الأرقام الشفهية إلى صيغة رقمية واضحة (مثال: "عشرة مليون ونص" -> "10.5 مليون").
- اكتب أكواد الوحدات بالحروف اللاتينية والأرقام كما تُنطق (مثال: "في آي إل صفر تمانية" -> "VIL-08").
- أخرج النص المفرغ فقط بدون أي مقدمات أو تعليقات.`;

/**
 * Transcribes Egyptian Arabic real estate voice notes into normalized text.
 *
 * @param {Buffer} audioBuffer - Clean OGG/Opus or MP3 audio buffer
 * @param {string} mimeType - Clean audio MIME type
 * @param {Object} [ctx] - Context containing telemetry pool
 * @returns {Promise<string>} Clean transcribed text
 */
async function transcribeAudio(audioBuffer, mimeType, ctx = {}) {
  const base64Audio = audioBuffer.toString("base64");


  const contents = [
    {
      role: "user",
      parts: [
        { text: TRANSCRIPTION_PROMPT },
        {
          inlineData: {
            mimeType: mimeType || "audio/ogg",
            data: base64Audio
          }
        }
      ]
    }
  ];

  const result = await generateWithCascade({
    contents,
    config: {
      temperature: 0.1
    },
    operationType: "audio_transcription",
    ctx
  });

  return result.text.trim();
}

module.exports = {
  TIERS,
  TEXT_TIERS,
  MEDIA_TIERS,
  hasMedia,
  hasAudio,
  tiersFor,
  ROUTES,
  FAST_THINKING,
  TRANSCRIPTION_PROMPT,
  classifyError,
  _setClientForTests,
  getGenAI,
  generateWithCascade,
  transcribeAudio
};
