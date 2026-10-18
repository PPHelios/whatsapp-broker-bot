const fs = require('fs');
const path = require('path');
const { default: satori } = require('satori');
const { Resvg } = require('@resvg/resvg-js');
const parseHtml = require('html-react-parser').default;

// Load Cairo Arabic Font once into memory buffer
const fontPath = path.join(__dirname, '..', 'fonts', 'Cairo.ttf');
let fontBuffer;
if (fs.existsSync(fontPath)) {
  fontBuffer = fs.readFileSync(fontPath);
} else {
  console.warn('Cairo.ttf font file not found in ./fonts directory. Arabic text shaping may fail.');
}

const safeColor = (c, fallback) => (/^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : fallback);

function readableOn(hex, dark = '#0b1329', light = '#ffffff') {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6,8}$/.test(h)) return light;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.19 ? dark : light;
}

const escapeXml = (unsafe = '') =>
  String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:image/');
}

/**
 * Builds standard brochure HTML markup cleanly parsed by Satori flexbox
 */
function buildFlyerTemplate(params) {
  // Normalize params between server.js and template signatures
  const heroUrl = params.heroUrl || params.heroImageUrl;
  const thumbs = Array.isArray(params.thumbs) ? params.thumbs.filter(isValidUrl) : [];
  const logoUri = params.logoUri || params.logoUrl;
  const agencyName = params.agencyName || 'الوكالة العقارية';
  const agentName = params.agentName || agencyName;
  const agentPhone = params.brokerPhone || params.agentPhone || '';
  const title = params.title || 'وحدة عقارية مميزة';
  const price = params.priceDisplay || params.price || 'عند الطلب';
  const area = params.area || '-';
  const rooms = params.bedrooms || params.rooms || '-';
  const floor = params.floor || '-';
  const location = params.location || 'القاهرة';
  const propertyType = params.propertyType || '';
  const finishing = params.finishing || '';
  const features = Array.isArray(params.features) ? params.features : [];
  const code = params.code || '';

  const brand = safeColor(params.brandColor, '#0f172a');
  const accent = safeColor(params.accentColor, '#38bdf8');
  const onBrand = readableOn(brand);
  const onAccent = readableOn(accent);

  // Fallback hero banner when no valid photo is provided
  const heroMarkup = isValidUrl(heroUrl)
    ? `<img src="${heroUrl}" style="width: 1080px; height: 740px; object-fit: cover;" />`
    : `
      <div style="display: flex; flex-direction: column; width: 1080px; height: 740px; background-color: #1e293b; justify-content: center; align-items: center; border-bottom: 3px solid rgba(255,255,255,0.1);">
        <span style="font-size: 110px; margin-bottom: 20px;">🏡</span>
        <span style="font-size: 38px; color: rgba(255,255,255,0.7); font-weight: 700;">${escapeXml(title)}</span>
      </div>
    `;

  const galleryHtml = thumbs.length > 0 ? `
    <div style="display: flex; flex-direction: row; flex-wrap: wrap; justify-content: space-between; padding: 20px 50px 0 50px;">
      ${thumbs.slice(0, 4).map((t) => `
        <img src="${t}" style="width: 475px; height: 260px; object-fit: cover; border-radius: 20px; margin-bottom: 15px; border: 2px solid rgba(255,255,255,0.15);" />
      `).join('')}
    </div>
  ` : '';

  const featuresHtml = features.length > 0 ? `
    <div style="display: flex; flex-direction: row; flex-wrap: wrap; padding: 15px 50px 0 50px;">
      ${features.slice(0, 6).map((f) => `
        <div style="background-color: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); border-radius: 50px; padding: 10px 24px; font-size: 26px; font-weight: 700; color: ${onBrand}; margin-left: 12px; margin-bottom: 12px; display: flex; align-items: center;">
          <span style="color: ${accent}; margin-left: 10px; font-weight: 900;">✓</span>
          <span>${escapeXml(f)}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  return `
    <div style="display: flex; flex-direction: column; width: 1080px; height: 1920px; background-color: ${brand}; color: ${onBrand}; font-family: 'Cairo'; justify-content: space-between; direction: rtl;">

      <!-- Top Section -->
      <div style="display: flex; flex-direction: column; width: 100%;">

        <!-- Hero Section -->
        <div style="display: flex; position: relative; width: 1080px; height: 740px;">
          ${heroMarkup}

          <!-- Top Bar Overlay -->
          <div style="display: flex; position: absolute; top: 35px; right: 40px; left: 40px; justify-content: space-between; align-items: center;">
            <div style="display: flex; align-items: center; background-color: rgba(15, 23, 42, 0.85); border: 1px solid rgba(255,255,255,0.2); border-radius: 60px; padding: 10px 24px;">
              ${isValidUrl(logoUri) ? `<img src="${logoUri}" style="height: 55px; max-width: 180px; object-fit: contain; margin-left: 15px;" />` : ''}
              <span style="font-size: 28px; font-weight: 700; color: #ffffff;">${escapeXml(agencyName)}</span>
            </div>
            ${code ? `
              <div style="display: flex; align-items: center;">
                <span style="background-color: rgba(15, 23, 42, 0.9); border: 1px solid rgba(255,255,255,0.25); color: #ffffff; padding: 8px 24px; border-radius: 40px; font-size: 28px; font-weight: 800;">#${escapeXml(code)}</span>
              </div>
            ` : ''}
          </div>

          <!-- Price Tag Badge -->
          <div style="display: flex; position: absolute; bottom: -35px; right: 40px; background-color: ${accent}; color: ${onAccent}; padding: 16px 44px; border-radius: 28px; font-size: 56px; font-weight: 900; box-shadow: 0 10px 30px rgba(0,0,0,0.4);">
            <span>${escapeXml(price)}</span>
          </div>

          <!-- Property Type Badge -->
          ${propertyType ? `
            <div style="display: flex; position: absolute; bottom: 25px; left: 40px; background-color: rgba(15, 23, 42, 0.85); border: 1px solid rgba(255,255,255,0.2); color: #ffffff; padding: 8px 24px; border-radius: 40px; font-size: 26px; font-weight: 700;">
              <span>${escapeXml(propertyType)}</span>
            </div>
          ` : ''}
        </div>

        <!-- Title & Location -->
        <div style="display: flex; flex-direction: column; padding: 60px 50px 0 50px;">
          <span style="font-size: 48px; font-weight: 900; line-height: 1.25;">${escapeXml(title)}</span>
          <div style="display: flex; align-items: center; margin-top: 10px;">
            <span style="color: ${accent}; font-size: 32px; margin-left: 10px;">📍</span>
            <span style="font-size: 32px; color: rgba(255,255,255,0.8); font-weight: 600;">${escapeXml(location)}</span>
          </div>
        </div>

        <!-- Optional Gallery Section -->
        ${galleryHtml}

        <!-- Specs Grid -->
        <div style="display: flex; flex-direction: column; margin: 25px 50px 0 50px; background-color: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 30px; overflow: hidden;">
          <div style="display: flex; flex-direction: row; justify-content: space-around; padding: 25px 15px; border-bottom: 1px solid rgba(255,255,255,0.1);">
            <div style="display: flex; flex-direction: column; align-items: center; width: 33%;">
              <span style="font-size: 38px;">📐</span>
              <span style="font-size: 34px; font-weight: 800; margin-top: 5px;">${escapeXml(area)}</span>
              <span style="font-size: 22px; color: rgba(255,255,255,0.6);">المساحة</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; width: 33%; border-right: 1px solid rgba(255,255,255,0.1); border-left: 1px solid rgba(255,255,255,0.1);">
              <span style="font-size: 38px;">🛏️</span>
              <span style="font-size: 34px; font-weight: 800; margin-top: 5px;">${escapeXml(rooms)}</span>
              <span style="font-size: 22px; color: rgba(255,255,255,0.6);">الغرف</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center; width: 33%;">
              <span style="font-size: 38px;">🏢</span>
              <span style="font-size: 34px; font-weight: 800; margin-top: 5px;">${escapeXml(floor)}</span>
              <span style="font-size: 22px; color: rgba(255,255,255,0.6);">الدور</span>
            </div>
          </div>
          ${finishing ? `
            <div style="display: flex; align-items: center; padding: 16px 30px; font-size: 28px;">
              <span style="margin-left: 10px;">🎨</span>
              <span style="color: rgba(255,255,255,0.6); margin-left: 10px;">التشطيب:</span>
              <span style="font-weight: 800;">${escapeXml(finishing)}</span>
            </div>
          ` : ''}
        </div>

        <!-- Features Badges -->
        ${featuresHtml}

      </div>

      <!-- Footer CTA Card -->
      <div style="display: flex; flex-direction: row; justify-content: space-between; align-items: center; padding: 45px 50px 50px 50px; background-color: ${accent}; color: ${onAccent}; border-top-left-radius: 50px; border-top-right-radius: 50px;">
        <div style="display: flex; flex-direction: column;">
          <span style="font-size: 42px; font-weight: 900;">${escapeXml(agentName)}</span>
          <span style="font-size: 26px; font-weight: 600; opacity: 0.85; margin-top: 4px;">${escapeXml(agencyName)}</span>
          ${agentPhone ? `
            <span style="font-size: 38px; font-weight: 800; direction: ltr; text-align: right; margin-top: 10px;">${escapeXml(agentPhone)}</span>
          ` : ''}
        </div>
        <div style="display: flex; flex-direction: column; align-items: center; background-color: ${brand}; color: ${onBrand}; padding: 20px 32px; border-radius: 26px;">
          <span style="font-size: 28px; font-weight: 800;">💬 تواصل واتساب</span>
          ${code ? `<span style="font-size: 22px; font-weight: 700; opacity: 0.8; margin-top: 4px;">#${escapeXml(code)}</span>` : ''}
        </div>
      </div>

    </div>
  `;
}

/**
 * Fast Satori + Resvg Render
 * @returns {Promise<Buffer>} Pure PNG binary buffer
 */
async function renderFlyerSatori(params) {
  const htmlString = buildFlyerTemplate(params);
  const reactElement = parseHtml(htmlString);

  const svg = await satori(reactElement, {
    width: 1080,
    height: 1920,
    fonts: fontBuffer ? [
      {
        name: 'Cairo',
        data: fontBuffer,
        weight: 700,
        style: 'normal',
      },
    ] : [],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1080 },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0,
  });

  return resvg.render().asPng();
}

module.exports = {
  renderFlyerSatori,
  renderFlyerPng: renderFlyerSatori
};