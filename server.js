require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const puppeteer = require('puppeteer-core');
const { GoogleGenAI } = require('@google/genai');

// @sparticuz/chromium is ESM-only in recent versions -> dynamic import
let chromiumPromise;
const getChromium = () =>
  (chromiumPromise ||= import('@sparticuz/chromium').then((m) => m.default ?? m));

const {
  PORT = 3000,
  GEMINI_API_KEY,
  GEMINI_MODEL = 'gemini-3.8-flash',
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  DEFAULT_AGENT_NAME = 'مكتب العقارات المميزة',
  AGENTS_JSON = '{}', // e.g. {"201001234567":"أحمد للعقارات"}
  ALLOWED_NUMBERS = '', // e.g. 201001234567,201112345678 (empty = allow all)
  FONT_URL, // optional fallback if fonts/Cairo.ttf is missing
  DEBOUNCE_MS = '8000'
} = process.env;

const GRAPH = 'https://graph.facebook.com/v21.0';
const AUTH = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
const AGENTS = JSON.parse(AGENTS_JSON);
const ALLOWED = ALLOWED_NUMBERS.split(',').map((s) => s.trim()).filter(Boolean);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const MAX_IMAGES = 4; // 1 hero + up to 3 gallery thumbnails
const PENDING_MS = 2 * 60 * 1000; // keep text-only submissions waiting for photos
const JOB_TIMEOUT_MS = 120000;
const HTTP_TIMEOUT_MS = 15000;

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));

const app = express();
app.use(express.json());

// ---------- Helpers ----------
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);

function logApiError(label, err) {
  if (err.response?.status === 401) {
    console.error(`${label}: WHATSAPP_TOKEN EXPIRED or invalid (401)`);
  }
  console.error(`${label}:`, err.response?.data || err.message);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------- Health + webhook verification ----------
app.get('/health', (_req, res) => res.send('ok'));

app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ---------- Incoming messages ----------
const seen = new Set(); // dedupe Meta retries
const buffers = {}; // per-sender debounce buffer
const pending = {}; // text/voice that arrived before any photo

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // ack fast so Meta doesn't retry

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);

    const phone = message.from;
    if (ALLOWED.length && !ALLOWED.includes(phone)) {
      console.log(`Ignored message from non-allowed number ${phone}`);
      return;
    }

    if (['video', 'sticker', 'document'].includes(message.type)) {
      sendText(phone, '⚠️ بقبل بس الصور والنصوص والرسائل الصوتية. ابعت الصورة كصورة عادية (مش ملف).');
      return;
    }

    const buf = (buffers[phone] ||= { images: [], audios: [], text: '', timer: null });

    if (message.type === 'text' && message.text?.body) {
      buf.text += ' ' + message.text.body;
    }
    if (message.type === 'image' && message.image?.id) {
      buf.images.push(message.image.id);
      if (message.image.caption) buf.text += ' ' + message.image.caption;
    }
    if (message.type === 'audio' && message.audio?.id) {
      buf.audios.push({
        id: message.audio.id,
        mime: (message.audio.mime_type || 'audio/ogg').split(';')[0],
      });
    }

    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      const data = buffers[phone];
      delete buffers[phone];
      onBatchReady(phone, data);
    }, DEBOUNCE_MS);
  } catch (err) {
    console.error('Webhook payload parse error:', err);
  }
});

function onBatchReady(phone, data) {
  // Merge details that arrived earlier without photos
  const p = pending[phone];
  if (p) {
    clearTimeout(p.timer);
    delete pending[phone];
    data.text = `${p.text} ${data.text}`.trim();
    data.audios = [...p.audios, ...data.audios];
  }

  // Details but no photos yet: hold them and ask for photos
  if (!data.images.length) {
    if (data.text.trim() || data.audios.length) {
      pending[phone] = {
        text: data.text,
        audios: data.audios,
        timer: setTimeout(() => delete pending[phone], PENDING_MS),
      };
      sendText(phone, '📥 استلمت التفاصيل. ابعت الصور دلوقتي وهجهز الكاتالوج.');
    }
    return;
  }

  enqueue(() => processSubmission(phone, data));
}

