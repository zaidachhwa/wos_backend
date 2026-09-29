import Activity from "../../models/Activity.js";
import BugReport from "../../models/BugReport.js";
import Project from "../../models/Project.js";
import Task from "../../models/Task.js";
import { combineDeadlineAndTime, endOfDayLocal } from "../../utils/taskDates.js";
import { monthPeriod } from "./appraisalPeriod.js";
import { roundStore } from "./appraisalMath.js";

// Collects every objective input the engine scores, for many employees at
// once (a handful of queries per month, not per person).
//
// Deliberately NOT read here: Attendance and FollowUp. Appraisal leaves and
// late marks are the HR-entered numbers on EmployeeAppraisal.hrInputs —
// the follow-up-driven attendance sweep keeps running for its own purposes
// but never feeds a score.

const deadlineCutoff = (task) =>
  task.deadline ? (task.endTime ? combineDeadlineAndTime(task.deadline, task.endTime) : endOfDayLocal(task.deadline)) : null;

// Deadlines are stored as a date at UTC midnight (date-only picker), so the
// month's deadline window is compared on the UTC calendar date.
const deadlineDay = (task) => (task.deadline ? new Date(task.deadline).toISOString().slice(0, 10) : null);

// Status of each task as of `asOf`, from the Activity status trail: the
// completion instant if its last status change at/before asOf was to
// "completed", else null. Tasks created straight into "completed" (no trail)
// fall back to createdAt.
const completionTimesAsOf = async (tasks, asOf) => {
  const ids = tasks.map((t) => t._id);
  const trail = await Activity.find({
    entityType: "task",
    entityId: { $in: ids },
    "meta.statusTo": { $exists: true },
    createdAt: { $lte: asOf },
  })
    .select("entityId createdAt meta.statusTo")
    .sort({ createdAt: 1 })
    .lean();

  const last = new Map();
  for (const a of trail) last.set(String(a.entityId), a);

  const result = new Map();
  for (const t of tasks) {
    const a = last.get(String(t._id));
    if (a) result.set(String(t._id), a.meta.statusTo === "completed" ? a.createdAt : null);
    else if (t.status === "completed" && t.createdAt <= asOf) result.set(String(t._id), t.createdAt);
    else result.set(String(t._id), null);
  }
  return result;
};

const emptyTaskStats = () => ({
  total: 0,
  completed: 0,
  pending: 0,
  overdue: 0,
  completedOnTime: 0,
  completedLate: 0,
  list: [],
});

