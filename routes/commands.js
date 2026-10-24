// routes/commands.js — Text Commands Controller & Lifecycle Handlers
"use strict";

const T = require("../lib/text");
const U = require("../lib/util");
const Flyer = require("../lib/flyer");
const Drafts = require("../lib/drafts");
const Vision = require("../lib/vision");
const {
  reply,
  replyButtons,
  replyImage,
  replyDocument
} = require("../lib/dispatcher");

/**
 * Validates whether the broker has permission to mutate a listing.
 */
function canEdit(broker, listing) {
  if (["admin", "owner", "manager"].includes(broker.role)) return true;
  return listing.broker_id === broker.id;
}

/**
 * Asynchronous, non-blocking operational telemetry logging helper.
 */
async function logCommandOp(
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
 * Distributed Session State: Retrieves broker's most recently accessed listing code.
 */
async function getRecentBrokerListing(pool, brokerId, fallbackMap) {
  if (pool && brokerId) {
    try {
      const { rows } = await pool.query(
        `SELECT session_data->>'recent_code' AS code
         FROM broker_sessions
         WHERE broker_id = $1 AND session_type = 'session_context' AND expires_at > NOW()`,
        [brokerId]
      );
      if (rows.length && rows[0].code) return rows[0].code;
    } catch (e) {
      console.warn(
        "Failed to read recent listing from broker_sessions:",
        e.message
      );
    }
  }
  return fallbackMap?.get?.(brokerId) || null;
}

/**
 * Distributed Session State: Persists broker's most recently accessed listing code.
 */
async function setRecentBrokerListing(pool, brokerId, code, fallbackMap) {
  if (fallbackMap?.set) fallbackMap.set(brokerId, code);
  if (!pool || !brokerId || !code) return;
  try {
    await pool.query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1, 'session_context', jsonb_build_object('recent_code', $2::text), NOW() + INTERVAL '1 hour')
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         session_data = jsonb_build_object('recent_code', $2::text),
         expires_at = NOW() + INTERVAL '1 hour'`,
      [brokerId, code]
    );
  } catch (e) {
    console.warn("Failed to set recent listing in broker_sessions:", e.message);
  }
}

/**
 * Distributed Cooldown: Checks remaining cooldown in seconds.
 */
async function checkBrokerCooldown(pool, brokerId, action, fallbackMap) {
  const now = Date.now();
  if (fallbackMap) {
    const memExp = fallbackMap.get(`${action}:${brokerId}`);
    if (memExp && memExp > now) return Math.ceil((memExp - now) / 1000);
  }
  if (!pool || !brokerId) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT expires_at FROM broker_sessions
       WHERE broker_id = $1 AND session_type = $2 AND expires_at > NOW()`,
      [brokerId, `cooldown_${action}`]
    );
    if (rows.length > 0) {
      return Math.ceil((new Date(rows[0].expires_at).getTime() - now) / 1000);
    }
  } catch (e) {
    console.warn("Failed to check cooldown in DB:", e.message);
  }
  return 0;
}

/**
 * Distributed Cooldown: Persists cooldown expiration timestamp.
 */
async function setBrokerCooldown(
  pool,
  brokerId,
  action,
  windowMs,
  fallbackMap
) {
  const now = Date.now();
  if (fallbackMap) fallbackMap.set(`${action}:${brokerId}`, now + windowMs);
  if (!pool || !brokerId) return;
  try {
    await pool.query(
      `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
       VALUES ($1, $2, '{}'::jsonb, NOW() + ($3 || ' milliseconds')::interval)
       ON CONFLICT (broker_id, session_type) DO UPDATE SET
         expires_at = NOW() + ($3 || ' milliseconds')::interval`,
      [brokerId, `cooldown_${action}`, String(windowMs)]
    );
  } catch (e) {
    console.warn("Failed to set cooldown in DB:", e.message);
  }
}

/**
 * Distributed Cooldown: Releases active cooldown early (e.g. on execution crash).
 */
async function releaseBrokerCooldown(pool, brokerId, action, fallbackMap) {
  if (fallbackMap) fallbackMap.delete(`${action}:${brokerId}`);
  if (!pool || !brokerId) return;
  try {
    await pool.query(
      `DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type = $2`,
      [brokerId, `cooldown_${action}`]
    );
  } catch (e) {}
}

/**
 * Reusable Deliverable Handler: Payment Matrix / Plans (DEL-03)
 */
