import User from "../models/User.js";
import Memo from "../models/Memo.js";
import { computeUserAppraisal } from "./monthlyAppraisal.js";
import { bandFor } from "../utils/performanceBand.js";
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
// the manual-trigger/testing path) for every active, tracked-role user
// against Shams's tenure-band score (computeUserAppraisal) and this team's
// Red/Yellow/Green thresholds, issuing a memo for anyone who lands in Red.
// Safe to re-run: Memo's unique {user, month} index turns a repeat pass into
// a no-op per user (see the 11000 catch below).
export const runMonthlyMemoSweep = async (monthOverride) => {
  const month = monthOverride || previousIstMonthStr();

  // Same roster exclusion as getAppraisal (admin/hr don't do task work
  // themselves, so both are excluded from scoring) — the memo sweep should
  // only ever flag someone who'd actually show up in the appraisal roster.
  const roster = await User.find({ isActive: true, role: { $nin: ["admin", "hr"] } })
    .select("name email reportingManager joinedAt createdAt team")
    .populate("team", "name performanceThresholds");

  let processed = 0;
  let memosIssued = 0;
  let emailsAttempted = 0;

  for (const user of roster) {
    if (!user.team) continue; // no team -> no thresholds to evaluate against

    const { score } = await computeUserAppraisal(user._id, month, user.joinedAt || user.createdAt);
    const band = bandFor(score, user.team.performanceThresholds);
    if (band !== "red") continue;
    processed += 1;

    const existingCount = await Memo.countDocuments({ user: user._id, voided: false });
    const sequenceNumber = existingCount + 1;
    const consequence = sequenceNumber <= 3 ? "review_delay" : "termination_flag";

    let memo;
    try {
      memo = await Memo.create({
        user: user._id,
        team: user.team._id,
        month,
        score,
        thresholds: user.team.performanceThresholds,
        sequenceNumber,
        consequence,
      });
    } catch (error) {
      if (error.code === 11000) continue; // already processed this user for this month
      console.error("memo sweep: failed to create memo:", error.message);
      continue;
    }
    memosIssued += 1;

    const freshUser = await User.findById(user._id);
    if (consequence === "review_delay") {
      const base = freshUser.nextReviewDate && freshUser.nextReviewDate > new Date() ? freshUser.nextReviewDate : new Date();
      freshUser.nextReviewDate = new Date(base.getTime() + REVIEW_DELAY_MS);
    } else if (!freshUser.terminationPending) {
      freshUser.terminationPending = true;
      const admins = await User.find({ role: "admin", isActive: true });
      for (const admin of admins) {
        notify({
          user: admin._id,
          type: "performance_memo",
          title: `${freshUser.name} flagged for termination review`,
          body: `${freshUser.name} has received their 4th performance memo (${month}).`,
          link: "/team",
        });
      }
    }
    await freshUser.save();

    if (freshUser.reportingManager) {
      notify({
        user: freshUser.reportingManager,
        type: "performance_memo",
        title: `${freshUser.name} received a performance memo`,
        body: `${month}: score ${score}, memo #${sequenceNumber}.`,
        link: "/team",
      });
    }

    if (emailConfigured()) {
      if (emailsAttempted > 0) await sleep(SEND_GAP_MS);
      emailsAttempted += 1;
      try {
        await sendEmail({
          to: freshUser.email,
          subject: `Performance Memo — ${month}`,
          html: memoEmailHtml({ user: freshUser, month, score, sequenceNumber, consequence }),
        });
        memo.emailSent = true;
        await memo.save();
      } catch (error) {
        console.error(`memo email failed for ${freshUser.email}:`, error.message);
      }
    }
  }

  return { processed, memosIssued };
};
