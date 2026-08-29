import Activity from "../models/Activity.js";
import Attendance from "../models/Attendance.js";
import Department from "../models/Department.js";
import Task from "../models/Task.js";
import Team from "../models/Team.js";
import User from "../models/User.js";
import { monthDayBounds } from "../utils/monthDayBounds.js";
import {
  monthBounds,
  monthsBetween,
  tenureBandFor,
  minTasksForBand,
  scoreFor,
  emptyStats,
  defectCountOf,
  computeUserAppraisal,
} from "../services/monthlyAppraisal.js";
import { getTenureThresholds, setTenureThresholds } from "../utils/appraisalConfig.js";
import { bandFor } from "../utils/performanceBand.js";
import { runMonthlyMemoSweep } from "../services/memoSweep.js";

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

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
    const [data, team] = await Promise.all([
      computeUserAppraisal(req.user._id, req.query.month, joinedAt),
      req.user.team ? Team.findById(req.user.team, "performanceThresholds") : null,
    ]);
    return res.json({
      success: true,
      message: "Appraisal fetched",
      data: { ...data, band: bandFor(data.score, team?.performanceThresholds) },
    });
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
      .populate("team", "name performanceThresholds")
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

    return res.json({
      success: true,
      message: "Appraisal fetched",
      data: { user: targetInfo, ...data, band: bandFor(data.score, target.team?.performanceThresholds) },
    });
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
        .populate("team", "name performanceThresholds")
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
      const score = scoreFor(stats.totalTasks, defectCountOf(stats), minTasksForScore);
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
        score,
        band: bandFor(score, u.team?.performanceThresholds),
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

// Manual "run it right now" escape hatch for the monthly Red/Yellow/Green
// memo sweep — mirrors leaderboardController.runOverdueSweep /
// attendanceController.runAttendanceSweepNow.
export const runMemoSweep = async (req, res) => {
  try {
    const result = await runMonthlyMemoSweep(req.body?.month);
    return res.json({ success: true, message: "Memo sweep completed", data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
