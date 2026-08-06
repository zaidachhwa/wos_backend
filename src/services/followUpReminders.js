import User from "../models/User.js";
import FollowUp from "../models/FollowUp.js";
import Notification from "../models/Notification.js";
import { emitTo } from "../utils/io.js";
import { localDay } from "../controllers/notificationController.js";
import { emailConfigured, sendEmail } from "./resend.js";

// The 8:30pm nudge: emails everyone who hasn't submitted today's evening
// follow-up yet. Idempotent across restarts — an upserted Notification
// (title carries the date) marks "already emailed today" per user, same
// dedupe idiom notificationController's injectReminders already uses for
// its in-app-only reminder, kept as a separate notification type since that
// one can exist (from the user just visiting /notifications) well before
// this job ever runs.
export const sendEveningFollowUpReminders = async (now = new Date()) => {
  if (!emailConfigured()) {
    return { sent: 0, eligible: 0, skipped: true, reason: "RESEND_API_KEY not set" };
  }

  const today = localDay(now);
  const title = `Evening follow-up reminder email sent (${today})`;

  const [users, submittedUserIds, alreadyEmailedUserIds] = await Promise.all([
    User.find({ isActive: true }).select("name email"),
    FollowUp.find({ date: today, type: "evening", status: { $ne: "draft" } }).distinct("user"),
    Notification.find({ type: "followup_reminder_email", title }).distinct("user"),
  ]);
  const submitted = new Set(submittedUserIds.map(String));
  const alreadyEmailed = new Set(alreadyEmailedUserIds.map(String));
  const pending = users.filter((u) => !submitted.has(String(u._id)));

  let sent = 0;
  for (const user of pending) {
    if (alreadyEmailed.has(String(user._id))) continue;
    try {
      await sendEmail({
        to: user.email,
        subject: "Reminder: submit your evening follow-up",
        html: `<p>Hi ${user.name},</p><p>You haven't submitted today's evening follow-up yet. Please take a moment to fill it in before you sign off.</p><p><a href="${process.env.CLIENT_ORIGIN}/follow-ups">Submit your follow-up</a></p>`,
      });
      await Notification.findOneAndUpdate(
        { user: user._id, type: "followup_reminder_email", title },
        { $setOnInsert: { user: user._id, type: "followup_reminder_email", title, link: "/follow-ups" } },
        { upsert: true }
      );
      emitTo(user._id, "notification");
      sent += 1;
    } catch (error) {
      console.error(`evening reminder email failed for ${user.email}:`, error.message);
    }
  }
  return { sent, eligible: pending.length };
};
