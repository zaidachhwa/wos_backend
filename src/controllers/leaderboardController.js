import Activity from "../models/Activity.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import Project from "../models/Project.js";
import { pointsForCompletedTask } from "../utils/points.js";
import {
  getPointsByPriority,
  setPointsByPriority,
  getPenalties,
  setPenalties,
  getMonthlyPenalties,
  setMonthlyPenalties,
  getOfficeLocation,
  setOfficeLocation,
} from "../utils/pointsConfig.js";
import { resolveDepartmentScope } from "../utils/departmentScope.js";
import { applyOverduePenalties } from "../services/overdueSweep.js";
import { istDayStr, istClock } from "../utils/istTime.js";

// The IST calendar date (YYYY-MM-DD) of the Monday that starts `date`'s
// week. Shifts by +5:30 purely to read the correct IST day-of-week/date —
// never used as a real instant itself, see utils/istTime.js.
const mondayDateStr = (date) => {
  const ist = new Date(new Date(date).getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay(); // 0 = Sun .. 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;
  ist.setUTCDate(ist.getUTCDate() + diff);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
};

// Real, correct UTC instant for that Monday's IST midnight — built via the
// same "+05:30" ISO-offset trick as taskDates.js, so it's safe to use
// directly in DB range queries (unlike a shift-then-read Date, which only
// has meaningful *symbolic* digits, not a meaningful real timestamp).
const mondayOf = (date) => new Date(`${mondayDateStr(date)}T00:00:00+05:30`);

const weekBoundsOf = (date) => {
  const start = mondayOf(date);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
  return { start, end };
};

const dayStr = (d) => istDayStr(d);

const REPORT_ROLES = ["admin", "manager", "subadmin"];

export const getLeaderboard = async (req, res) => {
  try {
    const format = req.query.format;
    const isReporter = REPORT_ROLES.includes(req.user.role);

    if (format === "csv" && !isReporter) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // ponytail: locked to Monday-only per requirement, checked against IST
    // (same clock the week math below already assumes). CSV export is an
    // explicit admin/manager report action, so it bypasses the lock —
    // otherwise there'd be no way to pull last week's numbers on a Friday.
    // Admins also see the live view any day, for oversight.
    const bypassLock = format === "csv" || req.user.role === "admin" || req.user.role === "subadmin";
    if (!bypassLock && istClock(new Date()).dayOfWeek !== 1) {
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
    const scope = await resolveDepartmentScope(req.user);
    if (scope) {
      rosterFilter.role = { $nin: ["admin", "subadmin"] };
      if (req.query.team) {
        if (!scope.teamIds.map(String).includes(String(req.query.team))) {
          return res.status(403).json({ success: false, message: "Forbidden" });
        }
        rosterFilter.team = req.query.team;
      } else {
        rosterFilter.$or = [{ team: { $in: scope.teamIds } }, { _id: req.user._id }];
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
      "title priority assignees bonusPoints deadline endTime project"
    );
    const taskById = new Map(tasks.map((t) => [String(t._id), t]));

    const projectIds = [...new Set(tasks.map((t) => String(t.project)))];
    const projects = await Project.find({ _id: { $in: projectIds } }).select("weightage");
    const weightageByProject = new Map(projects.map((p) => [String(p._id), p.weightage || 0]));

    const pointsByUser = new Map();
    const tasksByUser = new Map();
    for (const [taskId, activity] of latestByTask) {
      const task = taskById.get(taskId);
      if (!task) continue;
      const points = pointsForCompletedTask(task, activity.createdAt, weightageByProject.get(String(task.project)));
      // Confirmed: every assignee gets full points, not split.
      for (const assigneeId of task.assignees) {
        const id = String(assigneeId);
        pointsByUser.set(id, (pointsByUser.get(id) || 0) + points);
        tasksByUser.set(id, (tasksByUser.get(id) || 0) + 1);
      }
    }

    const penaltyActivities = await Activity.find({
      entityType: "task",
      action: { $in: ["overdue_penalized", "bug_logged"] },
      createdAt: { $gte: weekStart, $lte: weekEnd },
    }).select("meta");

    for (const activity of penaltyActivities) {
      for (const userId of activity.meta?.users || []) {
        pointsByUser.set(userId, (pointsByUser.get(userId) || 0) + (activity.meta.points || 0));
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
  return res.json({
    success: true,
    message: "Points config fetched",
    data: {
      pointsByPriority: getPointsByPriority(),
      penalties: getPenalties(),
      monthlyPenalties: getMonthlyPenalties(),
      officeLocation: getOfficeLocation(),
    },
  });
};

const validateNonNegative = (values, requiredKeys, label) => {
  for (const key of requiredKeys) {
    const val = values[key];
    if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
      return `${label}.${key} must be a non-negative number`;
    }
  }
  return null;
};

// lat/lng/radiusMeters may each be null (not configured yet) — but if any
// one is set, all three must be valid together, since a partial office
// location can't be used for a distance check.
const validateOfficeLocation = (loc) => {
  const allNull = loc.lat === null && loc.lng === null && loc.radiusMeters === null;
  if (allNull) return null;
  if (typeof loc.lat !== "number" || loc.lat < -90 || loc.lat > 90) {
    return "officeLocation.lat must be a number between -90 and 90";
  }
  if (typeof loc.lng !== "number" || loc.lng < -180 || loc.lng > 180) {
    return "officeLocation.lng must be a number between -180 and 180";
  }
  if (typeof loc.radiusMeters !== "number" || !Number.isFinite(loc.radiusMeters) || loc.radiusMeters <= 0) {
    return "officeLocation.radiusMeters must be a positive number";
  }
  return null;
};

export const runOverdueSweep = async (req, res) => {
  try {
    const result = await applyOverduePenalties();
    return res.json({ success: true, message: "Overdue sweep completed", data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updatePointsConfig = async (req, res) => {
  try {
    const { pointsByPriority, penalties, monthlyPenalties, officeLocation } = req.body;
    const pointsError =
      pointsByPriority && validateNonNegative(pointsByPriority, ["low", "medium", "high"], "pointsByPriority");
    if (pointsError) return res.status(400).json({ success: false, message: pointsError });
    const penaltiesError =
      penalties && validateNonNegative(penalties, ["completedLate", "overdue", "bug"], "penalties");
    if (penaltiesError) return res.status(400).json({ success: false, message: penaltiesError });
    const monthlyPenaltiesError =
      monthlyPenalties &&
      validateNonNegative(monthlyPenalties, ["leave", "lateMark", "clientChange", "bug"], "monthlyPenalties");
    if (monthlyPenaltiesError) return res.status(400).json({ success: false, message: monthlyPenaltiesError });
    const officeLocationError = officeLocation && validateOfficeLocation(officeLocation);
    if (officeLocationError) return res.status(400).json({ success: false, message: officeLocationError });

    const updatedPoints = pointsByPriority ? await setPointsByPriority(pointsByPriority) : getPointsByPriority();
    const updatedPenalties = penalties ? await setPenalties(penalties) : getPenalties();
    const updatedMonthlyPenalties = monthlyPenalties
      ? await setMonthlyPenalties(monthlyPenalties)
      : getMonthlyPenalties();
    const updatedOfficeLocation = officeLocation ? await setOfficeLocation(officeLocation) : getOfficeLocation();

    return res.json({
      success: true,
      message: "Points config updated",
      data: {
        pointsByPriority: updatedPoints,
        penalties: updatedPenalties,
        monthlyPenalties: updatedMonthlyPenalties,
        officeLocation: updatedOfficeLocation,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
