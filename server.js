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

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ [DATABASE] Pool connection error:", err.message);
  } else {
    console.log("✅ [DATABASE] Supabase PostgreSQL connection pool verified");
    release();
  }
});

// Initialize Supabase Storage client
const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_KEY || "placeholder"
);

// Initialize Gemini Client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || ""
});

// HMAC Signature Verification Middleware
function verifyMetaSignature(req, res, next) {
  const secret = process.env.APP_SECRET;
  if (!secret) {
    console.warn(
      "⚠️ [HMAC] APP_SECRET not set. Skipping signature verification."
    );
    return next();
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn(
      "❌ [HMAC] Request rejected: missing x-hub-signature-256 header"
    );
    return res.status(401).send("Missing signature");
  }

  const parts = signature.split("=");
  const signatureHash = parts[1];
  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody || "")
    .digest("hex");

  if (signatureHash !== expectedHash) {
    console.warn(
      `❌ [HMAC] Mismatch: received ${signatureHash} vs expected${expectedHash}`
    );
    return res.status(403).send("Invalid signature");
  }

  console.log("✅ [HMAC] Payload signature verified successfully");
  next();
}

// In-memory queue for multi-image / message debouncing
const pendingQueues = new Map();

// -----------------------------------------------------------------------------
// Health Check Endpoint
// -----------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// -----------------------------------------------------------------------------
// Meta Webhook Handshake (GET)
// -----------------------------------------------------------------------------
app.get("/webhook", (req, res) => {
  console.log("🔍 [WEBHOOK GET] Incoming verification request:", req.query);
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log(
      "✅ [WEBHOOK GET] Token matched. Replying challenge:",
      challenge
    );
    return res.status(200).send(challenge);
  }

  console.error(
    `❌ [WEBHOOK GET] Token mismatch: expected "${process.env.VERIFY_TOKEN}", received "${token}"`
  );
  return res.sendStatus(403);
});

