require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const sharp = require('sharp');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');
const T = require('./lib/text');
const { renderFlyerSatori } = require('./lib/render');

// Hardening memory footprint for high concurrency
sharp.cache(false);
sharp.concurrency(1);

const {
  PORT = 3000,
  APP_SECRET,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-2.5-flash',
  GEMINI_TIMEOUT_MS = '45000',
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  DEFAULT_AGENT_NAME = 'Aspire real estate agency',
  DEBOUNCE_MS = '7000',
  DATABASE_URL,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  STORAGE_BUCKET = 'media',
  DUP_HAMMING_THRESHOLD = '10',
  MAX_BROCHURES_PER_HOUR = '30',
  MAX_BROCHURES_PER_DAY = '120',
  SUBMISSION_COOLDOWN_SEC = '10',
  MAX_CLARIFY_ROUNDS = '2',
} = process.env;

const GRAPH = 'https://graph.facebook.com/v21.0';
const AUTH = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
const DEBOUNCE_TIME = Number(DEBOUNCE_MS) || 7000;
const MAX_IMAGES = 8;
const HTTP_TIMEOUT_MS = 15000;
const SESSION_TTL_HOURS = 2;
const NUM = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// Database pool for high concurrent transactions
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL || '') ? false : { rejectUnauthorized: false },
});
pool.on('error', (e) => console.error('PG pool error:', e.message));
const q = (text, params) => pool.query(text, params);

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));

const app = express();

// Capture raw body for Meta HMAC signature validation
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ====================================================================
// Security Middleware: Meta HMAC Verification
// ====================================================================
function verifyMetaSignature(req, res, next) {
  if (!APP_SECRET) return next();
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('Rejected webhook: Missing x-hub-signature-256');
    return res.sendStatus(401);
  }
  const elements = signature.split('=');
  const signatureHash = elements[1];
  const expectedHash = crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (signatureHash !== expectedHash) {
    console.warn('Rejected webhook: Invalid HMAC signature');
    return res.sendStatus(403);
  }
  next();
}

// ====================================================================
// Resilience & Network Utilities
// ====================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);

const isTransient = (e) => {
  const s = e?.response?.status ?? e?.status;
  if (s) return s === 429 || s >= 500;
  return true;
};

async function retry(fn, { tries = 3, baseMs = 600, label = 'op' } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === tries || !isTransient(e)) break;
      console.warn(`${label} failed (attempt ${i}/${tries}): ${e.message}`);
      await sleep(baseMs * 2 ** (i - 1));
    }
  }
  throw last;
}

function logApiError(label, err) {
  if (err.response?.status === 401) console.error(`${label}: WHATSAPP_TOKEN EXPIRED (401)`);
  if (err.response?.data?.error?.code === 131047) {
    console.error(`${label}: Meta 24-hr session expired (131047). Template message required.`);
  }
  console.error(`${label}:`, err.response?.data || err.message);
}

// ====================================================================
// Database Access
// ====================================================================
async function getBroker(phone) {
  const r = await q(
    `select b.id, b.agency_id, b.phone, b.name, b.contact_phone, b.role, b.is_active,
            a.name as agency_name
       from brokers b join agencies a on a.id = b.agency_id
      where b.phone = $1`,
    [phone]
  );
  const x = r.rows[0];
  if (!x) return null;
  return {
    id: x.id,
    agencyId: x.agency_id,
    phone: x.phone,
    name: x.name,
    contactPhone: x.contact_phone,
    role: x.role,
    isActive: x.is_active,
    agencyName: x.agency_name,
  };
}

const LISTING_SELECT = `
  select l.*, b.name as broker_name, b.phone as broker_phone, b.contact_phone as broker_contact,
         a.name as agency_name, a.logo_url, a.brand_color, a.accent_color
    from listings l
    join brokers b on b.id = l.broker_id
    join agencies a on a.id = l.agency_id`;

async function getListingById(id, agencyId) {
  const r = await q(`${LISTING_SELECT} where l.id = $1 and l.agency_id = $2`, [id, agencyId]);
  return r.rows[0] || null;
}

