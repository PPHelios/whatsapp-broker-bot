// lib/text.js
// Pure helpers (no external dependencies) for digit normalization, Arabic search normalization,
// price parsing/formatting, and WhatsApp command parsing.

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
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function formatPrice(n, lang = 'ar') {
  if (n === null || n === undefined || Number.isNaN(Number(n))) {
    return lang === 'en' ? 'On Request' : 'عند الطلب';
  }
  const num = Number(n);
  if (num <= 0) return lang === 'en' ? 'On Request' : 'عند الطلب';

  const v = num.toLocaleString('en-US');
  return lang === 'en' ? `${v} EGP` : `${v} جنيه`;
}

// "6.5 مليون" | "6,500,000" | "6.5m" | "6 مليون ونص" | "850 الف" -> number (EGP) or null
function parsePrice(input = '') {
  const s = toEnDigits(input).toLowerCase().replace(/,/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(مليون|ملايين|million|mil|m|الف|ألف|آلاف|الاف|k|thousand)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = m[2];
  const isMillion = unit && /^(مليون|ملايين|million|mil|m)$/.test(unit);
  const isThousand = unit && /^(الف|ألف|آلاف|الاف|k|thousand)$/.test(unit);
  if (isMillion) {
    if (/ونص|ونصف|and a half/.test(s)) n += 0.5;
    n *= 1e6;
  } else if (isThousand) {
    if (/ونص|ونصف|and a half/.test(s)) n += 0.5;
    n *= 1e3;
  }
  n = Math.round(n);
  return n >= 1000 ? n : null;
}

// Supports both numeric codes (e.g., 1001) and scoped alphanumeric codes (e.g., ANH245, MV-104, A12)
// Requires at least one digit in the code so normal words aren't misidentified as codes.
const CODE = '#?\\s*([a-zA-Z0-9_-]*\\d[a-zA-Z0-9_-]*)';

function parseCommand(raw = '') {
  const t = toEnDigits(raw).trim().replace(/\s+/g, ' ');
  if (!t) return null;
  let m;

  if (/^(مساعدة|مساعده|الاوامر|الأوامر|help|\/help|\?|؟)$/i.test(t)) return { type: 'help' };
  if (/^(تمام|تمام كده|اعتمد|تأكيد|تاكيد|ok|okay|confirm|✅)$/i.test(t)) return { type: 'confirm' };
  if (/^(كمل|كمّل|كمل كده|تخطي|skip|continue)$/i.test(t)) return { type: 'skip' };
  if (/^(احصائيات|إحصائيات|احصائياتي|تقرير|stats)$/i.test(t)) return { type: 'stats' };

  if ((m = t.match(/^(?:بحث|ابحث|دور|search|find)\s+(.+)$/i))) {
    return { type: 'search', query: m[1].trim() };
  }

  if ((m = t.match(new RegExp(`^(?:عقار|عرض|كود|وحدة|وحده|show|view)\\s+${CODE}$`, 'i')))) {
    return { type: 'show', code: m[1] };
  }

  // Direct hashtag lookup: e.g. "#1042" or "#ANH245" or "#MV-104"
  if ((m = t.match(/^#\s*([a-zA-Z0-9_-]*\d[a-zA-Z0-9_-]*)$/i))) {
    return { type: 'show', code: m[1] };
  }

  if ((m = t.match(new RegExp(`^(?:تم البيع|تم بيع|مباع|بيع|sold)\\s+${CODE}$`, 'i')))) {
    return { type: 'status', status: 'sold', code: m[1] };
  }

  if ((m = t.match(new RegExp(`^(?:ارشيف|أرشيف|ارشفه|ارشفة|أرشفة|archive)\\s+${CODE}$`, 'i')))) {
    return { type: 'status', status: 'archived', code: m[1] };
  }

  if ((m = t.match(new RegExp(`^(?:تفعيل|فعل|تنشيط|activate|reactivate|active)\\s+${CODE}$`, 'i')))) {
    return { type: 'status', status: 'active', code: m[1] };
  }

  if ((m = t.match(new RegExp(`^(?:السعر|سعر|تحديث سعر|price)\\s+${CODE}\\s*(?:الى|إلى|الي|لـ|ل|to|=|:)?\\s*(.+)$`, 'i')))) {
    return { type: 'price', code: m[1], priceText: m[2].trim() };
  }

  return null;
}

const PROPERTY_TYPE_AR = {
  apartment: 'شقة',
  villa: 'فيلا',
  townhouse: 'تاون هاوس',
  twinhouse: 'توين هاوس',
  duplex: 'دوبلكس',
  penthouse: 'بنتهاوس',
  studio: 'ستوديو',
  chalet: 'شاليه',
  office: 'مكتب إداري',
  clinic: 'عيادة',
  commercial: 'وحدة تجارية',
  land: 'أرض'
};

function translatePropertyType(type = '') {
  const key = String(type || '').toLowerCase().trim();
  return PROPERTY_TYPE_AR[key] || type || 'وحدة عقارية';
}

module.exports = {
  toEnDigits,
  normalizeAr,
  clip,
  formatPrice,
  parsePrice,
  parseCommand,
  translatePropertyType
};