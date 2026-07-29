import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { recordActivity, notify } from "../utils/record.js";
import { broadcast } from "../utils/io.js";
import { canViewProject, visibilityFilter, idOf } from "./projectController.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";
import { validateTimeSlot } from "../utils/taskDates.js";
import { maxBonusFor } from "../utils/points.js";

const SUBLEAD_PLUS = ["admin", "manager", "subadmin", "sublead"];
// Deliberately excludes subadmin: unlike task-editing (SUBLEAD_PLUS), comment
// moderation here has no canViewProject/department-scope check at all, so
// including subadmin would grant unscoped cross-department comment moderation.
const COMMENT_MODERATOR_ROLES = ["admin", "manager", "sublead"];

const FULL_FIELDS = [
  "title",
  "description",
  "modules",
  "assignees",
  "priority",
  "status",
  "estimatedHours",
  "actualHours",
  "deadline",
  "startTime",
  "endTime",
  "bonusPoints",
  "labels",
  "subtasks",
  "blockedBy",
  "recurrence",
];
const ASSIGNEE_FIELDS = ["status", "actualHours", "subtasks"];

export const createTask = async (req, res) => {
  try {
    const {
      project: projectId,
      modules,
      title,
      description,
      assignees,
      priority,
      status,
      estimatedHours,
      deadline,
      startTime,
      endTime,
      labels,
      blockedBy,
      recurrence,
    } = req.body;

    const timeSlotError = validateTimeSlot({ deadline, startTime, endTime });
    if (timeSlotError) {
      return res.status(400).json({ success: false, message: timeSlotError });
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    for (const moduleId of modules || []) {
      const projectModule = await ProjectModule.findOne({ _id: moduleId, project: project._id });
      if (!projectModule) {
        return res.status(400).json({ success: false, message: "module must belong to the project" });
      }
    }

    // Members can propose work, but only for themselves — assigning others
    // stays a sublead+ privilege — and it sits behind manager/admin approval
    // before it's "real" work.
    const isMember = req.user.role === "member";

    const task = await Task.create({
      project: project._id,
      modules: modules || [],
      title,
      description,
      assignees: isMember ? [req.user._id] : assignees || [],
      priority,
      status: isMember ? "backlog" : status,
      estimatedHours,
      deadline: deadline || null,
      startTime: startTime || null,
      endTime: endTime || null,
      labels: labels || [],
      blockedBy: blockedBy || [],
      recurrence: recurrence || null,
      createdBy: req.user._id,
      approvalStatus: isMember ? "pending" : "not_required",
    });

    if (isMember) {
      recordActivity({
        actor: req.user._id,
        action: "submitted_for_approval",
        entityType: "task",
        entityId: task._id,
        project: project._id,
        meta: { title: task.title },
      });
      if (req.user.reportingManager) {
        notify({
          user: req.user.reportingManager,
          type: "task_assigned",
          title: `${req.user.name} proposed a task: "${task.title}"`,
          link: `/tasks?open=${task._id}`,
        });
      } else {
        const admins = await User.find({ role: "admin" });
        for (const admin of admins) {
          notify({
            user: admin._id,
            type: "task_assigned",
            title: `${req.user.name} proposed a task: "${task.title}"`,
            link: `/tasks?open=${task._id}`,
          });
        }
      }
    } else {
      recordActivity({
        actor: req.user._id,
        action: "created",
        entityType: "task",
        entityId: task._id,
        project: project._id,
        meta: { title: task.title },
      });
      for (const userId of task.assignees) {
        notify({
          user: userId,
          type: "task_assigned",
          title: `Assigned to task "${task.title}"`,
          link: `/tasks/${task._id}`,
        });
      }
    }

    broadcast("tasks_changed");
    return res.status(201).json({ success: true, message: "Task created", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Mirrors followUpController.reviewFollowUp's state-machine: only the
// creator's reportingManager or an admin may decide, and only while pending.
const canDecideApproval = async (user, task) => {
  if (user.role === "admin") return true;
  if (!task.createdBy) return false;
  const creator = await User.findById(task.createdBy);
  return !!creator && String(creator.reportingManager) === String(user._id);
};

export const approveTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    if (task.approvalStatus !== "pending") {
      return res.status(409).json({ success: false, message: "Only pending tasks can be approved" });
    }
    if (!(await canDecideApproval(req.user, task))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    task.approvalStatus = "approved";
    // Approver may also adjust these in the same request (e.g. add teammates,
    // bump priority) — same whitelist as a full task edit.
    for (const key of ["assignees", "status", "priority"]) {
      if (key in req.body) task[key] = req.body[key];
    }
    await task.save();

    recordActivity({
      actor: req.user._id,
      action: "approved",
      entityType: "task",
      entityId: task._id,
      project: task.project,
      meta: { title: task.title },
    });
    notify({
      user: task.createdBy,
      type: "task_assigned",
      title: `Your task "${task.title}" was approved`,
      link: `/tasks/${task._id}`,
    });

    broadcast("tasks_changed");
    return res.json({ success: true, message: "Task approved", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const rejectTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    if (task.approvalStatus !== "pending") {
      return res.status(409).json({ success: false, message: "Only pending tasks can be rejected" });
    }
    if (!(await canDecideApproval(req.user, task))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (!req.body.approvalComment || !String(req.body.approvalComment).trim()) {
      return res.status(400).json({ success: false, message: "approvalComment (a reason) is required" });
    }

    task.approvalStatus = "rejected";
    task.approvalComment = req.body.approvalComment;
    await task.save();

    recordActivity({
      actor: req.user._id,
      action: "rejected",
      entityType: "task",
      entityId: task._id,
      project: task.project,
      meta: { title: task.title },
    });
    notify({
      user: task.createdBy,
      type: "task_assigned",
      title: `Your task "${task.title}" was rejected`,
      link: `/tasks/${task._id}`,
    });

    broadcast("tasks_changed");
    return res.json({ success: true, message: "Task rejected", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listTasks = async (req, res) => {
  try {
    const { project, module, assignee, status, priority, search, dueBefore, dueAfter, approvalStatus } = req.query;
    const filter = {};
    if (module) filter.modules = module;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (approvalStatus) filter.approvalStatus = approvalStatus;
    if (assignee) filter.assignees = assignee === "me" ? req.user._id : assignee;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.title = { $regex: escaped, $options: "i" };
    }
    if (dueBefore || dueAfter) {
      filter.deadline = {};
      if (dueAfter) filter.deadline.$gte = new Date(dueAfter);
      if (dueBefore) filter.deadline.$lte = new Date(dueBefore);
    }

    if (project) {
      const projectDoc = await Project.findById(project);
      if (!projectDoc) {
        return res.status(404).json({ success: false, message: "Project not found" });
      }
      if (!(await canViewProject(req.user, projectDoc))) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      filter.project = project;
    } else if (!["admin", "manager"].includes(req.user.role)) {
      const viewableIds = await Project.find(await visibilityFilter(req.user)).distinct("_id");
      filter.project = { $in: viewableIds };
    }

    const pageParams = paginationParams(req.query);
    const total = await Task.countDocuments(filter);
    let query = Task.find(filter)
      .populate("assignees", "name role designation")
      .populate("blockedBy", "title status")
      .sort("-createdAt")
      .lean();
    if (pageParams) query = query.skip(pageParams.skip).limit(pageParams.limit);
    const tasks = await query;
    return res.json({
      success: true,
      message: "Tasks fetched",
      data: { tasks, pagination: paginationMeta(total, pageParams) },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate("assignees", "name role designation")
      .populate("blockedBy", "title status")
      .populate("comments.user", "name role designation");
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const project = await Project.findById(task.project);
    if (!project || !(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    return res.json({ success: true, message: "Task fetched", data: { task } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const project = await Project.findById(task.project);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (task.approvalStatus === "pending") {
      return res
        .status(409)
        .json({ success: false, message: "Task is pending manager approval and can't be edited yet" });
    }

    const canManageFully = SUBLEAD_PLUS.includes(req.user.role) && (await canViewProject(req.user, project));
    const isAssignee = task.assignees.some((a) => idOf(a) === String(req.user._id));
    if (!canManageFully && !isAssignee) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const allowedFields = canManageFully ? FULL_FIELDS : ASSIGNEE_FIELDS;
    const disallowed = Object.keys(req.body).filter((key) => !allowedFields.includes(key));
    if (disallowed.length) {
      return res
        .status(403)
        .json({ success: false, message: `Cannot update field(s): ${disallowed.join(", ")}` });
    }

    for (const moduleId of req.body.modules || []) {
      const projectModule = await ProjectModule.findOne({ _id: moduleId, project: task.project });
      if (!projectModule) {
        return res.status(400).json({ success: false, message: "module must belong to the project" });
      }
    }

    const prevAssignees = task.assignees.map((a) => String(a));
    const prevStatus = task.status;
    const prevBonusPoints = task.bonusPoints;

    for (const key of allowedFields) {
      if (key in req.body) task[key] = req.body[key];
    }

    const timeSlotError = validateTimeSlot(task);
    if (timeSlotError) {
      return res.status(400).json({ success: false, message: timeSlotError });
    }

    if (task.bonusPoints > maxBonusFor(task.priority)) {
      return res
        .status(400)
        .json({ success: false, message: `bonusPoints cannot exceed ${maxBonusFor(task.priority)} for this priority` });
    }

    await task.save();

    const newlyAssigned = task.assignees.map((a) => String(a)).filter((id) => !prevAssignees.includes(id));
    recordActivity({
      actor: req.user._id,
      action: "updated",
      entityType: "task",
      entityId: task._id,
      project: task.project,
      meta: {
        title: task.title,
        ...(task.status !== prevStatus ? { statusFrom: prevStatus, statusTo: task.status } : {}),
        ...(newlyAssigned.length ? { assigneesAdded: newlyAssigned.length } : {}),
      },
    });

    for (const userId of newlyAssigned) {
      notify({
        user: userId,
        type: "task_assigned",
        title: `Assigned to task "${task.title}"`,
        link: `/tasks/${task._id}`,
      });
    }
    if (task.bonusPoints !== prevBonusPoints && task.bonusPoints > 0) {
      for (const userId of task.assignees) {
        notify({
          user: userId,
          type: "points_awarded",
          title: `+${task.bonusPoints} bonus points for "${task.title}"`,
          link: `/tasks/${task._id}`,
        });
      }
    }
    if (task.status !== prevStatus) {
      for (const userId of task.assignees) {
        notify({
          user: userId,
          type: "status_changed",
          title: `Task "${task.title}" is now ${task.status}`,
          link: `/tasks/${task._id}`,
        });
      }
    }

    if (task.status === "completed" && prevStatus !== "completed" && task.recurrence) {
      const nextDeadline = task.deadline ? new Date(task.deadline) : new Date();
      const { frequency, interval } = task.recurrence;
      if (frequency === "daily") nextDeadline.setDate(nextDeadline.getDate() + interval);
      else if (frequency === "weekly") nextDeadline.setDate(nextDeadline.getDate() + interval * 7);
      else if (frequency === "monthly") nextDeadline.setMonth(nextDeadline.getMonth() + interval);

      const nextTask = await Task.create({
        project: task.project,
        modules: task.modules,
        title: task.title,
        description: task.description,
        assignees: task.assignees,
        priority: task.priority,
        estimatedHours: task.estimatedHours,
        labels: task.labels,
        recurrence: task.recurrence,
        deadline: nextDeadline,
        startTime: task.startTime,
        endTime: task.endTime,
        status: "backlog",
        subtasks: [],
        comments: [],
        blockedBy: [],
        createdBy: task.createdBy,
      });

      recordActivity({
        actor: req.user._id,
        action: "created",
        entityType: "task",
        entityId: nextTask._id,
        project: nextTask.project,
        meta: { title: nextTask.title },
      });
      for (const userId of nextTask.assignees) {
        notify({
          user: userId,
          type: "task_assigned",
          title: `Assigned to task "${nextTask.title}"`,
          link: `/tasks/${nextTask._id}`,
        });
      }
    }

    broadcast("tasks_changed");
    return res.json({ success: true, message: "Task updated", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const addComment = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const project = await Project.findById(task.project);
    if (!project || !(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    task.comments.push({ user: req.user._id, text: req.body.text });
    await task.save();

    recordActivity({
      actor: req.user._id,
      action: "commented",
      entityType: "task",
      entityId: task._id,
      project: task.project,
      meta: { title: task.title },
    });
    for (const userId of task.assignees) {
      if (idOf(userId) !== String(req.user._id)) {
        notify({
          user: userId,
          type: "comment_added",
          title: `New comment on "${task.title}"`,
          link: `/tasks/${task._id}`,
        });
      }
    }

    return res.status(201).json({ success: true, message: "Comment added", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const updateComment = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const comment = task.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }
    const canManage = COMMENT_MODERATOR_ROLES.includes(req.user.role);
    if (idOf(comment.user) !== String(req.user._id) && !canManage) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (!req.body.text || !String(req.body.text).trim()) {
      return res.status(400).json({ success: false, message: "text is required" });
    }

    comment.text = req.body.text;
    await task.save();

    return res.json({ success: true, message: "Comment updated", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteComment = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const comment = task.comments.id(req.params.commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }
    if (idOf(comment.user) !== String(req.user._id) && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    comment.deleteOne();
    await task.save();

    return res.json({ success: true, message: "Comment deleted", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const bulkUpdateTasks = async (req, res) => {
  try {
    const { ids, status, assignees } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ success: false, message: "ids is required" });
    }

    const tasks = await Task.find({ _id: { $in: ids } });
    let updated = 0;
    for (const task of tasks) {
      const project = await Project.findById(task.project);
      if (!project || !(await canViewProject(req.user, project))) continue;

      const prevStatus = task.status;
      if (status !== undefined) task.status = status;
      if (assignees !== undefined) task.assignees = assignees;
      await task.save();

      recordActivity({
        actor: req.user._id,
        action: "updated",
        entityType: "task",
        entityId: task._id,
        project: task.project,
        meta: {
          title: task.title,
          ...(status !== undefined && status !== prevStatus ? { statusFrom: prevStatus, statusTo: status } : {}),
        },
      });
      updated += 1;
    }

    broadcast("tasks_changed");
    return res.json({ success: true, message: `${updated} tasks updated`, data: { updated } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteTask = async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    recordActivity({
      actor: req.user._id,
      action: "deleted",
      entityType: "task",
      entityId: task._id,
      project: task.project,
      meta: { title: task.title },
    });
    broadcast("tasks_changed");
    return res.json({ success: true, message: "Task deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
