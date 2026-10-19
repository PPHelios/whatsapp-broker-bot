// lib/flyer.js
const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Typography & Font Loader (Local disk first with CDN fallbacks)
// ---------------------------------------------------------------------------
let cairoBold = null;
let cairoRegular = null;

async function loadFonts() {
  try {
    if (!cairoBold) {
      const boldPath = path.join(__dirname, "../fonts/Cairo-Bold.ttf");
      if (fs.existsSync(boldPath)) cairoBold = fs.readFileSync(boldPath);
    }
    if (!cairoRegular) {
      const regPath = path.join(__dirname, "../fonts/Cairo-Regular.ttf");
      if (fs.existsSync(regPath)) cairoRegular = fs.readFileSync(regPath);
    }
  } catch (err) {
    console.warn("[FONT LOCAL LOAD]:", err.message);
  }

  if (!cairoBold) {
    try {
      const res = await fetch(
        "https://cdn.jsdelivr.net/gh/google/fonts/ofl/cairo/Cairo-Bold.ttf",
        {
          signal: AbortSignal.timeout(6000)
        }
      );
      if (res.ok) {
        cairoBold = Buffer.from(await res.arrayBuffer());
      }
    } catch (err) {
      console.warn("[FONT CDN FETCH FAILED - BOLD]:", err.message);
    }
  }

  if (!cairoRegular) {
    try {
      const res = await fetch(
        "https://cdn.jsdelivr.net/gh/google/fonts/ofl/cairo/Cairo-Regular.ttf",
        {
          signal: AbortSignal.timeout(6000)
        }
      );
      if (res.ok) {
        cairoRegular = Buffer.from(await res.arrayBuffer());
      }
    } catch {
      cairoRegular = cairoBold;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Image Helpers
// ---------------------------------------------------------------------------
async function toDataUri(src, { width = 1000, height = 440 } = {}) {
  if (!src) return null;
  if (typeof src === "string" && src.startsWith("data:")) return src;
  try {
    let buf;
    if (Buffer.isBuffer(src)) {
      buf = src;
    } else {
      const res = await fetch(src, { signal: AbortSignal.timeout(7000) });
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
    }
    const optimized = await sharp(buf)
      .resize({ width, height, fit: "cover", position: "center" })
      .jpeg({ quality: 82 })
      .toBuffer();
    return `data:image/jpeg;base64,${optimized.toString("base64")}`;
  } catch (err) {
    console.error("⚠️ [FLYER IMAGE FETCH FAILED]:", err.message);
    return null;
  }
}

const formatNum = (num) =>
  String(num ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function isArabicContent(text) {
  if (!text) return true;
  const arabicPattern = /[\u0600-\u06FF\u0750-\u077F]/;
  return arabicPattern.test(text);
}

// ---------------------------------------------------------------------------
// 3. Main Flyer Generation Engine
// ---------------------------------------------------------------------------
async function generateFlyerBuffer({ listing, agency = {}, images = [] }) {
  await loadFonts();

  const primaryBg = agency.primary_color || "#0B132B";
  const secondaryColor = agency.secondary_color || "#D4AF37";
  const agencyName = agency.name || "Aspire Real Estate";

  const details = listing.details || {};
  let sortedImages = [...images];

  if (Array.isArray(details.image_order) && details.image_order.length > 0) {
    const reordered = [];
    for (const idx of details.image_order) {
      if (images[idx]) reordered.push(images[idx]);
    }
    for (const img of images) {
      if (!reordered.includes(img)) reordered.push(img);
    }
    sortedImages = reordered;
  } else if (
    typeof details.hero_position === "number" &&
    details.hero_position < images.length
  ) {
    const hero = sortedImages.splice(details.hero_position, 1)[0];
    sortedImages.unshift(hero);
  }

  sortedImages = sortedImages.slice(0, 9);

  const heroUri =
    sortedImages.length > 0
      ? await toDataUri(sortedImages[0], { width: 1000, height: 460 })
      : null;

  const subImagesRaw = sortedImages.slice(1);
  const subUris = [];
  for (const rawImg of subImagesRaw) {
    const uri = await toDataUri(rawImg, { width: 494, height: 200 });
    if (uri) subUris.push(uri);
  }

  const logoDataUri = agency.logo_url
    ? await toDataUri(agency.logo_url, { width: 240, height: 60 })
    : null;

  const subRowsCount = Math.ceil(subUris.length / 2);
  const subGridHeight =
    subRowsCount > 0 ? subRowsCount * 200 + (subRowsCount - 1) * 12 : 0;
  const galleryHeight =
    (heroUri ? 460 : 0) + (subGridHeight > 0 ? subGridHeight + 14 : 0);

  const unitCode = String(listing.code || "RK-0000").toUpperCase();
  const summary = details.clean_summary || details.short_summary || "";

  // Language Detection & Localization Dictionary
  const isAr = isArabicContent(
    `${listing.title || ""} ${listing.location || ""} ${summary}`
  );

  const labels = isAr
    ? {
        currency: "جنيه",
        forSale: "للبيع",
        forRent: "للإيجار",
        readyToMove: "استلام فوري",
        area: "المساحة",
        areaUnit: "م²",
        bedrooms: "الغرف",
        roomsUnit: "غرف",
        finish: "التشطيب",
        finishDefault: "تشطيب كامل",
        type: "النوع",
        typeDefault: "سكني فاخر",
        priceLabel: "السعر المطلوب",
        codeLabel: "كود الحفظ والاستعلام",
        cash: "(كاش مطلوب)",
        installments: (yrs) => `(تقسيط ${yrs} سنوات)`,
        installmentsGeneric: "(بتسهيلات)",
        defaultTitle: "وحدة سكنية راقية",
        defaultLocation: "موقع متميز",
        defaultFeatures: ["تشطيب فاخر", "إطلالة مميزة", "استلام فوري"]
      }
    : {
        currency: "EGP",
        forSale: "FOR SALE",
        forRent: "FOR RENT",
        readyToMove: "Ready to Move",
        area: "Area",
        areaUnit: "m²",
        bedrooms: "Bedrooms",
        roomsUnit: "Beds",
        finish: "Finishing",
        finishDefault: "Fully Finished",
        type: "Type",
        typeDefault: "Luxury Residential",
        priceLabel: "Asking Price",
        codeLabel: "Property Reference Code",
        cash: "(Cash)",
        installments: (yrs) => `(${yrs} Yrs Installments)`,
        installmentsGeneric: "(Installments)",
        defaultTitle: "Luxury Property",
        defaultLocation: "Prime Location",
        defaultFeatures: ["Prime Location", "High Finishing", "Ready to Move"]
      };

  const title = listing.title || labels.defaultTitle;
  const location = listing.location || labels.defaultLocation;

  const isCash = !details.installment_years && !details.down_payment_value;
  const paymentTerm = isCash
    ? labels.cash
    : details.installment_years
    ? labels.installments(details.installment_years)
    : labels.installmentsGeneric;

  let rawPriceNumber = "";
  if (listing.price_value) {
    rawPriceNumber = formatNum(listing.price_value);
  } else if (listing.price_display) {
    rawPriceNumber = listing.price_display.replace(/[^\d,.]/g, "");
  }

  const features =
    Array.isArray(details.features) && details.features.length > 0
      ? details.features.slice(0, 5)
      : labels.defaultFeatures;

  const containerFlexDirection = isAr ? "row-reverse" : "row";
  const textAlign = isAr ? "right" : "left";
  const flexAlign = isAr ? "flex-end" : "flex-start";

  const summaryEstHeight = summary ? 110 : 0;
  const dynamicTotalHeight =
    80 +
    70 +
    (galleryHeight > 0 ? galleryHeight + 24 : 0) +
    150 +
    120 +
    summaryEstHeight +
    50 +
    110;

  const vnode = {
    type: "div",
    props: {
      style: {
        width: "1080px",
        height: `${dynamicTotalHeight}px`,
        display: "flex",
        flexDirection: "column",
        backgroundColor: primaryBg,
        fontFamily: "Cairo",
        direction: "ltr",
        padding: "40px",
        boxSizing: "border-box",
        justifyContent: "space-between"
      },
      children: [
        // -------------------------------------------------------------
        // HEADER: Unit Code & Agency Logo
        // -------------------------------------------------------------
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "20px"
            },
            children: [
              // Unit Code Capsule
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    backgroundColor: "rgba(255, 255, 255, 0.08)",
                    border: `1px solid ${secondaryColor}`,
                    padding: "8px 24px",
                    borderRadius: "40px"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: secondaryColor,
                          fontSize: "22px",
                          fontWeight: "bold",
                          letterSpacing: "1px",
                          display: "flex"
                        },
                        children: `#${unitCode}`
                      }
                    }
                  ]
                }
              },
              // Agency Branding Capsule
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    backgroundColor: "rgba(255, 255, 255, 0.95)",
                    padding: "8px 22px",
                    borderRadius: "40px",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.25)"
                  },
                  children: [
                    logoDataUri
                      ? {
                          type: "img",
                          props: {
                            src: logoDataUri,
                            style: {
                              maxHeight: "44px",
                              maxWidth: "160px",
                              objectFit: "contain",
                              marginRight: "10px"
                            }
                          }
                        }
                      : null,
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#0F172A",
                          fontSize: "22px",
                          fontWeight: "bold",
                          display: "flex"
                        },
                        children: agencyName
                      }
                    }
                  ].filter(Boolean)
                }
              }
            ]
          }
        },

        // -------------------------------------------------------------
        // PHOTO GALLERY
        // -------------------------------------------------------------
        galleryHeight > 0
          ? {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "14px",
                  marginBottom: "22px"
                },
                children: [
                  heroUri
                    ? {
                        type: "img",
                        props: {
                          src: heroUri,
                          style: {
                            width: "1000px",
                            height: "460px",
                            borderRadius: "16px",
                            objectFit: "cover",
                            boxShadow: "0 8px 24px rgba(0,0,0,0.4)"
                          }
                        }
                      }
                    : null,
                  subUris.length > 0
                    ? {
                        type: "div",
                        props: {
                          style: {
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "12px",
                            width: "1000px"
                          },
                          children: subUris.map((uri) => ({
                            type: "img",
                            props: {
                              src: uri,
                              style: {
                                width:
                                  subUris.length === 1 ? "1000px" : "494px",
                                height: "200px",
                                borderRadius: "12px",
                                objectFit: "cover"
                              }
                            }
                          }))
                        }
                      }
                    : null
                ].filter(Boolean)
              }
            }
          : null,

        // -------------------------------------------------------------
        // TITLE, BADGES & LOCATION
        // -------------------------------------------------------------
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              alignItems: flexAlign,
              marginBottom: "16px",
              width: "100%"
            },
            children: [
              // Badges
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: containerFlexDirection,
                    gap: "10px",
                    marginBottom: "10px"
                  },
                  children: [
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          backgroundColor: secondaryColor,
                          borderRadius: "6px",
                          padding: "3px 14px",
                          color: "#0B132B",
                          fontSize: "18px",
                          fontWeight: "bold"
                        },
                        children:
                          listing.listing_type === "rent"
                            ? labels.forRent
                            : labels.forSale
                      }
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          backgroundColor: "rgba(255, 255, 255, 0.08)",
                          borderRadius: "6px",
                          padding: "3px 14px",
                          color: "#E2E8F0",
                          fontSize: "18px"
                        },
                        children: labels.readyToMove
                      }
                    }
                  ]
                }
              },
              // Title
              {
                type: "div",
                props: {
                  style: {
                    color: "#FFFFFF",
                    fontSize: "32px",
                    fontWeight: "bold",
                    lineHeight: "1.35",
                    textAlign: textAlign,
                    display: "flex",
                    justifyContent: flexAlign,
                    width: "100%"
                  },
                  children: title
                }
              },
              // Location
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: flexAlign,
                    flexDirection: isAr ? "row" : "row-reverse",
                    color: "#94A3B8",
                    fontSize: "20px",
                    marginTop: "6px",
                    width: "100%"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: { display: "flex" },
                        children: location
                      }
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          [isAr ? "marginLeft" : "marginRight"]: "8px",
                          display: "flex"
                        },
                        children: "📍"
                      }
                    }
                  ]
                }
              }
            ]
          }
        },

        // -------------------------------------------------------------
        // 4-COLUMN METRICS BAR
        // -------------------------------------------------------------
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: containerFlexDirection,
              backgroundColor: "rgba(255, 255, 255, 0.04)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderRadius: "16px",
              padding: "16px 20px",
              justifyContent: "space-around",
              alignItems: "center",
              marginBottom: "16px"
            },
            children: [
              // Column 1: Area
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#94A3B8",
                          fontSize: "17px",
                          display: "flex"
                        },
                        children: labels.area
                      }
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#FFFFFF",
                          fontSize: "26px",
                          fontWeight: "bold",
                          display: "flex"
                        },
                        children: listing.area_value
                          ? `${listing.area_value} ${labels.areaUnit}`
                          : "-"
                      }
                    }
                  ]
                }
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: "1px",
                    height: "36px",
                    backgroundColor: "rgba(255,255,255,0.1)"
                  }
                }
              },
              // Column 2: Bedrooms
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#94A3B8",
                          fontSize: "17px",
                          display: "flex"
                        },
                        children: labels.bedrooms
                      }
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#FFFFFF",
                          fontSize: "26px",
                          fontWeight: "bold",
                          display: "flex"
                        },
                        children: listing.bedrooms
                          ? `${listing.bedrooms} ${labels.roomsUnit}`
                          : "-"
                      }
                    }
                  ]
                }
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: "1px",
                    height: "36px",
                    backgroundColor: "rgba(255,255,255,0.1)"
                  }
                }
              },
              // Column 3: Finishing
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#94A3B8",
                          fontSize: "17px",
                          display: "flex"
                        },
                        children: labels.finish
                      }
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#FFFFFF",
                          fontSize: "24px",
                          fontWeight: "bold",
                          display: "flex"
                        },
                        children: labels.finishDefault
                      }
                    }
                  ]
                }
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    width: "1px",
                    height: "36px",
                    backgroundColor: "rgba(255,255,255,0.1)"
                  }
                }
              },
              // Column 4: Type
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#94A3B8",
                          fontSize: "17px",
                          display: "flex"
                        },
                        children: labels.type
                      }
                    },
                    {
                      type: "span",
                      props: {
                        style: {
                          color: secondaryColor,
                          fontSize: "24px",
                          fontWeight: "bold",
                          display: "flex"
                        },
                        children: labels.typeDefault
                      }
                    }
                  ]
                }
              }
            ]
          }
        },

        // -------------------------------------------------------------
        // CLEAN SUMMARY BOX
        // -------------------------------------------------------------
        summary
          ? {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  backgroundColor: "rgba(255, 255, 255, 0.03)",
                  [isAr
                    ? "borderRight"
                    : "borderLeft"]: `4px solid ${secondaryColor}`,
                  padding: "16px 20px",
                  borderRadius: "8px",
                  marginBottom: "16px",
                  justifyContent: flexAlign
                },
                children: [
                  {
                    type: "span",
                    props: {
                      style: {
                        color: "#CBD5E1",
                        fontSize: "19px",
                        lineHeight: "1.6",
                        display: "flex",
                        textAlign: textAlign
                      },
                      children: summary
                    }
                  }
                ]
              }
            }
          : null,

        // -------------------------------------------------------------
        // FEATURE CHIPS
        // -------------------------------------------------------------
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap",
              flexDirection: containerFlexDirection,
              gap: "8px",
              marginBottom: "20px"
            },
            children: features.map((f) => ({
              type: "div",
              props: {
                style: {
                  display: "flex",
                  backgroundColor: "rgba(255, 255, 255, 0.06)",
                  border: "1px solid rgba(255, 255, 255, 0.12)",
                  borderRadius: "24px",
                  padding: "6px 18px",
                  color: "#E2E8F0",
                  fontSize: "18px"
                },
                children: f
              }
            }))
          }
        },

        // -------------------------------------------------------------
        // FOOTER: Pricing & Verification Code
        // -------------------------------------------------------------
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid rgba(255, 255, 255, 0.12)",
              paddingTop: "20px"
            },
            children: [
              // Price
              {
                type: "div",
                props: {
                  style: { display: "flex", flexDirection: "column" },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#94A3B8",
                          fontSize: "16px",
                          marginBottom: "4px",
                          display: "flex"
                        },
                        children: labels.priceLabel
                      }
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          alignItems: "baseline",
                          gap: "8px"
                        },
                        children: [
                          {
                            type: "span",
                            props: {
                              style: {
                                color: secondaryColor,
                                fontSize: "40px",
                                fontWeight: "bold",
                                display: "flex"
                              },
                              children:
                                rawPriceNumber ||
                                (isAr ? "عند الطلب" : "Upon Request")
                            }
                          },
                          {
                            type: "span",
                            props: {
                              style: {
                                color: "#FFFFFF",
                                fontSize: "22px",
                                fontWeight: "bold",
                                display: "flex"
                              },
                              children: labels.currency
                            }
                          },
                          {
                            type: "span",
                            props: {
                              style: {
                                color: "#94A3B8",
                                fontSize: "18px",
                                display: "flex"
                              },
                              children: paymentTerm
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              },
              // Unit Code
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-end"
                  },
                  children: [
                    {
                      type: "span",
                      props: {
                        style: {
                          color: "#94A3B8",
                          fontSize: "16px",
                          marginBottom: "4px",
                          display: "flex"
                        },
                        children: labels.codeLabel
                      }
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          backgroundColor: "rgba(255, 255, 255, 0.08)",
                          borderRadius: "8px",
                          padding: "6px 18px",
                          border: "1px solid rgba(255, 255, 255, 0.15)"
                        },
                        children: [
                          {
                            type: "span",
                            props: {
                              style: {
                                color: "#FFFFFF",
                                fontSize: "26px",
                                fontWeight: "bold",
                                display: "flex"
                              },
                              children: `#${unitCode}`
                            }
                          }
                        ]
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      ].filter(Boolean)
    }
  };

  const svg = await satori(vnode, {
    width: 1080,
    height: dynamicTotalHeight,
    fonts: [
      {
        name: "Cairo",
        data: cairoBold,
        weight: 700,
        style: "normal"
      },
      {
        name: "Cairo",
        data: cairoRegular || cairoBold,
        weight: 500,
        style: "normal"
      }
    ]
  });

  return sharp(Buffer.from(svg))
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

module.exports = {
  generateFlyerBuffer,
  renderFlyerJpeg: generateFlyerBuffer,
  renderFlyerPng: generateFlyerBuffer,
  renderFlyerSatori: generateFlyerBuffer
};
