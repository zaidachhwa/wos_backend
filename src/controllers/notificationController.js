import Notification from "../models/Notification.js";
import FollowUp from "../models/FollowUp.js";
import Task from "../models/Task.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";

// Server-local (process timezone) YYYY-MM-DD — matches the spec's "server-local"
// wording; there's no per-user timezone concept in this app.
// Exported for dashboardController: same "today" convention for follow-up lookups.
export const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Create-if-absent reminder notifications, deduped per day so a poll loop
// doesn't spam. Runs inline (awaited) — unlike record.js's fire-and-forget
// notify(), these must exist before the list query below reads them back.
const injectReminders = async (user) => {
  const now = new Date();
  const day = localDay(now);
  const hour = now.getHours();

  const followupTypes = [];
  if (hour < 12) followupTypes.push("morning");
  if (hour >= 17) followupTypes.push("evening");

  for (const type of followupTypes) {
    const followUp = await FollowUp.findOne({ user: user._id, date: day, type });
    if (followUp && followUp.status !== "draft") continue; // already submitted/reviewed
    const title = `${type === "morning" ? "Morning" : "Evening"} follow-up pending (${day})`;
    // ponytail: upsert instead of findOne-then-create so concurrent pollers (multi-tab,
    // 30s interval) can't both pass the exists-check and double-insert. Alternative would
    // be a unique index on (user, type, title/body); this keeps the dedupe key inline instead.
    await Notification.findOneAndUpdate(
      { user: user._id, type: "followup_reminder", title },
      { $setOnInsert: { user: user._id, type: "followup_reminder", title, link: "/follow-ups" } },
      { upsert: true },
    );
  }

  const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
  const dueSoon = await Task.find({
    assignees: user._id,
    status: { $ne: "completed" },
    deadline: { $gte: now, $lte: in24h },
  });
  for (const task of dueSoon) {
    const body = `task:${task._id}:${day}`;
    await Notification.findOneAndUpdate(
      { user: user._id, type: "deadline_reminder", body },
      {
        $setOnInsert: {
          user: user._id,
          type: "deadline_reminder",
          title: `Deadline approaching: ${task.title}`,
          body,
          link: `/tasks/${task._id}`,
        },
      },
      { upsert: true },
    );
  }
};

export const listNotifications = async (req, res) => {
  try {
    await injectReminders(req.user);
    const pageParams = paginationParams(req.query);
    let query = Notification.find({ user: req.user._id }).sort("-createdAt");
    query = pageParams ? query.skip(pageParams.skip).limit(pageParams.limit) : query.limit(50);
    const [notifications, unreadCount, total] = await Promise.all([
      query,
      Notification.countDocuments({ user: req.user._id, read: false }),
      Notification.countDocuments({ user: req.user._id }),
    ]);
    // Legacy (no params) mode still caps at 50 — report that as the
    // effective limit rather than falsely claiming "everything".
    const metaParams = pageParams || { page: 1, limit: 50 };
    return res.json({
      success: true,
      message: "Notifications fetched",
      data: { notifications, unreadCount, pagination: paginationMeta(total, metaParams) },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const markNotificationRead = async (req, res) => {
  try {
    const notification = await Notification.findOne({ _id: req.params.id, user: req.user._id });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    notification.read = true;
    await notification.save();
    return res.json({ success: true, message: "Notification marked as read", data: { notification } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const markAllNotificationsRead = async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
    return res.json({ success: true, message: "All notifications marked as read", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const deleteNotification = async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    return res.json({ success: true, message: "Notification deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const clearNotifications = async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user._id });
    return res.json({ success: true, message: "Notifications cleared", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
