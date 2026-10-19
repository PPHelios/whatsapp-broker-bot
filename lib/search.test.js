const S = require('../lib/search');
const assert = require('assert');
const eq = (a, b) => assert.deepStrictEqual(a, b);

// ---- normalizeParsed: validation, coercion, safety
const p = S.normalizeParsed({
  intent: 'search',
  filters: { listing_type: 'sale', property_types: ['Apartment', 'twin house', 'spaceship'], price_max: '7 مليون',
             price_min: 9000000, bedrooms_min: '3', bedrooms_max: 3, features: ['حمام سباحة'] },
  locations: ['التجمع الخامس'],
  location_terms: ['5th Settlement', 'ميفيدا', 'مِيفيدا', 'x', "'; DROP TABLE listings;--"],
});
eq(p.filters.property_types, ['apartment', 'twinhouse']);       // unknown dropped, aliases normalized
eq([p.filters.price_min, p.filters.price_max], [7000000, 9000000]); // string parsed, min/max swapped
eq(S.normalizeParsed({ filters: { code: '#A101' } }).filters.code, 'A101');
assert(p.location_terms.includes('التجمع الخامس'));              // place as said is always searched
assert(p.location_terms.includes('5th settlement'));
eq(p.location_terms.filter((t) => t === 'ميفيدا').length, 1);   // diacritics deduped
assert(!p.location_terms.includes('x'));                          // too short dropped
assert(p.location_terms.every((t) => !/[;'"]/.test(t)));          // punctuation stripped

// ---- buildSearchQuery: structure, parameterization, relaxation
let q = S.buildSearchQuery('agency-1', p);
assert(q.sql.includes("l.status = 'active'") && q.sql.includes('l.agency_id = $1'));
assert(q.sql.includes('location_keywords &&') && q.sql.includes('ILIKE ANY'));
assert(!q.sql.includes('DROP TABLE'));                           // nothing from the model is inlined
const maxIdx = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => +m[1]));
eq(maxIdx, q.params.length);                                      // every placeholder has a param
eq(q.params[0], 'agency-1');

const q2 = S.buildSearchQuery('a', p, { relaxed: true });
assert(q2.params.includes(Math.round(7000000 * 0.85)) || q2.params.includes(Math.round(9000000 * 1.15)));
assert(q2.params.includes(2) && q2.params.includes(4));           // bedrooms 3 -> 2..4

const byCode = S.buildSearchQuery('a', S.normalizeParsed({ intent: 'search', filters: { code: 'MV-104', listing_type: 'sale' } }));
assert(byCode.sql.includes('lower(l.code)') && !byCode.sql.includes('listing_type ='));  // code ignores other filters

// LIKE wildcards in model output are escaped
const wild = S.normalizeParsed({ locations: ['50%_off'] });
const qw = S.buildSearchQuery('a', wild);
assert(qw.params.some((x) => Array.isArray(x) && x.some((t) => t.includes('\\'))) || wild.location_terms.every((t) => !/[%_]/.test(t)));

// ---- fallback parser (Gemini down)
const fb = S.fallbackParse('عايز شقة في التجمع الخامس');
eq(fb.filters.property_types, ['apartment']);
assert(fb.location_terms.includes('التجمع الخامس') && !fb.location_terms.includes('في') && !fb.location_terms.includes('عايز'));

// ---- misc
assert(S.hasAnyFilter(p) && !S.hasAnyFilter(S.normalizeParsed({ intent: 'search' })));
eq(S.normalizeKeywords(['Mivida', 'ميفيدا', 'ميفيدا', 'a']), ['mivida', 'ميفيدا']);
console.log(S.formatInterpretation(p));
eq(S.estimateCostUsd({ input: 1000000, output: 500000 }, { inPerM: 0.3, outPerM: 2.5 }), 1.55);
console.log('ALL SEARCH TESTS PASS');
