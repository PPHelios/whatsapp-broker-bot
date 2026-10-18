// lib/render.js
const fs = require("fs");
const path = require("path");
const satoriModule = require("satori");
const satori = satoriModule.default || satoriModule;
const { Resvg } = require("@resvg/resvg-js");

// ---------------------------------------------------------------------------
// Font Buffer Loader
// ---------------------------------------------------------------------------
const fontCandidates = [
  path.join(__dirname, "..", "fonts", "Cairo.ttf"),
  path.join(__dirname, "fonts", "Cairo.ttf"),
  path.join(process.cwd(), "fonts", "Cairo.ttf")
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

// ---------------------------------------------------------------------------
// Helpers, BiDi Word Order Fix & Strict URL Validation
// ---------------------------------------------------------------------------
const safeColor = (c, fallback) =>
  /^#[0-9a-fA-F]{3,8}$/.test(c || "") ? c : fallback;

function isValidImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length < 5) return false;
  return (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("data:image/")
  );
}

// Satori shapes individual Arabic words properly, but in certain flex/text contexts
// reverses the word order of Arabic phrases (e.g. "عند الطلب" -> "الطلب عند").
// Rendering each phrase as a row-reverse flex container of words guarantees exact RTL word flow.
function containsArabic(text = "") {
  return /[\u0600-\u06FF]/.test(String(text));
}

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

function createRtlTextNode(text, textStyle = {}, containerStyle = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  if (!containsArabic(raw)) {
    return createVNode("span", { style: textStyle }, raw);
  }

  const words = raw.split(/\s+/);
  if (words.length <= 1) {
    return createVNode("span", { style: textStyle }, raw);
  }

  return createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "row-reverse",
        flexWrap: "wrap",
        alignItems: "center",
        ...containerStyle
      }
    },
    words.map((word, idx) =>
      createVNode(
        "span",
        {
          style: {
            ...textStyle,
            marginLeft: idx < words.length - 1 ? "8px" : "0px"
          }
        },
        word
      )
    )
  );
}