// ---------- Job queue (one Chromium at a time; a stuck job can't block forever) ----------
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue
    .then(() => withTimeout(job(), JOB_TIMEOUT_MS, 'job'))
    .catch((e) => console.error('Job error:', e.message));
}

// ---------- WhatsApp helpers ----------
async function downloadMedia(mediaId) {
  try {
    const { data } = await axios.get(`${GRAPH}/${mediaId}`, { headers: AUTH, timeout: HTTP_TIMEOUT_MS });
    const file = await axios.get(data.url, {
      headers: AUTH,
      responseType: 'arraybuffer',
      timeout: HTTP_TIMEOUT_MS,
    });
    return Buffer.from(file.data);
  } catch (err) {
    logApiError(`Failed to download media ${mediaId}`, err);
    throw new Error('MEDIA_DOWNLOAD_FAILED');
  }
}

async function sendText(to, body) {
  try {
    await axios.post(
      `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
      { headers: AUTH, timeout: HTTP_TIMEOUT_MS }
    );
  } catch (err) {
    logApiError('Failed to send text', err);
  }
}

async function sendImage(to, pngBuffer, caption) {
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/png');
    form.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'brochure.png');

    const upload = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, {
      method: 'POST',
      headers: AUTH,
      body: form,
      signal: AbortSignal.timeout(20000),
    });
    const uploadRes = await upload.json();
    if (upload.status === 401) console.error('WHATSAPP_TOKEN EXPIRED or invalid (401)');
    const id = uploadRes?.id;
    if (!id) throw new Error(`Media upload failed: ${JSON.stringify(uploadRes)}`);

    await axios.post(
      `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'image', image: { id, caption } },
      { headers: AUTH, timeout: HTTP_TIMEOUT_MS }
    );
  } catch (err) {
    logApiError('Failed to send brochure image', err);
    throw new Error('WHATSAPP_SEND_FAILED');
  }
}

// ---------- Gemini parsing (text + voice notes) ----------
const DEFAULTS = {
  title: 'شقة للبيع',
  price: 'السعر عند الاستعلام',
  area: 'غير محدد',
  rooms: 'غير محدد',
  floor: 'غير محدد',
  location: 'غير محدد',
};

// Returns { details, failed }
async function parseDetails(text, audioBuffers) {
  // Nothing to parse: skip the API call
  if (!text.trim() && !audioBuffers.length) {
    return { details: { ...DEFAULTS }, failed: true };
  }

  const parts = [
    {
      text:
        'Extract real estate listing details from the Arabic text and/or audio below. ' +
        'Return a JSON object with string values for keys: title, price, area, rooms, floor, location. ' +
        'Write values in Arabic, keep numbers with units (e.g. "185 م²", "6 مليون جنيه"). ' +
        'Use an empty string for anything not mentioned.' +
        (text.trim() ? `\n\nText: "${text.trim()}"` : ''),
    },
    ...audioBuffers.map((a) => ({
      inlineData: { mimeType: a.mime, data: a.buffer.toString('base64') },
    })),
  ];

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts }],
        config: { responseMimeType: 'application/json' },
      }),
      Number(process.env.GEMINI_TIMEOUT_MS) || 6000000,
      'gemini'
    );
    let parsed = JSON.parse(response.text);
    if (Array.isArray(parsed)) parsed = parsed[0];
    const details = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (parsed?.[k] && String(parsed[k]).trim()) details[k] = String(parsed[k]);
    }
    return { details, failed: false };
  } catch (e) {
    console.error('Gemini parse failed, using defaults:', e.message);
    return { details: { ...DEFAULTS }, failed: true };
  }
}

// ---------- Image processing ----------
const LOGO_PATH = path.join(__dirname, 'logo.png');
const toDataUri = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;

async function buildHero(imageBuffer, width, height) {
  let img = sharp(imageBuffer)
    .rotate() // respect EXIF orientation
    .resize(width, height, { fit: 'cover' })
    .modulate({ brightness: 1.08 });

  if (fs.existsSync(LOGO_PATH)) {
    const logo = await sharp(LOGO_PATH).resize({ width: 220 }).png().toBuffer();
    img = img.composite([{ input: logo, gravity: 'northeast' }]);
  }
  return toDataUri(await img.jpeg({ quality: 88 }).toBuffer());
}

