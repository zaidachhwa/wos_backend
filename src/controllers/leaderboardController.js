import Activity from "../models/Activity.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { pointsForCompletedTask } from "../utils/points.js";

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

export const getLeaderboard = async (req, res) => {
  try {
    const anchor = req.query.week ? new Date(req.query.week) : new Date();
    if (Number.isNaN(anchor.getTime())) {
      return res.status(400).json({ success: false, message: "week must be a valid date" });
    }
    const { start: weekStart, end: weekEnd } = weekBoundsOf(anchor);

    const [completions, roster] = await Promise.all([
      Activity.find({
        entityType: "task",
        "meta.statusTo": "completed",
        createdAt: { $gte: weekStart, $lte: weekEnd },
      }).select("entityId createdAt"),
      User.find({ isActive: true }).select("name role designation"),
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
      user: { _id: u._id, name: u.name, role: u.role, designation: u.designation },
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
