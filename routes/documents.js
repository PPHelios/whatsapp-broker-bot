// routes/documents.js — Bulk Excel Inventory Ingestion & Atomic Batch Commit
"use strict";

const crypto = require("crypto");
const ExcelJS = require("exceljs");
const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");
const Excel = require("../lib/excel");
const { reply, replyDocument } = require("../lib/dispatcher");

/**
 * Asynchronous, non-blocking operational telemetry logging helper.
 */
async function logDocumentOp(
  pool,
  {
    agency_id,
    broker_id,
    listing_code = "BULK_IMPORT",
    operation_type = "bulk_excel_import",
    status = "success",
    error_code = null,
    total_duration_ms = 0,
    db_ms = 0,
    metadata = {}
  }
) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO operation_logs (
        agency_id, broker_id, listing_code, operation_type,
        status, error_code, total_duration_ms, db_ms,
        metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
      [
        agency_id || null,
        broker_id || null,
        listing_code,
        operation_type,
        status,
        error_code,
        Math.round(total_duration_ms),
        Math.round(db_ms),
        JSON.stringify(metadata)
      ]
    );
  } catch (e) {
    console.warn("Document telemetry log warning:", e.message);
  }
}

/**
 * Distributed Cooldown: Checks remaining bulk import cooldown for agency/broker.
 */
async function checkAgencyCooldown(pool, agencyId, brokerId, fallbackMap) {
  const now = Date.now();
  if (fallbackMap) {
    const memExp = fallbackMap.get(`bulk_excel:${agencyId}`);
    if (memExp && memExp > now) return Math.ceil((memExp - now) / 1000);
  }
  if (!pool || !brokerId) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT expires_at FROM broker_sessions
       WHERE broker_id = $1 AND session_type = 'cooldown_bulk_excel' AND expires_at > NOW()`,
      [brokerId]
    );
    if (rows.length > 0) {
      return Math.ceil((new Date(rows[0].expires_at).getTime() - now) / 1000);
    }
  } catch (e) {
    console.warn("Failed to check bulk cooldown in DB:", e.message);
  }
  return 0;
}

/**
 * Distributed Cooldown: Persists bulk import cooldown window (45s).
 */
async function setAgencyCooldown(
  pool,
  agencyId,
  brokerId,
  windowMs,
  fallbackMap
) {
  const now = Date.now();
  if (fallbackMap) fallbackMap.set(`bulk_excel:${agencyId}`, now + windowMs);
  if (!pool || !brokerId) return;
  try {
    await pool.query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1, 'cooldown_bulk_excel', '{}'::jsonb, NOW() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         expires_at = NOW() + ($2 || ' milliseconds')::interval`,
      [brokerId, String(windowMs)]
    );
  } catch (e) {
    console.warn("Failed to set bulk cooldown in DB:", e.message);
  }
}

/**
 * Distributed Cooldown: Clears bulk import cooldown early on failure.
 */
async function releaseAgencyCooldown(pool, agencyId, brokerId, fallbackMap) {
  if (fallbackMap) fallbackMap.delete(`bulk_excel:${agencyId}`);
  if (!pool || !brokerId) return;
  try {
    await pool.query(
      `DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = 'cooldown_bulk_excel'`,
      [brokerId]
    );
  } catch (e) {}
}

/**
 * Handles incoming WhatsApp documents (.xlsx spreadsheets) (XLS-01 - XLS-04).
 */
