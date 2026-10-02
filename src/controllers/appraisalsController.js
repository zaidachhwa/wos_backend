import AppraisalAuditLog from "../models/AppraisalAuditLog.js";
import AppraisalEmailLog from "../models/AppraisalEmailLog.js";
import AppraisalPeriod from "../models/AppraisalPeriod.js";
import EmployeeAppraisal from "../models/EmployeeAppraisal.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { EMAIL_STATUSES } from "../constants/appraisal.constants.js";
import { getActiveCriteria, getSettings, weightageStatus } from "../services/appraisal/appraisalConfig.js";
import { istMonthOf, isValidMonth, monthPeriod } from "../services/appraisal/appraisalPeriod.js";
import { roundDisplay } from "../services/appraisal/appraisalMath.js";
import {
  AppraisalError,
  appraisedUserFilter,
  ensureDrafts,
  finalizeAppraisal,
  recalculate,
  recalculateOne,
  reopenAppraisal,
  setEvaluation,
  submitAppraisal,
  getOrCreateDraft,
  updateHrInputs,
} from "../services/appraisal/appraisalService.js";
import { canManage, canViewAll, canViewAppraisal, isTeamLead, managedIdSet, sanitizeAppraisal } from "../services/appraisal/appraisalAccess.js";
import { processEmailQueue, queueDueEmails, retryEmail } from "../services/appraisal/appraisalEmails.js";
import { closeMonth } from "../services/appraisal/appraisalScheduler.js";
import { audit } from "../services/appraisal/appraisalAudit.js";
import { maybeSendDirectorDeptReport } from "../services/appraisal/directorDeptReport.js";

const USER_FIELDS = "name email role designation department team isActive";
const STALE_MS = 60 * 1000;

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

// AppraisalError carries a safe, user-facing message; anything else is an
// unexpected failure and is logged but never echoed to the client.
const handle = (res, error) => {
  if (error instanceof AppraisalError) return fail(res, error.statusCode, error.message);
  if (error?.name === "CastError") return fail(res, 400, "Invalid identifier");
  console.error(error);
  return fail(res, 500, "Something went wrong");
};

const monthParam = (value) => {
  const month = value || istMonthOf();
  if (!isValidMonth(month)) throw new AppraisalError("month must be YYYY-MM");
  if (month > istMonthOf()) throw new AppraisalError("Appraisals can't be opened for a future month");
  return month;
};

const loadAppraisal = async (id) => {
  const doc = await EmployeeAppraisal.findById(id);
  if (!doc) throw new AppraisalError("Appraisal not found", 404);
  return doc;
};

// Month roster: makes sure every currently-appraised employee has a draft,
// refreshes stale non-finalized ones, and returns everything for the month
// (finalized rows of people who have since left/changed role included).
const loadMonthRoster = async (month, { now = new Date() } = {}) => {
  const settings = await getSettings();
  if (!(await AppraisalPeriod.exists({ month, status: "closed" }))) {
    const users = await User.find(appraisedUserFilter(settings)).select("department");
    await ensureDrafts(users, month);
  }
  const docs = await EmployeeAppraisal.find({ month });
  const stale = docs.filter((d) => d.status !== "finalized" && (!d.calculatedAt || now - d.calculatedAt > STALE_MS));
  if (stale.length) await recalculate(stale, { now, settings });
  await EmployeeAppraisal.populate(docs, [
    { path: "user", select: USER_FIELDS, populate: { path: "department", select: "name" } },
  ]);
  return { docs, settings };
};

