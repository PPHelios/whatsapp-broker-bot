const T = require('../lib/text');
const assert = require('assert');
const eq = (a, b) => assert.deepStrictEqual(a, b);

// prices
const P = (s, o) => T.parsePrice(s, o);
eq(P('6.5 مليون'), 6500000);
eq(P('٦٫٥ مليون'), 6500000);
eq(P('6 مليون ونص'), 6500000);
eq(P('6 ونص مليون'), 6500000);
eq(P('6 ونصف مليون'), 6500000);
eq(P('مليون ونص'), 1500000);
eq(P('مليونين ونص'), 2500000);
eq(P('نص مليون'), 500000);
eq(P('ربع مليون'), 250000);
eq(P('مليون وربع'), 1250000);
eq(P('تلات ارباع مليون'), 750000);
eq(P('6 وتلت مليون'), 6333000);
eq(P('مليون وتلت'), 1333000);
eq(P('تلات ملايين وربع'), 3250000);
eq(P('ستة مليون'), 6000000);
eq(P('تمانية مليون'), 8000000);
eq(P('6,500,000'), 6500000);
eq(P('6500000 جنيه'), 6500000);
eq(P('12.5 مليون جنيه'), 12500000);
eq(P('6.5m'), 6500000);
eq(P('850k'), 850000);
eq(P('850 الف'), 850000);
eq(P('ميت الف'), 100000);
eq(P('مية وخمسين الف'), 150000);
eq(P('خمسة وعشرين مليون'), 25000000);
eq(P('الف'), null);                            // bare thousand is too ambiguous
eq(P('كلمة غريبة الف'), null);
eq(P('6.5'), null);                            // ambiguous without opts
eq(P('6.5', { implicitUnits: true }), 6500000);
eq(P('7 ونص', { implicitUnits: true }), 7500000);
eq(P('850', { implicitUnits: true }), 850000);
eq(P('ستة مليون و185 متر'), 6000000);          // later numbers ignored

// commands
eq(T.parseCommand('بحث التجمع الخامس'), { type: 'search', query: 'التجمع الخامس' });
eq(T.parseCommand('عقار 1234'), { type: 'show', code: '1234' });
eq(T.parseCommand('#١٢٣٤'), { type: 'show', code: '1234' });
eq(T.parseCommand('تم البيع 1234'), { type: 'status', status: 'sold', code: '1234' });
eq(T.parseCommand('sold #1234'), { type: 'status', status: 'sold', code: '1234' });
eq(T.parseCommand('السعر 1234 6.5 مليون'), { type: 'price', code: '1234', priceText: '6.5 مليون' });
eq(T.parseCommand('price 1234 to 7m'), { type: 'price', code: '1234', priceText: '7m' });
eq(T.parseCommand('السعر 7 مليون'), null);
eq(T.parseCommand('السعر 6.5 مليون'), null);
eq(T.parseCommand('تمام'), { type: 'confirm' });
eq(T.parseCommand('كمل'), { type: 'skip' });
eq(T.parseCommand('شقة 185 متر'), null);
eq(T.normalizeAr('التَجمع الخامِس أ'), 'التجمع الخامس ا');
eq(T.formatPrice(6500000, 'ar'), '6,500,000 جنيه');
console.log('ALL TEXT TESTS PASS');
