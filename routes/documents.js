"use strict";

const ExcelJS = require("exceljs");
const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");
const Excel = require("../lib/excel");
const { reply } = require("../lib/dispatcher");

/**
 * Handles incoming WhatsApp documents (.xlsx spreadsheets) (XLS-01 - XLS-04).
 */
async function handleDocument(broker, message, ctx) {
  const { pool, lang, cooldowns } = ctx;
  const doc = message.document;

  if (!doc || !doc.id) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Document could not be retrieved."
        : "⚠️ تعذر استلام المستند المرفوع."
    );
    return "done";
  }

  const filename = doc.filename || "inventory.xlsx";
  const isExcel =
    /\.xlsx$/i.test(filename) ||
    (doc.mime_type && doc.mime_type.includes("spreadsheetml"));

  // Reject unsupported formats immediately (ING-06)
  if (!isExcel) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Unsupported file format. Please upload an Excel workbook (.xlsx)."
        : "⚠️ صيغة الملف غير مدعومة. يقبل النظام فقط ملفات الإكسيل بصيغة (.xlsx)."
    );
    return "done";
  }

  // Enforce 45s cooldown per agency to avoid concurrent lock collisions
  const agencyCooldownKey = `bulk_excel:${broker.agency_id}`;
  const now = Date.now();
  if (cooldowns.get(agencyCooldownKey) > now) {
    await reply(
      broker,
      lang === "en"
        ? "⏳ Another bulk file is currently being imported for your agency. Please wait a moment."
        : "⚠️ جاري معالجة ملف مخزون سابق لنفس الوكالة حالياً. يرجى الانتظار لحين اكتمال المعالجة."
    );
    return "done";
  }
  cooldowns.set(agencyCooldownKey, now + 45000);

  // Immediate Symmetrical Acknowledgment with Expected Time (Dynamic ETA Contract)
  await reply(
    broker,
    lang === "en"
      ? `📥 Received *${filename}*. Validating columns and inventory codes...\n⏱️ Estimated time: 10 to 15 seconds.`
      : `📥 تم استلام الملف *${filename}* بنجاح.\n⏳ جاري فحص البيانات، مطابقة الأكواد، ومراجعة الأسعار والمساحات...\n⏱️ الوقت المتوقع: 10 إلى 15 ثانية.`
  );

  // Download media from WhatsApp Graph API
  let fileData;
  try {
    fileData = await WA.downloadWhatsAppMedia(doc.id);
  } catch (err) {
    console.error("Failed to download document media:", err);
  }

  if (!fileData || !fileData.buffer) {
    cooldowns.delete(agencyCooldownKey); // Release cooldown on download failure
    await reply(
      broker,
      lang === "en"
        ? "❌ Could not download spreadsheet from WhatsApp. Please re-upload."
        : "❌ تعذر تحميل ملف الإكسيل من سيرفرات واتساب. يرجى إعادة المحاولة."
    );
    return "done";
  }

  const buffer = fileData.buffer;

  // Validate File Size (<= 5MB) (SEC-05)
  if (buffer.length > 5 * 1024 * 1024) {
    cooldowns.delete(agencyCooldownKey);
    await reply(
      broker,
      lang === "en"
        ? "⚠️ File size exceeds the 5MB maximum limit. Please split the sheet and retry."
        : "⚠️ حجم الملف أكبر من الحد الأقصى المسموح به (5 ميجابايت). يرجى تقليص حجم الملف والمحاولة مجدداً."
    );
    return "done";
  }

  // Validate ZIP/XLSX Magic Bytes (PK\x03\x04) (SEC-05)
  if (!U.isValidZipBuffer(buffer)) {
    cooldowns.delete(agencyCooldownKey);
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Corrupted or encrypted file. Please upload a standard unencrypted .xlsx file."
        : "⚠️ الملف تالف أو مشفر. يرجى التأكد من حفظ الملف بصيغة Excel (.xlsx) غير محمية بكلمة سر."
    );
    return "done";
  }

  // Parse Excel in-memory (Ephemeral Filesystem Rule)
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    console.error("ExcelJS parse failure:", err);
    cooldowns.delete(agencyCooldownKey);
    await reply(
      broker,
      lang === "en"
        ? "❌ Corrupted Excel structure. Could not parse worksheets."
        : "❌ هيكل ملف الإكسيل تالف أو غير صالح للقراءة. يرجى التأكد من صحة الملف."
    );
    return "done";
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount < 2) {
    cooldowns.delete(agencyCooldownKey);
    await reply(
      broker,
      lang === "en"
        ? "⚠️ The uploaded spreadsheet is empty or has no data rows."
        : "⚠️ ملف الإكسيل المرفوع فارغ ولا يحتوي على صفوف بيانات."
    );
    return "done";
  }

  // Extract original headers for rejection workbook alignment
  const originalHeaders = [];
  const headerRow = worksheet.getRow(1);
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    originalHeaders.push(String(cell.value || "").trim());
  });

  // Pre-Flight Dry Run Partitioning & Formula Injection Sanitization
  const validToCommit = [];
  const rejectedRows = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip headers

    const rawCode = Excel.sanitizeCellValue(row.getCell(1).text);
    const rawPrice = row.getCell(2).value;
    const rawArea = row.getCell(3).value;
    const rawCompound = Excel.sanitizeCellValue(row.getCell(4).text);
    const rawType = Excel.sanitizeCellValue(row.getCell(5).text) || "apartment";
    const rawBeds = row.getCell(6).value;

    const parsedPrice = T.parseEgyptianPrice(String(rawPrice || ""));
    const price = parsedPrice?.priceValue || 0;
    const area = parseFloat(String(rawArea || "").replace(/[^0-9.]/g, ""));
    const beds = parseInt(String(rawBeds || "1"), 10);

    // Collect all raw cell string values for audit workbook
    const rawRowValues = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      rawRowValues.push(String(cell.value || ""));
    });

    // Validate Unit Code formatting (ING-04)
    let code = rawCode ? rawCode.toUpperCase().replace(/\s+/g, "-") : null;
    if (!code) {
      code = `UNT-${Date.now().toString(36).toUpperCase()}-${rowNumber}`;
    }

    // Validation Rules
    if (!price || price <= 0) {
      rejectedRows.push({
        rowNumber,
        code,
        price: rawPrice,
        area: rawArea,
        compound: rawCompound,
        reason: "Missing or invalid price",
        rawRowValues
      });
      return;
    }

    if (!area || area < 10) {
      rejectedRows.push({
        rowNumber,
        code,
        price: rawPrice,
        area: rawArea,
        compound: rawCompound,
        reason: "Area missing or < 10 sqm",
        rawRowValues
      });
      return;
    }

    if (!rawCompound || rawCompound.trim().length === 0) {
      rejectedRows.push({
        rowNumber,
        code,
        price: rawPrice,
        area: rawArea,
        compound: rawCompound,
        reason: "Compound/Location missing",
        rawRowValues
      });
      return;
    }

    validToCommit.push({
      code,
      price,
      currency: parsedPrice.currency || "EGP",
      area,
      compound: rawCompound.trim(),
      propertyType: rawType,
      bedrooms: isNaN(beds) ? 1 : beds,
      rowNumber
    });
  });

  // Database Batch Commit inside Transaction (XLS-02)
  const client = await pool.connect();
  let committedCount = 0;

  try {
    await client.query("BEGIN");

    // Acquire agency-wide lock for atomic catalog insertion
    await client.query(
      "SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':bulk_import'), 1, 16))::bit(64)::bigint)",
      [String(broker.agency_id)]
    );

    for (const item of validToCommit) {
      const priceDisplay = T.formatAbbreviatedPrice(
        item.price,
        item.currency,
        lang,
        "sale"
      );
      const titleAr = `${item.propertyType} ${item.area}م² في ${item.compound} - ${priceDisplay}`;
      const searchCorpus = `${item.code} ${titleAr} ${item.compound}`;

      const insertQuery = `
        INSERT INTO listings (
          agency_id, broker_id, code, title, property_type, price_value, price_display,
          area_value, bedrooms, compound, search_text_normalized, status, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, clean_arabic_text($11), 'active', NOW())
        ON CONFLICT (agency_id, code)
        DO UPDATE SET
          price_value = EXCLUDED.price_value,
          price_display = EXCLUDED.price_display,
          area_value = EXCLUDED.area_value,
          bedrooms = EXCLUDED.bedrooms,
          compound = EXCLUDED.compound,
          search_text_normalized = EXCLUDED.search_text_normalized,
          flyer_cache = '{}'::jsonb,
          status = 'active',
          updated_at = NOW()
      `;

      await client.query(insertQuery, [
        broker.agency_id,
        broker.id,
        item.code,
        titleAr,
        item.propertyType,
        item.price,
        priceDisplay,
        item.area,
        item.bedrooms,
        item.compound,
        searchCorpus
      ]);

      committedCount++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    cooldowns.delete(agencyCooldownKey);
    console.error("Batch commit failed:", err);
    await reply(
      broker,
      lang === "en"
        ? "❌ Database error during import. No rows were committed."
        : "❌ حدث خطأ بقاعدة البيانات أثناء حفظ الوحدات. لم يتم اعتماد الشيت للحفاظ على اتساق البيانات."
    );
    return "done";
  } finally {
    client.release();
  }

  // Final Symmetrical Response & Rejection Document Dispatch (XLS-03)
  const totalRows = worksheet.rowCount - 1;
  const rejectedCount = rejectedRows.length;

  if (rejectedCount === 0) {
    await reply(
      broker,
      lang === "en"
        ? `✅ *Inventory Successfully Imported:*\n• Total Rows: ${totalRows}\n• ✅ Committed: ${committedCount} units\n• All units are active and searchable.`
        : `✅ *تم استيراد المخزون بنجاح:*\n• إجمالي السطور: ${totalRows}\n• ✅ تم الاعتماد والتحديث: ${committedCount} وحدة\n• جميع الوحدات نشطة ومتاحة في البحث الفوري الآن.`
    );
  } else {
    const summaryMsg =
      lang === "en"
        ? `📊 *Inventory Processing Report:*\n• Total Rows: ${totalRows}\n• ✅ Committed: ${committedCount} units\n• ❌ Rejected: ${rejectedCount} units\n📎 Attached is a detailed report of rejected rows for review.`
        : `📊 *تقرير معالجة ملف المخزون:*\n• الإجمالي: ${totalRows} سطر\n• ✅ تم الاعتماد والتحديث: ${committedCount} وحدة\n• ❌ تم الاستبعاد: ${rejectedCount} وحدة\n📎 مرفق شيت تفصيلي بالأخطاء لتصحيحها وإعادة رفعها.`;

    await reply(broker, summaryMsg);

    // Send Rejection Document via WhatsApp using centralized Excel library
    try {
      const { rows: agencyRows } = await pool.query(
        "SELECT name FROM agencies WHERE id = $1",
        [broker.agency_id]
      );
      const agencyName = agencyRows[0]?.name || "Aqar Real Estate";

      const rejectionBuffer = await Excel.buildRejectionWorkbook({
        rejectedRows,
        originalHeaders,
        agencyName
      });

      await WA.sendWhatsAppDocument(
        broker.phone_normalized,
        rejectionBuffer,
        `مرفوضات_${filename}`,
        lang === "en"
          ? "⚠️ Rejected Rows Report"
          : "⚠️ شيت الوحدات المستبعدة مع الأسباب"
      );
    } catch (docErr) {
      console.error("Failed to send rejection document:", docErr);
    }
  }

  return "done";
}

module.exports = {
  handleDocument
};