async function deliverPaymentPlans(listing, broker, lang, pool, ctx) {
  const plans = listing.payment_terms?.plans || [];
  if (!plans.length) {
    await reply(
      broker,
      lang === "en"
        ? `ℹ️ Unit #${listing.code} is a resale listing with cash/upfront breakdown. No developer payment schedule attached.`
        : `ℹ️ الوحدة #${listing.code} تابعة للريزيل ولا يوجد لها جدول أنظمة سداد مطورين.`
    );
    return true;
  }

  let planMsg =
    lang === "en"
      ? `💳 *Available Payment Plans for #${listing.code}*\n`
      : `💳 *أنظمة السداد المتاحة للوحدة #${listing.code}*\n`;

  plans.forEach((p, idx) => {
    planMsg += `\n*${idx + 1}. ${p.name || `${p.years} Years`}*`;
    planMsg += `\n  • ${lang === "en" ? "Down Payment" : "المقدم"}: ${
      p.down_payment_pct
    }%`;
    if (p.quarterly_amount) {
      planMsg += `\n  • ${
        lang === "en" ? "Quarterly Installment" : "القسط الربع سنوي"
      }: ${T.formatPrice(p.quarterly_amount, lang, "EGP")}`;
    }
    if (p.delivery_pct) {
      planMsg += `\n  • ${lang === "en" ? "Upon Delivery" : "دفعة الاستلام"}: ${
        p.delivery_pct
      }%`;
    }
  });

  await replyButtons(broker, planMsg, [
    {
      id: `flyer:en:dark:${listing.code}`,
      title: lang === "en" ? "Flyer 📄" : "الكتالوج 📄"
    },
    {
      id: `client:${listing.code}`,
      title: lang === "en" ? "Client Pitch 📱" : "نص العميل 📱"
    }
  ]);
  return true;
}

/**
 * Reusable Deliverable Handler: Luxury Brochure with Lazy Vision Curation (DEL-01)
 */
async function deliverFlyer(
  listing,
  isUnbranded,
  broker,
  lang,
  pool,
  cooldowns,
  ctx
) {
  const targetCode = listing.code;
  const cooldownRemaining = await checkBrokerCooldown(
    pool,
    broker.id,
    "flyer",
    cooldowns
  );

  if (cooldownRemaining > 0) {
    await reply(
      broker,
      lang === "en"
        ? `⏳ Brochure generation is cooling down. Please wait ${cooldownRemaining}s.`
        : `⏳ جاري معالجة طلب سابق. يرجى الانتظار ${cooldownRemaining} ثانية.`
    );
    return true;
  }

  await setBrokerCooldown(pool, broker.id, "flyer", 20000, cooldowns);

  const cacheKey = isUnbranded ? "unbranded" : "branded";
  const cachedUrl = listing.flyer_cache?.[cacheKey];

  if (cachedUrl) {
    const caption =
      lang === "en"
        ? `📄 Luxury Brochure for #${listing.code} (${
            isUnbranded ? "White-Label" : "Agency Branded"
          })`
        : `📄 كتالوج الوحدة #${listing.code} (${
            isUnbranded ? "بدون بيانات" : "معتمد بالبيانات"
          })`;
    await replyImage(broker, cachedUrl, caption);
    return true;
  }

  await reply(
    broker,
    lang === "en"
      ? `🎨 Generating luxury brochure for #${listing.code} (100% English)...\n⏱️ Estimated time: ~4 to 8 seconds.`
      : `🎨 جاري تصميم واعتماد الكتالوج عالي الجودة للوحدة #${listing.code} (إنجليزي 100%)...\n⏱️ الوقت المتوقع: ~4 إلى 8 ثوانٍ.`
  );

  setImmediate(async () => {
    const flyerStartTime = Date.now();
    try {
      // Lazy Vision Curation (DEL-01): Trigger curation if any listing_images have role = NULL
      await Vision.ensureListingImagesCurated(listing.id, ctx);

      // Re-fetch listing with curated image_order and hero_position
      const { rows: refreshedListings } = await pool.query(
        "SELECT * FROM listings WHERE id = $1 LIMIT 1",
        [listing.id]
      );
      const activeListing = refreshedListings[0] || listing;

      const { rows: agencyRows } = await pool.query(
        "SELECT * FROM agencies WHERE id = $1 LIMIT 1",
        [broker.agency_id]
      );
      const agency = agencyRows[0] || {};

      const flyerBuffer = await Flyer.generateFlyerBuffer({
        listing: activeListing,
        agency,
        broker: isUnbranded ? null : broker,
        lang: "en",
        unbranded: isUnbranded
      });

      if (!flyerBuffer) {
        throw new Error("Flyer buffer output was empty");
      }

      const Supabase = require("../lib/supabase");
      const storagePath = `flyers/${broker.agency_id}/${activeListing.id}/${
        isUnbranded ? "unbranded" : "branded"
      }_${Date.now()}.png`;

      const publicUrl = await Supabase.uploadFlyerImage(
        broker.agency_id,
        storagePath,
        flyerBuffer
      );

      // Update flyer_cache in listings
      const updatedCache = {
        ...(activeListing.flyer_cache || {}),
        [cacheKey]: publicUrl
      };
      await pool.query(
        "UPDATE listings SET flyer_cache = $1, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(updatedCache), activeListing.id]
      );

      await logCommandOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        listing_code: activeListing.code,
        operation_type: "flyer_render",
        total_duration_ms: Date.now() - flyerStartTime,
        metadata: { unbranded: isUnbranded, publicUrl }
      });

      const caption =
        lang === "en"
          ? `📄 Luxury Brochure for #${activeListing.code}`
          : `📄 كتالوج الوحدة #${activeListing.code}`;

      // A raw Buffer cannot be sent as an image link; a failed upload is a delivery failure.
      if (!publicUrl) throw new Error("Flyer upload returned no URL");
      const sent = await replyImage(broker, publicUrl, caption);
      if (!sent) throw new Error("Flyer image delivery failed");
    } catch (err) {
      console.error("Flyer render failure:", err);
      await releaseBrokerCooldown(pool, broker.id, "flyer", cooldowns);
      await reply(
        broker,
        lang === "en"
          ? `❌ Could not generate flyer for #${targetCode}. Please ensure unit photos are uploaded.`
          : `❌ تعذر إنشاء الكتالوج للوحدة #${targetCode}. يرجى التأكد من رفع صور كافية للوحدة.`
      );
    }
  });

  return true;
}