async function getListingByCode(code, agencyId) {
  const cleanCode = String(code).trim().replace(/^#/, '');
  const r = await q(
    `${LISTING_SELECT} where lower(l.code) = lower($1) and l.agency_id = $2`,
    [cleanCode, agencyId]
  );
  return r.rows[0] || null;
}

async function createListing(broker, { lat, lng, locationName, customCode = null }) {
  let finalCode = customCode ? String(customCode).trim().replace(/[^\w-]/g, '') : null;

  if (finalCode) {
    const exists = await q(
      `select id from listings where agency_id = $1 and lower(code) = lower($2) and status <> 'archived'`,
      [broker.agencyId, finalCode]
    );
    if (exists.rows.length) {
      const seq = (await q(`select nextval('listing_code_seq') as next`)).rows[0].next;
      finalCode = `${finalCode}-${seq}`;
    }
  } else {
    const seq = (await q(`select nextval('listing_code_seq') as next`)).rows[0].next;
    finalCode = String(seq);
  }

  const r = await q(
    `insert into listings (agency_id, broker_id, code, status, lat, lng, location_name)
     values ($1, $2, $3, 'draft', $4, $5, $6) returning id, code`,
    [broker.agencyId, broker.id, finalCode, lat ?? null, lng ?? null, locationName ?? null]
  );
  return r.rows[0];
}

async function saveDetails(listingId, d, rawText) {
  const searchText = T.normalizeAr(
    [d.title, d.property_type_label, d.property_type, d.listing_type, d.location, d.finishing,
      (d.features || []).join(' '), d.price_display, d.area_display].filter(Boolean).join(' ')
  );
  await q(
    `update listings set
            details = $2, title = $3, property_type = $4, listing_type = $5,
            price_value = $6, price_display = $7, area_value = $8, bedrooms = $9, location = $10,
            features = $11, language = $12,
            raw_text = coalesce($14, raw_text),
            search_text = $13 || ' ' || code,
            is_primary_developer = $15,
            down_payment_value = $16,
            installment_years = $17,
            installment_value = $18,
            payment_frequency = $19,
            delivery_date = $20,
            updated_at = now()
      where id = $1`,
    [
      listingId, JSON.stringify(d), d.title || null, d.property_type, d.listing_type, d.price_value,
      d.price_display || null, d.area_value, d.bedrooms, d.location || null, d.features || [],
      d.language || 'ar', searchText, rawText ?? null,
      Boolean(d.is_primary_developer), d.down_payment_value ?? null, d.installment_years ?? null,
      d.installment_value ?? null, d.payment_frequency || 'quarterly', d.delivery_date || null,
    ]
  );
}

async function setStatus(listingId, status) {
  await q(`update listings set status = $2, updated_at = now() where id = $1`, [listingId, status]);
}

async function getSession(phone) {
  const r = await q(
    `select state, listing_id, data from sessions
      where phone = $1 and updated_at > now() - interval '${SESSION_TTL_HOURS} hours'`,
    [phone]
  );
  return r.rows[0] || null;
}

async function setSession(phone, state, listingId, data = {}) {
  await q(
    `insert into sessions (phone, state, listing_id, data, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (phone) do update
       set state = $2, listing_id = $3, data = $4, updated_at = now()`,
    [phone, state, listingId, JSON.stringify(data)]
  );
}

const clearSession = (phone) => q(`delete from sessions where phone = $1`, [phone]);

function logEvent(broker, type, { listingId = null, ms = null, meta = {}, phone = null, costUsd = 0 } = {}) {
  return q(
    `insert into usage_events (agency_id, broker_id, phone, event_type, listing_id, duration_ms, cost_usd, meta)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [broker?.agencyId ?? null, broker?.id ?? null, broker?.phone ?? phone, type, listingId, ms, costUsd, JSON.stringify(meta)]
  ).catch((e) => console.error('logEvent failed:', e.message));
}

async function claimMessage(id) {
  try {
    const r = await q(
      `insert into processed_messages (message_id) values ($1) on conflict do nothing`,
      [id]
    );
    return r.rowCount === 1;
  } catch (e) {
    return true;
  }
}

const cleanupOldRows = () =>
  q(`delete from processed_messages where received_at < now() - interval '3 days'`)
    .catch((e) => console.error('cleanup failed:', e.message));

// ====================================================================
// WhatsApp Helpers
// ====================================================================
async function downloadMedia(mediaId) {
  try {
    return await retry(
      async () => {
        const { data } = await axios.get(`${GRAPH}/${mediaId}`, { headers: AUTH, timeout: HTTP_TIMEOUT_MS });
        const file = await axios.get(data.url, { headers: AUTH, responseType: 'arraybuffer', timeout: HTTP_TIMEOUT_MS });
        return Buffer.from(file.data);
      },
      { label: `download ${mediaId}` }
    );
  } catch (err) {
    logApiError(`Failed to download media ${mediaId}`, err);
    throw new Error('MEDIA_DOWNLOAD_FAILED');
  }
}

const waPost = (payload) =>
  retry(
    () => axios.post(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, { messaging_product: 'whatsapp', ...payload }, { headers: AUTH, timeout: HTTP_TIMEOUT_MS }),
    { label: 'whatsapp send' }
  );

async function sendText(to, body) {
  try {
    await waPost({ to, type: 'text', text: { body: T.clip(body, 4000) } });
  } catch (err) {
    logApiError('Failed to send text', err);
  }
}

async function sendButtons(to, body, buttons) {
  try {
    await waPost({
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: T.clip(body, 1000) },
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: T.clip(b.title, 20) } })) },
      },
    });
  } catch (err) {
    logApiError('Failed to send buttons', err);
    await sendText(to, body);
  }
}

async function sendImageLink(to, url, caption) {
  try {
    await waPost({ to, type: 'image', image: { link: url, caption: T.clip(caption, 1000) } });
  } catch (err) {
    logApiError('Failed to send image link', err);
    throw new Error('WHATSAPP_SEND_FAILED');
  }
}

async function sendImageBuffer(to, pngBuffer, filenameBase, caption) {
  try {
    const safe = (filenameBase || 'brochure').replace(/[\/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '_') || 'brochure';
    const id = await retry(
      async () => {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'image/png');
        form.append('file', new Blob([pngBuffer], { type: 'image/png' }), `${safe}.png`);
        const upload = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, {
          method: 'POST', headers: AUTH, body: form, signal: AbortSignal.timeout(20000),
        });
        if (upload.status === 401) console.error('WHATSAPP_TOKEN EXPIRED (401)');
        const j = await upload.json();
        if (!j?.id) throw new Error(`Media upload failed: ${JSON.stringify(j)}`);
        return j.id;
      },
      { label: 'media upload' }
    );
    await waPost({ to, type: 'image', image: { id, caption: T.clip(caption, 1000) } });
  } catch (err) {
    logApiError('Failed to send brochure image', err);
    throw new Error('WHATSAPP_SEND_FAILED');
  }
}

// ====================================================================
// Gemini Audio & Multimodal Extraction
// ====================================================================
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  try {
    const response = await retry(
      () =>
        withTimeout(
          ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: 'Transcribe this Egyptian Arabic voice note verbatim. ' +
                          'Return ONLY the transcription text without commentary or quotation marks.'
                  },
                  {
                    inlineData: {
                      mimeType: mimeType.split(';')[0],
                      data: audioBuffer.toString('base64')
                    }
                  }
                ]
              }
            ]
          }),
          15000,
          'transcribe-audio'
        ),
      { tries: 2, baseMs: 1000, label: 'transcribe' }
    );
    return (response.text || '').trim();
  } catch (err) {
    console.error('Audio transcription failed:', err.message);
    return '';
  }
}

const EXTRACTION_PROMPT = `You extract structured real-estate listing data from messages written or spoken by Egyptian real-estate brokers.
Input may be Egyptian Arabic, Modern Standard Arabic, Franco-Arab, English, or a mix. It may be text, voice notes, and listing photos. Transcribe audio first.

Inspect all uploaded images carefully. Evaluate them to choose the "hero_image_index" (0-based integer index of the best image to showcase on the flyer cover).
Hero selection criteria:
- Highest priority: Spacious, brightly-lit reception/living room, panoramic balcony/terrace view, or modern building facade.
- Moderate priority: Master bedroom or high-end kitchen.
- Lowest priority (Never choose if others exist): Bathrooms, narrow hallways, utility rooms, blurry/underexposed photos, wall/plumbing close-ups.

Return ONE JSON object with exactly these keys:
- language: "ar" or "en"
- transcript: transcription of voice notes ("" if none)
- title: short listing title
- custom_code: string (the broker's own code if mentioned, e.g. "كود: MV-104", "كود 502", "ref: A12", or null if not provided)
- property_type: apartment, villa, townhouse, twin_house, duplex, penthouse, studio, chalet, office, shop, land, other, or null
- property_type_label: property type in the output language
- listing_type: "sale" or "rent", or null
- price_value: total price in EGP, or null
- price_display: formatted price with unit
- is_primary_developer: boolean (true if developer project with installments, false if cash/resale)
- down_payment_value: number in EGP (or null)
- down_payment_display: formatted string (e.g. "750,000 ج.م (10%)" or "")
- installment_years: integer years (or null)
- installment_value: periodic check value in EGP (or null)
- installment_display: formatted string (e.g. "120,000 ج.م ربع سنوي" or "")
- payment_frequency: "quarterly", "monthly", "semi_annual", or "annual"
- delivery_date: delivery year/quarter (e.g. "2027" or "استلام فوري" or "")
- area_value: square meters number or null
- area_display: e.g. "185 م²"
- bedrooms: integer or null
- bathrooms: integer or null
- floor: floor as display text ("" if not stated)
- location: neighborhood / compound / city ("" if not stated)
- finishing: finishing level ("" if not stated)
- features: array of short strings for facilities (pool, garden, roof, parking, security, etc.)
- hero_image_index: integer (0 to images count - 1) identifying the best hero photo. If no images uploaded, return 0.
- confidence: object with keys price, area, location, property_type; each "high", "medium", "low" or "missing"

Rules: NEVER invent values. If not stated, use null or "".
If an "existing" JSON object is provided, keep existing values unless the new message updates them.`;

const EMPTY_DETAILS = () => ({
  language: 'ar', transcript: '', title: '', custom_code: null, property_type: null, property_type_label: '',
  listing_type: null, price_value: null, price_display: '', area_value: null, area_display: '',
  bedrooms: null, bathrooms: null, floor: '', location: '', finishing: '', features: [],
  is_primary_developer: false, down_payment_value: null, down_payment_display: '',
  installment_years: null, installment_value: null, installment_display: '',
  payment_frequency: 'quarterly', delivery_date: '', hero_image_index: 0, confidence: {},
});

function normalizeDetails(raw, prev = {}) {
  const r = (Array.isArray(raw) ? raw[0] : raw) || {};
  const str = (v) => (v == null ? '' : String(v).trim());
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const int = (v) => (num(v) ? Math.round(num(v)) : null);
  return {
    language: r.language === 'en' ? 'en' : 'ar',
    transcript: [prev.transcript, str(r.transcript)].filter(Boolean).join(' ').trim(),
    title: str(r.title),
    custom_code: str(r.custom_code) || prev.custom_code || null,
    property_type: str(r.property_type) || null,
    property_type_label: str(r.property_type_label),
    listing_type: ['sale', 'rent'].includes(r.listing_type) ? r.listing_type : null,
    price_value: num(r.price_value),
    price_display: str(r.price_display),
    is_primary_developer: Boolean(r.is_primary_developer),
    down_payment_value: num(r.down_payment_value),
    down_payment_display: str(r.down_payment_display),
    installment_years: int(r.installment_years),
    installment_value: num(r.installment_value),
    installment_display: str(r.installment_display),
    payment_frequency: ['monthly', 'quarterly', 'semi_annual', 'annual'].includes(r.payment_frequency) ? r.payment_frequency : 'quarterly',
    delivery_date: str(r.delivery_date),
    area_value: num(r.area_value),
    area_display: str(r.area_display),
    bedrooms: int(r.bedrooms),
    bathrooms: int(r.bathrooms),
    floor: str(r.floor),
    location: str(r.location),
    finishing: str(r.finishing),
    features: Array.isArray(r.features) ? r.features.map(str).filter(Boolean).slice(0, 8) : [],
    hero_image_index: Math.max(0, int(r.hero_image_index) || 0),
    confidence: r.confidence && typeof r.confidence === 'object' ? r.confidence : {},
  };
}

async function extractDetails({ text, audios = [], imageBuffers = [], existing = null, locationName = '', broker = null }) {
  if (!text.trim() && !audios.length && !imageBuffers.length) {
    return { details: existing || EMPTY_DETAILS(), failed: true };
  }

  // Pre-downscale thumbnails for Gemini multimodal vision to save bandwidth
  const visionParts = [];
  for (const buf of imageBuffers) {
    const thumb = await sharp(buf).rotate().resize(512, 512, { fit: 'inside' }).jpeg({ quality: 65 }).toBuffer();
    visionParts.push({ inlineData: { mimeType: 'image/jpeg', data: thumb.toString('base64') } });
  }

  const parts = [
    {
      text:
        EXTRACTION_PROMPT +
        (existing ? `\n\nexisting: ${JSON.stringify({ ...existing, transcript: undefined })}` : '') +
        (locationName ? `\n\nThe broker also shared a map pin named: "${locationName}"` : '') +
        (text.trim() ? `\n\nMessage text: "${text.trim()}"` : '') +
        `\n\nAttached image count: ${imageBuffers.length}`,
    },
    ...visionParts,
    ...audios.map((a) => ({ inlineData: { mimeType: a.mime, data: a.buffer.toString('base64') } })),
  ];

  const t0 = Date.now();
  try {
    const response = await retry(
      () =>
        withTimeout(
          ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ role: 'user', parts }],
            config: { responseMimeType: 'application/json' },
          }),
          NUM(GEMINI_TIMEOUT_MS, 45000),
          'gemini'
        ),
      { tries: 2, baseMs: 1500, label: 'gemini' }
    );
    const details = normalizeDetails(JSON.parse(response.text), existing || {});
    logEvent(broker, 'gemini', { ms: Date.now() - t0, meta: { audio: audios.length, images: imageBuffers.length, ok: true } });
    return { details, failed: false };
  } catch (e) {
    console.error('Gemini extraction failed:', e.message);
    logEvent(broker, 'gemini', { ms: Date.now() - t0, meta: { audio: audios.length, ok: false, error: e.message } });
    return { details: existing || EMPTY_DETAILS(), failed: true };
  }
}

// ====================================================================
// Images: dHash, Storage, Satori Rendering
// ====================================================================
async function dHash(buffer) {
  const { data } = await sharp(buffer)
    .rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw()
    .toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? '1' : '0';
  }
  return bits;
}

async function findDuplicate(agencyId, hashes) {
  if (!hashes.length) return null;
  const r = await q(
    `select l.id, l.code, l.title, min(bit_count(li.phash # h.hash::bit(64))) as dist
       from unnest($2::text[]) as h(hash)
       join listing_images li on li.agency_id = $1
       join listings l on l.id = li.listing_id and l.status = 'active'
      where bit_count(li.phash # h.hash::bit(64)) <= $3
      group by l.id, l.code, l.title
      order by dist asc limit 1`,
    [agencyId, hashes, NUM(DUP_HAMMING_THRESHOLD, 10)]
  );
  return r.rows[0] || null;
}

const publicUrl = (p) => sb.storage.from(STORAGE_BUCKET).getPublicUrl(p).data.publicUrl;

async function uploadToStorage(storagePath, buffer, contentType) {
  await retry(
    async () => {
      const { error } = await sb.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
        contentType, upsert: true, cacheControl: '3600',
      });
      if (error) throw new Error(error.message);
    },
    { label: `upload ${storagePath}` }
  );
  return publicUrl(storagePath);
}

// Parallel image compression & Supabase upload
async function storeListingImages(agencyId, listingId, buffers, hashes) {
  await Promise.all(
    buffers.map(async (buf, i) => {
      const compressed = await sharp(buf)
        .rotate()
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const url = await uploadToStorage(`${agencyId}/${listingId}/${i}.jpg`, compressed, 'image/jpeg');
      return q(
        `insert into listing_images (listing_id, agency_id, position, url, phash)
         values ($1, $2, $3, $4, $5::bit(64))`,
        [listingId, agencyId, i, url, hashes[i]]
      );
    })
  );
}

async function loadListingImages(listingId) {
  const r = await q(`select url from listing_images where listing_id = $1 order by position`, [listingId]);
  return Promise.all(
    r.rows.map(async (row) => {
      return retry(
        async () => Buffer.from((await axios.get(row.url, { responseType: 'arraybuffer', timeout: HTTP_TIMEOUT_MS })).data),
        { label: 'load image' }
      );
    })
  );
}

const toDataUri = (buf, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`;

// Fast in-memory Satori brochure rendering (~30ms)
async function renderBrochureSatori(l, buffers, heroIndex = 0) {
  const d = l.details || {};
  const imgList = [...buffers];
  const validIndex = heroIndex >= 0 && heroIndex < imgList.length ? heroIndex : 0;
  const [heroBuffer] = imgList.splice(validIndex, 1);

  // Compress hero and gallery items to base64 DataURIs
  const heroJpeg = await sharp(heroBuffer).rotate().resize(1080, 740, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
  const heroUri = toDataUri(heroJpeg);

  const thumbUris = [];
  for (const b of imgList.slice(0, 4)) {
    const t = await sharp(b).rotate().resize(475, 260, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
    thumbUris.push(toDataUri(t));
  }

  let logoUri = '';
  if (l.logo_url) {
    try {
      const raw = Buffer.from((await axios.get(l.logo_url, { responseType: 'arraybuffer', timeout: HTTP_TIMEOUT_MS })).data);
      const png = await sharp(raw).resize({ height: 100, fit: 'inside' }).png().toBuffer();
      logoUri = toDataUri(png, 'image/png');
    } catch (_) {}
  }

  let priceText = d.price_display || 'السعر عند الاستعلام';
  if (d.is_primary_developer && d.down_payment_display) {
    priceText = `مقدم: ${d.down_payment_display}`;
  }

  return renderFlyerSatori({
    heroUrl: heroUri,
    thumbs: thumbUris,
    logoUri,
    agencyName: l.agency_name || '',
    agentName: l.broker_name || l.agency_name || DEFAULT_AGENT_NAME,
    agentPhone: `+${String(l.broker_contact || l.broker_phone).replace(/\D/g, '')}`,
    title: T.clip(d.title || 'عقار مميز للبيع', 65),
    price: T.clip(priceText, 35),
    area: T.clip(d.area_display || 'غير محدد', 20),
    rooms: T.clip(d.bedrooms ? `${d.bedrooms} غرف` : 'غير محدد', 20),
    floor: T.clip(d.floor || 'غير محدد', 20),
    location: T.clip(d.location || 'غير محدد', 40),
    propertyType: T.clip(d.property_type_label || '', 20),
    finishing: T.clip(d.finishing || '', 25),
    features: d.features || [],
    code: `#${l.code}`,
    brandColor: l.brand_color,
    accentColor: l.accent_color,
  });
}

function buildCaption(l) {
  const d = l.details || {};
  const en = d.language === 'en';
  const title = d.title || (en ? 'Property' : 'عقار');
  const phone = String(l.broker_contact || l.broker_phone).replace(/\D/g, '');
  const wa = `https://wa.me/${phone}`;
  const agent = l.broker_name || l.agency_name || DEFAULT_AGENT_NAME;

  let installmentBlock = '';
  if (d.is_primary_developer) {
    installmentBlock = `\n💳 *المقدم:* ${d.down_payment_display || 'حسب الرغبة'}\n⏱️ *التقسيط:* ${d.installment_years ? `${d.installment_years} سنوات` : ''} ${d.installment_display ? `(${d.installment_display})` : ''}\n🔑 *الاستلام:* ${d.delivery_date || 'غير محدد'}\n`;
  }

  let loc = '';
  if (l.lat != null && l.lng != null) {
    const url = `https://maps.google.com/?q=${l.lat},${l.lng}`;
    const name = l.location_name || (en ? 'Property location on map' : 'موقع العقار على الخريطة');
    loc = en
      ? `📍 *Location:* ${name}\n🗺️ *Map:* ${url}\n`
      : `📍 *موقع العقار:* ${name}\n🗺️ *رابط الخريطة:* ${url}\n`;
  }
  return en
    ? `🏠 *${title}* (#${l.code})\n${installmentBlock}\n${loc}📌 For inquiries & communication with (${agent}):\n💬 Chat with us directly on WhatsApp:\n${wa}`
    : `🏠 *${title}* (#${l.code})\n${installmentBlock}\n${loc}📌 للتواصل والاستعلام مع (${agent}):\n💬 راسلنا مباشرة عبر واتساب:\n${wa}`;
}

function buildSummary(l, dup) {
  const d = l.details || {};
  const line1 = [d.price_display && `💰 ${d.price_display}`, d.area_display && `📐 ${d.area_display}`, d.bedrooms && `🛏️ ${d.bedrooms}`, d.location && `📍 ${d.location}`]
    .filter(Boolean).join(' | ');
  let msg = `✅ الكاتالوج جاهز — عقار #${l.code}\n🏠 ${d.title || ''}\n${line1}`;
  if (d.features?.length) msg += `\n✨ ${d.features.join(' • ')}`;
  if (dup) msg += `\n\n⚠️ الصور شبه عقار #${dup.code}${dup.title ? ` (${dup.title})` : ''} المتسجل عندكم قبل كده. لو هو نفسه، ابعت "تم البيع ${dup.code}" أو "أرشيف ${dup.code}" للقديم.`;
  msg += '\n\nلو في حاجة غلط ابعتلي التصحيح (نص أو فويس)، مثلاً: "السعر 6.5 مليون".';
  return msg;
}

// ====================================================================
// Core Flows
// ====================================================================
async function downloadAudios(audios) {
  return Promise.all(audios.map(async (a) => ({ mime: a.mime, buffer: await downloadMedia(a.id) })));
}

async function generateAndSend(broker, listingId, { regenerate = false, dup = null, buffers = null } = {}) {
  const t0 = Date.now();
  const l = await getListingById(listingId, broker.agencyId);
  if (!l) throw new Error('listing not found');

  const imgs = buffers || (await loadListingImages(l.id));
  if (!imgs.length) throw new Error('listing has no images');

  const heroIndex = l.details?.hero_image_index || 0;
  const png = await renderBrochureSatori(l, imgs, heroIndex);
  const flyerUrl = await uploadToStorage(`${l.agency_id}/${l.id}/flyer.png`, png, 'image/png');
  await q(`update listings set flyer_url = $2, updated_at = now() where id = $1`, [l.id, `${flyerUrl}?v=${Date.now()}`]);
  l.flyer_url = flyerUrl;

  await sendImageBuffer(broker.phone, png, l.title || `listing_${l.code}`, buildCaption(l));
  await sendButtons(broker.phone, buildSummary(l, dup), [
    { id: `confirm:${l.id}`, title: '✅ تمام' },
    { id: `edit:${l.id}`, title: '✏️ تعديل' },
  ]);

  await setSession(broker.phone, 'review', l.id, {});
  await logEvent(broker, regenerate ? 'regenerate' : 'brochure', { listingId: l.id, ms: Date.now() - t0, meta: { images: imgs.length } });
  console.log(`Flyer ${regenerate ? 're' : ''}generated for listing #${l.code} in ${Date.now() - t0}ms`);
}

async function startSubmission(broker, data, collected) {
  await logEvent(broker, 'submission', { meta: { images: data.images.length, audios: data.audios.length } });

  const prev = await getSession(broker.phone);
  if (prev?.state === 'review' && prev.listing_id) {
    await q(`update listings set status = 'active', updated_at = now() where id = $1 and agency_id = $2 and status = 'draft'`, [prev.listing_id, broker.agencyId]);
  }

  await sendText(broker.phone, '⏳ جاري تجهيز الكاتالوج واختيار أفضل صورة للغلاف...');

  const text = `${collected?.text || ''} ${data.text}`.trim();
  const audioRefs = [...(collected?.audios || []), ...data.audios];
  const location = data.location || collected?.location || null;
  const imageIds = data.images.slice(0, MAX_IMAGES);

  const [buffers, audios] = await Promise.all([
    Promise.all(imageIds.map(downloadMedia)),
    downloadAudios(audioRefs),
  ]);
  const hashes = await Promise.all(buffers.map(dHash));

  // Extract structured parameters with Gemini Flash
  const ex = await extractDetails({ text, audios, imageBuffers: buffers, locationName: location?.name || '', broker });
  const details = ex.details;
  if (!details.location && location?.name) details.location = location.name;

  // Create listing using extracted code (or sequence fallback)
  const listing = await createListing(broker, {
    lat: location?.lat,
    lng: location?.lng,
    locationName: location?.name || null,
    customCode: details.custom_code,
  });

  await Promise.all([
    storeListingImages(broker.agencyId, listing.id, buffers, hashes),
    saveDetails(listing.id, details, [text, details.transcript].filter(Boolean).join(' | ')),
  ]);

  const dup = await findDuplicate(broker.agencyId, hashes);
  if (dup) await logEvent(broker, 'duplicate_warning', { listingId: listing.id, meta: { matches: dup.code, dist: Number(dup.dist) } });

  const missing = ['price', 'location', 'property_type', 'area'].filter((f) => !details[f === 'area' ? 'area_value' : f === 'price' ? 'price_value' : f]);
  if (missing.length) {
    await setSession(broker.phone, 'clarifying', listing.id, { rounds: 0, dup: dup ? { code: dup.code, title: dup.title } : null });
    await sendText(broker.phone, `🤔 عشان أجهز الكاتالوج محتاج:\n${missing.map((f) => `• ${f}`).join('\n')}\n\nابعتهم نص أو فويس، أو ابعت "كمل" لتجهيزه.`);
    return;
  }

  await generateAndSend(broker, listing.id, { dup, buffers });
}

async function applyUpdate(broker, session, data, { skip = false } = {}) {
  const l = await getListingById(session.listing_id, broker.agencyId);
  if (!l) {
    await clearSession(broker.phone);
    await sendText(broker.phone, 'ابعت الصور والتفاصيل عشان نبدأ عقار جديد 📷');
    return;
  }
  const dup = session.data?.dup || null;
  let details = l.details;

  if (!skip) {
    const audios = await downloadAudios(data.audios);
    const ex = await extractDetails({
      text: data.text, audios, existing: l.details, locationName: data.location?.name || '', broker,
    });
    if (ex.failed) {
      await sendText(broker.phone, 'معرفتش أفهم التعديل 🙏 جرّب تكتبه بشكل أوضح، مثلاً: "السعر 6.5 مليون".');
      return;
    }
    details = ex.details;
    await saveDetails(l.id, details, [data.text, ex.details.transcript].filter(Boolean).join(' | ') || null);
  }

  await generateAndSend(broker, l.id, { regenerate: session.state === 'review', dup });
}

// ====================================================================
// Commands & Search Analytics
// ====================================================================
const STATUS_AR = { draft: 'مسودة', active: 'نشط', sold: 'تم البيع', archived: 'مؤرشف' };
const canModify = (broker, l) => broker.role === 'admin' || l.broker_id === broker.id;

async function searchListings(agencyId, brokerId, query, isVoice = false) {
  const tokens = T.normalizeAr(query).split(' ').filter(Boolean).slice(0, 6)
    .map((t) => t.replace(/[%_\\]/g, '\\$&'));
  if (!tokens.length) return [];
  const conds = tokens.map((_, i) => `search_text ilike $${i + 2}`).join(' and ');
  const r = await q(
    `select code, title, price_display, location, status from listings
      where agency_id = $1 and status <> 'archived' and ${conds}
      order by (status = 'active') desc, updated_at desc limit 7`,
    [agencyId, ...tokens.map((t) => `%${t}%`)]
  );

  // Log search demand intelligence
  await q(
    `insert into search_analytics (agency_id, broker_id, query_raw, tokens, results_count, is_voice)
     values ($1, $2, $3, $4, $5, $6)`,
    [agencyId, brokerId, query, tokens, r.rows.length, isVoice]
  ).catch(() => {});

  return r.rows;
}

async function runCommand(broker, cmd, isVoice = false) {
  const to = broker.phone;

  switch (cmd.type) {
    case 'help':
      return sendText(to, '🤖 *أوامر البوت*\n• ابعت صور + فويس/نص لتجهيز كاتالوج\n• بحث التجمع (أو فويس: عايز شقة في التجمع)\n• عقار 1234  ← عرض الكاتالوج\n• السعر 1234 6.5 مليون  ← تعديل السعر\n• تم البيع 1234  ← تغيير الحالة');

    case 'search': {
      const rows = await searchListings(broker.agencyId, broker.id, cmd.query, isVoice);
      if (!rows.length) return sendText(to, `🔍 مفيش نتايج لـ "${T.clip(cmd.query, 40)}".`);
      const shown = rows.slice(0, 6);
      const lines = shown.map((x) => `#${x.code} • ${x.title || '—'}${x.price_display ? ` • ${x.price_display}` : ''} • ${STATUS_AR[x.status]}`);
      return sendText(to, `🔍 النتايج:\n${lines.join('\n')}\n\nلعرض الكاتالوج: عقار <الرقم>`);
    }

    case 'show': {
      const l = await getListingByCode(cmd.code, broker.agencyId);
      if (!l) return sendText(to, `مفيش عقار برقم #${cmd.code} عندكم.`);
      if (l.flyer_url) {
        try {
          return await sendImageLink(to, l.flyer_url, `${buildCaption(l)}\n\nالحالة: ${STATUS_AR[l.status]}`);
        } catch (_) {}
      }
      return sendText(to, `#${l.code} • ${l.title || ''}\n${l.price_display || ''} | ${l.location || ''}\nالحالة: ${STATUS_AR[l.status]}`);
    }

    case 'status': {
      const l = await getListingByCode(cmd.code, broker.agencyId);
      if (!l) return sendText(to, `مفيش عقار برقم #${cmd.code} عندكم.`);
      if (!canModify(broker, l)) return sendText(to, '⛔ تقدر تعدّل عقاراتك إنت بس.');
      await setStatus(l.id, cmd.status);
      return sendText(to, `✅ عقار #${l.code} بقى: ${STATUS_AR[cmd.status]}`);
    }

    case 'price': {
      const l = await getListingByCode(cmd.code, broker.agencyId);
      if (!l) return sendText(to, `مفيش عقار برقم #${cmd.code} عندكم.`);
      if (!canModify(broker, l)) return sendText(to, '⛔ تقدر تعدّل عقاراتك إنت بس.');
      const price = T.parsePrice(cmd.priceText);
      if (!price) return sendText(to, 'مفهمتش السعر 🙏 اكتبه بالأرقام، مثلاً: السعر ' + cmd.code + ' 6.5 مليون');
      const d = { ...l.details, price_value: price, price_display: T.formatPrice(price, l.details?.language) };
      await saveDetails(l.id, d);
      await sendText(to, `✅ اتعدل سعر عقار #${l.code} لـ ${d.price_display}. بجهز الكاتالوج الجديد...`);
      return generateAndSend(broker, l.id, { regenerate: true });
    }
  }
}

// ====================================================================
// Batch Ingestion & Webhook
// ====================================================================
const buffers = {};

async function handleBatch(phone, data) {
  const broker = await getBroker(phone);
  if (!broker || !broker.isActive) return;

  let text = data.text.trim();
  const hasImages = data.images.length > 0;
  const hasAudios = data.audios.length > 0;
  const session = await getSession(phone);

  // 1. Voice Search / Voice Command detection (Lone Audio without photos)
  if (!hasImages && hasAudios && (!session || session.state === 'collecting')) {
    const audioBufs = await downloadAudios(data.audios);
    const transcript = await transcribeAudio(audioBufs[0].buffer, audioBufs[0].mime);

    if (transcript) {
      console.log(`Voice note transcribed from ${phone}: "${transcript}"`);
      const cmd = T.parseCommand(transcript);
      if (cmd) return runCommand(broker, cmd, true);

      if (/شقة|فيلا|دوبلكس|محل|مكتب|أرض|التجمع|زايد|الشروق|أكتوبر|مقدم|تقسيط|مليون/.test(transcript)) {
        return runCommand(broker, { type: 'search', query: transcript }, true);
      }
      text = transcript;
    }
  }

  // 2. Text command
  if (!hasImages && !hasAudios && !data.location && text) {
    const cmd = T.parseCommand(text);
    if (cmd) return runCommand(broker, cmd, false);
  }

  // 3. New Submission
  if (hasImages) {
    const collected = session?.state === 'collecting' ? session.data : null;
    return startSubmission(broker, data, collected);
  }

  // 4. Update / Clarify
  if (session && (session.state === 'clarifying' || session.state === 'review') && session.listing_id) {
    return applyUpdate(broker, session, data);
  }

  // 5. Buffer incomplete details
  if (text || hasAudios || data.location) {
    const prev = session?.state === 'collecting' ? session.data : {};
    await setSession(phone, 'collecting', null, {
      text: `${prev.text || ''} ${text}`.trim(),
      audios: [...(prev.audios || []), ...data.audios],
      location: data.location || prev.location || null,
    });
    if (!session || session.state !== 'collecting') {
      await sendText(phone, '📥 استلمت التفاصيل. ابعت الصور دلوقتي وهجهز الكاتالوج.');
    }
  }
}

app.get('/health', async (_req, res) => {
  q('select 1').catch(() => {});
  res.send('ok');
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Post webhook protected by Meta HMAC signature validation
app.post('/webhook', verifyMetaSignature, (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const phone = message.from;
    const buf = (buffers[phone] ||= { images: [], audios: [], text: '', location: null, timer: null });

    if (message.type === 'text' && message.text?.body) buf.text += ' ' + message.text.body;
    if (message.type === 'image' && message.image?.id) {
      buf.images.push(message.image.id);
      if (message.image.caption) buf.text += ' ' + message.image.caption;
    }
    if (message.type === 'audio' && message.audio?.id) {
      buf.audios.push({ id: message.audio.id, mime: (message.audio.mime_type || 'audio/ogg').split(';')[0] });
    }
    if (message.type === 'location' && message.location) {
      buf.location = {
        lat: message.location.latitude,
        lng: message.location.longitude,
        name: message.location.name || message.location.address || null,
      };
    }

    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      const data = buffers[phone];
      delete buffers[phone];
      handleBatch(phone, data).catch((e) => console.error('handleBatch error:', e));
    }, DEBOUNCE_TIME);
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

app.listen(PORT, async () => {
  console.log(`Server running with Satori rendering on port ${PORT}`);
  await q('select 1').catch(() => console.error('DB connect fail'));
  cleanupOldRows();
  setInterval(cleanupOldRows, 6 * 3600 * 1000);
});