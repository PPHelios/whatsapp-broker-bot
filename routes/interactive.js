// routes/interactive.js — Interactive Button & List Menu Callbacks Router
"use strict";

const WA = require("../lib/whatsapp");
const T = require("../lib/text");
const U = require("../lib/util");
const financials = require("../lib/financials");
const { reply, allowSilentDrop } = require("../lib/dispatcher");

/**
 * Interactive Button & List Menu Callbacks Router (CRD-01, DEL-01 - DEL-05)
 */
async function handleInteractive(broker, message, ctx) {
  const { pool, lang, recentButtonClicks, cooldowns } = ctx;
  const replyObj = message.interactive;

  const replyId =
    replyObj?.button_reply?.id || replyObj?.list_reply?.id || replyObj?.id;

  if (!replyId) {
    await reply(
      broker,
      lang === "en"
        ? "⚠️ Invalid action selected."
        : "⚠️ تم تحديد إجراء غير صالح."
    );
    return "done";
  }

  // 1. Debounce Trap (3 seconds per broker + button ID)
  const clickKey = `${broker.phone_normalized}:${replyId}`;
  const now = Date.now();
  if (recentButtonClicks.get(clickKey) > now) {
    allowSilentDrop("button_debounce");
    return "done";
  }
  recentButtonClicks.set(clickKey, now + 3000);

  // 2. DISCARD DRAFT (DRAFT_CANCEL)
  if (replyId === "DRAFT_CANCEL") {
    await pool.query(
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type IN ('draft', 'edit')",
      [broker.id]
    );
    await reply(
      broker,
      lang === "en"
        ? "🗑️ Draft discarded successfully."
        : "🗑️ تم إلغاء المسودة وتفريغ البيانات بنجاح."
    );
    return "done";
  }

  // 3. EDIT DRAFT INSTRUCTIONS (DRAFT_EDIT / draft_edit)
  if (replyId === "DRAFT_EDIT" || replyId === "draft_edit") {
    await reply(
      broker,
      lang === "en"
        ? "✏️ *Edit Draft Mode:*\nSend your adjustments via voice note or text (e.g., `price 9.5M` or `3 bedrooms`), then type *done* to review."
        : "✏️ *تعديل بيانات المسودة:*\nأرسل التعديلات المطلوبة في رسالة أو فويس نوت (مثال: `السعر 9.5 مليون` أو `3 غرف`)، ثم اكتب *«تم»* لإعادة المراجعة."
    );
    return "done";
  }

  // 4. CANCEL DELETION ACTION (del_cancel)
  if (replyId.startsWith("del_cancel:") || replyId === "CANCEL_ACTION") {
    const code = replyId.startsWith("del_cancel:")
      ? replyId.split(":")[1]
      : null;
    await reply(
      broker,
      lang === "en"
        ? `❌ Deletion cancelled${
            code ? ` for unit #${code}` : ""
          }. Your inventory remains active.`
        : `❌ تم التراجع عن الحذف${
            code ? ` للوحدة #${code}` : ""
          }. الوحدة ما زالت نشطة بمخزونك.`
    );
    return "done";
  }

  // 5. FINALIZE & SAVE DRAFT (DRAFT_SAVE / draft_confirm)
  if (replyId === "DRAFT_SAVE" || replyId === "draft_confirm") {
    const { rows: sessions } = await pool.query(
      "SELECT session_data, expires_at FROM broker_sessions WHERE broker_id = $1 AND session_type = 'draft'",
      [broker.id]
    );

    if (
      sessions.length === 0 ||
      new Date(sessions[0].expires_at) <= new Date()
    ) {
      await reply(
        broker,
        lang === "en"
          ? "⏳ Draft session expired. Please send photos or text to start a new listing."
          : "⏳ انتهت صلاحية المسودة (15 دقيقة بدون نشاط). يرجى بدء إضافة جديدة بإرسال الصور أو المواصفات."
      );
      return "done";
    }

    const draft = sessions[0].session_data;
    const mediaCount = draft.media_items?.length || 0;
    const textCount = draft.text_notes?.length || 0;
    const voiceCount = draft.voice_buffers?.length || 0;

    // ING-05: Image-only blocker
    if (textCount === 0 && voiceCount === 0) {
      await WA.sendWhatsAppButtons(
        broker.phone_normalized,
        lang === "en"
          ? `⚠️ Cannot save with images only (${mediaCount} photos). Please send a voice note or text with the price and compound.`
          : `⚠️ لا يمكن تسجيل الوحدة بالصور فقط (${mediaCount} صور). يرجى إرسال فويس نوت أو رسالة تحتوي على السعر والمشروع.`,
        [
          {
            id: "DRAFT_SAVE",
            title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
          },
          {
            id: "DRAFT_CANCEL",
            title: lang === "en" ? "Cancel ❌" : "إلغاء ❌"
          }
        ]
      );
      return "done";
    }

    await reply(
      broker,
      lang === "en"
        ? "⏳ Committing listing to cloud storage and database..."
        : "⏳ جاري حفظ الوحدة، رفع الصور، وتحديث سجلات المخزون..."
    );

    // Dynamic commit execution with built-in double-tap protection
    const Drafts = require("../lib/drafts");
    return await Drafts.commitDraftToDatabase(broker, draft, ctx);
  }

  // 6. DELETION CONFIRMATION WITH 64-BIT ADVISORY LOCK (DEL-02)
  if (replyId.startsWith("del_confirm:")) {
    const parts = replyId.split(":");
    const listingId = parts[1];
    const listingCode = parts[2] ? parts[2].toUpperCase() : "";

    const client = await pool.connect();
    let imagesToPurge = [];

    try {
      await client.query("BEGIN");

      // SEC-03: Acquire 64-bit transactional advisory lock matching ARCHITECTURE_MANIFEST invariant
      await client.query(
        "SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)",
        [String(broker.agency_id), listingCode]
      );

      // Verify row lock & ownership
      const { rows } = await client.query(
        "SELECT id, broker_id, code FROM listings WHERE id = $1 AND agency_id = $2 FOR UPDATE",
        [listingId, broker.agency_id]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? "⚠️ Listing was already deleted."
            : "⚠️ هذه الوحدة محذوفة بالفعل أو غير متاحة."
        );
        return "done";
      }

      // Collect storage file paths for asynchronous deletion
      const { rows: imgRows } = await client.query(
        "SELECT url FROM listing_images WHERE listing_id = $1",
        [listingId]
      );
      imagesToPurge = imgRows.map((r) => r.url);

      // Cascading row deletion
      await client.query("DELETE FROM listings WHERE id = $1", [listingId]);
      await client.query("COMMIT");

      // Asynchronous, non-blocking storage cleanup (SEC-04)
      if (imagesToPurge.length > 0) {
        setImmediate(async () => {
          try {
            const Supabase = require("../lib/supabase");
            await Supabase.deleteStorageFiles(imagesToPurge);
          } catch (storageErr) {
            console.error("Non-blocking storage file purge error:", storageErr);
          }
        });
      }

      await reply(
        broker,
        lang === "en"
          ? `🗑️ Unit #${listingCode} and its media assets have been permanently deleted.`
          : `🗑️ تم حذف الوحدة #${listingCode} نهائياً ومسح كافة وسائطها وملفاتها من السيرفر.`
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return "done";
  }

  // 7. CLIENT AD COPY (DEL-04)
  if (replyId.startsWith("client_copy:") || replyId.startsWith("client:")) {
    const code = replyId.split(":")[1];
    const { rows } = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND UPPER(code) = $2",
      [broker.agency_id, code.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en" ? "🔍 Listing not found." : "🔍 الوحدة غير موجودة."
      );
      return "done";
    }

    const listing = rows[0];
    const copyText = T.formatClientListingText(listing, broker, lang);
    await reply(broker, copyText);
    return "done";
  }

  // 8. ON-DEMAND BROCHURE GENERATION (DEL-01 / DEL-03)
  if (replyId.startsWith("flyer:")) {
    const [, flyerLang, theme, code] = replyId.split(":");
    const cooldownKey = `flyer:${broker.agency_id}:${code}`;

    if (cooldowns.get(cooldownKey) > now) {
      await reply(
        broker,
        lang === "en"
          ? "⏳ A brochure for this unit is already generating. Please wait."
          : "⏳ جاري إعداد البروشور لهذه الوحدة بالفعل. يرجى الانتظار ثوانٍ معدودة."
      );
      return "done";
    }
    cooldowns.set(cooldownKey, now + 20000); // 20s cooldown

    await reply(
      broker,
      lang === "en"
        ? `⏳ Rendering luxury brochure for unit #${code}... Estimated time: 4 to 7 seconds.`
        : `⏳ جاري تجهيز وتصميم الكتالوج المعتمد للوحدة #${code}... الوقت المتوقع: 4 إلى 7 ثوانٍ.`
    );

    const Flyer = require("../lib/flyer");
    return await Flyer.renderFlyerOnDemand(broker, code, flyerLang, theme, ctx);
  }

  // 9. DEVELOPER INSTALLMENT MATRIX OVERVIEW (DEL-05)
  if (replyId.startsWith("plans_view:") || replyId.startsWith("plans_all:")) {
    const code = replyId.split(":")[1];
    const { rows } = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND UPPER(code) = $2",
      [broker.agency_id, code.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en" ? "🔍 Listing not found." : "🔍 الوحدة غير موجودة."
      );
      return "done";
    }

    const listing = rows[0];
    const plans = listing.payment_terms?.plans || [];

    if (plans.length === 0) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ No staged payment plans recorded for this unit."
          : "⚠️ لا توجد خطط تقسيط مسجلة لهذه الوحدة."
      );
      return "done";
    }

    // Build Forwardable Interactive List Menu (up to 10 plans)
    const sections = [
      {
        title:
          lang === "en" ? "Available Payment Plans" : "أنظمة السداد المعتمدة",
        rows: plans.slice(0, 10).map((p, idx) => ({
          id: `plan_select:${listing.code}:${p.plan_id || idx}`,
          title: (p.name_ar || p.name_en || `خطة ${p.years} سنوات`).slice(
            0,
            24
          ),
          description:
            `مقدم ${p.down_payment_pct}% - قسط ربع سنوي ${p.years} سنوات`.slice(
              0,
              72
            )
        }))
      }
    ];

    await WA.sendWhatsAppList(
      broker.phone_normalized,
      lang === "en"
        ? `💳 Approved payment schedules for #${listing.code}. Select a plan to generate forwardable client copy:`
        : `💳 مصفوفة أنظمة السداد المعتمدة لوحدة #${listing.code}. اختر النظام لإصدار نص العميل المباشر:`,
      lang === "en" ? "View Plans" : "عرض الأنظمة",
      sections
    );

    return "done";
  }

  // 10. SELECT SPECIFIC PAYMENT PLAN -> FORWARDABLE CLIENT COPY (UX DEAD-END FIX)
  if (replyId.startsWith("plan_select:") || replyId.startsWith("plan_view:")) {
    const parts = replyId.split(":");
    const code = parts[1];
    const selectedPlanId = parts[2];

    const { rows } = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND UPPER(code) = $2",
      [broker.agency_id, code.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en" ? "🔍 Listing not found." : "🔍 الوحدة غير موجودة."
      );
      return "done";
    }

    const listing = rows[0];
    const planAdCopy = financials.formatSinglePlanAdCopy(
      listing,
      broker,
      selectedPlanId,
      lang
    );

    if (!planAdCopy) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Plan details could not be formatted."
          : "⚠️ تعذر تنسيق تفاصيل خطة السداد المحددة."
      );
      return "done";
    }

    await reply(broker, planAdCopy);
    return "done";
  }

  // 11. MULTI-PLAN EXCEL COMPARISON EXPORT (DEL-04)
  if (replyId.startsWith("compare_excel:")) {
    const code = replyId.split(":")[1];
    const { rows: listings } = await pool.query(
      "SELECT * FROM listings WHERE agency_id = $1 AND UPPER(code) = $2",
      [broker.agency_id, code.toUpperCase()]
    );

    if (listings.length === 0) {
      await reply(
        broker,
        lang === "en" ? "🔍 Listing not found." : "🔍 الوحدة غير موجودة."
      );
      return "done";
    }

    const listing = listings[0];
    const plans = listing.payment_terms?.plans || [];

    if (plans.length === 0) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ No payment plans available to export for this unit."
          : "⚠️ لا توجد خطط تقسيط متاحة للتصدير لهذه الوحدة."
      );
      return "done";
    }

    await reply(
      broker,
      lang === "en"
        ? `⏳ Compiling multi-plan comparison workbook for #${listing.code}...`
        : `⏳ جاري إنشاء ملف المقارنة وجداول السداد للوحدة #${listing.code}...`
    );

    setImmediate(async () => {
      try {
        const { rows: agencies } = await pool.query(
          "SELECT * FROM agencies WHERE id = $1",
          [broker.agency_id]
        );
        const Excel = require("../lib/excel");
        const buffer = await Excel.buildMultiPlanWorkbook({
          listing,
          plans,
          agency: agencies[0],
          broker,
          lang
        });

        await WA.sendWhatsAppDocument(
          broker.phone_normalized,
          buffer,
          `Payment_Plans_${listing.code}.xlsx`,
          lang === "en"
            ? `📊 Payment Matrix: Unit #${listing.code}`
            : `📊 جدول مقارنة أنظمة السداد: الوحدة #${listing.code}`
        );
      } catch (excelErr) {
        console.error("Multi-plan excel export error:", excelErr);
        await reply(
          broker,
          lang === "en"
            ? "❌ Failed to generate payment schedule workbook."
            : "❌ تعذر إنشاء ملف مقارنة أنظمة السداد."
        );
      }
    });

    return "done";
  }

  // 12. Unrecognized or Stale Button ID
  await reply(
    broker,
    lang === "en"
      ? "⚠️ This button has expired or is invalid. Please type the unit code to view current options."
      : "⚠️ هذا الزر غير صالح أو انتهت صلاحية جلسته. يرجى كتابة كود الوحدة مجدداً لعرض الخيارات المتاحة."
  );
  return "done";
}

module.exports = {
  handleInteractive
};
