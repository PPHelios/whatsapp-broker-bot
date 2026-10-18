// server.js
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
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'media';
const MAX_VISION_IMAGES = 10; // Max images sent to Gemini for OCR & Hero selection

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ [DATABASE] Pool connection error:', err.message);
  } else {
    release();
  }
});

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder'
);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
const pendingQueues = new Map();

// ---------------------------------------------------------------------------
// Utility & Schema Helpers
// ---------------------------------------------------------------------------
function normalizeDigits(value = '') {
  return T.toEnDigits(value);
}

function normalizeCode(raw = '') {
  const s = normalizeDigits(String(raw || ''))
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, '')
    .toUpperCase();
  return s || '';
}

// Compute a 64-bit binary string for `phash bit(64) not null` in `listing_images`
function computeImageBit64Hash(buffer) {
  const digest = crypto.createHash('sha256').update(buffer).digest();
  let bits = '';
  for (let i = 0; i < 8; i++) {
    bits += digest[i].toString(2).padStart(8, '0');
  }
  return bits; // 64 characters of '0' and '1'
}

// Non-blocking audit logger into `usage_events`
async function logUsageEvent({
  agencyId = null,
  brokerId = null,
  phone = null,
  eventType,
  listingId = null,
  durationMs = null,
  costUsd = 0,
  tokensInput = 0,
  tokensOutput = 0,
  meta = {}
}) {
  try {
    await pool.query(
      `INSERT INTO usage_events (
        agency_id, broker_id, phone, event_type, listing_id,
        duration_ms, cost_usd, tokens_input, tokens_output, meta
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        agencyId,
        brokerId,
        phone,
        eventType,
        listingId,
        durationMs,
        costUsd,
        tokensInput,
        tokensOutput,
        JSON.stringify(meta || {})
      ]
    );
  } catch (err) {
    console.error('⚠️ [USAGE_EVENTS] Failed to log event:', err.message);
  }
}

// Upsert conversation state in `sessions`
async function upsertSession(phone, state, listingId = null, data = {}) {
  try {
    await pool.query(
      `INSERT INTO sessions (phone, state, listing_id, data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE
       SET state = EXCLUDED.state,
           listing_id = COALESCE(EXCLUDED.listing_id, sessions.listing_id),
           data = EXCLUDED.data,
           updated_at = NOW()`,
      [phone, state, listingId, JSON.stringify(data || {})]
    );
  } catch (err) {
    console.error('⚠️ [SESSIONS] Failed to update session:', err.message);
  }
}

// Build normalized `search_text` for PostgreSQL pg_trgm / ILIKE index
function buildSearchText(data = {}, rawText = '', code = '') {
  const parts = [
    code,
    data.title,
    data.property_type,
    T.translatePropertyType(data.property_type),
    data.listing_type === 'rent' ? 'ايجار إيجار rent' : 'بيع تمليك sale',
    data.location,
    data.location_name,
    data.price_display,
    data.area_value ? `${data.area_value} متر م2` : '',
    data.bedrooms ? `${data.bedrooms} غرف نوم` : '',
    Array.isArray(data.features) ? data.features.join(' ') : '',
    rawText
  ];
  return T.normalizeAr(parts.filter(Boolean).join(' '));
}

// ---------------------------------------------------------------------------
// WhatsApp Graph API Helpers
// ---------------------------------------------------------------------------
async function downloadWhatsAppMedia(mediaId) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });

    if (!metaRes.ok) {
      const errBody = await metaRes.json().catch(() => ({}));
      console.error('❌ [MEDIA] Meta lookup failed:', errBody);
      return null;
    }

    const { url, mime_type } = await metaRes.json();
    const mediaRes = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });

    if (!mediaRes.ok) {
      console.error('❌ [MEDIA] Payload download failed for media:', mediaId);
      return null;
    }

    const buffer = Buffer.from(await mediaRes.arrayBuffer());
    return {
      mediaId,
      buffer,
      mimeType: mime_type || 'application/octet-stream'
    };
  } catch (err) {
    console.error('❌ [MEDIA] Download error:', err.message);
    return null;
  }
}

async function sendWhatsAppText(to, text) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text }
        })
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error('❌ [WHATSAPP OUTBOUND] Failed:', JSON.stringify(errBody));
      return false;
    }

    return true;
  } catch (err) {
    console.error('❌ [WHATSAPP OUTBOUND] Network error:', err.message);
    return false;
  }
}

async function sendWhatsAppImage(to, imageUrl, caption) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'image',
          image: {
            link: imageUrl,
            caption: caption || ''
          }
        })
      }
    );

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      console.error('❌ [WHATSAPP IMAGE] Failed:', JSON.stringify(errBody));
      return false;
    }

    return true;
  } catch (err) {
    console.error('❌ [WHATSAPP IMAGE] Network error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Brochure Rendering & Storage Helper
// ---------------------------------------------------------------------------
async function generateAndUploadFlyer({ broker, listing, imageSources = [] }) {
  const startMs = Date.now();
  const typeAr = T.translatePropertyType(listing.property_type);
  const displayTitle =
    listing.title ||
    (listing.location ? `${typeAr} في ${listing.location}` : typeAr);

  const priceDisplay =
    listing.price_display ||
    (listing.price_value ? T.formatPrice(listing.price_value) : 'عند الطلب');

  const downPaymentDisplay = listing.down_payment_value
    ? T.formatPrice(listing.down_payment_value)
    : null;

  const pngBuffer = await R.renderFlyerPng({
    agencyName: broker.agency_name,
    brandColor: broker.brand_color,
    accentColor: broker.accent_color,
    logoUrl: broker.logo_url,
    code: listing.code,
    title: displayTitle,
    priceDisplay,
    area: listing.area_value ? `${listing.area_value} م²` : null,
    bedrooms: listing.bedrooms ? `${listing.bedrooms} غرف` : null,
    location: listing.location || listing.location_name || 'القاهرة',
    brokerPhone: broker.contact_phone || broker.phone,
    features: Array.isArray(listing.features) ? listing.features : [],
    images: imageSources,
    downPayment: downPaymentDisplay,
    installmentYears: listing.installment_years || null
  });

  const storagePath = `${broker.agency_id}/${listing.id}/flyer.png`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, pngBuffer, {
      contentType: 'image/png',
      upsert: true
    });

  if (uploadError) throw uploadError;

  const { data: urlData } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const flyerPublicUrl = urlData.publicUrl;

  await pool.query(
    'UPDATE listings SET flyer_url = $1, updated_at = NOW() WHERE id = $2',
    [flyerPublicUrl, listing.id]
  );

  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: broker.phone,
    eventType: 'brochure',
    listingId: listing.id,
    durationMs: Date.now() - startMs
  });

  return flyerPublicUrl;
}

// ---------------------------------------------------------------------------
// Express Routes & Webhook Verification
// ---------------------------------------------------------------------------
function verifyMetaSignature(req, res, next) {
  const secret = process.env.APP_SECRET;
  if (!secret) return next();

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return res.status(401).send('Missing signature');

  const signatureHash = signature.split('=')[1];
  const expectedHash = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || '')
    .digest('hex');

  if (signatureHash !== expectedHash) {
    return res.status(403).send('Invalid signature');
  }

  next();
}

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook', verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);

  const body = req.body || {};
  if (body.object !== 'whatsapp_business_account') return;

  const value = body.entry?.[0]?.changes?.[0]?.value;
  if (value?.statuses && value.statuses.length > 0) return;

  const messages = value?.messages;
  if (!messages || messages.length === 0) return;

  for (const msg of messages) {
    await handleIncomingWhatsAppMessage(msg);
  }
});

async function handleIncomingWhatsAppMessage(msg) {
  const from = String(msg.from || '').replace(/\D/g, '');
  const messageId = msg.id;

  try {
    const dedup = await pool.query(
      'INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING RETURNING message_id',
      [messageId]
    );

    if (dedup.rowCount === 0) return;
  } catch (err) {
    console.error('❌ [DEDUP] Query failed:', err.message);
  }

  let broker;
  try {
    const bRes = await pool.query(
      `SELECT b.*, a.name as agency_name, a.brand_color, a.accent_color, a.logo_url
       FROM brokers b
       JOIN agencies a ON a.id = b.agency_id
       WHERE regexp_replace(b.phone, '\\D', '', 'g') = $1 AND b.is_active = true`,
      [from]
    );

    if (bRes.rowCount === 0) {
      await logUsageEvent({ phone: from, eventType: 'unregistered' });
      await sendWhatsAppText(
        from,
        '⚠️ هذا الرقم غير مسجل في النظام. تواصل مع مدير الوكالة للتفعيل.'
      );
      return;
    }

    broker = bRes.rows[0];
  } catch (err) {
    console.error('❌ [AUTH] Broker lookup error:', err.message);
    return;
  }

  // Only treat as an immediate command if there is no active media/text batch waiting for this broker
  if (msg.type === 'text' && !pendingQueues.has(from)) {
    const textBody = (msg.text?.body || '').trim();
    const command = T.parseCommand(textBody);
    if (command) {
      return handleCommand(command, broker, from);
    }
  }

  enqueueIncomingMessage(from, msg, broker);
}

// ---------------------------------------------------------------------------
// Batching & Listing Processing Pipeline
// ---------------------------------------------------------------------------
function enqueueIncomingMessage(from, msg, broker) {
  const debounceDelay = parseInt(process.env.DEBOUNCE_MS, 10) || 8000;

  if (!pendingQueues.has(from)) {
    pendingQueues.set(from, { items: [], timer: null, broker });
    upsertSession(from, 'collecting', null, { startedAt: new Date().toISOString() });
  }

  const queue = pendingQueues.get(from);
  queue.items.push(msg);

  if (queue.timer) clearTimeout(queue.timer);

  queue.timer = setTimeout(async () => {
    const target = pendingQueues.get(from);
    pendingQueues.delete(from);

    if (target && target.items.length > 0) {
      try {
        await processBatchedListing(from, target.items, target.broker);
      } catch (err) {
        console.error('💥 [DEBOUNCE RUNTIME ERROR]:', err);
        await logUsageEvent({
          agencyId: target.broker?.agency_id,
          brokerId: target.broker?.id,
          phone: from,
          eventType: 'error',
          meta: { message: err.message }
        });
        await sendWhatsAppText(from, '⚠️ حدث خطأ فني أثناء المعالجة.').catch(() => {});
      }
    }
  }, debounceDelay);
}

async function processBatchedListing(from, items, broker) {
  const submissionStartMs = Date.now();
  const collectedText = [];
  const imageItems = [];
  const audioItems = [];

  for (const item of items) {
    if (item.type === 'text' && item.text?.body) {
      collectedText.push(item.text.body);
    } else if (item.type === 'image' && item.image) {
      imageItems.push(item.image);
      if (item.image.caption) collectedText.push(item.image.caption);
    } else if (item.type === 'document' && item.document?.mime_type?.startsWith('image/')) {
      imageItems.push(item.document);
      if (item.document.caption) collectedText.push(item.document.caption);
    } else if ((item.type === 'audio' || item.type === 'voice') && (item.audio || item.voice)) {
      audioItems.push(item.audio || item.voice);
    }
  }

  if (imageItems.length === 0 && collectedText.length === 0 && audioItems.length === 0) {
    return;
  }

  sendWhatsAppText(from, '⏳ جاري استخراج البياناتواختيار أفضل الصور وتصميم الكتالوج...').catch(() => {});

  // 1. Download all images & voice notes from WhatsApp
  const downloadedImages = [];
  for (const img of imageItems) {
    if (!img?.id) continue;
    const media = await downloadWhatsAppMedia(img.id);
    if (media && media.buffer) {
      const mimeType = media.mimeType.startsWith('image/') ? media.mimeType : 'image/jpeg';
      downloadedImages.push({
        mediaId: img.id,
        buffer: media.buffer,
        mimeType,
        dataUri: `data:${mimeType};base64,${media.buffer.toString('base64')}`,
        phash: computeImageBit64Hash(media.buffer)
      });
    }
  }

  const downloadedAudio = [];
  for (const aud of audioItems) {
    if (!aud?.id) continue;
    const media = await downloadWhatsAppMedia(aud.id);
    if (media && media.buffer) {
      downloadedAudio.push({
        mediaId: aud.id,
        buffer: media.buffer,
        mimeType: media.mimeType || 'audio/ogg'
      });
    }
  }

  // 2. Build Multimodal Gemini Request (Text + Labeled Photos + Voice Notes)
  const visionCount = Math.min(downloadedImages.length, MAX_VISION_IMAGES);
  const rawTextJoined = collectedText.join('\n').trim();

  const promptText = `
You are an expert Egyptian real estate AI assistant and architectural photo editor.
Extract the real estate unit parameters from the provided text, images (including any Arabic/English text inside flyers or screenshots), and audio voice notes into strict JSON format:
{
  "code": "optional alphanumeric unit code if explicitly mentioned in text/image (e.g. ANH245, MV-104, A101) or null",
  "title": "concise attractive Arabic title for the unit (e.g. شقة فاخرة بفيو مفتوح في التجمع الخامس)",
  "property_type": "apartment | villa | townhouse | twinhouse | duplex | penthouse | studio | chalet | office | commercial",
  "listing_type": "sale | rent",
  "price_value": numeric total price in EGP (e.g. 6500000) or null,
  "price_display": "formatted Arabic price string (e.g. 6,500,000 جنيه or 6.5 مليون جنيه) or null",
  "area_value": numeric square meters (e.g. 165) or null,
  "bedrooms": numeric integer count of bedrooms (e.g. 3) or null,
  "location": "compound name and/or district in Arabic (e.g. التجمع الخامس - كمبوند ميفيدا)",
  "location_name": "city or area name in Arabic (e.g. القاهرة الجديدة)",
  "features": ["up to 6 key features in Arabic, e.g. تشطيب الترا سوبر لوكس, بحري, فيو لاندسكيب, استلام فوري"],
  "language": "ar | en",
  "hero_position": integer (0-based index from 0 to ${Math.max(0, visionCount - 1)} of the single BEST cover photo),
  "image_order": [array of 0-based integer indices ranking the images from best to worst visual appeal, starting with hero_position],
  "is_primary_developer": boolean (true if developer installment plan is offered),
  "down_payment_value": numeric down payment in EGP or null,
  "installment_years": numeric integer years of installments or null,
  "installment_value": numeric installment check amount or null,
  "payment_frequency": "monthly | quarterly | semi_annual | annual",
  "delivery_date": "delivery year/status in Arabic or null",
  "maintenance_pct": numeric maintenance percentage or null,
  "transcribed_text": "if audio or image text was read, include a summary of the raw text here"
}

Hero Image & Ranking Rules (for hero_position and image_order):
- Evaluate all ${visionCount} attached images (labeled Image Index 0 to Image Index ${Math.max(0, visionCount - 1)}).
- Pick the single most visually impressive photo as "hero_position":
  1. First priority: Bright, wide-angle exterior building/villa facade, swimming pool, garden, or open landscape/sea view.
  2. Second priority: Spacious, well-lit main reception / living room with high-end finishing.
  3. Third priority: Master bedroom or clean architectural shot.
- NEVER pick a bathroom, toilet, narrow corridor, unfurnished dark corner, floorplan diagram, or text-heavy screenshot as "hero_position" unless no other photo exists.
- In "image_order", list the indices from best to worst so the top 5 photos make an attractive brochure mosaic.

Data Extraction Rules:
- Convert any shorthand like "6.5 مليون" to price_value: 6500000.
- If a number like "180م" or "180 متر" is mentioned, set area_value: 180.
- If bedrooms are mentioned (e.g. "3 غرف" or "3 نوم"), set bedrooms: 3.
- Do NOT invent numbers if they are not present in the text, images, or audio; use null instead.

Provided Text:
${rawTextJoined || '(No text caption provided — extract details from the attached images/audio)'}
  `.trim();

  const geminiContents = [];

  // Attach up to MAX_VISION_IMAGES (10) with explicit index labels so Gemini knows exact 0-based positions
  for (let i = 0; i < visionCount; i++) {
    const img = downloadedImages[i];
    geminiContents.push({ text: `Image Index ${i}:` });
    geminiContents.push({
      inlineData: {
        data: img.buffer.toString('base64'),
        mimeType: img.mimeType
      }
    });
  }

  // Attach any voice notes for native audio extraction
  for (const aud of downloadedAudio) {
    geminiContents.push({
      inlineData: {
        data: aud.buffer.toString('base64'),
        mimeType: aud.mimeType
      }
    });
  }

  geminiContents.push({ text: promptText });

  let extractedData = {};
  const geminiStartMs = Date.now();
  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model: modelName,
      contents: geminiContents,
      config: { responseMimeType: 'application/json' }
    });

    const rawJson = (response.text || '{}').trim();
    extractedData = JSON.parse(rawJson);

    const usageMeta = response.usageMetadata || {};
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'gemini',
      durationMs: Date.now() - geminiStartMs,
      tokensInput: usageMeta.promptTokenCount || 0,
      tokensOutput: usageMeta.candidatesTokenCount || 0,
      meta: {
        model: modelName,
        imagesCount: downloadedImages.length,
        audioCount: downloadedAudio.length,
        heroChosen: extractedData.hero_position
      }
    });
  } catch (err) {
    console.error('❌ [GEMINI] Extraction failed:', err.message);
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'error',
      meta: { stage: 'gemini', message: err.message }
    });
    await sendWhatsAppText(from, '⚠️ حدث خطأ أثناء تحليل بيانات الإعلان.');
    return;
  }

  // Fallback regex extraction if rawText had price/area/rooms that Gemini missed
  if (!extractedData.price_value && rawTextJoined) {
    const fallbackPrice = T.parsePrice(rawTextJoined);
    if (fallbackPrice) extractedData.price_value = fallbackPrice;
  }
  if (extractedData.price_value && !extractedData.price_display) {
    extractedData.price_display = T.formatPrice(extractedData.price_value);
  }

  let listingCode = normalizeCode(extractedData.code);
  if (!listingCode) {
    const seq = await pool.query("SELECT nextval('listing_code_seq') AS code");
    listingCode = String(seq.rows[0].code);
  }

  const typeAr = T.translatePropertyType(extractedData.property_type);
  const locationText = extractedData.location || extractedData.location_name || null;
  const propertyTitle =
    extractedData.title ||
    (locationText ? `${typeAr} في ${locationText}` : typeAr);

  const combinedRawText = [rawTextJoined, extractedData.transcribed_text]
    .filter(Boolean)
    .join('\n')
    .trim();

  const searchText = buildSearchText(extractedData, combinedRawText, listingCode);

  // Determine heroPosition and ranked image order
  const parsedHeroPos = Number(extractedData.hero_position);
  const heroPosition =
    Number.isInteger(parsedHeroPos) &&
    parsedHeroPos >= 0 &&
    parsedHeroPos < downloadedImages.length
      ? parsedHeroPos
      : 0;

  // Build ranked index list: start with heroPosition, then valid indices from image_order, then any remaining images
  const rankedIndices = [];
  const addIndex = (idx) => {
    const n = Number(idx);
    if (
      Number.isInteger(n) &&
      n >= 0 &&
      n < downloadedImages.length &&
      !rankedIndices.includes(n)
    ) {
      rankedIndices.push(n);
    }
  };

  addIndex(heroPosition);
  if (Array.isArray(extractedData.image_order)) {
    extractedData.image_order.forEach(addIndex);
  }
  for (let i = 0; i < downloadedImages.length; i++) {
    addIndex(i);
  }

  const rankedImages = rankedIndices.map((idx) => downloadedImages[idx]);

  const validFrequency = ['monthly', 'quarterly', 'semi_annual', 'annual'].includes(
    extractedData.payment_frequency
  )
    ? extractedData.payment_frequency
    : 'quarterly';

  // 3. Upsert into `listings` (handles agency_id + code uniqueness gracefully)
  let listingRow;
  try {
    const ins = await pool.query(
      `INSERT INTO listings (
        agency_id, broker_id, code, status, title, property_type, listing_type,
        price_value, price_display, area_value, bedrooms, location, location_name,
        features, language, raw_text, details, search_text, hero_position,
        is_primary_developer, down_payment_value, installment_years, installment_value,
        payment_frequency, delivery_date, maintenance_pct
      ) VALUES (
        $1, $2, $3, 'active', $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22,
        $23, $24, $25
      )
      ON CONFLICT (agency_id, code) DO UPDATE SET
        broker_id = EXCLUDED.broker_id,
        status = 'active',
        title = COALESCE(EXCLUDED.title, listings.title),
        property_type = COALESCE(EXCLUDED.property_type, listings.property_type),
        listing_type = COALESCE(EXCLUDED.listing_type, listings.listing_type),
        price_value = COALESCE(EXCLUDED.price_value, listings.price_value),
        price_display = COALESCE(EXCLUDED.price_display, listings.price_display),
        area_value = COALESCE(EXCLUDED.area_value, listings.area_value),
        bedrooms = COALESCE(EXCLUDED.bedrooms, listings.bedrooms),
        location = COALESCE(EXCLUDED.location, listings.location),
        location_name = COALESCE(EXCLUDED.location_name, listings.location_name),
        features = CASE WHEN array_length(EXCLUDED.features, 1) > 0 THEN EXCLUDED.features ELSE listings.features END,
        raw_text = COALESCE(NULLIF(EXCLUDED.raw_text, ''), listings.raw_text),
        details = EXCLUDED.details,
        search_text = EXCLUDED.search_text,
        hero_position = EXCLUDED.hero_position,
        is_primary_developer = EXCLUDED.is_primary_developer,
        down_payment_value = COALESCE(EXCLUDED.down_payment_value, listings.down_payment_value),
        installment_years = COALESCE(EXCLUDED.installment_years, listings.installment_years),
        installment_value = COALESCE(EXCLUDED.installment_value, listings.installment_value),
        payment_frequency = COALESCE(EXCLUDED.payment_frequency, listings.payment_frequency),
        delivery_date = COALESCE(EXCLUDED.delivery_date, listings.delivery_date),
        updated_at = NOW()
      RETURNING *`,
      [
        broker.agency_id,
        broker.id,
        listingCode,
        propertyTitle,
        extractedData.property_type || 'apartment',
        extractedData.listing_type || 'sale',
        extractedData.price_value || null,
        extractedData.price_display || null,
        extractedData.area_value || null,
        extractedData.bedrooms ? parseInt(extractedData.bedrooms, 10) : null,
        locationText,
        extractedData.location_name || locationText,
        Array.isArray(extractedData.features) ? extractedData.features : [],
        extractedData.language === 'en' ? 'en' : 'ar',
        combinedRawText || null,
        JSON.stringify(extractedData),
        searchText,
        heroPosition,
        Boolean(extractedData.is_primary_developer),
        extractedData.down_payment_value || null,
        extractedData.installment_years ? parseInt(extractedData.installment_years, 10) : null,
        extractedData.installment_value || null,
        validFrequency,
        extractedData.delivery_date || null,
        extractedData.maintenance_pct ?? 8
      ]
    );

    listingRow = ins.rows[0];
  } catch (err) {
    console.error('❌ [DATABASE] Insertion failed:', err.message);
    await sendWhatsAppText(from, `⚠️ فشل حفظ العقار في قاعدة البيانات: ${err.message}`);
    return;
  }

  // 4. Upload Original Photos in Ranked Order (Position 0 = AI Hero Image) & Save to `listing_images`
  const uploadedImageUrls = [];
  if (rankedImages.length > 0) {
    // Check for duplicate images within the same agency
    try {
      const dupCheck = await pool.query(
        `SELECT li.listing_id, l.code
         FROM listing_images li
         JOIN listings l ON l.id = li.listing_id
         WHERE li.agency_id = $1 AND li.phash = $2::bit(64) AND li.listing_id <> $3
         LIMIT 1`,
        [broker.agency_id, rankedImages[0].phash, listingRow.id]
      );
      if (dupCheck.rowCount > 0) {
        await logUsageEvent({
          agencyId: broker.agency_id,
          brokerId: broker.id,
          phone: from,
          eventType: 'duplicate_warning',
          listingId: listingRow.id,
          meta: { matchedCode: dupCheck.rows[0].code }
        });
      }
    } catch (dupErr) {
      console.error('⚠️ [DUPLICATE CHECK] Error:', dupErr.message);
    }

    // Clear previous images if updating an existing code
    await pool.query('DELETE FROM listing_images WHERE listing_id = $1', [listingRow.id]);

    for (let i = 0; i < rankedImages.length; i++) {
      const img = rankedImages[i];
      const ext = img.mimeType.includes('png') ? 'png' : 'jpg';
      const photoPath = `${broker.agency_id}/${listingRow.id}/photo_${i}.${ext}`;

      try {
        const { error: photoErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(photoPath, img.buffer, {
            contentType: img.mimeType,
            upsert: true
          });

        if (!photoErr) {
          const { data: pubData } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(photoPath);

          const publicUrl = pubData.publicUrl;
          uploadedImageUrls.push(publicUrl);

          await pool.query(
            `INSERT INTO listing_images (listing_id, agency_id, position, url, phash)
             VALUES ($1, $2, $3, $4, $5::bit(64))`,
            [listingRow.id, broker.agency_id, i, publicUrl, img.phash]
          );
        }
      } catch (imgErr) {
        console.error(`❌ [IMAGE UPLOAD #${i}] Error:`, imgErr.message);
      }
    }
  }

  // Pass ranked in-memory base64 Data URIs to Satori (Index 0 is the AI-chosen Hero Image)
  const orderedDataUris = rankedImages.map((d) => d.dataUri);
  const renderImageSources =
    orderedDataUris.length > 0 ? orderedDataUris : uploadedImageUrls;

  // 5. Render Flyer PNG & Upload to Supabase
  let flyerPublicUrl = null;
  try {
    flyerPublicUrl = await generateAndUploadFlyer({
      broker,
      listing: listingRow,
      imageSources: renderImageSources
    });
  } catch (err) {
    console.error('❌ [RENDER] Brochure rendering/upload error:', err.message);
  }

  await upsertSession(from, 'review', listingRow.id, {
    code: listingCode,
    flyerUrl: flyerPublicUrl
  });

  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: from,
    eventType: 'submission',
    listingId: listingRow.id,
    durationMs: Date.now() - submissionStartMs,
    meta: {
      code: listingCode,
      imagesCount: downloadedImages.length,
      heroPosition
    }
  });

  const displayPrice =
    listingRow.price_display ||
    (listingRow.price_value ? T.formatPrice(listingRow.price_value) : 'عند الطلب');
  const displayArea = listingRow.area_value ? `${listingRow.area_value} م²` : '-';
  const displayRooms = listingRow.bedrooms ? `${listingRow.bedrooms} غرف` : '-';

  if (flyerPublicUrl) {
    const caption = [
      `🏡 *تم تجهيز الكتالوج بنجاح!*`,
      `• الكود: *#${listingCode}*`,
      `• الوحدة: *${propertyTitle}*`,
      `• السعر: *${displayPrice}*`,
      `• المساحة: *${displayArea}* | الغرف: *${displayRooms}*`,
      `• الموقع: *${locationText || 'القاهرة'}*`
    ].join('\n');

    await sendWhatsAppImage(from, `${flyerPublicUrl}?t=${Date.now()}`, caption);
  } else {
    await sendWhatsAppText(
      from,
      `✅ تم حفظ العقار برقم *#${listingCode}*، ولكن تعذر إنشاء الصورة الترويجية.`
    );
  }
}

