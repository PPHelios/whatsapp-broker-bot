// lib/excel.js — Hardened Financial Spreadsheet Generator & Ingestion Reports
"use strict";

const ExcelJS = require("exceljs");
const { formatDelivery } = require("../domain/delivery");
const {
  calculatePlanSummary,
  generateDetailedSchedule,
  maintenanceTerms,
  planDeliveryMonths
} = require("./financials");

/** A plan with the listing's maintenance terms and delivery date filled in where the plan is silent. */
function withListingTerms(plan, listing) {
  const m = maintenanceTerms(plan, listing);
  return {
    ...plan,
    maintenance_pct: m.pct,
    maintenance_due: m.due,
    delivery_after_months: plan.delivery_after_months ?? planDeliveryMonths(listing)
  };
}

/* ====================================================================== */
/* 0. Security Sanitization (Formula / CSV Injection Defense)             */
/* ====================================================================== */
/**
 * Prevents remote code execution and formula injection in Microsoft Excel.
 * Any string beginning with =, +, -, @, \t, or \r is escaped with a single quote.
 */
function sanitizeCellValue(val) {
  if (val === null || val === undefined) return "-";
  if (typeof val === "number" || typeof val === "boolean") return val;
  const str = String(val).trim();
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/* ====================================================================== */
/* Design Palette & Reusable Cell Styles                                  */
/* ====================================================================== */
const STYLES = {
  fontFamily: "Calibri",
  headerFill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0F172A" } // Dark Slate
  },
  headerFont: {
    name: "Calibri",
    size: 11,
    bold: true,
    color: { argb: "FFFFFFFF" }
  },
  bannerFill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF1F5F9" } // Light Slate
  },
  zebraFill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF8FAFC" }
  },
  maintenanceFill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFEF3C7" } // Subtle Amber Highlight
  },
  maintenanceFont: {
    name: "Calibri",
    size: 10,
    bold: true,
    color: { argb: "FF92400E" }
  },
  errorHeaderFill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF991B1B" } // Dark Crimson
  },
  errorFill: {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFEE2E2" } // Subtle Red
  },
  errorFont: {
    name: "Calibri",
    size: 10,
    color: { argb: "FF991B1B" }
  },
  borderThin: {
    top: { style: "thin", color: { argb: "FFE2E8F0" } },
    bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
    left: { style: "thin", color: { argb: "FFE2E8F0" } },
    right: { style: "thin", color: { argb: "FFE2E8F0" } }
  },
  borderHeader: {
    top: { style: "thin", color: { argb: "FF0F172A" } },
    bottom: { style: "medium", color: { argb: "FF0F172A" } },
    left: { style: "thin", color: { argb: "FF334155" } },
    right: { style: "thin", color: { argb: "FF334155" } }
  },
  borderTotal: {
    top: { style: "thin", color: { argb: "FF0F172A" } },
    bottom: { style: "double", color: { argb: "FF0F172A" } }
  }
};

/**
 * Automatically adjusts column widths based on cell text content length.
 */
function autoFitColumns(sheet, minWidth = 12, padding = 4) {
  sheet.columns.forEach((col) => {
    let maxLength = minWidth;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const valStr = cell.value ? String(cell.value) : "";
      if (valStr.length > maxLength && !valStr.includes("\n")) {
        maxLength = Math.min(valStr.length, 45);
      }
    });
    col.width = maxLength + padding;
  });
}

/* ====================================================================== */
/* 1. Full Agency Inventory Export (`excel` Command)                      */
/* ====================================================================== */

