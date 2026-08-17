import Activity from "../models/Activity.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { resolveDepartmentScope } from "../utils/departmentScope.js";

// "YYYY-MM" -> UTC month bounds. Monthly grain doesn't need IST precision
// the way the weekly leaderboard's Monday-lock does.
const monthBounds = (monthStr) => {
  const [y, m] = (monthStr || new Date().toISOString().slice(0, 7)).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1) - 1);
  return { start, end };
};

// Score = 100 - (bugs + client-requested changes) per completed task, so
// defects are judged relative to output volume rather than as raw counts.
// null (not 0) below the confidence floor — a single-task month shouldn't
// read as a 0% or 100% appraisal.
const MIN_TASKS_FOR_SCORE = 5;
const scoreFor = (totalTasks, defectCount) => {
  if (totalTasks < MIN_TASKS_FOR_SCORE) return null;
  return Math.max(0, Math.min(100, Math.round(100 - (defectCount / totalTasks) * 100)));
};

export const getAppraisal = async (req, res) => {
  try {
    const { start, end } = monthBounds(req.query.month);

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
        createdAt: { $gte: start, $lte: end },
      }).select("entityId createdAt"),
      User.find(rosterFilter).select("name role designation team").populate("team", "name"),
    ]);

    // Same dedupe as the leaderboard: only the latest completion per task
    // within the window counts, in case it was reopened and redone.
    const latestByTask = new Map();
    for (const a of completions) {
      const key = String(a.entityId);
      const existing = latestByTask.get(key);
      if (!existing || a.createdAt > existing.createdAt) latestByTask.set(key, a);
    }

    const taskIds = [...latestByTask.keys()];
    const tasks = await Task.find({ _id: { $in: taskIds } }).select("assignees type isClientChange");

    const statsByUser = new Map();
    for (const task of tasks) {
      for (const assigneeId of task.assignees) {
        const id = String(assigneeId);
        const stats = statsByUser.get(id) || { totalTasks: 0, bugs: 0, clientChanges: 0 };
        stats.totalTasks += 1;
        if (task.type === "bug") stats.bugs += 1;
        if (task.isClientChange) stats.clientChanges += 1;
        statsByUser.set(id, stats);
      }
    }

    const rows = roster.map((u) => {
      const stats = statsByUser.get(String(u._id)) || { totalTasks: 0, bugs: 0, clientChanges: 0 };
      return {
        user: {
          _id: u._id,
          name: u.name,
          role: u.role,
          designation: u.designation,
          team: u.team ? { _id: u.team._id, name: u.team.name } : null,
        },
        totalTasks: stats.totalTasks,
        bugs: stats.bugs,
        clientChanges: stats.clientChanges,
        score: scoreFor(stats.totalTasks, stats.bugs + stats.clientChanges),
      };
    });
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

    return res.json({
      success: true,
      message: "Appraisal fetched",
      data: { monthStart: start, monthEnd: end, rows },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