/**
 * Reusable Deliverable Handler: Marketing Collateral / Layout (DEL-05)
 */
async function deliverCollateral(listing, broker, lang) {
  const collateral = listing.collateral || {};
  const links = [];

  if (collateral.layout_pdf_url) {
    links.push(
      `📐 *${lang === "en" ? "2D Layout Plan" : "المخطط الهندسي"}:* ${
        collateral.layout_pdf_url
      }`
    );
  }
  if (collateral.master_plan_url) {
    links.push(
      `🗺️ *${lang === "en" ? "Master Plan" : "المخطط العام"}:* ${
        collateral.master_plan_url
      }`
    );
  }
  if (collateral.drive_folder_url) {
    links.push(
      `📁 *${lang === "en" ? "Drive Sales Kit" : "ملفات درايف"}:* ${
        collateral.drive_folder_url
      }`
    );
  }
  if (collateral.project_brochure_url) {
    links.push(
      `📖 *${lang === "en" ? "Project Brochure" : "بروشور المشروع"}:* ${
        collateral.project_brochure_url
      }`
    );
  }

  if (!links.length) {
    await reply(
      broker,
      lang === "en"
        ? `ℹ️ No external collateral or floor plans are currently linked to #${listing.code}.`
        : `ℹ️ لا توجد روابط مخططات أو ملفات درايف مسجلة للوحدة #${listing.code}.`
    );
    return true;
  }

  const header =
    lang === "en"
      ? `📁 *Sales Collateral for #${listing.code}:*\n\n`
      : `📁 *ملفات ومخططات الوحدة #${listing.code}:*\n\n`;

  await reply(broker, header + links.join("\n\n"));
  return true;
}

/**
 * Reusable Deliverable Handler: Direct Unit Code Inspection Card (ING-04)
 */
async function deliverUnitInspectionCard(listing, broker, lang) {
  const detailsCard = T.formatInternalListingDetails(listing, lang);
  const isResale = listing.inventory_type === "resale_unit";

  const buttons = [
    {
      id: `flyer:en:dark:${listing.code}`,
      title: lang === "en" ? "Flyer 📄" : "الكتالوج 📄"
    },
    {
      id: `client:${listing.code}`,
      title: lang === "en" ? "Client Copy 📱" : "نص العميل 📱"
    },
    {
      id: isResale ? `edit:${listing.code}` : `plans_view:${listing.code}`,
      title: isResale
        ? lang === "en"
          ? "Edit ✏️"
          : "تعديل ✏️"
        : lang === "en"
        ? "Plans 💳"
        : "جدول الأقساط 💳"
    }
  ];

  await replyButtons(broker, detailsCard, buttons);
  return true;
}

