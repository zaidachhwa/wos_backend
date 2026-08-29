import Activity from "../models/Activity.js";
import Attendance from "../models/Attendance.js";
import Task from "../models/Task.js";
import { monthDayBounds } from "../utils/monthDayBounds.js";
import { getTenureThresholds } from "../utils/appraisalConfig.js";

// "YYYY-MM" -> UTC month bounds. Monthly grain doesn't need IST precision
// the way the weekly leaderboard's Monday-lock does.
export const monthBounds = (monthStr) => {
  const [y, m] = (monthStr || new Date().toISOString().slice(0, 7)).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1) - 1);
  return { start, end };
};

// Whole months of tenure as of `asOf` — a fresh joiner should read as 0, not
// negative or NaN if joinedAt is somehow in the future (clock skew, typo'd
// join date). Band boundaries (6mo, 12mo) are fixed by design; only the
// per-band task threshold is admin/hr-tunable (see utils/appraisalConfig.js)
// — a newcomer needs fewer completed tasks before a score shows, a
// long-tenured lead/TL is expected to have handled more before theirs does.
export const monthsBetween = (from, asOf) => {
  const f = new Date(from);
  const t = new Date(asOf);
  let months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth());
  if (t.getDate() < f.getDate()) months -= 1;
  return Math.max(0, months);
};
export const tenureBandFor = (months) => (months < 6 ? "new" : months < 12 ? "mid" : "senior");
export const minTasksForBand = (band) => {
  const t = getTenureThresholds();
  return band === "new" ? t.minTasksNew : band === "mid" ? t.minTasksMid : t.minTasksSenior;
};

// Score = 100 - (bugs + client-requested changes + late marks + leaves) per
// completed task, so defects and attendance issues are judged relative to
// output volume rather than as raw counts. null (not 0) below the tenure
// band's confidence floor — a single-task month shouldn't read as a 0% or
// 100% appraisal, and that floor is tenure-aware (see minTasksForBand).
export const scoreFor = (totalTasks, defectCount, minTasksForScore) => {
  if (totalTasks < minTasksForScore) return null;
  return Math.max(0, Math.min(100, Math.round(100 - (defectCount / totalTasks) * 100)));
};

export const emptyStats = () => ({ totalTasks: 0, bugs: 0, clientChanges: 0, lates: 0, leaves: 0 });
export const defectCountOf = (s) => s.bugs + s.clientChanges + s.lates + s.leaves;

// One person's full itemized appraisal for a month — bug/client-change task
// list, late/leave entries with dates and notes, not just counts. Shared by
// the "me" endpoint (self), the admin/subadmin/hr "view anyone" endpoint,
// and the monthly memo sweep (services/memoSweep.js), so all three always
// agree on exactly what counts toward the score.
export const computeUserAppraisal = async (userId, monthStr, joinedAt) => {
  const { start, end } = monthBounds(monthStr);
  const { dayStart, dayEnd } = monthDayBounds(monthStr);
  const tenureMonths = monthsBetween(joinedAt, end);
  const tenureBand = tenureBandFor(tenureMonths);
  const minTasksForScore = minTasksForBand(tenureBand);

  const completions = await Activity.find({
    entityType: "task",
    "meta.statusTo": "completed",
    createdAt: { $gte: start, $lte: end },
  }).select("entityId createdAt");

  const latestByTask = new Map();
  for (const a of completions) {
    const key = String(a.entityId);
    const existing = latestByTask.get(key);
    if (!existing || a.createdAt > existing.createdAt) latestByTask.set(key, a);
  }

  const [tasks, attendance] = await Promise.all([
    Task.find({ _id: { $in: [...latestByTask.keys()] }, assignees: userId }).select("title type isClientChange"),
    Attendance.find({ user: userId, date: { $gte: dayStart, $lte: dayEnd } })
      .select("type date note source")
      .sort("-date"),
  ]);

  const stats = emptyStats();
  const bugTasks = [];
  const clientChangeTasks = [];
  for (const task of tasks) {
    stats.totalTasks += 1;
    const completedAt = latestByTask.get(String(task._id))?.createdAt || null;
    if (task.type === "bug") {
      stats.bugs += 1;
      bugTasks.push({ _id: task._id, title: task.title, completedAt });
    }
    if (task.isClientChange) {
      stats.clientChanges += 1;
      clientChangeTasks.push({ _id: task._id, title: task.title, completedAt });
    }
  }
  bugTasks.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  clientChangeTasks.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  const lateEntries = [];
  const leaveEntries = [];
  for (const a of attendance) {
    const entry = { _id: a._id, date: a.date, note: a.note, source: a.source };
    if (a.type === "late") {
      stats.lates += 1;
      lateEntries.push(entry);
    } else if (a.type === "leave") {
      stats.leaves += 1;
      leaveEntries.push(entry);
    }
  }

  return {
    monthStart: start,
    monthEnd: end,
    totalTasks: stats.totalTasks,
    bugs: stats.bugs,
    clientChanges: stats.clientChanges,
    lates: stats.lates,
    leaves: stats.leaves,
    score: scoreFor(stats.totalTasks, defectCountOf(stats), minTasksForScore),
    tenureMonths,
    tenureBand,
    minTasksForScore,
    bugTasks,
    clientChangeTasks,
    lateEntries,
    leaveEntries,
  };
};
