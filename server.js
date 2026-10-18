require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");

const T = require("./lib/text");
const R = require("./lib/render");

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body buffer for HMAC SHA256 signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ [DATABASE] Pool connection error:", err.message);
  } else {
    release();
  }
});

// Supabase Storage client
const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "placeholder"
);

// Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || ""
});

// In-memory queue for message debouncing
const pendingQueues = new Map();

// -----------------------------------------------------------------------------
// Helper: Outbound WhatsApp Messaging
// -----------------------------------------------------------------------------
async function sendWhatsAppText(to, text) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text }
        })
      }
    );
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`❌ [WHATSAPP OUTBOUND] Failed (${res.status}):`, errBody);
    }
  } catch (err) {
    console.error("❌ [WHATSAPP OUTBOUND] Network error:", err.message);
  }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "image",
          image: {
            link: imageUrl,
            caption: caption || ""
          }
        })
      }
    );
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`❌ [WHATSAPP IMAGE] Failed (${res.status}):`, errBody);
    }
  } catch (err) {
    console.error("❌ [WHATSAPP IMAGE] Network error:", err.message);
  }
}

// -----------------------------------------------------------------------------
// Middleware: HMAC Signature Verification
// -----------------------------------------------------------------------------
function verifyMetaSignature(req, res, next) {
  const secret = process.env.APP_SECRET;
  if (!secret) {
    console.warn("⚠️ [HMAC] APP_SECRET not set. Skipping verification.");
    return next();
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("❌ [HMAC] Request rejected: missing x-hub-signature-256");
    return res.status(401).send("Missing signature");
  }

  const parts = signature.split("=");
  const signatureHash = parts[1];
  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody || "")
    .digest("hex");

  if (signatureHash !== expectedHash) {
    console.warn(`❌ [HMAC] Signature mismatch from ${req.ip}`);
    return res.status(403).send("Invalid signature");
  }

  next();
}

// -----------------------------------------------------------------------------
// Health Check Endpoint
// -----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// -----------------------------------------------------------------------------
// Meta Webhook Verification (GET)
// -----------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  console.error(`❌ [WEBHOOK GET] Token mismatch: received "${token}"`);
  return res.sendStatus(403);
});

// -----------------------------------------------------------------------------
// Meta Webhook Event Ingestion (POST)
// -----------------------------------------------------------------------------
app.post("/webhook", verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  // Ignore delivery/read receipts
  if (value?.statuses && value.statuses.length > 0) return;

  const messages = value?.messages;
  if (!messages || messages.length === 0) return;

  const msg = messages[0];
  const from = String(msg.from || "").replace(/\D/g, "");
  const messageId = msg.id;

  // Deduplication check
  try {
    const dedup = await pool.query(
      "insert into processed_messages (message_id) values ($1) on conflict (message_id) do nothing returning message_id",
      [messageId]
    );
    if (dedup.rowCount === 0) return;
  } catch (err) {
    console.error("❌ [DEDUP] Query failed:", err.message);
  }

  // Broker authentication
  let broker;
  try {
    const bRes = await pool.query(
      `select b.*, a.name as agency_name, a.brand_color, a.accent_color, a.logo_url
       from brokers b
       join agencies a on a.id = b.agency_id
       where regexp_replace(b.phone, '\\D', '', 'g') = $1 and b.is_active = true`,
      [from]
    );
    if (bRes.rowCount === 0) {
      console.warn(`⛔ [AUTH] Rejected unauthorized phone number: ${from}`);
      await sendWhatsAppText(
        from,
        "⚠️ هذا الرقم غير مسجل في النظام. تواصل مع مدير الوكالة للتفعيل."
      );
      return;
    }
    broker = bRes.rows[0];
  } catch (err) {
    console.error("❌ [AUTH] Broker lookup error:", err.message);
    return;
  }

  // Immediate text commands
  if (msg.type === "text") {
    const textBody = (msg.text?.body || "").trim();
    const command = T.parseCommand(textBody);
    if (command) {
      return handleCommand(command, broker, from);
    }
  }

  // Buffer messages for debounced batch extraction
  enqueueIncomingMessage(from, msg, broker);
});