function truncate(str, max) {
  if (!str) return "";
  const s = String(str).trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Adaptive Gallery Layout Engine (Safe Images Only)
// ---------------------------------------------------------------------------
function renderPhotoMosaic(images = [], agencyName = "الوكالة العقارية") {
  const validImages = (Array.isArray(images) ? images : [])
    .filter(isValidImageUrl)
    .map((img) => img.trim());

  const total = validImages.length;

  if (total === 0) {
    return createVNode(
      "div",
      {
        style: {
          display: "flex",
          width: "1080px",
          height: "820px",
          backgroundColor: "#1e293b",
          justifyContent: "center",
          alignItems: "center"
        }
      },
      [
        createRtlTextNode(agencyName, {
          fontSize: "42px",
          color: "rgba(255,255,255,0.35)",
          fontWeight: "700"
        })
      ]
    );
  }

  // 1 Image: Full Hero Display
  if (total === 1) {
    return createVNode(
      "div",
      {
        style: {
          display: "flex",
          width: "1080px",
          height: "820px",
          overflow: "hidden"
        }
      },
      [
        createVNode("img", {
          src: validImages[0],
          style: { width: "1080px", height: "820px", objectFit: "cover" }
        })
      ]
    );
  }

  // 2 Images: Split Vertical Panes
  if (total === 2) {
    return createVNode(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "row",
          width: "1080px",
          height: "820px"
        }
      },
      [
        createVNode(
          "div",
          {
            style: {
              display: "flex",
              width: "536px",
              height: "820px",
              overflow: "hidden",
              marginRight: "8px"
            }
          },
          [
            createVNode("img", {
              src: validImages[0],
              style: { width: "536px", height: "820px", objectFit: "cover" }
            })
          ]
        ),
        createVNode(
          "div",
          {
            style: {
              display: "flex",
              width: "536px",
              height: "820px",
              overflow: "hidden"
            }
          },
          [
            createVNode("img", {
              src: validImages[1],
              style: { width: "536px", height: "820px", objectFit: "cover" }
            })
          ]
        )
      ]
    );
  }

  // 3 Images: 1 Main Photo Top, 2 Half-Width Below
  if (total === 3) {
    return createVNode(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          width: "1080px",
          height: "820px"
        }
      },
      [
        createVNode(
          "div",
          {
            style: {
              display: "flex",
              width: "1080px",
              height: "520px",
              overflow: "hidden",
              marginBottom: "8px"
            }
          },
          [
            createVNode("img", {
              src: validImages[0],
              style: { width: "1080px", height: "520px", objectFit: "cover" }
            })
          ]
        ),
        createVNode(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "row",
              width: "1080px",
              height: "292px"
            }
          },
          [
            createVNode(
              "div",
              {
                style: {
                  display: "flex",
                  width: "536px",
                  height: "292px",
                  overflow: "hidden",
                  marginRight: "8px"
                }
              },
              [
                createVNode("img", {
                  src: validImages[1],
                  style: { width: "536px", height: "292px", objectFit: "cover" }
                })
              ]
            ),
            createVNode(
              "div",
              {
                style: {
                  display: "flex",
                  width: "536px",
                  height: "292px",
                  overflow: "hidden"
                }
              },
              [
                createVNode("img", {
                  src: validImages[2],
                  style: { width: "536px", height: "292px", objectFit: "cover" }
                })
              ]
            )
          ]
        )
      ]
    );
  }

  // 4 Images: 1 Large Top + 3 Mini Thumbnails
  if (total === 4) {
    return createVNode(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          width: "1080px",
          height: "820px"
        }
      },
      [
        createVNode(
          "div",
          {
            style: {
              display: "flex",
              width: "1080px",
              height: "530px",
              overflow: "hidden",
              marginBottom: "8px"
            }
          },
          [
            createVNode("img", {
              src: validImages[0],
              style: { width: "1080px", height: "530px", objectFit: "cover" }
            })
          ]
        ),
        createVNode(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "row",
              width: "1080px",
              height: "282px"
            }
          },
          [
            createVNode(
              "div",
              {
                style: {
                  display: "flex",
                  width: "354px",
                  height: "282px",
                  overflow: "hidden",
                  marginRight: "8px"
                }
              },
              [
                createVNode("img", {
                  src: validImages[1],
                  style: { width: "354px", height: "282px", objectFit: "cover" }
                })
              ]
            ),
            createVNode(
              "div",
              {
                style: {
                  display: "flex",
                  width: "354px",
                  height: "282px",
                  overflow: "hidden",
                  marginRight: "8px"
                }
              },
              [
                createVNode("img", {
                  src: validImages[2],
                  style: { width: "354px", height: "282px", objectFit: "cover" }
                })
              ]
            ),
            createVNode(
              "div",
              {
                style: {
                  display: "flex",
                  width: "356px",
                  height: "282px",
                  overflow: "hidden"
                }
              },
              [
                createVNode("img", {
                  src: validImages[3],
                  style: { width: "356px", height: "282px", objectFit: "cover" }
                })
              ]
            )
          ]
        )
      ]
    );
  }

  // 5+ Images
  const thumbCount = Math.min(total - 1, 4);
  const remainingCount = total - 5;
  const thumbWidth = Math.floor((1080 - (thumbCount - 1) * 8) / thumbCount);

  const thumbnails = [];
  for (let i = 1; i <= thumbCount; i++) {
    const isLastSlot = i === 4 && remainingCount > 0;
    const thumbNode = createVNode(
      "div",
      {
        style: {
          display: "flex",
          position: "relative",
          width: `${thumbWidth}px`,
          height: "272px",
          overflow: "hidden",
          marginRight: i < thumbCount ? "8px" : "0px"
        }
      },
      [
        createVNode("img", {
          src: validImages[i],
          style: {
            width: `${thumbWidth}px`,
            height: "272px",
            objectFit: "cover"
          }
        }),
        isLastSlot
          ? createVNode(
              "div",
              {
                style: {
                  display: "flex",
                  position: "absolute",
                  top: "0px",
                  left: "0px",
                  width: `${thumbWidth}px`,
                  height: "272px",
                  backgroundColor: "rgba(15, 23, 42, 0.75)",
                  alignItems: "center",
                  justifyContent: "center"
                }
              },
              [
                createVNode(
                  "span",
                  {
                    style: {
                      fontSize: "38px",
                      fontWeight: "800",
                      color: "#ffffff"
                    }
                  },
                  `+${remainingCount + 1}`
                )
              ]
            )
          : null
      ]
    );
    thumbnails.push(thumbNode);
  }

  return createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        width: "1080px",
        height: "820px"
      }
    },
    [
      createVNode(
        "div",
        {
          style: {
            display: "flex",
            width: "1080px",
            height: "540px",
            overflow: "hidden",
            marginBottom: "8px"
          }
        },
        [
          createVNode("img", {
            src: validImages[0],
            style: { width: "1080px", height: "540px", objectFit: "cover" }
          })
        ]
      ),
      createVNode(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row",
            width: "1080px",
            height: "272px"
          }
        },
        thumbnails
      )
    ]
  );
}

