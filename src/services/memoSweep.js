import User from "../models/User.js";
import Memo from "../models/Memo.js";
import { monthBounds, computeMonthlyAppraisal } from "./monthlyAppraisal.js";
import { emailConfigured, sendEmail } from "./resend.js";
import { notify } from "../utils/record.js";
import { toIST } from "../utils/istTime.js";

const REVIEW_DELAY_MS = 21 * 24 * 60 * 60 * 1000; // "3 weeks", memos #1-3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Resend's free-tier rate limit is 2 req/s — same pacing followUpReminders.js
// already uses for a whole-roster send.
const SEND_GAP_MS = 550;

// The IST calendar month before "now" — what the sweep evaluates when it
// fires at the start of a new month (see server.js's trigger).
const previousIstMonthStr = (now = new Date()) => {
  const ist = toIST(now);
  let year = ist.getUTCFullYear();
  let month = ist.getUTCMonth() - 1; // 0-based
  if (month < 0) {
    month = 11;
    year -= 1;
  }
  return `${year}-${String(month + 1).padStart(2, "0")}`;
};

const memoEmailHtml = ({ user, month, score, sequenceNumber, consequence }) => `
  <p>Hi ${user.name},</p>
  <p>Your monthly performance score for <strong>${month}</strong> was <strong>${score}</strong>, which falls in your
  team's Red band.</p>
  <p>This is memo <strong>#${sequenceNumber}</strong> on your record.
  ${
    consequence === "review_delay"
      ? "As a result, your next review/eligibility date has been pushed back by 3 weeks."
      : "This is your 4th memo — your account has been flagged for admin review."
  }</p>
  <p>Please speak with your manager if you have questions about this month's evaluation.</p>
`;

// Evaluates the just-completed IST month (or `monthOverride`, "YYYY-MM", for
// the manual-trigger/testing path) for every active non-admin user, and
// issues a memo for anyone whose score landed in their team's Red band.
// Safe to re-run: Memo's unique {user, month} index turns a repeat pass into
// a no-op per user (see the 11000 catch below).
export const runMonthlyMemoSweep = async (monthOverride) => {
  const month = monthOverride || previousIstMonthStr();
  const { start, end } = monthBounds(month);
  const { rows } = await computeMonthlyAppraisal({
    start,
    end,
    rosterFilter: { isActive: true, role: { $ne: "admin" } },
  });

  let processed = 0;
  let memosIssued = 0;
  let emailsAttempted = 0;

  for (const row of rows) {
    if (row.band !== "red" || !row.user.team) continue;
    processed += 1;

    const existingCount = await Memo.countDocuments({ user: row.user._id, voided: false });
    const sequenceNumber = existingCount + 1;
    const consequence = sequenceNumber <= 3 ? "review_delay" : "termination_flag";

    let memo;
    try {
      memo = await Memo.create({
        user: row.user._id,
        team: row.user.team._id,
        month,
        score: row.score,
        thresholds: row.user.team.performanceThresholds,
        sequenceNumber,
        consequence,
      });
    } catch (error) {
      if (error.code === 11000) continue; // already processed this user for this month
      console.error("memo sweep: failed to create memo:", error.message);
      continue;
    }
    memosIssued += 1;

    const user = await User.findById(row.user._id);
    if (consequence === "review_delay") {
      const base = user.nextReviewDate && user.nextReviewDate > new Date() ? user.nextReviewDate : new Date();
      user.nextReviewDate = new Date(base.getTime() + REVIEW_DELAY_MS);
    } else if (!user.terminationPending) {
      user.terminationPending = true;
      const admins = await User.find({ role: "admin", isActive: true });
      for (const admin of admins) {
        notify({
          user: admin._id,
          type: "performance_memo",
          title: `${user.name} flagged for termination review`,
          body: `${user.name} has received their 4th performance memo (${month}).`,
          link: "/team",
        });
      }
    }
    await user.save();

    if (user.reportingManager) {
      notify({
        user: user.reportingManager,
        type: "performance_memo",
        title: `${user.name} received a performance memo`,
        body: `${month}: score ${row.score}, memo #${sequenceNumber}.`,
        link: "/team",
      });
    }

    if (emailConfigured()) {
      if (emailsAttempted > 0) await sleep(SEND_GAP_MS);
      emailsAttempted += 1;
      try {
        await sendEmail({
          to: user.email,
          subject: `Performance Memo — ${month}`,
          html: memoEmailHtml({ user, month, score: row.score, sequenceNumber, consequence }),
        });
        memo.emailSent = true;
        await memo.save();
      } catch (error) {
        console.error(`memo email failed for ${user.email}:`, error.message);
      }
    }
  }

  return { processed, memosIssued };
};
