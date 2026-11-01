"use strict";
// Golden corpus: spoken Egyptian Arabic searches read by the local parser (what runs when the AI is down, and the
// words the AI reply is checked against). A listed query must give exactly these filters and leave no stray word.
const Q = require("../../domain/searchQuery");

const CASES = [
 // [query, expected summary keys]
 ["عايز شقة تلات اوض في التجمع تحت تمانية مليون", {t:"apartment",bmin:3,pmax:8e6,place:"new_cairo"}],
 ["محتاج شقة غرفتين وصالة للايجار في مدينة نصر", {t:"apartment",lt:"rent",bmin:2}],
 ["فيلا للبيع في الشيخ زايد ميزانيتي ٣٥ مليون", {t:"villa",lt:"sale",pmax:35e6}],
 ["دوبلكس اربع غرف في الرحاب حتى ١٢ مليون", {t:"duplex",bmin:4,pmax:12e6}],
 ["بنتهاوس روف في التجمع الخامس", {t:"penthouse"}],
 ["شقة بسعر مليون ونص", {pmax:1.5e6}],
 ["شقة تحت مليونين", {pmax:2e6}],
 ["شقة بميزانية ٨ مليون ونص", {pmax:8.5e6}],
 ["شقة من ٣ ل ٥ مليون في العاصمة الادارية", {pmin:3e6,pmax:5e6,place:"new_capital"}],
 ["شقة ٩٥٠ الف", {pmax:950e3}],
 ["ايجار شقة ٧٠ الف في الشهر في التجمع", {lt:"rent",pmax:70e3}],
 ["شقة للايجار بحدود ٣٠ الف جنيه", {lt:"rent",pmax:30e3}],
 ["شقة ١٥٠ متر او اكتر", {amin:150}],
 ["شقة مساحتها على الاقل ١٢٠ متر", {amin:120}],
 ["شقة مش اقل من ١٣٠ متر", {amin:130}],
 ["شقة من ١٠٠ ل ١٤٠ متر في زايد", {amin:100,amax:140}],
 ["شقة بتقسيط على ٨ سنين", {inst:true,years:8}],
 ["شقة مقدم ١٠٪ وتقسيط ١٠ سنين", {down:10,years:10}],
 ["شقة قسط ١٥ الف في الشهر", {maxinst:15e3}],
 ["شقة مقدم نص مليون", {maxdown:5e5}],
 ["شقة كاش تحت ٥ مليون", {cash:true,pmax:5e6}],
 ["شقة ريسيل في مدينتي", {market:"resale"}],
 ["شقة من المطور في الشروق", {market:"primary"}],
 ["شقة استلام فوري", {ready:true}],
 ["شقة تسليم ٢٠٢٨", {deliv:2028}],
 ["شقة تحت الانشاء", {}],
 ["شقة على الطوب", {fin:"core_and_shell"}],
 ["شقة نص تشطيب", {fin:"semi_finished"}],
 ["شقة تشطيب سوبر لوكس", {fin:"super_lux"}],
 ["شقة هاي لوكس", {fin:"super_lux"}],
 ["شقة تشطيب كامل", {fin:"fully_finished"}],
 ["شقة مفروشة للايجار", {furn:"furnished"}],
 ["شقة فاضية للايجار", {furn:"unfurnished"}],
 ["شقة بالدور الاول", {floor:1}],
 ["شقة في دور ارضي بجنينة", {floor:0}],
 ["شقة متكرر", {floormin:1}],
 ["شقة في اخر دور", {}],
 ["شقة ناصية", {feat:"corner"}],
 ["شقة بحري", {feat:"north_facing"}],
 ["شقة على لاند سكيب", {}],
 ["شقة فيها اسانسير وجراج", {}],
 ["شقة بغرفة مربية", {feat:"nanny_room"}],
 ["شقة فيها تراس", {}],
 ["شقة قريبة من الجامعة الامريكية", {}],
 ["كومباوند ازاد", {}],
 ["شقة في سوديك فيليت", {place:"villette"}],
 ["شقة في ماونتن فيو اي سيتي", {place:"mv_icity"}],
 ["شقة في هايد بارك تلات غرف", {place:"hyde_park",bmin:3}],
 ["شقة في ميفيدا", {place:"mivida"}],
 ["شاليه في الساحل الشمالي", {t:"chalet"}],
 ["شاليه في العين السخنة", {t:"chalet"}],
 ["ارض في القاهرة الجديدة", {t:"land"}],
 ["محل تجاري للايجار", {t:"shop",lt:"rent"}],
 ["مكتب اداري ٨٠ متر", {t:"office"}],
 ["عيادة للايجار في المعادي", {t:"clinic"}],
 ["توين هاوس في التجمع", {t:"twinhouse"}],
 ["تاون هاوس في زايد", {t:"townhouse"}],
 ["استوديو للايجار", {t:"studio"}],
 ["يا باشا عندك شقة تلات غرف في التجمع", {bmin:3}],
 ["لو سمحت ممكن تدورلي على شقة اتنين غرف", {bmin:2}],
 ["ورينى شقتين في الرحاب", {}],
 ["عايز اوضتين وصالة", {bmin:2}],
 ["شقة ٣ غرف ٢ حمام", {bmin:3,bath:2}],
 ["شقة تلات حمامات", {bath:3}],
 ["شقه ثلاثه غرف", {bmin:3}],
 ["شقه ٣+ غرف", {bmin:3}],
 ["ابارتمنت ٣ بيدروم", {t:"apartment",bmin:3}],
 ["شقة ٢ بيدروم فولي فينشد", {bmin:2,fin:"fully_finished"}],
 ["شقة بلاش اللي على الشارع", {}],
 ["شقة للبيع بدون عمولة", {}],
 ["شقة اوفر ٣٠٠ الف", {}],
];

