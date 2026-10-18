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

function normalizeDigits(value = '') {
  return String(value)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

function normalizeCode(raw = '') {
  const s = String(raw || '').trim().replace(/^#/, '').replace(/\s+/g, '');
  if (!s) return '';
  return s;
}

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
      buffer,
      mimeType: mime_type || 'audio/ogg; codecs=opus'
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

  const msg = messages[0];
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
      await sendWhatsAppText(from, '⚠️ هذا الرقم غير مسجل في النظام. تواصل مع مدير الوكالة للتفعيل.');
      return;
    }

    broker = bRes.rows[0];
  } catch (err) {
    console.error('❌ [AUTH] Broker lookup error:', err.message);
    return;
  }

  if (msg.type === 'text') {
    const textBody = (msg.text?.body || '').trim();
    const command = T.parseCommand(textBody);
    if (command) {
      return handleCommand(command, broker, from);
    }
  }

  enqueueIncomingMessage(from, msg, broker);
});

function enqueueIncomingMessage(from, msg, broker) {
  const debounceDelay = parseInt(process.env.DEBOUNCE_MS, 10) || 7000;

  if (!pendingQueues.has(from)) {
    pendingQueues.set(from, { items: [], timer: null, broker });
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
        await sendWhatsAppText(from, '⚠️ حدث خطأ فني أثناء المعالجة.').catch(() => {});
      }
    }
  }, debounceDelay);
}

async function processBatchedListing(from, items, broker) {
  const collectedText = [];
  const images = [];
  const audioIds = [];

  for (const item of items) {
    if (item.type === 'text' && item.text?.body) {
      collectedText.push(item.text.body);
    } else if (item.type === 'image' && item.image) {
      images.push(item.image);
      if (item.image.caption) collectedText.push(item.image.caption);
    } else if ((item.type === 'audio' || item.type === 'voice') && (item.audio || item.voice)) {
      audioIds.push((item.audio || item.voice).id);
    }
  }

  if (images.length === 0 && collectedText.length === 0 && audioIds.length === 0) return;

  sendWhatsAppText(from, '⏳ جاري استخراج البيانات وتصميم الكتالوج...').catch(() => {});

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
      "features": ["feature 1", "feature 2"]
    }
    Text: ${collectedText.join('\n')}
  `;

  let extractedData = {};
  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await ai.models.generateContent({
      model: modelName,
      contents: promptText,
      config: { responseMimeType: 'application/json' }
    });

    extractedData = JSON.parse(response.text);
  } catch (err) {
    console.error('❌ [GEMINI] Extraction failed:', err.message);
    await sendWhatsAppText(from, '⚠️ حدث خطأ أثناء تحليل بيانات الإعلان.');
    return;
  }

  let listingCode = normalizeCode(extractedData.code);
  if (!listingCode) {
    const seq = await pool.query("SELECT nextval('listing_code_seq') AS code");
    listingCode = String(seq.rows[0].code);
  }

  const propertyTitle = `${extractedData.property_type || 'عقار'} في ${extractedData.location || 'مصر'}`;

  let listingId;
  try {
    const ins = await pool.query(
      `INSERT INTO listings (
        agency_id, broker_id, code, title, property_type, listing_type,
        price_value, price_display, area_value, bedrooms, location,
        features, details, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active')
      RETURNING id`,
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
        extractedData.bedrooms || null,
        extractedData.location || null,
        Array.isArray(extractedData.features) ? extractedData.features : [],
        JSON.stringify(extractedData)
      ]
    );

    listingId = ins.rows[0].id;
  } catch (err) {
    console.error('❌ [DATABASE] Insertion failed:', err.message);
    await sendWhatsAppText(from, `⚠️ فشل حفظ العقار في قاعدة البيانات: ${err.message}`);
    return;
  }

  let flyerPublicUrl = null;
  try {
    const pngBuffer = await R.renderFlyerPng({
      agencyName: broker.agency_name,
      brandColor: broker.brand_color,
      accentColor: broker.accent_color,
      logoUrl: broker.logo_url,
      code: listingCode,
      title: `${extractedData.property_type || 'وحدة'} - ${extractedData.location || ''}`,
      priceDisplay: extractedData.price_display || (extractedData.price_value ? T.formatPrice(extractedData.price_value) : 'عند الطلب'),
      area: extractedData.area_value ? `${extractedData.area_value} م²` : null,
      bedrooms: extractedData.bedrooms ? `${extractedData.bedrooms} غرف` : null,
      location: extractedData.location || 'القاهرة',
      brokerPhone: broker.contact_phone || broker.phone,
      features: extractedData.features || []
    });

    const storagePath = `${broker.agency_id}/${listingId}/flyer.png`;
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
    await pool.query('UPDATE listings SET flyer_url = $1 WHERE id = $2', [flyerPublicUrl, listingId]);
  } catch (err) {
    console.error('❌ [RENDER] Brochure rendering/upload error:', err.message);
  }

  if (flyerPublicUrl) {
    const caption = `🏡 *تم تجهيز الكتالوج بنجاح!*\nالكود: *#${listingCode}*\nالسعر: *${extractedData.price_display || 'غير محدد'}*\nالموقع: *${extractedData.location || '-'}*`;
    await sendWhatsAppImage(from, flyerPublicUrl, caption);
  } else {
    await sendWhatsAppText(from, `✅ تم حفظ العقار برقم #${listingCode}، ولكن تعذر إنشاء الصورة الترويجية.`);
  }
}

