// lib/whatsapp.js
"use strict";

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v20.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const MAX_TEXT = 3900; // WhatsApp hard ceiling is 4096
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const messagesUrl = () =>
  `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const authHeaders = (json = true) => ({
  Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
  ...(json ? { "Content-Type": "application/json" } : {})
});

/* ====================================================================== */
/* 1. Resilient HTTP Gateway with Rate-Limit Backoff                      */
/* ====================================================================== */

/**
 * fetch + JSON with exponential backoff on 429 / 5xx errors (honours Retry-After).
 * Never throws -> returns { ok, status, data }
 */
async function graphJson(
  url,
  opts = {},
  { retries = 3, timeoutMs = 15000, label = "WA" } = {}
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, status: res.status, data };

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) {
        console.error(
          `❌ [${label} ${res.status}]:`,
          JSON.stringify(data).slice(0, 400)
        );
        return { ok: false, status: res.status, data };
      }

      const ra = Number(res.headers.get("retry-after"));
      await sleep(
        ra > 0
          ? ra * 1000
          : Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300
      );
    } catch (err) {
      if (attempt >= retries) {
        console.error(`❌ [${label} EXCEPTION]:`, err.message);
        return {
          ok: false,
          status: 0,
          data: { error: { message: err.message } }
        };
      }
      await sleep(Math.min(8000, 700 * 2 ** attempt) + Math.random() * 300);
    }
  }
}

/**
 * Core HTTP dispatcher for WhatsApp messages.
 * Throws on failure so callers (server.js) can detect 131047 / 80007 error codes.
 */
async function postWhatsAppApi(payload, label = "WA API") {
  const r = await graphJson(
    messagesUrl(),
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(payload)
    },
    { label }
  );

  if (!r.ok) {
    const errorData = r.data?.error || {};
    const err = new Error(
      errorData.message || `WhatsApp API error ${r.status}`
    );
    err.status = r.status;
    err.response = { data: r.data };
    err.code = errorData.code;
    err.subcode = errorData.error_subcode;
    throw err;
  }

  return r.data;
}

// Split on line breaks to prevent dropping messages exceeding 4096 characters
function chunkText(text, max = MAX_TEXT) {
  const s = String(text);
  if (s.length <= max) return [s];
  const out = [];
  let buf = "";
  for (const line of s.split("\n")) {
    if ((buf + "\n" + line).length > max && buf) {
      out.push(buf);
      buf = "";
    }
    if (line.length > max) {
      for (let i = 0; i < line.length; i += max)
        out.push(line.slice(i, i + max));
    } else buf = buf ? `${buf}\n${line}` : line;
  }
  if (buf) out.push(buf);
  return out;
}

/* ====================================================================== */
/* 2. Text, Image & Document Messaging                                    */
/* ====================================================================== */

async function sendWhatsAppText(to, body) {
  if (!to || !body) return null;
  let last = null;
  for (const part of chunkText(body)) {
    last = await postWhatsAppApi(
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace(/\+/g, ""),
        type: "text",
        text: { preview_url: false, body: part }
      },
      "WA TEXT"
    );
  }
  return last;
}

async function sendWhatsAppImage(to, image, caption = "") {
  if (!to || !image) return null;
  const media =
    typeof image === "string" ? { link: image } : { id: image.id || image };
  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\+/g, ""),
      type: "image",
      image: {
        ...media,
        ...(caption ? { caption: String(caption).slice(0, 1024) } : {})
      }
    },
    "WA IMAGE"
  );
}

function detectMimeType(filename) {
  if (/\.xlsx$/i.test(filename))
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (/\.pdf$/i.test(filename)) return "application/pdf";
  if (/\.csv$/i.test(filename)) return "text/csv";
  if (/\.jpe?g$/i.test(filename)) return "image/jpeg";
  if (/\.png$/i.test(filename)) return "image/png";
  return "application/octet-stream";
}

async function uploadWhatsAppMedia(
  buffer,
  { mimeType = null, filename = "file.dat" } = {}
) {
  if (!buffer) return null;
  const resolvedMime = mimeType || detectMimeType(filename);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", resolvedMime);
  form.append("file", new Blob([buffer], { type: resolvedMime }), filename);

  const r = await graphJson(
    `${GRAPH}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`,
    { method: "POST", headers: authHeaders(false), body: form },
    { label: "WA MEDIA UPLOAD", timeoutMs: 25000 }
  );
  return r.ok && r.data.id ? r.data.id : null;
}

async function sendWhatsAppDocument(
  to,
  buffer,
  filename = "document.xlsx",
  caption = "",
  mimeType = null
) {
  if (!to || !buffer) return null;
  const resolvedMime = mimeType || detectMimeType(filename);
  const id = await uploadWhatsAppMedia(buffer, {
    mimeType: resolvedMime,
    filename
  });
  if (!id) return null;

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\+/g, ""),
      type: "document",
      document: {
        id,
        filename,
        ...(caption ? { caption: String(caption).slice(0, 1024) } : {})
      }
    },
    "WA DOCUMENT"
  );
}

/* ====================================================================== */
/* 3. Interactive Component Primitives (Buttons & Modal List Menus)       */
/* ====================================================================== */

/**
 * Sends WhatsApp interactive button message with strict Meta API guardrails:
 * - Maximum 3 buttons
 * - Title clamped to 20 characters
 * - ID clamped to 128 characters
 */
async function sendWhatsAppButtons(toPhone, bodyText, rawButtons = []) {
  if (!rawButtons.length) {
    return sendWhatsAppText(toPhone, bodyText);
  }

  const buttons = rawButtons.slice(0, 3).map((btn, idx) => {
    const rawTitle = String(btn.title || `Option ${idx + 1}`).trim();
    const title = rawTitle.slice(0, 20);
    const id = String(btn.id || `btn_${idx}`).slice(0, 128);

    return {
      type: "reply",
      reply: { id, title }
    };
  });

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone.replace(/\+/g, ""),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: String(bodyText).slice(0, 1024) },
        action: { buttons }
      }
    },
    "WA BUTTONS"
  );
}

/**
 * Sends WhatsApp interactive list message with strict Meta API guardrails:
 * - Button text max 20 chars
 * - Max 10 total rows across all sections
 * - Row title max 24 chars
 * - Row description max 72 chars
 * - Row ID max 200 chars
 */
async function sendWhatsAppList(
  to,
  headerText,
  bodyText,
  buttonText,
  rawSections = []
) {
  let totalRows = 0;
  const sections = (rawSections || []).slice(0, 10).map((sec, secIdx) => {
    const secTitle = String(sec.title || `Section ${secIdx + 1}`)
      .trim()
      .slice(0, 24);
    const availableSlots = Math.max(0, 10 - totalRows);
    const rawRows = (sec.rows || []).slice(0, availableSlots);

    const rows = rawRows.map((r, rIdx) => {
      const title = String(r.title || `Item ${rIdx + 1}`)
        .trim()
        .slice(0, 24);
      const id = String(r.id || `row_${secIdx}_${rIdx}`).slice(0, 200);
      const rowObj = { id, title };

      if (r.description) {
        rowObj.description = String(r.description).trim().slice(0, 72);
      }
      return rowObj;
    });

    totalRows += rows.length;
    return { title: secTitle, rows };
  });

  const btnLabel = String(buttonText || "عرض الخيارات 📋")
    .trim()
    .slice(0, 20);

  return postWhatsAppApi(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to.replace(/\+/g, ""),
      type: "interactive",
      interactive: {
        type: "list",
        ...(headerText
          ? { header: { type: "text", text: String(headerText).slice(0, 60) } }
          : {}),
        body: { text: String(bodyText).slice(0, 1024) },
        action: {
          button: btnLabel,
          sections
        }
      }
    },
    "WA LIST"
  );
}

/* ====================================================================== */
/* 4. Dynamic UI Adapter (Auto-Switching Buttons vs. List Sheet)          */
/* ====================================================================== */

/**
 * Universal interactive menu dispatcher:
 * Automatically uses Quick Reply Buttons if items <= 3.
 * Automatically switches to Modal Bottom Sheet List Picker if items > 3 (up to 10).
 */
async function sendAdaptiveMenu(toPhone, bodyText, options = [], opts = {}) {
  const count = options.length;

  if (count === 0) {
    return sendWhatsAppText(toPhone, bodyText);
  }

  // If 1 to 3 items, render native interactive buttons
  if (count <= 3) {
    return sendWhatsAppButtons(toPhone, bodyText, options);
  }

  // If 4 to 10 items, route to native bottom sheet list picker
  const rows = options.slice(0, 10).map((opt, idx) => ({
    id: opt.id || `opt_${idx}`,
    title: String(opt.title || `Option ${idx + 1}`).slice(0, 24),
    description: opt.description
      ? String(opt.description).slice(0, 72)
      : undefined
  }));

  const menuButtonText =
    opts.buttonText ||
    (opts.lang === "en"
      ? `Options (${count}) 📋`
      : `عرض الخيارات (${count}) 📋`);
  const headerText =
    opts.headerText ||
    (opts.lang === "en" ? "Select an Option" : "قائمة الخيارات");
  const sectionTitle =
    opts.sectionTitle ||
    (opts.lang === "en" ? "Available Choices" : "الخيارات المتاحة");

  return sendWhatsAppList(toPhone, headerText, bodyText, menuButtonText, [
    { title: sectionTitle, rows }
  ]);
}

/* ====================================================================== */
/* 5. Payment Plans Dynamic UX Router                                     */
/* ====================================================================== */

/**
 * Evaluates the results from financials.filterMatchingPlans and delivers
 * the exact compliant WhatsApp UX based on matching plans count (0, 1, 2, 3..10).
 */
async function sendPaymentPlansResponse(
  toPhone,
  unitCode,
  matchingResult,
  lang = "ar"
) {
  const isEn = lang === "en";
  const { status, matches = [], closest } = matchingResult;
  const count = matches.length;

  // SCENARIO 0: Zero Matches -> Smart Constraint Relaxation Buttons
  if (status === "unmatched" || count === 0) {
    const closestPlan = closest?.plan;
    const dpGapFormatted = closest?.dpGap
      ? (closest.dpGap / 1000).toFixed(0) + "k"
      : "0";

    const bodyText = isEn
      ? `⚠️ *No exact payment plan matches your exact budget criteria.*\n\n` +
        (closestPlan
          ? `• *Closest Alternative:* ${closestPlan.years}-Year Plan (${closestPlan.discount_pct}% discount)\n` +
            `• Down Payment: ${closestPlan.down_payment.toLocaleString()} EGP (+${dpGapFormatted} EGP gap)\n` +
            `• Installment: ${closestPlan.installment_amount.toLocaleString()} EGP / quarter\n\n`
          : "") +
        `You can review the closest plan, view all compound plans, or modify your budget:`
      : `⚠️ *لا توجد خطة سداد مطابقة تماماً للميزانية المحددة.*\n\n` +
        (closestPlan
          ? `• *أقرب نظام متاح:* نظام ${closestPlan.years} سنوات (خصم ${closestPlan.discount_pct}%)\n` +
            `• المقدم: ${closestPlan.down_payment.toLocaleString()} ج.م (فارق مطلوب: ${dpGapFormatted} ألف)\n` +
            `• القسط: ${closestPlan.installment_amount.toLocaleString()} ج.م ربع سنوي\n\n`
          : "") +
        `يمكنك مراجعة أقرب بديل، عرض كافة خطط المشروع، أو تعديل الميزانية:`;

    const buttons = [
      {
        id: `plan_view:${unitCode}:${closestPlan?.plan_id || "closest"}`,
        title: isEn ? "Closest Plan 🎯" : "عرض أقرب خطة 🎯"
      },
      {
        id: `plans_all:${unitCode}`,
        title: isEn ? "All Plans 📋" : "كل خطط المشروع 📋"
      },
      {
        id: `search_retry:${unitCode}`,
        title: isEn ? "Adjust Budget 🔄" : "تعديل الميزانية 🔄"
      }
    ];

    return sendWhatsAppButtons(toPhone, bodyText, buttons);
  }

  // SCENARIO 1: Exactly 1 Match -> Instant Action Buttons
  if (count === 1) {
    const plan = matches[0];
    const bodyText = isEn
      ? `🎯 *We found 1 exact plan matching your cash flow:*\n\n` +
        `🏢 *Unit #${unitCode}* | ${plan.name}\n` +
        `• *Down Payment:* ${plan.down_payment.toLocaleString()} EGP\n` +
        `• *Quarterly Installment:* ${plan.installment_amount.toLocaleString()} EGP (${
          plan.total_installments_count
        } payments)\n` +
        `• *Net Price:* ${plan.effective_price.toLocaleString()} EGP (Save ${
          plan.discount_pct
        }%)\n` +
        `• *Maintenance:* ${plan.maintenance_per_split.toLocaleString()} EGP / yr (for ${
          plan.maintenance_splits
        } yrs)\n\n` +
        `Choose an action below to receive your branded deliverable:`
      : `🎯 *وجدنا نظام سداد مطابق تماماً لتدفقك المالي:*\n\n` +
        `🏢 *الوحدة #${unitCode}* | ${plan.name}\n` +
        `• *المقدم:* ${plan.down_payment.toLocaleString()} ج.م\n` +
        `• *القسط ربع السنوي:* ${plan.installment_amount.toLocaleString()} ج.م (${
          plan.total_installments_count
        } قسط)\n` +
        `• *السعر بعد الخصم:* ${plan.effective_price.toLocaleString()} ج.م (وفرت ${
          plan.discount_pct
        }%)\n` +
        `• *وديعة الصيانة:* ${plan.maintenance_per_split.toLocaleString()} ج.م سنوياً (لمدة ${
          plan.maintenance_splits
        } سنوات)\n\n` +
        `اختر من الأدوات المباشرة أدناه لإرسال العرض للعميل:`;

    const buttons = [
      {
        id: `export_pdf:${unitCode}:${plan.plan_id}`,
        title: isEn ? "Factsheet PDF 📄" : "بروشور العرض PDF 📄"
      },
      {
        id: `export_excel:${unitCode}:${plan.plan_id}`,
        title: isEn ? "Excel Schedule 📊" : "جدول السداد Excel 📊"
      },
      {
        id: `share_client:${unitCode}:${plan.plan_id}`,
        title: isEn ? "Forward Text 📲" : "مشاركة للعميل 📲"
      }
    ];

    return sendWhatsAppButtons(toPhone, bodyText, buttons);
  }

  // SCENARIO 2: Exactly 2 Matches -> Direct Dual-Choice + Side-by-Side Compare
  if (count === 2) {
    const [p1, p2] = matches;
    const bodyText = isEn
      ? `🎯 *Found 2 payment plans matching your budget for #${unitCode}:*\n\n` +
        `1️⃣ *${
          p1.years
        } Years:* Down ${p1.down_payment.toLocaleString()} EGP | Qtr: ${p1.installment_amount.toLocaleString()} EGP\n` +
        `2️⃣ *${
          p2.years
        } Years:* Down ${p2.down_payment.toLocaleString()} EGP | Qtr: ${p2.installment_amount.toLocaleString()} EGP\n\n` +
        `Select a plan to view its schedule or compare both in Excel:`
      : `🎯 *وجدنا نظامين سداد يناسبان ميزانيتك للوحدة #${unitCode}:*\n\n` +
        `1️⃣ *نظام ${
          p1.years
        } سنين:* مقدم ${p1.down_payment.toLocaleString()} ج.م | قسط: ${p1.installment_amount.toLocaleString()} ج.م\n` +
        `2️⃣ *نظام ${
          p2.years
        } سنين:* مقدم ${p2.down_payment.toLocaleString()} ج.م | قسط: ${p2.installment_amount.toLocaleString()} ج.م\n\n` +
        `اختر الخطة لعرض تفاصيلها أو قارن بينهما في ملف إكسيل:`;

    const buttons = [
      {
        id: `plan_view:${unitCode}:${p1.plan_id}`,
        title: `${p1.years} سنين (${p1.discount_pct}%)`.slice(0, 20)
      },
      {
        id: `plan_view:${unitCode}:${p2.plan_id}`,
        title: `${p2.years} سنين (${p2.discount_pct}%)`.slice(0, 20)
      },
      {
        id: `compare_excel:${unitCode}`,
        title: isEn ? "Compare in Excel 📊" : "مقارنة إكسيل 📊"
      }
    ];

    return sendWhatsAppButtons(toPhone, bodyText, buttons);
  }

  // SCENARIO 3, 4, 5: 3 to 10 Matches -> Native WhatsApp Modal Bottom Sheet (type: "list")
  const planRows = matches.slice(0, 9).map((p) => {
    const dpK = Math.round(p.down_payment / 1000);
    const qtrK = Math.round(p.installment_amount / 1000);
    return {
      id: `plan_view:${unitCode}:${p.plan_id}`,
      title: `${p.years} سنين (خصم ${p.discount_pct}%)`.slice(0, 24),
      description: `مقدم: ${dpK}k | قسط: ${qtrK}k ربع سنوي`.slice(0, 72)
    };
  });

  // Always append consolidated Excel comparison as final row
  planRows.push({
    id: `compare_excel:${unitCode}`,
    title: isEn ? "📊 Full Excel Compare" : "📊 مقارنة الأنظمة إكسيل",
    description: isEn
      ? "Download multi-tab comparison spreadsheet"
      : "تحميل ملف إكسيل شامل لمقارنة الأنظمة"
  });

  const bodyText = isEn
    ? `🎯 Found ${count} payment plans matching your financial flow for #${unitCode}. Tap below to select or compare:`
    : `🎯 وجدنا ${count} أنظمة سداد تناسب تدفقك المالي للوحدة #${unitCode}. اضغط أدناه لاختيار النظام المناسب:`;

  const btnLabel = isEn
    ? `View Plans (${count}) 📋`
    : `عرض الخيارات (${count}) 📋`;
  const headerText = isEn ? "Matching Payment Plans" : "أنظمة السداد المطابقة";

  return sendWhatsAppList(toPhone, headerText, bodyText, btnLabel, [
    { title: isEn ? "Available Plans" : "الأنظمة المتاحة", rows: planRows }
  ]);
}