async function handleDocument(broker, message, ctx) {
  const startTime = Date.now();
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

  // Enforce 45s distributed cooldown per agency/broker
  const cooldownRemaining = await checkAgencyCooldown(
    pool,
    broker.agency_id,
    broker.id,
    cooldowns
  );

  if (cooldownRemaining > 0) {
    await reply(
      broker,
      lang === "en"
        ? `⏳ Another bulk file is currently being imported for your agency. Please wait ${cooldownRemaining}s.`
        : `⚠️ جاري معالجة ملف مخزون سابق لنفس الوكالة حالياً. يرجى الانتظار ${cooldownRemaining} ثانية لحين اكتمال المعالجة.`
    );
    return "done";
  }

  await setAgencyCooldown(pool, broker.agency_id, broker.id, 45000, cooldowns);

  // Immediate Symmetrical Acknowledgment with Dynamic Expected Time
  await reply(
    broker,
    lang === "en"
      ? `📥 Received *${filename}*. Validating columns and inventory codes...\n⏱️ Estimated time: ~10 to 15 seconds.`
      : `📥 تم استلام الملف *${filename}* بنجاح.\n⏳ جاري فحص البيانات، مطابقة الأكواد، ومراجعة الأسعار والمساحات...\n⏱️ الوقت المتوقع: ~10 إلى 15 ثانية.`
  );

  // Download media buffer from WhatsApp Graph API
  let fileData;
  try {
    fileData = await WA.downloadWhatsAppMedia(doc.id);
  } catch (err) {
    console.error("Failed to download document media:", err);
  }

  if (!fileData || !fileData.buffer) {
    await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
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
    await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
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
    await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Corrupted or encrypted file. Please upload a standard unencrypted .xlsx file."
        : "⚠️ الملف تالف أو مشفر. يرجى التأكد من حفظ الملف بصيغة Excel (.xlsx) غير محمية بكلمة سر."
    );
    return "done";
  }

  // Compute SHA-256 hash of the buffer for batch idempotency check
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const batchKey = `${broker.agency_id}:${fileHash}`;

  const client = await pool.connect();
  try {
    // Check if this exact file batch was already successfully committed
    const { rows: existingBatch } = await client.query(
      "SELECT batch_key FROM processed_batches WHERE batch_key = $1",
      [batchKey]
    );

    if (existingBatch.length > 0) {
      await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
      await reply(
        broker,
        lang === "en"
          ? "⚠️ This exact inventory spreadsheet has already been imported successfully. Duplicate upload ignored."
          : "⚠️ تم استيراد ملف المخزون هذا مسبقاً بنجاح. تم تجاهل إعادة رفع نفس الملف لتجنب التكرار."
      );
      return "done";
    }

    // Parse Excel in-memory (Ephemeral Filesystem Rule)
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch (err) {
      console.error("ExcelJS parse failure:", err);
      await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
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
      await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
      await reply(
        broker,
        lang === "en"
          ? "⚠️ The uploaded spreadsheet is empty or has no data rows."
          : "⚠️ ملف الإكسيل المرفوع فارغ ولا يحتوي على صفوف بيانات."
      );
      return "done";
    }

    // Extract original headers and map columns dynamically
    const originalHeaders = [];
    const colMap = {};
    const headerRow = worksheet.getRow(1);

    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const h = String(cell.value || "")
        .trim()
        .toLowerCase();
      originalHeaders.push(String(cell.value || "").trim());

      if (
        /(?:كود(?:\s*(?:الوحدة|الداخلي))?|code|unit\s*id|unit)/i.test(h) &&
        !colMap.code
      )
        colMap.code = colNumber;
      else if (/(?:سعر|price|total)/i.test(h) && !colMap.price)
        colMap.price = colNumber;
      else if (/(?:مساحة|مساحه|area|bua|sqm)/i.test(h) && !colMap.area)
        colMap.area = colNumber;
      else if (
        /(?:كمبوند|مشروع|compound|project|location|موقع)/i.test(h) &&
        !colMap.compound
      )
        colMap.compound = colNumber;
      else if (/(?:نوع(?:\s*العقار)?|type|property)/i.test(h) && !colMap.type)
        colMap.type = colNumber;
      else if (/(?:غرف|غرفة|غرفه|beds?|bedroom)/i.test(h) && !colMap.beds)
        colMap.beds = colNumber;
      else if (/(?:حمام|حمامات|baths?|bathroom)/i.test(h) && !colMap.baths)
        colMap.baths = colNumber;
      else if (
        /(?:مطور|developer|inventory|مخزون|نوع\s*المخزون)/i.test(h) &&
        !colMap.inventoryType
      )
        colMap.inventoryType = colNumber;
      else if (/(?:مقدم|down\s*payment)/i.test(h) && !colMap.downPayment)
        colMap.downPayment = colNumber;
      else if (/(?:تقسيط|قسط|years|سنوات)/i.test(h) && !colMap.installments)
        colMap.installments = colNumber;
      else if (/(?:استلام|delivery)/i.test(h) && !colMap.delivery)
        colMap.delivery = colNumber;
      else if (/(?:تشطيب|finishing)/i.test(h) && !colMap.finishing)
        colMap.finishing = colNumber;
      else if (/(?:دور|floor)/i.test(h) && !colMap.floor)
        colMap.floor = colNumber;
    });

    // Detect if the sheet represents a primary developer project portfolio
    const isDeveloperSheet =
      /(?:developer|primary|مطور|مشروع|project|شيت_المطور)/i.test(filename) ||
      originalHeaders.some((h) =>
        /(?:developer|مطور|نظام\s*سداد|payment\s*plan|كود\s*المطور)/i.test(h)
      );

    // Pre-Flight Dry Run Partitioning & Formula Injection Sanitization
    const validToCommit = [];
    const rejectedRows = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip headers

      const rawCodeText = Excel.sanitizeCellValue(
        row.getCell(colMap.code || 1).text
      );
      const rawPrice = row.getCell(colMap.price || 2).value;
      const rawArea = row.getCell(colMap.area || 3).value;
      const rawCompound = Excel.sanitizeCellValue(
        row.getCell(colMap.compound || 4).text
      );
      const rawType =
        Excel.sanitizeCellValue(row.getCell(colMap.type || 5).text) ||
        "apartment";
      const rawBeds = row.getCell(colMap.beds || 6).value;
      const rawBaths = colMap.baths ? row.getCell(colMap.baths).value : null;

      // Auxiliary columns
      const rawDownPayment = colMap.downPayment
        ? row.getCell(colMap.downPayment).value
        : null;
      const rawInstallments = colMap.installments
        ? row.getCell(colMap.installments).value
        : null;
      const rawDelivery = colMap.delivery
        ? Excel.sanitizeCellValue(row.getCell(colMap.delivery).text)
        : null;
      const rawFinishing = colMap.finishing
        ? Excel.sanitizeCellValue(row.getCell(colMap.finishing).text)
        : null;
      const rawFloor = colMap.floor
        ? Excel.sanitizeCellValue(row.getCell(colMap.floor).text)
        : null;

      const rawRowValues = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        rawRowValues.push(String(cell.value || ""));
      });

      // 1. Validate Unit Code formatting (ING-04)
      if (rawCodeText && /[\u0600-\u06FF]/.test(rawCodeText)) {
        rejectedRows.push({
          rowNumber,
          code: rawCodeText,
          price: rawPrice,
          area: rawArea,
          compound: rawCompound,
          reason:
            "كود الوحدة يجب أن يتكون من حروف وأرقام إنجليزية فقط (مثال: NOLL-101)",
          rawRowValues
        });
        return;
      }

      let code = T.extractCleanCode(rawCodeText);
      if (!code) {
        code = `UNT-${Date.now().toString(36).toUpperCase()}-${rowNumber}`;
      }

      // 2. Validate Price
      const parsedPrice = T.parseEgyptianPrice(String(rawPrice || ""));
      const price = parsedPrice?.priceValue || 0;

      if (!price || price <= 0) {
        rejectedRows.push({
          rowNumber,
          code,
          price: rawPrice,
          area: rawArea,
          compound: rawCompound,
          reason: "السعر مفقود أو غير صحيح",
          rawRowValues
        });
        return;
      }

      // 3. Validate Area
      const area = parseFloat(String(rawArea || "").replace(/[^0-9.]/g, ""));
      if (!area || area < 10) {
        rejectedRows.push({
          rowNumber,
          code,
          price: rawPrice,
          area: rawArea,
          compound: rawCompound,
          reason: "المساحة مفقودة أو أقل من 10 م²",
          rawRowValues
        });
        return;
      }

      // 4. Validate Compound
      if (!rawCompound || rawCompound.trim().length === 0) {
        rejectedRows.push({
          rowNumber,
          code,
          price: rawPrice,
          area: rawArea,
          compound: rawCompound,
          reason: "اسم الكمبوند أو المشروع مفقود",
          rawRowValues
        });
        return;
      }

      // 5. Typology Harmonization (Studios vs Villas)
      const cleanType = String(rawType || "apartment")
        .trim()
        .toLowerCase();
      const numBeds = parseInt(String(rawBeds ?? ""), 10);
      const isStudio =
        cleanType.includes("studio") ||
        cleanType.includes("استوديو") ||
        numBeds === 0;

      const isVilla = [
        "villa",
        "townhouse",
        "twinhouse",
        "standalone",
        "فيلا",
        "تاون",
        "توين"
      ].some((t) => cleanType.includes(t));

      let finalPropertyType = "apartment";
      if (isStudio) {
        finalPropertyType = "studio";
      } else if (isVilla) {
        if (cleanType.includes("town") || cleanType.includes("تاون")) {
          finalPropertyType = "townhouse";
        } else if (cleanType.includes("twin") || cleanType.includes("توين")) {
          finalPropertyType = "twinhouse";
        } else {
          finalPropertyType = "villa";
        }
      } else if (cleanType.includes("duplex") || cleanType.includes("دوبلكس")) {
        finalPropertyType = "duplex";
      } else if (
        cleanType.includes("penthouse") ||
        cleanType.includes("بنتهاوس")
      ) {
        finalPropertyType = "penthouse";
      } else if (cleanType.includes("chalet") || cleanType.includes("شاليه")) {
        finalPropertyType = "chalet";
      }

      const finalBedrooms = isStudio ? 0 : isNaN(numBeds) ? 1 : numBeds;
      const finalBathrooms = rawBaths
        ? parseInt(String(rawBaths), 10) || null
        : null;

      // 6. Developer Model Determination (XLS-02 & EDT-04)
      let isPrimaryDev = isDeveloperSheet;
      let invType = isDeveloperSheet ? "developer_model" : "resale_unit";

      if (colMap.inventoryType) {
        const rowInvVal = String(
          row.getCell(colMap.inventoryType).value || ""
        ).toLowerCase();
        if (/(?:مطور|developer|primary|مشروع)/i.test(rowInvVal)) {
          isPrimaryDev = true;
          invType = "developer_model";
        } else if (/(?:ريزيل|resale|اعادة\s*بيع)/i.test(rowInvVal)) {
          isPrimaryDev = false;
          invType = "resale_unit";
        }
      }

      // Construct Details JSONB
      const details = {
        currency: parsedPrice.currency || "EGP",
        finishing: rawFinishing || null,
        floor: isVilla ? null : rawFloor || null,
        bathrooms: finalBathrooms,
        bua: isVilla ? area : null,
        delivery_date: rawDelivery || null,
        down_payment_value: rawDownPayment
          ? Number(rawDownPayment) || null
          : null,
        installment_years: rawInstallments
          ? parseInt(String(rawInstallments), 10) || null
          : null
      };

      validToCommit.push({
        code,
        price,
        currency: parsedPrice.currency || "EGP",
        area,
        compound: rawCompound.trim(),
        propertyType: finalPropertyType,
        bedrooms: finalBedrooms,
        bathrooms: finalBathrooms,
        isPrimaryDeveloper: isPrimaryDev,
        inventoryType: invType,
        developerUnitCode: isPrimaryDev ? code : null,
        downPaymentValue: details.down_payment_value,
        installmentYears: details.installment_years,
        deliveryDate: details.delivery_date,
        details,
        rowNumber
      });
    });

    // Database Batch Commit inside Transaction (XLS-02) with 64-bit Advisory Lock
    let committedCount = 0;
    const dbStartTime = Date.now();

    try {
      await client.query("BEGIN");

      // Acquire agency-wide advisory lock for bulk import
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext('bulk_import'))",
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
            agency_id, broker_id, code, title, property_type, listing_type,
            price_value, price_display, area_value, bedrooms, bathrooms,
            compound, search_text_normalized, status, is_primary_developer,
            inventory_type, developer_unit_code, down_payment_value,
            installment_years, delivery_date, details, flyer_cache, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, 'sale',
            $6, $7, $8, $9, $10,
            $11, clean_arabic_text($12), 'active', $13,
            $14, $15, $16,
            $17, $18, $19::jsonb, '{}'::jsonb, NOW()
          )
          ON CONFLICT (agency_id, code)
          DO UPDATE SET
            title = EXCLUDED.title,
            property_type = EXCLUDED.property_type,
            price_value = EXCLUDED.price_value,
            price_display = EXCLUDED.price_display,
            area_value = EXCLUDED.area_value,
            bedrooms = EXCLUDED.bedrooms,
            bathrooms = COALESCE(EXCLUDED.bathrooms, listings.bathrooms),
            compound = EXCLUDED.compound,
            search_text_normalized = EXCLUDED.search_text_normalized,
            is_primary_developer = EXCLUDED.is_primary_developer,
            inventory_type = EXCLUDED.inventory_type,
            developer_unit_code = COALESCE(EXCLUDED.developer_unit_code, listings.developer_unit_code),
            down_payment_value = COALESCE(EXCLUDED.down_payment_value, listings.down_payment_value),
            installment_years = COALESCE(EXCLUDED.installment_years, listings.installment_years),
            delivery_date = COALESCE(EXCLUDED.delivery_date, listings.delivery_date),
            details = listings.details || EXCLUDED.details,
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
          item.bathrooms,
          item.compound,
          searchCorpus,
          item.isPrimaryDeveloper,
          item.inventoryType,
          item.developerUnitCode,
          item.downPaymentValue,
          item.installmentYears,
          item.deliveryDate,
          JSON.stringify(item.details)
        ]);

        committedCount++;
      }

      // Record batch in processed_batches to guarantee idempotency on multi-tap uploads
      await client.query(
        `INSERT INTO processed_batches (batch_key, agency_id, listing_code, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (batch_key) DO NOTHING`,
        [batchKey, broker.agency_id, "BULK_IMPORT"]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
      console.error("Batch commit failed:", err);

      await logDocumentOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "bulk_excel_import",
        status: "failed",
        error_code: err.code || "DB_BATCH_ERROR",
        total_duration_ms: Date.now() - startTime,
        metadata: { filename, error: err.message }
      });

      await reply(
        broker,
        lang === "en"
          ? "❌ Database error during import. No rows were committed."
          : "❌ حدث خطأ بقاعدة البيانات أثناء حفظ الوحدات. لم يتم اعتماد الشيت للحفاظ على اتساق البيانات."
      );
      return "done";
    }

    const dbDuration = Date.now() - dbStartTime;

    // Final Symmetrical Response & Rejection Document Dispatch (XLS-03)
    const totalRows = worksheet.rowCount - 1;
    const rejectedCount = rejectedRows.length;

    await logDocumentOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "bulk_excel_import",
      status: rejectedCount === 0 ? "success" : "partial_success",
      total_duration_ms: Date.now() - startTime,
      db_ms: dbDuration,
      metadata: {
        filename,
        totalRows,
        committedCount,
        rejectedCount,
        isDeveloperSheet
      }
    });

    if (rejectedCount === 0) {
      await reply(
        broker,
        lang === "en"
          ? `✅ *Inventory Successfully Imported:*\n• Total Rows: ${totalRows}\n• ✅ Committed: ${committedCount} units\n• Developer Protected: ${
              isDeveloperSheet ? "Yes (Primary Developer)" : "No (Resale)"
            }\n• All units are active and searchable.`
          : `✅ *تم استيراد المخزون بنجاح:*\n• إجمالي السطور: ${totalRows}\n• ✅ تم الاعتماد والتحديث: ${committedCount} وحدة\n• تصنيف المخزون: ${
              isDeveloperSheet ? "مشاريع مطورين معتمدة" : "وحدات ريزيل"
            }\n• جميع الوحدات نشطة ومتاحة في البحث الفوري الآن.`
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
          agencyName,
          originalFilename: filename
        });

        const sent = await replyDocument(
          broker,
          rejectionBuffer,
          `مرفوضات_${filename}`,
          lang === "en"
            ? "⚠️ Rejected Rows Report"
            : "⚠️ شيت الوحدات المستبعدة مع الأسباب"
        );
        if (!sent) throw new Error("Rejection workbook delivery failed");
      } catch (docErr) {
        console.error("Failed to send rejection document:", docErr);
        await reply(
          broker,
          lang === "en"
            ? "⚠️ The rejected-rows report could not be delivered. Please re-send the file to receive it again."
            : "⚠️ تعذر إرسال شيت الوحدات المستبعدة. يرجى إعادة إرسال الملف لاستلامه مرة أخرى."
        );
      }
    }
  } catch (err) {
    console.error("Document handler transaction error:", err);
    await releaseAgencyCooldown(pool, broker.agency_id, broker.id, cooldowns);
    await reply(
      broker,
      lang === "en"
        ? "❌ A temporary error occurred while processing your inventory file."
        : "❌ حدث خطأ فني أثناء معالجة ملف المخزون المرفوع."
    );
  } finally {
    client.release();
  }

  return "done";
}

module.exports = {
  handleDocument
};
