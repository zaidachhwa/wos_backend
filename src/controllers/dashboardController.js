import Project from "../models/Project.js";
import Task from "../models/Task.js";
import TimeBlock from "../models/TimeBlock.js";
import FollowUp from "../models/FollowUp.js";
import Activity from "../models/Activity.js";
import Team from "../models/Team.js";
import User from "../models/User.js";
import { visibilityFilter } from "./projectController.js";
import { getManagedUserIds } from "../utils/subadminScope.js";
import { computeProjectProgress } from "../utils/progress.js";
import { localDay } from "./notificationController.js";
import { isTaskOverdue } from "../utils/taskDates.js";

const dayBounds = (d) => {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const adminDashboard = async () => {
  const [statusCounts, activeUsers, managers, teams, teamCounts, recentActivity] = await Promise.all([
    Project.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    User.countDocuments({ isActive: true }),
    User.countDocuments({ role: "manager", isActive: true }),
    Team.find().sort("name").lean(),
    User.aggregate([
      { $match: { team: { $ne: null } } },
      { $group: { _id: "$team", count: { $sum: 1 } } },
    ]),
    Activity.find().sort("-createdAt").limit(10).populate("actor", "name role"),
  ]);

  const projectsByStatus = Object.fromEntries(statusCounts.map((s) => [s._id, s.count]));
  const countByTeam = new Map(teamCounts.map((t) => [String(t._id), t.count]));

  return {
    totals: { projectsByStatus, activeUsers, managers },
    teams: teams.map((t) => ({ name: t.name, memberCount: countByTeam.get(String(t._id)) || 0 })),
    recentActivity,
  };
};

// Shared by manager and sublead — plan: "sublead: manager shape but scoped".
// Manager scope = projects they manage; sublead scope = visibilityFilter
// (projects where they're manager/module-lead/member). Reports (their direct
// reports) may be empty for a sublead — every list below degrades to empty.
const managerLikeDashboard = async (user) => {
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const { start, end } = dayBounds(now);
  const today = localDay(now);

  const projectFilter = user.role === "manager" ? { manager: user._id } : await visibilityFilter(user);

  const [projectIds, reports, todaySchedule] = await Promise.all([
    Project.find(projectFilter).distinct("_id"),
    user.role === "subadmin"
      ? User.find({ _id: { $in: await getManagedUserIds(user) }, isActive: true }).select("name role")
      : User.find({ reportingManager: user._id, isActive: true }).select("name role"),
    TimeBlock.find({ user: user._id, start: { $gte: start, $lte: end } }).sort("start"),
  ]);

  const reportIds = reports.map((r) => r._id);
  const taskFilter = { $or: [{ project: { $in: projectIds } }, { assignees: { $in: reportIds } }] };

  const [
    overdueTasks,
    upcomingDeadlines,
    blockedTasks,
    delayedProjects,
    reportOpenTasks,
    morningFollowUps,
    eveningFollowUps,
    recentActivity,
  ] = await Promise.all([
    // Time-slot-aware overdue can't be expressed as a single Mongo query
    // (combining date + "HH:mm" time), so fetch candidates and filter in JS
    // via the shared predicate — per-manager task volumes are small.
    Task.find({ ...taskFilter, deadline: { $ne: null }, status: { $ne: "completed" } })
      .populate("assignees", "name role designation")
      .sort("deadline")
      .then((tasks) => tasks.filter((t) => isTaskOverdue(t, now))),
    Task.find({ ...taskFilter, deadline: { $gte: now, $lte: in7d }, status: { $ne: "completed" } })
      .populate("assignees", "name role designation")
      .sort("deadline"),
    Task.find({ ...taskFilter, status: "blocked" }).populate("assignees", "name role designation"),
    Project.find({
      _id: { $in: projectIds },
      deadline: { $lt: now },
      status: { $nin: ["completed", "cancelled"] },
    }),
    Task.find({ assignees: { $in: reportIds }, status: { $ne: "completed" } }).select(
      "assignees estimatedHours"
    ),
    FollowUp.find({ user: { $in: reportIds }, date: today, type: "morning" }),
    FollowUp.find({ user: { $in: reportIds }, date: today, type: "evening" }),
    Activity.find({ project: { $in: projectIds } }).sort("-createdAt").limit(10).populate("actor", "name role"),
  ]);

  // A report is "pending" (hasn't submitted today) if there's no doc yet, or
  // it's still a draft — submitted/reviewed both mean they submitted.
  const buildPending = (existing) => {
    const byUser = new Map(existing.map((f) => [String(f.user), f]));
    return reports
      .filter((r) => {
        const f = byUser.get(String(r._id));
        return !f || f.status === "draft";
      })
      .map((r) => ({ user: { _id: r._id, name: r.name, role: r.role } }));
  };

  const workload = reports.map((r) => {
    const openTasks = reportOpenTasks.filter((t) => t.assignees.some((a) => String(a) === String(r._id)));
    return {
      user: { _id: r._id, name: r.name, role: r.role },
      openTasks: openTasks.length,
      estimatedHours: openTasks.reduce((sum, t) => sum + (t.estimatedHours || 0), 0),
    };
  });

  return {
    todaySchedule,
    pendingFollowUps: { morning: buildPending(morningFollowUps), evening: buildPending(eveningFollowUps) },
    overdueTasks,
    upcomingDeadlines,
    blockedTasks,
    delayedProjects,
    workload,
    recentActivity,
  };
};

const memberDashboard = async (user) => {
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const { start, end } = dayBounds(now);
  const today = localDay(now);

  const [todayTasks, yesterdayTasks, upcomingDeadlines, todaySchedule, followUps, projectDocs, recentActivity] =
    await Promise.all([
      Task.find({
        assignees: user._id,
        status: { $ne: "completed" },
        assignedDate: { $gte: start, $lte: end },
      }).populate("assignees", "name role designation"),
      Task.find({
        assignees: user._id,
        status: { $ne: "completed" },
        assignedDate: { $lt: start },
      })
        .populate("assignees", "name role designation")
        .sort("assignedDate"),
      Task.find({ assignees: user._id, deadline: { $gte: now, $lte: in7d }, status: { $ne: "completed" } }).sort(
        "deadline"
      ),
      TimeBlock.find({ user: user._id, start: { $gte: start, $lte: end } }).sort("start"),
      FollowUp.find({ user: user._id, date: today, type: { $in: ["morning", "evening"] } }),
      Project.find(await visibilityFilter(user))
        .populate("manager", "name role designation")
        .sort("-createdAt")
        .lean(),
      Activity.find({ actor: user._id }).sort("-createdAt").limit(10).populate("actor", "name role"),
    ]);

  // draft counts as "missing" — followUpStatus only exposes submitted|missing|reviewed.
  const statusFor = (type) => {
    const f = followUps.find((x) => x.type === type);
    return !f || f.status === "draft" ? "missing" : f.status;
  };

  const projects = await Promise.all(
    projectDocs.map(async (p) => ({ ...p, progress: await computeProjectProgress(p._id) }))
  );

  return {
    todayTasks,
    yesterdayTasks,
    upcomingDeadlines,
    todaySchedule,
    followUpStatus: { morning: statusFor("morning"), evening: statusFor("evening") },
    projects,
    recentActivity,
  };
};

export const getDashboard = async (req, res) => {
  try {
    let data;
    if (req.user.role === "admin") data = await adminDashboard();
    else if (req.user.role === "member") data = await memberDashboard(req.user);
    else data = await managerLikeDashboard(req.user); // manager, sublead
    return res.json({ success: true, message: "Dashboard fetched", data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
