import AppraisalEmailLog from "../../models/AppraisalEmailLog.js";
import EmployeeAppraisal from "../../models/EmployeeAppraisal.js";
import User from "../../models/User.js";
import { emailConfigured, sendEmail } from "../resend.js";
import { notify } from "../../utils/record.js";
import { audit } from "./appraisalAudit.js";
import { monthLabel } from "./appraisalPeriod.js";
import { roundDisplay } from "./appraisalMath.js";

// Monthly appraisal emails. Guarantees:
//  - at most one email per appraisal: unique AppraisalEmailLog.appraisal +
//    an atomic pending/retrying -> processing claim before every send;
//  - never before 00:01 IST on the 1st of the following month;
//  - every failure is recorded (status, error, attempts), bounded retries
//    with backoff, then left "failed" for HR to retry by hand;
//  - a send interrupted mid-flight (crash while "processing") is marked
//    failed, never auto-resent — it may have gone out.

const SEND_GAP_MS = 550; // Resend's 2 req/s limit — same pacing as followUpReminders.js
const BACKOFF_MS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];
const STUCK_PROCESSING_MS = 10 * 60 * 1000;
const EMAIL_DELAY_AFTER_PERIOD_MS = 60 * 1000 + 1; // periodEnd 23:59:59.999 -> 00:01:00.000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const appUrl = () => (process.env.APP_URL || process.env.CLIENT_ORIGIN || "").replace(/\/$/, "");

export const emailSubject = (month) => `Monthly Performance Appraisal – ${monthLabel(month)}`;

