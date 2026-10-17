require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { GoogleGenAI } = require('@google/genai');

const {
  PORT = 3000,
  GEMINI_API_KEY,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  DEFAULT_AGENT_NAME = 'مكتب العقارات المميزة',
  AGENTS_JSON = '{}', // e.g. {"201001234567":"أحمد للعقارات"}
  FONT_URL, // optional fallback if fonts/Cairo.ttf is missing
} = process.env;

const GRAPH = 'https://graph.facebook.com/v21.0';
const AUTH = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
const AGENTS = JSON.parse(AGENTS_JSON);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const app = express();
app.use(express.json());

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
const DEBOUNCE_MS = 4000;

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // ack fast so Meta doesn't retry

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);

    const phone = message.from;
    const buf = (buffers[phone] ||= { images: [], audios: [], text: '', timer: null });

    if (message.type === 'text') buf.text += ' ' + message.text.body;
    if (message.type === 'image') {
      buf.images.push(message.image.id);
      if (message.image.caption) buf.text += ' ' + message.image.caption;
    }
    if (message.type === 'audio') {
      buf.audios.push({
        id: message.audio.id,
        mime: (message.audio.mime_type || 'audio/ogg').split(';')[0],
      });
    }

    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      const data = buffers[phone];
      delete buffers[phone];
      enqueue(() => processSubmission(phone, data));
    }, DEBOUNCE_MS);
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ---------- Job queue (one Chromium at a time: free-tier RAM) ----------
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue.then(job).catch((e) => console.error('Job error:', e));
}

// ---------- WhatsApp helpers ----------
async function downloadMedia(mediaId) {
  const { data } = await axios.get(`${GRAPH}/${mediaId}`, { headers: AUTH });
  const file = await axios.get(data.url, { headers: AUTH, responseType: 'arraybuffer' });
  return Buffer.from(file.data);
}

async function sendText(to, body) {
  await axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    { headers: AUTH }
  );
}

async function sendImage(to, pngBuffer, caption) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'brochure.png');

  const upload = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: AUTH,
    body: form,
  });
  const { id } = await upload.json();
  if (!id) throw new Error('Media upload failed');

  await axios.post(
    `${GRAPH}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { id, caption },
    },
    { headers: AUTH }
  );
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

async function parseDetails(text, audioBuffers) {
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
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json' },
    });
    let parsed = JSON.parse(response.text);
    if (Array.isArray(parsed)) parsed = parsed[0];
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (parsed?.[k] && String(parsed[k]).trim()) out[k] = String(parsed[k]);
    }
    return out;
  } catch (e) {
    console.error('Gemini parse failed, using defaults:', e.message);
    return { ...DEFAULTS };
  }
}

// ---------- Image processing ----------
const LOGO_PATH = path.join(__dirname, 'logo.png'); // optional watermark

async function buildHero(imageBuffer) {
  let img = sharp(imageBuffer)
    .rotate() // respect EXIF orientation
    .resize(1080, 1050, { fit: 'cover' })
    .modulate({ brightness: 1.08 });

  if (fs.existsSync(LOGO_PATH)) {
    const logo = await sharp(LOGO_PATH).resize({ width: 220 }).png().toBuffer();
    img = img.composite([{ input: logo, gravity: 'northeast' }]);
  }
  const out = await img.jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

// ---------- HTML rendering ----------
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fontCss() {
  const local = path.join(__dirname, 'fonts', 'Cairo.ttf');
  if (!fs.existsSync(local)) return '';
  const b64 = fs.readFileSync(local).toString('base64');
  return `<style>@font-face{font-family:'Cairo';src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:100 900;}</style>`;
}
const FONT_CSS = fontCss();

function renderHtml(values) {
  // Function replacer: no $-pattern surprises, replaces ALL occurrences
  const html = TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_m, key) =>
    key === 'IMAGE_URL' ? values[key] : escapeHtml(values[key] ?? '')
  );
  return html.replace('</head>', `${FONT_CSS}</head>`);
}

async function renderPng(html) {
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
    return Buffer.from(await page.screenshot({ type: 'png' })); // buffer, no disk file
  } finally {
    await browser.close();
  }
}

// ---------- Main pipeline ----------
async function processSubmission(phone, data) {
  console.log(`Processing ${data.images.length} image(s), ${data.audios.length} voice note(s) for ${phone}`);

  if (!data.images.length) {
    await sendText(phone, 'ابعت صورة واحدة على الأقل مع التفاصيل (نص أو رسالة صوتية).');
    return;
  }

  try {
    const [heroSource, ...audioBufs] = await Promise.all([
      downloadMedia(data.images[0]),
      ...data.audios.map(async (a) => ({ mime: a.mime, buffer: await downloadMedia(a.id) })),
    ]);

    const [details, heroDataUri] = await Promise.all([
      parseDetails(data.text, audioBufs),
      buildHero(heroSource),
    ]);

    const html = renderHtml({
      IMAGE_URL: heroDataUri,
      PRICE: details.price,
      TITLE: details.title,
      AREA: details.area,
      ROOMS: details.rooms,
      FLOOR: details.floor,
      LOCATION: details.location,
      AGENT_NAME: AGENTS[phone] || DEFAULT_AGENT_NAME,
      AGENT_PHONE: `+${phone}`,
    });

    const png = await renderPng(html);
    await sendImage(phone, png, details.title);
    console.log('Brochure sent.');
  } catch (err) {
    console.error('Error processing submission:', err);
    await sendText(phone, 'حصلت مشكلة في تجهيز الصورة، جرّب تبعت تاني.').catch(() => {});
  }
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));