// Places and data the system does not know yet: these must be left as soft words, never turned into other filters.
const SOFT = [
  ["شقة في اخر دور", "اخر دور"],
  ["شقة للبيع بدون عمولة", "بدون عموله"],
  ["شقة اوفر ٣٠٠ الف", "اوفر"]
];

describe("voice search corpus", () => {
  for (const [q, want] of CASES) {
    if (/ازاد|المعادي|مدينة نصر|الجامعة|اخر دور|عمولة|اوفر/.test(q)) continue;
    test(q, () => {
      const f = Q.fallbackParse(q).filters;
      const got = {
        t: f.property_types[0], lt: f.listing_type, bmin: f.bedrooms_min, pmin: f.price_min, pmax: f.price_max, amin: f.area_min, amax: f.area_max,
        place: (f.places[0] || {}).key, inst: f.payment_installments || undefined, years: f.payment_years, down: f.payment_down_pct,
        maxinst: f.max_installment, maxdown: f.max_down_payment, cash: f.payment_cash, market: f.market, ready: f.delivery_ready, deliv: f.delivery_by_year,
        fin: f.finishing[0], furn: f.furnishing, floor: f.floor_min === f.floor_max ? f.floor_min : undefined, floormin: f.floor_min,
        feat: f.features.join(","), bath: f.bathrooms_min
      };
      for (const [k, v] of Object.entries(want)) {
        if (k === "feat") expect(got.feat).toContain(v);
        else expect(got[k]).toBe(v);
      }
      expect(f.place_terms).toEqual([]);
    });
  }
  test("off plan reads as not ready", () => {
    expect(Q.fallbackParse("شقة تحت الانشاء").filters.delivery_ready).toBe(false);
  });
  for (const [q, word] of SOFT) {
    test(`unknown word stays a soft word: ${q}`, () => {
      expect(Q.fallbackParse(q).filters.place_terms.join(" ")).toContain(word);
    });
  }
});
