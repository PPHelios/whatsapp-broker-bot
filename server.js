require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const T = require('./lib/text');
const R = require('./lib/render');

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body for HMAC signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Initialize database connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ [DATABASE] Connection failed:', err.message);
  } else {
    console.log('✅ [DATABASE] Connected to Supabase PostgreSQL pool');
    release();
  }
});

// Initialize Supabase Storage client
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// HMAC Signature Validator
function verifyMetaSignature(req, res, next) {
  const secret = process.env.APP_SECRET;
  if (!secret) {
    console.warn('⚠️ [HMAC] APP_SECRET not configured. Skipping HMAC validation.');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('❌ [HMAC] Missing x-hub-signature-256 header');
    return res.status(401).send('Missing signature');
  }

  const parts = signature.split('=');
  const signatureHash = parts[1];
  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || '')
    .digest('hex');

  if (signatureHash !== expectedHash) {
    console.warn(`❌ [HMAC] Mismatch! Received: ${signatureHash} \vert{} Expected:${expectedHash}`);
    return res.status(403).send('Invalid signature');
  }

  console.log('✅ [HMAC] Payload signature verified successfully');
  next();
}

// In-memory debounce queue for grouping media and text buffers
const pendingQueues = new Map();

// -----------------------------------------------------------------------------
// Health Check Endpoint
// -----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// -----------------------------------------------------------------------------
// Meta Webhook Verification (GET)
// -----------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  console.log('🔍 [WEBHOOK GET] Incoming handshake query:', req.query);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ [WEBHOOK GET] Handshake verified successfully with challenge:', challenge);
    return res.status(200).send(challenge);
  }

  console.error(`❌ [WEBHOOK GET] Failed handshake. Token mismatch: expected "${process.env.VERIFY_TOKEN}", got "${token}"`);
  return res.sendStatus(403);
});

// -----------------------------------------------------------------------------
// Meta Webhook Event Processor (POST)
// -----------------------------------------------------------------------------
app.post('/webhook', verifyMetaSignature, async (req, res) => {
  // Always acknowledge Meta with 200 immediately to prevent timeouts
  res.sendStatus(200);

  const body = req.body;
  console.log('📥 [WEBHOOK POST] Raw payload received:');
  console.dir(body, { depth: 5 });

  if (body.object !== 'whatsapp_business_account') {
    console.log(`ℹ️ [WEBHOOK POST] Ignored object type: "${body.object}"`);
    return;
  }

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  // Track status updates (sent, delivered, read)
  if (value?.statuses) {
    const st = value.statuses[0];
    console.log(`📊 [STATUS] Message ${st.id} -> ${st.status} (Recipient:${st.recipient_id})`);
    return;
  }

  const messages = value?.messages;
  if (!messages || messages.length === 0) {
    console.log('ℹ️ [WEBHOOK POST] Event received with no user messages');
    return;
  }

  const msg = messages[0];
  const from = msg.from; // Sender WhatsApp digits
  const messageId = msg.id;

  console.log(`\n📩 [MESSAGE] Processing incoming message ${messageId} from${from}`);

  // Deduplication check
  try {
    const dedupCheck = await pool.query(
      'insert into processed_messages (message_id) values ($1) on conflict (message_id) do nothing returning message_id',
      [messageId]
    );
    if (dedupCheck.rowCount === 0) {
      console.warn(`⚠️ [DEDUP] Skipping duplicate message ${messageId}`);
      return;
    }
  } catch (err) {
    console.error('❌ [DEDUP] Database check failed:', err.message);
  }

  // Broker registration validation
  let broker;
  try {
    const bRes = await pool.query(
      'select b.*, a.name as agency_name, a.brand_color, a.accent_color, a.logo_url from brokers b join agencies a on a.id = b.agency_id where b.phone = $1 and b.is_active = true',
      [from]
    );
    if (bRes.rowCount === 0) {
      console.warn(`⛔ [AUTH] Rejecting request: Phone ${from} is not registered or active in database`);
      await sendWhatsAppText(from, '⚠️ هذا الرقم غير مسجل في النظام. تواصل مع مدير الوكالة للتفعيل.');
      return;
    }
    broker = bRes.rows[0];
    console.log(`👤 [BROKER] Authenticated broker: ${broker.name} (Agency:${broker.agency_name})`);
  } catch (err) {
    console.error('❌ [AUTH] Broker lookup error:', err.message);
    return;
  }

  // Handle Text Commands Directly
  if (msg.type === 'text') {
    const textBody = msg.text.body.trim();
    console.log(`💬 [TEXT] Content: "${textBody}"`);

    const command = T.parseCommand(textBody);
    if (command) {
      console.log(`⚡ [COMMAND] Parsed command:`, command);
      return handleCommand(command, broker, from);
    }
  }

  // Handle Media / Multi-Part Buffering
  console.log(`⏳ [BUFFER] Enqueuing ${msg.type} message from${from}`);
  enqueueIncomingMessage(from, msg, broker);
});