const rowOf = (d) => {
  const finalized = d.status === "finalized";
  const u = d.user || {};
  const manual = (d.entries || []).filter((e) => e.type === "manual");
  return {
    _id: d._id,
    month: d.month,
    user: {
      _id: u._id,
      name: u.name || d.employeeSnapshot?.name,
      email: u.email || d.employeeSnapshot?.email,
      role: u.role,
      designation: finalized ? d.employeeSnapshot?.designation : u.designation,
      isActive: u.isActive,
    },
    department: finalized
      ? { _id: d.employeeSnapshot?.departmentId || null, name: d.employeeSnapshot?.departmentName || "Unassigned" }
      : { _id: u.department?._id || null, name: u.department?.name || "Unassigned" },
    status: d.status,
    totalScore: d.totalScore,
    classification: d.classification,
    hrInputs: { leaves: d.hrInputs?.leaves ?? null, lateMarks: d.hrInputs?.lateMarks ?? null, scoreFrom: d.hrInputs?.scoreFrom ?? null, scoreTo: d.hrInputs?.scoreTo ?? null },
    bugs: d.metricsSnapshot?.bugs?.counted ?? 0,
    bugsTotal: d.metricsSnapshot?.bugs?.total ?? 0,
    manualRated: manual.filter((e) => e.complete).length,
    manualTotal: manual.length,
    missingInputs: d.missingInputs || [],
    calculatedAt: d.calculatedAt,
    finalizedAt: d.finalizedAt,
  };
};

const applyFilters = (rows, q) => {
  const search = String(q.search || "").trim().toLowerCase();
  return rows.filter((r) => {
    if (q.department === "unassigned" ? r.department._id : q.department && String(r.department._id) !== q.department) return false;
    if (q.designation && (r.user.designation || "").toLowerCase() !== String(q.designation).toLowerCase()) return false;
    if (q.employee && String(r.user._id) !== q.employee) return false;
    if (q.classification && r.classification?.key !== q.classification) return false;
    if (q.status && r.status !== q.status) return false;
    if (q.minScore !== undefined && q.minScore !== "" && r.totalScore < Number(q.minScore)) return false;
    if (q.maxScore !== undefined && q.maxScore !== "" && r.totalScore > Number(q.maxScore)) return false;
    if (search && !`${r.user.name} ${r.user.email} ${r.user._id}`.toLowerCase().includes(search)) return false;
    return true;
  });
};

const statsOf = (rows, settings) => {
  const finalized = rows.filter((r) => r.status === "finalized");
  const byClassification = Object.fromEntries((settings.classifications || []).map((c) => [c.key, 0]));
  for (const r of rows) if (r.classification?.key && r.classification.key in byClassification) byClassification[r.classification.key] += 1;
  return {
    totalEmployees: rows.length,
    completed: finalized.length,
    pending: rows.length - finalized.length,
    byClassification,
    averageScore: rows.length ? roundDisplay(rows.reduce((s, r) => s + r.totalScore, 0) / rows.length) : 0,
  };
};

// ------------------------------------------------------------------ roster

export const listAppraisals = async (req, res) => {
  try {
    const month = monthParam(req.query.month);
    const { docs, settings } = await loadMonthRoster(month);
    const rows = applyFilters(docs.map(rowOf), req.query).sort((a, b) => (a.user.name || "").localeCompare(b.user.name || ""));
    const criteria = await getActiveCriteria();
    return res.json({
      success: true,
      message: "Appraisals fetched",
      data: {
        month,
        period: monthPeriod(month),
        rows,
        stats: statsOf(rows, settings),
        classifications: settings.classifications,
        weightage: await weightageStatus(criteria, settings),
        periodStatus: (await AppraisalPeriod.findOne({ month }).select("status closedAt closeSummary").lean()) || { status: "open" },
      },
    });
  } catch (error) {
    return handle(res, error);
  }
};

// Quick grid save for HR's monthly inputs screen: many employees' leaves/
// late marks in one request. Per-row results, so one locked appraisal
// doesn't fail the whole batch.
export const bulkUpdateInputs = async (req, res) => {
  try {
    const month = monthParam(req.body.month);
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 500) : [];
    if (!rows.length) return fail(res, 400, "rows are required");
    const results = [];
    const touched = [];
    for (const row of rows) {
      try {
        const doc = await getOrCreateDraft(row.userId, month);
        const patch = {};
        if (row.leaves !== undefined) patch.leaves = row.leaves === "" ? null : row.leaves;
        if (row.lateMarks !== undefined) patch.lateMarks = row.lateMarks === "" ? null : row.lateMarks;
        if (row.scoreFrom !== undefined) patch.scoreFrom = row.scoreFrom;
        if (row.scoreTo !== undefined) patch.scoreTo = row.scoreTo;
        await updateHrInputs(doc, patch, req.user);
        touched.push(doc);
        results.push({ userId: row.userId, ok: true });
      } catch (error) {
        results.push({ userId: row.userId, ok: false, message: error instanceof AppraisalError ? error.message : "Could not save" });
        if (!(error instanceof AppraisalError)) console.error(error);
      }
    }
    if (touched.length) await recalculate(touched);
    const failed = results.filter((r) => !r.ok).length;
    return res.json({ success: true, message: failed ? `${results.length - failed} saved, ${failed} failed` : "Inputs saved", data: { results } });
  } catch (error) {
    return handle(res, error);
  }
};