async function handleCommand(cmd, broker, from) {
  if (cmd.type === 'help') {
    return sendWhatsAppText(
      from,
      '📖 *دليل أوامر النظام:*\n\n• إضافة عقار: أرسل الصور أو النصوص أو الرسائل الصوتية.\n• عرض عقار: عقار 1001 أو #1001\n• تحديث سعر: سعر 1001 إلى 8.5 مليون\n• تحديث حالة: تم البيع 1001\n• أرشفة: أرشيف 1001'
    );
  }

  if (cmd.type === 'status') {
    const res = await pool.query(
      'UPDATE listings SET status = $1, updated_at = NOW() WHERE agency_id = $2 AND lower(code) = lower($3) RETURNING code',
      [cmd.status, broker.agency_id, normalizeCode(cmd.code)]
    );

    if (res.rowCount > 0) {
      return sendWhatsAppText(from, `✅ تم تحديث حالة العقار #${normalizeCode(cmd.code)} إلى: *${cmd.status}*`);
    }

    return sendWhatsAppText(from, `❌ لم يتم العثور على عقار بالكود #${normalizeCode(cmd.code)}`);
  }

  if (cmd.type === 'price') {
    const parsed = T.parsePrice(normalizeDigits(cmd.priceText));
    if (!parsed) {
      return sendWhatsAppText(from, `⚠️ لم نتمكن من قراءة السعر الجديد: "${cmd.priceText}"`);
    }

    const display = T.formatPrice(parsed);
    const res = await pool.query(
      'UPDATE listings SET price_value = $1, price_display = $2, updated_at = NOW() WHERE agency_id = $3 AND lower(code) = lower($4) RETURNING id',
      [parsed, display, broker.agency_id, normalizeCode(cmd.code)]
    );

    if (res.rowCount > 0) {
      return sendWhatsAppText(from, `✅ تم تحديث سعر العقار #${normalizeCode(cmd.code)} إلى: *${display}*`);
    }

    return sendWhatsAppText(from, `❌ لم يتم العثور على عقار بالكود #${normalizeCode(cmd.code)}`);
  }

  if (cmd.type === 'show') {
    const cleanCode = normalizeCode(cmd.code);
    const res = await pool.query(
      'SELECT * FROM listings WHERE agency_id = $1 AND lower(code) = lower($2)',
      [broker.agency_id, cleanCode]
    );

    if (res.rowCount === 0) {
      return sendWhatsAppText(from, `❌ العقار #${cleanCode} غير مسجل.`);
    }

    const l = res.rows[0];
    if (l.flyer_url) {
      return sendWhatsAppImage(from, `${l.flyer_url}?t=${Date.now()}`, `📋 بيانات العقار #${l.code}\nالسعر: ${l.price_display}\nالحالة: ${l.status}`);
    }

    return sendWhatsAppText(from, `📋 العقار #${l.code}\nالنوع: ${l.property_type}\nالسعر: ${l.price_display}\nالموقع: ${l.location}`);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ [GLOBAL] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('🚨 [GLOBAL] Uncaught Exception:', err);
});

app.listen(PORT, () => {
  console.log(`🚀 Real Estate WhatsApp Engine Online | Port: ${PORT}`);
});