// -----------------------------------------------------------------------------
// Message Aggregator & Debounce
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
    console.log(`⏱️ [BUFFER] Debounce timer reset for ${from} (${queue.items.length} items buffered)`);
  }

  queue.timer = setTimeout(async () => {
    const targetQueue = pendingQueues.get(from);
    pendingQueues.delete(from);

    if (targetQueue && targetQueue.items.length > 0) {
      console.log(`🚀 [PIPELINE] Debounce timer expired for ${from}. Processing ${targetQueue.items.length} items.`);
      await processBatchedListing(from, targetQueue.items, targetQueue.broker);
    }
  }, debounceDelay);
}

// -----------------------------------------------------------------------------
// Core Extraction and Brochure Pipeline
// -----------------------------------------------------------------------------
async function processBatchedListing(from, items, broker) {
  console.log(`\n================= START LISTING PIPELINE =================`);
  console.log(`Broker: ${broker.name} \vert{} Items Count:${items.length}`);

  let collectedText = [];
  let images = [];
  let audioIds = [];

  for (const item of items) {
    if (item.type === 'text') {
      collectedText.push(item.text.body);
    } else if (item.type === 'image') {
      images.push(item.image);
      if (item.image.caption) collectedText.push(item.image.caption);
    } else if (item.type === 'audio' || item.type === 'voice') {
      audioIds.push((item.audio || item.voice).id);
    }
  }

  console.log(`📦 [PIPELINE] Extracted: ${images.length} images, ${audioIds.length} audio notes,${collectedText.length} text blocks`);

  if (images.length === 0 && collectedText.length === 0 && audioIds.length === 0) {
    console.warn('⚠️ [PIPELINE] Batch empty. Aborting.');
    return;
  }

  await sendWhatsAppText(from, '⏳ جاري استخراج البيانات وتصميم الكتالوج...');

  // Step 1: Multimodal Extraction via Gemini 2.5 Flash
  let promptText = `
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
      "installment_value": numeric or null,
      "hero_image_index": 0
    }
    Text: ${collectedText.join('\n')}
  `;

  let extractedData = {};
  try {
    console.log('🤖 [GEMINI] Dispatching extraction payload to model:', process.env.GEMINI_MODEL || 'gemini-2.5-flash');
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: promptText,
      config: { responseMimeType: 'application/json' }
    });

    extractedData = JSON.parse(response.text);
    console.log('✅ [GEMINI] Parsed listing parameters:');
    console.dir(extractedData, { depth: 4 });
  } catch (err) {
    console.error('❌ [GEMINI] Extraction failed:', err.message);
    await sendWhatsAppText(from, '⚠️ حدث خطأ أثناء تحليل بيانات الإعلان بالذكاء الاصطناعي.');
    return;
  }

  // Step 2: Database Code Allocation
  let listingCode = extractedData.code;
  if (!listingCode) {
    const seqRes = await pool.query("select nextval('listing_code_seq') as code");
    listingCode = String(seqRes.rows[0].code);
    console.log(`🔢 [CODE] Generated fallback sequence code: #${listingCode}`);
  }

  // Step 3: Insert Listing Record
  let listingId;
  try {
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
        `${extractedData.property_type \vert{}\vert{} 'عقار'} في ${extractedData.location || 'مصر'}`,
        extractedData.property_type,
        extractedData.listing_type || 'sale',
        extractedData.price_value,
        extractedData.price_display,
        extractedData.area_value,
        extractedData.bedrooms,
        extractedData.location,
        extractedData.features || [],
        extractedData
      ]
    );
    listingId = ins.rows[0].id;
    console.log(`💾 [DATABASE] Inserted listing record UUID: ${listingId} (Code: #${listingCode})`);
  } catch (err) {
    console.error('❌ [DATABASE] Failed to insert listing:', err.message);
    await sendWhatsAppText(from, `⚠️ فشل حفظ العقار في قاعدة البيانات: ${err.message}`);
    return;
  }

  // Step 4: Satori SVG + Resvg PNG Rendering
  let flyerPublicUrl = null;
  try {
    console.log('🎨 [SATORI] Generating high-resolution brochure PNG...');
    const pngBuffer = await R.renderFlyerPng({
      agencyName: broker.agency_name,
      brandColor: broker.brand_color,
      accentColor: broker.accent_color,
      logoUrl: broker.logo_url,
      code: listingCode,
      title: `${extractedData.property_type \vert{}\vert{} 'وحدة'} - ${extractedData.location || ''}`,
      priceDisplay: extractedData.price_display || (extractedData.price_value ? T.formatPrice(extractedData.price_value) : 'عند الطلب'),
      area: extractedData.area_value ? `${extractedData.area_value} م²` : null,
      bedrooms: extractedData.bedrooms ? `${extractedData.bedrooms} غرف` : null,
      location: extractedData.location || 'القاهرة',
      brokerPhone: broker.contact_phone || broker.phone,
      features: extractedData.features || []
    });

    const storagePath = `${broker.agency_id}/${listingId}/flyer.png`;
    console.log(`☁️ [SUPABASE STORAGE] Uploading brochure buffer to bucket "${process.env.STORAGE_BUCKET}": ${storagePath}`);

    const { error: uploadError } = await supabase.storage
      .from(process.env.STORAGE_BUCKET || 'media')
      .upload(storagePath, pngBuffer, {
        contentType: 'image/png',
        upsert: true
      });

    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage
      .from(process.env.STORAGE_BUCKET || 'media')
      .getPublicUrl(storagePath);

    flyerPublicUrl = urlData.publicUrl;
    console.log(`🔗 [SUPABASE STORAGE] Public flyer URL: ${flyerPublicUrl}`);

    await pool.query('update listings set flyer_url = $1 where id = $2', [flyerPublicUrl, listingId]);
  } catch (err) {
    console.error('❌ [RENDER] Brochure generation or upload failed:', err.message);
  }

  // Step 5: Send Finished Catalog to WhatsApp
  if (flyerPublicUrl) {
    console.log(`📤 [WHATSAPP] Dispatching flyer image to ${from}`);
    const caption = `🏡 *تم تجهيز الكتالوج بنجاح!*\nالكود: *#${listingCode}*\nالسعر: *${extractedData.price_display \vert{}\vert{} 'غير محدد'}*\nالموقع: *${extractedData.location || '-'}*`;
    await sendWhatsAppImage(from, flyerPublicUrl, caption);
  } else {
    await sendWhatsAppText(from, `✅ تم حفظ العقار برقم #${listingCode}، ولكن تعذر إنشاء الصورة الترويجية.`);
  }

  console.log(`================= COMPLETED PIPELINE =================\n`);
}