// ------------------------------------------------------------------ detail

const criteriaMetaFor = async (doc) => {
  const source = ["finalized", "reopened"].includes(doc.status) && doc.configSnapshot ? doc.configSnapshot.criteria : await getActiveCriteria();
  return source.map((c) => ({ key: c.key, name: c.name, description: c.description, type: c.type, group: c.group, ratingOptions: c.ratingOptions || [] }));
};

const detailPayload = async (doc, user) => {
  await doc.populate([
    { path: "user", select: USER_FIELDS, populate: [{ path: "department", select: "name" }, { path: "team", select: "name" }] },
    { path: "evaluator", select: "name" },
    { path: "finalizedBy", select: "name" },
    { path: "submittedBy", select: "name" },
    { path: "reopenHistory.by", select: "name" },
  ]);
  const data = sanitizeAppraisal(doc, user);
  if (canViewAll(user)) data.criteriaMeta = await criteriaMetaFor(doc);
  data.canManage = canManage(user);
  return data;
};

export const getAppraisal = async (req, res) => {
  try {
    const doc = await loadAppraisal(req.params.id);
    if (!(await canViewAppraisal(req.user, doc))) return fail(res, 403, "You don't have access to this appraisal");
    if (canManage(req.user) && doc.status !== "finalized") await recalculateOne(doc);
    return res.json({ success: true, message: "Appraisal fetched", data: { appraisal: await detailPayload(doc, req.user) } });
  } catch (error) {
    return handle(res, error);
  }
};

// HR opening a specific employee/month straight from a link or history.
export const openEmployeeMonth = async (req, res) => {
  try {
    const month = monthParam(req.params.month);
    const doc = await getOrCreateDraft(req.params.userId, month);
    if (doc.status !== "finalized") await recalculateOne(doc);
    return res.json({ success: true, message: "Appraisal fetched", data: { appraisal: await detailPayload(doc, req.user) } });
  } catch (error) {
    return handle(res, error);
  }
};

const mutate = (fn, message) => async (req, res) => {
  try {
    const doc = await loadAppraisal(req.params.id);
    const result = await fn(doc, req);
    const fresh = await EmployeeAppraisal.findById(result?._id || doc._id);
    if (fresh.status !== "finalized") await recalculateOne(fresh);
    return res.json({ success: true, message, data: { appraisal: await detailPayload(fresh, req.user) } });
  } catch (error) {
    return handle(res, error);
  }
};

export const recalculateAppraisal = mutate(async (doc) => {
  if (doc.status === "finalized") throw new AppraisalError("Finalized appraisals are never recalculated", 409);
  return doc;
}, "Recalculated");
export const updateAppraisalHrInputs = mutate((doc, req) => updateHrInputs(doc, req.body || {}, req.user), "HR inputs saved");
export const updateEvaluation = mutate((doc, req) => setEvaluation(doc, req.params.criterionKey, req.body || {}, req.user), "Evaluation saved");
export const submit = mutate((doc, req) => submitAppraisal(doc, req.user), "Appraisal submitted");
export const finalize = async (req, res) => {
  try {
    const doc = await loadAppraisal(req.params.id);
    await finalizeAppraisal(doc, req.user);
    const fresh = await EmployeeAppraisal.findById(doc._id).populate("user", USER_FIELDS);
    // Queue and send the employee email immediately.
    const settings = await getSettings();
    queueDueEmails(new Date()).catch((e) => console.error("appraisal email queue failed:", e.message));
    processEmailQueue(new Date(), { maxAttempts: settings.automation?.maxEmailAttempts || 3 }).catch((e) =>
      console.error("appraisal email send failed:", e.message)
    );
    // Check if the whole department is done — email director if so.
    const deptId = fresh?.user?.department;
    if (deptId) maybeSendDirectorDeptReport(deptId, doc.month).catch((e) => console.error("director dept report failed:", e.message));
    return res.json({ success: true, message: "Appraisal finalized", data: { appraisal: await detailPayload(fresh, req.user) } });
  } catch (error) {
    return handle(res, error);
  }
};
export const reopen = mutate((doc, req) => reopenAppraisal(doc, req.user, req.body?.reason), "Appraisal reopened");