/* ====================================================================== */
/* 6. Inbound Utility Handlers                                            */
/* ====================================================================== */

async function markAsRead(messageId, { typing = false } = {}) {
  if (!messageId) return null;
  const r = await graphJson(
    messagesUrl(),
    {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        ...(typing ? { typing_indicator: { type: "text" } } : {})
      })
    },
    { label: "WA READ", retries: 0, timeoutMs: 8000 }
  );
  return r.ok;
}

async function downloadWhatsAppMedia(
  mediaId,
  { maxBytes = MAX_MEDIA_BYTES } = {}
) {
  if (!mediaId || !process.env.WHATSAPP_ACCESS_TOKEN) return null;
  try {
    const meta = await graphJson(
      `${GRAPH}/${mediaId}`,
      { method: "GET", headers: authHeaders(false) },
      { label: "WA MEDIA META" }
    );
    if (!meta.ok || !meta.data.url) return null;
    if (Number(meta.data.file_size) > maxBytes) {
      console.warn(`[WA MEDIA] ${mediaId} too large (${meta.data.file_size})`);
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(meta.data.url, {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
            "User-Agent": "curl/7.64.1"
          },
          signal: AbortSignal.timeout(25000)
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) continue;
          return null;
        }
        if (Number(res.headers.get("content-length")) > maxBytes) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) return null;
        return { buffer: buf, mimeType: meta.data.mime_type || "image/jpeg" };
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    return null;
  } catch (err) {
    console.error("❌ [WA MEDIA EXCEPTION]:", err.message);
    return null;
  }
}

module.exports = {
  postWhatsAppApi,
  sendWhatsAppText,
  sendWhatsAppImage,
  sendWhatsAppDocument,
  sendWhatsAppButtons,
  sendWhatsAppList,
  sendAdaptiveMenu,
  sendPaymentPlansResponse,
  uploadWhatsAppMedia,
  markAsRead,
  downloadWhatsAppMedia
};
