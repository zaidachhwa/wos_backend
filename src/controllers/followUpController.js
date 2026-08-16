import FollowUp from "../models/FollowUp.js";
import User from "../models/User.js";
import Task from "../models/Task.js";
import { recordActivity, notify } from "../utils/record.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";
import { localDay } from "./notificationController.js";
import { aiConfigured, generateText } from "../services/gemini.js";
import { sendEveningFollowUpReminders } from "../services/followUpReminders.js";
import { getManagedUserIds } from "../utils/departmentScope.js";

const TEAM_SCOPE_ROLES = ["admin", "manager", "subadmin", "sublead"];

// ponytail: plain Date arithmetic, no date library in this project. `dateStr`
// is a "YYYY-MM-DD" org (IST) calendar day — the explicit "+05:30" offset
// makes these bounds correct regardless of the server process's own timezone.
const dayBoundsFor = (dateStr) => ({
  start: new Date(`${dateStr}T00:00:00+05:30`),
  end: new Date(`${dateStr}T23:59:59.999+05:30`),
});

export const upsertFollowUp = async (req, res) => {
  try {
    const { date, type, data, submit } = req.body;

    let followUp = await FollowUp.findOne({ user: req.user._id, date, type });
    if (followUp && followUp.status === "reviewed") {
      return res.status(409).json({ success: false, message: "Follow-up already reviewed and locked" });
    }
    if (!followUp) {
      followUp = new FollowUp({ user: req.user._id, date, type });
    }

    followUp.set(type, data);
    if (submit === true) {
      followUp.status = "submitted";
      followUp.submittedAt = new Date();
    }
    await followUp.save();

    if (submit === true) {
      recordActivity({
        actor: req.user._id,
        action: "submitted",
        entityType: "followup",
        entityId: followUp._id,
        meta: { title: `${type} follow-up` },
      });
      if (req.user.reportingManager) {
        notify({
          user: req.user.reportingManager,
          type: "followup_submitted",
          title: `${req.user.name} submitted their ${type} follow-up`,
          link: "/follow-ups",
        });
      }
    }

    return res.status(200).json({ success: true, message: "Follow-up saved", data: { followUp } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "Follow-up already exists" });
    }
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listFollowUps = async (req, res) => {
  try {
    const { date, type, scope = "own" } = req.query;

    if (scope === "team") {
      if (!TEAM_SCOPE_ROLES.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      if (!date || !type) {
        return res
          .status(400)
          .json({ success: false, message: "date and type are required for scope=team" });
      }
      let reportFilter;
      if (req.user.role === "admin") {
        reportFilter = { isActive: true };
      } else if (req.user.role === "subadmin") {
        const managedIds = await getManagedUserIds(req.user);
        reportFilter = { _id: { $in: managedIds }, isActive: true };
      } else if (req.user.role === "sublead") {
        if (!req.user.team) {
          return res.json({ success: true, message: "Follow-ups fetched", data: { followUps: [] } });
        }
        reportFilter = { team: req.user.team, isActive: true };
      } else {
        reportFilter = { reportingManager: req.user._id, isActive: true };
      }
      const reports = await User.find(reportFilter).select("name role department");
      const existing = await FollowUp.find({
        user: { $in: reports.map((r) => r._id) },
        date,
        type,
      }).populate("user", "name role department");
      const byUser = new Map(existing.map((f) => [String(f.user._id), f]));
      const followUps = reports.map(
        (r) =>
          byUser.get(String(r._id)) || {
            user: { _id: r._id, name: r.name, role: r.role, department: r.department },
            date,
            type,
            status: "missing",
          }
      );
      return res.json({ success: true, message: "Follow-ups fetched", data: { followUps } });
    }

    const filter = { user: req.user._id };
    if (date) filter.date = date;
    if (type) filter.type = type;
    const pageParams = paginationParams(req.query);

    if (pageParams) {
      // Paginate by distinct date, not by raw document — a date's morning +
      // evening pair must never be split across a page boundary (the history
      // list groups by date, so a split pair used to show up as an orphaned
      // half-entry at the top of the next page).
      const dates = (await FollowUp.distinct("date", filter)).sort((a, b) => (a < b ? 1 : -1));
      const pageDates = dates.slice(pageParams.skip, pageParams.skip + pageParams.limit);
      const followUps = await FollowUp.find({ ...filter, date: { $in: pageDates } }).sort("-date");
      return res.json({
        success: true,
        message: "Follow-ups fetched",
        data: { followUps, pagination: paginationMeta(dates.length, pageParams) },
      });
    }

    const followUps = await FollowUp.find(filter).sort("-date");
    return res.json({
      success: true,
      message: "Follow-ups fetched",
      data: { followUps, pagination: paginationMeta(followUps.length, null) },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const reviewFollowUp = async (req, res) => {
  try {
    const followUp = await FollowUp.findById(req.params.id);
    if (!followUp) {
      return res.status(404).json({ success: false, message: "Follow-up not found" });
    }
    if (followUp.status !== "submitted") {
      return res.status(409).json({ success: false, message: "Only submitted follow-ups can be reviewed" });
    }

    const owner = await User.findById(followUp.user);
    const isOwnManager = owner && String(owner.reportingManager) === String(req.user._id);
    const isSubleadTeammate =
      req.user.role === "sublead" &&
      req.user.team &&
      owner &&
      String(owner._id) !== String(req.user._id) &&
      String(owner.team) === String(req.user.team);
    const isSubadminManaged =
      req.user.role === "subadmin" &&
      owner &&
      (await getManagedUserIds(req.user)).some((id) => String(id) === String(owner._id));
    if (
      req.user.role !== "admin" &&
      !isOwnManager &&
      !isSubleadTeammate &&
      !isSubadminManaged
    ) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    followUp.status = "reviewed";
    followUp.managerComment = req.body.managerComment || "";
    followUp.reviewedBy = req.user._id;
    await followUp.save();

    recordActivity({
      actor: req.user._id,
      action: "reviewed",
      entityType: "followup",
      entityId: followUp._id,
      meta: { title: `${followUp.type} follow-up` },
    });
    notify({
      user: followUp.user,
      type: "followup_reviewed",
      title: `Your ${followUp.type} follow-up was reviewed`,
      link: "/follow-ups",
    });

    return res.json({ success: true, message: "Follow-up reviewed", data: { followUp } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getFollowUpSuggestion = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, message: "date is required" });
    }

    const { start } = dayBoundsFor(date);
    const previousDayStart = new Date(start);
    previousDayStart.setDate(previousDayStart.getDate() - 1);
    const previousDayEnd = new Date(previousDayStart);
    previousDayEnd.setHours(23, 59, 59, 999);

    const tasks = await Task.find({
      assignees: req.user._id,
      status: "completed",
      updatedAt: { $gte: previousDayStart, $lte: previousDayEnd },
    }).select("title");

    const yesterdayCompleted = tasks.length
      ? `Completed: ${tasks.map((t) => t.title).join(", ")}`
      : "";

    return res.json({
      success: true,
      message: "Suggestion fetched",
      data: { yesterdayCompleted },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

const fmtDate = (d) => d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

const bulletLines = (text, empty) => {
  const lines = (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines.map((line) => `- ${line}`).join("\n") : `- ${empty}`;
};

// Personal EOD work log — gated on today's own evening follow-up being
// submitted, since it's generated from that submission's tomorrow-plan.
export const workLog = async (req, res) => {
  try {
    const today = localDay(new Date());
    const eveningFollowUp = await FollowUp.findOne({ user: req.user._id, date: today, type: "evening" });
    if (!eveningFollowUp || eveningFollowUp.status === "draft") {
      return res.status(403).json({ success: false, message: "Submit your evening follow-up first" });
    }

    const { start: dayStart, end: dayEnd } = dayBoundsFor(today);
    const tasks = await Task.find({
      assignees: req.user._id,
      status: "completed",
      updatedAt: { $gte: dayStart, $lte: dayEnd },
    }).populate("modules", "name");

    const taskLines = tasks.length
      ? tasks.map((t) => `- ${t.title}${t.modules?.length ? ` (${t.modules.map((m) => m.name).join(", ")})` : ""}`).join("\n")
      : "- None";

    const rawText = [
      "Work log",
      `Date : ${fmtDate(dayStart)}`,
      `Team Leader : ${req.user.name}`,
      "",
      "Tasks :",
      taskLines,
      "",
      "Todo :",
      bulletLines(eveningFollowUp.evening.tomorrowPlan, "Nothing planned yet"),
    ].join("\n");

    let text = rawText;
    if (aiConfigured()) {
      try {
        text = await generateText(
          [
            "Rewrite this end-of-day work log so it reads clearly and professionally.",
            'Keep the exact structure: the "Work log" title, "Date :" line, "Team Leader :" line, a blank line, a "Tasks :" section, a blank line, then a "Todo :" section — same headings, same order, same "-" bullet style.',
            "Do not invent tasks or plans that aren't listed below, and do not drop any of them.",
            "Do not add any preamble, commentary, or markdown formatting — plain text only.",
            "",
            rawText,
          ].join("\n")
        );
      } catch (error) {
        // Enhancement is a nice-to-have — never let an AI hiccup block a work log that already exists.
        console.error("work-log AI enhancement failed, using raw text:", error.response?.data || error.message);
        text = rawText;
      }
    }

    return res.json({ success: true, message: "Work log generated", data: { date: today, text } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Manual "run it right now" escape hatch around the same function the
// 8:30pm server.js interval calls — mirrors leaderboardController.runOverdueSweep.
export const runEveningReminderSweep = async (req, res) => {
  try {
    const result = await sendEveningFollowUpReminders();
    return res.json({ success: true, message: "Evening reminder sweep completed", data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
