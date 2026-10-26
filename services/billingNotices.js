// services/billingNotices.js — What billing tells people (phase 2 step 4): the owner hears about a new payment or
// sign-up (Telegram owner alert), an agency's managers hear when a payment is confirmed and 3 days before their trial
// or paid period ends (daily job, once per period end). Kept apart from services/billing.js, which lib/ai.js loads.
"use strict";

const Notifications = require("../lib/notifications");
const ErrorReports = require("../lib/errorReports");
const Billing = require("./billing");
const Plans = require("../domain/plans");

const L = (b, ar, en) => (b.preferred_lang === "en" ? en : ar);
const day = (d) => new Date(d).toISOString().slice(0, 10);

async function toManagers(pool, agencyId, { dedupeKey, title, body, now = new Date() }) {
  let n = 0;
  for (const m of await Notifications.managersOf(pool, agencyId)) {
    await Notifications.notifyBroker(pool, m, { kind: "manager_alert", dedupeKey, title: title(m), body: body ? body(m) : "", url: "/app/plan", now });
    n++;
  }
  return n;
}

function paymentRequested(payment, agency, manager) {
  const what = payment.kind === "voice_pack" ? `voice pack (${Plans.VOICE_PACK.notes})` : `${payment.plan} × ${payment.months} month(s)`;
  return ErrorReports.alertOwner([`💳 Payment announced ${payment.reference}`, `${agency.name} · ${manager.name || ""}`, `${what} · ${payment.amount_egp} EGP`, "Confirm on /app/owner once it arrives."].join("\n")).catch(() => {});
}

function signupRequested(agency, broker, referrer = null) {
  const lines = [`🆕 Sign-up waiting: ${agency.name}`, `${broker.name} · +${broker.phone_number}`];
  if (referrer) lines.push(`🎁 Invited by ${referrer.name}`);
  lines.push("Approve or reject on /app/owner.");
  return ErrorReports.alertOwner(lines.join("\n")).catch(() => {});
}

async function paymentConfirmed(pool, { payment, agency, referral = null }, { now = new Date() } = {}) {
  const until = agency.paid_until ? day(agency.paid_until) : null;
  const bonus = referral ? referral.bonus : 0;
  // The inviting agency hears that its free month landed (on its paid period, or held for its next payment).
  if (referral && referral.referrer) {
    const r = referral.referrer;
    await toManagers(pool, r.id, {
      dedupeKey: `referral_ok:${payment.agency_id}`,
      title: (m) =>
        r.credited
          ? L(m, `🎁 ${agency.name} اشتركت بدعوتك: شهر مجاني هيتضاف لأول دفعة جاية ليك`, `🎁 ${agency.name} joined on your invite: a free month will be added to your next payment`)
          : L(m, `🎁 ${agency.name} اشتركت بدعوتك: اتضافلك شهر مجاني`, `🎁 ${agency.name} joined on your invite: a free month was added to your plan`),
      now
    });
  }
  return toManagers(pool, payment.agency_id, {
    dedupeKey: `payment_ok:${payment.id}`,
    title: (m) =>
      payment.kind === "voice_pack"
        ? L(m, `✅ وصل الدفع ${payment.reference}: ${Plans.VOICE_PACK.notes} فويس زيادة الشهر ده`, `✅ Payment ${payment.reference} received: ${Plans.VOICE_PACK.notes} extra voice notes this month`)
        : L(m, `✅ وصل الدفع ${payment.reference}: الباقة شغالة لحد ${until}`, `✅ Payment ${payment.reference} received: your plan runs until ${until}`) +
          (bonus ? L(m, ` (منهم ${bonus} شهر مجاني من الدعوات 🎁)`, ` (including ${bonus} free month(s) from invites 🎁)`) : ""),
    now
  });
}

/** Daily: managers of agencies whose trial or paid period ends within 3 days hear once per end date. */
async function remindEnding(pool, { now = new Date() } = {}) {
  let sent = 0;
  for (const a of await Billing.endingSoon(pool, { now, days: 3 })) {
    const paid = a.paid_until && new Date(a.paid_until) > now;
    const end = paid ? a.paid_until : a.trial_ends_at;
    sent += await toManagers(pool, a.id, {
      dedupeKey: `plan_end:${a.id}:${day(end)}`,
      title: (m) =>
        paid
          ? L(m, `⏳ باقتك بتخلص ${day(end)}. جدّدها من صفحة الباقة.`, `⏳ Your plan ends on ${day(end)}. Renew it from the Plan page.`)
          : L(m, `⏳ التجربة المجانية بتخلص ${day(end)}. اختار باقة من صفحة الباقة عشان تكمّل.`, `⏳ Your free trial ends on ${day(end)}. Pick a plan on the Plan page to carry on.`),
      body: (m) => L(m, "بياناتك مش بتتمسح؛ بعد كده بتشتغل على الباقة المجانية.", "Your data is never deleted; afterwards you're on the Free plan."),
      now
    });
  }
  return { sent };
}

/** The scheduler job entry (lib/jobs.js): hourly; the dedupe key keeps it to one notice per period end. */
const reminderJob = () => ({
  name: "plan_reminders",
  everyMs: 60 * 60 * 1000,
  run: ({ pool, now }) => remindEnding(pool, { now }).then((counts) => ({ counts }))
});

module.exports = { paymentRequested, signupRequested, paymentConfirmed, remindEnding, reminderJob };
