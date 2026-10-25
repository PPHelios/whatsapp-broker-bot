// routes/interactive.js — Interactive Button & List Menu Callbacks Router
"use strict";

const T = require("../lib/text");
const ShareLinks = require("../lib/shareLinks");
const U = require("../lib/util");
const Drafts = require("../lib/drafts");
const financials = require("../lib/financials");
const {
  reply,
  replyForClient,
  replyButtons,
  replyList,
  replyDocument,
  allowSilentDrop
} = require("../lib/dispatcher");

const { canEdit } = require("../lib/authz");
const Edits = require("../lib/edits");
const { quickSections } = require("../lib/buttons");
const { t } = require("../lib/copy");
const LeadIntake = require("../lib/leadIntake");
const DealsWA = require("../lib/deals");

/**
 * Non-blocking operational telemetry logging helper.
 */
async function logInteractiveOp(
  pool,
  {
    agency_id,
    broker_id,
    listing_code = null,
    operation_type,
    status = "success",
    error_code = null,
    total_duration_ms = 0,
    metadata = {}
  }
) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO operation_logs (
        agency_id, broker_id, listing_code, operation_type,
        status, error_code, total_duration_ms, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        agency_id || null,
        broker_id || null,
        listing_code || null,
        operation_type,
        status,
        error_code,
        Math.round(total_duration_ms),
        JSON.stringify(metadata)
      ]
    );
  } catch (e) {
    console.warn("Operation telemetry log warning:", e.message);
  }
}

/**
 * Interactive Button & List Menu Callbacks Router (CRD-01, DEL-01 - DEL-05, SCH-02)
 */
