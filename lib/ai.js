"use strict";

const U = require("./util");

// Tiered Model Hierarchy
const TIERS = [
  process.env.GEMINI_MODEL_TIER_1 || "gemini-3.8-flash",
  process.env.GEMINI_MODEL_TIER_2 || "gemini-3.6-flash",
  process.env.GEMINI_MODEL_TIER_3 || "gemini-3.5-flash-lite"
];

// In-process rate gate (RPM limit per container)
const rateGate = U.createRateGate(parseInt(process.env.GEMINI_RPM || "60", 10));

// Cached GoogleGenAI SDK instance (Dynamic ESM singleton)
let genAIInstance = null;

/**
 * Dynamically loads @google/genai as an ESM module to avoid CommonJS require crashes.
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
 * Calculates exponential jitter backoff delay in milliseconds.
 */
function getJitterDelay(attempt) {
  return Math.floor(1000 * (attempt + 1) + Math.random() * 400);
}

/**
 * Checks if an error is transient and eligible for tier fallback or retry.
 */
function isTransientError(err) {
  const status = err?.status || err?.statusCode || 0;
  const msg = (err?.message || "").toLowerCase();
  return (
    status === 429 ||
    status === 503 ||
    status === 500 ||
    msg.includes("resource_exhausted") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("etimedout")
  );
}

/**
 * Executes a Gemini request through the 3-tier cascade with jitter backoff.
 *
 * @param {Object} params
 * @param {Array|string} params.contents - Prompt or multimodal parts
 * @param {Object} [params.config] - Generation config (temperature, responseSchema, etc.)
 * @param {string} [params.operationType] - Telemetry operation label
 * @param {Object} [params.ctx] - Execution context containing pg pool and tenant data
 * @returns {Promise<Object>} Result containing text, modelUsed, usage, and latencyMs
 */
async function generateWithCascade({
  contents,
  config = {},
  operationType = "ai_generation",
  ctx = {}
}) {
  await rateGate();
  const ai = await getGenAI();

  let lastError = null;
  const startTime = Date.now();

  for (let tierIdx = 0; tierIdx < TIERS.length; tierIdx++) {
    const model = TIERS[tierIdx];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tierStart = Date.now();
        const response = await ai.models.generateContent({
          model,
          contents,
          config
        });

        const latencyMs = Date.now() - tierStart;
        const totalDurationMs = Date.now() - startTime;
        const usage = response.usageMetadata || {};

        // Asynchronous non-blocking telemetry log
        if (ctx.pool && ctx.broker) {
          setImmediate(async () => {
            try {
              await ctx.pool.query(
                `INSERT INTO operation_logs (
                   agency_id, broker_id, operation_type, status, total_duration_ms,
                   gemini_ms, tokens_input, tokens_output, model_used, created_at
                 ) VALUES ($1, $2, $3, 'success', $4, $5, $6, $7, $8, NOW())`,
                [
                  ctx.broker.agency_id || null,
                  ctx.broker.id || null,
                  operationType,
                  totalDurationMs,
                  latencyMs,
                  usage.promptTokenCount || 0,
                  usage.candidatesTokenCount || 0,
                  model
                ]
              );
            } catch (logErr) {
              console.warn("Operation telemetry log error:", logErr.message);
            }
          });
        }

        return {
          text: response.text || "",
          modelUsed: model,
          usage,
          totalDurationMs
        };
      } catch (err) {
        lastError = err;
        console.warn(
          `[AI_GATEWAY] Model ${model} (Tier ${tierIdx + 1}, Attempt ${
            attempt + 1
          }) failed: ${err.message}`
        );

        if (isTransientError(err) && attempt === 0) {
          const delay = getJitterDelay(attempt);
          await U.sleep(delay);
          continue; // Retry once on same tier
        }
        break; // Cascade to next tier
      }
    }

    // Brief inter-tier cooldown
    await U.sleep(400);
  }

  // All 3 tiers failed
  console.error(
    "[AI_GATEWAY_CRITICAL] All 3 Gemini tiers exhausted:",
    lastError
  );
  throw lastError;
}

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

  const prompt = `أنت مساعد ذكي متخصص في الاستماع للرسائل الصوتية لوسطاء العقارات في مصر.
مهمتك: تفريغ التسجيل الصوتي بدقة تامة وباللهجة المصرية الدارجة مع التركيز على المصطلحات العقارية:
(المناطق: التجمع، زايد، أكتوبر، الشروق، المستقبل، الساحل، العاصمة، مدينتي...
أنواع الوحدات: شقة، دوبلكس، بنتهاوس، تاون هاوس، توين هاوس، ستاند ألون، أرضي بحديقة...
التشطيب والماليات: استلام فوري، ريدي تو موف، نصف تشطيب، محارة وحلوق، الترا سوبر لوكس، أوفر، كاش، أقساط، وديعة صيانة).

تعليمات مهمة:
- اكتب الكلمات العقارية والأرقام بدقة.
- حول الأرقام الشفهية إلى صيغة رقمية واضحة (مثال: "عشرة مليون ونص" -> "10.5 مليون").
- أخرج النص المفرغ فقط بدون أي مقدمات أو تعليقات.`;

  const contents = [
    {
      role: "user",
      parts: [
        { text: prompt },
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
  getGenAI,
  generateWithCascade,
  transcribeAudio
};
