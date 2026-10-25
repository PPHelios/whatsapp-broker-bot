// routes/commandInventory.js — Inventory summary ("stats") and the Excel export command. Split out of routes/commands.js.
"use strict";

const T = require("../lib/text");
const { reply, replyButtons, replyDocument } = require("../lib/dispatcher");
const { logCommandOp, checkBrokerCooldown, setBrokerCooldown, releaseBrokerCooldown } = require("./commandState");

/** STATS-01: counts by status and inventory type, portfolio value, average price and the top areas. */
async function sendInventoryStats(broker, ctx, startTime) {
  const { pool, lang } = ctx;
  try {
    const statsQuery = `
      SELECT
        COUNT(*)::integer AS total_count,
        COUNT(*) FILTER (WHERE status = 'active')::integer AS active_count,
        COUNT(*) FILTER (WHERE status = 'sold')::integer AS sold_count,
        COUNT(*) FILTER (WHERE status = 'archived')::integer AS archived_count,
        COUNT(*) FILTER (WHERE inventory_type = 'resale_unit' AND status = 'active')::integer AS resale_count,
        COUNT(*) FILTER (WHERE inventory_type != 'resale_unit' AND status = 'active')::integer AS developer_count,
        COALESCE(SUM(price_value) FILTER (WHERE status = 'active'), 0)::numeric AS total_active_value,
        COALESCE(AVG(price_value) FILTER (WHERE status = 'active' AND price_value > 0), 0)::numeric AS avg_active_price
      FROM listings
      WHERE agency_id = $1
    `;

    const topAreasQuery = `
      SELECT COALESCE(compound, district, city, 'أخرى') AS area_name, COUNT(*)::integer AS unit_count
      FROM listings
      WHERE agency_id = $1 AND status = 'active' AND (compound IS NOT NULL OR district IS NOT NULL OR city IS NOT NULL)
      GROUP BY 1
      ORDER BY unit_count DESC
      LIMIT 3
    `;

    const [statsResult, areasResult] = await Promise.all([
      pool.query(statsQuery, [broker.agency_id]),
      pool.query(topAreasQuery, [broker.agency_id])
    ]);

    const s = statsResult.rows[0] || {
      total_count: 0,
      active_count: 0,
      sold_count: 0,
      archived_count: 0,
      resale_count: 0,
      developer_count: 0,
      total_active_value: 0,
      avg_active_price: 0
    };

    const topAreas = areasResult.rows || [];

    let statsMsg = "";
    if (lang === "en") {
      statsMsg =
        `📊 *Agency Inventory Summary*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *Total Units:* ${s.total_count}\n` +
        `• 🟢 *Active & Searchable:* ${s.active_count}\n` +
        `• 🔴 *Sold:* ${s.sold_count}\n` +
        `• 📁 *Archived:* ${s.archived_count}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *Resale Units:* ${s.resale_count}\n` +
        `• *Primary Developer:* ${s.developer_count}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *Active Portfolio Value:* ${T.formatPrice(
          s.total_active_value,
          "en",
          "EGP"
        )}\n` +
        `• *Average Unit Price:* ${T.formatPrice(
          s.avg_active_price,
          "en",
          "EGP"
        )}`;

      if (topAreas.length > 0) {
        statsMsg += `\n━━━━━━━━━━━━━━━━━━━━\n📍 *Top Hubs by Inventory:*`;
        topAreas.forEach((area, idx) => {
          statsMsg += `\n  ${idx + 1}. *${area.area_name}*: ${
            area.unit_count
          } units`;
        });
      }
    } else {
      statsMsg =
        `📊 *تقرير وملخص مخزون الوكالة*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *إجمالي الوحدات المسجلة:* ${s.total_count}\n` +
        `• 🟢 *نشط ومتاح للبحث:* ${s.active_count}\n` +
        `• 🔴 *تم البيع:* ${s.sold_count}\n` +
        `• 📁 *مؤرشف:* ${s.archived_count}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *وحدات إعادة البيع (Resale):* ${s.resale_count}\n` +
        `• *مشاريع المطورين:* ${s.developer_count}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `• *إجمالي قيمة المحفظة النشطة:* ${T.formatPrice(
          s.total_active_value,
          "ar",
          "EGP"
        )}\n` +
        `• *متوسط سعر الوحدة:* ${T.formatPrice(
          s.avg_active_price,
          "ar",
          "EGP"
        )}`;

      if (topAreas.length > 0) {
        statsMsg += `\n━━━━━━━━━━━━━━━━━━━━\n📍 *أعلى المناطق تواجداً:*`;
        topAreas.forEach((area, idx) => {
          statsMsg += `\n  ${idx + 1}. *${area.area_name}*: ${
            area.unit_count
          } وحدة`;
        });
      }
    }

    await replyButtons(broker, statsMsg, [
      {
        id: "cmd:export",
        title: lang === "en" ? "Export Excel 📊" : "تصدير الإكسيل 📊"
      },
      {
        id: "cmd:add",
        title: lang === "en" ? "New Unit 📝" : "إضافة وحدة 📝"
      }
    ]);

    logCommandOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "command_inventory_stats",
      total_duration_ms: Date.now() - startTime
    });
    return true;
  } catch (err) {
    console.error("Inventory stats summary failure:", err);
    await reply(
      broker,
      lang === "en"
        ? "❌ Could not calculate inventory statistics. Please try again later."
        : "❌ تعذر استخراج إحصائيات المخزون حالياً. يرجى المحاولة لاحقاً."
    );
    return true;
  }
}

/** DEL-06: the agency's active units as an .xlsx, built after the reply (one export a minute per broker). */
async function startInventoryExport(broker, ctx) {
  const { pool, lang, cooldowns } = ctx;
  const cooldownRemaining = await checkBrokerCooldown(
    pool,
    broker.id,
    "export",
    cooldowns
  );

  if (cooldownRemaining > 0) {
    await reply(
      broker,
      lang === "en"
        ? `⏳ Export is cooling down. Please wait ${cooldownRemaining}s before requesting again.`
        : `⏳ عذراً، تم طلب تصدير الشيت منذ قليل. يرجى الانتظار ${cooldownRemaining} ثانية قبل إعادة الطلب.`
    );
    return true;
  }

  await setBrokerCooldown(pool, broker.id, "export", 60000, cooldowns);

  await reply(
    broker,
    lang === "en"
      ? "⏳ Compiling agency inventory spreadsheet... You will receive the .xlsx file shortly."
      : "⏳ جاري استخراج شيت إكسيل بمخزون الوكالة... سيتم إرسال الملف مباشرة."
  );

  setImmediate(async () => {
    const exportStartTime = Date.now();
    try {
      const { rows: listings } = await pool.query(
        "SELECT * FROM listings WHERE agency_id = $1 AND status = 'active' ORDER BY created_at DESC",
        [broker.agency_id]
      );
      const { rows: agencies } = await pool.query(
        "SELECT * FROM agencies WHERE id = $1",
        [broker.agency_id]
      );
      const Excel = require("../lib/excel");
      const buf = await Excel.buildAgencyInventoryWorkbook({
        listings,
        agency: agencies[0],
        broker,
        lang
      });

      const sent = await replyDocument(
        broker,
        buf,
        `Inventory_${new Date().toISOString().slice(0, 10)}.xlsx`,
        lang === "en"
          ? "📊 Full Agency Inventory Report"
          : "📊 تقرير مخزون الوكالة المعتمد"
      );
      if (!sent) throw new Error("Inventory workbook delivery failed");

      await logCommandOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        operation_type: "command_inventory_export",
        total_duration_ms: Date.now() - exportStartTime,
        metadata: { rowsCount: listings.length }
      });
    } catch (err) {
      console.error("Export failure:", err);
      await releaseBrokerCooldown(pool, broker.id, "export", cooldowns);
      await reply(
        broker,
        lang === "en"
          ? "❌ Failed to generate the inventory spreadsheet. Please try again later."
          : "❌ تعذر إنشاء ملف الإكسيل حالياً. يرجى إعادة المحاولة لاحقاً."
      );
    }
  });

  return true;
}

module.exports = {
  sendInventoryStats,
  startInventoryExport
};