// -----------------------------------------------------------------------------
// Meta Webhook Event Ingestion (POST)
// -----------------------------------------------------------------------------
app.post("/webhook", verifyMetaSignature, async (req, res) => {
  // Acknowledge Meta immediately with 200 OK
  res.sendStatus(200);

  const body = req.body;
  console.log("📥 [WEBHOOK POST] Payload:");
  console.dir(body, { depth: 5 });

  if (body.object !== "whatsapp_business_account") {
    console.log(`ℹ️ [WEBHOOK POST] Ignored object type: "${body.object}"`);
    return;
  }

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  // Handle message delivery status updates
  if (value?.statuses && value.statuses.length > 0) {
    const st = value.statuses[0];
    console.log(
      `📊 [STATUS] Message ID: ${st.id} -> ${st.status} (User:${st.recipient_id})`
    );
    return;
  }

  const messages = value?.messages;
  if (!messages || messages.length === 0) {
    console.log("ℹ️ [WEBHOOK POST] No messages array found in change value");
    return;
  }

  const msg = messages[0];
  const from = msg.from;
  const messageId = msg.id;

  console.log(
    `\n📩 [MESSAGE] Received ID ${messageId} from ${from} (type:${msg.type})`
  );

  // Message deduplication
  try {
    const dedup = await pool.query(
      "insert into processed_messages (message_id) values ($1) on conflict (message_id) do nothing returning message_id",
      [messageId]
    );
    if (dedup.rowCount === 0) {
      console.warn(
        `⚠️ [DEDUP] Message ${messageId} already processed. Skipping.`
      );
      return;
    }
  } catch (err) {
    console.error("❌ [DEDUP] Query failed:", err.message);
  }

  // Broker authorization
  let broker;
  try {
    const bRes = await pool.query(
      "select b.*, a.name as agency_name, a.brand_color, a.accent_color, a.logo_url from brokers b join agencies a on a.id = b.agency_id where b.phone = $1 and b.is_active = true",
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
    console.log(
      `👤 [BROKER] Authenticated ${broker.name} (Agency:${broker.agency_name})`
    );
  } catch (err) {
    console.error("❌ [AUTH] Broker lookup error:", err.message);
    return;
  }

  // Process text commands immediately without queuing
  if (msg.type === "text") {
    const textBody = (msg.text?.body || "").trim();
    console.log(`💬 [TEXT BODY] "${textBody}"`);

    const command = T.parseCommand(textBody);
    if (command) {
      console.log("⚡ [COMMAND DETECTED]", command);
      return handleCommand(command, broker, from);
    }
  }

  // Queue media and freeform property listings for debouncing
  console.log(`⏳ [BUFFER] Enqueueing ${msg.type} from${from}`);
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
    console.log(
      `⏱️ [BUFFER] Timer reset for ${from} (buffered count:${queue.items.length})`
    );
  }

  queue.timer = setTimeout(async () => {
    const target = pendingQueues.get(from);
    pendingQueues.delete(from);

    if (target && target.items.length > 0) {
      console.log(
        `🚀 [PIPELINE] Debounce resolved for ${from}. Processing batch of ${target.items.length} items.`
      );
      await processBatchedListing(from, target.items, target.broker);
    }
  }, debounceDelay);
}

// -----------------------------------------------------------------------------
// AI Extraction & Satori Generation
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// AI Extraction & Satori Generation
// -----------------------------------------------------------------------------
async function processBatchedListing(from, items, broker) {
  console.log(`\n=================== START BATCH PROCESSING ===================`);
  console.log(`Broker: ${broker.name} | Total items: ${items.length}`);

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

  console.log(
    `📦 [PIPELINE] Extracted items: ${images.length} images, ${audioIds.length} audio notes, ${collectedText.length} text lines`
  );

  if (images.length === 0 && collectedText.length === 0 && audioIds.length === 0) {
    console.warn("⚠️ [PIPELINE] Empty submission batch. Exiting.");
    return;
  }

  await sendWhatsAppText(from, "⏳ جاري استخراج البيانات وتصميم الكتالوج...");

  // Step 1: Gemini Parameter Extraction
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
    console.log(`🤖 [GEMINI] Invoking model: ${modelName}`);

    const response = await ai.models.generateContent({
      model: modelName,
      contents: promptText,
      config: { responseMimeType: "application/json" }
    });

    extractedData = JSON.parse(response.text);
    console.log("✅ [GEMINI] Extracted Data:");
    console.dir(extractedData, { depth: 4 });
  } catch (err) {
    console.error("❌ [GEMINI] Extraction failed:", err.message);
    await sendWhatsAppText(from, "⚠️ حدث خطأ أثناء تحليل بيانات الإعلان.");
    return;
  }

  // Step 2: Listing Code Assignment
  let listingCode = extractedData.code;
  if (!listingCode) {
    const seq = await pool.query("select nextval('listing_code_seq') as code");
    listingCode = String(seq.rows[0].code);
    console.log(`🔢 [CODE] Fallback sequence assigned: #${listingCode}`);
  }

  // Step 3: Insert Listing to PostgreSQL
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
    console.log(`💾 [DATABASE] Inserted listing UUID: ${listingId} (Code: #${listingCode})`);
  } catch (err) {
    console.error("❌ [DATABASE] Insertion failed:", err.message);
    await sendWhatsAppText(from, `⚠️ فشل حفظ العقار في قاعدة البيانات: ${err.message}`);
    return;
  }

  // Step 4: Satori Rendering and Storage Upload
  let flyerPublicUrl = null;
  try {
    console.log("🎨 [SATORI] Rendering brochure image...");
    const pngBuffer = await R.renderFlyerPng({
      agencyName: broker.agency_name,
      brandColor: broker.brand_color,
      accentColor: broker.accent_color,
      logoUrl: broker.logo_url,
      code: listingCode,
      title: `${extractedData.property_type || "وحدة"} - ${extractedData.location || ""}`,
      priceDisplay:
        extractedData.price_display ||
        (extractedData.price_value
          ? T.formatPrice(extractedData.price_value)
          : "عند الطلب"),
      area: extractedData.area_value ? `${extractedData.area_value} م²` : null,
      bedrooms: extractedData.bedrooms ? `${extractedData.bedrooms} غرف` : null,
      location: extractedData.location || "القاهرة",
      brokerPhone: broker.contact_phone || broker.phone,
      features: extractedData.features || []
    });

    const storagePath = `${broker.agency_id}/${listingId}/flyer.png`;
    console.log(`☁️ [SUPABASE STORAGE] Uploading to bucket "${process.env.STORAGE_BUCKET}": ${storagePath}`);

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
    console.log(`🔗 [SUPABASE STORAGE] Public flyer URL: ${flyerPublicUrl}`);

    await pool.query("update listings set flyer_url = $1 where id = $2", [
      flyerPublicUrl,
      listingId
    ]);
  } catch (err) {
    console.error("❌ [RENDER] Brochure rendering/upload error:", err.message);
  }

  // Step 5: WhatsApp Response
  if (flyerPublicUrl) {
    console.log(`📤 [WHATSAPP] Delivering flyer to ${from}`);
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

  console.log(`=================== COMPLETED BATCH ===================\n`);
}