// -----------------------------------------------------------------------------
// Interactive Commands Handler
// -----------------------------------------------------------------------------
async function handleCommand(cmd, broker, from) {
  console.log(`⚙️ [COMMAND] Executing command "${cmd.type}" for broker ${broker.name}`);

  if (cmd.type === 'help') {
    const helpMsg = `📖 *دليل أوامر النظام:*\n\n` +
      `• *إضافة عقار:* أرسل الصور متبوعة بالتفاصيل وسيقوم الذكاء الاصطناعي بتوليد الكتالوج تلقائياً.\n` +
      `• *عرض عقار:* \`عقار 1001\` أو \`#1001\`\n` +
      `• *تحديث سعر:* \`سعر 1001 إلى 8.5 مليون\`\n` +
      `• *تحديث حالة:* \`تم البيع 1001\`\n` +
      `• *أرشفة:* \`ارشيف 1001\`\n` +
      `• *بحث:* \`بحث شقق التجمع 3 غرف\``;
    return sendWhatsAppText(from, helpMsg);
  }

  if (cmd.type === 'status') {
    const res = await pool.query(
      'update listings set status = $1, updated_at = now() where agency_id = $2 and lower(code) = lower($3) returning code',
      [cmd.status, broker.agency_id, cmd.code]
    );
    if (res.rowCount > 0) {
      return sendWhatsAppText(from, `✅ تم تحديث حالة العقار #${cmd.code} إلى: *${cmd.status}*`);
    } else {
      return sendWhatsAppText(from, `❌ لم يتم العثور على عقار بالكود #${cmd.code}`);
    }
  }

  if (cmd.type === 'price') {
    const parsed = T.parsePrice(cmd.priceText);
    if (!parsed) {
      return sendWhatsAppText(from, `⚠️ لم نتمكن من قراءة السعر الجديد: "${cmd.priceText}"`);
    }
    const display = T.formatPrice(parsed);
    const res = await pool.query(
      'update listings set price_value = $1, price_display = $2, updated_at = now() where agency_id = $3 and lower(code) = lower($4) returning id, flyer_url',
      [parsed, display, broker.agency_id, cmd.code]
    );
    if (res.rowCount > 0) {
      return sendWhatsAppText(from, `✅ تم تحديث سعر العقار #${cmd.code} إلى: *${display}*`);
    } else {
      return sendWhatsAppText(from, `❌ لم يتم العثور على عقار بالكود #${cmd.code}`);
    }
  }

  if (cmd.type === 'show') {
    const res = await pool.query(
      'select * from listings where agency_id = $1 and lower(code) = lower($2)',
      [broker.agency_id, cmd.code]
    );
    if (res.rowCount === 0) {
      return sendWhatsAppText(from, `❌ العقار #${cmd.code} غير مسجل.`);
    }
    const l = res.rows[0];
    if (l.flyer_url) {
      return sendWhatsAppImage(from, l.flyer_url, `📋 بيانات العقار #${l.code}\nالسعر: ${l.price_display}\nالحالة: ${l.status}`);
    } else {
      return sendWhatsAppText(from, `📋 العقار #${l.code}\nالنوع: ${l.property_type}\nالسعر: ${l.price_display}\nالموقع: ${l.location}`);
    }
  }
}

