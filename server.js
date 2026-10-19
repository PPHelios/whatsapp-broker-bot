// server.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
const sharp = require('sharp');

const T = require('./lib/text');
const R = require('./lib/render');
const S = require('./lib/search');

// ---------------------------------------------------------------------------
// 1. Boot Environment Guard: Require APP_SECRET unless local bypass is explicit
// ---------------------------------------------------------------------------
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true';
const APP_SECRET = process.env.APP_SECRET;

if (!APP_SECRET && !ALLOW_UNSIGNED) {
  console.error('🚨 [FATAL] Server cannot start: APP_SECRET is missing.');
  console.error('👉 Set APP_SECRET in your .env or set ALLOW_UNSIGNED_WEBHOOKS=true for local testing only.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET || 'media';
const MAX_VISION_IMAGES = 15;
const CODE_WAITING_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

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
function cleanAudioMime(mime = '') {
  return String(mime || 'audio/ogg').split(';')[0].trim().toLowerCase() || 'audio/ogg';
}

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

async function computeDHash64(buffer) {
  try {
    const rawPixels = await sharp(buffer)
      .grayscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    let hash = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left = rawPixels[row * 9 + col];
        const right = rawPixels[row * 9 + col + 1];
        hash += left < right ? '1' : '0';
      }
    }
    return hash;
  } catch (_) {
    return '0'.repeat(64);
  }
}

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

