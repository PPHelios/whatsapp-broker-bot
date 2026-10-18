const fs = require('fs');
const path = require('path');
const { default: satori } = require('satori');
const { Resvg } = require('@resvg/resvg-js');

// ---------------------------------------------------------------------------
// Font Loader: Guaranteed In-Memory Buffer with Emergency Fallback
// ---------------------------------------------------------------------------
const fontCandidates = [
  path.join(__dirname, '..', 'fonts', 'Cairo.ttf'),
  path.join(__dirname, 'fonts', 'Cairo.ttf'),
  path.join(process.cwd(), 'fonts', 'Cairo.ttf')
];

let fontBuffer = null;
for (const p of fontCandidates) {
  if (fs.existsSync(p)) {
    try {
      fontBuffer = fs.readFileSync(p);
      break;
    } catch (_) {}
  }
}

if (!fontBuffer) {
  console.warn('⚠️ [RENDER] Cairo.ttf not found in standard paths. Text shaping may use fallback.');
}

// ---------------------------------------------------------------------------
// Helper Utilities
// ---------------------------------------------------------------------------
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

function isValidHttpOrDataUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  return (
    trimmed.startsWith('https://') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('data:image/')
  );
}

// ---------------------------------------------------------------------------
// Satori-Compliant VDOM Builder (Zero parser crashes, 100% Satori Schema)
// ---------------------------------------------------------------------------
function createVNode(type, props = {}, children = []) {
  const normChildren = Array.isArray(children)
    ? children.filter((c) => c !== null && c !== undefined && c !== false)
    : [children].filter((c) => c !== null && c !== undefined && c !== false);

  return {
    type,
    props: {
      ...props,
      children: normChildren.length === 1 ? normChildren[0] : normChildren
    }
  };
}

/**
 * Builds standard brochure virtual DOM adhering strictly to Satori layout rules:
 * 1. All flex containers explicitly declare display: flex.
 * 2. No undefined image sources (all image URLs verified before node emission).
 * 3. Text is strictly encased in terminal string nodes.
 */
