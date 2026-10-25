// routes/commandDeliverables.js — Unit deliverables sent from text commands: payment plans, flyers, client copy,
// collateral links and the unit card, plus pasted listing cards. Split out of routes/commands.js.
"use strict";

const T = require("../lib/text");
const Flyer = require("../lib/flyer");
const ShareLinks = require("../lib/shareLinks");
const { cardButtons } = require("../lib/buttons");
const { reply, replyForClient, replyButtons, replyAlbum } = require("../lib/dispatcher");
const Catalogue = require("../services/catalogue");
const { logCommandOp, setRecentBrokerListing } = require("./commandState");

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
 * DEL-01: flyers have one pipeline (lib/flyer.js renderFlyerOnDemand, A7/V1).
 */
async function deliverFlyerFor(listing, isUnbranded, broker, ctx) {
  return (await Flyer.renderFlyerOnDemand(broker, listing.code, "en", "dark", { ...ctx, unbranded: isUnbranded })) && true;
}

/**
 * Reusable Deliverable Handler: Marketing Collateral / Layout (DEL-05)
 */
async function deliverCollateral(listing, broker, lang, pool = null) {
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

  // The unit's catalogue project (C1): its links, internal ones marked 🔒 (never for the client).
  const project = pool ? await Catalogue.projectForUnit(pool, listing).catch(() => null) : null;
  for (const m of project?.materials || []) links.push(`🔗 *${m.label}*${m.client_visible ? "" : " 🔒"}: ${m.url}`);

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
async function deliverUnitInspectionCard(listing, broker, lang, pool = null) {
  const detailsCard = T.formatInternalListingDetails(listing, lang);
  const buttons = cardButtons(listing, lang);

  // Telegram (6.4): the unit's photos as an album above the card (free there; WhatsApp keeps text only).
  if (pool && broker.channel === "telegram") {
    const urls = await require("../lib/listingStore").photosOf(pool, listing).catch(() => []);
    if (urls.length) await replyAlbum(broker, urls.map((url, i) => ({ url, caption: i === 0 ? `#${listing.code}` : "" })));
  }

  await replyButtons(broker, detailsCard, buttons);
  return true;
}

/**
 * A forwarded / pasted multi-line listing card that names a unit code: sends the deliverable it asks for
 * (plans, flyer, client copy, collateral) or the unit card. Returns null when no unit of the agency matches.
 */
async function handlePastedCard(broker, raw, ctx) {
  const { pool, lang, recentBrokerListings } = ctx;
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
        return await deliverFlyerFor(listing, isUnbranded, broker, ctx);
      }
      if (/(?:client|عميل|نص\s*العميل)/i.test(raw)) {
        const isEn = /client/i.test(raw);
        const clientCopy = await ShareLinks.clientCopyWithLink(
          pool,
          broker,
          listing,
          isEn ? "en" : "ar",
          T.formatClientListingText(listing, broker, isEn ? "en" : "ar")
        );
        await replyForClient(broker, clientCopy, { lang: broker.preferred_lang === "en" ? "en" : "ar" });
        return true;
      }
      if (/(?:layout|مخطط|collateral|ملفات)/i.test(raw)) {
        return await deliverCollateral(listing, broker, lang, pool);
      }

      // Default: If card contains code with no specific action, treat as direct unit inspection
      return await deliverUnitInspectionCard(listing, broker, lang, pool);
    }
  }
  return null;
}

/**
 * "flyer CODE", "client CODE", "plans CODE", "layout CODE" (code optional: the broker's last unit).
 * Returns null when the text is none of these.
 */
async function handleDeliverableCommand(broker, raw, ctx, { resolveTargetCode, startTime }) {
  const { pool, lang, recentBrokerListings } = ctx;
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
    return await deliverFlyerFor(listing, isUnbranded, broker, ctx);
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

    // The copy carries a client share link (public unit page; the broker is told when it is opened).
    const clientCopy = await ShareLinks.clientCopyWithLink(
      pool,
      broker,
      listing,
      isEn ? "en" : "ar",
      T.formatClientListingText(listing, broker, isEn ? "en" : "ar")
    );
    await replyForClient(broker, clientCopy, { lang: broker.preferred_lang === "en" ? "en" : "ar" });

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
    return await deliverCollateral(listing, broker, lang, pool);
  }

  return null;
}

module.exports = {
  deliverPaymentPlans,
  deliverFlyerFor,
  deliverCollateral,
  deliverUnitInspectionCard,
  handlePastedCard,
  handleDeliverableCommand
};