async function buildAgencyInventoryWorkbook({
  listings = [],
  agency = {},
  broker = {},
  lang = "en"
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = agency.name || broker.name || "WehdatHub";
  workbook.lastModifiedBy = broker.name || "Agent";
  workbook.created = new Date();

  // Locked strictly to English LTR
  const sheet = workbook.addWorksheet("Agency Inventory", {
    views: [{ state: "frozen", ySplit: 5, rightToLeft: false }]
  });

  // Top Branding Banner (Row 1)
  sheet.mergeCells("A1:T1");
  const bannerCell = sheet.getCell("A1");
  bannerCell.value = `${sanitizeCellValue(
    agency.name || "Aqar Real Estate"
  )} | Master Agency Inventory Ledger`;
  bannerCell.font = {
    name: "Calibri",
    size: 14,
    bold: true,
    color: { argb: "FF0F172A" }
  };
  bannerCell.alignment = { horizontal: "left", vertical: "middle" };
  bannerCell.fill = STYLES.bannerFill;
  sheet.getRow(1).height = 32;

  // Sub-Banner Info (Row 2) - Uses correct broker phone schema
  sheet.mergeCells("A2:T2");
  const subBanner = sheet.getCell("A2");
  const brokerPhone =
    broker.contact_phone ||
    broker.phone_number ||
    broker.phone_normalized ||
    "";
  subBanner.value = `Exported by: ${sanitizeCellValue(
    broker.name || "Broker"
  )} (${sanitizeCellValue(
    brokerPhone
  )}) | Date: ${new Date().toLocaleDateString("en-GB")} | Total Active Units: ${
    listings.length
  }`;
  subBanner.font = {
    name: "Calibri",
    size: 10,
    italic: true,
    color: { argb: "FF475569" }
  };
  subBanner.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getRow(2).height = 20;

  sheet.addRow([]); // Blank spacer (Row 3)
  sheet.getRow(3).height = 8;

  // Standardized Headers (Row 4)
  const headers = [
    "Code",
    "Title",
    "Compound / Project",
    "Property Type",
    "Purpose",
    "Price",
    "Upfront Cash",
    "Quarterly Check",
    "Tenure (Years)",
    "Area (sqm)",
    "Bedrooms",
    "Bathrooms",
    "Orientation",
    "Delivery",
    "Finishing",
    "Amenities",
    "District / City",
    "Status",
    "Description (Original AR)",
    "Summary (English)"
  ];

  const headerRow = sheet.addRow(headers);
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.fill = STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = STYLES.borderHeader;
  });

  const TYPE_MAP = {
    apartment: "Apartment",
    villa: "Standalone Villa",
    townhouse: "Townhouse",
    twinhouse: "Twinhouse",
    duplex: "Duplex",
    penthouse: "Penthouse",
    chalet: "Chalet",
    studio: "Studio",
    office: "Office",
    commercial: "Commercial",
    land: "Land"
  };

  const STATUS_MAP = {
    active: "Active",
    sold: "Sold",
    archived: "Archived"
  };

  listings.forEach((l, idx) => {
    const det = l.details || {};
    const typeKey = String(l.property_type || "apartment").toLowerCase();
    const statusKey = String(l.status || "active").toLowerCase();
    const purpose = l.listing_type === "rent" ? "Rent" : "Sale";

    const compoundDisplay =
      det.compound_en || l.compound_en || l.compound || "-";
    const deliveryDisplay = det.ready_to_move
      ? "Immediate (Ready)"
      : det.delivery_date || l.delivery_date || "-";
    const upfrontVal =
      det.total_upfront_cash ||
      det.down_payment_value ||
      l.down_payment_value ||
      0;
    const featuresStr =
      Array.isArray(det.features_en) && det.features_en.length
        ? det.features_en.join(" • ")
        : Array.isArray(l.features) && l.features.length
        ? l.features.join(" • ")
        : "-";

    const row = sheet.addRow([
      sanitizeCellValue(String(l.code || "").toUpperCase()),
      sanitizeCellValue(det.title_en || l.title || "-"),
      sanitizeCellValue(compoundDisplay),
      sanitizeCellValue(TYPE_MAP[typeKey] || l.property_type || "-"),
      sanitizeCellValue(purpose),
      Number(l.price_value) || 0,
      Number(upfrontVal) || 0,
      Number(
        l.installment_value || det.installment_amount || det.installment_value
      ) || 0,
      Number(l.installment_years || det.installment_years) || 0,
      Number(l.area_value) || 0,
      l.bedrooms !== null && l.bedrooms !== undefined
        ? Number(l.bedrooms)
        : typeKey === "studio"
        ? 0
        : "-",
      det.bathrooms || l.bathrooms ? Number(det.bathrooms || l.bathrooms) : "-",
      sanitizeCellValue(det.orientation_en || det.orientation || "-"),
      sanitizeCellValue(deliveryDisplay),
      sanitizeCellValue(det.finishing_en || det.finishing || "-"),
      sanitizeCellValue(featuresStr),
      sanitizeCellValue(l.district || l.city || l.location || "-"),
      sanitizeCellValue(STATUS_MAP[statusKey] || l.status || "Active"),
      sanitizeCellValue(det.clean_summary || l.raw_text || "-"),
      sanitizeCellValue(det.summary_en || "-")
    ]);

    row.height = 22;
    const isZebra = idx % 2 === 1;

    row.eachCell((cell, colNumber) => {
      cell.border = STYLES.borderThin;
      cell.font = { name: "Calibri", size: 10 };
      if (isZebra) cell.fill = STYLES.zebraFill;

      // Numeric formatting
      if (colNumber === 6 || colNumber === 7 || colNumber === 8) {
        if (typeof cell.value === "number") cell.numFmt = "#,##0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
      } else if (
        colNumber === 9 ||
        colNumber === 10 ||
        colNumber === 11 ||
        colNumber === 12
      ) {
        if (typeof cell.value === "number") cell.numFmt = "#,##0";
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else if (colNumber === 19) {
        // XLS-04: the sheet stays LTR; the Arabic description reads right to left.
        cell.alignment = { horizontal: "right", vertical: "middle", readingOrder: "rtl" };
      } else {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      }
    });
  });

  // Enable Auto-Filter on data range
  sheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4 + listings.length, column: headers.length }
  };

  autoFitColumns(sheet, 13, 3);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/* ====================================================================== */