export const finalizeMonth = async (req, res) => {
  try {
    const month = monthParam(req.body.month);
    const [settings, criteria] = await Promise.all([getSettings(), getActiveCriteria()]);
    const filter = { month, status: { $in: ["ready_for_review", "submitted", "in_progress", "pending_hr_input", "draft"] } };
    if (Array.isArray(req.body.ids) && req.body.ids.length) filter._id = { $in: req.body.ids };
    const docs = await EmployeeAppraisal.find(filter);
    let finalized = 0;
    const skipped = [];
    for (const doc of docs) {
      try {
        await finalizeAppraisal(doc, req.user, { settings, criteria });
        finalized += 1;
      } catch (error) {
        if (!(error instanceof AppraisalError)) throw error;
        skipped.push({ id: doc._id, message: error.message });
      }
    }
    // Queue and send emails for all newly finalized appraisals immediately.
    queueDueEmails(new Date()).catch((e) => console.error("appraisal email queue failed:", e.message));
    processEmailQueue(new Date(), { maxAttempts: settings.automation?.maxEmailAttempts || 3 }).catch((e) =>
      console.error("appraisal email send failed:", e.message)
    );
    // Check each unique department — email directors for any now-complete ones.
    const deptIds = [...new Set(
      await Promise.all(docs.map(async (d) => {
        const u = await User.findById(d.user).select("department").lean();
        return u?.department ? String(u.department) : null;
      }))
    )].filter(Boolean);
    for (const deptId of deptIds) {
      maybeSendDirectorDeptReport(deptId, month).catch((e) => console.error("director dept report failed:", e.message));
    }
    return res.json({ success: true, message: `${finalized} finalized, ${skipped.length} skipped`, data: { finalized, skipped } });
  } catch (error) {
    return handle(res, error);
  }
};

export const appraisalAudit = async (req, res) => {
  try {
    const doc = await loadAppraisal(req.params.id);
    const logs = await AppraisalAuditLog.find({ $or: [{ entityType: "appraisal", entityId: doc._id }, { subject: doc.user, month: doc.month }] })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate("actor", "name role")
      .lean();
    return res.json({ success: true, message: "Audit fetched", data: { logs } });
  } catch (error) {
    return handle(res, error);
  }
};

// ------------------------------------------------------------------ history

const historyFor = async (userId, viewer) => {
  const filter = { user: userId };
  if (!canViewAll(viewer)) filter.status = "finalized";
  return EmployeeAppraisal.find(filter)
    .select("month status totalScore classification finalizedAt employeeSnapshot")
    .sort({ month: -1 })
    .lean();
};

export const employeeHistory = async (req, res) => {
  try {
    const target = await User.findById(req.params.userId).select(USER_FIELDS).populate("department", "name").lean();
    if (!target) return fail(res, 404, "Employee not found");
    const self = String(target._id) === String(req.user._id);
    if (!canViewAll(req.user) && !self && !(await managedIdSet(req.user)).has(String(target._id))) {
      return fail(res, 403, "You don't have access to this employee's appraisals");
    }
    const history = await historyFor(target._id, req.user);
    return res.json({ success: true, message: "History fetched", data: { employee: target, history } });
  } catch (error) {
    return handle(res, error);
  }
};

export const myAppraisals = async (req, res) => {
  try {
    const history = await historyFor(req.user._id, { role: "member" }); // own view: finalized only
    return res.json({ success: true, message: "Appraisals fetched", data: { history } });
  } catch (error) {
    return handle(res, error);
  }
};