async function handleInteractive(broker, message, ctx) {
  const startTime = Date.now();
  const { pool, lang, recentButtonClicks, cooldowns, S } = ctx;
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
  if (recentButtonClicks && recentButtonClicks.get(clickKey) > now) {
    allowSilentDrop("button_debounce");
    return "done";
  }
  if (recentButtonClicks) {
    recentButtonClicks.set(clickKey, now + 3000);
  }

  // CRM lead buttons (ld:*): each reloads the lead and checks rights (lib/leadIntake.js).
  if (await LeadIntake.handleButton(broker, replyId, ctx)) return "done";
  // Deal review buttons (dl:*): the deal waits server-side (lib/deals.js).
  if (await DealsWA.handleButton(broker, replyId, ctx)) return "done";

  // 2. DISCARD DRAFT (DRAFT_CANCEL / draft_cancel)
  if (replyId === "DRAFT_CANCEL" || replyId === "draft_cancel") {
    await pool.query(
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type IN ('draft', 'edit')",
      [broker.id]
    );

    logInteractiveOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "draft_discard",
      total_duration_ms: Date.now() - startTime
    });

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

  // Answer to the review's "is the rest paid in installments?" question.
  if (replyId === "draft_inst_yes" || replyId === "draft_inst_no") {
    return await Drafts.answerInstallments(broker, ctx, replyId === "draft_inst_yes");
  }

  // 5. DRAFT: review (DRAFT_SAVE / draft_save_exit) or commit the staged review (draft_confirm)
  if (
    replyId === "DRAFT_SAVE" ||
    replyId === "draft_confirm" ||
    replyId === "draft_save_exit"
  ) {
    const draft = await Drafts.getDraft(pool, broker.id, "draft");

    if (!draft) {
      await reply(
        broker,
        lang === "en"
          ? "⏳ Draft session expired. Please send photos or text to start a new listing."
          : "⏳ انتهت صلاحية المسودة (15 دقيقة بدون نشاط). يرجى بدء إضافة جديدة بإرسال الصور أو المواصفات."
      );
      return "done";
    }

    const mediaCount = draft.media_items?.length || 0;
    const textCount = draft.text_notes?.length || 0;
    const voiceCount = draft.voice_buffers?.length || 0;

    // ING-05: Image-only blocker
    if (textCount === 0 && voiceCount === 0) {
      await replyButtons(
        broker,
        lang === "en"
          ? `⚠️ Cannot save with images only (${mediaCount} photos). Please send a voice note or text with the price and compound.`
          : `⚠️ لا يمكن تسجيل الوحدة بالصور فقط (${mediaCount} صور). يرجى إرسال فويس نوت أو رسالة تحتوي على السعر والمشروع.`,
        [
          {
            id: "DRAFT_SAVE",
            title: lang === "en" ? "Review ✅" : "مراجعة ✅"
          },
          {
            id: "draft_cancel",
            title: lang === "en" ? "Cancel ❌" : "إلغاء ❌"
          }
        ]
      );
      return "done";
    }

    // DRF-03: only a staged review is ever committed; without one, review first (A2).
    if (replyId === "draft_confirm" && draft.staged_review?.ok) {
      return await Drafts.commitStagedReview(broker, ctx);
    }
    return await Drafts.reviewDraft(broker, ctx);
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

      // SEC-03: Acquire 64-bit transactional advisory lock
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
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

      const listing = rows[0];
      if (!canEdit(broker, listing)) {
        await client.query("ROLLBACK");
        await reply(
          broker,
          lang === "en"
            ? "⛔ You do not have permission to delete this listing."
            : "⛔ ليس لديك صلاحية لحذف هذه الوحدة."
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

      logInteractiveOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        listing_code: listingCode,
        operation_type: "listing_delete",
        total_duration_ms: Date.now() - startTime
      });

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

  // 7. CLIENT AD COPY (DEL-02)
  if (replyId.startsWith("client_copy:") || replyId.startsWith("client:")) {
    const code = T.extractCleanCode(replyId.split(":")[1]);
    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, code]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en" ? "🔍 Listing not found." : "🔍 الوحدة غير موجودة."
      );
      return "done";
    }

    const listing = rows[0];
    const copyText = await ShareLinks.clientCopyWithLink(pool, broker, listing, lang, T.formatClientListingText(listing, broker, lang));
    await replyForClient(broker, copyText, { lang });
    return "done";
  }

  // 8. ON-DEMAND BROCHURE GENERATION (DEL-01)
  if (replyId.startsWith("flyer:")) {
    const [, flyerLang, theme, rawCode] = replyId.split(":");
    const code = T.extractCleanCode(rawCode);
    const cooldownKey = `flyer:${broker.agency_id}:${code}`;

    if (cooldowns && cooldowns.get(cooldownKey) > now) {
      await reply(
        broker,
        lang === "en"
          ? "⏳ A brochure for this unit is already generating. Please wait."
          : "⏳ جاري إعداد البروشور لهذه الوحدة بالفعل. يرجى الانتظار ثوانٍ معدودة."
      );
      return "done";
    }
    if (cooldowns) {
      cooldowns.set(cooldownKey, now + 20000); // 20s cooldown
    }

    // One message: the flyer itself (the typing indicator covers the render).
    const Flyer = require("../lib/flyer");
    return await Flyer.renderFlyerOnDemand(broker, code, flyerLang, theme, ctx);
  }

  // 9. DEVELOPER INSTALLMENT MATRIX OVERVIEW (DEL-03)
  if (replyId.startsWith("plans_view:") || replyId.startsWith("plans_all:")) {
    const code = T.extractCleanCode(replyId.split(":")[1]);
    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, code]
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

    await replyList(
      broker,
      lang === "en"
        ? `💳 Approved payment schedules for #${listing.code}. Select a plan to generate forwardable client copy:`
        : `💳 مصفوفة أنظمة السداد المعتمدة لوحدة #${listing.code}. اختر النظام لإصدار نص العميل المباشر:`,
      lang === "en" ? "View Plans" : "عرض الأنظمة",
      sections
    );

    return "done";
  }

  // 10. SELECT SPECIFIC PAYMENT PLAN -> FORWARDABLE CLIENT COPY
  if (replyId.startsWith("plan_select:") || replyId.startsWith("plan_view:")) {
    const parts = replyId.split(":");
    const code = T.extractCleanCode(parts[1]);
    const selectedPlanId = parts[2];

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, code]
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
    const code = T.extractCleanCode(replyId.split(":")[1]);
    const { rows: listings } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, code]
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

        const sent = await replyDocument(
          broker,
          buffer,
          `Payment_Plans_${listing.code}.xlsx`,
          lang === "en"
            ? `📊 Payment Matrix: Unit #${listing.code}`
            : `📊 جدول مقارنة أنظمة السداد: الوحدة #${listing.code}`
        );
        if (!sent) throw new Error("Payment plans workbook delivery failed");
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

  // 12. EDIT FROM A CARD (EDT-01) and the staged edit buttons
  if (replyId.startsWith("edit:")) {
    return await Edits.startEdit(broker, T.extractCleanCode(replyId.split(":")[1]), ctx);
  }
  if (replyId === "edit_review") return await Edits.reviewEdit(broker, ctx);
  if (replyId === "edit_confirm") return await Edits.confirmEdit(broker, ctx);
  if (replyId === "edit_cancel") return await Edits.cancelEdit(broker, ctx);

  // 12b. QUICK UPDATES: menu (qu_menu:CODE) and actions (qu:sold|available|archive|edit:CODE)
  if (replyId.startsWith("qu_menu:")) {
    const code = T.extractCleanCode(replyId.split(":")[1]);
    await replyList(broker, t("quick_menu", lang, { code }), lang === "en" ? "Choose" : "اختار", quickSections(code, lang));
    return "done";
  }
  if (replyId.startsWith("qu:")) {
    const [, action, rawCode] = replyId.split(":");
    const code = T.extractCleanCode(rawCode);
    if (action === "edit") return await Edits.startEdit(broker, code, ctx);
    if (["sold", "available", "archive"].includes(action)) return await Edits.quickUpdate(broker, { action, code }, ctx);
  }

  // 13. CANCEL DRAFT AND EXECUTE SEARCH (COL-01)
  if (replyId === "cancel_and_search" || replyId.startsWith("cancel_and_search:")) {
    let queryText = "";
    if (replyId === "cancel_and_search") {
      const { rows: pending } = await pool.query(
        `DELETE FROM broker_sessions
         WHERE broker_id = $1 AND session_type = 'pending_search' AND expires_at > NOW()
         RETURNING session_data->>'query' AS query`,
        [broker.id]
      );
      queryText = pending[0]?.query || "";
    } else {
      // Legacy buttons sent before the query moved server-side carried it base64-encoded.
      try {
        queryText = Buffer.from(replyId.split(":")[1], "base64").toString("utf8");
      } catch (e) {
        console.warn("Base64 query decode error:", e);
      }
    }

    await pool.query(
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = 'draft'",
      [broker.id]
    );

    if (!queryText.trim()) {
      await reply(
        broker,
        lang === "en"
          ? "🗑️ Draft cancelled. Please type your search query."
          : "🗑️ تم إلغاء المسودة. يرجى كتابة مواصفات البحث المطلوبة."
      );
      return "done";
    }

    if (S && S.handleSearchMessage) {
      return await S.handleSearchMessage(broker, queryText.trim(), ctx);
    }
    return "done";
  }

  // 14. EXPORT INVENTORY VIA BUTTON (STATS-01 / DEL-06)
  if (replyId === "cmd:export" || replyId === "cmd_export") {
    const cooldownKey = `export:${broker.id}`;
    if (cooldowns && cooldowns.get(cooldownKey) > now) {
      const waitSec = Math.ceil((cooldowns.get(cooldownKey) - now) / 1000);
      await reply(
        broker,
        lang === "en"
          ? `⏳ Export is cooling down. Please wait ${waitSec}s before requesting again.`
          : `⏳ عذراً، تم طلب تصدير الشيت منذ قليل. يرجى الانتظار ${waitSec} ثانية قبل إعادة الطلب.`
      );
      return "done";
    }

    if (cooldowns) {
      cooldowns.set(cooldownKey, now + 60000);
    }

    await reply(
      broker,
      lang === "en"
        ? "⏳ Compiling agency inventory spreadsheet... You will receive the .xlsx file shortly."
        : "⏳ جاري استخراج شيت إكسيل بمخزون الوكالة... سيتم إرسال الملف مباشرة."
    );

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

        const sent = await replyDocument(
          broker,
          buf,
          `Inventory_${new Date().toISOString().slice(0, 10)}.xlsx`,
          lang === "en"
            ? "📊 Full Agency Inventory Report"
            : "📊 تقرير مخزون الوكالة المعتمد"
        );
        if (!sent) throw new Error("Inventory workbook delivery failed");
      } catch (err) {
        console.error("Interactive export failure:", err);
        if (cooldowns) cooldowns.delete(cooldownKey);
        await reply(
          broker,
          lang === "en"
            ? "❌ Failed to generate the inventory spreadsheet. Please try again later."
            : "❌ تعذر إنشاء ملف الإكسيل حالياً. يرجى إعادة المحاولة لاحقاً."
        );
      }
    });

    return "done";
  }

  // 15. OPEN NEW DRAFT VIA BUTTON (DRF-01)
  if (replyId === "cmd:add" || replyId === "cmd_add") {
    await Drafts.createDraft(
      pool,
      broker.id,
      broker.agency_id,
      broker.phone_normalized || broker.phone_number,
      "draft"
    );
    await reply(
      broker,
      lang === "en"
        ? "📝 New listing draft opened. Send photos, voice notes, or details, and type *done* when finished."
        : "📝 تم فتح مسودة وحدة جديدة. أرسل الصور، التسجيلات الصوتية، أو التفاصيل واكتب «تم» عند الانتهاء."
    );
    return "done";
  }

  // 16. SEARCH PAGINATION (SCH-02): next page from the id snapshot (B1).
  // session_type = 'search_state' holds { ids, offset, total } (lib/search.js handleMore).
  if (replyId === "MORE_SEARCH" || replyId.startsWith("search_more:")) {
    return await S.handleMore(broker, ctx);
  }

  // 17. Unrecognized or Stale Button ID
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