// -----------------------------------------------------------------------------
// Command Handlers
// -----------------------------------------------------------------------------
async function handleCommand(cmd, broker, from) {
  console.log(`⚙️ [COMMAND] Executing ${cmd.type} for broker${broker.name}`);

  if (cmd.type === "help") {
    const helpMsg =
      `📖 *دليل أوامر النظام:*\n\n` +
      `• *إضافة عقار:* أرسل الصور متبوعة بالتفاصيل وسيقوم الذكاء الاصطناعي بتوليد الكتالوج تلقائياً.\n` +
      `• *عرض عقار:* \`عقار 1001\` أو \`#1001\`\n` +
      `• *تحديث سعر:* \`سعر 1001 إلى 8.5 مليون\`\n` +
      `• *تحديث حالة:* \`تم البيع 1001\`\n` +
      `• *أرشفة:* \`ارشيف 1001\`\n` +
      `• *بحث:* \`بحث شقق التجمع 3 غرف\``;
    return sendWhatsAppText(from, helpMsg);
  }

  if (cmd.type === "status") {
    const res = await pool.query(
      "update listings set status = $1, updated_at = now() where agency_id = $2 and lower(code) = lower($3) returning code",
      [cmd.status, broker.agency_id, cmd.code]
    );
    if (res.rowCount > 0) {
      return sendWhatsAppText(
        from,
        `✅ تم تحديث حالة العقار #${cmd.code} إلى: *${cmd.status}*`
      );
    } else {
      return sendWhatsAppText(
        from,
        `❌ لم يتم العثور على عقار بالكود #${cmd.code}`
      );
    }
  }

  if (cmd.type === "price") {
    const parsed = T.parsePrice(cmd.priceText);
    if (!parsed) {
      return sendWhatsAppText(
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
      return sendWhatsAppText(
        from,
        `✅ تم تحديث سعر العقار #${cmd.code} إلى: *${display}*`
      );
    } else {
      return sendWhatsAppText(
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
      return sendWhatsAppText(from, `❌ العقار #${cmd.code} غير مسجل.`);
    }
    const l = res.rows[0];
    if (l.flyer_url) {
      return sendWhatsAppImage(
        from,
        l.flyer_url,
        `📋 بيانات العقار #${l.code}\nالسعر: ${l.price_display}\nالحالة: ${l.status}`
      );
    } else {
      return sendWhatsAppText(
        from,
        `📋 العقار #${l.code}\nالنوع: ${l.property_type}\nالسعر: ${l.price_display}\nالموقع: ${l.location}`
      );
    }
  }
}

// -----------------------------------------------------------------------------
// WhatsApp Outbound API Helpers
// -----------------------------------------------------------------------------
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  console.log(
    `📤 [WHATSAPP OUTBOUND] Text to ${to}: "${text.slice(0, 50)}..."`
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text }
      })
    });
    const data = await res.json();
    if (!res.ok) console.error("❌ [WHATSAPP OUTBOUND ERROR]", data);
    else
      console.log(
        `✅ [WHATSAPP OUTBOUND] Message ID: ${data.messages?.[0]?.id}`
      );
  } catch (err) {
    console.error("❌ [WHATSAPP OUTBOUND NETWORK ERROR]", err.message);
  }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  console.log(`📤 [WHATSAPP OUTBOUND] Image to ${to}: ${imageUrl}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "image",
        image: {
          link: imageUrl,
          caption: caption
        }
      })
    });
    const data = await res.json();
    if (!res.ok) console.error("❌ [WHATSAPP OUTBOUND ERROR]", data);
    else
      console.log(`✅ [WHATSAPP OUTBOUND] Image ID: ${data.messages?.[0]?.id}`);
  } catch (err) {
    console.error("❌ [WHATSAPP OUTBOUND NETWORK ERROR]", err.message);
  }
}

// -----------------------------------------------------------------------------
// Server Initialization
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(
    `\n🚀 Real Estate WhatsApp Engine Online | Port: ${PORT} | Storage: ${process.env.STORAGE_BUCKET}\n`
  );
});