/* 2. Broker-Branded Payment Matrix & Schedules (Multi-Plan)              */
/* ====================================================================== */

async function buildMultiPlanWorkbook({
  listing,
  plans = [],
  agency = {},
  broker = {},
  lang = "en"
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = agency.name || broker.name || "WehdatHub";
  workbook.lastModifiedBy = broker.name || "Real Estate Consultant";
  workbook.created = new Date();

  const basePrice = Number(listing.price_value || listing.total_price || 0);
  const brokerPhone =
    broker.contact_phone ||
    broker.phone_number ||
    broker.phone_normalized ||
    "";

  /* ------------------------------------------------------------------ */
  /* TAB 1: Executive Plan Comparison Matrix (English LTR)              */
  /* ------------------------------------------------------------------ */
  const compSheet = workbook.addWorksheet("Payment Plans Overview", {
    views: [{ rightToLeft: false }]
  });

  // Top Banner
  compSheet.mergeCells("A1:H1");
  const compBanner = compSheet.getCell("A1");
  compBanner.value = `${sanitizeCellValue(
    agency.name || "Aqar Prime"
  )} | Financial Proposals & Payment Plans`;
  compBanner.font = {
    name: "Calibri",
    size: 14,
    bold: true,
    color: { argb: "FF0F172A" }
  };
  compBanner.alignment = { horizontal: "left", vertical: "middle" };
  compBanner.fill = STYLES.bannerFill;
  compSheet.getRow(1).height = 32;

  compSheet.mergeCells("A2:H2");
  const agentBar = compSheet.getCell("A2");
  agentBar.value = `Consultant: ${sanitizeCellValue(
    broker.name || "Agent"
  )} | WhatsApp / Direct: ${sanitizeCellValue(
    brokerPhone
  )} | Date: ${new Date().toLocaleDateString("en-GB")}`;
  agentBar.font = {
    name: "Calibri",
    size: 10,
    italic: true,
    color: { argb: "FF334155" }
  };
  agentBar.alignment = { horizontal: "left", vertical: "middle" };
  compSheet.getRow(2).height = 20;

  // Unit Summary Strip (Row 3)
  compSheet.mergeCells("A3:H3");
  const unitBar = compSheet.getCell("A3");
  // F10: nothing invented — unknown compound, area or delivery is left out.
  const compoundName =
    listing.details?.compound_en || listing.compound_en || listing.compound || "";
  const unitTitle =
    listing.details?.title_en ||
    [compoundName, listing.area_value ? `(${listing.area_value} sqm)` : ""].filter(Boolean).join(" ") ||
    String(listing.code || "");
  const delivery = formatDelivery(listing, "en", { icon: false });
  unitBar.value = `🏢 ${sanitizeCellValue(
    unitTitle
  )} | Base Price: ${basePrice.toLocaleString(
    "en-US"
  )} EGP${delivery ? ` | ${sanitizeCellValue(delivery)}` : ""}`;
  unitBar.font = {
    name: "Calibri",
    size: 11,
    bold: true,
    color: { argb: "FF0F172A" }
  };
  unitBar.alignment = { horizontal: "left", vertical: "middle" };
  compSheet.getRow(3).height = 22;

  compSheet.addRow([]); // Blank spacer (Row 4)

  // Comparison Table Headers (Row 5)
  const compHeaders = [
    "Payment Plan",
    "Term (Years)",
    "Discount %",
    "Net Price (EGP)",
    "Down Payment (EGP)",
    "Installment",
    "Maintenance",
    "Total Financial Outflow"
  ];

  const compHeaderRow = compSheet.addRow(compHeaders);
  compHeaderRow.height = 26;
  compHeaderRow.eachCell((cell) => {
    cell.fill = STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = STYLES.borderHeader;
  });

  plans.forEach((rawPlan, pIdx) => {
    const summary = calculatePlanSummary(basePrice, withListingTerms(rawPlan, listing));
    const row = compSheet.addRow([
      sanitizeCellValue(summary.name),
      summary.years,
      `${summary.discount_pct}%`,
      summary.effective_price,
      summary.down_payment,
      summary.installment_amount,
      summary.total_maintenance,
      summary.gross_total
    ]);

    row.height = 22;
    const isZebra = pIdx % 2 === 1;

    row.eachCell((cell, colNumber) => {
      cell.border = STYLES.borderThin;
      cell.font = { name: "Calibri", size: 10 };
      if (isZebra) cell.fill = STYLES.zebraFill;

      if (colNumber >= 4) {
        cell.numFmt = "#,##0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
    });
  });

  compSheet.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5 + plans.length, column: compHeaders.length }
  };

  autoFitColumns(compSheet, 15, 4);

  /* ------------------------------------------------------------------ */
  /* TABS 2..N: Detailed Chronological Timeline for Each Plan           */
  /* ------------------------------------------------------------------ */
  plans.forEach((rawPlan) => {
    const { summary, rows } = generateDetailedSchedule(basePrice, withListingTerms(rawPlan, listing));
    const tabName = `${summary.years} Years Plan`.slice(0, 31);

    const schedSheet = workbook.addWorksheet(tabName, {
      views: [{ state: "frozen", ySplit: 3, rightToLeft: false }]
    });

    // Plan Title Banner (Row 1)
    schedSheet.mergeCells("A1:G1");
    const schedBanner = schedSheet.getCell("A1");
    schedBanner.value = `${sanitizeCellValue(
      summary.name
    )} | Net Contract: ${summary.effective_price.toLocaleString(
      "en-US"
    )} EGP | Consultant: ${sanitizeCellValue(
      broker.name || "Agent"
    )} (${sanitizeCellValue(brokerPhone)})`;
    schedBanner.font = {
      name: "Calibri",
      size: 12,
      bold: true,
      color: { argb: "FF0F172A" }
    };
    schedBanner.alignment = { horizontal: "left", vertical: "middle" };
    schedBanner.fill = STYLES.bannerFill;
    schedSheet.getRow(1).height = 28;

    schedSheet.addRow([]); // Blank spacer (Row 2)

    // Schedule Table Headers (Row 3)
    const schedHeaders = [
      "No.",
      "Due Date",
      "Milestone / Payment Item",
      "Installment (EGP)",
      "Maintenance Deposit",
      "Total Outflow (EGP)",
      "Cumulative Paid"
    ];

    const schedHeaderRow = schedSheet.addRow(schedHeaders);
    schedHeaderRow.height = 24;
    schedHeaderRow.eachCell((cell) => {
      cell.fill = STYLES.headerFill;
      cell.font = STYLES.headerFont;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = STYLES.borderHeader;
    });

    // Schedule Rows (Row 4..N)
    rows.forEach((r, idx) => {
      const dataRow = schedSheet.addRow([
        r.period,
        r.due_date,
        sanitizeCellValue(r.label),
        Number(r.amount) || 0,
        Number(r.maintenance_amount) || 0,
        Number(r.total_outflow) || 0,
        Number(r.running_total) || 0
      ]);

      dataRow.height = 20;
      const isZebra = idx % 2 === 1;
      const hasMaintenance = Number(r.maintenance_amount) > 0;

      dataRow.eachCell((cell, colNumber) => {
        cell.border = STYLES.borderThin;
        cell.font = { name: "Calibri", size: 10 };

        if (
          hasMaintenance &&
          (colNumber === 3 || colNumber === 5 || colNumber === 6)
        ) {
          cell.fill = STYLES.maintenanceFill;
          cell.font = STYLES.maintenanceFont;
        } else if (isZebra) {
          cell.fill = STYLES.zebraFill;
        }

        if (colNumber === 1 || colNumber === 2) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
        } else if (colNumber >= 4) {
          if (typeof cell.value === "number") {
            // Displays 0 as "-" in accounting style without inserting literal string hyphens
            cell.numFmt = '#,##0;-#,##0;"-"';
          }
          cell.alignment = { horizontal: "right", vertical: "middle" };
        } else {
          cell.alignment = { horizontal: "left", vertical: "middle" };
        }
      });
    });

    // Summary Formula Row at the bottom
    const totalRowIndex = rows.length + 4;
    const totalRow = schedSheet.addRow([
      "",
      "",
      "TOTAL CONTRACT COMMITMENT",
      { formula: `SUM(D4:D${totalRowIndex - 1})` },
      { formula: `SUM(E4:E${totalRowIndex - 1})` },
      { formula: `SUM(F4:F${totalRowIndex - 1})` },
      ""
    ]);

    totalRow.height = 24;
    totalRow.eachCell((cell, colNumber) => {
      cell.font = { name: "Calibri", size: 11, bold: true };
      cell.border = STYLES.borderTotal;
      if (colNumber >= 4 && colNumber <= 6) {
        cell.numFmt = "#,##0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
      }
    });

    autoFitColumns(schedSheet, 13, 3);
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/* ====================================================================== */
/* 3. Automatic Rejection Spreadsheet (`مرفوضات_المخزون.xlsx`)             */
/* ====================================================================== */

async function buildRejectionWorkbook({
  rejectedRows = [],
  originalHeaders = [],
  agencyName = "Aqar Real Estate"
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = agencyName;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Rejected Units", {
    views: [{ state: "frozen", ySplit: 3, rightToLeft: false }]
  });

  const totalCols = Math.max(originalHeaders.length + 2, 6);
  sheet.mergeCells(1, 1, 1, totalCols);
  const banner = sheet.getCell("A1");
  banner.value = `⚠️ Rejected Inventory Rows (${rejectedRows.length} errors) — Fix flagged errors and re-upload this file`;
  banner.font = {
    name: "Calibri",
    size: 12,
    bold: true,
    color: { argb: "FF991B1B" }
  };
  banner.fill = STYLES.errorFill;
  banner.alignment = { horizontal: "left", vertical: "middle" };
  sheet.getRow(1).height = 28;

  sheet.addRow([]); // Blank spacer (Row 2)
  sheet.getRow(2).height = 6;

  // Header Row (Row 3): Column A is Error Reason, Column B is Excel Row #
  const finalHeaders = ["Rejection Reason / سبب الاستبعاد", "Excel Row #"];

  if (originalHeaders && originalHeaders.length) {
    finalHeaders.push(...originalHeaders.map(sanitizeCellValue));
  } else {
    finalHeaders.push(
      "Code",
      "Title",
      "Compound",
      "Property Type",
      "Price",
      "Area",
      "Bedrooms",
      "Raw Details"
    );
  }

  const headerRow = sheet.addRow(finalHeaders);
  headerRow.height = 26;
  headerRow.eachCell((cell, colNumber) => {
    cell.fill = colNumber === 1 ? STYLES.errorHeaderFill : STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = STYLES.borderHeader;
  });

  rejectedRows.forEach((item) => {
    const rawReason =
      item.reason ||
      item.errorMessage ||
      "Validation failed: Missing mandatory fields";

    const rowVals = [sanitizeCellValue(rawReason), item.rowNumber || "-"];

    if (Array.isArray(item.rawRowValues)) {
      rowVals.push(...item.rawRowValues.map(sanitizeCellValue));
    } else if (item.data && typeof item.data === "object") {
      rowVals.push(
        sanitizeCellValue(item.data.code || item.code || "-"),
        sanitizeCellValue(item.data.title || "-"),
        sanitizeCellValue(item.data.compound || "-"),
        sanitizeCellValue(item.data.property_type || "-"),
        sanitizeCellValue(item.data.price_value || item.data.price || "-"),
        sanitizeCellValue(item.data.area_value || item.data.area || "-"),
        sanitizeCellValue(item.data.bedrooms || "-"),
        sanitizeCellValue(item.rawDetails || "-")
      );
    } else {
      rowVals.push(
        sanitizeCellValue(item.code || "-"),
        sanitizeCellValue(item.field || "-"),
        sanitizeCellValue(item.rawDetails || "-")
      );
    }

    const row = sheet.addRow(rowVals);
    row.height = 22;

    row.eachCell((cell, colNumber) => {
      cell.border = STYLES.borderThin;
      cell.font = { name: "Calibri", size: 10 };

      if (colNumber === 1) {
        cell.fill = STYLES.errorFill;
        cell.font = STYLES.errorFont;
        // The reasons are Arabic: right to left inside an LTR sheet (XLS-04).
        cell.alignment = { horizontal: "right", vertical: "middle", readingOrder: "rtl" };
      } else if (colNumber === 2) {
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      }
    });
  });

  autoFitColumns(sheet, 14, 3);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/* ====================================================================== */
/* 4. Bulk Ingestion Reconciliation Report (2-Tab Format)                 */
/* ====================================================================== */

async function buildBulkIngestionReport({
  addedListings = [],
  rejectedRows = [],
  agency = {},
  broker = {},
  lang = "en"
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = agency.name || "WehdatHub Ingestion Engine";
  workbook.created = new Date();

  /* TAB 1: Successfully Added Listings */
  const addedSheet = workbook.addWorksheet("Imported Units", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: false }]
  });

  const addedHeaders = [
    "Assigned Code",
    "Unit Title",
    "Price",
    "Area (sqm)",
    "Bedrooms",
    "Compound / Location",
    "Status"
  ];

  const addedHeaderRow = addedSheet.addRow(addedHeaders);
  addedHeaderRow.height = 24;
  addedHeaderRow.eachCell((cell) => {
    cell.fill = STYLES.headerFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = STYLES.borderHeader;
  });

  addedListings.forEach((item, idx) => {
    const row = addedSheet.addRow([
      sanitizeCellValue(item.code),
      sanitizeCellValue(item.details?.title_en || item.title || "-"),
      Number(item.price_value) || 0,
      Number(item.area_value) || 0,
      Number(item.bedrooms) || 0,
      sanitizeCellValue(
        item.details?.compound_en || item.compound || item.location || "-"
      ),
      "Active"
    ]);

    row.height = 20;
    const isZebra = idx % 2 === 1;
    row.eachCell((cell, colNumber) => {
      cell.border = STYLES.borderThin;
      cell.font = { name: "Calibri", size: 10 };
      if (isZebra) cell.fill = STYLES.zebraFill;

      if (colNumber === 3) {
        cell.numFmt = "#,##0";
        cell.alignment = { horizontal: "right", vertical: "middle" };
      } else if (colNumber === 4 || colNumber === 5) {
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      }
    });
  });

  autoFitColumns(addedSheet, 14, 3);

  /* TAB 2: Rejected Rows & Validation Errors */
  const rejectedSheet = workbook.addWorksheet("Rejected Rows", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: false }]
  });

  const rejectedHeaders = [
    "Excel Row #",
    "Given Code",
    "Rejection Reason",
    "Missing / Invalid Field",
    "Raw Input Details"
  ];

  const rejHeaderRow = rejectedSheet.addRow(rejectedHeaders);
  rejHeaderRow.height = 24;
  rejHeaderRow.eachCell((cell) => {
    cell.fill = STYLES.errorHeaderFill;
    cell.font = STYLES.headerFont;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = STYLES.borderHeader;
  });

  rejectedRows.forEach((errItem) => {
    const row = rejectedSheet.addRow([
      errItem.rowNumber || "-",
      sanitizeCellValue(errItem.code || "-"),
      sanitizeCellValue(errItem.reason || "Validation Failed"),
      sanitizeCellValue(errItem.field || "-"),
      sanitizeCellValue(errItem.rawDetails || "-")
    ]);

    row.height = 22;
    row.eachCell((cell, colNumber) => {
      cell.border = STYLES.borderThin;
      cell.fill = STYLES.errorFill;
      cell.font = STYLES.errorFont;

      if (colNumber === 1) {
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      }
    });
  });

  autoFitColumns(rejectedSheet, 16, 4);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
  buildAgencyInventoryWorkbook,
  buildMultiPlanWorkbook,
  buildRejectionWorkbook,
  buildBulkIngestionReport,
  sanitizeCellValue
};