export const collectMetrics = async ({ userIds, month, settings, hrInputsByUser = new Map(), now = new Date() }) => {
  const period = monthPeriod(month);
  const asOf = now < period.endAt ? now : period.endAt;
  const monthStartUtc = new Date(`${period.dayStart}T00:00:00.000Z`);
  const monthEndUtc = new Date(`${period.dayEnd}T23:59:59.999Z`);
  const idSet = new Set(userIds.map(String));

  // Candidates: due this month, touched this month, or carried in overdue
  // from an earlier month. Precise inclusion is decided per task below.
  const tasks = await Task.find({
    assignees: { $in: userIds },
    approvalStatus: { $nin: ["pending", "rejected"] },
    createdAt: { $lte: asOf },
    $or: [
      { deadline: { $gte: monthStartUtc, $lte: monthEndUtc } },
      { updatedAt: { $gte: period.startAt } },
      { deadline: { $lt: monthStartUtc }, status: { $ne: "completed" } },
    ],
  })
    .select("title project assignees status deadline endTime createdAt isClientChange clientChangeCategory type")
    .lean();

  const completedAt = await completionTimesAsOf(tasks, asOf);

  const clientChangeTasks = await Task.find({
    assignees: { $in: userIds },
    isClientChange: true,
    createdAt: { $gte: period.startAt, $lte: period.endAt },
  })
    .select("title project assignees clientChangeCategory createdAt")
    .lean();

  const [projects, bugs] = await Promise.all([
    Project.find({
      $or: [
        { _id: { $in: [...new Set([...tasks, ...clientChangeTasks].map((t) => String(t.project)))] } },
        { members: { $in: userIds } },
      ],
    })
      .select("name weightage status deadline members")
      .lean(),
    BugReport.find({ employee: { $in: userIds }, date: { $gte: period.dayStart, $lte: period.dayEnd } })
      .select("employee project title severity date status includeInAppraisal")
      .populate("project", "name")
      .lean(),
  ]);
  const projectById = new Map(projects.map((p) => [String(p._id), p]));

  const byUser = new Map(userIds.map((id) => [String(id), { tasks: emptyTaskStats(), projectAgg: new Map() }]));

  for (const task of tasks) {
    const doneAt = completedAt.get(String(task._id));
    // Finished before this month started: it belongs to an earlier month.
    if (doneAt && doneAt < period.startAt) continue;
    const day = deadlineDay(task);
    const dueInMonth = day && day >= period.dayStart && day <= period.dayEnd;
    const completedInMonth = doneAt && doneAt >= period.startAt && doneAt <= asOf;
    const carriedOverdue = day && day < period.dayStart && !doneAt;
    if (!dueInMonth && !completedInMonth && !carriedOverdue) continue;

    const cutoff = deadlineCutoff(task);
    const completed = Boolean(doneAt);
    const onTime = completed && (!cutoff || doneAt <= cutoff);
    const late = completed && cutoff && doneAt > cutoff;
    const overdue = !completed && cutoff && cutoff < asOf && task.status !== "client_review";
    const state = completed ? (onTime ? "completed_on_time" : "completed_late") : overdue ? "overdue" : "pending";

    for (const assignee of task.assignees) {
      const bucket = byUser.get(String(assignee));
      if (!bucket || !idSet.has(String(assignee))) continue;
      const s = bucket.tasks;
      s.total += 1;
      if (completed) s.completed += 1;
      else s.pending += 1;
      if (onTime) s.completedOnTime += 1;
      if (late) s.completedLate += 1;
      if (overdue) s.overdue += 1;
      s.list.push({
        _id: task._id,
        title: task.title,
        type: task.type,
        project: projectById.get(String(task.project))?.name || "",
        deadline: task.deadline,
        completedAt: doneAt,
        state,
      });

      const key = String(task.project);
      const agg = bucket.projectAgg.get(key) || { total: 0, completed: 0 };
      agg.total += 1;
      if (completed) agg.completed += 1;
      bucket.projectAgg.set(key, agg);
    }
  }

  // Bugs
  const severities = new Map((settings.bugSeverities || []).map((s) => [s.key, s]));
  const countable = new Set(settings.bugCountableStatuses || []);
  const bugsByUser = new Map();
  for (const bug of bugs) {
    const key = String(bug.employee);
    if (!bugsByUser.has(key)) bugsByUser.set(key, []);
    bugsByUser.get(key).push(bug);
  }

  // Client changes
  const categories = new Map((settings.clientChangeCategories || []).map((c) => [c.key, c]));
  const ccByUser = new Map();
  for (const t of clientChangeTasks) {
    for (const a of t.assignees) {
      const key = String(a);
      if (!idSet.has(key)) continue;
      if (!ccByUser.has(key)) ccByUser.set(key, []);
      ccByUser.get(key).push(t);
    }
  }

  const result = new Map();
  for (const userId of userIds) {
    const key = String(userId);
    const bucket = byUser.get(key);
    const t = bucket.tasks;

    // Projects: weightage-weighted completion over projects with work this
    // month. If none of them has a weightage configured, weight equally.
    const projectRows = [...bucket.projectAgg.entries()].map(([projectId, agg]) => {
      const p = projectById.get(projectId);
      const delayed = p?.deadline && new Date(p.deadline) < asOf && !["completed", "cancelled"].includes(p?.status);
      return {
        projectId,
        name: p?.name || "Unknown project",
        weightage: p?.weightage || 0,
        status: p?.status || null,
        delayed: Boolean(delayed),
        total: agg.total,
        completed: agg.completed,
        completionRate: agg.total ? agg.completed / agg.total : 0,
      };
    });
    const weightFallback = projectRows.length > 0 && projectRows.every((r) => !r.weightage);
    let weightSum = 0;
    let weighted = 0;
    for (const r of projectRows) {
      r.effectiveWeight = weightFallback ? 1 : r.weightage;
      weightSum += r.effectiveWeight;
      weighted += r.effectiveWeight * r.completionRate;
    }
    const assignedOnly = projects
      .filter((p) => (p.members || []).some((m) => String(m) === key) && !bucket.projectAgg.has(String(p._id)))
      .map((p) => ({ projectId: String(p._id), name: p.name, weightage: p.weightage || 0, status: p.status }));

    // Bugs
    const bySeverity = {};
    for (const s of settings.bugSeverities || []) {
      bySeverity[s.key] = { key: s.key, label: s.label, penalty: s.penalty, count: 0, subtotal: 0 };
    }
    let penaltyPoints = 0;
    let counted = 0;
    const bugList = [];
    for (const bug of bugsByUser.get(key) || []) {
      const sev = severities.get(bug.severity);
      const counts = bug.includeInAppraisal && countable.has(bug.status) && Boolean(sev);
      if (counts) {
        counted += 1;
        bySeverity[bug.severity].count += 1;
        bySeverity[bug.severity].subtotal += sev.penalty;
        penaltyPoints += sev.penalty;
      }
      bugList.push({
        _id: bug._id,
        title: bug.title,
        project: bug.project?.name || "",
        severity: bug.severity,
        severityLabel: sev?.label || bug.severity,
        penalty: counts ? sev.penalty : 0,
        status: bug.status,
        date: bug.date,
        counted: counts,
      });
    }

    // Client changes
    const ccList = [];
    let penalized = 0;
    let uncategorized = 0;
    const byCategory = {};
    for (const cc of ccByUser.get(key) || []) {
      const cat = cc.clientChangeCategory ? categories.get(cc.clientChangeCategory) : null;
      if (!cc.clientChangeCategory) uncategorized += 1;
      const counts = cat ? cat.countsAgainstEmployee : !cc.clientChangeCategory && settings.uncategorizedClientChangeCounts;
      if (counts) penalized += 1;
      const catKey = cc.clientChangeCategory || "uncategorized";
      byCategory[catKey] = (byCategory[catKey] || 0) + 1;
      ccList.push({
        _id: cc._id,
        title: cc.title,
        project: projectById.get(String(cc.project))?.name || "",
        category: cc.clientChangeCategory,
        categoryLabel: cat?.label || "Uncategorized",
        counted: Boolean(counts),
        createdAt: cc.createdAt,
      });
    }

    const hr = hrInputsByUser.get(key) || {};
    result.set(key, {
      asOf,
      tasks: {
        total: t.total,
        completed: t.completed,
        pending: t.pending,
        overdue: t.overdue,
        completedOnTime: t.completedOnTime,
        completedLate: t.completedLate,
        completionRate: t.total ? roundStore(t.completed / t.total) : null,
        list: t.list,
      },
      projects: {
        list: projectRows,
        assignedOnly,
        weightFallback,
        weightedCompletion: weightSum ? roundStore(weighted / weightSum) : null,
        weightedLoad: roundStore(weighted),
        completedProjects: projectRows.filter((r) => r.status === "completed").length,
        ongoingProjects: projectRows.filter((r) => r.status !== "completed" && r.status !== "cancelled").length,
        delayedProjects: projectRows.filter((r) => r.delayed).length,
      },
      bugs: { total: bugList.length, counted, penaltyPoints: roundStore(penaltyPoints), bySeverity, list: bugList },
      clientChanges: { total: ccList.length, penalized, uncategorized, byCategory, list: ccList },
      hr: { leaves: hr.leaves ?? null, lateMarks: hr.lateMarks ?? null },
    });
  }
  return result;
};
