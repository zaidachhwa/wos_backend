import BugReport from "../models/BugReport.js";
import EmployeeAppraisal from "../models/EmployeeAppraisal.js";
import Project from "../models/Project.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { BUG_STATUSES } from "../constants/appraisal.constants.js";
import { getSettings } from "../services/appraisal/appraisalConfig.js";
import { canManage, canViewAll, managedIdSet } from "../services/appraisal/appraisalAccess.js";
import { audit, diffFields } from "../services/appraisal/appraisalAudit.js";
import { isValidMonth, monthPeriod } from "../services/appraisal/appraisalPeriod.js";
import { istDayStr } from "../utils/istTime.js";

// Bug reports against employees, for appraisal. Reporters: HR/admin
// (anyone), team leads — manager/sublead/subadmin — (only people they
// manage), QA (anyone, mirroring its existing unscoped defect-flagging in
// taskController.canFlagDefects). A lead/QA report starts "reported" and
// only counts once HR confirms it; an HR report is confirmed on creation.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORTER_EDITABLE = ["title", "description", "severity", "project", "task", "date"];
const HR_EDITABLE = [...REPORTER_EDITABLE, "status", "includeInAppraisal", "exclusionReason", "resolution"];

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const serverError = (res, error) => {
  if (error?.name === "CastError") return fail(res, 400, "Invalid identifier");
  if (error?.name === "ValidationError") return fail(res, 400, "Invalid bug details");
  console.error(error);
  return fail(res, 500, "Something went wrong");
};

const canReportAgainst = async (actor, employeeId) => {
  if (String(actor._id) === String(employeeId)) return false; // never against yourself
  if (canManage(actor) || actor.role === "qa") return true;
  return (await managedIdSet(actor)).has(String(employeeId));
};

const canSeeBug = async (actor, bug) => {
  if (canViewAll(actor)) return true;
  if (String(bug.reportedBy?._id || bug.reportedBy) === String(actor._id)) return true;
  return (await managedIdSet(actor)).has(String(bug.employee?._id || bug.employee));
};

// Tells the caller when an edit lands in a month whose appraisal is already
// locked — the change is recorded but won't touch that snapshot unless HR
// reopens it.
const lockedNotice = async (employee, date) => {
  const month = String(date).slice(0, 7);
  const locked = await EmployeeAppraisal.exists({ user: employee, month, status: "finalized" });
  return locked ? `The ${month} appraisal for this employee is finalized; this bug won't affect it unless the appraisal is reopened.` : null;
};

const validSeverity = async (key) => {
  const settings = await getSettings();
  return (settings.bugSeverities || []).find((s) => s.key === key && s.isActive !== false);
};

const populateBug = (q) =>
  q
    .populate("employee", "name designation department")
    .populate("project", "name")
    .populate("task", "title")
    .populate("reportedBy", "name role")
    .populate("reviewedBy", "name")
    .populate("comments.user", "name role");

export const listBugs = async (req, res) => {
  try {
    const filter = {};
    const { month, employee, status, severity, project } = req.query;
    if (month) {
      if (!isValidMonth(month)) return fail(res, 400, "month must be YYYY-MM");
      const { dayStart, dayEnd } = monthPeriod(month);
      filter.date = { $gte: dayStart, $lte: dayEnd };
    }
    if (employee) filter.employee = employee;
    if (status) filter.status = status;
    if (severity) filter.severity = severity;
    if (project) filter.project = project;

    if (!canViewAll(req.user)) {
      const managed = [...(await managedIdSet(req.user))];
      if (!managed.length && req.user.role !== "qa") return fail(res, 403, "You don't have access to bug reports");
      filter.$or = [{ reportedBy: req.user._id }, { employee: { $in: managed } }];
    }
    const bugs = await populateBug(BugReport.find(filter).sort({ date: -1, createdAt: -1 }).limit(1000)).lean();
    const settings = await getSettings();
    const penalties = Object.fromEntries((settings.bugSeverities || []).map((s) => [s.key, s.penalty]));
    const countable = new Set(settings.bugCountableStatuses || []);
    const rows = bugs.map((b) => ({ ...b, penalty: b.includeInAppraisal && countable.has(b.status) ? penalties[b.severity] ?? 0 : 0 }));
    return res.json({ success: true, message: "Bugs fetched", data: { bugs: rows, severities: settings.bugSeverities, countableStatuses: settings.bugCountableStatuses } });
  } catch (error) {
    return serverError(res, error);
  }
};

