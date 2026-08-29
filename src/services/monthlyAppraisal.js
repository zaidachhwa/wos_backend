import Activity from "../models/Activity.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import FollowUp from "../models/FollowUp.js";
import { monthlyAttendanceForUser } from "../utils/attendance.js";
import { getMonthlyPenalties } from "../utils/pointsConfig.js";
import { bandFor } from "../utils/performanceBand.js";

// "YYYY-MM" -> UTC month bounds. Monthly grain doesn't need IST precision
// the way the weekly leaderboard's Monday-lock does.
export const monthBounds = (monthStr) => {
  const [y, m] = (monthStr || new Date().toISOString().slice(0, 7)).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1) - 1);
  return { start, end };
};

// Monthly performance score = 100 - weighted penalty points per completed
// task. Unclamped by design (a bad month can go negative), null only when
// there's genuinely no output to divide by.
const scoreFor = (tasksCompleted, penaltyPoints) => {
  if (tasksCompleted <= 0) return null;
  return Number((100 - penaltyPoints / tasksCompleted).toFixed(2));
};

// The pure computation behind /appraisal — shared by the HTTP handler
// (appraisalController.js) and the monthly memo sweep (memoSweep.js), so
// both are guaranteed to agree on every number and every red/yellow/green
// band decision.
export const computeMonthlyAppraisal = async ({ start, end, rosterFilter }) => {
  const [completions, roster] = await Promise.all([
    Activity.find({
      entityType: "task",
      "meta.statusTo": "completed",
      createdAt: { $gte: start, $lte: end },
    }).select("entityId createdAt"),
    User.find(rosterFilter)
      .select("name role designation team shiftStart shiftEnd")
      .populate("team", "name performanceThresholds"),
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
  const rosterIds = roster.map((u) => u._id);
  const [tasks, followUps] = await Promise.all([
    Task.find({ _id: { $in: taskIds } }).select("assignees type isClientChange"),
    FollowUp.find({
      user: { $in: rosterIds },
      date: { $gte: start.toISOString().slice(0, 10), $lte: end.toISOString().slice(0, 10) },
      type: { $in: ["morning", "evening"] },
      status: { $in: ["submitted", "reviewed"] },
    }).select("user type date submittedAt"),
  ]);

  const statsByUser = new Map();
  for (const task of tasks) {
    for (const assigneeId of task.assignees) {
      const id = String(assigneeId);
      const stats = statsByUser.get(id) || { tasksCompleted: 0, bugs: 0, clientChanges: 0 };
      stats.tasksCompleted += 1;
      if (task.type === "bug") stats.bugs += 1;
      if (task.isClientChange) stats.clientChanges += 1;
      statsByUser.set(id, stats);
    }
  }

  // Per user, per day: {morning: submittedAt|null, evening: submittedAt|null} —
  // what monthlyAttendanceForUser needs to derive late marks/leaves.
  const followUpsByUser = new Map();
  for (const f of followUps) {
    const id = String(f.user);
    const byDate = followUpsByUser.get(id) || new Map();
    const entry = byDate.get(f.date) || { morning: null, evening: null };
    entry[f.type] = f.submittedAt;
    byDate.set(f.date, entry);
    followUpsByUser.set(id, byDate);
  }

  const monthlyPenalties = getMonthlyPenalties();

  const unranked = roster.map((u) => {
    const id = String(u._id);
    const stats = statsByUser.get(id) || { tasksCompleted: 0, bugs: 0, clientChanges: 0 };
    const { lateMarks, leaves } = monthlyAttendanceForUser({
      shiftStart: u.shiftStart,
      shiftEnd: u.shiftEnd,
      monthStart: start,
      followUpsByDate: followUpsByUser.get(id) || new Map(),
    });
    const penaltyPoints =
      leaves * monthlyPenalties.leave +
      lateMarks * monthlyPenalties.lateMark +
      stats.clientChanges * monthlyPenalties.clientChange +
      stats.bugs * monthlyPenalties.bug;
    const score = scoreFor(stats.tasksCompleted, penaltyPoints);

    return {
      user: {
        _id: u._id,
        name: u.name,
        role: u.role,
        designation: u.designation,
        team: u.team ? { _id: u.team._id, name: u.team.name, performanceThresholds: u.team.performanceThresholds } : null,
      },
      tasksCompleted: stats.tasksCompleted,
      bugs: stats.bugs,
      clientChanges: stats.clientChanges,
      lateMarks,
      leaves,
      penaltyPoints,
      score,
      band: bandFor(score, u.team?.performanceThresholds),
    };
  });
  // Highest score first; null (no completed tasks) sorts last.
  unranked.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));

  // Competition ranking: ties share a rank, next distinct rank skips ahead
  // (1, 1, 3, 4, ...) — same convention as the weekly leaderboard.
  let rank = 0;
  let prevScore; // undefined sentinel — score is always a number or null, never undefined
  const rows = unranked.map((row, index) => {
    if (row.score !== prevScore) rank = index + 1;
    prevScore = row.score;
    return { ...row, rank };
  });

  return { rows, configuration: monthlyPenalties };
};
