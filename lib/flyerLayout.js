// lib/flyerLayout.js — Flyer layout: the Satori element tree, photo grid and one render pass (split out of lib/flyer.js).
"use strict";

const satori = require("satori").default || require("satori");
const { W, PAD, INNER, MAX_PHOTOS, mix, contrast, truncate } = require("./flyerStyle");
const { cover, logoSlot, fitInto } = require("./flyerAssets");

/* ====================================================================== */
/* 6. Layout (Satori element tree)                                          */
/* ====================================================================== */
const ICONS = {
  area: '<path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/>',
  land: '<path d="M3 21h18M5 21V7l7-4 7 4v14"/>',
  bed: '<path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="1.6"/>',
  bath: '<path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-3zM6 12V6a2 2 0 0 1 4 0M7 19l-1 2M17 19l1 2"/>',
  floor: '<path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  finishing:
    '<path d="M18.37 2.63L14 7l-1.5-1.5 4.37-4.37a2.12 2.12 0 1 1 3 3zM12.5 5.5l-8 8a2.12 2.12 0 0 0-.62 1.5V19a1 1 0 0 0 1 1h3.5a2.12 2.12 0 0 0 1.5-.62l8-8L12.5 5.5z"/>',
  garden: '<path d="M12 22v-7M12 15a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM8 22h8"/>',
  roof: '<path d="M3 11l9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/>',
  pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  wa: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
};

const h = (type, style = {}, children) => {
  const kids = Array.isArray(children)
    ? children.filter((c) => c !== null && c !== undefined && c !== false)
    : children;
  return {
    type,
    props: {
      style: { display: "flex", ...style },
      ...(kids !== undefined ? { children: kids } : {})
    }
  };
};
const imgEl = (src, w, hh, style = {}) => ({
  type: "img",
  props: {
    src,
    width: w,
    height: hh,
    style: { width: w, height: hh, ...style }
  }
});
const txt = (s, o = {}) =>
  h(
    "div",
    {
      fontSize: o.size || 28,
      fontWeight: o.weight || 400,
      color: o.color,
      lineHeight: o.lh || 1.25,
      whiteSpace: o.nowrap ? "nowrap" : "normal",
      textAlign: o.align || "left",
      ...(o.style || {})
    },
    String(s)
  );