// ---------------------------------------------------------------------------
// Command Handlers (help, status, price, show, search, stats, confirm, skip)
// ---------------------------------------------------------------------------
async function handleCommand(cmd, broker, from) {
  const startMs = Date.now();

  if (cmd.type === 'help') {
    return sendWhatsAppText(
      from,
      [
        '📖 *دليل أوامر النظام:*',
        '',
        '• *إضافة عقار:* أرسل الصور مع الوصف أو رسالة صوتية.',
        '• *عرض عقار:* عقار 1001 أو #ANH245',
        '• *بحث في العقارات:* بحث شقة التجمع أو بحث فيلا زايد',
        '• *تحديث سعر:* سعر ANH245 إلى 8.5 مليون',
        '• *تحديث حالة:* تم البيع ANH245 | أرشيف ANH245 | تفعيل ANH245',
        '• *إحصائيات:* احصائيات'
      ].join('\n')
    );
  }

  if (cmd.type === 'confirm' || cmd.type === 'skip') {
    const sRes = await pool.query('SELECT * FROM sessions WHERE phone = $1', [from]);
    const listingId = sRes.rows[0]?.listing_id;
    if (listingId) {
      await pool.query(
        "UPDATE listings SET status = 'active', updated_at = NOW() WHERE id = $1",
        [listingId]
      );
    }
    await pool.query('DELETE FROM sessions WHERE phone = $1', [from]);
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'confirm',
      listingId
    });
    return sendWhatsAppText(from, '✅ تم اعتماد وتفعيل الإعلان بنجاح.');
  }

  if (cmd.type === 'status') {
    const cleanCode = normalizeCode(cmd.code);
    const res = await pool.query(
      'UPDATE listings SET status = $1, updated_at = NOW() WHERE agency_id = $2 AND lower(code) = lower($3) RETURNING id, code',
      [cmd.status, broker.agency_id, cleanCode]
    );

    if (res.rowCount > 0) {
      const row = res.rows[0];
      await logUsageEvent({
        agencyId: broker.agency_id,
        brokerId: broker.id,
        phone: from,
        eventType: 'status',
        listingId: row.id,
        durationMs: Date.now() - startMs,
        meta: { status: cmd.status, code: row.code }
      });
      const statusAr =
        cmd.status === 'sold' ? 'مباع (Sold)' : cmd.status === 'archived' ? 'مؤرشف (Archived)' : 'نشط (Active)';
      return sendWhatsAppText(from, `✅ تم تحديث حالة العقار *#${row.code}* إلى: *${statusAr}*`);
    }

    return sendWhatsAppText(from, `❌ لم يتم العثور على عقار بالكود *#${cleanCode}*`);
  }

  if (cmd.type === 'price') {
    const cleanCode = normalizeCode(cmd.code);
    const parsed = T.parsePrice(normalizeDigits(cmd.priceText));
    if (!parsed) {
      return sendWhatsAppText(from, `⚠️ لم نتمكن من قراءة السعر الجديد: "${cmd.priceText}"`);
    }

    const display = T.formatPrice(parsed);
    const res = await pool.query(
      `UPDATE listings
       SET price_value = $1, price_display = $2, updated_at = NOW()
       WHERE agency_id = $3 AND lower(code) = lower($4)
       RETURNING *`,
      [parsed, display, broker.agency_id, cleanCode]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(from, `❌ لم يتم العثور على عقار بالكود *#${cleanCode}*`);
    }

    const updatedListing = res.rows[0];
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'price',
      listingId: updatedListing.id,
      durationMs: Date.now() - startMs,
      meta: { code: updatedListing.code, newPrice: parsed }
    });

    // Re-render flyer with the new price and existing ranked images
    try {
      const imgsRes = await pool.query(
        'SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC',
        [updatedListing.id]
      );
      const imageUrls = imgsRes.rows.map((r) => r.url);
      const newFlyerUrl = await generateAndUploadFlyer({
        broker,
        listing: updatedListing,
        imageSources: imageUrls
      });
      return sendWhatsAppImage(
        from,
        `${newFlyerUrl}?t=${Date.now()}`,
        `✅ تم تحديث سعر العقار *#${updatedListing.code}* إلى: *${display}* وتحديث الكتالوج.`
      );
    } catch (err) {
      console.error('⚠️ [PRICE RE-RENDER] Failed:', err.message);
      return sendWhatsAppText(
        from,
        `✅ تم تحديث سعر العقار *#${updatedListing.code}* إلى: *${display}*`
      );
    }
  }

  if (cmd.type === 'show') {
    const cleanCode = normalizeCode(cmd.code);
    const res = await pool.query(
      'SELECT * FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)',
      [broker.agency_id, cleanCode]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(from, `❌ العقار *#${cleanCode}* غير مسجل.`);
    }

    const l = res.rows[0];
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'show',
      listingId: l.id,
      durationMs: Date.now() - startMs
    });

    const caption = [
      `📋 *بيانات العقار #${l.code}*`,
      `• العنوان: ${l.title || '-'}`,
      `• السعر: *${l.price_display || 'عند الطلب'}*`,
      `• المساحة: ${l.area_value ? `${l.area_value} م²` : '-'} | الغرف: ${l.bedrooms || '-'}`,
      `• الموقع: ${l.location || '-'}`,
      `• الحالة: ${l.status}`
    ].join('\n');

    if (l.flyer_url) {
      return sendWhatsAppImage(from, `${l.flyer_url}?t=${Date.now()}`, caption);
    }

    return sendWhatsAppText(from, caption);
  }

  if (cmd.type === 'search') {
    const normalizedQuery = T.normalizeAr(cmd.query);
    const tokens = normalizedQuery.split(' ').filter(Boolean);

    if (tokens.length === 0) {
      return sendWhatsAppText(from, '⚠️ يرجى كتابة كلمات البحث بعد كلمة "بحث".');
    }

    // Match all tokens against search_text, title, location, or code
    const conditions = tokens.map(
      (_, i) =>
        `(search_text ILIKE $${i + 2} OR COALESCE(location, '') ILIKE $${i + 2} OR COALESCE(title, '') ILIKE $${i + 2} OR code ILIKE $${i + 2})`
    );
    const values = [broker.agency_id, ...tokens.map((tok) => `%${tok}%`)];

    const sRes = await pool.query(
      `SELECT code, title, price_display, area_value, bedrooms, location
       FROM listings
       WHERE agency_id = $1 AND status = 'active' AND ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 8`,
      values
    );

    // Record buyer demand in `search_analytics`
    try {
      await pool.query(
        `INSERT INTO search_analytics (agency_id, broker_id, query_raw, tokens, results_count, is_voice)
         VALUES ($1, $2, $3, $4, $5, false)`,
        [broker.agency_id, broker.id, cmd.query, tokens, sRes.rowCount]
      );
    } catch (saErr) {
      console.error('⚠️ [SEARCH_ANALYTICS] Insert error:', saErr.message);
    }

    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'search',
      durationMs: Date.now() - startMs,
      meta: { query: cmd.query, resultsCount: sRes.rowCount }
    });

    if (sRes.rowCount === 0) {
      return sendWhatsAppText(from, `🔍 لا توجد وحدات نشطة تطابق بحثك: "${cmd.query}"`);
    }

    const lines = sRes.rows.map(
      (r) =>
        `• *#${r.code}* — ${r.title || 'وحدة'} (${r.location || '-'})\n  💰 ${r.price_display || 'عند الطلب'} | 📐 ${r.area_value ? `${r.area_value}م²` : '-'} | 🛏️ ${r.bedrooms || '-'}`
    );

    return sendWhatsAppText(
      from,
      `🔍 *نتائج البحث (${sRes.rowCount}):*\n\n${lines.join('\n\n')}\n\n💡 لعرض كتالوج أي وحدة أرسل: *#الكود*`
    );
  }

  if (cmd.type === 'stats') {
    const countsRes = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active') AS active_count,
         COUNT(*) FILTER (WHERE status = 'sold') AS sold_count,
         COUNT(*) FILTER (WHERE status = 'archived') AS archived_count,
         COUNT(*) AS total_count
       FROM listings
       WHERE agency_id = $1`,
      [broker.agency_id]
    );

    const c = countsRes.rows[0] || {};
    return sendWhatsAppText(
      from,
      [
        `📊 *إحصائيات ${broker.agency_name}:*`,
        `• إجمالي الوحدات: *${c.total_count || 0}*`,
        `• وحدات نشطة: *${c.active_count || 0}*`,
        `• وحدات مباعة: *${c.sold_count || 0}*`,
        `• وحدات مؤرشفة: *${c.archived_count || 0}*`
      ].join('\n')
    );
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [GLOBAL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('🚨 [GLOBAL] Uncaught Exception:', err);
});

app.listen(PORT, () => {
  console.log(`🚀 Real Estate WhatsApp Engine Online | Port: ${PORT}`);
});