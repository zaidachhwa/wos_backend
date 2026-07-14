import Task from "../models/Task.js";
import ProjectModule from "../models/ProjectModule.js";
import FollowUp from "../models/FollowUp.js";
import User from "../models/User.js";
import { localDay } from "./notificationController.js";

const DAY = 24 * 3600 * 1000;

const pad = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isWeekday = (d) => d.getDay() !== 0 && d.getDay() !== 6;

const weekdaysBetween = (from, to) => {
  let count = 0;
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + DAY)) {
    if (isWeekday(d)) count += 1;
  }
  return count;
};

// Consecutive weekdays (walking back from today) with a submitted morning
// follow-up. Capped at 60 to bound the loop.
const streakOf = (morningDays) => {
  let streak = 0;
  const today = dayStr(new Date());
  const d = new Date();
  for (let i = 0; i < 60; i += 1) {
    if (isWeekday(d)) {
      if (morningDays.has(dayStr(d))) {
        streak += 1;
      } else if (dayStr(d) !== today) {
        // A missed past weekday ends the streak; a not-yet-submitted TODAY doesn't.
        break;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
};

export const teamReport = async (req, res) => {
  try {
    const { from, to, format } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: "from and to are required" });
    }
    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${to}T23:59:59`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      return res.status(400).json({ success: false, message: "from and to must be a valid date range" });
    }

    const reportFilter =
      req.user.role === "admin"
        ? { role: { $ne: "admin" }, isActive: true }
        : { reportingManager: req.user._id, isActive: true };
    const people = await User.find(reportFilter).select("name role designation").sort("name");
    const ids = people.map((p) => p._id);

    const [completedTasks, openTasks, followUps, streakFollowUps] = await Promise.all([
      // ponytail: updatedAt is the completion-time proxy; a statusChangedAt
      // field is the upgrade path if precision ever matters.
      Task.find({
        assignee: { $in: ids },
        status: "completed",
        updatedAt: { $gte: fromDate, $lte: toDate },
      }).select("assignee estimatedHours actualHours"),
      Task.find({ assignee: { $in: ids }, status: { $ne: "completed" } }).select("assignee status"),
      FollowUp.find({
        user: { $in: ids },
        date: { $gte: from, $lte: to },
        status: { $in: ["submitted", "reviewed"] },
      }).select("user type date"),
      FollowUp.find({
        user: { $in: ids },
        type: "morning",
        status: { $in: ["submitted", "reviewed"] },
      }).select("user date"),
    ]);

    const workingDays = weekdaysBetween(fromDate, toDate);
    const rows = people.map((p) => {
      const id = String(p._id);
      const done = completedTasks.filter((t) => String(t.assignee) === id);
      const open = openTasks.filter((t) => String(t.assignee) === id);
      const submitted = followUps.filter((f) => String(f.user) === id);
      const morningDays = new Set(
        streakFollowUps.filter((f) => String(f.user) === id).map((f) => f.date)
      );
      const estimated = done.reduce((s, t) => s + (t.estimatedHours || 0), 0);
      const actual = done.reduce((s, t) => s + (t.actualHours || 0), 0);
      return {
        user: { _id: p._id, name: p.name, role: p.role, designation: p.designation },
        tasksCompleted: done.length,
        estimatedHours: estimated,
        actualHours: actual,
        openTasks: open.length,
        blockedTasks: open.filter((t) => t.status === "blocked").length,
        followUpsSubmitted: submitted.length,
        followUpsExpected: workingDays * 2,
        complianceRate: workingDays ? Math.round((submitted.length / (workingDays * 2)) * 100) : 0,
        morningStreak: streakOf(morningDays),
      };
    });

    if (format === "csv") {
      const header =
        "Name,Role,Tasks completed,Estimated hours,Actual hours,Open tasks,Blocked,Follow-ups submitted,Follow-ups expected,Compliance %,Morning streak";
      const csv = [
        header,
        ...rows.map((r) =>
          [
            `"${r.user.name.replace(/"/g, '""')}"`,
            r.user.role,
            r.tasksCompleted,
            r.estimatedHours,
            r.actualHours,
            r.openTasks,
            r.blockedTasks,
            r.followUpsSubmitted,
            r.followUpsExpected,
            r.complianceRate,
            r.morningStreak,
          ].join(",")
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="team-report-${from}-to-${to}.csv"`);
      return res.send(csv);
    }

    return res.json({
      success: true,
      message: "Report generated",
      data: { rows, workingDays, from, to },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

const fmtDate = (d) => d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

export const workLog = async (req, res) => {
  try {
    const day = typeof req.query.date === "string" && req.query.date ? req.query.date : localDay(new Date());
    const dayStart = new Date(`${day}T00:00:00`);
    const dayEnd = new Date(`${day}T23:59:59.999`);
    if (Number.isNaN(dayStart.getTime())) {
      return res.status(400).json({ success: false, message: "date must be a valid YYYY-MM-DD" });
    }

    const reportFilter =
      req.user.role === "admin"
        ? { role: { $ne: "admin" }, isActive: true }
        : { reportingManager: req.user._id, isActive: true };
    const reports = await User.find(reportFilter).select("name");
    const ids = reports.map((r) => r._id);

    const [tasks, modules, evenings] = await Promise.all([
      Task.find({
        assignee: { $in: ids },
        status: "completed",
        updatedAt: { $gte: dayStart, $lte: dayEnd },
      }).populate("assignee", "name"),
      ProjectModule.find({
        lead: { $in: ids },
        status: "completed",
        updatedAt: { $gte: dayStart, $lte: dayEnd },
      }).populate("lead", "name"),
      FollowUp.find({
        user: { $in: ids },
        date: day,
        type: "evening",
        status: { $in: ["submitted", "reviewed"] },
      }).populate("user", "name"),
    ]);

    const bullets = (items, empty) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);

    const taskLines = bullets(
      tasks.map((t) => `${t.assignee?.name || "Unassigned"}: ${t.title}`),
      "None"
    );
    const moduleLines = bullets(
      modules.map((m) => `${m.lead?.name || "Unassigned"}: ${m.name}`),
      "None"
    );
    const todoLines = bullets(
      evenings
        .filter((f) => f.evening?.tomorrowPlan?.trim())
        .map((f) => `${f.user?.name || "Someone"}: ${f.evening.tomorrowPlan.trim()}`),
      "No tomorrow plans submitted yet"
    );

    const text = [
      "Work log",
      `Date: ${fmtDate(dayStart)}`,
      `Team Leader: ${req.user.name}`,
      "",
      "Tasks:",
      taskLines,
      "",
      "Modules:",
      moduleLines,
      "",
      "Todo:",
      todoLines,
    ].join("\n");

    return res.json({ success: true, message: "Work log generated", data: { date: day, text } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
