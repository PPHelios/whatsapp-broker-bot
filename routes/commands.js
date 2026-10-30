// routes/commands.js — Text Commands Controller & Lifecycle Handlers
// Telemetry and command state: routes/commandState.js · deliverables: routes/commandDeliverables.js ·
// inventory stats and export: routes/commandInventory.js.
"use strict";

const T = require("../lib/text");
const Drafts = require("../lib/drafts");
const Registry = require("../lib/registry");
const Links = require("../lib/links");
const { reply, replyButtons } = require("../lib/dispatcher");
const { canEdit } = require("../lib/authz");
const { logCommandOp, getRecentBrokerListing, setRecentBrokerListing } = require("./commandState");
const Deliver = require("./commandDeliverables");
const Inventory = require("./commandInventory");
const Vis = require("../lib/visibility");

/**
 * Text Commands Controller
 */
async function handleCommand(broker, text, ctx) {
  const startTime = Date.now();
  const { pool, lang, recentBrokerListings } = ctx;
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // Helper to resolve code explicitly or fallback to persistent session context
  const resolveTargetCode = async (explicitCode) => {
    if (explicitCode) return T.extractCleanCode(explicitCode);
    return await getRecentBrokerListing(pool, broker.id, recentBrokerListings);
  };

  // Inside an open draft, a sentence that mentions a code is unit details (B3), not a lookup;
  // only a bare code ("#HP-201") still opens that unit's card.
  const isBareCode = /^[#`\[]?[A-Za-z0-9][A-Za-z0-9_\-\.\/]{1,29}[`\]]?$/.test(raw);
  let draftOpen = null;
  const inDraft = async () => {
    if (draftOpen === null) draftOpen = Boolean(await Drafts.getDraft(pool, broker.id, "draft"));
    return draftOpen;
  };

  // 0. INTERCEPT FORWARDED / PASTED MULTI-LINE LISTING CARDS (Resolves [9:19 PM] Error)
  if (raw.includes("\n") && !(await inDraft())) {
    const done = await Deliver.handlePastedCard(broker, raw, ctx);
    if (done !== null) return done;
  }

  // 1. HELP / MENU (SYS-01)
  if (/^(مساعدة|help|اوامر|الأوامر|menu|قائمة)$/i.test(lower)) {
    const guide = lang === "en" ? `📘 Quick guide and FAQ: ${Links.guideUrl(lang)}` : `📘 الدليل السريع والأسئلة الشائعة: ${Links.guideUrl(lang)}`;
    const helpMsg = `${T.getHelpMessage(lang)}\n\n${guide}`;
    await reply(broker, helpMsg);
    logCommandOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "command_help",
      total_duration_ms: Date.now() - startTime
    });
    return true;
  }

  // 2. LANGUAGE PREFERENCE TOGGLE (SYS-02)
  const langMatch = raw.match(/^lang\s+(ar|en)|^(العربية|الإنجليزية)$/i);
  if (langMatch) {
    const newLang =
      (langMatch[1] || langMatch[2]) === "en" || langMatch[2] === "الإنجليزية"
        ? "en"
        : "ar";
    await pool.query("UPDATE brokers SET preferred_lang = $1 WHERE id = $2", [
      newLang,
      broker.id
    ]);
    await reply(
      broker,
      newLang === "en"
        ? "✅ Language preference updated to English."
        : "✅ تم تغيير لغة التفاعل إلى اللغة العربية بنجاح."
    );
    logCommandOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "command_lang_toggle",
      total_duration_ms: Date.now() - startTime,
      metadata: { newLang }
    });
    return true;
  }

  // 3. CANCEL / ABORT DRAFT (DRF-05)
  if (/^(cancel|إلغاء|الغاء|خروج|abort|exit|قفل)$/i.test(lower)) {
    await pool.query(
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type IN ('draft', 'edit', 'lead_draft', 'pending_lead')",
      [broker.id]
    );
    await reply(
      broker,
      lang === "en"
        ? "🗑️ Draft session cancelled and cleared successfully."
        : "🗑️ تم إلغاء المسودة وتفريغ البيانات بنجاح."
    );
    logCommandOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "command_draft_cancel",
      total_duration_ms: Date.now() - startTime
    });
    return true;
  }

  // 4. OPEN NEW DRAFT (DRF-01)
  if (/^(اضافة|إضافة|add|new|جديد|وحدة جديدة)$/i.test(lower)) {
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
    logCommandOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      operation_type: "command_draft_open",
      total_duration_ms: Date.now() - startTime
    });
    return true;
  }

  // 5. REGISTERED COMMANDS (lib/registry.js): quick status updates (sold / archive / available),
  //    price edits incl. "تعديل سعر CODE إلى X" (A5), edit sessions (A3), "تم" inside an edit, "المزيد".
  //    Status keywords handled there: تم البيع|مباع|sold, ارشفة|أرشفة|archive, تفعيل|نشط|active.
  if (await Registry.dispatch(broker, raw, ctx)) return true;

  // 6. DRAFT PRE-SAVE VALIDATION / FINALIZATION (DRF-02, ING-05)
  if (/^(تم|حفظ|done|save)$/i.test(lower)) {
    const { rows: drafts } = await pool.query(
      "SELECT session_data, expires_at FROM broker_sessions WHERE broker_id = $1 AND session_type = 'draft'",
      [broker.id]
    );

    if (drafts.length === 0 || new Date(drafts[0].expires_at) <= new Date()) {
      return false; // No active draft, let fallthrough
    }

    const draft = drafts[0].session_data || {};
    const mediaCount = (draft.media_items || []).length;
    const voiceCount = (draft.voice_buffers || []).length;
    const textCount = (draft.text_notes || []).length;

    // Pre-flight guard: Completely empty draft blocker
    if (mediaCount === 0 && voiceCount === 0 && textCount === 0) {
      await replyButtons(
        broker,
        lang === "en"
          ? "⚠️ Your listing draft is empty. Please send photos, voice notes, or text details, or tap cancel to abort."
          : "⚠️ مسودة الوحدة فارغة تماماً. يرجى إرسال الصور أو الملاحظات الصوتية أو التفاصيل، أو الضغط على إلغاء.",
        [
          {
            id: "draft_cancel",
            title: lang === "en" ? "Cancel ❌" : "إلغاء ❌"
          }
        ]
      );
      return true;
    }

    // ING-05: Image-only draft blocker
    if (mediaCount > 0 && voiceCount === 0 && textCount === 0) {
      await replyButtons(
        broker,
        lang === "en"
          ? `⚠️ Listing cannot be registered with photos only (${mediaCount} photos). Please send a voice note or message containing price and location.`
          : `⚠️ لا يمكن تسجيل الوحدة بالصور فقط (${mediaCount} صور). يرجى إرسال فويس نوت أو رسالة تحتوي على السعر والمشروع.`,
        [
          {
            id: "draft_confirm",
            title: lang === "en" ? "Done (Save) ✅" : "تم (حفظ) ✅"
          },
          {
            id: "draft_cancel",
            title: lang === "en" ? "Cancel ❌" : "إلغاء ❌"
          }
        ]
      );
      return true;
    }

    // DRF-02: AI extraction over every draft input, field rules, staged review card.
    return (await Drafts.reviewDraft(broker, ctx)) && true;
  }

  // 7. INVENTORY SUMMARY & STATS (STATS-01)
  if (
    /^(مخزون|المخزون|تقرير المخزون|احصائيات|إحصائيات|stats|inventory stats|summary)$/i.test(
      lower
    )
  ) {
    return await Inventory.sendInventoryStats(broker, ctx, startTime);
  }

  // 8. EXPORT INVENTORY (EXCEL) (DEL-06)
  if (/^(تصدير|export|excel|شيت|اكسل|إكسل|اكسيل|إكسيل)$/i.test(lower)) {
    return await Inventory.startInventoryExport(broker, ctx);
  }

  // 9. LIFECYCLE STATUS UPDATES: lib/registry.js (step 5 above).

  // 10. DELETION: REQUEST WITH ADVISORY & ROW-LOCKING (DEL-01)
  const deleteMatch = raw.match(/^(حذف|delete|مسح)(?:\s+(.+))?$/i);
  if (deleteMatch) {
    const targetCode = await resolveTargetCode(deleteMatch[2]);
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
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(broker.agency_id), targetCode.toUpperCase()]
      );

      const { rows } = await client.query(
        `SELECT id, broker_id, code FROM listings
         WHERE ${Vis.units("listings")} AND agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
         FOR UPDATE`,
        [broker.agency_id, targetCode.toUpperCase()]
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

      const promptBody =
        lang === "en"
          ? `⚠️ Are you sure you want to permanently delete unit #${listing.code}? Media and brochures will be unlinked.`
          : `⚠️ هل أنت متأكد من رغبتك في حذف الوحدة #${listing.code} نهائياً؟ سيتم مسح كافة ملفات البروشور والوسائط.`;

      await replyButtons(broker, promptBody, [
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

  // 11. PRICE EDITS: lib/registry.js (step 5 above); developer inventory (is_primary_developer / developer_model) is guarded in lib/edits.js.

  // 12-15. DELIVERABLES: flyer / brochure (DEL-01), client ad copy (DEL-02), payment plans (DEL-03), collateral (DEL-05).
  const delivered = await Deliver.handleDeliverableCommand(broker, raw, ctx, { resolveTargetCode, startTime });
  if (delivered !== null) return delivered;

  // 16. DIRECT UNIT CODE LOOKUP (ING-04)
  const codeParseResult = T.parseExplicitUnitCode(raw);
  if (codeParseResult.hasCode && codeParseResult.code && (isBareCode || !(await inDraft()))) {
    const targetCode = T.extractCleanCode(codeParseResult.code);

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE ${Vis.units("listings")} AND agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, targetCode.toUpperCase()]
    );

    if (rows.length > 0) {
      const listing = rows[0];
      await setRecentBrokerListing(
        pool,
        broker.id,
        listing.code,
        recentBrokerListings
      );
      return await Deliver.deliverUnitInspectionCard(listing, broker, lang, pool);
    }
  }

  // Not handled by commands router; fallthrough to search/text pipeline
  return false;
}

module.exports = {
  handleCommand
};
