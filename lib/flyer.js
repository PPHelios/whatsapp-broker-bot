const satori = require("satori").default || require("satori");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const MAX_FLYER_IMAGES = 9;
let cairoBold = null;
let cairoRegular = null;

async function loadFonts() {
  try {
    if (!cairoBold) {
      const p1 = path.join(__dirname, "../fonts/Cairo-Bold.ttf");
      const p2 = path.join(process.cwd(), "fonts/Cairo-Bold.ttf");
      if (fs.existsSync(p1)) cairoBold = fs.readFileSync(p1);
      else if (fs.existsSync(p2)) cairoBold = fs.readFileSync(p2);
    }
    if (!cairoRegular) {
      const p1 = path.join(__dirname, "../fonts/Cairo-Regular.ttf");
      const p2 = path.join(process.cwd(), "fonts/Cairo-Regular.ttf");
      if (fs.existsSync(p1)) cairoRegular = fs.readFileSync(p1);
      else if (fs.existsSync(p2)) cairoRegular = fs.readFileSync(p2);
    }
  } catch (err) {
    console.warn("[FONT LOCAL LOAD]:", err.message);
  }

  if (!cairoBold) {
    try {
      const res = await fetch(
        "https://cdn.jsdelivr.net/gh/google/fonts/ofl/cairo/Cairo-Bold.ttf",
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) cairoBold = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.warn("[FONT CDN BOLD FAILED]:", err.message);
    }
  }
  if (!cairoRegular) {
    try {
      const res = await fetch(
        "https://cdn.jsdelivr.net/gh/google/fonts/ofl/cairo/Cairo-Regular.ttf",
        { signal: AbortSignal.timeout(6000) }
      );
      if (res.ok) cairoRegular = Buffer.from(await res.arrayBuffer());
    } catch {
      cairoRegular = cairoBold;
    }
  }
}

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
      .resize({
        width,
        height,
        fit: "cover",
        position: "center",
        withoutEnlargement: true
      })
      .jpeg({ quality: 82, mozjpeg: true })
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
  return /[\u0600-\u06FF\u0750-\u077F]/.test(text);
}

