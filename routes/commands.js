"use strict";

const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");
const { reply } = require("../lib/dispatcher");

/**
 * Validates whether the broker has permission to mutate a listing.
 */
function canEdit(broker, listing) {
  if (["admin", "owner", "manager"].includes(broker.role)) return true;
  return listing.broker_id === broker.id;
}

/**
 * Text Commands Controller
 */
async function handleCommand(broker, text, ctx) {
  const { pool, lang, recentBrokerListings, cooldowns } = ctx;
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // Helper to resolve code explicitly or fallback to recent session
  const resolveTargetCode = (explicitCode) => {
    if (explicitCode) return explicitCode.toUpperCase().replace(/^#/, "");
    return recentBrokerListings.get(broker.id) || null;
  };

  // 1. HELP / MENU (SYS-01)
  if (/^(مساعدة|help|اوامر|الأوامر|menu|قائمة)$/i.test(lower)) {
    const helpMsg = T.getHelpMessage(lang);
    await reply(broker, helpMsg);
    return true;
  }

  // 2. EXPORT INVENTORY (EXCEL) (DEL-06)
  if (/^(تصدير|export|excel|شيت)$/i.test(lower)) {
    const cooldownKey = `export:${broker.id}`;
    const now = Date.now();
    const activeCooldown = cooldowns.get(cooldownKey);

    if (activeCooldown && activeCooldown > now) {
      const waitSec = Math.ceil((activeCooldown - now) / 1000);
      await reply(
        broker,
        lang === "en"
          ? `⏳ Export is cooling down. Please wait ${waitSec}s before requesting again.`
          : `⏳ عذراً، تم طلب تصدير الشيت منذ قليل. يرجى الانتظار ${waitSec} ثانية قبل إعادة الطلب.`
      );
      return true;
    }

    cooldowns.set(cooldownKey, now + 60000); // 60s cooldown

    await reply(
      broker,
      lang === "en"
        ? "⏳ Compiling agency inventory spreadsheet... You will receive the .xlsx file shortly."
        : "⏳ جاري استخراج شيت إكسيل بمخزون الوكالة... سيتم إرسال الملف مباشرة."
    );

    // Asynchronously generate and send
    setImmediate(async () => {
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

        await WA.sendWhatsAppDocument(
          broker.phone_normalized,
          buf,
          `Inventory_${new Date().toISOString().slice(0, 10)}.xlsx`,
          lang === "en"
            ? "📊 Full Agency Inventory Report"
            : "📊 تقرير مخزون الوكالة المعتمد"
        );
      } catch (err) {
        console.error("Export failure:", err);
        cooldowns.delete(cooldownKey); // UX: Release cooldown on crash
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

  // 3. LIFECYCLE: STATUS UPDATES (Sold, Archived, Reactivate) (LFC-01, LFC-02, LFC-03)
  const statusMatch = raw.match(
    /^(تم البيع|مباع|sold|ارشفة|أرشفة|archive|تفعيل|نشط|active)(?:\s+(.+))?$/i
  );
  if (statusMatch) {
    const action = statusMatch[1].toLowerCase();
    const targetCode = resolveTargetCode(statusMatch[2]);

    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code (e.g., `sold NOLL-101`)."
          : "⚠️ يرجى تحديد كود الوحدة (مثال: `مباع NOLL-101`)."
      );
      return true;
    }

    let newStatus = "active";
    if (["تم البيع", "مباع", "sold"].includes(action)) newStatus = "sold";
    else if (["ارشفة", "أرشفة", "archive"].includes(action))
      newStatus = "archived";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)",
        [String(broker.agency_id), targetCode]
      );

      const { rows } = await client.query(
        "SELECT id, broker_id, code, status FROM listings WHERE agency_id = $1 AND UPPER(code) = $2 FOR UPDATE",
        [broker.agency_id, targetCode]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? `🔍 Unit #${targetCode} was not found.`
            : `🔍 الوحدة #${targetCode} غير موجودة.`
        );
        return true;
      }

      const listing = rows[0];
      if (!canEdit(broker, listing)) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? "⛔ You are not authorized to update this listing."
            : "⛔ ليس لديك صلاحية تعديل حالة هذه الوحدة."
        );
        return true;
      }

      await client.query(
        "UPDATE listings SET status = $1, flyer_cache = '{}'::jsonb, updated_at = NOW() WHERE id = $2",
        [newStatus, listing.id]
      );

      await client.query("COMMIT");

      const statusLabels = {
        active: { ar: "نشطة ومتاحة في البحث", en: "active and searchable" },
        sold: { ar: "تم البيع", en: "sold" },
        archived: { ar: "مؤرشفة ومخفية من البحث", en: "archived" }
      };

      await reply(
        broker,
        lang === "en"
          ? `✅ Status for unit #${listing.code} changed to *${statusLabels[newStatus].en}*.`
          : `✅ تم تغيير حالة الوحدة #${listing.code} إلى: *${statusLabels[newStatus].ar}*.`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

  // 4. DELETION: REQUEST WITH ADVISORY & ROW-LOCKING (DEL-01)
  const deleteMatch = raw.match(/^(حذف|delete|مسح)(?:\s+(.+))?$/i);
  if (deleteMatch) {
    const targetCode = resolveTargetCode(deleteMatch[2]);
    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code to delete (e.g., `delete NOLL-101`)."
          : "⚠️ يرجى تحديد كود الوحدة للحذف (مثال: `حذف NOLL-101`)."
      );
      return true;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)",
        [String(broker.agency_id), targetCode]
      );

      const { rows } = await client.query(
        "SELECT id, broker_id, code FROM listings WHERE agency_id = $1 AND UPPER(code) = $2 FOR UPDATE",
        [broker.agency_id, targetCode]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? `🔍 Unit #${targetCode} was not found.`
            : `🔍 الوحدة #${targetCode} غير موجودة.`
        );
        return true;
      }

      const listing = rows[0];
      if (!canEdit(broker, listing)) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? "⛔ You do not have permission to delete this listing."
            : "⛔ ليس لديك صلاحية لحذف هذه الوحدة."
        );
        return true;
      }

      await client.query("COMMIT");

      // Interactive prompt with strictly <= 20 char button titles
      const promptBody =
        lang === "en"
          ? `⚠️ Are you sure you want to permanently delete unit #${listing.code}? Media and brochures will be unlinked.`
          : `⚠️ هل أنت متأكد من رغبتك في حذف الوحدة #${listing.code} نهائياً؟ سيتم مسح كافة ملفات البروشور والوسائط.`;

      await WA.sendWhatsAppButtons(broker.phone_normalized, promptBody, [
        {
          id: `del_confirm:${listing.id}:${listing.code}`,
          title: lang === "en" ? "Delete 🗑️" : "تأكيد الحذف 🗑️"
        },
        {
          id: `del_cancel:${listing.code}`,
          title: lang === "en" ? "Cancel ❌" : "تراجع ❌"
        }
      ]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

  // 5. INLINE DIRECT PRICE EDIT (EDT-03, EDT-04, EDT-05)
  const priceEditMatch = raw.match(
    /^(?:تعديل\s+)?(?:سعر|price)\s+([A-Za-z0-9_-]+)\s+(?:الى|إلى|to\s+)?(.+)$/i
  );
  if (priceEditMatch) {
    const targetCode = priceEditMatch[1].toUpperCase();
    const rawPrice = priceEditMatch[2];

    const parsedPriceResult = T.parseEgyptianPrice(rawPrice);
    const numericPrice = parsedPriceResult?.priceValue;

    if (!numericPrice || numericPrice <= 0) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Invalid price format. Example: `price NOLL-101 8.5M`"
          : "⚠️ صيغة السعر غير صحيحة. مثال: `سعر NOLL-101 8.5 مليون`"
      );
      return true;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)",
        [String(broker.agency_id), targetCode]
      );

      const { rows } = await client.query(
        "SELECT * FROM listings WHERE agency_id = $1 AND UPPER(code) = $2 FOR UPDATE",
        [broker.agency_id, targetCode]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? `🔍 Unit #${targetCode} not found.`
            : `🔍 الوحدة #${targetCode} غير موجودة.`
        );
        return true;
      }

      const listing = rows[0];
      if (!canEdit(broker, listing)) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? "⛔ Not authorized."
            : "⛔ ليس لديك صلاحية تعديل هذه الوحدة."
        );
        return true;
      }

      // EDT-04: DEVELOPER MODEL GUARD
      if (
        listing.is_primary_developer ||
        listing.inventory_type === "developer_model"
      ) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? "⚠️ Developer inventory prices cannot be edited directly due to certified payment matrices. Please re-upload the updated project sheet."
            : "⚠️ لا يمكن تعديل أسعار مشاريع المطورين مباشرة لارتباطها بجدول أقساط معتمد. يرجى رفع شيت الأسعار المحدث."
        );
        return true;
      }

      // EDT-05: FULL CASCADE MUTATION
      const formattedPriceDisplay = T.formatAbbreviatedPrice(
        numericPrice,
        parsedPriceResult.currency || "EGP",
        lang,
        listing.listing_type
      );
      const updatedDetails = {
        ...(listing.details || {}),
        price_display: formattedPriceDisplay,
        currency:
          parsedPriceResult.currency || listing.details?.currency || "EGP"
      };

      // Re-synthesize Titles & Trigram
      const newArTitle = `${listing.property_type || "وحدة"} ${
        listing.area_value || ""
      }م² في ${
        listing.compound || listing.location || ""
      } - ${formattedPriceDisplay}`.trim();
      const newEnTitle = `${listing.property_type || "Unit"} ${
        listing.area_value || ""
      }sqm in ${
        listing.details?.compound_en || listing.compound || ""
      } - ${formattedPriceDisplay}`.trim();
      updatedDetails.title_en = newEnTitle;

      const fullSearchCorpus = `${targetCode} ${newArTitle} ${newEnTitle} ${
        listing.compound || ""
      } ${listing.district || ""} ${listing.city || ""}`;

      await client.query(
        `UPDATE listings SET
           price_value = $1,
           price_display = $2,
           title = $3,
           details = $4,
           search_text_normalized = clean_arabic_text($5),
           flyer_cache = '{}'::jsonb,
           updated_at = NOW()
         WHERE id = $6`,
        [
          numericPrice,
          formattedPriceDisplay,
          newArTitle,
          updatedDetails,
          fullSearchCorpus,
          listing.id
        ]
      );

      await client.query("COMMIT");

      await reply(
        broker,
        lang === "en"
          ? `✅ Price for unit #${listing.code} updated to *${formattedPriceDisplay}*. Brochure cache invalidated.`
          : `✅ تم تعديل سعر الوحدة #${listing.code} إلى *${formattedPriceDisplay}*. تم تحديث فهارس البحث ومسح كاش البروشور القديم.`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

  // Not handled by commands router; fallthrough to search/text pipeline
  return false;
}

module.exports = {
  handleCommand
};