// Who the caller may report against — backs the employee picker.
export const reportableEmployees = async (req, res) => {
  try {
    const settings = await getSettings();
    const filter = { isActive: true, role: { $in: settings.appraisedRoles }, _id: { $ne: req.user._id } };
    if (!canManage(req.user) && req.user.role !== "qa") filter._id = { $in: [...(await managedIdSet(req.user))], $ne: req.user._id };
    const users = await User.find(filter).select("name designation department").populate("department", "name").sort("name").lean();
    return res.json({ success: true, message: "Employees fetched", data: { users } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const getBug = async (req, res) => {
  try {
    const bug = await populateBug(BugReport.findById(req.params.id));
    if (!bug) return fail(res, 404, "Bug not found");
    if (!(await canSeeBug(req.user, bug))) return fail(res, 403, "You don't have access to this bug");
    return res.json({ success: true, message: "Bug fetched", data: { bug } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const createBug = async (req, res) => {
  try {
    const { employee, project, task, title, description = "", severity, date } = req.body || {};
    if (!employee || !title || !String(title).trim() || !severity) return fail(res, 400, "employee, title and severity are required");
    const day = date || istDayStr();
    if (!DATE_RE.test(day)) return fail(res, 400, "date must be YYYY-MM-DD");
    if (day > istDayStr()) return fail(res, 400, "A bug can't be dated in the future");
    const target = await User.findById(employee).select("_id isActive");
    if (!target) return fail(res, 404, "Employee not found");
    if (!(await canReportAgainst(req.user, employee))) return fail(res, 403, "You can only report bugs against people you manage");
    if (!(await validSeverity(severity))) return fail(res, 400, "Unknown or inactive severity");
    if (project && !(await Project.exists({ _id: project }))) return fail(res, 400, "Project not found");
    if (task && !(await Task.exists({ _id: task }))) return fail(res, 400, "Task not found");

    const isHr = canManage(req.user);
    const bug = await BugReport.create({
      employee,
      project: project || null,
      task: task || null,
      title: String(title).trim().slice(0, 300),
      description: String(description).slice(0, 5000),
      severity,
      date: day,
      status: isHr ? "confirmed" : "reported",
      reportedBy: req.user._id,
      reporterRole: req.user.role,
      reviewedBy: isHr ? req.user._id : null,
      reviewedAt: isHr ? new Date() : null,
    });
    await audit({ actor: req.user, action: "bug_created", entityType: "bug", entityId: bug._id, subject: employee, month: day.slice(0, 7), after: { title: bug.title, severity, status: bug.status } });
    const notice = await lockedNotice(employee, day);
    return res.status(201).json({ success: true, message: notice || "Bug reported", data: { bug: await populateBug(BugReport.findById(bug._id)), notice } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const updateBug = async (req, res) => {
  try {
    const bug = await BugReport.findById(req.params.id);
    if (!bug) return fail(res, 404, "Bug not found");
    const isHr = canManage(req.user);
    const isReporter = String(bug.reportedBy) === String(req.user._id);
    if (!isHr && !(isReporter && bug.status === "reported")) {
      return fail(res, 403, "Only HR can edit a bug after it has been reviewed");
    }
    const allowed = isHr ? HR_EDITABLE : REPORTER_EDITABLE;
    const body = req.body || {};
    const disallowed = Object.keys(body).filter((k) => !allowed.includes(k));
    if (disallowed.length) return fail(res, 403, `Cannot update field(s): ${disallowed.join(", ")}`);

    if (body.severity !== undefined && !(await validSeverity(body.severity))) return fail(res, 400, "Unknown or inactive severity");
    if (body.status !== undefined && !BUG_STATUSES.includes(body.status)) return fail(res, 400, "Invalid status");
    if (body.date !== undefined && (!DATE_RE.test(body.date) || body.date > istDayStr())) return fail(res, 400, "Invalid date");
    if (body.includeInAppraisal === false && !String(body.exclusionReason ?? bug.exclusionReason).trim()) {
      return fail(res, 400, "A reason is required to exclude a bug from the appraisal");
    }

    const before = bug.toObject();
    for (const k of allowed) {
      if (body[k] === undefined) continue;
      if (k === "title") bug.title = String(body.title).trim().slice(0, 300);
      else if (k === "project" || k === "task") bug[k] = body[k] || null;
      else bug[k] = body[k];
    }
    if (body.status !== undefined && body.status !== before.status) {
      bug.reviewedBy = req.user._id;
      bug.reviewedAt = new Date();
      if (body.status === "resolved") bug.resolvedAt = new Date();
    }
    await bug.save();

    const changes = diffFields(before, bug.toObject(), allowed);
    if (changes) {
      const common = { actor: req.user, entityType: "bug", entityId: bug._id, subject: bug.employee, month: bug.date.slice(0, 7) };
      await audit({ ...common, action: "bug_updated", ...changes });
      if ("severity" in changes.after) await audit({ ...common, action: "bug_severity_changed", before: { severity: before.severity }, after: { severity: bug.severity } });
      if ("status" in changes.after) await audit({ ...common, action: "bug_status_changed", before: { status: before.status }, after: { status: bug.status } });
    }
    const notice = await lockedNotice(bug.employee, bug.date);
    return res.json({ success: true, message: notice || "Bug updated", data: { bug: await populateBug(BugReport.findById(bug._id)), notice } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const addBugComment = async (req, res) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) return fail(res, 400, "Comment text is required");
    const bug = await BugReport.findById(req.params.id);
    if (!bug) return fail(res, 404, "Bug not found");
    if (!(await canSeeBug(req.user, bug))) return fail(res, 403, "You don't have access to this bug");
    bug.comments.push({ user: req.user._id, text: text.slice(0, 2000) });
    await bug.save();
    return res.status(201).json({ success: true, message: "Comment added", data: { bug: await populateBug(BugReport.findById(bug._id)) } });
  } catch (error) {
    return serverError(res, error);
  }
};