// -----------------------------------------------------------------------------
// Message Debounce & Batching
// -----------------------------------------------------------------------------
function enqueueIncomingMessage(from, msg, broker) {
  const debounceDelay = parseInt(process.env.DEBOUNCE_MS, 10) || 7000;

  if (!pendingQueues.has(from)) {
    pendingQueues.set(from, {
      items: [],
      timer: null,
      broker: broker
    });
  }

  const queue = pendingQueues.get(from);
  queue.items.push(msg);

  if (queue.timer) {
    clearTimeout(queue.timer);
  }

  queue.timer = setTimeout(async () => {
    const target = pendingQueues.get(from);
    pendingQueues.delete(from);

    if (target && target.items.length > 0) {
      try {
        await processBatchedListing(from, target.items, target.broker);
      } catch (err) {
        console.error("💥 [TIMER RUNTIME ERROR]:", err);
        await sendWhatsAppText(
          from,
          "⚠️ حدث خطأ فني أثناء المعالجة. يرجى المحاولة لاحقاً."
        ).catch(() => {});
      }
    }
  }, debounceDelay);
}

// -----------------------------------------------------------------------------
// AI Extraction & Pipeline Execution
// -----------------------------------------------------------------------------
async function processBatchedListing(from, items, broker) {
  const totalStart = performance.now();
  const latency = {};

  try {
    let collectedText = [];
    let images = [];
    let audioIds = [];

    for (const item of items) {
      if (item.type === "text" && item.text?.body) {
        collectedText.push(item.text.body);
      } else if (item.type === "image" && item.image) {
        images.push(item.image);
        if (item.image.caption) collectedText.push(item.image.caption);
      } else if (
        (item.type === "audio" || item.type === "voice") &&
        (item.audio || item.voice)
      ) {
        audioIds.push((item.audio || item.voice).id);
      }
    }

    if (
      images.length === 0 &&
      collectedText.length === 0 &&
      audioIds.length === 0
    ) {
      return;
    }

    // Acknowledge processing non-blockingly
    sendWhatsAppText(from, "⏳ جاري استخراج البيانات وتصميم الكتالوج...").catch(
      () => {}
    );

    // Step 1: Gemini Extraction
    const geminiStart = performance.now();
    const promptText = `
      Extract real estate unit parameters from the provided text into JSON format:
      {
        "code": "optional alphanumeric unit code, e.g. A101",
        "property_type": "apartment | villa | townhouse | duplex | studio",
        "listing_type": "sale | rent",
        "price_value": numeric price or null,
        "price_display": "formatted price string in EGP",
        "area_value": numeric square meters or null,
        "bedrooms": numeric integer or null,
        "location": "location name or compound",
        "features": ["feature 1", "feature 2"],
        "down_payment_value": numeric or null,
        "installment_years": numeric or null,
        "installment_value": numeric or null
      }
      Text: ${collectedText.join("\n")}
    `;

    let extractedData = {};
    try {
      const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const response = await ai.models.generateContent({
        model: modelName,
        contents: promptText,
        config: { responseMimeType: "application/json" }
      });

      extractedData = JSON.parse(response.text);
      latency.gemini = Math.round(performance.now() - geminiStart);
    } catch (err) {
      console.error("❌ [GEMINI] Extraction failed:", err.message);
      await sendWhatsAppText(
        from,
        "⚠️ حدث خطأ أثناء تحليل بيانات الإعلان بالذكاء الاصطناعي."
      );
      return;
    }

    // Step 2 & 3: Database Insertion
    const dbStart = performance.now();
    let listingCode = extractedData.code;
    if (!listingCode) {
      const seq = await pool.query(
        "select nextval('listing_code_seq') as code"
      );
      listingCode = String(seq.rows[0].code);
    }

    let listingId;
    try {
      const propertyTitle = `${extractedData.property_type || "عقار"} في ${
        extractedData.location || "مصر"
      }`;

      const ins = await pool.query(
        `insert into listings (
          agency_id, broker_id, code, title, property_type, listing_type,
          price_value, price_display, area_value, bedrooms, location,
          features, details, status
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active')
        returning id`,
        [
          broker.agency_id,
          broker.id,
          listingCode,
          propertyTitle,
          extractedData.property_type || "apartment",
          extractedData.listing_type || "sale",
          extractedData.price_value || null,
          extractedData.price_display || null,
          extractedData.area_value || null,
          extractedData.bedrooms || null,
          extractedData.location || null,
          Array.isArray(extractedData.features) ? extractedData.features : [],
          JSON.stringify(extractedData)
        ]
      );
      listingId = ins.rows[0].id;
      latency.db = Math.round(performance.now() - dbStart);
    } catch (err) {
      console.error("❌ [DATABASE] Insertion failed:", err.message);
      await sendWhatsAppText(
        from,
        `⚠️ فشل حفظ العقار في قاعدة البيانات: ${err.message}`
      );
      return;
    }

    // Step 4a: Satori Flyer Rendering
    let flyerPublicUrl = null;
    let pngBuffer = null;

    try {
      const renderStart = performance.now();
      pngBuffer = await R.renderFlyerSatori({
        agencyName: broker.agency_name,
        brandColor: broker.brand_color,
        accentColor: broker.accent_color,
        logoUrl: broker.logo_url,
        code: listingCode,
        title: `${extractedData.property_type || "وحدة"} - ${
          extractedData.location || ""
        }`,
        priceDisplay:
          extractedData.price_display ||
          (extractedData.price_value
            ? T.formatPrice(extractedData.price_value)
            : "عند الطلب"),
        area: extractedData.area_value
          ? `${extractedData.area_value} م²`
          : null,
        bedrooms: extractedData.bedrooms
          ? `${extractedData.bedrooms} غرف`
          : null,
        location: extractedData.location || "القاهرة",
        brokerPhone: broker.contact_phone || broker.phone,
        features: extractedData.features || []
      });
      latency.render = Math.round(performance.now() - renderStart);
    } catch (err) {
      console.error("❌ [RENDER] Brochure rendering error:", err.message);
    }

    // Step 4b: Supabase Storage Upload
    if (pngBuffer) {
      try {
        const uploadStart = performance.now();
        const storagePath = `${broker.agency_id}/${listingId}/flyer.png`;

        const { error: uploadError } = await supabase.storage
          .from(process.env.STORAGE_BUCKET || "media")
          .upload(storagePath, pngBuffer, {
            contentType: "image/png",
            upsert: true
          });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from(process.env.STORAGE_BUCKET || "media")
          .getPublicUrl(storagePath);

        flyerPublicUrl = urlData.publicUrl;

        await pool.query("update listings set flyer_url = $1 where id = $2", [
          flyerPublicUrl,
          listingId
        ]);

        latency.upload = Math.round(performance.now() - uploadStart);
      } catch (err) {
        console.error("❌ [STORAGE] Upload error:", err.message);
      }
    }

    // Step 5: WhatsApp Response
    const waStart = performance.now();
    if (flyerPublicUrl) {
      const caption = `🏡 *تم تجهيز الكتالوج بنجاح!*\nالكود: *#${listingCode}*\nالسعر: *${
        extractedData.price_display || "غير محدد"
      }*\nالموقع: *${extractedData.location || "-"}*`;
      await sendWhatsAppImage(from, flyerPublicUrl, caption);
    } else {
      await sendWhatsAppText(
        from,
        `✅ تم حفظ العقار برقم #${listingCode}، ولكن تعذر إنشاء الصورة الترويجية.`
      );
    }
    latency.whatsapp = Math.round(performance.now() - waStart);
    latency.total = Math.round(performance.now() - totalStart);

    // Record timing metrics to Render logs
    console.log(
      `⏱️ [PERF] #${listingCode} | Gemini: ${latency.gemini || 0}ms | DB:${
        latency.db || 0
      }ms | Render: ${latency.render || 0}ms | Upload:${
        latency.upload || 0
      }ms | WhatsApp: ${latency.whatsapp || 0}ms | Total:${latency.total}ms`
    );

    // Persist latency metrics to Supabase details column
    pool
      .query(
        `update listings
       set details = jsonb_set(coalesce(details, '{}')::jsonb, '{latency_ms}', $1::jsonb)
       where id = $2`,
        [JSON.stringify(latency), listingId]
      )
      .catch((err) =>
        console.error("❌ [METRICS] Failed to save latency to DB:", err.message)
      );
  } catch (fatalErr) {
    console.error("💥 [PIPELINE UNCAUGHT ERROR]:", fatalErr);
    await sendWhatsAppText(
      from,
      "⚠️ حدث خطأ غير متوقع أثناء معالجة العقار. يرجى المحاولة مرة أخرى لاحقاً."
    ).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// Command Router
// -----------------------------------------------------------------------------
async function handleCommand(cmd, broker, from) {
  try {
    if (cmd.type === "help") {
      const helpMsg =
        `📖 *دليل أوامر النظام:*\n\n` +
        `• *إضافة عقار:* أرسل الصور متبوعة بالتفاصيل وسيقوم الذكاء الاصطناعي بتوليد الكتالوج تلقائياً.\n` +
        `• *عرض عقار:* \`عقار 1001\` أو \`#1001\`\n` +
        `• *تحديث سعر:* \`سعر 1001 إلى 8.5 مليون\`\n` +
        `• *تحديث حالة:* \`تم البيع 1001\`\n` +
        `• *أرشفة:* \`ارشيف 1001\`\n` +
        `• *بحث:* \`بحث شقق التجمع 3 غرف\``;
      return await sendWhatsAppText(from, helpMsg);
    }

    if (cmd.type === "status") {
      const res = await pool.query(
        "update listings set status = $1, updated_at = now() where agency_id = $2 and lower(code) = lower($3) returning code",
        [cmd.status, broker.agency_id, cmd.code]
      );
      if (res.rowCount > 0) {
        return await sendWhatsAppText(
          from,
          `✅ تم تحديث حالة العقار #${cmd.code} إلى: *${cmd.status}*`
        );
      } else {
        return await sendWhatsAppText(
          from,
          `❌ لم يتم العثور على عقار بالكود #${cmd.code}`
        );
      }
    }

    if (cmd.type === "price") {
      const parsed = T.parsePrice(cmd.priceText);
      if (!parsed) {
        return await sendWhatsAppText(
          from,
          `⚠️ لم نتمكن من قراءة السعر الجديد: "${cmd.priceText}"`
        );
      }
      const display = T.formatPrice(parsed);
      const res = await pool.query(
        "update listings set price_value = $1, price_display = $2, updated_at = now() where agency_id = $3 and lower(code) = lower($4) returning id",
        [parsed, display, broker.agency_id, cmd.code]
      );
      if (res.rowCount > 0) {
        return await sendWhatsAppText(
          from,
          `✅ تم تحديث سعر العقار #${cmd.code} إلى: *${display}*`
        );
      } else {
        return await sendWhatsAppText(
          from,
          `❌ لم يتم العثور على عقار بالكود #${cmd.code}`
        );
      }
    }

    if (cmd.type === "show") {
      const res = await pool.query(
        "select * from listings where agency_id = $1 and lower(code) = lower($2)",
        [broker.agency_id, cmd.code]
      );
      if (res.rowCount === 0) {
        return await sendWhatsAppText(from, `❌ العقار #${cmd.code} غير مسجل.`);
      }
      const l = res.rows[0];
      if (l.flyer_url) {
        return await sendWhatsAppImage(
          from,
          l.flyer_url,
          `📋 بيانات العقار #${l.code}\nالسعر: ${l.price_display}\nالحالة: ${l.status}`
        );
      } else {
        return await sendWhatsAppText(
          from,
          `📋 العقار #${l.code}\nالنوع: ${l.property_type}\nالسعر: ${l.price_display}\nالموقع: ${l.location}`
        );
      }
    }
  } catch (err) {
    console.error(
      `❌ [COMMAND ERROR] Failed executing ${cmd.type}:`,
      err.message
    );
    await sendWhatsAppText(from, `⚠️ تعذر تنفيذ الأمر: ${err.message}`).catch(
      () => {}
    );
  }
}

// -----------------------------------------------------------------------------
// Global Crash Prevention
// -----------------------------------------------------------------------------
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "⚠️ [GLOBAL] Unhandled Rejection at:",
    promise,
    "reason:",
    reason
  );
});

process.on("uncaughtException", (err) => {
  console.error("🚨 [GLOBAL] Uncaught Exception thrown:", err);
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Real Estate WhatsApp Engine Online | Port: ${PORT}`);
});