async function generateFlyerBuffer({
  listing,
  agency = {},
  images = [],
  lang
}) {
  await loadFonts();
  if (!cairoBold)
    throw new Error(
      "Critical: Cairo font buffer is missing for Satori rendering."
    );

  const primaryBg = agency.primary_color || "#0B132B";
  const secondaryColor = agency.secondary_color || "#D4AF37";
  const agencyName = agency.name || "Real Estate Agency";
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
  }
  sortedImages = sortedImages.slice(0, MAX_FLYER_IMAGES);

  const heroUri =
    sortedImages.length > 0
      ? await toDataUri(sortedImages[0], { width: 1000, height: 460 })
      : null;
  const subImagesRaw = sortedImages.slice(1);
  const subUris = (
    await Promise.all(
      subImagesRaw.map((rawImg) =>
        toDataUri(rawImg, { width: 494, height: 200 })
      )
    )
  ).filter(Boolean);
  const logoDataUri = agency.logo_url
    ? await toDataUri(agency.logo_url, { width: 240, height: 60 })
    : null;

  const subRows = [];
  for (let i = 0; i < subUris.length; i += 2) {
    subRows.push(subUris.slice(i, i + 2));
  }

  let isAr = true;
  if (lang === "en") isAr = false;
  else if (lang === "ar") isAr = true;
  else
    isAr = isArabicContent(
      `${listing.title || ""} ${listing.location || ""} ${
        details.clean_summary || ""
      }`
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
        typeArMap: {
          apartment: "شقة",
          villa: "فيلا",
          townhouse: "تاون هاوس",
          twinhouse: "توين هاوس",
          duplex: "دوبلكس",
          penthouse: "بنتهاوس",
          studio: "استوديو",
          chalet: "شاليه",
          office: "مكتب",
          commercial: "تجاري"
        },
        typeDefault: "وحدة سكنية",
        priceLabel: "السعر المطلوب",
        codeLabel: "كود الوحدة للبحث والاستعلام",
        cash: "(كاش)",
        installments: (yrs) => `(تقسيط ${yrs} سنوات)`,
        installmentsGeneric: "(تسهيلات سداد)",
        defaultTitle: "وحدة سكنية راقية",
        defaultLocation: "موقع استراتيجي متميز",
        defaultFeatures: [
          "تشطيب فاخر",
          "موقع استراتيجي",
          "إطلالة مميزة",
          "استلام فوري"
        ]
      }
    : {
        currency: "EGP",
        forSale: "FOR SALE",
        forRent: "FOR RENT",
        readyToMove: "Ready to Move",
        area: "Area",
        areaUnit: "sqm",
        bedrooms: "Bedrooms",
        roomsUnit: "Beds",
        finish: "Finishing",
        finishDefault: "Fully Finished",
        type: "Type",
        typeDefault: String(listing.property_type || "Property").toUpperCase(),
        priceLabel: "Asking Price",
        codeLabel: "Reference Code",
        cash: "(Cash)",
        installments: (yrs) => `(${yrs} Yrs Installments)`,
        installmentsGeneric: "(Payment Plans)",
        defaultTitle: "Prime Residential Property",
        defaultLocation: "Prime Location",
        defaultFeatures: [
          "Prime Location",
          "High End Finishing",
          "Great View",
          "Ready to Move"
        ]
      };

  const unitCode = String(listing.code || "RK-0000").toUpperCase();
  const title = listing.title || labels.defaultTitle;
  const location = listing.location || labels.defaultLocation;
  const summary = details.clean_summary || details.short_summary || "";
  const propTypeKey = String(listing.property_type || "").toLowerCase();
  const displayPropType = isAr
    ? labels.typeArMap[propTypeKey] || listing.property_type || "وحدة سكنية"
    : listing.property_type || "Property";

  const isCash = !details.installment_years && !details.down_payment_value;
  const paymentTerm = isCash
    ? labels.cash
    : details.installment_years
    ? labels.installments(details.installment_years)
    : labels.installmentsGeneric;

  let rawPriceNumber = "";
  if (listing.price_value) rawPriceNumber = formatNum(listing.price_value);
  else if (listing.price_display)
    rawPriceNumber = listing.price_display.replace(/[^\d,.]/g, "");

  const features =
    Array.isArray(details.features) && details.features.length > 0
      ? details.features.slice(0, 5)
      : labels.defaultFeatures;

  const containerFlexDirection = isAr ? "row-reverse" : "row";
  const textAlign = isAr ? "right" : "left";
  const flexAlign = isAr ? "flex-end" : "flex-start";

  const subGridHeight =
    subRows.length > 0 ? subRows.length * 200 + (subRows.length - 1) * 12 : 0;
  const galleryHeight =
    (heroUri ? 460 : 0) + (subGridHeight > 0 ? subGridHeight + 12 : 0);
  const galleryBlockHeight = galleryHeight > 0 ? galleryHeight + 20 : 0;

  const titleLines = title.split("\n");
  const titleLineCount = titleLines.reduce(
    (acc, l) => acc + Math.max(1, Math.ceil(l.length / (isAr ? 36 : 48))),
    0
  );
  const titleBlockHeight = 32 + 10 + titleLineCount * 44 + 6 + 30 + 18;
  const metricsBarHeight = 86 + 18;

  let summaryBlockHeight = 0;
  if (summary) {
    const sumLines = summary.split("\n");
    const summaryLineCount = sumLines.reduce(
      (acc, l) => acc + Math.max(1, Math.ceil(l.length / (isAr ? 60 : 75))),
      0
    );
    summaryBlockHeight = Math.max(60, summaryLineCount * 30 + 32) + 18;
  }

  const totalFeatureChars = features.join("").length;
  const featureRowsCount =
    totalFeatureChars > 75 ? (totalFeatureChars > 150 ? 3 : 2) : 1;
  const featuresBlockHeight =
    featureRowsCount * 36 + (featureRowsCount - 1) * 8 + 20;
  const dynamicTotalHeight = Math.round(
    80 +
      68 +
      galleryBlockHeight +
      titleBlockHeight +
      metricsBarHeight +
      summaryBlockHeight +
      featuresBlockHeight +
      96
  );

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
        justifyContent: "flex-start"
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              marginBottom: "20px"
            },
            children: [
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
        galleryHeight > 0
          ? {
              type: "div",
              props: {
                style: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                  width: "100%",
                  marginBottom: "20px"
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
                  ...subRows.map((row) => ({
                    type: "div",
                    props: {
                      style: {
                        display: "flex",
                        flexDirection: containerFlexDirection,
                        justifyContent: "space-between",
                        width: "1000px"
                      },
                      children: row.map((uri) => ({
                        type: "img",
                        props: {
                          src: uri,
                          style: {
                            width: row.length === 1 ? "1000px" : "494px",
                            height: "200px",
                            borderRadius: "12px",
                            objectFit: "cover"
                          }
                        }
                      }))
                    }
                  }))
                ].filter(Boolean)
              }
            }
          : null,
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              alignItems: flexAlign,
              width: "100%",
              marginBottom: "18px"
            },
            children: [
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
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: flexAlign,
                    flexDirection: containerFlexDirection,
                    color: "#94A3B8",
                    fontSize: "20px",
                    marginTop: "6px",
                    width: "100%",
                    gap: "8px"
                  },
                  children: [
                    {
                      type: "span",
                      props: { style: { display: "flex" }, children: "📍" }
                    },
                    {
                      type: "span",
                      props: { style: { display: "flex" }, children: location }
                    }
                  ]
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
              flexDirection: containerFlexDirection,
              backgroundColor: "rgba(255, 255, 255, 0.04)",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderRadius: "16px",
              padding: "16px 20px",
              justifyContent: "space-around",
              alignItems: "center",
              width: "100%",
              marginBottom: "18px"
            },
            children: [
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
                        children: displayPropType
                      }
                    }
                  ]
                }
              }
            ]
          }
        },
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
                  marginBottom: "18px",
                  width: "100%",
                  boxSizing: "border-box",
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
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexWrap: "wrap",
              flexDirection: containerFlexDirection,
              gap: "8px",
              width: "100%",
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
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: containerFlexDirection,
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid rgba(255, 255, 255, 0.12)",
              paddingTop: "20px",
              width: "100%"
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: flexAlign
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
                        children: labels.priceLabel
                      }
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          flexDirection: containerFlexDirection,
                          alignItems: "baseline",
                          gap: "8px"
                        },
                        children: [
                          {
                            type: "span",
                            props: {
                              style: {
                                color: secondaryColor,
                                fontSize: "38px",
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
                                fontSize: "20px",
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
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isAr ? "flex-start" : "flex-end"
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
                                fontSize: "24px",
                                fontWeight: "bold",
                                display: "flex",
                                letterSpacing: "1px"
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
      { name: "Cairo", data: cairoBold, weight: 700, style: "normal" },
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
