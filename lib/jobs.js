// lib/jobs.js — The scheduler's job list (lib/scheduler.js). Each Release 3 step adds its jobs here.
"use strict";

const Notifications = require("./notifications");
const MatchSweep = require("../services/matchSweep");
const FollowUpReminders = require("../services/followUpReminders");
const Privacy = require("../services/privacy");
const DailyDigest = require("../services/dailyDigest");
const UnitChecks = require("../services/unitChecks");
const BillingNotices = require("../services/billingNotices");
const PhotoHash = require("../services/photoHash");
const Catalogue = require("../services/catalogue");
const PriceSheets = require("../services/priceSheets");
const LeadRules = require("../services/leadRules");

/**
 * Jobs for this instance: [{ name, everyMs, run({ pool, now, watermark, log }) }].
 * @param {Object} deps - { pool, config }
 */
function buildJobs(_deps = {}) {
  return [Notifications.deliverJob(), MatchSweep.sweepJob(), FollowUpReminders.reminderJob(), DailyDigest.digestJob(), UnitChecks.unitCheckJob(), Privacy.privacyJob(), BillingNotices.reminderJob(), PhotoHash.backfillJob(), Catalogue.linkCheckJob(), PriceSheets.pricesJob(), LeadRules.responseJob()];
}

module.exports = { buildJobs };