async function buildThumb(imageBuffer) {
  const out = await sharp(imageBuffer)
    .rotate()
    .resize(600, 470, { fit: 'cover' })
    .modulate({ brightness: 1.05 })
    .jpeg({ quality: 80 })
    .toBuffer();
  return toDataUri(out);
}

// ---------- HTML rendering ----------
function readTemplate(file) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) {
    console.error(`WARNING: ${file} is missing from the project root`);
    return null;
  }
  return fs.readFileSync(p, 'utf8');
}
const TEMPLATE_SINGLE = readTemplate('template.html') || '<html><body><h1>Template Missing</h1></body></html>';
const TEMPLATE_MULTI = readTemplate('template-multi.html') || TEMPLATE_SINGLE;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fontCss() {
  const local = path.join(__dirname, 'fonts', 'Cairo.ttf');
  if (!fs.existsSync(local)) return '';
  const b64 = fs.readFileSync(local).toString('base64');
  return `<style>@font-face{font-family:'Cairo';src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:100 900;}</style>`;
}
const FONT_CSS = fontCss();

const RAW_KEYS = new Set(['IMAGE_URL', 'GALLERY']); // trusted HTML, not escaped

function renderHtml(template, values) {
  const html = template.replace(/\{\{(\w+)\}\}/g, (_m, key) =>
    RAW_KEYS.has(key) ? values[key] ?? '' : escapeHtml(values[key] ?? '')
  );
  return html.replace('</head>', `${FONT_CSS}</head>`);
}

async function renderPng(html) {
  const chromium = await getChromium();
  if (!FONT_CSS && FONT_URL) await chromium.font(FONT_URL);

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1080, height: 1920 },
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(await page.screenshot({ type: 'png' }));
  } finally {
    await browser.close();
  }
}

// ---------- Main pipeline ----------
async function processSubmission(phone, data) {
  const imageIds = data.images.slice(0, MAX_IMAGES);
  console.log(
    `Processing ${imageIds.length} image(s), ${data.audios.length} voice note(s) for ${phone}`
  );

  await sendText(phone, '⏳ جاري تصميم الكاتالوج العقاري الخاص بك، لحظات...');

  try {
    const [imageBuffers, audioBufs] = await Promise.all([
      Promise.all(imageIds.map(downloadMedia)),
      Promise.all(
        data.audios.map(async (a) => ({ mime: a.mime, buffer: await downloadMedia(a.id) }))
      ),
    ]);

    const multi = imageBuffers.length > 1;

    const parsePromise = parseDetails(data.text, audioBufs);
    const heroDataUri = await buildHero(imageBuffers[0], 1080, multi ? 820 : 1050);

    // Thumbnails one by one to keep RAM low on the free tier
    const thumbs = [];
    for (const b of imageBuffers.slice(1)) thumbs.push(await buildThumb(b));
    const gallery = thumbs.length
      ? `<div class="gallery g${thumbs.length}">${thumbs.map((u) => `<img src="${u}" />`).join('')}</div>`
      : '';

    const { details, failed } = await parsePromise;

    const html = renderHtml(multi ? TEMPLATE_MULTI : TEMPLATE_SINGLE, {
      IMAGE_URL: heroDataUri,
      GALLERY: gallery,
      PRICE: clip(details.price, 40),
      TITLE: clip(details.title, 70),
      AREA: clip(details.area, 25),
      ROOMS: clip(details.rooms, 20),
      FLOOR: clip(details.floor, 20),
      LOCATION: clip(details.location, 40),
      AGENT_NAME: AGENTS[phone] || DEFAULT_AGENT_NAME,
      AGENT_PHONE: `+${phone}`,
    });

    const png = await renderPng(html);
    await sendImage(phone, png, clip(details.title, 70));
    console.log('Brochure generated and sent.');

    if (failed) {
      await sendText(phone, '⚠️ معرفتش أقرا التفاصيل كويس. ابعتها تاني (نص أو صوت) مع الصور وهعدّل الكاتالوج.');
    }
  } catch (err) {
    console.error('Error in submission pipeline:', err.message);
    await sendText(phone, '❌ عذراً، حصلت مشكلة أثناء تجهيز الصورة. جرّب إرسال الطلب مرة أخرى.');
  }
}

app.listen(PORT, () => console.log(`Broker bot server running on port ${PORT}`));
