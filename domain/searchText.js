// domain/searchText.js — The one search normalizer (JS twin of SQL normalize_search, migration 005)
// Both sides must agree byte for byte; tests/unit/search-parity.test.js checks them against each other.
"use strict";

/**
 * lower → Eastern/Persian digits to 0-9 → أإآٱ→ا, ى→ي, ة→ه, ؤ→و, ئ→ي → drop tashkeel and tatweel
 * → anything but a-z, 0-9, Arabic letters or "-" becomes a space → collapse spaces.
 */
function normalizeSearch(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[^0-9a-zء-ي٠-٩ٱ-ۓ-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// SQL twin (kept here so the migration and the tests use the same text).
const NORMALIZE_SEARCH_SQL = `
CREATE OR REPLACE FUNCTION public.normalize_search(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT btrim(regexp_replace(
    regexp_replace(
      translate(lower(coalesce(t, '')),
                'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
                'اااايهوي01234567890123456789'),
      '[\\u064B-\\u065F\\u0670\\u0640]', '', 'g'),
    '[^0-9a-z\\u0621-\\u064A\\u0660-\\u0669\\u0671-\\u06D3-]+', ' ', 'g'))
$function$;`;

module.exports = { normalizeSearch, NORMALIZE_SEARCH_SQL };