/**
 * Text Commands Controller
 */
async function handleCommand(broker, text, ctx) {
  const startTime = Date.now();
  const { pool, lang, recentBrokerListings, cooldowns, AI } = ctx;
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
    const codeMatch =
      raw.match(
        /(?:كود|الكود|code|unit\s*code|كود\s*الوحدة|الكود\s*الداخلي)\s*[:#]?\s*([A-Za-z0-9_\-\.\/]{3,30})/i
      ) || raw.match(/#([A-Za-z0-9_\-\.\/]{3,30})/);

    if (codeMatch) {
      const extractedCode = T.extractCleanCode(codeMatch[1]);
      const { rows: matchedUnits } = await pool.query(
        `SELECT * FROM listings
         WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
         LIMIT 1`,
        [broker.agency_id, extractedCode]
      );

      if (matchedUnits.length > 0) {
        const listing = matchedUnits[0];
        await setRecentBrokerListing(
          pool,
          broker.id,
          listing.code,
          recentBrokerListings
        );

        // Check for specific deliverable intent inside the pasted card
        if (
          /(?:جدول|انظمة\s*السداد|أنظمة\s*السداد|plans|matrix|اقساط|أقساط)/i.test(
            raw
          )
        ) {
          return await deliverPaymentPlans(listing, broker, lang, pool, ctx);
        }
        if (/(?:flyer|كتالوج|بروشور|brochure)/i.test(raw)) {
          const isUnbranded = /unbranded|بدون بيانات/i.test(raw);
          return await deliverFlyer(
            listing,
            isUnbranded,
            broker,
            lang,
            pool,
            cooldowns,
            ctx
          );
        }
        if (/(?:client|عميل|نص\s*العميل)/i.test(raw)) {
          const isEn = /client/i.test(raw);
          const clientCopy = T.formatClientListingText(
            listing,
            broker,
            isEn ? "en" : "ar"
          );
          await reply(broker, clientCopy);
          return true;
        }
        if (/(?:layout|مخطط|collateral|ملفات)/i.test(raw)) {
          return await deliverCollateral(listing, broker, lang);
        }

        // Default: If card contains code with no specific action, treat as direct unit inspection
        return await deliverUnitInspectionCard(listing, broker, lang);
      }
    }
  }

  // 0b. SEARCH PAGING BY TEXT (SCH-02, B4): "المزيد" pages the last search, also inside a draft.
  if (/^(المزيد|مزيد|كمان|more|next)$/i.test(lower)) {
    const { rows } = await pool.query(
      "SELECT 1 FROM broker_sessions WHERE broker_id = $1 AND session_type = 'search_state' AND expires_at > NOW()",
      [broker.id]
    );
    if (rows.length) {
      await ctx.S.handleMore(broker, ctx);
      return true;
    }
  }

  // 1. HELP / MENU (SYS-01)
  if (/^(مساعدة|help|اوامر|الأوامر|menu|قائمة)$/i.test(lower)) {
    const helpMsg = T.getHelpMessage(lang);
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
      "DELETE FROM broker_sessions WHERE broker_id = $1 AND session_type IN ('draft', 'edit')",
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

  // 5. EDIT SESSION / PATCH (EDT-01, EDT-02)
  const editMatch = raw.match(
    /^(تعديل|edit)(?:\s+([A-Za-z0-9_\-\.\/]+))?(?:\s+(.+))?$/i
  );
  if (editMatch) {
    const targetCode = await resolveTargetCode(editMatch[2]);
    const instructions = editMatch[3];

    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code to edit (e.g., `edit NOLL-101` or `تعديل NOLL-101 السعر 9M`)."
          : "⚠️ يرجى تحديد كود الوحدة للتعديل (مثال: `تعديل NOLL-101` أو `تعديل NOLL-101 السعر 9 مليون`)."
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
        `SELECT * FROM listings
         WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
         FOR UPDATE`,
        [broker.agency_id, targetCode.toUpperCase()]
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
            ? "⛔ Not authorized to edit this listing."
            : "⛔ ليس لديك صلاحية لتعديل هذه الوحدة."
        );
        return true;
      }

      if (instructions) {
        await client.query("COMMIT");
        await reply(
          broker,
          lang === "en"
            ? `✏️ Processing update instructions for unit #${listing.code}...`
            : `✏️ جاري تنفيذ تعليمات التعديل للوحدة #${listing.code}...`
        );
      } else {
        await client.query(
          `INSERT INTO broker_sessions (broker_id, session_type, session_data, expires_at)
           VALUES ($1::uuid, 'edit', $2::jsonb, NOW() + INTERVAL '15 minutes')
           ON CONFLICT (broker_id, session_type) DO UPDATE SET
             session_data = EXCLUDED.session_data,
             expires_at = NOW() + INTERVAL '15 minutes'`,
          [
            broker.id,
            JSON.stringify({
              listing_id: listing.id,
              code: listing.code,
              voice_buffers: [],
              text_notes: []
            })
          ]
        );
        await client.query("COMMIT");

        await setRecentBrokerListing(
          pool,
          broker.id,
          listing.code,
          recentBrokerListings
        );
        await reply(
          broker,
          lang === "en"
            ? `✏️ Edit mode active for unit #${listing.code}. Send your modifications (voice or text), then type *done*.`
            : `✏️ وضع التعديل نشط للوحدة #${listing.code}. أرسل تعديلاتك (صوت أو كتابة) واكتب «تم» عند الانتهاء.`
        );
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return true;
  }

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

  // 8. EXPORT INVENTORY (EXCEL) (DEL-06)
  if (/^(تصدير|export|excel|شيت)$/i.test(lower)) {
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

  // 9. LIFECYCLE: STATUS UPDATES (Sold, Archived, Reactivate) (LFC-01, LFC-02, LFC-03)
  const statusMatch = raw.match(
    /^(تم البيع|مباع|sold|ارشفة|أرشفة|archive|تفعيل|نشط|active)(?:\s+(.+))?$/i
  );
  if (statusMatch) {
    const action = statusMatch[1].toLowerCase();
    const targetCode = await resolveTargetCode(statusMatch[2]);

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
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(broker.agency_id), targetCode.toUpperCase()]
      );

      const { rows } = await client.query(
        `SELECT id, broker_id, code, status FROM listings
         WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
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

      logCommandOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        listing_code: listing.code,
        operation_type: `command_status_${newStatus}`,
        total_duration_ms: Date.now() - startTime
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

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
         WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
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

  // 11. INLINE DIRECT PRICE EDIT (EDT-03, EDT-04, EDT-05)
  const priceEditMatch = raw.match(
    /^(?:تعديل\s+)?(?:سعر|price)\s+([A-Za-z0-9_\-\.\/]+)\s+(?:الى|إلى|to\s+)?(.+)$/i
  );
  if (priceEditMatch) {
    const targetCode = T.extractCleanCode(priceEditMatch[1]);
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
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [String(broker.agency_id), targetCode.toUpperCase()]
      );

      const { rows } = await client.query(
        `SELECT * FROM listings
         WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
         FOR UPDATE`,
        [broker.agency_id, targetCode.toUpperCase()]
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

      logCommandOp(pool, {
        agency_id: broker.agency_id,
        broker_id: broker.id,
        listing_code: listing.code,
        operation_type: "command_price_patch",
        total_duration_ms: Date.now() - startTime,
        metadata: { newPrice: numericPrice, formattedPriceDisplay }
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return true;
  }

  // 12. DELIVERABLE: LUXURY FLYER / BROCHURE (DEL-01)
  const flyerMatch = raw.match(
    /^(?:flyer|كتالوج|بروشور|unbranded|بدون بيانات)(?:\s+([A-Za-z0-9_\-\.\/]+))?$/i
  );
  if (flyerMatch) {
    const isUnbranded = /unbranded|بدون بيانات/i.test(flyerMatch[0]);
    const targetCode = await resolveTargetCode(flyerMatch[1]);

    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code (e.g. `flyer NOLL-101` or `كتالوج NOLL-101`)."
          : "⚠️ يرجى كتابة كود الوحدة (مثال: `كتالوج NOLL-101` أو `بروشور NOLL-101`)."
      );
      return true;
    }

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, targetCode.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en"
          ? `🔍 Unit #${targetCode} was not found.`
          : `🔍 لم يتم العثور على الوحدة #${targetCode}.`
      );
      return true;
    }

    const listing = rows[0];
    await setRecentBrokerListing(
      pool,
      broker.id,
      listing.code,
      recentBrokerListings
    );
    return await deliverFlyer(
      listing,
      isUnbranded,
      broker,
      lang,
      pool,
      cooldowns,
      ctx
    );
  }

  // 13. DELIVERABLE: CLIENT MARKETING AD COPY (DEL-02)
  const clientCopyMatch = raw.match(
    /^(?:client|عميل)(?:\s+([A-Za-z0-9_\-\.\/]+))?$/i
  );
  if (clientCopyMatch) {
    const isEn = /^client/i.test(clientCopyMatch[0]);
    const targetCode = await resolveTargetCode(clientCopyMatch[1]);

    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code (e.g., `client NOLL-101` or `عميل NOLL-101`)."
          : "⚠️ يرجى تحديد كود الوحدة (مثال: `عميل NOLL-101` أو `client NOLL-101`)."
      );
      return true;
    }

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, targetCode.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en"
          ? `🔍 Unit #${targetCode} was not found.`
          : `🔍 لم يتم العثور على الوحدة #${targetCode}.`
      );
      return true;
    }

    const listing = rows[0];
    await setRecentBrokerListing(
      pool,
      broker.id,
      listing.code,
      recentBrokerListings
    );

    const clientCopy = T.formatClientListingText(
      listing,
      broker,
      isEn ? "en" : "ar"
    );
    await reply(broker, clientCopy);

    logCommandOp(pool, {
      agency_id: broker.agency_id,
      broker_id: broker.id,
      listing_code: listing.code,
      operation_type: "command_client_copy",
      total_duration_ms: Date.now() - startTime
    });
    return true;
  }

  // 14. DELIVERABLE: PAYMENT MATRIX / PLANS (DEL-03)
  const plansMatch = raw.match(
    /^(?:plans|جدول|انظمة السداد|سداد)(?:\s+([A-Za-z0-9_\-\.\/]+))?$/i
  );
  if (plansMatch) {
    const targetCode = await resolveTargetCode(plansMatch[1]);

    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code (e.g. `plans NOLL-101` or `جدول NOLL-101`)."
          : "⚠️ يرجى تحديد كود الوحدة (مثال: `جدول NOLL-101` أو `انظمة السداد NOLL-101`)."
      );
      return true;
    }

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, targetCode.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en"
          ? `🔍 Unit #${targetCode} was not found.`
          : `🔍 الوحدة #${targetCode} غير موجودة.`
      );
      return true;
    }

    const listing = rows[0];
    await setRecentBrokerListing(
      pool,
      broker.id,
      listing.code,
      recentBrokerListings
    );
    return await deliverPaymentPlans(listing, broker, lang, pool, ctx);
  }

  // 15. DELIVERABLE: MARKETING COLLATERAL / LAYOUT (DEL-05)
  const collateralMatch = raw.match(
    /^(?:layout|مخطط|collateral|ملفات)(?:\s+([A-Za-z0-9_\-\.\/]+))?$/i
  );
  if (collateralMatch) {
    const targetCode = await resolveTargetCode(collateralMatch[1]);

    if (!targetCode) {
      await reply(
        broker,
        lang === "en"
          ? "⚠️ Please specify the unit code (e.g. `layout NOLL-101`)."
          : "⚠️ يرجى تحديد كود الوحدة (مثال: `مخطط NOLL-101`)."
      );
      return true;
    }

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
       LIMIT 1`,
      [broker.agency_id, targetCode.toUpperCase()]
    );

    if (rows.length === 0) {
      await reply(
        broker,
        lang === "en"
          ? `🔍 Unit #${targetCode} was not found.`
          : `🔍 لم يتم العثور على الوحدة #${targetCode}.`
      );
      return true;
    }

    const listing = rows[0];
    await setRecentBrokerListing(
      pool,
      broker.id,
      listing.code,
      recentBrokerListings
    );
    return await deliverCollateral(listing, broker, lang);
  }

  // 16. DIRECT UNIT CODE LOOKUP (ING-04)
  const codeParseResult = T.parseExplicitUnitCode(raw);
  if (codeParseResult.hasCode && codeParseResult.code && (isBareCode || !(await inDraft()))) {
    const targetCode = T.extractCleanCode(codeParseResult.code);

    const { rows } = await pool.query(
      `SELECT * FROM listings
       WHERE agency_id = $1 AND (code_norm = $2 OR upper(developer_unit_code) = $2)
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
      return await deliverUnitInspectionCard(listing, broker, lang);
    }
  }

  // Not handled by commands router; fallthrough to search/text pipeline
  return false;
}

module.exports = {
  handleCommand
};