export const teamAppraisals = async (req, res) => {
  try {
    if (!isTeamLead(req.user)) return fail(res, 403, "Forbidden");
    const month = monthParam(req.query.month);
    const ids = [...(await managedIdSet(req.user))];
    const docs = await EmployeeAppraisal.find({ user: { $in: ids }, month, status: "finalized" })
      .select("user month status totalScore classification employeeSnapshot finalizedAt")
      .populate("user", "name designation")
      .lean();
    const members = await User.find({ _id: { $in: ids }, isActive: true }).select("name designation").sort("name").lean();
    return res.json({ success: true, message: "Team appraisals fetched", data: { month, appraisals: docs, members } });
  } catch (error) {
    return handle(res, error);
  }
};

// ------------------------------------------------------------------ reports

export const report = async (req, res) => {
  try {
    const month = monthParam(req.query.month);
    const { docs, settings } = await loadMonthRoster(month);
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const rows = applyFilters(docs.map(rowOf), req.query).sort(
      (a, b) => a.department.name.localeCompare(b.department.name) || (a.user.name || "").localeCompare(b.user.name || "")
    );

    const summary = rows.map((r) => {
      const d = byId.get(String(r._id));
      return {
        employee: r.user.name,
        email: r.user.email,
        department: r.department.name,
        designation: r.user.designation || "",
        score: roundDisplay(r.totalScore),
        classification: r.classification?.label || "",
        status: r.status,
        scoreFrom: d?.hrInputs?.scoreFrom ? new Date(d.hrInputs.scoreFrom).toISOString().slice(0, 10) : "",
        scoreTo: d?.hrInputs?.scoreTo ? new Date(d.hrInputs.scoreTo).toISOString().slice(0, 10) : "",
      };
    });
    const criteria = [];
    const automatic = [];
    const hr = [];
    const manualNames = new Set();
    for (const r of rows) {
      const d = byId.get(String(r._id));
      const m = d.metricsSnapshot || {};
      for (const e of d.entries || []) {
        criteria.push({
          employee: r.user.name,
          criterion: e.name,
          type: e.type,
          weightage: e.weightage,
          rating: e.ratingLabel || "",
          performancePct: e.performancePct === null ? "" : roundDisplay(e.performancePct),
          score: roundDisplay(e.score),
        });
        if (e.type === "manual") manualNames.add(e.name);
      }
      automatic.push({
        employee: r.user.name,
        projects: m.projects?.list?.length ?? 0,
        tasks: m.tasks?.total ?? 0,
        completed: m.tasks?.completed ?? 0,
        overdue: m.tasks?.overdue ?? 0,
        bugs: m.bugs?.counted ?? 0,
        clientChanges: m.clientChanges?.total ?? 0,
      });
      const hrRow = {
        employee: r.user.name,
        leaves: r.hrInputs.leaves ?? "",
        lateMarks: r.hrInputs.lateMarks ?? "",
        scoreFrom: d?.hrInputs?.scoreFrom ? new Date(d.hrInputs.scoreFrom).toISOString().slice(0, 10) : "",
        scoreTo: d?.hrInputs?.scoreTo ? new Date(d.hrInputs.scoreTo).toISOString().slice(0, 10) : "",
      };
      for (const e of (d.entries || []).filter((x) => x.type === "manual")) hrRow[e.name] = e.ratingLabel || "";
      hr.push(hrRow);
    }

    const deptMap = new Map();
    for (const r of rows) {
      const key = r.department.name;
      if (!deptMap.has(key)) deptMap.set(key, []);
      deptMap.get(key).push(r);
    }
    const departments = [...deptMap.entries()].map(([name, list]) => {
      const row = {
        department: name,
        employeeCount: list.length,
        averageScore: roundDisplay(list.reduce((s, r) => s + r.totalScore, 0) / list.length),
      };
      for (const c of settings.classifications || []) row[c.label] = list.filter((r) => r.classification?.key === c.key).length;
      return row;
    });

    if (req.query.format === "csv") {
      const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = ["Employee", "Email", "Department", "Designation", "Overall Score", "Classification", "Status"];
      const csv = [header.join(","), ...summary.map((s) => Object.values(s).map(cell).join(","))].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="appraisal-report-${month}.csv"`);
      return res.send(csv);
    }

    return res.json({
      success: true,
      message: "Report generated",
      data: { month, summary, criteria, automatic, hr, hrColumns: [...manualNames], departments, classifications: settings.classifications },
    });
  } catch (error) {
    return handle(res, error);
  }
};

// ------------------------------------------------------------------ emails & periods

export const listEmailLogs = async (req, res) => {
  try {
    const filter = {};
    if (req.query.month) {
      if (!isValidMonth(req.query.month)) return fail(res, 400, "month must be YYYY-MM");
      filter.month = req.query.month;
    }
    if (req.query.status) {
      if (!EMAIL_STATUSES.includes(req.query.status)) return fail(res, 400, "Invalid status");
      filter.status = req.query.status;
    }
    const logs = await AppraisalEmailLog.find(filter).sort({ updatedAt: -1 }).limit(500).populate("user", "name").lean();
    const counts = Object.fromEntries(EMAIL_STATUSES.map((s) => [s, logs.filter((l) => l.status === s).length]));
    return res.json({ success: true, message: "Email logs fetched", data: { logs, counts } });
  } catch (error) {
    return handle(res, error);
  }
};

export const retryEmailLog = async (req, res) => {
  try {
    const log = await retryEmail(req.params.id, req.user);
    if (!log) return fail(res, 409, "Only failed emails can be retried");
    const settings = await getSettings();
    processEmailQueue(new Date(), { maxAttempts: settings.automation?.maxEmailAttempts || 3 }).catch((error) =>
      console.error("appraisal email retry failed:", error.message)
    );
    return res.json({ success: true, message: "Email queued for retry", data: { log } });
  } catch (error) {
    return handle(res, error);
  }
};

export const listPeriods = async (req, res) => {
  try {
    const periods = await AppraisalPeriod.find().sort({ month: -1 }).limit(36).lean();
    return res.json({ success: true, message: "Periods fetched", data: { periods } });
  } catch (error) {
    return handle(res, error);
  }
};

export const closePeriod = async (req, res) => {
  try {
    const month = monthParam(req.params.month);
    const result = await closeMonth(month, { actor: req.user });
    return res.json({ success: true, message: result.skipped ? "Month was already closed" : "Month closed", data: result });
  } catch (error) {
    return handle(res, error);
  }
};

// ------------------------------------------------------------------ client changes

export const listClientChanges = async (req, res) => {
  try {
    const month = monthParam(req.query.month);
    const { startAt, endAt } = monthPeriod(month);
    const filter = { isClientChange: true, createdAt: { $gte: startAt, $lte: endAt } };
    if (req.query.category === "uncategorized") filter.clientChangeCategory = null;
    else if (req.query.category) filter.clientChangeCategory = req.query.category;
    const tasks = await Task.find(filter)
      .select("title project assignees clientChangeCategory createdAt status")
      .populate("project", "name")
      .populate("assignees", "name")
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, message: "Client changes fetched", data: { tasks } });
  } catch (error) {
    return handle(res, error);
  }
};

export const categorizeClientChange = async (req, res) => {
  try {
    const settings = await getSettings();
    const category = req.body.category || null;
    if (category && !(settings.clientChangeCategories || []).some((c) => c.key === category)) return fail(res, 400, "Unknown category");
    const task = await Task.findOne({ _id: req.params.taskId, isClientChange: true });
    if (!task) return fail(res, 404, "Client-change task not found");
    const before = task.clientChangeCategory;
    // updateOne, not save(): leaves updatedAt and every other task field alone.
    await Task.updateOne({ _id: task._id }, { $set: { clientChangeCategory: category } }, { timestamps: false });
    await audit({ actor: req.user, action: "client_change_categorized", entityType: "task", entityId: task._id, before: { category: before }, after: { category } });
    return res.json({ success: true, message: "Category saved", data: { taskId: task._id, category } });
  } catch (error) {
    return handle(res, error);
  }
};

// ------------------------------------------------------------------ audit

export const listAudit = async (req, res) => {
  try {
    const filter = {};
    if (req.query.month) filter.month = req.query.month;
    if (req.query.subject) filter.subject = req.query.subject;
    if (req.query.action) filter.action = req.query.action;
    if (req.query.entityType) filter.entityType = req.query.entityType;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const logs = await AppraisalAuditLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("actor", "name role")
      .populate("subject", "name")
      .lean();
    return res.json({ success: true, message: "Audit log fetched", data: { logs } });
  } catch (error) {
    return handle(res, error);
  }
};
