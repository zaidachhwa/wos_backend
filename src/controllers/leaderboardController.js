import Activity from "../models/Activity.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { pointsForCompletedTask } from "../utils/points.js";
import { getPointsByPriority, setPointsByPriority } from "../utils/pointsConfig.js";
import { getManagedTeamIds } from "../utils/subadminScope.js";

const mondayOf = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0 = Sun .. 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
};

const weekBoundsOf = (date) => {
  const start = mondayOf(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const dayStr = (d) => new Date(d).toISOString().slice(0, 10);

const REPORT_ROLES = ["admin", "manager", "subadmin"];

export const getLeaderboard = async (req, res) => {
  try {
    const format = req.query.format;
    const isReporter = REPORT_ROLES.includes(req.user.role);

    if (format === "csv" && !isReporter) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // ponytail: locked to Monday-only per requirement, checked against server
    // local time (same clock the week math below already assumes). CSV export
    // is an explicit admin/manager report action, so it bypasses the lock —
    // otherwise there'd be no way to pull last week's numbers on a Friday.
    // Admins also see the live view any day, for oversight.
    const bypassLock = format === "csv" || req.user.role === "admin";
    if (!bypassLock && new Date().getDay() !== 1) {
      const nextMonday = mondayOf(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
      return res.json({
        success: true,
        message: "Leaderboard locked",
        data: { locked: true, nextMonday },
      });
    }

    const anchor = req.query.week ? new Date(req.query.week) : new Date();
    if (Number.isNaN(anchor.getTime())) {
      return res.status(400).json({ success: false, message: "week must be a valid date" });
    }
    const { start: weekStart, end: weekEnd } = weekBoundsOf(anchor);

    const rosterFilter = { isActive: true, role: { $ne: "admin" } };
    if (req.user.role === "subadmin") {
      const managedTeamIds = (await getManagedTeamIds(req.user.managedDepartment)).map(String);
      if (req.query.team) {
        if (!managedTeamIds.includes(String(req.query.team))) {
          return res.status(403).json({ success: false, message: "Forbidden" });
        }
        rosterFilter.team = req.query.team;
      } else {
        rosterFilter.team = { $in: managedTeamIds };
      }
    } else if (req.query.team) {
      rosterFilter.team = req.query.team;
    }

    const [completions, roster] = await Promise.all([
      Activity.find({
        entityType: "task",
        "meta.statusTo": "completed",
        createdAt: { $gte: weekStart, $lte: weekEnd },
      }).select("entityId createdAt"),
      User.find(rosterFilter).select("name role designation team").populate("team", "name"),
    ]);

    // Dedupe to the latest completion activity per task within the week —
    // a task can flip completed -> reopened -> completed again, and should
    // only be credited once.
    const latestByTask = new Map();
    for (const a of completions) {
      const key = String(a.entityId);
      const existing = latestByTask.get(key);
      if (!existing || a.createdAt > existing.createdAt) latestByTask.set(key, a);
    }

    const taskIds = [...latestByTask.keys()];
    const tasks = await Task.find({ _id: { $in: taskIds } }).select(
      "title priority assignees bonusPoints deadline endTime"
    );
    const taskById = new Map(tasks.map((t) => [String(t._id), t]));

    const pointsByUser = new Map();
    const tasksByUser = new Map();
    for (const [taskId, activity] of latestByTask) {
      const task = taskById.get(taskId);
      if (!task) continue;
      const points = pointsForCompletedTask(task, activity.createdAt);
      // Confirmed: every assignee gets full points, not split.
      for (const assigneeId of task.assignees) {
        const id = String(assigneeId);
        pointsByUser.set(id, (pointsByUser.get(id) || 0) + points);
        tasksByUser.set(id, (tasksByUser.get(id) || 0) + 1);
      }
    }

    const unranked = roster.map((u) => ({
      user: {
        _id: u._id,
        name: u.name,
        role: u.role,
        designation: u.designation,
        team: u.team ? { _id: u.team._id, name: u.team.name } : null,
      },
      points: pointsByUser.get(String(u._id)) || 0,
      tasksCompleted: tasksByUser.get(String(u._id)) || 0,
    }));
    unranked.sort((a, b) => b.points - a.points);

    // Competition ranking: ties share a rank, the next distinct rank skips
    // ahead accordingly (1, 1, 3, 4, ...).
    let rank = 0;
    let prevPoints = null;
    const rows = unranked.map((row, index) => {
      if (row.points !== prevPoints) rank = index + 1;
      prevPoints = row.points;
      return { ...row, rank };
    });

    if (format === "csv") {
      const header = "Rank,Name,Role,Team,Tasks completed,Points";
      const csv = [
        header,
        ...rows.map((r) =>
          [
            r.rank,
            `"${r.user.name.replace(/"/g, '""')}"`,
            r.user.role,
            r.user.team ? `"${r.user.team.name.replace(/"/g, '""')}"` : "",
            r.tasksCompleted,
            r.points,
          ].join(",")
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="leaderboard-${dayStr(weekStart)}-to-${dayStr(weekEnd)}.csv"`
      );
      return res.send(csv);
    }

    return res.json({
      success: true,
      message: "Leaderboard fetched",
      data: { weekStart, weekEnd, rows },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getPointsConfig = async (req, res) => {
  return res.json({ success: true, message: "Points config fetched", data: getPointsByPriority() });
};

export const updatePointsConfig = async (req, res) => {
  try {
    const { low, medium, high, critical } = req.body;
    const values = { low, medium, high, critical };
    for (const [key, val] of Object.entries(values)) {
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
        return res.status(400).json({ success: false, message: `${key} must be a non-negative number` });
      }
    }
    const updated = await setPointsByPriority(values);
    return res.json({ success: true, message: "Points config updated", data: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
