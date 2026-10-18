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

// "6.5 مليون" | "6,500,000" | "6.5m" | "6 مليون ونص" | "850 الف" -> number (EGP) or null
function parsePrice(input = '') {
  const s = toEnDigits(input).toLowerCase().replace(/,/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(مليون|ملايين|million|mil|m|الف|ألف|k|thousand)?/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const unit = m[2];
  const isMillion = unit && /^(مليون|ملايين|million|mil|m)$/.test(unit);
  const isThousand = unit && /^(الف|ألف|k|thousand)$/.test(unit);
  if (isMillion) {
    if (/ونص|ونصف|and a half/.test(s)) n += 0.5;
    n *= 1e6;
  } else if (isThousand) {
    n *= 1e3;
  }
  n = Math.round(n);
  return n >= 1000 ? n : null;
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