// Built only from the appraisal's own finalized snapshot — the email says
// exactly what the locked record says, whatever the config is today.
export const buildAppraisalEmail = (appraisal, employeeName) => {
  const month = monthLabel(appraisal.month);
  const classifications = appraisal.configSnapshot?.classifications || [];
  const band = classifications.find((c) => c.key === appraisal.classification?.key) || {};
  const score = roundDisplay(appraisal.totalScore);
  const areas = band.showImprovementAreas ? appraisal.improvementAreas || [] : [];
  const link = `${appUrl()}/appraisal/${appraisal._id}`;
  const rows = (appraisal.entries || [])
    .map(
      (e) =>
        `<tr><td style="padding:4px 12px 4px 0;">${esc(e.name)}</td><td style="padding:4px 0;text-align:right;">${roundDisplay(e.score)} / ${roundDisplay(e.maxScore)}${e.ratingLabel ? ` (${esc(e.ratingLabel)})` : ""}</td></tr>`
    )
    .join("");

  const fmtDateOnly = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : null;
  const scoreFrom = fmtDateOnly(appraisal.hrInputs?.scoreFrom);
  const scoreTo = fmtDateOnly(appraisal.hrInputs?.scoreTo);
  const scorePeriodLine = (scoreFrom || scoreTo)
    ? `<p style="margin:4px 0 0;"><strong>Score Period:</strong> ${esc(scoreFrom || "—")} to ${esc(scoreTo || "—")}</p>`
    : "";

  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1c1b19; max-width: 600px;">
    <p>Dear ${esc(employeeName)},</p>
    <p>Your performance appraisal for <strong>${esc(month)}</strong> has been completed.</p>
    <div style="border: 1px solid #e8e5e0; border-radius: 12px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0;"><strong>Overall Score:</strong> ${score} / 100</p>
      <p style="margin: 4px 0 0;"><strong>Performance Status:</strong> ${esc(appraisal.classification?.label || "—")}</p>
      ${scorePeriodLine}
    </div>
    ${
      areas.length
        ? `<p>Based on the monthly evaluation, the following areas require improvement:</p>
           <ul>${areas.map((a) => `<li>${esc(a.name)} — ${roundDisplay(a.score)} / ${roundDisplay(a.maxScore)}</li>`).join("")}</ul>`
        : ""
    }
    ${band.emailMessage ? `<p>${esc(band.emailMessage)}</p>` : ""}
    <p style="margin-top: 20px;"><strong>Score breakdown</strong></p>
    <table style="border-collapse: collapse; font-size: 14px;">${rows}</table>
    <p style="margin-top: 20px;">Your detailed appraisal is available in WOS: <a href="${esc(link)}">${esc(link)}</a></p>
    <p>Regards,<br/>HR Department<br/>WOS</p>
  </div>`;
  return { subject: emailSubject(appraisal.month), html };
};

// Creates the (single) log row for every finalized appraisal whose email is
// due. Safe to run any number of times: the unique index turns a repeat
// into a no-op, and emailQueuedAt keeps the scan to new appraisals only.
// Emails are queued as soon as an appraisal is finalized by HR (no delay).
export const queueDueEmails = async (now = new Date(), { emailsEnabled = true } = {}) => {
  if (!emailsEnabled) return { queued: 0 };
  const due = await EmployeeAppraisal.find({
    status: "finalized",
    emailQueuedAt: null,
  })
    .select("_id user month")
    .populate("user", "email")
    .lean();

  let queued = 0;
  for (const a of due) {
    try {
      await AppraisalEmailLog.create({
        appraisal: a._id,
        user: a.user._id,
        month: a.month,
        recipient: a.user?.email || "(no email on record)",
        subject: emailSubject(a.month),
        status: "pending",
        nextAttemptAt: now,
      });
      queued += 1;
    } catch (error) {
      if (error.code !== 11000) {
        console.error("appraisal email queue failed:", error.message);
        continue;
      }
    }
    await EmployeeAppraisal.updateOne({ _id: a._id, emailQueuedAt: null }, { $set: { emailQueuedAt: now } });
  }
  return { queued };
};

const failLog = async (log, message, maxAttempts, now) => {
  const canRetry = log.attempts < maxAttempts;
  const update = canRetry
    ? { status: "retrying", lastError: message, retryCount: log.retryCount + 1, nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[Math.min(log.attempts - 1, BACKOFF_MS.length - 1)]) }
    : { status: "failed", lastError: message, nextAttemptAt: null };
  await AppraisalEmailLog.updateOne({ _id: log._id, status: "processing" }, { $set: update });
  await audit({ action: "email_failed", entityType: "email", entityId: log._id, subject: log.user, month: log.month, after: { status: update.status, attempts: log.attempts }, meta: { error: message } });
};

// Test seam: swaps the mail transport for every queue run (including the
// background run kicked off by a manual retry). null restores Resend.
let senderOverride = null;
export const setEmailSender = (fn) => {
  senderOverride = fn;
};

export const processEmailQueue = async (now = new Date(), { maxAttempts = 3, sender = null } = {}) => {
  const send = sender || senderOverride || (emailConfigured() ? sendEmail : null);

  // A send that crashed mid-flight may or may not have gone out — park it
  // as failed for a human to check rather than risk a duplicate.
  await AppraisalEmailLog.updateMany(
    { status: "processing", processingStartedAt: { $lt: new Date(now.getTime() - STUCK_PROCESSING_MS) } },
    { $set: { status: "failed", lastError: "Send was interrupted; verify with the employee before retrying", nextAttemptAt: null } }
  );

  let sent = 0;
  let failed = 0;
  let attempted = 0;
  for (;;) {
    const log = await AppraisalEmailLog.findOneAndUpdate(
      { status: { $in: ["pending", "retrying"] }, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      { $set: { status: "processing", processingStartedAt: new Date() }, $inc: { attempts: 1 } },
      { returnDocument: "after", sort: { nextAttemptAt: 1 } }
    );
    if (!log) break;

    if (!send) {
      await failLog(log, "Email service is not configured (RESEND_API_KEY missing)", maxAttempts, now);
      failed += 1;
      continue;
    }

    const appraisal = await EmployeeAppraisal.findById(log.appraisal).lean();
    // Official address from the live user record, never from client input.
    const user = await User.findById(log.user).select("name email isActive").lean();
    if (!appraisal || appraisal.status !== "finalized") {
      await failLog(log, "Appraisal is no longer finalized (reopened?) — email held", 0, now);
      failed += 1;
      continue;
    }
    if (!user?.email) {
      await failLog(log, "Employee has no email address on record", 0, now);
      failed += 1;
      continue;
    }

    if (attempted > 0) await sleep(SEND_GAP_MS);
    attempted += 1;
    const { subject, html } = buildAppraisalEmail(appraisal, user.name);
    try {
      const result = await send({ to: user.email, subject, html });
      await AppraisalEmailLog.updateOne(
        { _id: log._id },
        { $set: { status: "sent", sentAt: new Date(), recipient: user.email, subject, lastError: "", nextAttemptAt: null, providerMessageId: result?.id || null } }
      );
      await audit({ action: "email_sent", entityType: "email", entityId: log._id, subject: log.user, month: log.month, after: { recipient: user.email } });
      notify({ user: log.user, type: "appraisal_update", title: `Your ${monthLabel(log.month)} appraisal is available`, link: `/appraisal/${appraisal._id}` });
      sent += 1;
    } catch (error) {
      const message = (error.response?.data?.message || error.message || "Unknown error").slice(0, 500);
      await failLog(log, message, maxAttempts, now);
      failed += 1;
    }
  }
  return { sent, failed };
};

export const retryEmail = async (logId, actor) => {
  const log = await AppraisalEmailLog.findOneAndUpdate(
    { _id: logId, status: "failed" },
    { $set: { status: "pending", nextAttemptAt: new Date(), lastError: "" }, $inc: { retryCount: 1 } },
    { returnDocument: "after" }
  );
  if (!log) return null;
  await audit({ actor, action: "email_retried", entityType: "email", entityId: log._id, subject: log.user, month: log.month });
  return log;
};