const icon = (key, color, size = 36) =>
  imgEl(
    `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${
        ICONS[key] || ICONS.pin
      }</svg>`
    ).toString("base64")}`,
    size,
    size
  );

const HERO_H = {
  1: 860,
  2: 520,
  3: 440,
  4: 420,
  5: 400,
  6: 390,
  7: 380,
  8: 370,
  9: 360
};
const ROW_H = { 1: 300, 2: 215, 3: 170 };
const ROWS_FOR = [
  [],
  [1],
  [2],
  [3],
  [2, 2],
  [3, 2],
  [3, 3],
  [3, 2, 2],
  [3, 3, 2]
]; // by number of non-hero photos
const PHOTO_GAP = 10;

/** Photo grid geometry for n photos (0-9): { heroH, rows:[{count,w,h}] } */
function photoLayout(n, opts) {
  const count = Math.max(0, Math.min(MAX_PHOTOS, n));
  const rows = (ROWS_FOR[Math.max(0, count - 1)] || []).map((c) => ({
    count: c,
    w: Math.floor((INNER - (c - 1) * PHOTO_GAP) / c),
    h: Math.round(ROW_H[c] * opts.rowScale)
  }));
  const base = count === 0 ? 420 : HERO_H[count];
  return { heroH: Math.round(base * opts.heroScale) + opts.heroExtra, rows };
}

function buildTree(model, T, photos, logo, opts) {
  const { heroH, rows } = photoLayout(photos.length, opts);

  /* ---- header ---- */
  let left = null;
  if (!model.unbranded) {
    const parts = [];
    let showName = true;
    if (logo) {
      const slot = logoSlot(logo.ratio);
      const fit = fitInto(logo.w, logo.h, slot.maxW, slot.maxH);
      let plate = "#FFFFFF";
      if (logo.light) {
        plate = mix(T.headerBg, "#000000", 0.35);
        for (let t = 0.35; t <= 1 && contrast("#FFFFFF", plate) < 4.5; t += 0.1)
          plate = mix(T.headerBg, "#000000", t);
      }
      parts.push(
        h(
          "div",
          {
            background: plate,
            borderRadius: 20,
            padding: 14,
            alignItems: "center",
            justifyContent: "center"
          },
          imgEl(logo.uri, fit.w, fit.h)
        )
      );
      showName = slot.showName;
    }
    if (showName && model.brand.name) {
      parts.push(
        txt(truncate(model.brand.name, 22), {
          size: 34,
          weight: 700,
          color: T.onHeader,
          nowrap: true
        })
      );
    }
    if (parts.length) left = h("div", { alignItems: "center", gap: 18 }, parts);
  }
  const refEl = model.ref
    ? h(
        "div",
        {
          border: `2px solid ${T.accentOnHeader}`,
          borderRadius: 14,
          padding: "6px 16px"
        },
        txt(`Ref ${model.ref}`, {
          size: 28,
          weight: 700,
          color: T.accentOnHeader,
          nowrap: true
        })
      )
    : null;
  const header =
    left || refEl
      ? h(
          "div",
          {
            width: W,
            height: 140,
            background: T.headerBg,
            padding: `0 ${PAD}px`,
            alignItems: "center",
            justifyContent: left ? "space-between" : "flex-end"
          },
          [left, refEl]
        )
      : null;

  /* ---- photos ---- */
  const tag = h(
    "div",
    { position: "absolute", left: 20, top: 20, alignItems: "center", gap: 10 },
    [
      h(
        "div",
        { background: T.accent, borderRadius: 14, padding: "10px 22px" },
        txt(model.tag.text, {
          size: 30,
          weight: 700,
          color: T.onAccent,
          nowrap: true
        })
      ),
      model.tag.badge
        ? h(
            "div",
            {
              background: "rgba(0,0,0,0.55)",
              border: "2px solid #FFFFFF",
              borderRadius: 14,
              padding: "8px 18px"
            },
            txt(model.tag.badge, {
              size: 28,
              weight: 700,
              color: "#FFFFFF",
              nowrap: true
            })
          )
        : null
    ]
  );
  const hero = photos.length
    ? h("div", { position: "relative", width: INNER, height: heroH }, [
        imgEl(photos[0], INNER, heroH, { borderRadius: 20 }),
        tag
      ])
    : h(
        "div",
        {
          position: "relative",
          width: INNER,
          height: heroH,
          borderRadius: 20,
          background: T.headerBg,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14
        },
        [
          txt(truncate(model.typeName || "Property", 24), {
            size: 76,
            weight: 700,
            color: T.onHeader,
            align: "center"
          }),
          model.place
            ? txt(truncate(model.place, 36), {
                size: 38,
                color: T.onHeaderMuted,
                align: "center"
              })
            : null,
          tag
        ]
      );
  let cursor = 1;
  const rowEls = rows.map((r) => {
    const cells = [];
    for (let i = 0; i < r.count; i++)
      cells.push(imgEl(photos[cursor++], r.w, r.h, { borderRadius: 16 }));
    return h("div", { gap: PHOTO_GAP, width: INNER }, cells);
  });
  const photoBlock = h(
    "div",
    { flexDirection: "column", gap: PHOTO_GAP, width: INNER },
    [hero, ...rowEls]
  );

  /* ---- title + location ---- */
  const showTitle = photos.length || !model.titleIsFallback;
  const titleBlock = !showTitle && !model.locationLine ? null : h(
    "div",
    { flexDirection: "column", gap: 10, width: INNER },
    [
      showTitle ? txt(model.title, { size: 56, weight: 700, color: T.fg, lh: 1.2 }) : null,
      model.locationLine
        ? h("div", { alignItems: "center", gap: 10, width: INNER }, [
            icon("pin", T.accentText, 34),
            txt(model.locationLine, { size: 34, color: T.muted, nowrap: true })
          ])
        : null
    ]
  );

  /* ---- price card ---- */
  const c = model.card;
  const leftCol = h("div", { flexDirection: "column", gap: 6 }, [
    c.missing
      ? null
      : txt(c.label, { size: 28, weight: 700, color: T.onAccentMuted }),
    h("div", { alignItems: "flex-end", gap: 12 }, [
      txt(c.main, {
        size: c.missing ? 56 : 84,
        weight: 700,
        color: T.onAccent,
        lh: 1.05,
        nowrap: true
      }),
      c.unit
        ? txt(c.unit, {
            size: 36,
            weight: 700,
            color: T.onAccent,
            nowrap: true,
            style: { paddingBottom: 8 }
          })
        : null
    ]),
    c.full ? txt(c.full, { size: 28, color: T.onAccent }) : null,
    c.perSqm ? txt(c.perSqm, { size: 28, color: T.onAccentMuted }) : null
  ]);
  let rightCol = null;
  if (
    c.right &&
    c.right.type === "lines" &&
    (c.right.lines.length || c.right.bold.length)
  ) {
    rightCol = h(
      "div",
      {
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 6,
        maxWidth: 500
      },
      [
        txt("Payment plans", {
          size: 26,
          weight: 700,
          color: T.onAccentMuted,
          align: "right"
        }),
        ...c.right.lines.map((l) =>
          txt(l, { size: 28, color: T.onAccent, align: "right" })
        ),
        ...c.right.bold.map((l) =>
          txt(l, { size: 28, weight: 700, color: T.onAccent, align: "right" })
        )
      ]
    );
  } else if (c.right && c.right.type === "figure") {
    rightCol = h(
      "div",
      { flexDirection: "column", alignItems: "flex-end", gap: 4 },
      [
        txt(c.right.label, {
          size: 28,
          weight: 700,
          color: T.onAccentMuted,
          align: "right"
        }),
        txt(c.right.value, {
          size: 64,
          weight: 700,
          color: T.onAccent,
          lh: 1.05,
          nowrap: true
        })
      ]
    );
  } else if (c.right && c.right.type === "pill") {
    rightCol = h(
      "div",
      {
        border: `2px solid ${T.onAccent}`,
        borderRadius: 30,
        padding: "8px 22px"
      },
      txt(c.right.text, {
        size: 28,
        weight: 700,
        color: T.onAccent,
        nowrap: true
      })
    );
  }
  const priceCard = h(
    "div",
    {
      width: INNER,
      background: T.accent,
      borderRadius: 24,
      padding: "24px 28px",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 20
    },
    [leftCol, rightCol]
  );

  const notesCard = c.notes.length
    ? h(
        "div",
        {
          width: INNER,
          background: T.card,
          border: `2px solid ${T.line}`,
          borderRadius: 20,
          padding: "18px 24px",
          flexDirection: "column",
          gap: 8
        },
        c.notes.map((n) => txt(n, { size: 28, color: T.fg }))
      )
    : null;

  /* ---- facts grid ---- */
  let factsEl = null;
  const nf = model.facts.length;
  if (nf >= 1) {
    const cols = nf <= 3 ? nf : nf === 4 ? 2 : 3;
    const lines = [];
    for (let i = 0; i < nf; i += cols)
      lines.push(model.facts.slice(i, i + cols));
    factsEl = h(
      "div",
      {
        width: INNER,
        background: T.card,
        border: `2px solid ${T.line}`,
        borderRadius: 24,
        flexDirection: "column"
      },
      lines.map((row, ri) =>
        h(
          "div",
          {
            width: INNER - 4,
            ...(ri ? { borderTop: `2px solid ${T.line}` } : {})
          },
          row.map((f, ci) =>
            h(
              "div",
              {
                flexGrow: 1,
                flexBasis: 0,
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                padding: "20px 10px",
                ...(ci ? { borderLeft: `2px solid ${T.line}` } : {})
              },
              [
                icon(f.icon, T.accentText, 36),
                txt(f.value, {
                  size: f.value.length > 16 ? 30 : 36,
                  weight: 700,
                  color: T.fg,
                  align: "center"
                }),
                txt(f.label, { size: 26, color: T.muted, align: "center" })
              ]
            )
          )
        )
      )
    );
  }

  /* ---- chips ---- */
  let chips = model.chips;
  if (chips.length > opts.chipMax) {
    const extra = chips.length - (opts.chipMax - 1);
    chips = [
      ...chips.slice(0, opts.chipMax - 1),
      { text: `+${extra} more`, hi: false }
    ];
  }
  const chipsEl = chips.length
    ? h(
        "div",
        { width: INNER, flexWrap: "wrap", gap: 10 },
        chips.map((ch) =>
          h(
            "div",
            {
              background: T.card,
              border: `2px solid ${ch.hi ? T.accentText : T.line}`,
              borderRadius: 30,
              padding: "8px 20px"
            },
            txt(ch.text, {
              size: 28,
              weight: 700,
              color: ch.hi ? T.accentText : T.fg,
              nowrap: true
            })
          )
        )
      )
    : null;

  /* ---- contact band ---- */
  const ct = model.contact;
  const who = ct.name
    ? h("div", { alignItems: "center", gap: 18 }, [
        ct.initial
          ? h(
              "div",
              {
                width: 88,
                height: 88,
                borderRadius: 44,
                background: T.accent,
                alignItems: "center",
                justifyContent: "center"
              },
              txt(ct.initial, { size: 44, weight: 700, color: T.onAccent })
            )
          : null,
        h("div", { flexDirection: "column", gap: 2 }, [
          txt(ct.name, {
            size: ct.name.length > 22 ? 36 : 42,
            weight: 700,
            color: T.onHeader,
            nowrap: true
          }),
          txt(ct.role, { size: 28, color: T.onHeaderMuted })
        ])
      ])
    : null;
  const call = ct.phone
    ? h(
        "div",
        {
          flexDirection: "column",
          alignItems: ct.name ? "flex-end" : "center",
          gap: 2
        },
        [
          h("div", { alignItems: "center", gap: 14 }, [
            icon("wa", T.onHeader, 44),
            txt(ct.phone, {
              size: 50,
              weight: 700,
              color: T.onHeader,
              nowrap: true
            })
          ]),
          txt("Call or WhatsApp", { size: 26, color: T.onHeaderMuted })
        ]
      )
    : null;
  const footer =
    who || call
      ? h(
          "div",
          {
            width: W,
            background: T.headerBg,
            padding: `28px ${PAD}px`,
            alignItems: "center",
            justifyContent: who && call ? "space-between" : "center"
          },
          [who, call]
        )
      : null;

  const body = h(
    "div",
    {
      width: W,
      flexDirection: "column",
      gap: 22,
      padding: `${header ? 24 : 32}px ${PAD}px ${
        (footer ? 32 : 40) + (opts.extraPad || 0)
      }px`
    },
    [photoBlock, titleBlock, priceCard, notesCard, factsEl, chipsEl]
  );

  return h(
    "div",
    {
      width: W,
      flexDirection: "column",
      background: T.bg,
      color: T.fg,
      fontFamily: "Cairo"
    },
    [header, body, footer]
  );
}

const svgHeight = (svg) => {
  const m = String(svg).match(/<svg[^>]*?\sheight="([\d.]+)"/);
  return m ? Math.ceil(parseFloat(m[1])) : 0;
};

const PASS_LEVELS = [
  { heroScale: 1, rowScale: 1, chipMax: 10, heroExtra: 0, extraPad: 0 },
  { heroScale: 0.9, rowScale: 0.88, chipMax: 8, heroExtra: 0, extraPad: 0 },
  { heroScale: 0.8, rowScale: 0.76, chipMax: 6, heroExtra: 0, extraPad: 0 }
];

async function renderPass(model, T, bufs, logo, opts, fonts) {
  const lay = photoLayout(bufs.length, opts);
  const dims = [];
  if (bufs.length) dims.push([INNER, lay.heroH]);
  for (const r of lay.rows)
    for (let i = 0; i < r.count; i++) dims.push([r.w, r.h]);
  const photos = await Promise.all(
    bufs.map((b, i) => cover(b, dims[i][0], dims[i][1]))
  );
  const tree = buildTree(model, T, photos, logo, opts);
  const svg = await satori(tree, { width: W, fonts });
  return { svg, height: svgHeight(svg) };
}

module.exports = {
  ICONS,
  ROWS_FOR,
  photoLayout,
  buildTree,
  svgHeight,
  PASS_LEVELS,
  renderPass
};