function buildSearchText(data = {}, rawText = '', code = '') {
  const parts = [
    code,
    data.title,
    data.property_type,
    T.translatePropertyType(data.property_type),
    data.listing_type === 'rent' ? 'ايجار إيجار rent' : 'بيع تمليك sale',
    data.location,
    data.location_name,
    data.compound,
    data.district,
    data.city,
    Array.isArray(data.location_keywords) ? data.location_keywords.join(' ') : '',
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

    const rawBuffer = Buffer.from(await mediaRes.arrayBuffer());

    if ((mime_type || '').startsWith('image/')) {
      const optimizedBuffer = await sharp(rawBuffer)
        .rotate()
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();

      return {
        mediaId,
        buffer: optimizedBuffer,
        mimeType: 'image/jpeg'
      };
    }

    return {
      mediaId,
      buffer: rawBuffer,
      mimeType: cleanAudioMime(mime_type)
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

  const jpegBuffer = await R.renderFlyerJpeg({
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

  const storagePath = `${broker.agency_id}/${listing.id}/flyer.jpg`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, jpegBuffer, {
      contentType: 'image/jpeg',
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
// Webhook Signature Middleware
// ---------------------------------------------------------------------------
function verifyMetaSignature(req, res, next) {
  if (ALLOW_UNSIGNED && !APP_SECRET) {
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('⚠️ [SECURITY] Rejected webhook: Missing x-hub-signature-256 header.');
    return res.status(401).send('Missing signature');
  }

  const signatureHash = signature.split('=')[1];
  const expectedHash = crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody || '')
    .digest('hex');

  if (signatureHash !== expectedHash) {
    console.warn('⚠️ [SECURITY] Rejected webhook: Invalid HMAC signature.');
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

  // -------------------------------------------------------------------------
  // Check for Pending 10-Minute Waiting Code Session
  // -------------------------------------------------------------------------
  const sRes = await pool.query('SELECT * FROM sessions WHERE phone = $1', [from]);
  if (sRes.rowCount > 0 && sRes.rows[0].state === 'waiting_code') {
    const session = sRes.rows[0];
    const elapsed = Date.now() - new Date(session.updated_at).getTime();

    if (elapsed > CODE_WAITING_WINDOW_MS) {
      await pool.query('DELETE FROM sessions WHERE phone = $1', [from]);
      await sendWhatsAppText(from, '⏳ انتهت مهلة الـ 10 دقائق لتعديل الكود وتم إلغاء حفظ الإعلان.');
    } else if (msg.type === 'text') {
      const candidateCode = normalizeCode(msg.text?.body || '');
      const isPureCode = /^[A-Z0-9_-]{2,20}$/i.test(candidateCode) && /\d/.test(candidateCode);

      if (isPureCode) {
        const dupCheck = await pool.query(
          'SELECT id FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)',
          [broker.agency_id, candidateCode]
        );

        if (dupCheck.rowCount > 0) {
          return sendWhatsAppText(
            from,
            `⚠️ الكود *#${candidateCode}* مستخدم أيضاً! أرسل كود آخر متاح:`
          );
        }

        await pool.query('DELETE FROM sessions WHERE phone = $1', [from]);
        await sendWhatsAppText(from, `⏳ جاري حفظ العقار بالكود الجديد *#${candidateCode}*...`);
        return finalizeListingCreation({
          broker,
          from,
          draftData: session.data.draftData,
          listingCode: candidateCode,
          rankedImages: session.data.rankedImages
        });
      } else {
        await pool.query('DELETE FROM sessions WHERE phone = $1', [from]);
        await sendWhatsAppText(from, '❌ تم إلغاء حفظ الإعلان السابق.');
      }
    } else {
      await pool.query('DELETE FROM sessions WHERE phone = $1', [from]);
      await sendWhatsAppText(from, '❌ تم إلغاء حفظ الإعلان السابق لبدء رسالة جديدة.');
    }
  }

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
        // Generic error message for broker, details logged internally only
        await sendWhatsAppText(from, '⚠️ حدث خطأ فني أثناء المعالجة. يرجى إعادة المحاولة لاحقاً.').catch(() => {});
      }
    }
  }, debounceDelay);
}

async function processBatchedListing(from, items, broker) {
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

  if (imageItems.length === 0) {
    const handled = await routeTextOrVoice({ from, broker, collectedText, audioItems });
    if (handled) return;
  }

  sendWhatsAppText(from, '⏳ جاري استخراج البيانات واختيار أفضل الصور وتصميم الكتالوج...').catch(() => {});

  const downloadedImages = [];
  for (const img of imageItems) {
    if (!img?.id) continue;
    const media = await downloadWhatsAppMedia(img.id);
    if (media && media.buffer) {
      const phash = await computeDHash64(media.buffer);
      downloadedImages.push({
        mediaId: img.id,
        buffer: media.buffer,
        mimeType: media.mimeType,
        dataUri: `data:${media.mimeType};base64,${media.buffer.toString('base64')}`,
        phash
      });
    }
  }

  const downloadedAudio = [];
  for (const aud of audioItems) {
    if (!aud?.id) continue;
    const cachedAudio = mediaCache.get(aud.id);
    const media = cachedAudio ? cachedAudio.media : await downloadWhatsAppMedia(aud.id);
    if (media && media.buffer) {
      downloadedAudio.push({
        mediaId: aud.id,
        buffer: media.buffer,
        mimeType: cleanAudioMime(media.mimeType)
      });
    }
  }

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
  "compound": "compound / project name in Arabic (e.g. ميفيدا) or null",
  "district": "district in Arabic (e.g. التجمع الخامس, الشيخ زايد, مدينة نصر) or null",
  "city": "city / region in Arabic (e.g. القاهرة الجديدة, 6 أكتوبر) or null",
  "location_keywords": ["up to 12 names a buyer might type to find this unit: the compound, district and city in Arabic AND English/Franco spellings, common misspellings, developer name if known"],
  "features": ["up to 6 key features in Arabic, e.g. تشطيب الترا سوبر لوكس, بحري, فيو لاندسكيب, استلام فوري"],
  "language": "ar | en",
  "hero_position": integer (0-based index from 0 to ${Math.max(0, visionCount - 1)} of the single BEST cover photo),
  "image_order": [array of 0-based integer indices ranking the images from best to worst visual appeal, starting with hero_position],
  "duplicate_indices": [array of indices of any redundant or near-duplicate images in this batch to discard],
  "floorplan_indices": [array of indices of floor plans or 2D layout diagrams],
  "is_primary_developer": boolean (true if developer installment plan is offered),
  "down_payment_value": numeric down payment in EGP or null,
  "installment_years": numeric integer years of installments or null,
  "installment_value": numeric installment check amount or null,
  "payment_frequency": "monthly | quarterly | semi_annual | annual",
  "delivery_date": "delivery year/status in Arabic or null",
  "maintenance_pct": numeric maintenance percentage or null,
  "transcribed_text": "if audio or image text was read, include a summary of the raw text here"
}

Hero Image & Ranking Rules:
- Evaluate all ${visionCount} attached images (labeled Image Index 0 to Image Index ${Math.max(0, visionCount - 1)}).
- Pick the single most visually impressive photo as "hero_position":
  1. First priority: Bright, wide-angle exterior facade, pool, garden, or landscape view.
  2. Second priority: Spacious, well-lit main reception / living room with high-end finishing.
  3. Third priority: Master bedroom or clean architectural shot.
- NEVER pick a bathroom, toilet, corridor, dark corner, or floorplan diagram as "hero_position".
- Mark floor plans in "floorplan_indices" so they are stored but excluded from the main photo mosaic.
- In "image_order", rank the best architectural and room photos in descending order of visual appeal.

Data Extraction Rules:
- Convert any shorthand like "6.5 مليون" to price_value: 6500000.
- If a number like "180م" or "180 متر" is mentioned, set area_value: 180.
- If bedrooms are mentioned (e.g. "3 غرف" or "3 نوم"), set bedrooms: 3.
- Do NOT invent numbers if they are not present in the text, images, or audio; use null instead.

Provided Text:
${rawTextJoined || '(No text caption provided — extract details from the attached images/audio)'}
  `.trim();

  const geminiContents = [];
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

  for (const aud of downloadedAudio) {
    geminiContents.push({
      inlineData: {
        data: aud.buffer.toString('base64'),
        mimeType: cleanAudioMime(aud.mimeType)
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
    // Generic error message for broker, details logged internally only
    await sendWhatsAppText(from, '⚠️ تعذر قراءة بيانات الإعلان تلقائياً. يرجى التأكد من وضوح الصور أو النصوص.');
    return;
  }

  if (!extractedData.price_value && rawTextJoined) {
    const fallbackPrice = T.parsePrice(rawTextJoined);
    if (fallbackPrice) extractedData.price_value = fallbackPrice;
  }
  if (extractedData.price_value && !extractedData.price_display) {
    extractedData.price_display = T.formatPrice(extractedData.price_value);
  }

  let listingCode = normalizeCode(extractedData.code);
  const isExplicitCode = Boolean(listingCode);

  // Auto-generate code if none was provided, silently retrying if a sequence code already exists
  if (!listingCode) {
    while (true) {
      const seq = await pool.query("SELECT nextval('listing_code_seq') AS code");
      const cand = String(seq.rows[0].code);
      const exists = await pool.query(
        'SELECT 1 FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)',
        [broker.agency_id, cand]
      );
      if (exists.rowCount === 0) {
        listingCode = cand;
        break;
      }
    }
  }

  // Check collision for explicit broker-supplied code
  if (isExplicitCode) {
    const existingCodeRes = await pool.query(
      'SELECT id, broker_id FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)',
      [broker.agency_id, listingCode]
    );

    if (existingCodeRes.rowCount > 0) {
      const existingListing = existingCodeRes.rows[0];
      const isSameBroker = String(existingListing.broker_id) === String(broker.id);

      // Different broker in same agency: Trigger 10-minute duplicate code window
      if (!isSameBroker) {
        const dupSet = new Set(Array.isArray(extractedData.duplicate_indices) ? extractedData.duplicate_indices : []);
        const fpSet = new Set(Array.isArray(extractedData.floorplan_indices) ? extractedData.floorplan_indices : []);

        const validOrder = [];
        const addIdx = (idx) => {
          const n = Number(idx);
          if (Number.isInteger(n) && n >= 0 && n < downloadedImages.length && !dupSet.has(n) && !validOrder.includes(n)) {
            validOrder.push(n);
          }
        };

        addIdx(extractedData.hero_position);
        if (Array.isArray(extractedData.image_order)) extractedData.image_order.forEach(addIdx);
        for (let i = 0; i < downloadedImages.length; i++) addIdx(i);

        const flyerMosaicImages = validOrder.filter((idx) => !fpSet.has(idx)).slice(0, 9).map((idx) => downloadedImages[idx]);
        const storedImages = validOrder.map((idx) => ({
          bufferB64: downloadedImages[idx].buffer.toString('base64'),
          mimeType: downloadedImages[idx].mimeType,
          phash: downloadedImages[idx].phash,
          isFloorplan: fpSet.has(idx)
        }));

        const draftPayload = {
          draftData: {
            ...extractedData,
            rawTextJoined,
            isExplicitCode
          },
          rankedImages: storedImages,
          flyerMosaicDataUris: flyerMosaicImages.map((d) => d.dataUri)
        };

        await upsertSession(from, 'waiting_code', null, draftPayload);
        await logUsageEvent({
          agencyId: broker.agency_id,
          brokerId: broker.id,
          phone: from,
          eventType: 'duplicate_warning',
          meta: { clashingCode: listingCode }
        });

        return sendWhatsAppText(
          from,
          `⚠️ الكود *#${listingCode}* مسجل بالفعل لوحدة أخرى تابعة لزميل في الوكالة.\n\nأرسل *كود جديد فقط* (مثلاً #A205) خلال 10 دقائق لحفظ الإعلان، أو أرسل أي رسالة أخرى لإلغاء العملية.`
        );
      }
    }
  }

  const dupSet = new Set(Array.isArray(extractedData.duplicate_indices) ? extractedData.duplicate_indices : []);
  const fpSet = new Set(Array.isArray(extractedData.floorplan_indices) ? extractedData.floorplan_indices : []);

  const validOrder = [];
  const addIdx = (idx) => {
    const n = Number(idx);
    if (Number.isInteger(n) && n >= 0 && n < downloadedImages.length && !dupSet.has(n) && !validOrder.includes(n)) {
      validOrder.push(n);
    }
  };

  addIdx(extractedData.hero_position);
  if (Array.isArray(extractedData.image_order)) extractedData.image_order.forEach(addIdx);
  for (let i = 0; i < downloadedImages.length; i++) addIdx(i);

  const storedImages = validOrder.map((idx) => ({
    buffer: downloadedImages[idx].buffer,
    mimeType: downloadedImages[idx].mimeType,
    phash: downloadedImages[idx].phash,
    dataUri: downloadedImages[idx].dataUri,
    isFloorplan: fpSet.has(idx)
  }));

  await finalizeListingCreation({
    broker,
    from,
    draftData: {
      ...extractedData,
      rawTextJoined
    },
    listingCode,
    rankedImages: storedImages
  });
}