// ---------------------------------------------------------------------------
// Main Brochure Builder
// ---------------------------------------------------------------------------
function buildSatoriVDOM(params = {}) {
  const brand = safeColor(params.brandColor || params.brand_color, "#0b1120");
  const accent = safeColor(
    params.accentColor || params.accent_color,
    "#0ea5e9"
  );

  const agencyName = truncate(params.agencyName || "الوكالة العقارية", 28);
  const brokerPhone = String(params.brokerPhone || "").trim();
  const title = truncate(params.title || "وحدة سكنية راقية", 50);
  const price = truncate(params.priceDisplay || "عند الطلب", 26);
  const area = params.area ? truncate(params.area, 16) : "-";
  const rooms = params.bedrooms ? truncate(params.bedrooms, 16) : "-";
  const location = truncate(params.location || "القاهرة", 40);
  const code = params.code ? String(params.code).trim().toUpperCase() : "";
  const features = (Array.isArray(params.features) ? params.features : [])
    .slice(0, 6)
    .map((f) => truncate(f, 28));

  // Optional Installment Info
  const downPayment = params.downPayment ? truncate(params.downPayment, 22) : null;
  const installmentYears = params.installmentYears ? `${params.installmentYears} سنوات` : null;

  // Support params.images, params.heroUrl, or params.heroImageUrl
  const rawList =
    Array.isArray(params.images) && params.images.length > 0
      ? params.images
      : params.heroUrl
      ? [params.heroUrl]
      : params.heroImageUrl
      ? [params.heroImageUrl]
      : [];
  const validImages = rawList.filter(isValidImageUrl);

  const galleryBlock = renderPhotoMosaic(validImages, agencyName);

  const rawLogo = params.logoUrl || params.logo_url;
  const validLogo = isValidImageUrl(rawLogo) ? rawLogo.trim() : null;

  const topBarNode = createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "row",
        position: "absolute",
        top: "36px",
        right: "36px",
        left: "36px",
        justifyContent: "space-between",
        alignItems: "center"
      }
    },
    [
      createVNode(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: "rgba(11, 17, 32, 0.85)",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: "40px",
            padding: "10px 24px"
          }
        },
        [
          validLogo
            ? createVNode("img", {
                src: validLogo,
                style: {
                  height: "44px",
                  maxWidth: "140px",
                  objectFit: "contain",
                  marginRight: "12px"
                }
              })
            : null,
          createRtlTextNode(agencyName, {
            fontSize: "26px",
            fontWeight: "800",
            color: "#ffffff"
          })
        ]
      ),
      code
        ? createVNode(
            "div",
            {
              style: {
                display: "flex",
                backgroundColor: "rgba(11, 17, 32, 0.9)",
                border: "1px solid rgba(255,255,255,0.25)",
                color: "#ffffff",
                padding: "8px 24px",
                borderRadius: "30px",
                fontSize: "26px",
                fontWeight: "900"
              }
            },
            `#${code}`
          )
        : null
    ]
  );

  // Price Ribbon (positioned on the right for RTL focus)
  const priceBadgeNode = createVNode(
    "div",
    {
      style: {
        display: "flex",
        position: "absolute",
        bottom: "-34px",
        right: "48px",
        backgroundColor: accent,
        color: "#ffffff",
        padding: "14px 44px",
        borderRadius: "24px",
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)"
      }
    },
    [
      createRtlTextNode(price, {
        fontSize: "44px",
        fontWeight: "900",
        color: "#ffffff"
      })
    ]
  );

  const headerContainer = createVNode(
    "div",
    {
      style: {
        display: "flex",
        position: "relative",
        width: "1080px",
        height: "820px"
      }
    },
    [galleryBlock, topBarNode, priceBadgeNode]
  );

  // Title & Location (Right-aligned for Arabic RTL)
  const titleBlock = createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        padding: "64px 48px 0 48px"
      }
    },
    [
      createRtlTextNode(
        title,
        {
          fontSize: "44px",
          fontWeight: "900",
          color: "#ffffff",
          lineHeight: "1.25"
        },
        { justifyContent: "flex-start" }
      ),
      createVNode(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "row-reverse",
            alignItems: "center",
            marginTop: "14px"
          }
        },
        [
          createVNode(
            "svg",
            {
              width: "26",
              height: "26",
              viewBox: "0 0 24 24",
              fill: accent,
              style: { marginLeft: "10px" }
            },
            [
              createVNode("path", {
                d: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"
              })
            ]
          ),
          createRtlTextNode(location, {
            fontSize: "30px",
            color: "rgba(255,255,255,0.75)",
            fontWeight: "600"
          })
        ]
      )
    ]
  );

  // Key Specifications (Area & Rooms + Optional Installment Years)
  const specItems = [
    { label: "المساحة الإجمالية", value: area },
    { label: "عدد الغرف", value: rooms }
  ];

  if (installmentYears) {
    specItems.push({ label: "فترة السداد", value: installmentYears });
  }
  if (downPayment) {
    specItems.push({ label: "المقدم", value: downPayment });
  }

  const colWidth = `${Math.floor(96 / specItems.length)}%`;

  const specsMatrix = createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "row-reverse",
        justifyContent: "space-around",
        margin: "35px 48px 0 48px",
        backgroundColor: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: "28px",
        padding: "24px 16px"
      }
    },
    specItems.map((item, idx) =>
      createVNode(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: colWidth,
            borderLeft:
              idx < specItems.length - 1
                ? "1px solid rgba(255,255,255,0.1)"
                : "none"
          }
        },
        [
          createRtlTextNode(
            item.label,
            {
              fontSize: "22px",
              color: "rgba(255,255,255,0.55)"
            },
            { marginBottom: "8px", justifyContent: "center" }
          ),
          createRtlTextNode(
            item.value,
            {
              fontSize: "34px",
              fontWeight: "900",
              color: "#ffffff"
            },
            { justifyContent: "center" }
          )
        ]
      )
    )
  );

  // Features Pill List
  const featureBadges = features.map((feat) =>
    createVNode(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "row-reverse",
          alignItems: "center",
          backgroundColor: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: "40px",
          padding: "10px 24px",
          marginLeft: "12px",
          marginBottom: "12px"
        }
      },
      [
        createVNode(
          "span",
          { style: { color: accent, marginLeft: "10px", fontSize: "24px" } },
          "•"
        ),
        createRtlTextNode(feat, {
          fontSize: "24px",
          fontWeight: "700",
          color: "#ffffff"
        })
      ]
    )
  );

  const featuresContainer =
    featureBadges.length > 0
      ? createVNode(
          "div",
          {
            style: {
              display: "flex",
              flexDirection: "row-reverse",
              flexWrap: "wrap",
              padding: "28px 48px 0 48px"
            }
          },
          featureBadges
        )
      : null;

  // Footer CTA
  const footerNode = createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "42px 48px 46px 48px",
        backgroundColor: accent,
        borderTopLeftRadius: "44px",
        borderTopRightRadius: "44px"
      }
    },
    [
      createVNode(
        "div",
        { style: { display: "flex", flexDirection: "column" } },
        [
          createRtlTextNode(agencyName, {
            fontSize: "38px",
            fontWeight: "900",
            color: "#ffffff"
          }),
          brokerPhone
            ? createVNode(
                "span",
                {
                  style: {
                    fontSize: "32px",
                    fontWeight: "800",
                    color: "rgba(255,255,255,0.95)",
                    marginTop: "6px"
                  }
                },
                brokerPhone
              )
            : null
        ]
      ),
      createVNode(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            backgroundColor: brand,
            color: "#ffffff",
            padding: "16px 28px",
            borderRadius: "20px"
          }
        },
        [
          createRtlTextNode("تواصل عبر واتساب", {
            fontSize: "26px",
            fontWeight: "800",
            color: "#ffffff"
          }),
          code
            ? createVNode(
                "span",
                {
                  style: {
                    fontSize: "20px",
                    fontWeight: "700",
                    color: "rgba(255,255,255,0.8)",
                    marginTop: "4px"
                  }
                },
                `#${code}`
              )
            : null
        ]
      )
    ]
  );

  return createVNode(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        width: "1080px",
        height: "1920px",
        backgroundColor: brand,
        fontFamily: "Cairo",
        justifyContent: "space-between"
      }
    },
    [
      createVNode(
        "div",
        {
          style: { display: "flex", flexDirection: "column", width: "1080px" }
        },
        [headerContainer, titleBlock, specsMatrix, featuresContainer]
      ),
      footerNode
    ]
  );
}

// ---------------------------------------------------------------------------
// Render to PNG
// ---------------------------------------------------------------------------
async function renderFlyerSatori(params = {}) {
  const vdom = buildSatoriVDOM(params);

  const fontsConfig = fontBuffer
    ? [{ name: "Cairo", data: fontBuffer, weight: 700, style: "normal" }]
    : [];

  const svg = await satori(vdom, {
    width: 1080,
    height: 1920,
    fonts: fontsConfig
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
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