// -----------------------------------------------------------------------------
// WhatsApp Outbound API Helpers
// -----------------------------------------------------------------------------
async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  console.log(`📤 [WHATSAPP OUTBOUND] Sending text to ${to}: "${text.slice(0, 50)}..."`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('❌ [WHATSAPP OUTBOUND ERROR]', data);
    else console.log(`✅ [WHATSAPP OUTBOUND] Message dispatched (ID: ${data.messages?.[0]?.id})`);
  } catch (err) {
    console.error('❌ [WHATSAPP OUTBOUND NETWORK ERROR]', err.message);
  }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  console.log(`📤 [WHATSAPP OUTBOUND] Dispatching image to ${to}: ${imageUrl}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption
        }
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('❌ [WHATSAPP OUTBOUND ERROR]', data);
    else console.log(`✅ [WHATSAPP OUTBOUND] Image dispatched (ID: ${data.messages?.[0]?.id})`);
  } catch (err) {
    console.error('❌ [WHATSAPP OUTBOUND NETWORK ERROR]', err.message);
  }
}

// -----------------------------------------------------------------------------
// Start Express Server
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🚀 =================================================`);
  console.log(`🚀 Real Estate WhatsApp Broker Engine Online`);
  console.log(`🚀 Port: ${PORT}`);
  console.log(`🚀 Storage Bucket: ${process.env.STORAGE_BUCKET}`);
  console.log(`🚀 Satori + Supabase Pipeline Active`);
  console.log(`=================================================\n`);
});