// ---------------------------------------------------------------------------
// Finalize Listing Creation Helper
// ---------------------------------------------------------------------------
async function finalizeListingCreation({ broker, from, draftData, listingCode, rankedImages = [] }) {
  const typeAr = T.translatePropertyType(draftData.property_type);
  const locationText = draftData.location || draftData.location_name || null;
  const propertyTitle =
    draftData.title ||
    (locationText ? `${typeAr} في ${locationText}` : typeAr);

  const combinedRawText = [draftData.rawTextJoined, draftData.transcribed_text]
    .filter(Boolean)
    .join('\n')
    .trim();

  const searchText = buildSearchText(draftData, combinedRawText, listingCode);
  const locKeywords = S.normalizeKeywords([
    draftData.compound,
    draftData.district,
    draftData.city,
    draftData.location,
    draftData.location_name,
    ...String(draftData.location || '').split(/[-–—،,/]/),
    ...(Array.isArray(draftData.location_keywords) ? draftData.location_keywords : [])
  ]);

  const validFrequency = ['monthly', 'quarterly', 'semi_annual', 'annual'].includes(
    draftData.payment_frequency
  )
    ? draftData.payment_frequency
    : 'quarterly';

  let listingRow;
  try {
    const ins = await pool.query(
      `INSERT INTO listings (
        agency_id, broker_id, code, status, title, property_type, listing_type,
        price_value, price_display, area_value, bedrooms, location, location_name,
        features, language, raw_text, details, search_text, hero_position,
        is_primary_developer, down_payment_value, installment_years, installment_value,
        payment_frequency, delivery_date, maintenance_pct,
        compound, district, city, location_keywords
      ) VALUES (
        $1, $2, $3, 'active', $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, 0,
        $18, $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27, $28
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
        compound = COALESCE(EXCLUDED.compound, listings.compound),
        district = COALESCE(EXCLUDED.district, listings.district),
        city = COALESCE(EXCLUDED.city, listings.city),
        location_keywords = CASE WHEN cardinality(EXCLUDED.location_keywords) > 0 THEN EXCLUDED.location_keywords ELSE listings.location_keywords END,
        hero_position = 0,
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
        draftData.property_type || 'apartment',
        draftData.listing_type || 'sale',
        draftData.price_value || null,
        draftData.price_display || null,
        draftData.area_value || null,
        draftData.bedrooms ? parseInt(draftData.bedrooms, 10) : null,
        locationText,
        draftData.location_name || locationText,
        Array.isArray(draftData.features) ? draftData.features : [],
        draftData.language === 'en' ? 'en' : 'ar',
        combinedRawText || null,
        JSON.stringify(draftData),
        searchText,
        Boolean(draftData.is_primary_developer),
        draftData.down_payment_value || null,
        draftData.installment_years ? parseInt(draftData.installment_years, 10) : null,
        draftData.installment_value || null,
        validFrequency,
        draftData.delivery_date || null,
        draftData.maintenance_pct ?? 8,
        draftData.compound || null,
        draftData.district || null,
        draftData.city || null,
        locKeywords
      ]
    );

    listingRow = ins.rows[0];
  } catch (err) {
    console.error('❌ [DATABASE] Insertion failed:', err.message);
    await logUsageEvent({
      agencyId: broker.agency_id,
      brokerId: broker.id,
      phone: from,
      eventType: 'error',
      meta: { stage: 'db_insert', error: err.message }
    });
    // Generic error message for broker, details logged internally only
    await sendWhatsAppText(from, '⚠️ تعذر حفظ بيانات العقار في النظام حالياً. يرجى المحاولة مرة أخرى.');
    return;
  }

  await pool.query('DELETE FROM listing_images WHERE listing_id = $1', [listingRow.id]);

  const flyerImageSources = [];
  for (let i = 0; i < rankedImages.length; i++) {
    const item = rankedImages[i];
    const buffer = item.buffer || Buffer.from(item.bufferB64, 'base64');
    const photoPath = `${broker.agency_id}/${listingRow.id}/photo_${i}.jpg`;

    try {
      const { error: photoErr } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(photoPath, buffer, {
          contentType: 'image/jpeg',
          upsert: true
        });

      if (!photoErr) {
        const { data: pubData } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(photoPath);

        const publicUrl = pubData.publicUrl;

        await pool.query(
          `INSERT INTO listing_images (listing_id, agency_id, position, url, phash)
           VALUES ($1, $2, $3, $4, $5::bit(64))`,
          [listingRow.id, broker.agency_id, i, publicUrl, item.phash || '0'.repeat(64)]
        );

        if (!item.isFloorplan && flyerImageSources.length < 9) {
          flyerImageSources.push(item.dataUri || `data:image/jpeg;base64,${buffer.toString('base64')}`);
        }
      }
    } catch (imgErr) {
      console.error(`❌ [IMAGE UPLOAD #${i}] Error:`, imgErr.message);
    }
  }

  let flyerPublicUrl = null;
  try {
    flyerPublicUrl = await generateAndUploadFlyer({
      broker,
      listing: listingRow,
      imageSources: flyerImageSources
    });
  } catch (err) {
    console.error('❌ [RENDER] Brochure rendering error:', err.message);
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
    meta: {
      code: listingCode,
      imagesCount: rankedImages.length
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
// AI Search (Text or Voice) & Command Handlers
// ---------------------------------------------------------------------------
const mediaCache = new Map();
const MAX_SEARCHES_PER_HOUR = parseInt(process.env.MAX_SEARCHES_PER_HOUR, 10) || 60;
const searchModel = () =>
  process.env.GEMINI_SEARCH_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const geminiPrices = () => ({
  inPerM: Number(process.env.GEMINI_PRICE_IN_PER_M) || 0,
  outPerM: Number(process.env.GEMINI_PRICE_OUT_PER_M) || 0
});

function cacheMedia(id, media) {
  const now = Date.now();
  for (const [k, v] of mediaCache) if (now - v.at > 3 * 60 * 1000) mediaCache.delete(k);
  mediaCache.set(id, { media, at: now });
}

async function routeTextOrVoice({ from, broker, collectedText, audioItems }) {
  const text = collectedText.join('\n').trim();
  const audio = [];
  for (const aud of audioItems) {
    if (!aud?.id) continue;
    const media = await downloadWhatsAppMedia(aud.id);
    if (media?.buffer) {
      cacheMedia(aud.id, media);
      audio.push({ buffer: media.buffer, mimeType: cleanAudioMime(media.mimeType) });
    }
  }

  const startMs = Date.now();
  let parsed;
  let usage;
  try {
    ({ parsed, usage } = await S.parseSearchRequest(ai, { text, audio, model: searchModel() }));
  } catch (err) {
    console.error('❌ [SEARCH PARSE] Gemini failed:', err.message);
    return false;
  }

  await logUsageEvent({
    agencyId: broker.agency_id,
    brokerId: broker.id,
    phone: from,
    eventType: 'gemini',
    durationMs: Date.now() - startMs,
    costUsd: S.estimateCostUsd(usage, geminiPrices()),
    tokensInput: usage.input,
    tokensOutput: usage.output,
    meta: { stage: 'intent_search', intent: parsed.intent, audioCount: audio.length }
  });

  if (parsed.intent === 'search') {
    await runAiSearch({ broker, from, parsed, isVoice: audio.length > 0, startMs });
    return true;
  }
  if (parsed.intent === 'other') {
    await sendWhatsAppText(
      from,
      'أهلاً 👋 ابعت صور العقار مع التفاصيل لتجهيز كتالوج، أو اسألني عن وحداتكم مثلاً: "شقة 3 غرف في التجمع الخامس تحت 7 مليون". للمساعدة اكتب: مساعدة'
    );
    return true;
  }
  return false;
}

async function runAiSearch({ broker, from, parsed, isVoice = false, startMs = Date.now(), usedFallback = false }) {
  const lim = await pool.query(
    `SELECT COUNT(*) AS n FROM usage_events
      WHERE broker_id = $1 AND event_type = 'search' AND created_at > NOW() - INTERVAL '1 hour'`,
    [broker.id]
  );
  if (Number(lim.rows[0].n) >= MAX_SEARCHES_PER_HOUR) {
    return sendWhatsAppText(from, '⛔ وصلت للحد الأقصى لعمليات البحث بالساعة. جرّب بعد شوية.');
  }

  if (!S.hasAnyFilter(parsed)) {
    return sendWhatsAppText(
      from,
      'حدد منطقة أو نوع أو سعر عشان أدورلك، مثلاً: "شقة 3 غرف في التجمع الخامس تحت 7 مليون".'
    );
  }

  let relaxed = false;
  let q = S.buildSearchQuery(broker.agency_id, parsed);
  let res = await pool.query(q.sql, q.params);
  if (res.rowCount === 0 && !parsed.filters.code) {
    relaxed = true;
    q = S.buildSearchQuery(broker.agency_id, parsed, { relaxed: true });
    res = await pool.query(q.sql, q.params);
  }

  try {
    await pool.query(
      `INSERT INTO search_analytics (agency_id, broker_id, query_raw, tokens, results_count, is_voice)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [broker.agency_id, broker.id, parsed.transcript || '', parsed.location_terms, res.rowCount, isVoice]
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
    meta: { resultsCount: res.rowCount, relaxed, isVoice, usedFallback, terms: parsed.location_terms }
  });

  const understood = S.formatInterpretation(parsed);
  const header = `🔍 *فهمت طلبك:* ${understood || parsed.transcript}${usedFallback ? ' _(بحث بالكلمات)_' : ''}`;

  if (res.rowCount === 0) {
    return sendWhatsAppText(
      from,
      `${header}\n\nمفيش وحدات نشطة مطابقة. جرّب تشيل السعر أو عدد الغرف، أو اكتب المنطقة بشكل تاني.`
    );
  }

  const lines = res.rows.map(
    (r) =>
      `• *#${r.code}* — ${r.title || 'وحدة'} (${r.location || '-'})\n  💰 ${r.price_display || 'عند الطلب'} | 📐 ${r.area_value ? `${r.area_value}م²` : '-'} | 🛏️ ${r.bedrooms || '-'}`
  );
  const note = relaxed ? '\n⚠️ مفيش تطابق كامل، دي أقرب النتائج.' : '';
  return sendWhatsAppText(
    from,
    `${header}${note}\n\n*النتائج (${res.rowCount}):*\n\n${lines.join('\n\n')}\n\n💡 لعرض كتالوج أي وحدة أرسل: *#الكود*`
  );
}

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

    try {
      const imgsRes = await pool.query(
        'SELECT url FROM listing_images WHERE listing_id = $1 ORDER BY position ASC LIMIT 9',
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
    let parsed;
    let usage = null;
    let usedFallback = false;
    try {
      ({ parsed, usage } = await S.parseSearchRequest(ai, { text: cmd.query, model: searchModel() }));
      parsed.intent = 'search';
    } catch (err) {
      console.error('❌ [SEARCH PARSE] Gemini failed, using keyword fallback:', err.message);
      parsed = S.fallbackParse(cmd.query);
      usedFallback = true;
    }
    if (usage) {
      await logUsageEvent({
        agencyId: broker.agency_id,
        brokerId: broker.id,
        phone: from,
        eventType: 'gemini',
        durationMs: Date.now() - startMs,
        costUsd: S.estimateCostUsd(usage, geminiPrices()),
        tokensInput: usage.input,
        tokensOutput: usage.output,
        meta: { stage: 'search_command' }
      });
    }
    return runAiSearch({ broker, from, parsed, startMs, usedFallback });
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