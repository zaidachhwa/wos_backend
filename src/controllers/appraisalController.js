import Activity from "../models/Activity.js";
import Attendance from "../models/Attendance.js";
import Department from "../models/Department.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { monthDayBounds } from "../utils/monthDayBounds.js";
import { getTenureThresholds, setTenureThresholds } from "../utils/appraisalConfig.js";

// "YYYY-MM" -> UTC month bounds. Monthly grain doesn't need IST precision
// the way the weekly leaderboard's Monday-lock does.
const monthBounds = (monthStr) => {
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
const monthsBetween = (from, asOf) => {
  const f = new Date(from);
  const t = new Date(asOf);
  let months = (t.getFullYear() - f.getFullYear()) * 12 + (t.getMonth() - f.getMonth());
  if (t.getDate() < f.getDate()) months -= 1;
  return Math.max(0, months);
};
const tenureBandFor = (months) => (months < 6 ? "new" : months < 12 ? "mid" : "senior");
const minTasksForBand = (band) => {
  const t = getTenureThresholds();
  return band === "new" ? t.minTasksNew : band === "mid" ? t.minTasksMid : t.minTasksSenior;
};

// Score = 100 - (bugs + client-requested changes + late marks + leaves) per
// completed task, so defects and attendance issues are judged relative to
// output volume rather than as raw counts. null (not 0) below the tenure
// band's confidence floor — a single-task month shouldn't read as a 0% or
// 100% appraisal, and that floor is now tenure-aware (see minTasksForBand).
const scoreFor = (totalTasks, defectCount, minTasksForScore) => {
  if (totalTasks < minTasksForScore) return null;
  return Math.max(0, Math.min(100, Math.round(100 - (defectCount / totalTasks) * 100)));
};

const emptyStats = () => ({ totalTasks: 0, bugs: 0, clientChanges: 0, lates: 0, leaves: 0 });
const defectCountOf = (s) => s.bugs + s.clientChanges + s.lates + s.leaves;
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// One person's full itemized appraisal for a month — bug/client-change task
// list, late/leave entries with dates and notes, not just counts. Shared by
// the "me" endpoint (self) and the admin/subadmin/hr "view anyone" endpoint
// below, so both always agree on exactly what counts toward the score.
const computeUserAppraisal = async (userId, monthStr, joinedAt) => {
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

const individualCsv = (target, data) => {
  const month = data.monthStart.toISOString().slice(0, 7);
  const rows = [
    ...data.bugTasks.map((t) => [t.completedAt ? t.completedAt.toISOString().slice(0, 10) : "", "Bug", t.title]),
    ...data.clientChangeTasks.map((t) => [
      t.completedAt ? t.completedAt.toISOString().slice(0, 10) : "",
      "Client change",
      t.title,
    ]),
    ...data.lateEntries.map((e) => [e.date, "Late", e.note || ""]),
    ...data.leaveEntries.map((e) => [e.date, e.source === "auto" ? "Absent" : "Leave", e.note || ""]),
  ].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  return [
    `Appraisal detail — ${target.name} (${month})`,
    `Role,${target.role}`,
    `Department,${target.department?.name || ""}`,
    `Team,${target.team?.name || ""}`,
    `Tasks done,${data.totalTasks}`,
    `Bugs,${data.bugs}`,
    `Client changes,${data.clientChanges}`,
    `Late marks,${data.lates}`,
    `Leaves,${data.leaves}`,
    `Tenure,${data.tenureMonths} months (${data.tenureBand})`,
    `Score,${data.score === null ? "" : data.score}`,
    ...(data.score === null
      ? [`Score note,Needs ${data.minTasksForScore} completed tasks this month to show (has ${data.totalTasks})`]
      : []),
    "",
    "Date,Type,Detail",
    ...rows.map((r) => [r[0], r[1], csvCell(r[2])].join(",")),
  ].join("\n");
};

// Own-profile view for everyone else (manager/sublead/member): just their
// own itemized detail for the month, no roster/team visibility.
export const getMyAppraisal = async (req, res) => {
  try {
    const joinedAt = req.user.joinedAt || req.user.createdAt;
    const data = await computeUserAppraisal(req.user._id, req.query.month, joinedAt);
    return res.json({ success: true, message: "Appraisal fetched", data });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// admin/hr only (see routes) drilling into one specific person's itemized
// detail — same shape getMyAppraisal returns for yourself, plus the
// target's identity and an optional CSV download.
export const getUserAppraisal = async (req, res) => {
  try {
    const target = await User.findById(req.params.userId)
      .select("name role designation team department joinedAt createdAt")
      .populate("team", "name")
      .populate("department", "name");
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const data = await computeUserAppraisal(target._id, req.query.month, target.joinedAt || target.createdAt);
    const targetInfo = {
      _id: target._id,
      name: target.name,
      role: target.role,
      designation: target.designation,
      team: target.team ? { _id: target.team._id, name: target.team.name } : null,
      department: target.department ? { _id: target.department._id, name: target.department.name } : null,
    };

    if (req.query.format === "csv") {
      const month = data.monthStart.toISOString().slice(0, 7);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="appraisal-${target.name.replace(/\s+/g, "-")}-${month}.csv"`
      );
      return res.send(individualCsv(targetInfo, data));
    }

    return res.json({ success: true, message: "Appraisal fetched", data: { user: targetInfo, ...data } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getAppraisal = async (req, res) => {
  try {
    const { start, end } = monthBounds(req.query.month);
    const { dayStart, dayEnd } = monthDayBounds(req.query.month);

    // admin and hr only reach here (see routes) — both get an unrestricted,
    // org-wide roster, department-wise. Neither does task work themselves,
    // so both are excluded from the roster rows. "unassigned" (no query
    // value) matches users with no department set at all.
    const rosterFilter = { isActive: true, role: { $nin: ["admin", "hr"] } };
    if (req.query.department === "unassigned") rosterFilter.department = null;
    else if (req.query.department) rosterFilter.department = req.query.department;
    if (req.query.team) rosterFilter.team = req.query.team;

    const [completions, roster] = await Promise.all([
      Activity.find({
        entityType: "task",
        "meta.statusTo": "completed",
        createdAt: { $gte: start, $lte: end },
      }).select("entityId createdAt"),
      User.find(rosterFilter)
        .select("name role designation team department joinedAt createdAt")
        .populate("team", "name")
        .populate("department", "name"),
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
    const [tasks, attendance] = await Promise.all([
      Task.find({ _id: { $in: taskIds } }).select("assignees type isClientChange"),
      Attendance.find({ user: { $in: rosterIds }, date: { $gte: dayStart, $lte: dayEnd } }).select("user type"),
    ]);

    const statsByUser = new Map();
    const getStats = (id) => {
      let s = statsByUser.get(id);
      if (!s) {
        s = emptyStats();
        statsByUser.set(id, s);
      }
      return s;
    };

    for (const task of tasks) {
      for (const assigneeId of task.assignees) {
        const stats = getStats(String(assigneeId));
        stats.totalTasks += 1;
        if (task.type === "bug") stats.bugs += 1;
        if (task.isClientChange) stats.clientChanges += 1;
      }
    }
    for (const a of attendance) {
      const stats = getStats(String(a.user));
      if (a.type === "late") stats.lates += 1;
      else if (a.type === "leave") stats.leaves += 1;
    }

    const rows = roster.map((u) => {
      const stats = statsByUser.get(String(u._id)) || emptyStats();
      const tenureMonths = monthsBetween(u.joinedAt || u.createdAt, end);
      const tenureBand = tenureBandFor(tenureMonths);
      const minTasksForScore = minTasksForBand(tenureBand);
      return {
        user: {
          _id: u._id,
          name: u.name,
          role: u.role,
          designation: u.designation,
          team: u.team ? { _id: u.team._id, name: u.team.name } : null,
          department: u.department ? { _id: u.department._id, name: u.department.name } : null,
        },
        totalTasks: stats.totalTasks,
        bugs: stats.bugs,
        clientChanges: stats.clientChanges,
        lates: stats.lates,
        leaves: stats.leaves,
        tenureMonths,
        tenureBand,
        minTasksForScore,
        score: scoreFor(stats.totalTasks, defectCountOf(stats), minTasksForScore),
      };
    });
    rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

    if (req.query.format === "csv") {
      const header = "Department,Name,Role,Team,Tenure,Tasks done,Bugs,Client changes,Late marks,Leaves,Score";
      const month = req.query.month || new Date().toISOString().slice(0, 7);
      let scope = "all-departments";
      if (req.query.department === "unassigned") scope = "unassigned";
      else if (req.query.department) scope = (await Department.findById(req.query.department))?.name || "department";
      const csv = [
        header,
        ...rows.map((r) =>
          [
            csvCell(r.user.department?.name || "Unassigned"),
            csvCell(r.user.name),
            r.user.role,
            csvCell(r.user.team?.name || ""),
            csvCell(`${r.tenureMonths}mo (${r.tenureBand})`),
            r.totalTasks,
            r.bugs,
            r.clientChanges,
            r.lates,
            r.leaves,
            r.score === null ? "" : r.score,
          ].join(",")
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="appraisal-${scope.replace(/\s+/g, "-")}-${month}.csv"`
      );
      return res.send(csv);
    }

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

// The tenure-band task thresholds — admin/hr only (see routes).
export const getAppraisalConfig = async (req, res) => {
  return res.json({ success: true, message: "Appraisal config fetched", data: getTenureThresholds() });
};

export const updateAppraisalConfig = async (req, res) => {
  try {
    const { minTasksNew, minTasksMid, minTasksSenior } = req.body;
    const values = {};
    for (const [key, raw] of Object.entries({ minTasksNew, minTasksMid, minTasksSenior })) {
      if (raw === undefined) continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        return res.status(400).json({ success: false, message: `${key} must be a non-negative number` });
      }
      values[key] = num;
    }
    const updated = await setTenureThresholds(values);
    return res.json({ success: true, message: "Appraisal config updated", data: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
