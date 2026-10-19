// Pure helpers (no dependencies) so they can be unit-tested.

const toEnDigits = (s = '') =>
  String(s)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');

// Normalize Arabic/English text for search: digits, diacritics, alef/yaa/taa-marbuta variants
function normalizeAr(s = '') {
  return toEnDigits(s)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function formatPrice(n, lang = 'ar') {
  const v = Number(n).toLocaleString('en-US');
  return lang === 'en' ? `${v} EGP` : `${v} جنيه`;
}

// Egyptian Arabic / English prices -> number (EGP) or null.
// Handles: "6.5 مليون", "6,500,000", "6.5m", "850 الف", "6 ونص مليون", "مليون ونص",
// "نص مليون", "ربع مليون", "مليونين ونص", "تلات ملايين وربع", "6 وتلت مليون", number words (ستة مليون).
// opts.implicitUnits: a bare "6.5" means millions and a bare "850" means thousands (sale prices only).
const NUM_WORDS = {
  واحد: 1, واحده: 1, اتنين: 2, اثنين: 2, اثنان: 2, تلاته: 3, ثلاثه: 3, تلات: 3, ثلاث: 3,
  اربعه: 4, اربع: 4, خمسه: 5, خمس: 5, سته: 6, ست: 6, سبعه: 7, سبع: 7,
  تمانيه: 8, ثمانيه: 8, تمان: 8, ثمان: 8, تسعه: 9, تسع: 9, عشره: 10, عشر: 10,
  عشرين: 20, تلاتين: 30, ثلاثين: 30, اربعين: 40, خمسين: 50, ستين: 60,
  سبعين: 70, تمانين: 80, ثمانين: 80, تسعين: 90,
  ميه: 100, ميت: 100, مئه: 100, مائه: 100, ميتين: 200, تلتميه: 300, ربعميه: 400,
  خمسميه: 500, ستميه: 600, سبعميه: 700, تمنميه: 800, تسعميه: 900,
};
const FRACS = {
  نص: 0.5, نصف: 0.5, ربع: 0.25, تلت: 1 / 3, ثلث: 1 / 3, تلتين: 2 / 3, ثلثين: 2 / 3, _q3: 0.75,
};
const UNITS = {
  مليون: { mul: 1e6 }, ملايين: { mul: 1e6 }, مليونين: { mul: 1e6, dual: true },
  million: { mul: 1e6 }, mil: { mul: 1e6 }, m: { mul: 1e6 },
  الف: { mul: 1e3 }, الاف: { mul: 1e3 }, الفين: { mul: 1e3, dual: true },
  thousand: { mul: 1e3 }, k: { mul: 1e3 },
};
const FRAC_RE = '(?:نص|نصف|ربع|تلتين|ثلثين|تلت|ثلث)';

function parsePrice(input = '', { implicitUnits = false } = {}) {
  let s = normalizeAr(input).replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/,/g, ' ');
  // "تلات ارباع" (three quarters) -> single token
  s = s.replace(/(?:^|\s)و?(?:تلات|تلت|ثلاث)\s*(?:ارباع|تربع|اربع)(?=\s|$)/g, ' _q3 ');
  const tokens = s
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(new RegExp(`^و(?=${FRAC_RE}$)`), ''))
    .map((t) => (t.startsWith('و') && NUM_WORDS[t.slice(1)] != null ? t.slice(1) : t))
    .filter((t) => t !== 'و');

  let base = null;
  let fracSum = 0;
  let fracBeforeUnit = false;
  let unit = null;
  let locked = false; // once a unit is found, later numbers (e.g. area) are ignored
  let prevWasWord = false;

  for (const t of tokens) {
    let m;
    if ((m = t.match(/^(\d+(?:\.\d+)?)(m|k|mil|million|thousand)?$/))) {
      if (!locked) base = parseFloat(m[1]);
      if (m[2] && !unit) { unit = UNITS[m[2]]; locked = true; }
    } else if (NUM_WORDS[t] != null) {
      // additive number words: "خمسة وعشرين" = 25, "ميه وخمسين" = 150
      if (!locked) base = prevWasWord && base != null ? base + NUM_WORDS[t] : NUM_WORDS[t];
      prevWasWord = true;
      continue;
    } else if (FRACS[t] != null) {
      fracSum += FRACS[t];
      if (!unit) fracBeforeUnit = true;
    } else if (UNITS[t] && !unit) {
      unit = UNITS[t];
      if (unit.dual && base == null) base = 2;
      locked = base != null;
    }
    prevWasWord = false;
  }

  let value;
  if (unit) {
    // A bare "ألف" is too easy to misread ("ميت ألف"), so thousands always need a number
    if (unit.mul === 1e3 && base == null) return null;
    const b = base ?? (fracBeforeUnit ? 0 : 1); // "نص مليون" = 0.5M, "مليون ونص" = 1.5M
    value = (b + fracSum) * unit.mul;
    if (unit.mul === 1e6 && value % 1000 !== 0) value = Math.round(value / 1000) * 1000;
  } else if (base != null) {
    value = base + fracSum;
    if (value < 1000 && implicitUnits) value = value < 100 ? value * 1e6 : value * 1e3;
  } else {
    return null;
  }
  value = Math.round(value);
  return value >= 1000 ? value : null;
}

// Listing codes start at 1000, so 4+ digits is unambiguous vs. prices like "7 مليون"
const CODE = '#?\\s*(\\d{4,})';

function parseCommand(raw = '') {
  const t = toEnDigits(raw).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  let m;

  if (/^(مساعدة|مساعده|help|\/help|\?|؟)$/i.test(t)) return { type: 'help' };
  if (/^(تمام|تمام كده|اعتمد|ok|okay|confirm|✅)$/i.test(t)) return { type: 'confirm' };
  if (/^(كمل|كمّل|كمل كده|skip|continue)$/i.test(t)) return { type: 'skip' };
  if (/^(احصائيات|إحصائيات|احصائياتي|stats)$/i.test(t)) return { type: 'stats' };

  if ((m = t.match(/^(?:بحث|ابحث|search|find)\s+(.+)$/i))) return { type: 'search', query: m[1] };
  if ((m = t.match(new RegExp(`^(?:عقار|عرض|show|view)\\s*${CODE}$`, 'i')))) return { type: 'show', code: m[1] };
  if ((m = t.match(/^#\s*(\d{4,})$/))) return { type: 'show', code: m[1] };

  if ((m = t.match(new RegExp(`^(?:تم البيع|تم بيع|مباع|بيع|sold)\\s*${CODE}$`, 'i'))))
    return { type: 'status', status: 'sold', code: m[1] };
  if ((m = t.match(new RegExp(`^(?:ارشيف|أرشيف|ارشفه|ارشفة|أرشفة|archive)\\s*${CODE}$`, 'i'))))
    return { type: 'status', status: 'archived', code: m[1] };
  if ((m = t.match(new RegExp(`^(?:تفعيل|فعل|activate|reactivate|active)\\s*${CODE}$`, 'i'))))
    return { type: 'status', status: 'active', code: m[1] };

  if ((m = t.match(new RegExp(`^(?:السعر|سعر|price)\\s*${CODE}\\s*(?:الى|إلى|الي|to|=|:)?\\s*(.+)$`, 'i'))))
    return { type: 'price', code: m[1], priceText: m[2] };

  return null;
}

module.exports = { toEnDigits, normalizeAr, clip, formatPrice, parsePrice, parseCommand };