function buildSatoriVDOM(params = {}) {
  const brand = safeColor(params.brandColor, '#0f172a');
  const accent = safeColor(params.accentColor, '#38bdf8');
  const onBrand = readableOn(brand);
  const onAccent = readableOn(accent);

  const agencyName = String(params.agencyName || params.agency_name || 'الوكالة العقارية');
  const agentPhone = String(params.brokerPhone || params.agentPhone || params.phone || '');
  const title = String(params.title || 'وحدة عقارية مميزة');
  const price = String(params.priceDisplay || params.price || 'عند الطلب');
  const area = params.area ? String(params.area) : '-';
  const rooms = params.bedrooms ? String(params.bedrooms) : '-';
  const location = String(params.location || 'القاهرة');
  const propertyType = params.propertyType ? String(params.propertyType) : '';
  const code = params.code ? String(params.code) : '';
  const features = Array.isArray(params.features) ? params.features.slice(0, 4) : [];

  const rawLogo = params.logoUrl || params.logoUri || params.logo_url;
  const validLogoUrl = isValidHttpOrDataUrl(rawLogo) ? rawLogo.trim() : null;

  const rawHero = params.heroUrl || params.heroImageUrl;
  const validHeroUrl = isValidHttpOrDataUrl(rawHero) ? rawHero.trim() : null;

  // 1. Top Section Components
  const heroNode = validHeroUrl
    ? createVNode('img', {
        src: validHeroUrl,
        style: { width: '1080px', height: '740px', objectFit: 'cover' }
      })
    : createVNode(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            width: '1080px',
            height: '740px',
            backgroundColor: '#1e293b',
            justifyContent: 'center',
            alignItems: 'center',
            borderBottom: '4px solid rgba(255,255,255,0.1)'
          }
        },
        [
          createVNode('span', { style: { fontSize: '110px', marginBottom: '20px' } }, '🏡'),
          createVNode(
            'span',
            { style: { fontSize: '40px', color: 'rgba(255,255,255,0.7)', fontWeight: '700' } },
            title
          )
        ]
      );

  // Logo + Agency Badge
  const badgeChildren = [];
  if (validLogoUrl) {
    badgeChildren.push(
      createVNode('img', {
        src: validLogoUrl,
        style: { height: '52px', maxWidth: '170px', objectFit: 'contain', marginLeft: '16px' }
      })
    );
  }
  badgeChildren.push(
    createVNode(
      'span',
      { style: { fontSize: '28px', fontWeight: '700', color: '#ffffff' } },
      agencyName
    )
  );

  const topBarNode = createVNode(
    'div',
    {
      style: {
        display: 'flex',
        position: 'absolute',
        top: '35px',
        right: '40px',
        left: '40px',
        justifyContent: 'space-between',
        alignItems: 'center'
      }
    },
    [
      createVNode(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '60px',
            padding: '10px 24px'
          }
        },
        badgeChildren
      ),
      code
        ? createVNode(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                border: '1px solid rgba(255,255,255,0.25)',
                color: '#ffffff',
                padding: '8px 26px',
                borderRadius: '40px',
                fontSize: '28px',
                fontWeight: '800'
              }
            },
            `#${code}`
          )
        : null
    ]
  );

  // Price Badge Node
  const priceBadgeNode = createVNode(
    'div',
    {
      style: {
        display: 'flex',
        position: 'absolute',
        bottom: '-35px',
        right: '40px',
        backgroundColor: accent,
        color: onAccent,
        padding: '16px 44px',
        borderRadius: '28px',
        fontSize: '54px',
        fontWeight: '900',
        boxShadow: '0 10px 30px rgba(0,0,0,0.4)'
      }
    },
    price
  );

  // Property Type Badge
  const propertyTypeBadge = propertyType
    ? createVNode(
        'div',
        {
          style: {
            display: 'flex',
            position: 'absolute',
            bottom: '25px',
            left: '40px',
            backgroundColor: 'rgba(15, 23, 42, 0.85)',
            border: '1px solid rgba(255,255,255,0.2)',
            color: '#ffffff',
            padding: '8px 24px',
            borderRadius: '40px',
            fontSize: '26px',
            fontWeight: '700'
          }
        },
        propertyType
      )
    : null;

  // Header Box
  const headerContainer = createVNode(
    'div',
    { style: { display: 'flex', position: 'relative', width: '1080px', height: '740px' } },
    [heroNode, topBarNode, priceBadgeNode, propertyTypeBadge]
  );

  // Title and Location Block
  const titleBlock = createVNode(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        padding: '65px 50px 0 50px'
      }
    },
    [
      createVNode(
        'span',
        { style: { fontSize: '48px', fontWeight: '900', lineHeight: '1.25' } },
        title
      ),
      createVNode(
        'div',
        { style: { display: 'flex', alignItems: 'center', marginTop: '12px' } },
        [
          createVNode('span', { style: { color: accent, fontSize: '32px', marginLeft: '10px' } }, '📍'),
          createVNode(
            'span',
            { style: { fontSize: '32px', color: 'rgba(255,255,255,0.8)', fontWeight: '600' } },
            location
          )
        ]
      )
    ]
  );

  // Specs Matrix (Area & Rooms)
  const specsMatrix = createVNode(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-around',
        margin: '35px 50px 0 50px',
        backgroundColor: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: '30px',
        padding: '25px 15px'
      }
    },
    [
      createVNode(
        'div',
        { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: '48%' } },
        [
          createVNode('span', { style: { fontSize: '40px' } }, '📐'),
          createVNode('span', { style: { fontSize: '34px', fontWeight: '800', marginTop: '5px' } }, area),
          createVNode('span', { style: { fontSize: '22px', color: 'rgba(255,255,255,0.6)' } }, 'المساحة')
        ]
      ),
      createVNode(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            width: '48%',
            borderRight: '1px solid rgba(255,255,255,0.12)'
          }
        },
        [
          createVNode('span', { style: { fontSize: '40px' } }, '🛏️'),
          createVNode('span', { style: { fontSize: '34px', fontWeight: '800', marginTop: '5px' } }, rooms),
          createVNode('span', { style: { fontSize: '22px', color: 'rgba(255,255,255,0.6)' } }, 'الغرف')
        ]
      )
    ]
  );

  // Features List
  const featureBadges = features.map((feat) =>
    createVNode(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          backgroundColor: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '50px',
          padding: '10px 24px',
          fontSize: '26px',
          fontWeight: '700',
          color: onBrand,
          marginLeft: '12px',
          marginBottom: '12px'
        }
      },
      [
        createVNode('span', { style: { color: accent, marginLeft: '10px', fontWeight: '900' } }, '✓'),
        createVNode('span', {}, String(feat))
      ]
    )
  );

  const featuresContainer = featureBadges.length > 0
    ? createVNode(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'row',
            flexWrap: 'wrap',
            padding: '25px 50px 0 50px'
          }
        },
        featureBadges
      )
    : null;

  // Footer CTA Block
  const footerNode = createVNode(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '45px 50px 50px 50px',
        backgroundColor: accent,
        color: onAccent,
        borderTopLeftRadius: '50px',
        borderTopRightRadius: '50px'
      }
    },
    [
      createVNode(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        [
          createVNode('span', { style: { fontSize: '40px', fontWeight: '900' } }, agencyName),
          agentPhone
            ? createVNode(
                'span',
                {
                  style: {
                    fontSize: '36px',
                    fontWeight: '800',
                    direction: 'ltr',
                    textAlign: 'right',
                    marginTop: '8px'
                  }
                },
                agentPhone
              )
            : null
        ]
      ),
      createVNode(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            backgroundColor: brand,
            color: onBrand,
            padding: '18px 30px',
            borderRadius: '24px'
          }
        },
        [
          createVNode('span', { style: { fontSize: '28px', fontWeight: '800' } }, '💬 تواصل واتساب'),
          code
            ? createVNode(
                'span',
                { style: { fontSize: '22px', fontWeight: '700', opacity: '0.8', marginTop: '4px' } },
                `#${code}`
              )
            : null
        ]
      )
    ]
  );

  // Root Container
  return createVNode(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '1080px',
        height: '1920px',
        backgroundColor: brand,
        color: onBrand,
        fontFamily: 'Cairo',
        justifyContent: 'space-between',
        direction: 'rtl'
      }
    },
    [
      createVNode(
        'div',
        { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        [headerContainer, titleBlock, specsMatrix, featuresContainer]
      ),
      footerNode
    ]
  );
}

// ---------------------------------------------------------------------------
// Main Render Engine
// ---------------------------------------------------------------------------
/**
 * Renders Satori flyer directly to PNG binary buffer
 * @param {Object} params - Property and Agency details
 * @returns {Promise<Buffer>} Pure PNG buffer
 */
async function renderFlyerSatori(params = {}) {
  const vdom = buildSatoriVDOM(params);

  const fontsConfig = fontBuffer
    ? [
        {
          name: 'Cairo',
          data: fontBuffer,
          weight: 700,
          style: 'normal'
        }
      ]
    : [];

  // Generate SVG via Satori
  const svg = await satori(vdom, {
    width: 1080,
    height: 1920,
    fonts: fontsConfig
  });

  // Rasterize to PNG via Rust Resvg
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1080 },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0
  });

  return resvg.render().asPng();
}

module.exports = {
  renderFlyerSatori,
  renderFlyerPng: renderFlyerSatori
};